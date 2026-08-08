/**
 * Revenue-cycle arithmetic: how old the money is and how much of it arrives.
 *
 * Every figure here is integer minor units, and every ratio is basis points —
 * a percentage carried as a float is how a collection rate ends up disagreeing
 * with the ledger it was derived from.
 */

export type AgingBucket = '0-30' | '31-60' | '61-90' | '90+';

export const AGING_BUCKETS: readonly AgingBucket[] = ['0-30', '31-60', '61-90', '90+'];

/** Statuses that still owe money. A cancelled or written-off invoice is not receivable. */
export const OPEN_INVOICE_STATUSES: ReadonlySet<string> = new Set([
  'issued',
  'partially_paid',
  'overdue',
]);

export interface AgeableInvoice {
  id: string;
  status: string;
  balance_minor: number;
  issued_at: Date | string | null;
  created_at: Date | string;
  payer_type?: string | null;
}

const daysBetween = (from: Date | string, to: Date): number =>
  Math.floor((to.getTime() - new Date(from).getTime()) / 86_400_000);

/** Which bucket an invoice of this age falls in. */
export function bucketForAge(days: number): AgingBucket {
  if (days <= 30) return '0-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

export interface AgingRow {
  bucket: AgingBucket;
  invoice_count: number;
  balance_minor: number;
}

export interface AgingReport {
  buckets: AgingRow[];
  total_outstanding_minor: number;
  /** Anything past 90 days, which is what a finance team escalates on. */
  over_90_minor: number;
}

/**
 * Ages open receivables from the date the invoice was issued.
 *
 * Issue date, not creation date: a draft that sat unissued for a fortnight has
 * not been owed for a fortnight. Falls back to created_at only when an invoice
 * somehow reached an open status without being stamped.
 */
export function ageReceivables(
  invoices: readonly AgeableInvoice[],
  now: Date = new Date(),
): AgingReport {
  const rows = new Map<AgingBucket, AgingRow>(
    AGING_BUCKETS.map((bucket) => [bucket, { bucket, invoice_count: 0, balance_minor: 0 }]),
  );

  let total = 0;

  for (const invoice of invoices) {
    if (!OPEN_INVOICE_STATUSES.has(invoice.status)) continue;
    if (invoice.balance_minor <= 0) continue;

    const age = daysBetween(invoice.issued_at ?? invoice.created_at, now);
    const row = rows.get(bucketForAge(Math.max(0, age)))!;
    row.invoice_count += 1;
    row.balance_minor += invoice.balance_minor;
    total += invoice.balance_minor;
  }

  const buckets = AGING_BUCKETS.map((bucket) => rows.get(bucket)!);
  return {
    buckets,
    total_outstanding_minor: total,
    over_90_minor: rows.get('90+')!.balance_minor,
  };
}

/**
 * Basis points of a ratio, so the caller never has to handle a float.
 * 10 000 bp = 100%. An empty denominator is 0, not NaN.
 */
export function ratioBp(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000);
}

export interface CollectionRate {
  billed_minor: number;
  collected_minor: number;
  rate_bp: number;
}

/**
 * What share of the period's billing actually arrived.
 *
 * Cash collected in the period against value billed in the period — the standard
 * net-collection view. It can exceed 100% in a month that clears an old backlog,
 * and that is a real signal, so it is not capped.
 */
export function collectionRate(billedMinor: number, collectedMinor: number): CollectionRate {
  return {
    billed_minor: billedMinor,
    collected_minor: collectedMinor,
    rate_bp: ratioBp(collectedMinor, billedMinor),
  };
}

export interface ClaimOutcome {
  outcome: string;
  denied_minor: number;
  approved_minor: number;
  denial_codes?: string[];
}

export interface DenialRate {
  responses: number;
  denied: number;
  rate_bp: number;
  denied_minor: number;
}

/** A partially-paid claim counts as a denial: some of it was refused. */
export function denialRate(outcomes: readonly ClaimOutcome[]): DenialRate {
  let denied = 0;
  let deniedMinor = 0;

  for (const outcome of outcomes) {
    if (outcome.outcome === 'denied' || outcome.denied_minor > 0) {
      denied += 1;
      deniedMinor += outcome.denied_minor;
    }
  }

  return {
    responses: outcomes.length,
    denied,
    rate_bp: ratioBp(denied, outcomes.length),
    denied_minor: deniedMinor,
  };
}

export interface DenialReasonRow {
  code: string;
  count: number;
  denied_minor: number;
}

/** The denial codes costing the most, worst first. */
export function topDenialReasons(
  outcomes: readonly ClaimOutcome[],
  limit = 5,
): DenialReasonRow[] {
  const rows = new Map<string, DenialReasonRow>();

  for (const outcome of outcomes) {
    for (const code of outcome.denial_codes ?? []) {
      const row = rows.get(code) ?? { code, count: 0, denied_minor: 0 };
      row.count += 1;
      row.denied_minor += outcome.denied_minor;
      rows.set(code, row);
    }
  }

  return [...rows.values()]
    .sort((a, b) => b.denied_minor - a.denied_minor || b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, limit);
}

export interface PayerRevenueRow {
  payer_type: string;
  invoice_count: number;
  billed_minor: number;
  collected_minor: number;
  outstanding_minor: number;
}

export function revenueByPayer(
  invoices: readonly (AgeableInvoice & { total_minor: number; paid_minor: number })[],
): PayerRevenueRow[] {
  const rows = new Map<string, PayerRevenueRow>();

  for (const invoice of invoices) {
    // A cancelled invoice was never revenue.
    if (invoice.status === 'cancelled') continue;
    const key = invoice.payer_type ?? 'cash';
    const row =
      rows.get(key) ??
      { payer_type: key, invoice_count: 0, billed_minor: 0, collected_minor: 0, outstanding_minor: 0 };
    row.invoice_count += 1;
    row.billed_minor += invoice.total_minor;
    row.collected_minor += invoice.paid_minor;
    row.outstanding_minor += invoice.balance_minor;
    rows.set(key, row);
  }

  return [...rows.values()].sort((a, b) => b.billed_minor - a.billed_minor);
}

/** Start of the current month, in UTC. The period every MTD figure is measured over. */
export function startOfMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}
