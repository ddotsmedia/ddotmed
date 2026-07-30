import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { KAFKA_TOPICS, type LabCriticalValueEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { LabService } from './lab.module';
import { interpretResult, type ReferenceRange } from './reference-ranges';
import { buildTrends, TREND_POINTS } from './result-trends';

export const SubmitResultDto = z.object({
  service_request_id: z.string().uuid().nullable().optional(),
  /** Only optional when a service_request_id is given — that carries the patient. */
  patient_id: z.string().uuid().optional(),
  encounter_id: z.string().uuid().nullable().optional(),
  specimen_id: z.string().uuid().nullable().optional(),
  loinc_code: z.string().min(1),
  test_name: z.string().min(1).optional(),
  value_quantity: z.number().nullable().optional(),
  value_string: z.string().nullable().optional(),
  value_unit: z.string().nullable().optional(),
  ref_range_low: z.number().nullable().optional(),
  ref_range_high: z.number().nullable().optional(),
  /** What the analyser reported. The server re-derives it and wins on a conflict. */
  interpretation: z.enum(['H', 'L', 'HH', 'LL', 'N']).nullable().optional(),
  critical_flag: z.boolean().optional(),
  status: z.enum(['registered', 'preliminary', 'final', 'amended', 'corrected']).default('final'),
  method: z.string().optional(),
  analyzer_id: z.string().optional(),
});

@Injectable()
export class LabResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly lab: LabService,
  ) {}

  /**
   * Files a result from an analyser or from manual entry.
   *
   * The interpretation and the critical flag are derived here from the reference
   * range, not taken on trust from the sender. An analyser that mis-flags — or a
   * typist who leaves the flag on the previous patient's value — must not be able
   * to turn a critical result into a normal one. A sender may raise the flag we
   * did not raise; it can never lower one we did.
   */
  async submit(dto: z.infer<typeof SubmitResultDto>) {
    const ctx = currentContext();

    const order = dto.service_request_id
      ? await this.prisma.serviceRequest.findFirst({
          where: { id: dto.service_request_id, tenant_id: ctx.tenantId, deleted_at: null },
        })
      : null;

    if (dto.service_request_id && !order) throw new BadRequestException('Order not found');

    const patientId = dto.patient_id ?? order?.patient_id;
    if (!patientId) {
      throw new BadRequestException('patient_id is required when no service_request_id is given');
    }
    const testName = dto.test_name ?? order?.code_display ?? dto.loinc_code;

    // A caller-supplied range is honoured — a reference lab knows its own assay —
    // but the critical thresholds always come from our own table.
    const known = await this.lab.referenceRangeFor(patientId, dto.loinc_code);
    const range: ReferenceRange | null =
      dto.ref_range_low != null || dto.ref_range_high != null
        ? {
            loinc: dto.loinc_code,
            name: testName,
            unit: dto.value_unit ?? known?.unit ?? '',
            low: dto.ref_range_low ?? null,
            high: dto.ref_range_high ?? null,
            criticalLow: known?.criticalLow ?? null,
            criticalHigh: known?.criticalHigh ?? null,
          }
        : known;

    const derived = interpretResult(dto.value_quantity ?? null, range);
    const interpretation = derived.code ?? dto.interpretation ?? null;
    // Union, not override: whoever says "critical" is believed.
    const isCritical = derived.isCritical || dto.critical_flag === true;

    const result = await this.prisma.labResult.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: patientId,
        encounter_id: dto.encounter_id ?? order?.encounter_id ?? null,
        service_request_id: dto.service_request_id ?? null,
        specimen_id: dto.specimen_id ?? null,
        loinc_code: dto.loinc_code,
        display: testName,
        status: dto.status,
        value_quantity: dto.value_quantity ?? null,
        value_string: dto.value_string ?? null,
        unit: dto.value_unit ?? range?.unit ?? null,
        reference_low: range?.low ?? null,
        reference_high: range?.high ?? null,
        reference_text: range?.text ?? null,
        interpretation,
        is_critical: isCritical,
        method: dto.method,
        analyzer_id: dto.analyzer_id,
        performed_at: new Date(),
      },
    });

    // A resulted order is a finished order, unless it was only preliminary.
    if (order && dto.status === 'final' && order.status === 'active') {
      await this.prisma.serviceRequest.update({
        where: { id: order.id },
        data: { status: 'completed', performed_at: new Date() },
      });
    }

    await this.lab.publishResult(result, range, derived.reason);

    if (isCritical) {
      const event: LabCriticalValueEvent = {
        tenant_id: ctx.tenantId,
        patient_id: patientId,
        encounter_id: result.encounter_id,
        result_id: result.id,
        service_request_id: dto.service_request_id ?? null,
        loinc_code: dto.loinc_code,
        test_name: testName,
        value: String(dto.value_quantity ?? dto.value_string ?? ''),
        unit: result.unit,
        reference_range:
          range && (range.low != null || range.high != null)
            ? `${range.low ?? ''}–${range.high ?? ''} ${range.unit ?? ''}`.trim()
            : null,
        interpretation,
        // The clinician who is waiting for this number, not whoever is nearest.
        ordering_practitioner_id: order?.requester_id ?? null,
        occurred_at: new Date().toISOString(),
      };
      await this.kafka.emit(KAFKA_TOPICS.LAB_CRITICAL_VALUE, ctx.tenantId, event);
    }

    return { ...result, critical_flag: isCritical, interpretation };
  }

  /**
   * A patient's results with the trend behind each one.
   *
   * The window is deliberately wider than the number of points returned: a test
   * run monthly still needs five points, so enough rows are read to fill the
   * sparkline for every test rather than only the ones run recently.
   */
  async forPatient(params: { patientId: string; loincCode?: string; points?: number }) {
    const points = params.points ?? TREND_POINTS;
    const rows = await this.prisma.labResult.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        patient_id: params.patientId,
        deleted_at: null,
        ...(params.loincCode ? { loinc_code: params.loincCode } : {}),
      },
      orderBy: { performed_at: 'desc' },
      take: 500,
    });

    const results = rows.map((r) => ({
      ...r,
      value_quantity: r.value_quantity === null ? null : Number(r.value_quantity),
      reference_low: r.reference_low === null ? null : Number(r.reference_low),
      reference_high: r.reference_high === null ? null : Number(r.reference_high),
    }));

    return {
      results,
      trends: buildTrends(results, points),
    };
  }
}

@ApiTags('lab-results')
@Controller('lab-results')
export class LabResultsController {
  constructor(private readonly service: LabResultsService) {}

  @Post()
  @RequirePermissions('lab:result')
  @Audit({ action: 'lab.result.submit', resourceType: 'Observation', isPhi: true })
  @ApiOperation({ summary: 'File a result; the critical flag is re-derived server-side' })
  submit(@ZodBody(SubmitResultDto) dto: z.infer<typeof SubmitResultDto>) {
    return this.service.submit(dto);
  }

  @Get()
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Results for a patient with the last 5 values of each test' })
  forPatient(
    @Query('patientId') patientId?: string,
    @Query('loincCode') loincCode?: string,
    @Query('points') points?: string,
  ) {
    if (!patientId) throw new BadRequestException('patientId is required');
    return this.service.forPatient({
      patientId,
      loincCode,
      points: points ? Number(points) : undefined,
    });
  }
}
