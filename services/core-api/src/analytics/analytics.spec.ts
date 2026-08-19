/**
 * The dashboards through the service.
 *
 * Two things are being protected here. One is that every tile the executive
 * dashboard renders actually arrives — a missing key renders as a blank card, not
 * as an error, so an absent metric is invisible. The other is that the cache is a
 * cache: the second call inside the window must not touch the database.
 */
import { BadRequestException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DashboardAnalyticsService } from './analytics.module';
import { ReportsService, MAX_REPORT_ROWS } from './reports.controller';
import { AnalyticsCacheService } from './analytics-cache.service';
import type { PrismaService } from '../common/prisma.service';
import type { ObjectStorageService } from '../common/object-storage.service';
import { requestContext, type RequestContext } from '../common/tenant-context';
import { ratioBp } from './analytics-metrics';

const NOW = new Date('2026-08-19T14:30:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const ctx: RequestContext = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  roles: ['tenant-admin'],
  permissions: ['patient:read', 'invoice:read', 'config:manage'],
  isBreakGlass: false,
  ip: null,
  userAgent: null,
  requestId: 'r1',
};

const run = <T>(fn: () => Promise<T>): Promise<T> => requestContext.run(ctx, fn);

/** Cache with no Redis configured — the in-process path, which is deterministic. */
const memoryCache = () => {
  const cache = new AnalyticsCacheService({ get: () => undefined } as unknown as ConfigService);
  cache.onModuleInit();
  return cache;
};

const invoice = (over: Record<string, unknown> = {}) => ({
  id: 'i1',
  status: 'issued',
  balance_minor: 10_000,
  total_minor: 10_000,
  paid_minor: 0,
  issued_at: daysAgo(5),
  created_at: daysAgo(5),
  payer_type: 'cash',
  ...over,
});

interface PrismaMock {
  admission: Record<string, jest.Mock>;
  bed: Record<string, jest.Mock>;
  encounter: Record<string, jest.Mock>;
  payment: Record<string, jest.Mock>;
  labResult: Record<string, jest.Mock>;
  claimResponse: Record<string, jest.Mock>;
  patient: Record<string, jest.Mock>;
  tenant: Record<string, jest.Mock>;
  invoice: Record<string, jest.Mock>;
  invoiceLineItem: Record<string, jest.Mock>;
  condition: Record<string, jest.Mock>;
  medicationAdministration: Record<string, jest.Mock>;
  queue: Record<string, jest.Mock>;
  imagingStudy: Record<string, jest.Mock>;
  appointment: Record<string, jest.Mock>;
}

function prismaMock(): PrismaMock {
  return {
    admission: {
      count: jest.fn().mockResolvedValue(12),
      findMany: jest.fn().mockResolvedValue([]),
    },
    bed: { count: jest.fn().mockResolvedValue(40) },
    encounter: { count: jest.fn().mockResolvedValue(31), findMany: jest.fn().mockResolvedValue([]) },
    payment: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amount_minor: 250_000, refunded_minor: 5_000 } }),
    },
    labResult: { count: jest.fn().mockResolvedValue(2), findMany: jest.fn().mockResolvedValue([]) },
    claimResponse: { findMany: jest.fn().mockResolvedValue([]) },
    patient: { count: jest.fn().mockResolvedValue(7) },
    tenant: { findUnique: jest.fn().mockResolvedValue({ currency: 'AED' }) },
    invoice: { findMany: jest.fn().mockResolvedValue([]) },
    invoiceLineItem: { findMany: jest.fn().mockResolvedValue([]) },
    condition: { groupBy: jest.fn().mockResolvedValue([]) },
    medicationAdministration: { findMany: jest.fn().mockResolvedValue([]) },
    queue: { findMany: jest.fn().mockResolvedValue([]) },
    imagingStudy: { findMany: jest.fn().mockResolvedValue([]) },
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
  };
}

