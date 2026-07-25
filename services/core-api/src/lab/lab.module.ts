import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { KAFKA_TOPICS, WS_EVENTS, type CriticalAlertEvent, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { RealtimeGateway } from '../messaging/realtime.gateway';
import { currentContext } from '../common/tenant-context';
import { labResultToFhir, serviceRequestToFhir } from '../fhir/mappers';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { interpretResult, parseHl7Oru, type ReferenceRange } from './reference-ranges';

export const OrderLabDto = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid().nullable().optional(),
  loinc_code: z.string().min(1),
  display: z.string().min(1),
  priority: z.enum(['routine', 'urgent', 'asap', 'stat']).default('routine'),
  specimen_type: z.string().default('blood'),
  fasting_required: z.boolean().default(false),
  scheduled_for: z.coerce.date().optional(),
  clinical_notes: z.string().max(2000).optional(),
});

export const EnterResultDto = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid().nullable().optional(),
  service_request_id: z.string().uuid().nullable().optional(),
  specimen_id: z.string().uuid().nullable().optional(),
  loinc_code: z.string().min(1),
  display: z.string().min(1),
  value_quantity: z.number().nullable().optional(),
  value_string: z.string().nullable().optional(),
  unit: z.string().nullable().optional(),
  method: z.string().optional(),
  analyzer_id: z.string().optional(),
  status: z.enum(['registered', 'preliminary', 'final', 'amended', 'corrected']).default('final'),
});

