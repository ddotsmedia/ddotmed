import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { KAFKA_TOPICS, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { medicationDispenseToFhir, medicationRequestToFhir } from '../fhir/mappers';
import { AllergiesService } from '../allergies/allergies.service';
import { InteractionsService } from './interactions.service';
import { searchDrugCatalogue, type DrugMatch } from './drug-catalogue';

export const PrescribeDto = z.object({
  patient_id: z.string().uuid(),
  /** One reason satisfies both gates; the granular fields below still work. */
  override_reason: z.string().min(10).max(500).optional(),
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

export const ModifyMedicationDto = z.object({
  status: z.enum(['active', 'on_hold', 'stopped', 'cancelled', 'completed']).optional(),
  dose_quantity: z.number().positive().optional(),
  dose_unit: z.string().min(1).optional(),
  route: z.string().min(1).optional(),
  frequency: z.string().min(1).optional(),
  duration_days: z.number().int().positive().nullable().optional(),
  instructions: z.string().max(1000).optional(),
  /** Mandatory when discontinuing — a stopped drug with no reason is unreviewable. */
  reason: z.string().min(3).max(500).optional(),
});

export const DispenseRecordDto = z.object({
  quantity: z.number().int().positive(),
  batch_number: z.string().max(60).optional(),
  expiry_date: z.coerce.date().optional(),
  witness_id: z.string().uuid().nullable().optional(),
  substituted: z.boolean().default(false),
  substitution_reason: z.string().max(500).optional(),
});

@Injectable()
export class MedicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly allergies: AllergiesService,
    private readonly interactions: InteractionsService,
  ) {}

  async listForPatient(patientId: string, activeOnly = true) {
    return this.list({ patientId, status: activeOnly ? 'active' : undefined });
  }

  /**
   * `status=active` means "currently being taken", which includes a drug on hold —
   * a paused course is still on the chart and still interacts.
   */
  async list(params: { patientId: string; status?: string; encounterId?: string }) {
    const status =
      params.status === 'active' || !params.status
        ? params.status === 'active'
          ? { in: ['active', 'on_hold'] as const }
          : undefined
        : { equals: params.status as never };

    return this.prisma.medication.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        patient_id: params.patientId,
        deleted_at: null,
        ...(params.encounterId ? { encounter_id: params.encounterId } : {}),
        ...(status ? { status: status as never } : {}),
      },
      include: { formulary: true, dispenses: { where: { deleted_at: null } } },
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
    const allergyOverride = dto.allergy_override_reason ?? dto.override_reason;
    const interactionOverride = dto.interaction_override_reason ?? dto.override_reason;

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
    if (allergyWarnings.length > 0 && !allergyOverride) {
      throw new ConflictException({
        code: 'ALLERGY_WARNING_UNACKNOWLEDGED',
        message: 'A documented reason is required to prescribe despite the recorded allergy',
        warnings: allergyWarnings,
        override_allowed: true,
      });
    }

    // 2 — MANDATORY drug-drug interaction check.
    // A contraindication ends the order outright; a major interaction is the
    // prescriber's call to make, but they have to put their reasoning on record.
    const interactionResult = await this.interactions.check(dto.patient_id, {
      rxnorm: dto.code,
      name: dto.code_display,
    });
    this.interactions.assertNotBlocked(interactionResult, dto.code_display);

    const needsOverride = interactionResult.findings.filter((f) => f.action === 'override');
    if (needsOverride.length > 0 && !interactionOverride) {
      throw new ConflictException({
        code: 'DRUG_INTERACTION',
        message: `A documented reason is required to prescribe ${dto.code_display} alongside ${needsOverride
          .map((f) => (f.drug_a === dto.code_display ? f.drug_b : f.drug_a))
          .join(', ')}`,
        findings: needsOverride,
        override_allowed: true,
      });
    }

    // Everything short of a contraindication is carried into the response, including
    // what was overridden — a warning the prescriber accepted still belongs on the record.
    const interactionWarnings = interactionResult.findings.filter((f) => f.action !== 'block');

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
        allergy_override_reason: allergyWarnings.length > 0 ? (allergyOverride ?? null) : null,
        interaction_override_reason: needsOverride.length > 0 ? (interactionOverride ?? null) : null,
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
        overridden:
          (allergyWarnings.length > 0 && Boolean(allergyOverride)) ||
          (needsOverride.length > 0 && Boolean(interactionOverride)),
      },
    };
  }

  /**
   * Drug search for the prescribing box.
   *
   * Tenant formulary rows come first — they carry the site's own stock, strengths
   * and controlled-drug flags — and the bundled catalogue fills the gap for a
   * tenant that has not loaded one. Both carry an RxNorm code, without which
   * nothing downstream can check the drug against an allergy or another drug.
   */
  async searchDrugs(query: string, limit = 10): Promise<DrugMatch[]> {
    const q = query.trim();
    if (q.length < 2) return [];

    const rows = await this.prisma.drugFormulary.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        is_formulary: true,
        OR: [
          { generic_name: { contains: q, mode: 'insensitive' } },
          { brand_name: { contains: q, mode: 'insensitive' } },
          { rxnorm_code: { startsWith: q } },
          { atc_code: { startsWith: q, mode: 'insensitive' } },
        ],
      },
      take: 25,
    });

    return searchDrugCatalogue(q, {
      limit,
      extra: rows.map((row) => ({
        formulary_id: row.id,
        rxnorm: row.rxnorm_code ?? '',
        atc: row.atc_code ?? '',
        generic_name: row.generic_name,
        brand_name: row.brand_name ?? undefined,
        strength: row.strength,
        dose_form: row.dose_form,
        drug_class: 'other' as const,
        is_controlled: row.is_controlled,
        controlled_schedule: row.controlled_schedule ?? undefined,
        score: 0,
        source: 'tenant' as const,
      })),
    });
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
      can_prescribe: !allergy.blocked && !interaction.blocked,
      requires_override:
        interaction.requires_override || allergy.warnings.some((w) => w.action === 'warn'),
    };
  }

  async stop(id: string, reason: string) {
    return this.modify(id, { status: 'stopped', reason });
  }

  /**
   * Discontinue or adjust a live prescription.
   *
   * Dose changes are applied in place rather than superseding the order: the
   * FHIR MedicationRequest keeps its identity across a titration, and the audit
   * log already records who changed what and when.
   */
  async modify(id: string, dto: z.infer<typeof ModifyMedicationDto>) {
    const ctx = currentContext();
    const med = await this.prisma.medication.findFirst({
      where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!med) throw new BadRequestException('Medication not found');
    if (med.status === 'stopped' || med.status === 'cancelled') {
      throw new BadRequestException(`This prescription is already ${med.status}`);
    }

    const stopping = dto.status === 'stopped' || dto.status === 'cancelled';
    if (stopping && !dto.reason) {
      throw new BadRequestException('A reason is required to discontinue a prescription');
    }

    const updated = await this.prisma.medication.update({
      where: { id },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.dose_quantity !== undefined ? { dose_quantity: dto.dose_quantity } : {}),
        ...(dto.dose_unit ? { dose_unit: dto.dose_unit } : {}),
        ...(dto.frequency ? { frequency: dto.frequency } : {}),
        ...(dto.route ? { route: dto.route } : {}),
        ...(dto.duration_days !== undefined ? { duration_days: dto.duration_days } : {}),
        ...(dto.instructions ? { instructions: dto.instructions } : {}),
        ...(stopping ? { end_date: new Date() } : {}),
        ...(dto.reason ? { deleted_reason: null, instructions: dto.reason } : {}),
      },
    });

    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, {
      tenant_id: ctx.tenantId,
      resource_type: 'MedicationRequest',
      internal_id: updated.id,
      fhir_id: updated.fhir_id,
      operation: 'update',
      payload: medicationRequestToFhir(updated as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    } satisfies FhirSyncEvent);

    return updated;
  }

  /**
   * Records that a prescription was handed to the patient.
   *
   * Distinct from the pharmacy dispense flow, which additionally verifies
   * barcodes and draws down tracked stock. This is the clinic case: no stock
   * ledger, but the same rules about quantity, controlled drugs and witnesses.
   */
  async dispense(id: string, dto: z.infer<typeof DispenseRecordDto>) {
    const ctx = currentContext();
    const med = await this.prisma.medication.findFirst({
      where: { id, tenant_id: ctx.tenantId, deleted_at: null },
      include: { dispenses: { where: { deleted_at: null } } },
    });
    if (!med) throw new BadRequestException('Prescription not found');
    if (med.status !== 'active' && med.status !== 'on_hold') {
      throw new BadRequestException(`Cannot dispense against a ${med.status} prescription`);
    }

    if (med.is_controlled && !dto.witness_id) {
      throw new BadRequestException({
        code: 'WITNESS_REQUIRED',
        message: 'A witness is required to dispense a controlled drug',
        controlled_schedule: med.controlled_schedule,
      });
    }

    // Refills are the ceiling on how much may leave the pharmacy in total.
    const alreadyDispensed = med.dispenses.reduce((sum, d) => sum + d.quantity, 0);
    const authorised = med.quantity * (1 + med.refills);
    if (alreadyDispensed + dto.quantity > authorised) {
      throw new BadRequestException({
        code: 'QUANTITY_EXCEEDS_PRESCRIPTION',
        message: `Only ${authorised - alreadyDispensed} of ${authorised} remain authorised on this prescription`,
        authorised,
        already_dispensed: alreadyDispensed,
      });
    }

    const dispense = await this.prisma.medicationDispense.create({
      data: {
        tenant_id: ctx.tenantId,
        medication_id: med.id,
        patient_id: med.patient_id,
        dispensed_by: ctx.userId!,
        witness_id: dto.witness_id ?? null,
        status: 'completed',
        quantity: dto.quantity,
        batch_number: dto.batch_number ?? null,
        expiry_date: dto.expiry_date ?? null,
        substituted: dto.substituted,
        substitution_reason: dto.substitution_reason ?? null,
        barcode_verified: false,
        dispensed_at: new Date(),
      },
    });

    if (med.is_controlled) {
      await this.prisma.controlledDrugRegister.create({
        data: {
          tenant_id: ctx.tenantId,
          medication_id: med.id,
          entry_type: 'dispensed',
          schedule: med.controlled_schedule ?? 'unscheduled',
          drug_name: med.code_display,
          quantity_change: -dto.quantity,
          balance_after: 0,
          performed_by: ctx.userId!,
          witness_id: dto.witness_id!,
          patient_id: med.patient_id,
          reason: 'Dispensed against prescription',
        },
      });
    }

    // A fully-dispensed course with no refills left is finished.
    const remaining = authorised - (alreadyDispensed + dto.quantity);
    if (remaining <= 0) {
      await this.prisma.medication.update({ where: { id: med.id }, data: { status: 'completed' } });
    }

    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, {
      tenant_id: ctx.tenantId,
      resource_type: 'MedicationDispense',
      internal_id: dispense.id,
      fhir_id: dispense.fhir_id,
      operation: 'create',
      payload: medicationDispenseToFhir(dispense as unknown as Record<string, unknown>),
      occurred_at: dispense.dispensed_at.toISOString(),
    } satisfies FhirSyncEvent);

    return { dispense, remaining_authorised: Math.max(0, remaining) };
  }
}