describe('DashboardAnalyticsService.executive', () => {
  let prisma: PrismaMock;
  let cache: AnalyticsCacheService;
  let service: DashboardAnalyticsService;

  /** Every key the executive dashboard binds a tile to. */
  const REQUIRED_KEYS = [
    'inpatients_today',
    'bed_occupancy_pct',
    'opd_visits_today',
    'revenue_today_minor',
    'revenue_currency',
    'pending_critical_labs',
    'denial_rate_mtd',
    'avg_los_days',
    'new_patients_today',
  ];

  beforeEach(() => {
    prisma = prismaMock();
    cache = memoryCache();
    service = new DashboardAnalyticsService(prisma as unknown as PrismaService, cache);
  });

  it('returns every key the dashboard renders', async () => {
    const result = (await run(() => service.executive(NOW))) as Record<string, unknown>;

    for (const key of REQUIRED_KEYS) {
      // A missing key renders as a blank card rather than an error, so absence
      // has to be caught here.
      expect(Object.keys(result)).toContain(key);
      expect(result[key]).not.toBeUndefined();
    }
  });

  it('computes occupancy, revenue and the counts from one pass', async () => {
    prisma.bed.count
      .mockResolvedValueOnce(40) // total
      .mockResolvedValueOnce(30); // occupied

    const result = await run(() => service.executive(NOW));

    expect(result.inpatients_today).toBe(12);
    expect(result.bed_occupancy_pct).toBe(75);
    expect(result.opd_visits_today).toBe(31);
    // 250 000 taken less 5 000 refunded.
    expect(result.revenue_today_minor).toBe(245_000);
    expect(result.revenue_currency).toBe('AED');
    expect(result.pending_critical_labs).toBe(2);
    expect(result.new_patients_today).toBe(7);
  });

  it('reports average length of stay as null when nobody was discharged', async () => {
    // Null, not zero: "no discharges" and "stays averaged zero days" are different.
    const result = await run(() => service.executive(NOW));
    expect(result.avg_los_days).toBeNull();
  });

  it('falls back to a currency rather than failing when the tenant has none', async () => {
    prisma.tenant.findUnique.mockResolvedValue(null);
    const result = await run(() => service.executive(NOW));
    expect(result.revenue_currency).toBe('AED');
  });

  it('serves the second call from cache, without touching the database', async () => {
    const first = await run(() => service.executive(NOW));
    const queriesAfterFirst = prisma.bed.count.mock.calls.length;
    expect(queriesAfterFirst).toBeGreaterThan(0);

    const second = await run(() => service.executive(NOW));

    expect(second).toEqual(first);
    expect(prisma.bed.count).toHaveBeenCalledTimes(queriesAfterFirst);
    expect(prisma.admission.count).toHaveBeenCalledTimes(1);
    expect(cache.producerRuns).toBe(1);
  });

  it(`keeps one tenant's dashboard out of another's cache`, async () => {
    await run(() => service.executive(NOW));
    await requestContext.run({ ...ctx, tenantId: 't2' }, () => service.executive(NOW));

    // A second tenant is a second key, so the producer must have run again.
    expect(cache.producerRuns).toBe(2);
  });

  it('does not cache a failure', async () => {
    prisma.admission.count.mockRejectedValueOnce(new Error('connection reset'));
    await expect(run(() => service.executive(NOW))).rejects.toThrow('connection reset');

    prisma.admission.count.mockResolvedValue(12);
    const result = await run(() => service.executive(NOW));
    expect(result.inpatients_today).toBe(12);
  });
});