@Injectable()
export class LabService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  private async nextOrderNumber(): Promise<string> {
    const stem = `LAB-${new Date().getFullYear()}-`;
    const last = await this.prisma.serviceRequest.findFirst({
      where: { tenant_id: currentContext().tenantId, order_number: { startsWith: stem } },
      orderBy: { order_number: 'desc' },
      select: { order_number: true },
    });
    const n = last ? Number(last.order_number.slice(stem.length)) + 1 : 1;
    return `${stem}${String(n).padStart(6, '0')}`;
  }

  /**
   * Placing an order also mints the specimen and its barcode, so phlebotomy always
   * has a scannable label before the patient is approached.
   */
  async order(dto: z.infer<typeof OrderLabDto>) {
    const ctx = currentContext();
    const orderNumber = await this.nextOrderNumber();
    // Code 128 payload: order number is the barcode; a check digit is added by the printer.
    const barcode = orderNumber.replace(/-/g, '');

    const request = await this.prisma.serviceRequest.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        encounter_id: dto.encounter_id ?? null,
        requester_id: ctx.practitionerId ?? ctx.userId!,
        category: 'laboratory',
        status: 'active',
        priority: dto.priority,
        code_system: 'http://loinc.org',
        code: dto.loinc_code,
        code_display: dto.display,
        order_number: orderNumber,
        barcode,
        fasting_required: dto.fasting_required,
        scheduled_for: dto.scheduled_for,
        clinical_notes: dto.clinical_notes,
        specimens: {
          create: {
            tenant_id: ctx.tenantId,
            patient_id: dto.patient_id,
            accession_number: orderNumber,
            barcode,
            type: dto.specimen_type,
            status: 'pending-collection',
          },
        },
      },
      include: { specimens: true },
    });

    const event: FhirSyncEvent = {
      tenant_id: ctx.tenantId,
      resource_type: 'ServiceRequest',
      internal_id: request.id,
      fhir_id: request.fhir_id,
      operation: 'create',
      payload: serviceRequestToFhir(request as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, event);
    return request;
  }

  async collectSpecimen(specimenId: string, scannedBarcode: string) {
    const ctx = currentContext();
    const specimen = await this.prisma.labSpecimen.findFirst({
      where: { id: specimenId, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!specimen) throw new BadRequestException('Specimen not found');
    // Barcode mismatch here means the wrong tube or the wrong patient — never proceed.
    if (specimen.barcode !== scannedBarcode) {
      throw new BadRequestException({
        code: 'BARCODE_MISMATCH',
        message: 'Scanned barcode does not match this specimen',
        expected: specimen.barcode,
        scanned: scannedBarcode,
      });
    }
    return this.prisma.labSpecimen.update({
      where: { id: specimenId },
      data: { status: 'collected', collected_by: ctx.userId, collected_at: new Date() },
    });
  }

  /** Demographic-aware reference range lookup for the patient. */
  private async rangeFor(patientId: string, loinc: string): Promise<ReferenceRange | null> {
    const patient = await this.prisma.patient.findFirst({
      where: { id: patientId, tenant_id: currentContext().tenantId },
      select: { gender: true, birth_date: true },
    });
    if (!patient) return null;
    const ageYears = Math.floor((Date.now() - patient.birth_date.getTime()) / (365.25 * 86_400_000));
    const { rangeFor } = await import('./reference-ranges');
    return rangeFor(loinc, { gender: patient.gender, ageYears });
  }

  async enterResult(dto: z.infer<typeof EnterResultDto>) {
    const ctx = currentContext();
    const range = await this.rangeFor(dto.patient_id, dto.loinc_code);
    const interpretation = interpretResult(dto.value_quantity ?? null, range);

    const result = await this.prisma.labResult.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        encounter_id: dto.encounter_id ?? null,
        service_request_id: dto.service_request_id ?? null,
        specimen_id: dto.specimen_id ?? null,
        loinc_code: dto.loinc_code,
        display: dto.display,
        status: dto.status,
        value_quantity: dto.value_quantity ?? null,
        value_string: dto.value_string ?? null,
        unit: dto.unit ?? range?.unit ?? null,
        reference_low: range?.low ?? null,
        reference_high: range?.high ?? null,
        reference_text: range?.text ?? null,
        interpretation: interpretation.code,
        is_critical: interpretation.isCritical,
        method: dto.method,
        analyzer_id: dto.analyzer_id,
        performed_at: new Date(),
      },
    });

    const syncEvent: FhirSyncEvent = {
      tenant_id: ctx.tenantId,
      resource_type: 'Observation',
      internal_id: result.id,
      fhir_id: result.fhir_id,
      operation: 'create',
      payload: labResultToFhir(result as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, syncEvent);

    this.realtime.emitToChannel(ctx.tenantId, `patient:${dto.patient_id}`, WS_EVENTS.LAB_RESULT, {
      result_id: result.id,
      display: dto.display,
      is_critical: interpretation.isCritical,
    });

    // A critical value must reach a clinician; it is not enough to file it in the chart.
    if (interpretation.isCritical) {
      const alert: CriticalAlertEvent = {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        encounter_id: dto.encounter_id ?? null,
        source: 'lab',
        severity: 'critical',
        title: `Critical lab value: ${dto.display}`,
        detail: interpretation.reason ?? 'Result is outside the critical threshold',
        value: `${dto.value_quantity ?? dto.value_string ?? ''} ${dto.unit ?? ''}`.trim(),
        reference_range: range ? `${range.low ?? ''}–${range.high ?? ''} ${range.unit ?? ''}`.trim() : undefined,
        target_roles: ['doctor', 'nurse'],
        occurred_at: new Date().toISOString(),
        dedupe_key: `lab:${result.id}`,
      };
      await this.kafka.emit(KAFKA_TOPICS.CRITICAL_ALERT, ctx.tenantId, alert);
      this.realtime.emitToRoles(ctx.tenantId, alert.target_roles, WS_EVENTS.CRITICAL_ALERT, alert);
    }

    return result;
  }

  async verify(resultId: string) {
    const ctx = currentContext();
    return this.prisma.labResult.update({
      where: { id: resultId },
      data: { status: 'final', verified_by: ctx.userId, verified_at: new Date() },
    });
  }

  async acknowledgeCritical(resultId: string) {
    const ctx = currentContext();
    return this.prisma.labResult.update({
      where: { id: resultId },
      data: { critical_notified_at: new Date(), critical_notified_to: ctx.userId },
    });
  }

  /** Bulk import of HL7 v2 ORU^R01 result messages from an analyser or reference lab. */
  async importHl7(message: string) {
    const parsed = parseHl7Oru(message);
    const imported: string[] = [];
    const errors: string[] = [];

    for (const obx of parsed.observations) {
      try {
        const specimen = parsed.accessionNumber
          ? await this.prisma.labSpecimen.findFirst({
              where: {
                tenant_id: currentContext().tenantId,
                accession_number: parsed.accessionNumber,
                deleted_at: null,
              },
            })
          : null;
        if (!specimen) {
          errors.push(`No specimen for accession ${parsed.accessionNumber}`);
          continue;
        }
        const result = await this.enterResult({
          patient_id: specimen.patient_id,
          service_request_id: specimen.service_request_id,
          specimen_id: specimen.id,
          loinc_code: obx.loinc,
          display: obx.display,
          value_quantity: obx.numericValue,
          value_string: obx.numericValue === null ? obx.rawValue : null,
          unit: obx.unit,
          status: obx.status,
        });
        imported.push(result.id);
      } catch (e) {
        errors.push(`${obx.loinc}: ${String(e)}`);
      }
    }

    return { message_type: parsed.messageType, imported: imported.length, ids: imported, errors };
  }

  async worklist(status = 'active') {
    return this.prisma.serviceRequest.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        category: 'laboratory',
        deleted_at: null,
        status: status as never,
      },
      include: {
        patient: { select: { mrn: true, given_names: true, family_name: true } },
        specimens: true,
      },
      orderBy: [{ priority: 'desc' }, { created_at: 'asc' }],
      take: 200,
    });
  }

  async resultsForPatient(patientId: string, limit = 100) {
    return this.prisma.labResult.findMany({
      where: { tenant_id: currentContext().tenantId, patient_id: patientId, deleted_at: null },
      orderBy: { performed_at: 'desc' },
      take: limit,
    });
  }

  async criticalPending() {
    return this.prisma.labResult.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        is_critical: true,
        critical_notified_at: null,
      },
      include: { patient: { select: { mrn: true, given_names: true, family_name: true } } },
      orderBy: { performed_at: 'asc' },
    });
  }
}

