import {
  BadRequestException,
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
import { KAFKA_TOPICS, type CriticalAlertEvent, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { imagingStudyToFhir, serviceRequestToFhir } from '../fhir/mappers';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';

/** DICOM modality codes accepted by the RIS. */
const MODALITIES = ['CR', 'CT', 'MR', 'US', 'XA', 'NM', 'PT', 'MG', 'DX', 'RF', 'OT'] as const;

export const OrderImagingDto = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid().nullable().optional(),
  modality: z.enum(MODALITIES),
  code: z.string().min(1),
  code_display: z.string().min(1),
  body_site: z.string().optional(),
  priority: z.enum(['routine', 'urgent', 'asap', 'stat']).default('routine'),
  reason_text: z.string().max(1000).optional(),
  scheduled_for: z.coerce.date().optional(),
});

export const RegisterStudyDto = z.object({
  service_request_id: z.string().uuid(),
  study_instance_uid: z.string().min(10),
  series_count: z.number().int().min(0).default(0),
  instance_count: z.number().int().min(0).default(0),
  pacs_url: z.string().url().optional(),
  radiation_dose_mgy: z.number().min(0).nullable().optional(),
  description: z.string().max(500).optional(),
});

export const ReportDto = z.object({
  imaging_study_id: z.string().uuid(),
  clinical_history: z.string().max(4000).optional(),
  technique: z.string().max(2000).optional(),
  findings: z.string().min(1).max(20000),
  impression: z.string().min(1).max(8000),
  recommendation: z.string().max(4000).optional(),
  is_critical: z.boolean().default(false),
  /** Set when the text originated from voice dictation rather than typing. */
  transcription_source: z.enum(['typed', 'voice', 'ai-assisted']).default('typed'),
  ai_drafted: z.boolean().default(false),
  ai_confidence: z.number().min(0).max(1).nullable().optional(),
  sign: z.boolean().default(false),
});

