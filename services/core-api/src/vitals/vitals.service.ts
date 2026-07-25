import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { KAFKA_TOPICS, WS_EVENTS, type CriticalAlertEvent, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { RealtimeGateway } from '../messaging/realtime.gateway';
import { currentContext } from '../common/tenant-context';
import { vitalsToFhirObservations } from '../fhir/mappers';
import { calculateBmi, calculateEws, detectCriticalVitals } from './ews';

export const RecordVitalsDto = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid().nullable().optional(),
  recorded_at: z.coerce.date().optional(),
  source: z.enum(['manual', 'device', 'wearable']).default('manual'),
  device_id: z.string().max(120).optional(),
  systolic_bp: z.number().int().min(0).max(300).nullable().optional(),
  diastolic_bp: z.number().int().min(0).max(200).nullable().optional(),
  heart_rate: z.number().int().min(0).max(300).nullable().optional(),
  respiratory_rate: z.number().int().min(0).max(100).nullable().optional(),
  temperature_c: z.number().min(20).max(45).nullable().optional(),
  spo2: z.number().int().min(0).max(100).nullable().optional(),
  supplemental_o2: z.boolean().default(false),
  consciousness: z.enum(['A', 'C', 'V', 'P', 'U']).nullable().optional(),
  pain_score: z.number().int().min(0).max(10).nullable().optional(),
  weight_kg: z.number().positive().max(700).nullable().optional(),
  height_cm: z.number().positive().max(280).nullable().optional(),
});
export type RecordVitalsDto = z.infer<typeof RecordVitalsDto>;

/** IoT/bedside monitor ingestion — same scoring path, no interactive fields. */
export const DeviceVitalsDto = RecordVitalsDto.omit({ source: true }).extend({
  device_id: z.string().min(1),
  device_type: z.string().optional(),
});

@Injectable()
export class VitalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async listForPatient(patientId: string, limit = 50) {
    return this.prisma.vital.findMany({
      where: { tenant_id: currentContext().tenantId, patient_id: patientId, deleted_at: null },
      orderBy: { recorded_at: 'desc' },
      take: limit,
    });
  }

  /** EWS is recomputed on every save; a stored score is never trusted across edits. */
  async record(dto: RecordVitalsDto) {
    const ctx = currentContext();
    const ews = calculateEws(dto);
    const bmi = calculateBmi(dto.weight_kg, dto.height_cm);
    const critical = detectCriticalVitals(dto);
    const recordedAt = dto.recorded_at ?? new Date();

    const vital = await this.prisma.vital.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        encounter_id: dto.encounter_id ?? null,
        recorded_by: ctx.userId,
        recorded_at: recordedAt,
        source: dto.source,
        device_id: dto.device_id,
        systolic_bp: dto.systolic_bp ?? null,
        diastolic_bp: dto.diastolic_bp ?? null,
        heart_rate: dto.heart_rate ?? null,
        respiratory_rate: dto.respiratory_rate ?? null,
        temperature_c: dto.temperature_c ?? null,
        spo2: dto.spo2 ?? null,
        supplemental_o2: dto.supplemental_o2,
        consciousness: dto.consciousness ?? null,
        pain_score: dto.pain_score ?? null,
        weight_kg: dto.weight_kg ?? null,
        height_cm: dto.height_cm ?? null,
        bmi,
        ews_score: ews.score,
        ews_risk: ews.risk,
        escalated_at: ews.risk === 'high' ? new Date() : null,
      },
    });

    const syncEvent: FhirSyncEvent = {
      tenant_id: ctx.tenantId,
      resource_type: 'Observation',
      internal_id: vital.id,
      fhir_id: vital.fhir_id,
      operation: 'create',
      payload: { observations: vitalsToFhirObservations(vital as unknown as Record<string, unknown>) },
      occurred_at: recordedAt.toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, syncEvent);

    this.realtime.emitToChannel(
      ctx.tenantId,
      `patient:${dto.patient_id}`,
      WS_EVENTS.VITALS_RECORDED,
      { vital_id: vital.id, ews_score: ews.score, ews_risk: ews.risk },
    );

    // Escalate on a critical absolute value or a medium/high aggregate.
    if (critical.length > 0 || ews.risk !== 'low') {
      const severity: CriticalAlertEvent['severity'] =
        critical.length > 0 ? 'life-threatening' : ews.risk === 'high' ? 'critical' : 'warning';
      const alert: CriticalAlertEvent = {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        encounter_id: dto.encounter_id ?? null,
        source: critical.length > 0 ? 'vitals' : 'ews',
        severity,
        title: critical.length > 0 ? 'Critical vital sign' : `EWS ${ews.score} — ${ews.risk} risk`,
        detail: critical.length
          ? critical.map((c) => `${c.parameter} ${c.value} (${c.threshold})`).join('; ')
          : ews.response,
        value: String(ews.score),
        target_roles: ews.risk === 'high' || critical.length ? ['doctor', 'nurse'] : ['nurse'],
        occurred_at: recordedAt.toISOString(),
        dedupe_key: `vitals:${vital.id}`,
      };
      await this.kafka.emit(KAFKA_TOPICS.EWS_ESCALATION, ctx.tenantId, alert);
      this.realtime.emitToRoles(ctx.tenantId, alert.target_roles, WS_EVENTS.CRITICAL_ALERT, alert);
    }

    return { ...vital, ews, critical_values: critical };
  }

  async ingestFromDevice(dto: z.infer<typeof DeviceVitalsDto>) {
    return this.record({ ...dto, source: 'device' });
  }

  /** Score trend used by the ward EWS chart. */
  async trend(patientId: string, hours = 48) {
    const since = new Date(Date.now() - hours * 3_600_000);
    return this.prisma.vital.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        patient_id: patientId,
        deleted_at: null,
        recorded_at: { gte: since },
      },
      select: { recorded_at: true, ews_score: true, ews_risk: true, systolic_bp: true, heart_rate: true, spo2: true, temperature_c: true, respiratory_rate: true },
      orderBy: { recorded_at: 'asc' },
    });
  }
}
