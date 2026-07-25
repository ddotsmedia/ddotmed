import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { KAFKA_TOPICS, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { medicationRequestToFhir } from '../fhir/mappers';
import { AllergiesService } from '../allergies/allergies.service';
import { InteractionsService } from './interactions.service';

export const PrescribeDto = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid().nullable().optional(),
  drug_formulary_id: z.string().uuid().nullable().optional(),
  code: z.string().min(1),
  code_display: z.string().min(1),
  dose_quantity: z.number().positive(),
  dose_unit: z.string().min(1),
  route: z.string().min(1),
  frequency: z.string().min(1),
  duration_days: z.number().int().positive().nullable().optional(),
  quantity: z.number().int().positive(),
  refills: z.number().int().min(0).default(0),
  instructions: z.string().max(1000).optional(),
  is_prn: z.boolean().default(false),
  witness_id: z.string().uuid().nullable().optional(),
  /** Required to proceed past a LOW-criticality allergy warning. */
  allergy_override_reason: z.string().min(10).max(500).optional(),
  /** Required to proceed past a non-contraindicated interaction. */
  interaction_override_reason: z.string().min(10).max(500).optional(),
});
export type PrescribeDto = z.infer<typeof PrescribeDto>;

@Injectable()
export class MedicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly allergies: AllergiesService,
    private readonly interactions: InteractionsService,
  ) {}

  async listForPatient(patientId: string, activeOnly = true) {
    return this.prisma.medication.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        patient_id: patientId,
        deleted_at: null,
        ...(activeOnly ? { status: { in: ['active', 'on_hold'] } } : {}),
      },
      include: { formulary: true },
      orderBy: { created_at: 'desc' },
    });
  }

  /**
   * Prescribing gate. Both checks run on EVERY save — there is no code path that
   * writes a MedicationRequest without them, and both timestamps are persisted so
   * an audit can prove the checks happened.
   */
  async prescribe(dto: PrescribeDto) {
    const ctx = currentContext();

    const formulary = dto.drug_formulary_id
      ? await this.prisma.drugFormulary.findFirst({
          where: { id: dto.drug_formulary_id, tenant_id: ctx.tenantId, deleted_at: null },
        })
      : null;

    // 1 — MANDATORY allergy check.
    const allergyResult = await this.allergies.checkAgainstDrug(dto.patient_id, {
      rxnorm: dto.code,
      name: dto.code_display,
      ingredients: formulary ? [formulary.generic_name] : [],
    });
    this.allergies.assertNotBlocked(allergyResult, dto.code_display);
    const allergyWarnings = allergyResult.warnings.filter((w) => w.action === 'warn');
    if (allergyWarnings.length > 0 && !dto.allergy_override_reason) {
      throw new ConflictException({
        code: 'ALLERGY_WARNING_UNACKNOWLEDGED',
        message: 'A documented reason is required to prescribe despite the recorded allergy',
        warnings: allergyWarnings,
        override_allowed: true,
      });
    }

    // 2 — MANDATORY drug-drug interaction check.
    const interactionResult = await this.interactions.check(dto.patient_id, {
      rxnorm: dto.code,
      name: dto.code_display,
    });
    const contraindicated = interactionResult.findings.filter((f) => f.severity === 'contraindicated');
    if (contraindicated.length > 0) {
      this.interactions.assertNotBlocked({ blocked: true, findings: contraindicated }, dto.code_display);
    }
    const overridableBlocks = interactionResult.findings.filter((f) => f.action === 'block');
    if (overridableBlocks.length > 0 && !dto.interaction_override_reason) {
      this.interactions.assertNotBlocked(interactionResult, dto.code_display);
    }
    const interactionWarnings = interactionResult.findings.filter((f) => f.action === 'warn');

    // 3 — Controlled drugs require a witness identified at the point of prescribing.
    const isControlled = formulary?.is_controlled ?? false;
    if (isControlled && !dto.witness_id) {
      throw new BadRequestException({
        code: 'WITNESS_REQUIRED',
        message: `${dto.code_display} is a controlled drug and requires a witness`,
        controlled_schedule: formulary?.controlled_schedule,
      });
    }
    if (isControlled && dto.witness_id === ctx.userId) {
      throw new BadRequestException({
        code: 'WITNESS_INVALID',
        message: 'The witness must be a different person from the prescriber',
      });
    }

    const now = new Date();
    const medication = await this.prisma.medication.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        encounter_id: dto.encounter_id ?? null,
        prescriber_id: ctx.practitionerId ?? ctx.userId!,
        drug_formulary_id: dto.drug_formulary_id ?? null,
        status: 'active',
        code: dto.code,
        code_display: dto.code_display,
        dose_quantity: dto.dose_quantity,
        dose_unit: dto.dose_unit,
        route: dto.route,
        frequency: dto.frequency,
        duration_days: dto.duration_days ?? null,
        quantity: dto.quantity,
        refills: dto.refills,
        instructions: dto.instructions,
        is_prn: dto.is_prn,
        is_controlled: isControlled,
        controlled_schedule: formulary?.controlled_schedule ?? null,
        witness_id: dto.witness_id ?? null,
        allergy_checked_at: now,
        interaction_checked_at: now,
        allergy_override_reason: dto.allergy_override_reason ?? null,
        interaction_override_reason: dto.interaction_override_reason ?? null,
        start_date: now,
        end_date: dto.duration_days
          ? new Date(now.getTime() + dto.duration_days * 86_400_000)
          : null,
      },
    });

    if (isControlled) {
      await this.prisma.controlledDrugRegister.create({
        data: {
          tenant_id: ctx.tenantId,
          medication_id: medication.id,
          entry_type: 'prescribed',
          schedule: formulary?.controlled_schedule ?? 'unscheduled',
          drug_name: dto.code_display,
          quantity_change: -dto.quantity,
          balance_after: 0,
          performed_by: ctx.userId!,
          witness_id: dto.witness_id!,
          patient_id: dto.patient_id,
          reason: 'Prescription issued',
        },
      });
    }

    const event: FhirSyncEvent = {
      tenant_id: ctx.tenantId,
      resource_type: 'MedicationRequest',
      internal_id: medication.id,
      fhir_id: medication.fhir_id,
      operation: 'create',
      payload: medicationRequestToFhir(medication as unknown as Record<string, unknown>),
      occurred_at: now.toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, event);

    return {
      ...medication,
      safety: {
        allergy_warnings: allergyWarnings,
        interaction_warnings: interactionWarnings,
        overridden: Boolean(dto.allergy_override_reason || dto.interaction_override_reason),
      },
    };
  }

  /** Dry-run of both gates, used by the prescribing UI before the clinician commits. */
  async preflight(patientId: string, code: string, display: string) {
    const [allergy, interaction] = await Promise.all([
      this.allergies.checkAgainstDrug(patientId, { rxnorm: code, name: display }),
      this.interactions.check(patientId, { rxnorm: code, name: display }),
    ]);
    return {
      allergy,
      interaction,
      can_prescribe: !allergy.blocked && !interaction.findings.some((f) => f.severity === 'contraindicated'),
    };
  }

  async stop(id: string, reason: string) {
    const ctx = currentContext();
    const med = await this.prisma.medication.findFirst({
      where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!med) throw new BadRequestException('Medication not found');
    return this.prisma.medication.update({
      where: { id },
      data: { status: 'stopped', end_date: new Date(), instructions: reason },
    });
  }
}
