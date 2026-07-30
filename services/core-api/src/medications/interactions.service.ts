import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/tenant-context';
import {
  actionFor,
  fallbackExplanation,
  findCatalogueInteraction,
  pairKey,
  type DrugRef,
  type InteractionAction,
  type InteractionSeverity,
} from './interaction-catalogue';

export type { InteractionSeverity } from './interaction-catalogue';

export interface InteractionFinding {
  rxnorm_a: string;
  rxnorm_b: string;
  drug_a: string;
  drug_b: string;
  severity: InteractionSeverity;
  mechanism: string | null;
  clinical_effect: string;
  management: string | null;
  /** Plain-English wording for the prescriber; model-written where one is cached. */
  explanation: string;
  action: InteractionAction;
  source: 'tenant' | 'bundled';
}

export interface InteractionCheckResult {
  /** True only for a contraindication — the one severity no reason can justify. */
  blocked: boolean;
  /** True when a documented reason is needed to proceed. */
  requires_override: boolean;
  findings: InteractionFinding[];
}

@Injectable()
export class InteractionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Checks a candidate drug against the patient's active medication list.
   *
   * Two sources are consulted: rows the tenant holds in `drug_interactions`, and
   * the bundled catalogue. Tenant rows win, so a site that has loaded a licensed
   * feed is never second-guessed by the fallback — but a site that has loaded
   * nothing is still protected.
   */
  async check(
    patientId: string,
    candidate: { rxnorm: string; name: string },
  ): Promise<InteractionCheckResult> {
    const tenantId = currentContext().tenantId;

    const active = await this.prisma.medication.findMany({
      where: {
        tenant_id: tenantId,
        patient_id: patientId,
        deleted_at: null,
        status: { in: ['active', 'on_hold'] },
      },
      select: { code: true, code_display: true },
    });

    // The same drug already on the list is a duplicate-therapy question, not an interaction.
    const existing = active.filter((m) => m.code && m.code !== candidate.rxnorm);
    if (existing.length === 0) return { blocked: false, requires_override: false, findings: [] };

    const codes = existing.map((m) => m.code).filter(Boolean);
    const rows = codes.length
      ? await this.prisma.drugInteraction.findMany({
          where: {
            deleted_at: null,
            OR: [
              { rxnorm_a: candidate.rxnorm, rxnorm_b: { in: codes } },
              { rxnorm_b: candidate.rxnorm, rxnorm_a: { in: codes } },
            ],
          },
        })
      : [];

    const nameOf = (code: string) =>
      code === candidate.rxnorm
        ? candidate.name
        : (existing.find((m) => m.code === code)?.code_display ?? code);

    const findings: InteractionFinding[] = [];
    const seen = new Set<string>();

    for (const row of rows) {
      const severity = row.severity as InteractionSeverity;
      const drugA = nameOf(row.rxnorm_a);
      const drugB = nameOf(row.rxnorm_b);
      seen.add(pairKey(row.rxnorm_a, row.rxnorm_b));
      findings.push({
        rxnorm_a: row.rxnorm_a,
        rxnorm_b: row.rxnorm_b,
        drug_a: drugA,
        drug_b: drugB,
        severity,
        mechanism: row.mechanism,
        clinical_effect: row.clinical_effect,
        management: row.management,
        explanation:
          row.plain_explanation ??
          fallbackExplanation({
            drug_a: drugA,
            drug_b: drugB,
            severity,
            clinical_effect: row.clinical_effect,
            management: row.management,
          }),
        action: actionFor(severity),
        source: 'tenant',
      });
    }

    const candidateRef: DrugRef = { rxnorm: candidate.rxnorm, name: candidate.name };
    for (const other of existing) {
      const otherRef: DrugRef = { rxnorm: other.code, name: other.code_display };
      const entry = findCatalogueInteraction(candidateRef, otherRef);
      if (!entry) continue;
      if (seen.has(pairKey(entry.rxnorm_a, entry.rxnorm_b))) continue;
      seen.add(pairKey(entry.rxnorm_a, entry.rxnorm_b));
      findings.push({
        rxnorm_a: entry.rxnorm_a,
        rxnorm_b: entry.rxnorm_b,
        drug_a: candidate.name,
        drug_b: other.code_display,
        severity: entry.severity,
        mechanism: entry.mechanism,
        clinical_effect: entry.clinical_effect,
        management: entry.management,
        explanation: fallbackExplanation({
          drug_a: candidate.name,
          drug_b: other.code_display,
          severity: entry.severity,
          clinical_effect: entry.clinical_effect,
          management: entry.management,
        }),
        action: actionFor(entry.severity),
        source: 'bundled',
      });
    }

    return {
      blocked: findings.some((f) => f.action === 'block'),
      requires_override: findings.some((f) => f.action === 'override'),
      findings,
    };
  }

  /**
   * Throws on a contraindication. 422 rather than 409: the request is well-formed
   * and there is nothing to reconcile — the prescription simply cannot be written.
   */
  assertNotBlocked(result: InteractionCheckResult, drugName: string): void {
    if (!result.blocked) return;
    const blocking = result.findings.filter((f) => f.action === 'block');
    throw new UnprocessableEntityException({
      code: 'DRUG_INTERACTION',
      message: `Blocked: ${drugName} is contraindicated with ${blocking
        .map((b) => (b.drug_a === drugName ? b.drug_b : b.drug_a))
        .join(', ')}`,
      findings: blocking,
      override_allowed: false,
    });
  }
}
