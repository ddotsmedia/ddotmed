import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/tenant-context';
import { AllergiesService } from '../allergies/allergies.service';
import { InteractionsService } from '../medications/interactions.service';

export interface CdsService {
  hook: string;
  id: string;
  title: string;
  description: string;
  prefetch?: Record<string, string>;
}

export interface CdsCard {
  uuid: string;
  summary: string;
  detail?: string;
  indicator: 'info' | 'warning' | 'critical';
  source: { label: string; url?: string };
  suggestions?: Array<{ label: string; uuid: string; isRecommended?: boolean }>;
  overrideReasons?: Array<{ code: string; system: string; display: string }>;
  links?: Array<{ label: string; url: string; type: 'absolute' | 'smart' }>;
}

const SOURCE = { label: 'MediCore Clinical Decision Support' };

/**
 * CDS Hooks 2.0 service discovery and invocation.
 * Cards are advisory — the hard blocks live in the prescribing service, because a
 * CDS card can be dismissed and a contraindication must not be dismissible.
 */
@Injectable()
export class CdsHooksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly allergies: AllergiesService,
    private readonly interactions: InteractionsService,
  ) {}

  discovery(): { services: CdsService[] } {
    return {
      services: [
        {
          hook: 'medication-prescribe',
          id: 'medication-safety',
          title: 'Medication safety check',
          description: 'Allergy contraindications and drug-drug interactions for a draft prescription',
          prefetch: {
            patient: 'Patient/{{context.patientId}}',
            allergies: 'AllergyIntolerance?patient={{context.patientId}}&clinical-status=active',
          },
        },
        {
          hook: 'patient-view',
          id: 'patient-risk-summary',
          title: 'Patient risk summary',
          description: 'High-criticality allergies, deteriorating EWS and overdue results',
          prefetch: { patient: 'Patient/{{context.patientId}}' },
        },
        {
          hook: 'order-select',
          id: 'duplicate-order-check',
          title: 'Duplicate order check',
          description: 'Warns when an equivalent order was already placed recently',
        },
      ],
    };
  }

  async invoke(
    serviceId: string,
    request: { context: Record<string, unknown>; prefetch?: Record<string, unknown> },
  ): Promise<{ cards: CdsCard[] }> {
    const patientId = String(request.context.patientId ?? '');
    if (!patientId) return { cards: [] };

    switch (serviceId) {
      case 'medication-safety':
        return { cards: await this.medicationSafety(patientId, request.context) };
      case 'patient-risk-summary':
        return { cards: await this.riskSummary(patientId) };
      case 'duplicate-order-check':
        return { cards: await this.duplicateOrder(patientId, request.context) };
      default:
        return { cards: [] };
    }
  }

  private card(partial: Omit<CdsCard, 'uuid' | 'source'>): CdsCard {
    return { uuid: crypto.randomUUID(), source: SOURCE, ...partial };
  }

  private async medicationSafety(
    patientId: string,
    context: Record<string, unknown>,
  ): Promise<CdsCard[]> {
    const draft = (context.draftOrders as { entry?: Array<{ resource?: Record<string, unknown> }> } | undefined)
      ?.entry?.[0]?.resource;
    const coding = (
      (draft?.medicationCodeableConcept as { coding?: Array<{ code?: string; display?: string }> } | undefined)
        ?.coding ?? []
    )[0];
    if (!coding?.code) return [];

    const drug = { rxnorm: coding.code, name: coding.display ?? coding.code };
    const [allergy, interaction] = await Promise.all([
      this.allergies.checkAgainstDrug(patientId, drug),
      this.interactions.check(patientId, { rxnorm: drug.rxnorm, name: drug.name }),
    ]);

    const cards: CdsCard[] = [];

    for (const w of allergy.warnings) {
      cards.push(
        this.card({
          summary:
            w.action === 'block'
              ? `Contraindicated: documented ${w.criticality}-criticality allergy to ${w.substance}`
              : `Caution: documented allergy to ${w.substance}`,
          detail: w.reaction.length ? `Recorded reaction: ${w.reaction.join(', ')}` : undefined,
          indicator: w.action === 'block' ? 'critical' : 'warning',
          overrideReasons:
            w.action === 'warn'
              ? [
                  { code: 'benefit-outweighs-risk', system: 'urn:medicore:override', display: 'Benefit outweighs the risk' },
                  { code: 'previously-tolerated', system: 'urn:medicore:override', display: 'Previously tolerated' },
                ]
              : undefined,
        }),
      );
    }

    for (const f of interaction.findings) {
      cards.push(
        this.card({
          summary: `${f.severity} interaction: ${f.drug_a} + ${f.drug_b}`,
          detail: [f.clinical_effect, f.management].filter(Boolean).join(' — '),
          indicator: f.severity === 'contraindicated' ? 'critical' : f.action === 'block' ? 'warning' : 'info',
        }),
      );
    }

    return cards;
  }

  private async riskSummary(patientId: string): Promise<CdsCard[]> {
    const tenantId = currentContext().tenantId;
    const [highAllergies, latestVital, unacknowledged] = await Promise.all([
      this.prisma.allergy.findMany({
        where: { tenant_id: tenantId, patient_id: patientId, deleted_at: null, clinical_status: 'active', criticality: 'high' },
      }),
      this.prisma.vital.findFirst({
        where: { tenant_id: tenantId, patient_id: patientId, deleted_at: null },
        orderBy: { recorded_at: 'desc' },
      }),
      this.prisma.labResult.count({
        where: { tenant_id: tenantId, patient_id: patientId, deleted_at: null, is_critical: true, critical_notified_at: null },
      }),
    ]);

    const cards: CdsCard[] = [];

    if (highAllergies.length) {
      cards.push(
        this.card({
          summary: `${highAllergies.length} high-criticality allerg${highAllergies.length === 1 ? 'y' : 'ies'}`,
          detail: highAllergies.map((a) => a.code_display ?? a.code).join(', '),
          indicator: 'critical',
        }),
      );
    }

    if (latestVital?.ews_risk && latestVital.ews_risk !== 'low') {
      cards.push(
        this.card({
          summary: `EWS ${latestVital.ews_score} — ${latestVital.ews_risk} risk`,
          detail: `Recorded ${latestVital.recorded_at.toISOString()}`,
          indicator: latestVital.ews_risk === 'high' ? 'critical' : 'warning',
        }),
      );
    }

    if (unacknowledged > 0) {
      cards.push(
        this.card({
          summary: `${unacknowledged} unacknowledged critical result${unacknowledged === 1 ? '' : 's'}`,
          indicator: 'critical',
        }),
      );
    }

    return cards;
  }

  private async duplicateOrder(
    patientId: string,
    context: Record<string, unknown>,
  ): Promise<CdsCard[]> {
    const selections = (context.selections as string[] | undefined) ?? [];
    if (selections.length === 0) return [];

    const since = new Date(Date.now() - 24 * 3_600_000);
    const recent = await this.prisma.serviceRequest.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        patient_id: patientId,
        deleted_at: null,
        created_at: { gte: since },
      },
      select: { code: true, code_display: true, created_at: true },
    });
    if (recent.length === 0) return [];

    return [
      this.card({
        summary: `${recent.length} order(s) already placed for this patient in the last 24 hours`,
        detail: recent.map((r) => `${r.code_display} (${r.created_at.toISOString()})`).join('; '),
        indicator: 'info',
      }),
    ];
  }
}