describe('DashboardAnalyticsService.financial', () => {
  let prisma: PrismaMock;
  let service: DashboardAnalyticsService;

  beforeEach(() => {
    prisma = prismaMock();
    service = new DashboardAnalyticsService(prisma as unknown as PrismaService, memoryCache());
  });

  it('splits AR into buckets that sum to the total outstanding', async () => {
    const open = [
      invoice({ id: 'a', issued_at: daysAgo(10), balance_minor: 1_000 }),
      invoice({ id: 'b', issued_at: daysAgo(45), balance_minor: 2_000 }),
      invoice({ id: 'c', issued_at: daysAgo(75), balance_minor: 3_000 }),
      invoice({ id: 'd', issued_at: daysAgo(200), balance_minor: 4_000 }),
    ];
    prisma.invoice.findMany.mockResolvedValueOnce(open).mockResolvedValueOnce([]);

    const result = await run(() => service.financial(30, NOW));
    const aging = result.ar_aging;

    expect(aging.current_minor).toBe(1_000);
    expect(aging['30_minor']).toBe(2_000);
    expect(aging['60_minor']).toBe(3_000);
    expect(aging.over90_minor).toBe(4_000);

    const summed =
      aging.current_minor + aging['30_minor'] + aging['60_minor'] + aging['90_minor'] + aging.over90_minor;
    expect(summed).toBe(aging.total_minor);
    expect(summed).toBe(10_000);
  });

  it('sums to the total when every bucket is empty', async () => {
    const result = await run(() => service.financial(30, NOW));
    const aging = result.ar_aging;
    const summed =
      aging.current_minor + aging['30_minor'] + aging['60_minor'] + aging['90_minor'] + aging.over90_minor;
    expect(summed).toBe(0);
    expect(aging.total_minor).toBe(0);
    expect(aging.buckets).toHaveLength(4);
  });

  it('computes the collection rate as cash collected over value billed, month to date', async () => {
    prisma.invoice.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        invoice({ id: 'm1', total_minor: 100_000, paid_minor: 60_000 }),
        invoice({ id: 'm2', total_minor: 100_000, paid_minor: 0 }),
      ]);
    prisma.payment.aggregate.mockResolvedValue({
      _sum: { amount_minor: 130_000, refunded_minor: 10_000 },
    });

    const result = await run(() => service.financial(30, NOW));

    expect(result.collection_rate_mtd.billed_minor).toBe(200_000);
    // Refunds come back out of collections before the ratio is taken.
    expect(result.collection_rate_mtd.collected_minor).toBe(120_000);
    expect(result.collection_rate_mtd.rate_bp).toBe(6_000);
    expect(result.collection_rate_mtd.rate_bp).toBe(ratioBp(120_000, 200_000));
  });

  it('keeps a cancelled invoice out of the billed figure', async () => {
    prisma.invoice.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        invoice({ id: 'm1', total_minor: 100_000 }),
        invoice({ id: 'm2', total_minor: 999_000, status: 'cancelled' }),
      ]);

    const result = await run(() => service.financial(30, NOW));
    expect(result.collection_rate_mtd.billed_minor).toBe(100_000);
  });

  it('reports a zero collection rate rather than NaN in a month with no billing', async () => {
    prisma.payment.aggregate.mockResolvedValue({ _sum: { amount_minor: 0, refunded_minor: 0 } });
    const result = await run(() => service.financial(30, NOW));
    expect(result.collection_rate_mtd.rate_bp).toBe(0);
  });

  it('groups revenue by charge-master category', async () => {
    prisma.invoiceLineItem.findMany.mockResolvedValue([
      { total_minor: 5_000, quantity: 1, charge_master: { category: 'Radiology' } },
      { total_minor: 7_000, quantity: 1, charge_master: null },
    ]);

    const result = await run(() => service.financial(30, NOW));
    expect(result.revenue_by_department).toEqual([
      { department: 'Uncategorised', line_count: 1, billed_minor: 7_000 },
      { department: 'Radiology', line_count: 1, billed_minor: 5_000 },
    ]);
  });

  it('returns every key the financial tab renders', async () => {
    const result = (await run(() => service.financial(30, NOW))) as Record<string, unknown>;
    for (const key of [
      'revenue_by_department',
      'ar_aging',
      'collection_rate_mtd',
      'top_denial_reasons',
      'revenue_by_payer',
    ]) {
      expect(Object.keys(result)).toContain(key);
    }
  });
});

