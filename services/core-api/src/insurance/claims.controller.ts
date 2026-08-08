import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Logger,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { getCountryPack } from '@medicore/country-packs';
import { KAFKA_TOPICS } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { AiClient } from '../ai/ai.module';
import { NotificationsService } from '../notifications/notifications.module';
import { InsuranceService } from './insurance.module';
import {
  assessDenialRisk,
  reviewSuggestions,
  type ReviewedSuggestion,
  type SuggestedCode,
} from './denial-risk';

export const SubmitClaimRequestDto = z.object({
  invoice_id: z.string().uuid(),
  payer_id: z.string().uuid(),
  diagnosis_codes: z.array(z.string().min(1)).default([]),
  procedure_codes: z.array(z.string().min(1)).default([]),
  pre_authorization_id: z.string().uuid().nullable().optional(),
  /** Clinical text the coding assistant reads. Without it no suggestion is asked for. */
  note_text: z.string().max(50_000).optional(),
  /** Set false to submit without calling the model at all. */
  request_coding_suggestions: z.boolean().default(true),
});

export const ClaimResponseDto = z.object({
  outcome: z.enum(['approved', 'partial', 'denied']),
  approved_amount_minor: z.number().int().min(0).default(0),
  paid_amount_minor: z.number().int().min(0).optional(),
  denial_code: z.string().max(40).optional(),
  denial_reason: z.string().max(1000).optional(),
  payer_reference: z.string().max(120).optional(),
});

@Injectable()
export class ClaimsService {
  private readonly log = new Logger(ClaimsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly ai: AiClient,
    private readonly notifications: NotificationsService,
    private readonly insurance: InsuranceService,
  ) {}

  /**
   * Asks the coding assistant for codes the note supports.
   *
   * Advisory only: nothing here is applied to the claim. A model failure returns
   * an empty list rather than blocking the submission — a claim that cannot be
   * filed because a suggestion service is down is worse than one filed without
   * suggestions.
   */
  private async suggestCodes(
    noteText: string | undefined,
    onClaim: { diagnosis_codes: string[]; procedure_codes: string[] },
  ): Promise<{ suggestions: ReviewedSuggestion[]; model_version: string | null }> {
    if (!noteText || noteText.trim().length < 10) {
      return { suggestions: [], model_version: null };
    }

    try {
      const raw = (await this.ai.post('/ai/coding/suggest', {
        note_text: noteText,
        code_systems: ['ICD-10', 'CPT'],
      })) as { codes?: SuggestedCode[]; model_version?: string };

      return {
        suggestions: reviewSuggestions(raw.codes ?? [], onClaim),
        model_version: raw.model_version ?? this.ai.model,
      };
    } catch (error) {
      this.log.warn(`Coding suggestions unavailable: ${(error as Error).message}`);
      return { suggestions: [], model_version: null };
    }
  }

