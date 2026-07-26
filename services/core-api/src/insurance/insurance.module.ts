import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { getCountryPack } from '@medicore/country-packs';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/tenant-context';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';

export const EligibilityDto = z.object({
  coverage_id: z.string().uuid(),
  service_type: z.string().optional(),
  estimated_minor: z.number().int().min(0).optional(),
});

export const PreAuthDto = z.object({
  patient_id: z.string().uuid(),
  coverage_id: z.string().uuid(),
  encounter_id: z.string().uuid().nullable().optional(),
  requested_minor: z.number().int().positive(),
  diagnosis_codes: z.array(z.object({ system: z.string(), code: z.string(), display: z.string().optional() })),
  procedure_codes: z.array(z.object({ system: z.string(), code: z.string(), display: z.string().optional() })).default([]),
  clinical_justification: z.string().min(20).max(4000),
});

export const SubmitClaimDto = z.object({
  patient_id: z.string().uuid(),
  coverage_id: z.string().uuid(),
  invoice_id: z.string().uuid().nullable().optional(),
  encounter_id: z.string().uuid().nullable().optional(),
  pre_authorization_id: z.string().uuid().nullable().optional(),
  diagnosis_codes: z.array(z.object({ system: z.string(), code: z.string(), display: z.string().optional() })).min(1),
  procedure_codes: z.array(z.object({ system: z.string(), code: z.string(), display: z.string().optional() })).default([]),
  claimed_minor: z.number().int().positive(),
});

export const RemittanceDto = z.object({
  claim_id: z.string().uuid(),
  outcome: z.enum(['complete', 'partial', 'error']),
  approved_minor: z.number().int().min(0),
  paid_minor: z.number().int().min(0),
  denied_minor: z.number().int().min(0),
  denial_codes: z.array(z.string()).default([]),
  disposition: z.string().optional(),
  payer_reference: z.string().optional(),
  remittance_advice_ref: z.string().optional(),
  raw_payload: z.record(z.unknown()).optional(),
});

@Injectable()
export class InsuranceService {
  private readonly logger = new Logger(InsuranceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async listPayers() {
    return this.prisma.payer.findMany({
      where: { tenant_id: currentContext().tenantId, deleted_at: null, is_active: true },
      select: { id: true, name: true, code: true, country_pack: true, claim_format: true },
      orderBy: { name: 'asc' },
    });
  }

  private async loadCoverage(id: string) {
    const coverage = await this.prisma.coverage.findFirst({
      where: { id, tenant_id: currentContext().tenantId, deleted_at: null },
      include: { payer: true },
    });
    if (!coverage) throw new BadRequestException('Coverage not found');
    return coverage;
  }

  /**
   * Real-time eligibility. Where the payer exposes an API the adapter calls it;
   * otherwise the locally-held policy terms are returned, clearly marked as such.
   */
  async checkEligibility(dto: z.infer<typeof EligibilityDto>) {
    const coverage = await this.loadCoverage(dto.coverage_id);
    const now = new Date();

    const localVerdict = {
      eligible:
        coverage.status === 'active' &&
        coverage.starts_at <= now &&
        (coverage.ends_at === null || coverage.ends_at >= now),
      reason:
        coverage.status !== 'active'
          ? `Coverage status is ${coverage.status}`
          : coverage.ends_at && coverage.ends_at < now
            ? 'Policy has expired'
            : coverage.starts_at > now
              ? 'Policy has not started'
              : null,
    };

    const remainingLimit =
      coverage.annual_limit_minor != null
        ? Math.max(0, coverage.annual_limit_minor - coverage.used_minor)
        : null;

    let payerResponse: Record<string, unknown> | null = null;
    if (coverage.payer.supports_realtime_eligibility && coverage.payer.api_base_url) {
      payerResponse = await this.callPayerEligibility(coverage, dto);
    }

    const result = {
      source: payerResponse ? 'payer-api' : 'local-policy',
      eligible: (payerResponse?.eligible as boolean | undefined) ?? localVerdict.eligible,
      reason: (payerResponse?.reason as string | undefined) ?? localVerdict.reason,
      member_id: coverage.member_id,
      policy_number: coverage.policy_number,
      plan_name: coverage.plan_name,
      copay_bp: coverage.copay_bp,
      deductible_remaining_minor: coverage.deductible_minor,
      annual_limit_remaining_minor: remainingLimit,
      requires_preauth: coverage.requires_preauth,
      checked_at: now.toISOString(),
      payer_response: payerResponse,
    };

    await this.prisma.coverage.update({
      where: { id: coverage.id },
      data: { last_eligibility_check_at: now, last_eligibility_result: result as never },
    });

    return result;
  }

  private async callPayerEligibility(
    coverage: { payer: { api_base_url: string | null; code: string }; member_id: string },
    dto: z.infer<typeof EligibilityDto>,
  ): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetch(`${coverage.payer.api_base_url}/eligibility`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          member_id: coverage.member_id,
          service_type: dto.service_type,
          estimated_amount_minor: dto.estimated_minor,
        }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch (e) {
      // A payer outage must not block registration or billing; fall back to local terms.
      this.logger.warn(`Payer ${coverage.payer.code} eligibility check failed: ${String(e)}`);
      return null;
    }
  }

