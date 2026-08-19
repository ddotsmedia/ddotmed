import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/tenant-context';
import { RequirePermissions } from '../common/decorators';
import { AnalyticsCacheService } from './analytics-cache.service';
import { ReportsController, ReportsService } from './reports.controller';
import {
  ageReceivables,
  collectionRate,
  denialRate,
  revenueByPayer,
  topDenialReasons,
  OPEN_INVOICE_STATUSES,
} from '../billing/ar-aging';
import {
  alosByWard,
  averageLengthOfStay,
  averageTurnaroundMinutes,
  averageWaitMinutes,
  bedTurnoverRate,
  dailyTrend,
  dischargeDelayCount,
  lastNDays,
  percent,
  readmissionRate30d,
  revenueByDepartment,
  startOfDay,
  startOfMonth,
  topDiagnoses,
} from './analytics-metrics';

/** Report windows the dashboards offer. Anything else is clamped into range. */
const MIN_WINDOW_DAYS = 1;
const MAX_WINDOW_DAYS = 365;
const DEFAULT_WINDOW_DAYS = 30;

/** A single scan never reads more than this many rows into memory. */
const SCAN_LIMIT = 20_000;

function windowDays(raw: string | undefined, fallback = DEFAULT_WINDOW_DAYS): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_WINDOW_DAYS, Math.max(MIN_WINDOW_DAYS, Math.floor(n)));
}

