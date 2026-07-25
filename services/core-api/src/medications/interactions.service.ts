import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/tenant-context';

export type InteractionSeverity = 'contraindicated' | 'major' | 'moderate' | 'minor';

export interface InteractionFinding {
  rxnorm_a: string;
  rxnorm_b: string;
  drug_a: string;
  drug_b: string;
  severity: InteractionSeverity;
  clinical_effect: string;
  management: string | null;
  action: 'block' | 'warn';
}

export interface InteractionCheckResult {
  blocked: boolean;
  findings: InteractionFinding[];
}

/** Severities that stop an order outright rather than warning. */
const BLOCKING: ReadonlySet<string> = new Set(['contraindicated', 'major']);

@Injectable()
export class InteractionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Checks a candidate drug against the patient's active medication list.
   * Pair lookup is order-independent — the register stores each pair once.
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

    const existing = active.filter((m) => m.code && m.code !== candidate.rxnorm);
    if (existing.length === 0) return { blocked: false, findings: [] };

    const codes = existing.map((m) => m.code);
    const rows = await this.prisma.drugInteraction.findMany({
      where: {
        deleted_at: null,
        OR: [
          { rxnorm_a: candidate.rxnorm, rxnorm_b: { in: codes } },
          { rxnorm_b: candidate.rxnorm, rxnorm_a: { in: codes } },
        ],
      },
    });

    const nameOf = (code: string) =>
      code === candidate.rxnorm
        ? candidate.name
        : (existing.find((m) => m.code === code)?.code_display ?? code);

    const findings: InteractionFinding[] = rows.map((r) => ({
      rxnorm_a: r.rxnorm_a,
      rxnorm_b: r.rxnorm_b,
      drug_a: nameOf(r.rxnorm_a),
      drug_b: nameOf(r.rxnorm_b),
      severity: r.severity as InteractionSeverity,
      clinical_effect: r.clinical_effect,
      management: r.management,
      action: BLOCKING.has(r.severity) ? 'block' : 'warn',
    }));

    return { blocked: findings.some((f) => f.action === 'block'), findings };
  }

  assertNotBlocked(result: InteractionCheckResult, drugName: string): void {
    if (!result.blocked) return;
    const blocking = result.findings.filter((f) => f.action === 'block');
    throw new ConflictException({
      code: 'DRUG_INTERACTION',
      message: `Blocked: severe interaction between ${drugName} and ${blocking
        .map((b) => (b.drug_a === drugName ? b.drug_b : b.drug_a))
        .join(', ')}`,
      findings: blocking,
      // Major (not contraindicated) interactions may be overridden with a documented reason.
      override_allowed: blocking.every((b) => b.severity !== 'contraindicated'),
    });
  }
}
