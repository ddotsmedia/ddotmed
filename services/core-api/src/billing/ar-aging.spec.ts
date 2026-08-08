import {
  AGING_BUCKETS,
  ageReceivables,
  bucketForAge,
  collectionRate,
  denialRate,
  ratioBp,
  revenueByPayer,
  startOfMonth,
  topDenialReasons,
} from './ar-aging';

const NOW = new Date('2026-08-02T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

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

describe('bucketForAge', () => {
  it('places each age in its bucket, boundaries included in the lower one', () => {
    expect(bucketForAge(0)).toBe('0-30');
    expect(bucketForAge(30)).toBe('0-30');
    expect(bucketForAge(31)).toBe('31-60');
    expect(bucketForAge(60)).toBe('31-60');
    expect(bucketForAge(61)).toBe('61-90');
    expect(bucketForAge(90)).toBe('61-90');
    expect(bucketForAge(91)).toBe('90+');
  });
});

describe('ageReceivables', () => {
  it('returns all four buckets even when some are empty', () => {
    const report = ageReceivables([invoice()], NOW);
    expect(report.buckets.map((b) => b.bucket)).toEqual([...AGING_BUCKETS]);
    expect(report.buckets.find((b) => b.bucket === '90+')!.balance_minor).toBe(0);
  });

  it('ages by issue date and sums balances into the right bucket', () => {
    const report = ageReceivables(
      [
        invoice({ id: 'a', issued_at: daysAgo(10), balance_minor: 1_000 }),
        invoice({ id: 'b', issued_at: daysAgo(45), balance_minor: 2_000 }),
        invoice({ id: 'c', issued_at: daysAgo(75), balance_minor: 3_000 }),
        invoice({ id: 'd', issued_at: daysAgo(200), balance_minor: 4_000 }),
      ],
      NOW,
    );

    expect(report.buckets.map((b) => b.balance_minor)).toEqual([1_000, 2_000, 3_000, 4_000]);
    expect(report.total_outstanding_minor).toBe(10_000);
    expect(report.over_90_minor).toBe(4_000);
  });

  it('ignores paid, cancelled and written-off invoices', () => {
    const report = ageReceivables(
      [
        invoice({ id: 'paid', status: 'paid', balance_minor: 0 }),
        invoice({ id: 'void', status: 'cancelled', balance_minor: 5_000 }),
        invoice({ id: 'off', status: 'written_off', balance_minor: 5_000 }),
      ],
      NOW,
    );
    expect(report.total_outstanding_minor).toBe(0);
  });

  it('counts a partially paid invoice for what is still owed', () => {
    const report = ageReceivables(
      [invoice({ status: 'partially_paid', balance_minor: 2_500 })],
      NOW,
    );
    expect(report.total_outstanding_minor).toBe(2_500);
    expect(report.buckets[0]!.invoice_count).toBe(1);
  });

  it('falls back to created_at when an open invoice was never stamped as issued', () => {
    const report = ageReceivables(
      [invoice({ issued_at: null, created_at: daysAgo(100), balance_minor: 700 })],
      NOW,
    );
    expect(report.over_90_minor).toBe(700);
  });

  it('does not put a future-dated invoice into a negative age', () => {
    const future = new Date(NOW.getTime() + 5 * 86_400_000).toISOString();
    const report = ageReceivables([invoice({ issued_at: future })], NOW);
    expect(report.buckets[0]!.invoice_count).toBe(1);
  });
});

describe('ratioBp', () => {
  it('expresses a ratio in basis points', () => {
    expect(ratioBp(1, 2)).toBe(5_000);
    expect(ratioBp(3, 4)).toBe(7_500);
  });

  it('reads an empty denominator as zero rather than NaN', () => {
    expect(ratioBp(100, 0)).toBe(0);
  });
});

describe('collectionRate', () => {
  it('reports what share of billing arrived', () => {
    expect(collectionRate(100_000, 85_000)).toEqual({
      billed_minor: 100_000,
      collected_minor: 85_000,
      rate_bp: 8_500,
    });
  });

  it('does not cap a month that cleared an old backlog', () => {
    expect(collectionRate(50_000, 75_000).rate_bp).toBe(15_000);
  });

  it('is zero, not NaN, in a month with no billing', () => {
    expect(collectionRate(0, 0).rate_bp).toBe(0);
  });
});

describe('denialRate', () => {
  const outcome = (over: Record<string, unknown> = {}) => ({
    outcome: 'approved',
    denied_minor: 0,
    approved_minor: 1_000,
    denial_codes: [] as string[],
    ...over,
  });

  it('counts a partially paid claim as a denial — some of it was refused', () => {
    const rate = denialRate([
      outcome(),
      outcome({ outcome: 'partial', denied_minor: 400, approved_minor: 600 }),
      outcome({ outcome: 'denied', denied_minor: 1_000, approved_minor: 0 }),
    ]);
    expect(rate.responses).toBe(3);
    expect(rate.denied).toBe(2);
    expect(rate.rate_bp).toBe(6_667);
    expect(rate.denied_minor).toBe(1_400);
  });

  it('is zero on a month with no responses', () => {
    expect(denialRate([])).toEqual({ responses: 0, denied: 0, rate_bp: 0, denied_minor: 0 });
  });
});

describe('topDenialReasons', () => {
  it('ranks by money refused, then by frequency', () => {
    const rows = topDenialReasons([
      { outcome: 'denied', denied_minor: 5_000, approved_minor: 0, denial_codes: ['NO_AUTH'] },
      { outcome: 'denied', denied_minor: 500, approved_minor: 0, denial_codes: ['CODING'] },
      { outcome: 'denied', denied_minor: 400, approved_minor: 0, denial_codes: ['CODING'] },
    ]);
    expect(rows[0]).toEqual({ code: 'NO_AUTH', count: 1, denied_minor: 5_000 });
    expect(rows[1]).toEqual({ code: 'CODING', count: 2, denied_minor: 900 });
  });

  it('counts every code on a multi-code denial', () => {
    const rows = topDenialReasons([
      { outcome: 'denied', denied_minor: 1_000, approved_minor: 0, denial_codes: ['A', 'B'] },
    ]);
    expect(rows.map((r) => r.code).sort()).toEqual(['A', 'B']);
  });

  it('honours the limit', () => {
    const outcomes = ['A', 'B', 'C', 'D', 'E', 'F'].map((code, i) => ({
      outcome: 'denied',
      denied_minor: (6 - i) * 100,
      approved_minor: 0,
      denial_codes: [code],
    }));
    expect(topDenialReasons(outcomes, 3)).toHaveLength(3);
  });

  it('returns nothing when nothing was denied', () => {
    expect(topDenialReasons([{ outcome: 'approved', denied_minor: 0, approved_minor: 100 }])).toEqual(
      [],
    );
  });
});

describe('revenueByPayer', () => {
  it('groups billed, collected and outstanding by payer type', () => {
    const rows = revenueByPayer([
      invoice({ payer_type: 'insurance', total_minor: 10_000, paid_minor: 4_000, balance_minor: 6_000 }),
      invoice({ payer_type: 'insurance', total_minor: 5_000, paid_minor: 5_000, balance_minor: 0, status: 'paid' }),
      invoice({ payer_type: 'cash', total_minor: 2_000, paid_minor: 2_000, balance_minor: 0, status: 'paid' }),
    ]);

    expect(rows[0]).toEqual({
      payer_type: 'insurance',
      invoice_count: 2,
      billed_minor: 15_000,
      collected_minor: 9_000,
      outstanding_minor: 6_000,
    });
    expect(rows[1]!.payer_type).toBe('cash');
  });

  it('excludes a cancelled invoice — it was never revenue', () => {
    const rows = revenueByPayer([
      invoice({ status: 'cancelled', total_minor: 99_000, balance_minor: 0 }),
    ]);
    expect(rows).toEqual([]);
  });

  it('treats a missing payer type as cash', () => {
    expect(revenueByPayer([invoice({ payer_type: null })])[0]!.payer_type).toBe('cash');
  });
});

describe('startOfMonth', () => {
  it('is midnight UTC on the first', () => {
    expect(startOfMonth(NOW).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });
});
