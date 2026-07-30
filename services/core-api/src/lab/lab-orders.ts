/**
 * Lab order lifecycle and label formatting.
 *
 * Kept free of Prisma so the rules that decide whether an order may still be
 * changed — and what goes on the tube label — are testable on their own. A tube
 * mislabelled at the bedside is the single commonest cause of a wrong result
 * reaching the wrong chart.
 */

export type OrderStatus = 'draft' | 'active' | 'on_hold' | 'revoked' | 'completed' | 'entered_in_error';

export type OrderPriority = 'routine' | 'urgent' | 'asap' | 'stat';

/** Highest urgency first — the order a phlebotomy worklist is worked in. */
export const PRIORITY_RANK: Record<OrderPriority, number> = {
  stat: 0,
  asap: 1,
  urgent: 2,
  routine: 3,
};

/** Statuses an order can still move to. Terminal states have no exits. */
export const ORDER_STATUS_FLOW: Record<OrderStatus, OrderStatus[]> = {
  draft: ['active', 'revoked'],
  active: ['on_hold', 'completed', 'revoked'],
  on_hold: ['active', 'revoked'],
  revoked: [],
  completed: [],
  entered_in_error: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_STATUS_FLOW[from]?.includes(to) ?? false;
}

/** True once the order is finished with, in either direction. */
export function isTerminal(status: OrderStatus): boolean {
  return ORDER_STATUS_FLOW[status]?.length === 0;
}

/**
 * Priority may only be raised on a live order.
 *
 * Lowering it is what a cancel-and-reorder is for: a specimen already drawn as
 * STAT has been handled as STAT, and quietly downgrading it hides that.
 */
export function canChangePriority(
  status: OrderStatus,
  from: OrderPriority,
  to: OrderPriority,
): boolean {
  if (isTerminal(status)) return false;
  return PRIORITY_RANK[to] <= PRIORITY_RANK[from];
}

export function sortByUrgency<T extends { priority: string; created_at: Date | string }>(
  orders: readonly T[],
): T[] {
  return [...orders].sort((a, b) => {
    const rank =
      (PRIORITY_RANK[a.priority as OrderPriority] ?? 9) -
      (PRIORITY_RANK[b.priority as OrderPriority] ?? 9);
    if (rank !== 0) return rank;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

/** `LAB-2026-000123` — year-scoped and human-readable on a printed worklist. */
export function formatOrderNumber(year: number, sequence: number): string {
  return `LAB-${year}-${String(sequence).padStart(6, '0')}`;
}

/**
 * The scannable payload. Code 128 subset B is safest with an alphanumeric body,
 * so the separators are stripped rather than encoded.
 */
export function barcodeFor(orderNumber: string): string {
  return orderNumber.replace(/-/g, '');
}

export function sequenceFromOrderNumber(orderNumber: string | null | undefined): number {
  if (!orderNumber) return 0;
  const tail = orderNumber.slice(orderNumber.lastIndexOf('-') + 1);
  const n = Number(tail);
  return Number.isFinite(n) ? n : 0;
}

export interface LabelFields {
  order_number: string;
  barcode: string;
  patient_name: string;
  mrn: string;
  test_name: string;
  priority: OrderPriority;
  fasting_required: boolean;
  collected_by?: string | null;
  printed_at: string;
}

/**
 * Everything that must be legible on a specimen label.
 *
 * STAT and fasting are called out in words rather than left to a colour, because
 * labels are routinely printed on monochrome thermal printers.
 */
export function labelFor(
  order: {
    order_number: string;
    barcode: string | null;
    code_display: string;
    priority: string;
    fasting_required: boolean;
  },
  patient: { mrn: string; given_names: string[]; family_name: string },
  printedAt: Date,
): LabelFields {
  return {
    order_number: order.order_number,
    barcode: order.barcode ?? barcodeFor(order.order_number),
    patient_name: `${patient.given_names.join(' ')} ${patient.family_name}`.trim(),
    mrn: patient.mrn,
    test_name: order.code_display,
    priority: (order.priority as OrderPriority) ?? 'routine',
    fasting_required: order.fasting_required,
    printed_at: printedAt.toISOString(),
  };
}