@ApiTags('lab')
@Controller('lab')
export class LabController {
  constructor(private readonly service: LabService) {}

  @Get('worklist')
  @RequirePermissions('lab:order')
  worklist(@Query('status') status?: string) {
    return this.service.worklist(status ?? 'active');
  }

  @Get('critical-pending')
  @RequirePermissions('lab:result')
  criticalPending() {
    return this.service.criticalPending();
  }

  @Post('orders')
  @RequirePermissions('lab:order')
  @Audit({ action: 'lab.order', resourceType: 'ServiceRequest', isPhi: true })
  order(@ZodBody(OrderLabDto) dto: z.infer<typeof OrderLabDto>) {
    return this.service.order(dto);
  }

  @Post('specimens/:id/collect')
  @RequirePermissions('lab:order')
  @Audit({ action: 'lab.specimen.collect', resourceType: 'Specimen', isPhi: true })
  collect(@Param('id', ParseUUIDPipe) id: string, @Body('barcode') barcode: string) {
    return this.service.collectSpecimen(id, barcode);
  }

  @Post('results')
  @RequirePermissions('lab:result')
  @Audit({ action: 'lab.result.enter', resourceType: 'Observation', isPhi: true })
  enter(@ZodBody(EnterResultDto) dto: z.infer<typeof EnterResultDto>) {
    return this.service.enterResult(dto);
  }

  @Post('results/:id/verify')
  @RequirePermissions('lab:verify')
  @Audit({ action: 'lab.result.verify', resourceType: 'Observation', isPhi: true })
  verify(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.verify(id);
  }

  @Post('results/:id/acknowledge')
  @RequirePermissions('lab:result')
  @Audit({ action: 'lab.critical.acknowledge', resourceType: 'Observation', isPhi: true })
  acknowledge(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.acknowledgeCritical(id);
  }

  @Get('results/patient/:patientId')
  @RequirePermissions('patient:read')
  forPatient(@Param('patientId', ParseUUIDPipe) patientId: string, @Query('limit') limit?: string) {
    return this.service.resultsForPatient(patientId, limit ? Number(limit) : 100);
  }

  @Post('hl7/import')
  @RequirePermissions('lab:result')
  @Audit({ action: 'lab.hl7.import', resourceType: 'Observation', isPhi: true })
  @ApiOperation({ summary: 'Import HL7 v2 ORU^R01 results from an analyser or reference lab' })
  importHl7(@Body('message') message: string) {
    return this.service.importHl7(message);
  }
}

@Module({
  controllers: [LabController],
  providers: [LabService],
  exports: [LabService],
})
export class LabModule {}