describe('DashboardAnalyticsService.clinical and .operational', () => {
  let prisma: PrismaMock;
  let service: DashboardAnalyticsService;

  beforeEach(() => {
    prisma = prismaMock();
    service = new DashboardAnalyticsService(prisma as unknown as PrismaService, memoryCache());
  });

  it('returns every key the clinical tab renders', async () => {
    const result = (await run(() => service.clinical(30, NOW))) as Record<string, unknown>;
    for (const key of [
      'readmission_rate_30d',
      'alos_by_ward',
      'top_diagnoses',
      'infection_alerts_active',
      'medication_error_count_mtd',
    ]) {
      expect(Object.keys(result)).toContain(key);
    }
  });

  it('counts an administration given without all five rights as an error', async () => {
    prisma.medicationAdministration.findMany.mockResolvedValue([
      {
        status: 'completed',
        patient_barcode_verified: true,
        medication_barcode_verified: true,
        dose_verified: true,
        route_verified: true,
        time_verified: true,
      },
      {
        status: 'completed',
        patient_barcode_verified: true,
        medication_barcode_verified: false,
        dose_verified: true,
        route_verified: true,
        time_verified: true,
      },
      {
        status: 'entered-in-error',
        patient_barcode_verified: true,
        medication_barcode_verified: true,
        dose_verified: true,
        route_verified: true,
        time_verified: true,
      },
    ]);

    const result = await run(() => service.clinical(30, NOW));
    expect(result.medication_error_count_mtd).toBe(2);
  });

  it('returns every key the operational tab renders', async () => {
    const result = (await run(() => service.operational(7, NOW))) as Record<string, unknown>;
    for (const key of [
      'avg_wait_minutes_opd',
      'bed_turnover_rate',
      'discharge_delay_count',
      'ot_utilisation_pct',
      'lab_tat_avg_minutes',
      'radiology_tat_avg_minutes',
    ]) {
      expect(Object.keys(result)).toContain(key);
    }
  });

  it('reports theatre occupancy against theatre capacity', async () => {
    prisma.bed.count
      .mockResolvedValueOnce(40) // all beds
      .mockResolvedValueOnce(4) // theatres
      .mockResolvedValueOnce(3); // theatres in use

    const result = await run(() => service.operational(7, NOW));
    expect(result.ot_utilisation_pct).toBe(75);
    expect(result.ot_beds_total).toBe(4);
  });

  it('reports a turnaround as null when nothing completed, not as zero', async () => {
    const result = await run(() => service.operational(7, NOW));
    expect(result.lab_tat_avg_minutes).toBeNull();
    expect(result.radiology_tat_avg_minutes).toBeNull();
  });

  it('produces a dense trend series for the chart', async () => {
    const result = await run(() => service.admissionTrend(7, NOW));
    expect(result.points).toHaveLength(7);
  });
});

