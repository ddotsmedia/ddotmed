import { ConflictException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { KAFKA_TOPICS, type CriticalAlertEvent, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { allergyToFhir } from '../fhir/mappers';

export const RecordAllergyDto = z.object({
  patient_id: z.string().uuid(),
  type: z.enum(['allergy', 'intolerance']).default('allergy'),
  category: z.enum(['food', 'medication', 'environment', 'biologic', 'latex', 'contrast']),
  criticality: z.enum(['low', 'high', 'unable_to_assess']).default('low'),
  code_system: z.string().default('http://snomed.info/sct'),
  code: z.string().min(1),
  code_display: z.string().optional(),
  substance_rxnorm: z.string().optional(),
  reaction: z.array(z.string()).default([]),
  severity: z.enum(['mild', 'moderate', 'severe']).optional(),
  onset_date: z.coerce.date().optional(),
  notes: z.string().max(2000).optional(),
});
export type RecordAllergyDto = z.infer<typeof RecordAllergyDto>;

export interface AllergyCheckResult {
  blocked: boolean;
  warnings: Array<{
    allergy_id: string;
    substance: string;
    criticality: string;
    reaction: string[];
    action: 'block' | 'warn';
  }>;
}

@Injectable()
export class AllergiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  async listForPatient(patientId: string, includeInactive = false) {
    return this.prisma.allergy.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        patient_id: patientId,
        deleted_at: null,
        ...(includeInactive ? {} : { clinical_status: 'active' }),
      },
      orderBy: [{ criticality: 'desc' }, { created_at: 'desc' }],
    });
  }

  async record(dto: RecordAllergyDto) {
    const ctx = currentContext();
    const allergy = await this.prisma.allergy.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        type: dto.type,
        category: dto.category,
        criticality: dto.criticality,
        code_system: dto.code_system,
        code: dto.code,
        code_display: dto.code_display,
        substance_rxnorm: dto.substance_rxnorm,
        reaction: dto.reaction,
        severity: dto.severity,
        onset_date: dto.onset_date,
        notes: dto.notes,
        recorded_by: ctx.userId!,
      },
    });

    const event: FhirSyncEvent = {
      tenant_id: ctx.tenantId,
      resource_type: 'AllergyIntolerance',
      internal_id: allergy.id,
      fhir_id: allergy.fhir_id,
      operation: 'create',
      payload: allergyToFhir(allergy as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, event);

    // A newly-recorded high-criticality allergy must reach anyone already treating this patient.
    if (allergy.criticality === 'high') {
      const alert: CriticalAlertEvent = {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        encounter_id: null,
        source: 'allergy',
        severity: 'critical',
        title: 'High-criticality allergy recorded',
        detail: `${dto.code_display ?? dto.code}${dto.reaction.length ? ` — ${dto.reaction.join(', ')}` : ''}`,
        target_roles: ['doctor', 'nurse', 'pharmacist'],
        occurred_at: new Date().toISOString(),
        dedupe_key: `allergy:${allergy.id}`,
      };
      await this.kafka.emit(KAFKA_TOPICS.CRITICAL_ALERT, ctx.tenantId, alert);
    }

    return allergy;
  }

  async markResolved(id: string, reason: string) {
    return this.prisma.allergy.update({
      where: { id },
      data: { clinical_status: 'resolved', notes: reason },
    });
  }

  /**
   * The gate every prescription passes through.
   * HIGH criticality blocks the order outright; LOW warns and may be overridden with a reason.
   */
  async checkAgainstDrug(
    patientId: string,
    drug: { rxnorm?: string | null; name: string; ingredients?: string[] },
  ): Promise<AllergyCheckResult> {
    const allergies = await this.prisma.allergy.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        patient_id: patientId,
        deleted_at: null,
        clinical_status: 'active',
        category: { in: ['medication', 'biologic', 'contrast', 'latex'] },
      },
    });

    const needles = [drug.name.toLowerCase(), ...(drug.ingredients ?? []).map((i) => i.toLowerCase())];

    const warnings = allergies
      .filter((a) => {
        if (drug.rxnorm && a.substance_rxnorm && a.substance_rxnorm === drug.rxnorm) return true;
        const substance = (a.code_display ?? a.code).toLowerCase();
        return needles.some((n) => n.includes(substance) || substance.includes(n));
      })
      .map((a) => ({
        allergy_id: a.id,
        substance: a.code_display ?? a.code,
        criticality: a.criticality,
        reaction: a.reaction,
        action: (a.criticality === 'high' ? 'block' : 'warn') as 'block' | 'warn',
      }));

    return { blocked: warnings.some((w) => w.action === 'block'), warnings };
  }

  /** Throws when the check blocks; used by the prescribing path. */
  assertNotBlocked(result: AllergyCheckResult, drugName: string): void {
    if (!result.blocked) return;
    const blocking = result.warnings.filter((w) => w.action === 'block');
    throw new ConflictException({
      code: 'ALLERGY_CONTRAINDICATION',
      message: `Blocked: patient has a high-criticality allergy to ${blocking.map((b) => b.substance).join(', ')}`,
      drug: drugName,
      allergies: blocking,
      override_allowed: false,
    });
  }
}