@Injectable()
export class DashboardAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: AnalyticsCacheService,
  ) {}

  private scope() {
    return { tenant_id: currentContext().tenantId, deleted_at: null };
  }

  /**
   * The executive KPI strip.
   *
   * Every figure comes from one concurrent batch — the queries are issued together
   * and awaited together, so the tiles describe the same instant. Reading them
   * sequentially would let occupancy be measured a second after the admission
   * count and quietly disagree with it.
   *
   * Cached for sixty seconds per tenant. See {@link AnalyticsCacheService} for why.
   */
  async executive(now: Date = new Date()) {
    const tenantId = currentContext().tenantId;
    return this.cache.wrap(this.cache.key(tenantId, 'executive'), () => this.executiveUncached(now));
  }

  private async executiveUncached(now: Date) {
    const scope = this.scope();
    const dayStart = startOfDay(now);
    const monthStart = startOfMonth(now);

    const [
      inpatients,
      totalBeds,
      occupiedBeds,
      opdVisits,
      payments,
      pendingCriticalLabs,
      monthResponses,
      dischargedThisMonth,
      newPatients,
      tenant,
    ] = await Promise.all([
      this.prisma.admission.count({ where: { ...scope, status: 'admitted', discharged_at: null } }),
      this.prisma.bed.count({ where: scope }),
      this.prisma.bed.count({ where: { ...scope, status: 'occupied' } }),
      // Outpatient contact for the day: an ambulatory or virtual encounter opened today.
      this.prisma.encounter.count({
        where: { ...scope, class: { in: ['AMB', 'VR'] }, period_start: { gte: dayStart } },
      }),
      this.prisma.payment.aggregate({
        where: { ...scope, status: 'succeeded', received_at: { gte: dayStart } },
        _sum: { amount_minor: true, refunded_minor: true },
      }),
      this.prisma.labResult.count({
        where: { ...scope, is_critical: true, critical_notified_at: null },
      }),
      this.prisma.claimResponse.findMany({
        where: { ...scope, received_at: { gte: monthStart } },
        select: { outcome: true, denied_minor: true, approved_minor: true, denial_codes: true },
        take: SCAN_LIMIT,
      }),
      this.prisma.admission.findMany({
        where: { ...scope, discharged_at: { gte: monthStart } },
        select: { patient_id: true, admitted_at: true, discharged_at: true },
        take: SCAN_LIMIT,
      }),
      this.prisma.patient.count({ where: { ...scope, created_at: { gte: dayStart } } }),
      this.prisma.tenant.findUnique({
        where: { id: currentContext().tenantId },
        select: { currency: true },
      }),
    ]);

    // Refunds are money that went back out; today's revenue is the net of the two.
    const revenueToday =
      (payments._sum.amount_minor ?? 0) - (payments._sum.refunded_minor ?? 0);

    return {
      inpatients_today: inpatients,
      bed_occupancy_pct: percent(occupiedBeds, totalBeds),
      opd_visits_today: opdVisits,
      revenue_today_minor: revenueToday,
      revenue_currency: tenant?.currency ?? 'AED',
      pending_critical_labs: pendingCriticalLabs,
      denial_rate_mtd: denialRate(monthResponses).rate_bp,
      avg_los_days: averageLengthOfStay(dischargedThisMonth),
      new_patients_today: newPatients,
      beds_total: totalBeds,
      beds_occupied: occupiedBeds,
      generated_at: now.toISOString(),
    };
  }

  /** Admissions and discharges per day, for the dashboard trend line. */
  async admissionTrend(days = 7, now: Date = new Date()) {
    const tenantId = currentContext().tenantId;
    return this.cache.wrap(this.cache.key(tenantId, 'trend', { days }), async () => {
      const { from } = lastNDays(days, now);
      const scope = this.scope();

      const [admitted, discharged] = await Promise.all([
        this.prisma.admission.findMany({
          where: { ...scope, admitted_at: { gte: from } },
          select: { admitted_at: true },
          take: SCAN_LIMIT,
        }),
        this.prisma.admission.findMany({
          where: { ...scope, discharged_at: { gte: from } },
          select: { discharged_at: true },
          take: SCAN_LIMIT,
        }),
      ]);

      return { days, points: dailyTrend(admitted, discharged, days, now) };
    });
  }

  /**
   * Clinical quality.
   *
   * The readmission window reaches back a further 30 days beyond the reporting
   * period: a discharge on the first day of the period can only be judged against
   * admissions that follow it, and a patient readmitted on day 2 was discharged
   * before the window opened.
   */
  async clinical(days = DEFAULT_WINDOW_DAYS, now: Date = new Date()) {
    const tenantId = currentContext().tenantId;
    return this.cache.wrap(this.cache.key(tenantId, 'clinical', { days }), async () => {
      const { from } = lastNDays(days, now);
      const readmissionFrom = new Date(from.getTime() - 30 * 86_400_000);
      const monthStart = startOfMonth(now);
      const scope = this.scope();

      const [stays, wardStays, diagnoses, isolationBeds, administrations] = await Promise.all([
        this.prisma.admission.findMany({
          where: { ...scope, admitted_at: { gte: readmissionFrom } },
          select: { patient_id: true, admitted_at: true, discharged_at: true },
          orderBy: { admitted_at: 'asc' },
          take: SCAN_LIMIT,
        }),
        this.prisma.admission.findMany({
          where: { ...scope, discharged_at: { gte: from } },
          select: {
            patient_id: true,
            admitted_at: true,
            discharged_at: true,
            bed: { select: { ward: true } },
          },
          take: SCAN_LIMIT,
        }),
        this.prisma.condition.groupBy({
          by: ['code', 'code_display'],
          where: { ...scope, created_at: { gte: from } },
          _count: { code: true },
          orderBy: { _count: { code: 'desc' } },
          take: 20,
        }),
        // Isolation is the infection signal this schema carries: a flagged bed with
        // somebody in it is an active precaution somebody is nursing around.
        this.prisma.bed.count({ where: { ...scope, isolation_flag: true, status: 'occupied' } }),
        this.prisma.medicationAdministration.findMany({
          where: { ...scope, administered_at: { gte: monthStart } },
          select: {
            status: true,
            patient_barcode_verified: true,
            medication_barcode_verified: true,
            dose_verified: true,
            route_verified: true,
            time_verified: true,
          },
          take: SCAN_LIMIT,
        }),
      ]);

      // A medication error here is an administration retracted as entered-in-error,
      // or one recorded as given without all five rights being verified at the
      // bedside. Both are the events a drug-safety committee reviews.
      const medicationErrors = administrations.filter(
        (a) =>
          a.status === 'entered-in-error' ||
          (a.status === 'completed' &&
            !(
              a.patient_barcode_verified &&
              a.medication_barcode_verified &&
              a.dose_verified &&
              a.route_verified &&
              a.time_verified
            )),
      ).length;

      return {
        period_days: days,
        readmission_rate_30d: readmissionRate30d(stays),
        alos_by_ward: alosByWard(
          wardStays.map((s) => ({
            patient_id: s.patient_id,
            admitted_at: s.admitted_at,
            discharged_at: s.discharged_at,
            ward: s.bed?.ward ?? null,
          })),
        ),
        top_diagnoses: topDiagnoses(
          diagnoses.map((d) => ({
            code: d.code,
            display: d.code_display,
            count: d._count.code,
          })),
        ),
        infection_alerts_active: isolationBeds,
        medication_error_count_mtd: medicationErrors,
        generated_at: now.toISOString(),
      };
    });
  }

  /**
   * The revenue cycle.
   *
   * Aging, collection and denial arithmetic is reused verbatim from the billing
   * module rather than re-derived here — two definitions of the collection rate is
   * two numbers in two meetings, and finance will find both.
   */
  async financial(days = DEFAULT_WINDOW_DAYS, now: Date = new Date()) {
    const tenantId = currentContext().tenantId;
    return this.cache.wrap(this.cache.key(tenantId, 'financial', { days }), async () => {
      const { from } = lastNDays(days, now);
      const monthStart = startOfMonth(now);
      const scope = this.scope();

      const invoiceSelect = {
        id: true,
        status: true,
        balance_minor: true,
        total_minor: true,
        paid_minor: true,
        issued_at: true,
        created_at: true,
        payer_type: true,
      } as const;

      const [openInvoices, monthInvoices, monthPayments, responses, lines, tenant] =
        await Promise.all([
          this.prisma.invoice.findMany({
            where: { ...scope, status: { in: [...OPEN_INVOICE_STATUSES] as never } },
            select: invoiceSelect,
            take: SCAN_LIMIT,
          }),
          this.prisma.invoice.findMany({
            where: { ...scope, created_at: { gte: monthStart } },
            select: invoiceSelect,
            take: SCAN_LIMIT,
          }),
          this.prisma.payment.aggregate({
            where: { ...scope, status: 'succeeded', received_at: { gte: monthStart } },
            _sum: { amount_minor: true, refunded_minor: true },
          }),
          this.prisma.claimResponse.findMany({
            where: { ...scope, received_at: { gte: monthStart } },
            select: { outcome: true, denied_minor: true, approved_minor: true, denial_codes: true },
            take: SCAN_LIMIT,
          }),
          this.prisma.invoiceLineItem.findMany({
            where: { ...scope, service_date: { gte: from } },
            select: {
              total_minor: true,
              quantity: true,
              charge_master: { select: { category: true } },
            },
            take: SCAN_LIMIT,
          }),
          this.prisma.tenant.findUnique({
            where: { id: currentContext().tenantId },
            select: { currency: true },
          }),
        ]);

      const billed = monthInvoices
        .filter((i) => i.status !== 'cancelled')
        .reduce((sum, i) => sum + i.total_minor, 0);
      const collected =
        (monthPayments._sum.amount_minor ?? 0) - (monthPayments._sum.refunded_minor ?? 0);

      const aging = ageReceivables(openInvoices, now);
      const bucket = (name: string) =>
        aging.buckets.find((b) => b.bucket === name)?.balance_minor ?? 0;

      return {
        period_days: days,
        currency: tenant?.currency ?? 'AED',
        revenue_by_department: revenueByDepartment(
          lines.map((l) => ({
            category: l.charge_master?.category ?? null,
            total_minor: l.total_minor,
            quantity: l.quantity,
          })),
        ),
        // The named shape the dashboard reads; `buckets` carries the same figures
        // with their invoice counts for anyone drilling in.
        ar_aging: {
          current_minor: bucket('0-30'),
          '30_minor': bucket('31-60'),
          '60_minor': bucket('61-90'),
          '90_minor': 0,
          over90_minor: bucket('90+'),
          total_minor: aging.total_outstanding_minor,
          buckets: aging.buckets,
        },
        collection_rate_mtd: collectionRate(billed, collected),
        denial_rate_mtd: denialRate(responses),
        top_denial_reasons: topDenialReasons(responses),
        revenue_by_payer: revenueByPayer(monthInvoices),
        generated_at: now.toISOString(),
      };
    });
  }

  /**
   * Operational flow.
   *
   * `ot_utilisation_pct` is derived from theatre beds in use against theatre beds
   * that exist — this schema books theatres as beds of type `ot` and has no
   * separate surgery schedule, so a time-based utilisation figure would have to be
   * invented. This one is a point-in-time occupancy of theatre capacity, and is
   * labelled as such rather than dressed up as session utilisation.
   */
  async operational(days = 7, now: Date = new Date()) {
    const tenantId = currentContext().tenantId;
    return this.cache.wrap(this.cache.key(tenantId, 'operational', { days }), async () => {
      const { from } = lastNDays(days, now);
      const scope = this.scope();
      const today = startOfDay(now);

      const [queueEntries, totalBeds, discharges, openAdmissions, otBeds, otOccupied, labPairs, imagingStudies] =
        await Promise.all([
          this.prisma.queue.findMany({
            where: { ...scope, queue_date: { gte: today } },
            select: { created_at: true, called_at: true },
            take: SCAN_LIMIT,
          }),
          this.prisma.bed.count({ where: scope }),
          this.prisma.admission.count({ where: { ...scope, discharged_at: { gte: from } } }),
          this.prisma.admission.findMany({
            where: { ...scope, discharged_at: null, status: 'admitted' },
            select: { expected_discharge_at: true, discharged_at: true },
            take: SCAN_LIMIT,
          }),
          this.prisma.bed.count({ where: { ...scope, bed_type: 'ot' } }),
          this.prisma.bed.count({
            where: { ...scope, bed_type: 'ot', status: { in: ['occupied', 'reserved'] } },
          }),
          this.prisma.labResult.findMany({
            where: { ...scope, performed_at: { gte: from }, service_request_id: { not: null } },
            select: { performed_at: true, service_request: { select: { created_at: true } } },
            take: SCAN_LIMIT,
          }),
          this.prisma.imagingStudy.findMany({
            where: { ...scope, completed_at: { gte: from } },
            select: { completed_at: true, created_at: true },
            take: SCAN_LIMIT,
          }),
        ]);

      return {
        period_days: days,
        avg_wait_minutes_opd: averageWaitMinutes(queueEntries),
        bed_turnover_rate: bedTurnoverRate(discharges, totalBeds),
        discharge_delay_count: dischargeDelayCount(openAdmissions, now),
        ot_utilisation_pct: percent(otOccupied, otBeds),
        ot_beds_total: otBeds,
        // Ordered to resulted, which is the turnaround a clinician experiences.
        lab_tat_avg_minutes: averageTurnaroundMinutes(
          labPairs.map((r) => ({
            ordered_at: r.service_request?.created_at ?? null,
            completed_at: r.performed_at,
          })),
        ),
        radiology_tat_avg_minutes: averageTurnaroundMinutes(
          imagingStudies.map((s) => ({ ordered_at: s.created_at, completed_at: s.completed_at })),
        ),
        discharges_in_period: discharges,
        generated_at: now.toISOString(),
      };
    });
  }
}