describe('ReportsService', () => {
  let prisma: PrismaMock;
  let storage: ObjectStorageService;
  let service: ReportsService;

  beforeEach(() => {
    prisma = prismaMock();
    storage = {
      isConfigured: false,
      putObject: jest.fn().mockResolvedValue(null),
    } as unknown as ObjectStorageService;
    service = new ReportsService(prisma as unknown as PrismaService, storage);
  });

  it('rejects a non-whitelisted field with 400 before any query runs', async () => {
    let thrown: unknown;
    await run(() =>
      service.run({
        source: 'invoices',
        fields: ['status', 'password_hash'],
        filters: [],
        limit: 100,
      } as never),
    ).catch((e: unknown) => {
      thrown = e;
    });

    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as BadRequestException).getStatus()).toBe(400);
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
  });

  it('rejects a non-whitelisted filter field with 400', async () => {
    await expect(
      run(() =>
        service.run({
          source: 'invoices',
          fields: ['status'],
          filters: [{ field: 'mfa_secret', operator: 'eq', value: 'x' }],
          limit: 100,
        } as never),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it(`always scopes the query to the caller's tenant and excludes soft-deleted rows`, async () => {
    await run(() =>
      service.run({ source: 'invoices', fields: ['status'], filters: [], limit: 100 } as never),
    );

    const where = prisma.invoice.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.tenant_id).toBe('t1');
    expect(where.deleted_at).toBeNull();
  });

  it('cannot have its tenant scope overridden by a filter', async () => {
    await run(() =>
      service.run({
        source: 'invoices',
        fields: ['status'],
        filters: [{ field: 'status', operator: 'eq', value: 'paid' }],
        limit: 100,
      } as never),
    );

    const where = prisma.invoice.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.tenant_id).toBe('t1');
    expect(where.AND).toEqual([{ status: 'paid' }]);
  });

  it('caps the result and reports that it was truncated', async () => {
    // One more than the limit comes back, which is how truncation is detected.
    prisma.invoice.findMany.mockResolvedValue(
      Array.from({ length: 4 }, (_, i) => ({ status: `s${i}` })),
    );

    const result = await run(() =>
      service.run({ source: 'invoices', fields: ['status'], filters: [], limit: 3 } as never),
    );

    expect(result.row_count).toBe(3);
    expect(result.truncated).toBe(true);
    expect(prisma.invoice.findMany.mock.calls[0][0].take).toBe(4);
  });

  it('never asks for more than the hard row ceiling', async () => {
    await run(() =>
      service.run({
        source: 'invoices',
        fields: ['status'],
        filters: [],
        limit: MAX_REPORT_ROWS,
      } as never),
    );
    expect(prisma.invoice.findMany.mock.calls[0][0].take).toBe(MAX_REPORT_ROWS + 1);
  });

  it(`applies the date range to the source's own date column`, async () => {
    const from = daysAgo(30);
    const to = NOW;
    await run(() =>
      service.run({
        source: 'admissions',
        fields: ['admission_number'],
        filters: [],
        date_range: { from, to },
        limit: 100,
      } as never),
    );

    const where = prisma.admission.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.admitted_at).toEqual({ gte: from, lte: to });
  });

  it('groups rows and flags the result as no longer a PHI extract', async () => {
    prisma.invoice.findMany.mockResolvedValue([
      { payer_type: 'cash', total_minor: 1_000, patient: { mrn: 'MRN-1' } },
      { payer_type: 'cash', total_minor: 2_000, patient: { mrn: 'MRN-2' } },
    ]);

    const result = await run(() =>
      service.run({
        source: 'invoices',
        fields: ['mrn', 'total_minor'],
        filters: [],
        group_by: 'payer_type',
        limit: 100,
      } as never),
    );

    expect(result.grouped_by).toBe('payer_type');
    expect(result.rows).toEqual([{ group: 'cash', count: 2, total_minor: 3_000 }]);
    // Grouping collapsed the identifiers away.
    expect(result.contains_phi).toBe(false);
  });

  it('flags an ungrouped report carrying an identifier as PHI', async () => {
    prisma.invoice.findMany.mockResolvedValue([{ patient: { mrn: 'MRN-1' } }]);
    const result = await run(() =>
      service.run({ source: 'invoices', fields: ['mrn'], filters: [], limit: 100 } as never),
    );
    expect(result.contains_phi).toBe(true);
  });

  it('refuses to group on a field that is not bucketable', async () => {
    await expect(
      run(() =>
        service.run({
          source: 'invoices',
          fields: ['status'],
          filters: [],
          group_by: 'total_minor',
          limit: 100,
        } as never),
      ),
    ).rejects.toThrow(/cannot be grouped/);
  });

  it('renders CSV with the labels as its header', async () => {
    prisma.invoice.findMany.mockResolvedValue([{ status: 'paid' }]);
    const result = await run(() =>
      service.run({ source: 'invoices', fields: ['status'], filters: [], limit: 100 } as never),
    );

    const rendered = service.render(result, 'csv', { title: 'Invoices' });
    expect(rendered.contentType).toContain('text/csv');
    expect(rendered.body).toBe('Status\r\npaid\r\n');
  });

  it('renders the PDF path as a printable document', async () => {
    prisma.invoice.findMany.mockResolvedValue([{ status: 'paid' }]);
    const result = await run(() =>
      service.run({ source: 'invoices', fields: ['status'], filters: [], limit: 100 } as never),
    );

    const rendered = service.render(result, 'pdf', { title: 'Invoices' });
    expect(rendered.contentType).toContain('text/html');
    expect(rendered.extension).toBe('html');
    expect(rendered.body).toContain('@page');
  });

  it('names an export under the tenant that asked for it', async () => {
    const key = await run(async () => service.exportKey('invoices', 'csv', NOW));
    expect(key.startsWith('tenants/t1/reports/')).toBe(true);
    expect(key.endsWith('.csv')).toBe(true);
  });

  it('reports storage as unavailable so the caller streams inline instead', () => {
    expect(service.storageAvailable).toBe(false);
  });
});
