import { Controller, ForbiddenException, Get, Injectable, Module, Query } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/tenant-context';
import { Audit, RequirePermissions } from '../common/decorators';

/**
 * Patient-facing read model.
 *
 * Scope is taken from the token's `patient_id`, never from a query parameter, so a
 * signed-in patient cannot request another patient's record by changing a URL.
 */
@Injectable()
export class PortalService {
  constructor(private readonly prisma: PrismaService) {}

  async summary() {
    const ctx = currentContext();
    if (!ctx.patientId) {
      throw new ForbiddenException('This endpoint is only available to a patient account');
    }

    const scope = { tenant_id: ctx.tenantId, patient_id: ctx.patientId, deleted_at: null };

    const [appointments, results, invoices] = await Promise.all([
      this.prisma.appointment.findMany({
        where: { ...scope, status: { notIn: ['cancelled'] } },
        select: {
          id: true,
          start: true,
          end: true,
          service_type: true,
          status: true,
          is_telehealth: true,
          telehealth_url: true,
          queue_token: true,
        },
        orderBy: { start: 'desc' },
        take: 20,
      }),
      this.prisma.labResult.findMany({
        // Only verified, final results are shown; a preliminary value must not reach
        // a patient before a clinician has released it.
        where: { ...scope, status: 'final', verified_at: { not: null } },
        select: {
          id: true,
          display: true,
          value_quantity: true,
          value_string: true,
          unit: true,
          reference_low: true,
          reference_high: true,
          interpretation: true,
          performed_at: true,
          status: true,
        },
        orderBy: { performed_at: 'desc' },
        take: 50,
      }),
      this.prisma.invoice.findMany({
        where: { ...scope, status: { notIn: ['draft', 'cancelled'] } },
        select: {
          id: true,
          invoice_number: true,
          currency: true,
          total_minor: true,
          paid_minor: true,
          balance_minor: true,
          due_at: true,
          status: true,
        },
        orderBy: { created_at: 'desc' },
        take: 20,
      }),
    ]);

    return { appointments, results, invoices };
  }

  async medications() {
    const ctx = currentContext();
    if (!ctx.patientId) throw new ForbiddenException('Patient account required');
    return this.prisma.medication.findMany({
      where: { tenant_id: ctx.tenantId, patient_id: ctx.patientId, deleted_at: null, status: 'active' },
      select: {
        id: true,
        code_display: true,
        dose_quantity: true,
        dose_unit: true,
        route: true,
        frequency: true,
        instructions: true,
        refills: true,
        refills_used: true,
        end_date: true,
      },
      orderBy: { created_at: 'desc' },
    });
  }
}

/**
 * Executive analytics. The daily briefing is assembled from live counts rather than
 * a model call, so the dashboard is correct even when the AI provider is unreachable;
 * ai-service enriches it separately when configured.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async dailyBriefing() {
    const tenantId = currentContext().tenantId;
    const since = new Date(Date.now() - 24 * 3_600_000);
    const scope = { tenant_id: tenantId, deleted_at: null };

    const [beds, occupied, criticalPending, highEws, admissions, discharges, overdueClaims, expiringCredentials] =
      await Promise.all([
        this.prisma.bed.count({ where: scope }),
        this.prisma.bed.count({ where: { ...scope, status: 'occupied' } }),
        this.prisma.labResult.count({
          where: { ...scope, is_critical: true, critical_notified_at: null },
        }),
        this.prisma.vital.count({
          where: { ...scope, ews_risk: 'high', recorded_at: { gte: since } },
        }),
        this.prisma.admission.count({ where: { ...scope, admitted_at: { gte: since } } }),
        this.prisma.admission.count({ where: { ...scope, discharged_at: { gte: since } } }),
        this.prisma.insuranceClaim.count({
          where: { ...scope, status: { in: ['denied', 'rejected'] } },
        }),
        this.prisma.credential.count({
          where: {
            ...scope,
            status: { in: ['valid', 'expiring'] },
            expires_at: { not: null, lte: new Date(Date.now() + 30 * 86_400_000) },
          },
        }),
      ]);

    const occupancy = beds ? Math.round((occupied / beds) * 100) : 0;

    const bullets: string[] = [];
    if (criticalPending > 0) {
      bullets.push(`${criticalPending} critical result(s) awaiting acknowledgement`);
    }
    if (highEws > 0) bullets.push(`${highEws} high-EWS observation(s) in the last 24 hours`);
    if (occupancy >= 90) bullets.push(`Bed occupancy at ${occupancy}% — escalation capacity is limited`);
    bullets.push(`${admissions} admission(s) and ${discharges} discharge(s) in the last 24 hours`);
    if (overdueClaims > 0) bullets.push(`${overdueClaims} denied or rejected claim(s) awaiting action`);
    if (expiringCredentials > 0) {
      bullets.push(`${expiringCredentials} staff credential(s) expiring within 30 days`);
    }

    const headline =
      criticalPending > 0
        ? `${criticalPending} unacknowledged critical result(s) need attention`
        : occupancy >= 90
          ? `Bed occupancy is ${occupancy}%`
          : 'No outstanding critical items';

    return {
      headline,
      bullets,
      metrics: {
        beds,
        occupied,
        occupancy_pct: occupancy,
        critical_pending: criticalPending,
        high_ews_24h: highEws,
        admissions_24h: admissions,
        discharges_24h: discharges,
        denied_claims: overdueClaims,
        expiring_credentials: expiringCredentials,
      },
      generated_at: new Date().toISOString(),
      // Deterministic counts, not a model inference — never flagged low confidence.
      low_confidence: false,
      source: 'deterministic',
      ai_enrichment_available: Boolean(this.config.get('AI_SERVICE_URL')),
    };
  }

  async populationHealth(days = 90) {
    const tenantId = currentContext().tenantId;
    const since = new Date(Date.now() - days * 86_400_000);

    const conditions = await this.prisma.condition.groupBy({
      by: ['code', 'code_display'],
      where: { tenant_id: tenantId, deleted_at: null, created_at: { gte: since } },
      _count: { code: true },
      orderBy: { _count: { code: 'desc' } },
      take: 20,
    });

    return {
      period_days: days,
      top_conditions: conditions.map((c) => ({
        code: c.code,
        display: c.code_display,
        count: c._count.code,
      })),
    };
  }
}

@ApiTags('patient-portal')
@Controller('portal')
export class PortalController {
  constructor(private readonly service: PortalService) {}

  @Get('summary')
  @RequirePermissions('patient:read')
  @Audit({ action: 'portal.summary.read', resourceType: 'Patient', isPhi: true })
  @ApiOperation({ summary: 'Patient-scoped appointments, released results and invoices' })
  summary() {
    return this.service.summary();
  }

  @Get('medications')
  @RequirePermissions('patient:read')
  @Audit({ action: 'portal.medications.read', resourceType: 'MedicationRequest', isPhi: true })
  medications() {
    return this.service.medications();
  }
}

@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly service: AnalyticsService) {}

  @Get('daily-briefing')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Live operational briefing for the executive dashboard' })
  dailyBriefing() {
    return this.service.dailyBriefing();
  }

  @Get('population-health')
  @RequirePermissions('config:manage')
  populationHealth(@Query('days') days?: string) {
    return this.service.populationHealth(days ? Number(days) : 90);
  }
}

@Module({
  controllers: [PortalController, AnalyticsController],
  providers: [PortalService, AnalyticsService],
  exports: [PortalService, AnalyticsService],
})
export class PortalModule {}