@ApiTags('analytics')
@Controller('analytics')
export class DashboardAnalyticsController {
  constructor(private readonly service: DashboardAnalyticsService) {}

  @Get('executive')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Executive KPI strip; one query pass, cached 60 seconds' })
  executive() {
    return this.service.executive();
  }

  @Get('trend')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Daily admissions and discharges for the trend chart' })
  trend(@Query('days') days?: string) {
    return this.service.admissionTrend(windowDays(days, 7));
  }

  @Get('clinical')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Readmission rate, ALOS by ward, top diagnoses, safety counts' })
  clinical(@Query('days') days?: string) {
    return this.service.clinical(windowDays(days));
  }

  @Get('financial')
  @RequirePermissions('invoice:read')
  @ApiOperation({ summary: 'Revenue by department, AR aging, collection and denial rates' })
  financial(@Query('days') days?: string) {
    return this.service.financial(windowDays(days));
  }

  @Get('operational')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Waiting, bed flow, theatre occupancy and turnaround times' })
  operational(@Query('days') days?: string) {
    return this.service.operational(windowDays(days, 7));
  }
}

@Module({
  controllers: [DashboardAnalyticsController, ReportsController],
  providers: [DashboardAnalyticsService, AnalyticsCacheService, ReportsService],
  exports: [DashboardAnalyticsService, AnalyticsCacheService],
})
export class AnalyticsModule {}