@Injectable()
export class RadiologyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  private async nextAccession(): Promise<string> {
    const stem = `RAD-${new Date().getFullYear()}-`;
    const last = await this.prisma.serviceRequest.findFirst({
      where: { tenant_id: currentContext().tenantId, order_number: { startsWith: stem } },
      orderBy: { order_number: 'desc' },
      select: { order_number: true },
    });
    const n = last ? Number(last.order_number.slice(stem.length)) + 1 : 1;
    return `${stem}${String(n).padStart(6, '0')}`;
  }

  async order(dto: z.infer<typeof OrderImagingDto>) {
    const ctx = currentContext();
    const accession = await this.nextAccession();

    const request = await this.prisma.serviceRequest.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        encounter_id: dto.encounter_id ?? null,
        requester_id: ctx.practitionerId ?? ctx.userId!,
        category: 'imaging',
        status: 'active',
        priority: dto.priority,
        code_system: 'http://loinc.org',
        code: dto.code,
        code_display: dto.code_display,
        order_number: accession,
        barcode: accession.replace(/-/g, ''),
        reason_text: dto.reason_text,
        scheduled_for: dto.scheduled_for,
      },
    });

    await this.prisma.imagingStudy.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        encounter_id: dto.encounter_id ?? null,
        service_request_id: request.id,
        // Placeholder UID until the modality reports the real one at acquisition.
        study_instance_uid: `pending:${request.id}`,
        accession_number: accession,
        modality: dto.modality,
        body_site: dto.body_site,
        description: dto.code_display,
        status: 'registered',
      },
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

  /** Called by the PACS/modality worklist bridge once acquisition completes. */
  async registerStudy(dto: z.infer<typeof RegisterStudyDto>) {
    const ctx = currentContext();
    const study = await this.prisma.imagingStudy.findFirst({
      where: { service_request_id: dto.service_request_id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!study) throw new BadRequestException('No imaging study for that order');

    const updated = await this.prisma.imagingStudy.update({
      where: { id: study.id },
      data: {
        study_instance_uid: dto.study_instance_uid,
        series_count: dto.series_count,
        instance_count: dto.instance_count,
        pacs_url: dto.pacs_url,
        radiation_dose_mgy: dto.radiation_dose_mgy ?? null,
        description: dto.description ?? study.description,
        status: 'completed',
        started_at: study.started_at ?? new Date(),
        completed_at: new Date(),
        performed_by: ctx.userId,
      },
    });

    await this.prisma.serviceRequest.update({
      where: { id: dto.service_request_id },
      data: { status: 'completed', performed_at: new Date() },
    });

    const event: FhirSyncEvent = {
      tenant_id: ctx.tenantId,
      resource_type: 'ImagingStudy',
      internal_id: updated.id,
      fhir_id: updated.fhir_id,
      operation: 'update',
      payload: imagingStudyToFhir(updated as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, event);
    return updated;
  }

  /** RIS worklist: ordered studies awaiting acquisition or reporting. */
  async worklist(status?: string) {
    return this.prisma.imagingStudy.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        ...(status ? { status } : { status: { in: ['registered', 'completed'] } }),
      },
      include: {
        patient: { select: { id: true, mrn: true, given_names: true, family_name: true, birth_date: true, gender: true } },
        service_request: { select: { priority: true, reason_text: true, scheduled_for: true } },
        reports: { select: { id: true, status: true, signed_at: true } },
      },
      orderBy: [{ created_at: 'asc' }],
      take: 200,
    });
  }

  async report(dto: z.infer<typeof ReportDto>) {
    const ctx = currentContext();
    const study = await this.prisma.imagingStudy.findFirst({
      where: { id: dto.imaging_study_id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!study) throw new BadRequestException('Imaging study not found');

    const report = await this.prisma.radiologyReport.create({
      data: {
        tenant_id: ctx.tenantId,
        imaging_study_id: dto.imaging_study_id,
        radiologist_id: ctx.practitionerId ?? ctx.userId!,
        // An AI-drafted report is never final until a radiologist signs it.
        status: dto.sign && !dto.ai_drafted ? 'final' : 'preliminary',
        clinical_history: dto.clinical_history,
        technique: dto.technique,
        findings: dto.findings,
        impression: dto.impression,
        recommendation: dto.recommendation,
        is_critical: dto.is_critical,
        transcription_source: dto.transcription_source,
        ai_drafted: dto.ai_drafted,
        ai_confidence: dto.ai_confidence ?? null,
        signed_at: dto.sign && !dto.ai_drafted ? new Date() : null,
      },
    });

    if (dto.is_critical) {
      const alert: CriticalAlertEvent = {
        tenant_id: ctx.tenantId,
        patient_id: study.patient_id,
        encounter_id: study.encounter_id,
        source: 'lab',
        severity: 'critical',
        title: `Critical imaging finding: ${study.modality} ${study.description ?? ''}`.trim(),
        detail: dto.impression.slice(0, 500),
        target_roles: ['doctor'],
        occurred_at: new Date().toISOString(),
        dedupe_key: `radiology:${report.id}`,
      };
      await this.kafka.emit(KAFKA_TOPICS.CRITICAL_ALERT, ctx.tenantId, alert);
      await this.prisma.radiologyReport.update({
        where: { id: report.id },
        data: { critical_notified_at: new Date() },
      });
    }

    return report;
  }

  async signReport(reportId: string) {
    const ctx = currentContext();
    const report = await this.prisma.radiologyReport.findFirst({
      where: { id: reportId, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!report) throw new BadRequestException('Report not found');
    if (report.signed_at) throw new BadRequestException('Report is already signed');

    return this.prisma.radiologyReport.update({
      where: { id: reportId },
      data: {
        status: 'final',
        signed_at: new Date(),
        radiologist_id: ctx.practitionerId ?? ctx.userId!,
        // Signing converts an AI draft into a clinician-owned report.
        ai_drafted: false,
      },
    });
  }

  async studiesForPatient(patientId: string) {
    return this.prisma.imagingStudy.findMany({
      where: { tenant_id: currentContext().tenantId, patient_id: patientId, deleted_at: null },
      include: { reports: true },
      orderBy: { created_at: 'desc' },
    });
  }
}

@ApiTags('radiology')
@Controller('radiology')
export class RadiologyController {
  constructor(private readonly service: RadiologyService) {}

  @Get('worklist')
  @RequirePermissions('imaging:report')
  worklist(@Query('status') status?: string) {
    return this.service.worklist(status);
  }

  @Post('orders')
  @RequirePermissions('imaging:order')
  @Audit({ action: 'imaging.order', resourceType: 'ServiceRequest', isPhi: true })
  order(@ZodBody(OrderImagingDto) dto: z.infer<typeof OrderImagingDto>) {
    return this.service.order(dto);
  }

  @Post('studies')
  @RequirePermissions('imaging:report')
  @Audit({ action: 'imaging.study.register', resourceType: 'ImagingStudy', isPhi: true })
  @ApiOperation({ summary: 'Register DICOM study metadata from the modality/PACS bridge' })
  registerStudy(@ZodBody(RegisterStudyDto) dto: z.infer<typeof RegisterStudyDto>) {
    return this.service.registerStudy(dto);
  }

  @Post('reports')
  @RequirePermissions('imaging:report')
  @Audit({ action: 'imaging.report.write', resourceType: 'DiagnosticReport', isPhi: true })
  report(@ZodBody(ReportDto) dto: z.infer<typeof ReportDto>) {
    return this.service.report(dto);
  }

  @Post('reports/:id/sign')
  @RequirePermissions('imaging:report')
  @Audit({ action: 'imaging.report.sign', resourceType: 'DiagnosticReport', isPhi: true })
  sign(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.signReport(id);
  }

  @Get('patient/:patientId')
  @RequirePermissions('patient:read')
  forPatient(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.service.studiesForPatient(patientId);
  }
}

@Module({
  controllers: [RadiologyController],
  providers: [RadiologyService],
  exports: [RadiologyService],
})
export class RadiologyModule {}