  /**
   * Submits a claim for an invoice.
   *
   * The claimed amount is read from the invoice, never from the request: a client
   * that could name its own figure could bill a payer for more than was invoiced.
   */
  async submit(dto: z.infer<typeof SubmitClaimRequestDto>) {
    const ctx = currentContext();

    const invoice = await this.prisma.invoice.findFirst({
      where: { id: dto.invoice_id, tenant_id: ctx.tenantId, deleted_at: null },
      include: { coverage: true },
    });
    if (!invoice) throw new BadRequestException('Invoice not found');
    if (invoice.status === 'cancelled') {
      throw new BadRequestException('This invoice has been voided and cannot be claimed');
    }
    if (!invoice.coverage_id) {
      throw new BadRequestException('This invoice has no insurance coverage attached');
    }

    const payer = await this.prisma.payer.findFirst({
      where: { id: dto.payer_id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!payer) throw new BadRequestException('Payer not found');

    // The payer's share is what the insurer owes; the patient's share is billed to the patient directly.
    const claimedMinor = invoice.payer_share_minor > 0 ? invoice.payer_share_minor : invoice.total_minor;

    const pack = getCountryPack(payer.country_pack);
    const rules = pack.getInsuranceRules();

    if (dto.diagnosis_codes.length === 0) {
      throw new BadRequestException('A claim needs at least one diagnosis code');
    }

    // The payer's mandated coding systems come from the country pack, so a bare
    // code string from the client is always carried under the right system.
    const { claim } = await this.insurance.submitClaim({
      patient_id: invoice.patient_id,
      encounter_id: invoice.encounter_id ?? null,
      invoice_id: invoice.id,
      coverage_id: invoice.coverage_id,
      pre_authorization_id: dto.pre_authorization_id ?? null,
      claimed_minor: claimedMinor,
      diagnosis_codes: dto.diagnosis_codes.map((code) => ({
        system: rules.mandatoryDiagnosisSystem,
        code,
      })),
      procedure_codes: dto.procedure_codes.map((code) => ({
        system: rules.mandatoryProcedureSystem,
        code,
      })),
    });

    const daysSinceService = invoice.issued_at
      ? Math.floor((Date.now() - invoice.issued_at.getTime()) / 86_400_000)
      : 0;

    const risk = assessDenialRisk({
      diagnosis_codes: dto.diagnosis_codes,
      procedure_codes: dto.procedure_codes,
      claimed_minor: claimedMinor,
      currency: invoice.currency,
      requires_pre_auth:
        rules.requiresPreAuthAbove !== null && claimedMinor > rules.requiresPreAuthAbove,
      has_pre_auth: Boolean(dto.pre_authorization_id),
      days_since_service: daysSinceService,
      filing_limit_days: rules.claimSubmissionDeadlineDays,
      payer_denial_rate_bp: await this.recentPayerDenialRateBp(dto.payer_id),
    });

    const coding = dto.request_coding_suggestions
      ? await this.suggestCodes(dto.note_text, {
          diagnosis_codes: dto.diagnosis_codes,
          procedure_codes: dto.procedure_codes,
        })
      : { suggestions: [], model_version: null };

    const stored = await this.prisma.insuranceClaim.update({
      where: { id: claim.id },
      data: {
        denial_risk: risk.risk_bp / 10_000,
        denial_risk_factors: risk.factors as never,
      },
      include: { payer: { select: { name: true, code: true } } },
    });

    await this.kafka.emit(KAFKA_TOPICS.BILLING, ctx.tenantId, {
      tenant_id: ctx.tenantId,
      event: 'claim_submitted',
      claim_id: stored.id,
      claim_number: stored.claim_number,
      invoice_id: invoice.id,
      payer_id: dto.payer_id,
      claimed_minor: claimedMinor,
      currency: invoice.currency,
      denial_risk_bp: risk.risk_bp,
      occurred_at: new Date().toISOString(),
    });

    return {
      claim: stored,
      denial_risk: risk,
      coding_suggestions: coding.suggestions,
      coding_model_version: coding.model_version,
      // Suggestions are proposals; a coder accepts them before they reach a claim.
      requires_approval: true as const,
    };
  }

  /** This payer's denial rate over the last 90 days, in basis points. */
  private async recentPayerDenialRateBp(payerId: string): Promise<number> {
    const since = new Date(Date.now() - 90 * 86_400_000);
    const claims = await this.prisma.insuranceClaim.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        payer_id: payerId,
        deleted_at: null,
        adjudicated_at: { gte: since },
      },
      select: { status: true, denied_minor: true },
      take: 1_000,
    });
    if (claims.length === 0) return 0;
    const denied = claims.filter((c) => c.status === 'denied' || c.denied_minor > 0).length;
    return Math.round((denied / claims.length) * 10_000);
  }

  /**
   * Records what the payer came back with.
   *
   * A denial raises a work item rather than only updating a status: an unworked
   * denial is money the hospital has already spent and will not be paid for.
   */
  async recordResponse(claimId: string, dto: z.infer<typeof ClaimResponseDto>) {
    const ctx = currentContext();

    const claim = await this.prisma.insuranceClaim.findFirst({
      where: { id: claimId, tenant_id: ctx.tenantId, deleted_at: null },
      include: { payer: { select: { name: true } } },
    });
    if (!claim) throw new BadRequestException('Claim not found');
    if (dto.approved_amount_minor > claim.claimed_minor) {
      throw new BadRequestException(
        `Approved ${dto.approved_amount_minor} exceeds the ${claim.claimed_minor} claimed`,
      );
    }
    if (dto.outcome === 'denied' && !dto.denial_code && !dto.denial_reason) {
      throw new BadRequestException('A denial needs a code or a reason to be workable');
    }

    const approved = dto.outcome === 'denied' ? 0 : dto.approved_amount_minor;
    const denied = claim.claimed_minor - approved;
    const status =
      dto.outcome === 'denied' ? 'denied' : dto.outcome === 'partial' ? 'partially_paid' : 'accepted';

    const { response, updated } = await this.prisma.$transaction(async (tx) => {
      const created = await tx.claimResponse.create({
        data: {
          tenant_id: ctx.tenantId,
          claim_id: claimId,
          outcome: dto.outcome,
          payer_reference: dto.payer_reference,
          approved_minor: approved,
          paid_minor: dto.paid_amount_minor ?? 0,
          denied_minor: denied,
          currency: claim.currency,
          denial_codes: dto.denial_code ? [dto.denial_code] : [],
          adjudication_details: dto.denial_reason ? [{ reason: dto.denial_reason }] : [],
        },
      });

      const next = await tx.insuranceClaim.update({
        where: { id: claimId },
        data: {
          status: status as never,
          approved_minor: approved,
          paid_minor: dto.paid_amount_minor ?? claim.paid_minor,
          denied_minor: denied,
          adjudicated_at: new Date(),
          denial_reason_codes: dto.denial_code ? [dto.denial_code] : [],
        },
      });

      return { response: created, updated: next };
    });

    if (dto.outcome !== 'approved') {
      await this.notifications.create({
        tenant_id: ctx.tenantId,
        role: 'insurance-officer',
        category: 'claim-denial',
        severity: dto.outcome === 'denied' ? 'warning' : 'info',
        title:
          dto.outcome === 'denied'
            ? `Claim denied: ${claim.claim_number}`
            : `Claim partially paid: ${claim.claim_number}`,
        body: `${claim.payer.name} ${dto.outcome} ${claim.claim_number}. ${denied} of ${claim.claimed_minor} ${claim.currency} unpaid.${dto.denial_reason ? ` Reason: ${dto.denial_reason}` : ''}`,
        patient_id: claim.patient_id,
        resource_type: 'Claim',
        resource_id: claimId,
        dedupe_key: `claim-denial:${claimId}`,
        requires_acknowledgement: dto.outcome === 'denied',
      });
    }

    await this.kafka.emit(KAFKA_TOPICS.BILLING, ctx.tenantId, {
      tenant_id: ctx.tenantId,
      event: 'claim_adjudicated',
      claim_id: claimId,
      outcome: dto.outcome,
      approved_minor: approved,
      denied_minor: denied,
      occurred_at: new Date().toISOString(),
    });

    return { claim: updated, response };
  }

  async list(params: { payerId?: string; status?: string; invoiceId?: string; limit?: number }) {
    return this.prisma.insuranceClaim.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        ...(params.payerId ? { payer_id: params.payerId } : {}),
        ...(params.status ? { status: params.status as never } : {}),
        ...(params.invoiceId ? { invoice_id: params.invoiceId } : {}),
      },
      include: {
        payer: { select: { name: true, code: true } },
        responses: { orderBy: { received_at: 'desc' }, take: 1 },
      },
      orderBy: { created_at: 'desc' },
      take: params.limit ?? 100,
    });
  }
}

@ApiTags('insurance-claims')
@Controller('insurance-claims')
export class ClaimsController {
  constructor(private readonly service: ClaimsService) {}

  @Post()
  @RequirePermissions('claim:submit')
  @Audit({ action: 'claim.submit', resourceType: 'Claim', isPhi: true })
  @ApiOperation({ summary: 'Submit a claim; returns denial risk and advisory coding suggestions' })
  submit(@ZodBody(SubmitClaimRequestDto) dto: z.infer<typeof SubmitClaimRequestDto>) {
    return this.service.submit(dto);
  }

  @Get()
  @RequirePermissions('claim:read')
  list(
    @Query('payerId') payerId?: string,
    @Query('status') status?: string,
    @Query('invoiceId') invoiceId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list({ payerId, status, invoiceId, limit: limit ? Number(limit) : 100 });
  }

  @Patch(':id/response')
  @RequirePermissions('claim:write')
  @Audit({ action: 'claim.response', resourceType: 'ClaimResponse', isPhi: true })
  @ApiOperation({ summary: 'Record the payer response; a denial raises a work item' })
  respond(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(ClaimResponseDto) dto: z.infer<typeof ClaimResponseDto>,
  ) {
    return this.service.recordResponse(id, dto);
  }
}