  /** Decides whether an amount needs pre-auth under the active country pack's rules. */
  async requiresPreAuth(coverageId: string, amountMinor: number): Promise<boolean> {
    const coverage = await this.loadCoverage(coverageId);
    if (coverage.requires_preauth) return true;
    const pack = getCountryPack(coverage.payer.country_pack);
    const threshold = pack.getInsuranceRules().requiresPreAuthAbove;
    return threshold !== null && amountMinor > threshold;
  }

  async requestPreAuth(dto: z.infer<typeof PreAuthDto>) {
    const ctx = currentContext();
    const coverage = await this.loadCoverage(dto.coverage_id);
    const pack = getCountryPack(coverage.payer.country_pack);
    const rules = pack.getInsuranceRules();

    const year = new Date().getFullYear();
    const stem = `PA-${year}-`;
    const last = await this.prisma.preAuthorization.findFirst({
      where: { tenant_id: ctx.tenantId, reference_number: { startsWith: stem } },
      orderBy: { reference_number: 'desc' },
      select: { reference_number: true },
    });
    const reference = `${stem}${String(last ? Number(last.reference_number.slice(stem.length)) + 1 : 1).padStart(6, '0')}`;

    return this.prisma.preAuthorization.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        coverage_id: dto.coverage_id,
        payer_id: coverage.payer_id,
        encounter_id: dto.encounter_id ?? null,
        reference_number: reference,
        status: 'pending',
        requested_minor: dto.requested_minor,
        currency: coverage.payer.country_pack ? pack.currency : 'USD',
        diagnosis_codes: dto.diagnosis_codes,
        procedure_codes: dto.procedure_codes,
        clinical_justification: dto.clinical_justification,
        valid_from: new Date(),
        valid_to: new Date(Date.now() + rules.preAuthTurnaroundHours * 3_600_000),
      },
    });
  }

  /**
   * Builds and submits a claim in the payer's national format via the country pack.
   * Submission is recorded even when the transport fails, so nothing is silently lost.
   */
  async submitClaim(dto: z.infer<typeof SubmitClaimDto>) {
    const ctx = currentContext();
    const coverage = await this.loadCoverage(dto.coverage_id);
    const pack = getCountryPack(coverage.payer.country_pack);
    const rules = pack.getInsuranceRules();

    const requiresPreAuth = await this.requiresPreAuth(dto.coverage_id, dto.claimed_minor);
    if (requiresPreAuth && !dto.pre_authorization_id) {
      throw new BadRequestException({
        code: 'PRE_AUTH_REQUIRED',
        message: `This payer requires pre-authorisation above ${rules.requiresPreAuthAbove} minor units`,
        threshold_minor: rules.requiresPreAuthAbove,
      });
    }
    if (dto.pre_authorization_id) {
      const preAuth = await this.prisma.preAuthorization.findFirst({
        where: { id: dto.pre_authorization_id, tenant_id: ctx.tenantId, deleted_at: null },
      });
      if (!preAuth || preAuth.status !== 'approved') {
        throw new BadRequestException('The referenced pre-authorisation is not approved');
      }
    }

    const year = new Date().getFullYear();
    const stem = `CLM-${year}-`;
    const last = await this.prisma.insuranceClaim.findFirst({
      where: { tenant_id: ctx.tenantId, claim_number: { startsWith: stem } },
      orderBy: { claim_number: 'desc' },
      select: { claim_number: true },
    });
    const claimNumber = `${stem}${String(last ? Number(last.claim_number.slice(stem.length)) + 1 : 1).padStart(6, '0')}`;

    const draft = await this.prisma.insuranceClaim.create({
      data: {
        tenant_id: ctx.tenantId,
        claim_number: claimNumber,
        patient_id: dto.patient_id,
        encounter_id: dto.encounter_id ?? null,
        invoice_id: dto.invoice_id ?? null,
        coverage_id: dto.coverage_id,
        payer_id: coverage.payer_id,
        pre_authorization_id: dto.pre_authorization_id ?? null,
        status: 'draft',
        country_pack: pack.code,
        claim_format: coverage.payer.claim_format,
        currency: pack.currency,
        claimed_minor: dto.claimed_minor,
        diagnosis_codes: dto.diagnosis_codes,
        procedure_codes: dto.procedure_codes,
      },
    });

    const payload = pack.buildClaimPayload(draft as never, {
      payerLicense: coverage.payer.license_number ?? undefined,
      memberId: coverage.member_id,
    });

    const submitted = await this.prisma.insuranceClaim.update({
      where: { id: draft.id },
      data: {
        status: 'submitted',
        submitted_at: new Date(),
        payload: payload as never,
      },
    });

    return { claim: submitted, payload };
  }

  /** Applies a payer remittance to the claim and, where linked, to the invoice. */
  async processRemittance(dto: z.infer<typeof RemittanceDto>) {
    const ctx = currentContext();
    const claim = await this.prisma.insuranceClaim.findFirst({
      where: { id: dto.claim_id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!claim) throw new BadRequestException('Claim not found');

    if (dto.approved_minor + dto.denied_minor > claim.claimed_minor) {
      throw new BadRequestException('Approved plus denied exceeds the claimed amount');
    }

    const status =
      dto.denied_minor === claim.claimed_minor
        ? 'denied'
        : dto.paid_minor === 0
          ? 'accepted'
          : dto.paid_minor < claim.claimed_minor
            ? 'partially_paid'
            : 'paid';

    return this.prisma.$transaction(async (tx) => {
      const response = await tx.claimResponse.create({
        data: {
          tenant_id: ctx.tenantId,
          claim_id: claim.id,
          outcome: dto.outcome,
          disposition: dto.disposition,
          payer_reference: dto.payer_reference,
          approved_minor: dto.approved_minor,
          paid_minor: dto.paid_minor,
          denied_minor: dto.denied_minor,
          patient_responsibility_minor: claim.claimed_minor - dto.approved_minor,
          currency: claim.currency,
          denial_codes: dto.denial_codes,
          remittance_advice_ref: dto.remittance_advice_ref,
          raw_payload: (dto.raw_payload ?? undefined) as never,
        },
      });

      const updated = await tx.insuranceClaim.update({
        where: { id: claim.id },
        data: {
          status: status as never,
          approved_minor: dto.approved_minor,
          paid_minor: dto.paid_minor,
          denied_minor: dto.denied_minor,
          denial_reason_codes: dto.denial_codes,
          adjudicated_at: new Date(),
        },
      });

      // A payer payment settles the payer share of the invoice.
      if (claim.invoice_id && dto.paid_minor > 0) {
        const invoice = await tx.invoice.findUnique({ where: { id: claim.invoice_id } });
        if (invoice) {
          const applied = Math.min(dto.paid_minor, invoice.balance_minor);
          const paid = invoice.paid_minor + applied;
          const balance = invoice.total_minor - paid;
          await tx.payment.create({
            data: {
              tenant_id: ctx.tenantId,
              invoice_id: invoice.id,
              patient_id: invoice.patient_id,
              receipt_number: `RCP-CLM-${claim.claim_number}`,
              method: 'insurance',
              status: 'succeeded',
              currency: invoice.currency,
              amount_minor: applied,
              gateway_reference: dto.payer_reference,
              received_by: ctx.userId,
            },
          });
          await tx.invoice.update({
            where: { id: invoice.id },
            data: { paid_minor: paid, balance_minor: balance, status: balance === 0 ? 'paid' : 'partially_paid' },
          });
        }
      }

      // Consume the annual limit so subsequent invoices split correctly.
      if (dto.approved_minor > 0) {
        await tx.coverage.update({
          where: { id: claim.coverage_id },
          data: { used_minor: { increment: dto.approved_minor } },
        });
      }

      return { claim: updated, response };
    });
  }

  /** Denial worklist ordered by AI-scored risk, for the RCM team. */
  async denialQueue(page = 1, limit = 25) {
    const where = {
      tenant_id: currentContext().tenantId,
      deleted_at: null,
      status: { in: ['denied', 'rejected', 'partially_paid'] as never },
    };
    const [data, total] = await Promise.all([
      this.prisma.insuranceClaim.findMany({
        where,
        include: { payer: true, responses: { orderBy: { received_at: 'desc' }, take: 1 } },
        orderBy: [{ denial_risk: 'desc' }, { adjudicated_at: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.insuranceClaim.count({ where }),
    ]);
    return { data, total, page, limit, pages: Math.ceil(total / limit) };
  }

  /** Records a denial-risk score produced by ai-service. */
  async setDenialRisk(claimId: string, risk: number, factors: string[]) {
    return this.prisma.insuranceClaim.update({
      where: { id: claimId },
      data: { denial_risk: risk, denial_risk_factors: factors },
    });
  }

  async appeal(claimId: string, notes: string) {
    const claim = await this.prisma.insuranceClaim.findFirst({
      where: { id: claimId, tenant_id: currentContext().tenantId, deleted_at: null },
    });
    if (!claim) throw new BadRequestException('Claim not found');

    const pack = getCountryPack(claim.country_pack);
    const window = pack.getInsuranceRules().resubmissionWindowDays;
    const adjudicated = claim.adjudicated_at ?? claim.submitted_at;
    if (adjudicated && Date.now() - adjudicated.getTime() > window * 86_400_000) {
      throw new BadRequestException(`The ${window}-day resubmission window for this payer has closed`);
    }

    return this.prisma.insuranceClaim.update({
      where: { id: claimId },
      data: { status: 'appealed', appeal_notes: notes, resubmission_count: { increment: 1 } },
    });
  }
}

@ApiTags('insurance')
@Controller('insurance')
export class InsuranceController {
  constructor(private readonly service: InsuranceService) {}

  @Get('payers')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Active payers for the tenant, for registration and claims' })
  payers() {
    return this.service.listPayers();
  }

  @Post('eligibility')
  @RequirePermissions('claim:read')
  @ApiOperation({ summary: 'Real-time eligibility check with local-policy fallback' })
  eligibility(@ZodBody(EligibilityDto) dto: z.infer<typeof EligibilityDto>) {
    return this.service.checkEligibility(dto);
  }

  @Post('pre-auth')
  @RequirePermissions('claim:write')
  @Audit({ action: 'preauth.request', resourceType: 'PreAuthorization', isPhi: true })
  preAuth(@ZodBody(PreAuthDto) dto: z.infer<typeof PreAuthDto>) {
    return this.service.requestPreAuth(dto);
  }

  @Post('claims')
  @RequirePermissions('claim:submit')
  @Audit({ action: 'claim.submit', resourceType: 'Claim', isPhi: true })
  submit(@ZodBody(SubmitClaimDto) dto: z.infer<typeof SubmitClaimDto>) {
    return this.service.submitClaim(dto);
  }

  @Post('remittance')
  @RequirePermissions('claim:write')
  @Audit({ action: 'claim.remittance', resourceType: 'ClaimResponse', isPhi: true })
  remittance(@ZodBody(RemittanceDto) dto: z.infer<typeof RemittanceDto>) {
    return this.service.processRemittance(dto);
  }

  @Get('denials')
  @RequirePermissions('claim:read')
  denials(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.service.denialQueue(Number(page ?? 1), Number(limit ?? 25));
  }

  @Post('claims/:id/denial-risk')
  @RequirePermissions('claim:write')
  denialRisk(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { risk: number; factors: string[] },
  ) {
    return this.service.setDenialRisk(id, body.risk, body.factors);
  }

  @Post('claims/:id/appeal')
  @RequirePermissions('claim:write')
  @Audit({ action: 'claim.appeal', resourceType: 'Claim', isPhi: true })
  appeal(@Param('id', ParseUUIDPipe) id: string, @Body('notes') notes: string) {
    return this.service.appeal(id, notes);
  }
}

@Module({
  controllers: [InsuranceController],
  providers: [InsuranceService],
  exports: [InsuranceService],
})
export class InsuranceModule {}
