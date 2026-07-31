/**
 * Ordering the dispensing queue.
 *
 * A prescription carries no priority field of its own — urgency is a property of
 * the drug, the setting and how long the patient has already been waiting. Kept
 * pure so the rule can be read and tested without a database, because "who gets
 * their medicine next" is a decision worth being able to explain.
 */

export type QueuePriority = 'urgent' | 'high' | 'routine';

/** Highest urgency first. */
export const QUEUE_RANK: Record<QueuePriority, number> = {
  urgent: 0,
  high: 1,
  routine: 2,
};

/** Encounter classes that mean the patient cannot wait in a queue. */
const EMERGENCY_CLASSES: ReadonlySet<string> = new Set(['EMER', 'ACUTE']);

/** A routine prescription that has waited this long is escalated. */
export const ESCALATE_AFTER_MINUTES = 45;

export interface QueueCandidate {
  id: string;
  created_at: Date | string;
  is_controlled: boolean;
  is_prn: boolean;
  encounter_class?: string | null;
  is_high_alert?: boolean;
}

export interface QueueEntry<T extends QueueCandidate = QueueCandidate> {
  item: T;
  priority: QueuePriority;
  waiting_minutes: number;
  /** Why it sits where it sits — shown on the card so the order is never a mystery. */
  reason: string;
}

const minutesSince = (at: Date | string, now: Date): number =>
  Math.max(0, Math.floor((now.getTime() - new Date(at).getTime()) / 60_000));

/**
 * Emergency first, then anything that needs a witness or is high-alert — those
 * take a second person and a register entry, so starting them late is what makes
 * a queue stall. A long wait escalates on its own.
 */
export function queuePriority(item: QueueCandidate, now = new Date()): QueueEntry {
  const waiting = minutesSince(item.created_at, now);

  if (item.encounter_class && EMERGENCY_CLASSES.has(item.encounter_class)) {
    return { item, priority: 'urgent', waiting_minutes: waiting, reason: 'Emergency encounter' };
  }
  if (item.is_controlled) {
    return {
      item,
      priority: 'high',
      waiting_minutes: waiting,
      reason: 'Controlled drug — needs a witness',
    };
  }
  if (item.is_high_alert) {
    return { item, priority: 'high', waiting_minutes: waiting, reason: 'High-alert medication' };
  }
  if (waiting >= ESCALATE_AFTER_MINUTES) {
    return {
      item,
      priority: 'high',
      waiting_minutes: waiting,
      reason: `Waiting ${waiting} minutes`,
    };
  }
  return {
    item,
    priority: 'routine',
    waiting_minutes: waiting,
    // A PRN order is dispensed for the ward stock cupboard rather than for a
    // patient standing at the counter, so it never jumps the queue.
    reason: item.is_prn ? 'When required' : 'Routine',
  };
}

export function sortQueue<T extends QueueCandidate>(items: readonly T[], now = new Date()): Array<QueueEntry<T>> {
  return items
    .map((item) => queuePriority(item, now) as QueueEntry<T>)
    .sort((a, b) => {
      const rank = QUEUE_RANK[a.priority] - QUEUE_RANK[b.priority];
      if (rank !== 0) return rank;
      // Within a band, the longest wait goes first.
      return b.waiting_minutes - a.waiting_minutes;
    });
}

export interface StockLevel {
  quantity_on_hand: number;
  reorder_level: number;
}

/**
 * True once stock has fallen below the reorder point.
 *
 * A reorder level of zero means the item is not tracked for reordering, not that
 * every dispense should raise an alert.
 */
export function isBelowReorderLevel(stock: StockLevel): boolean {
  return stock.reorder_level > 0 && stock.quantity_on_hand < stock.reorder_level;
}

/** True only on the dispense that took stock across the line, so alerts do not repeat. */
export function crossedReorderLevel(before: number, after: number, reorderLevel: number): boolean {
  if (reorderLevel <= 0) return false;
  return before >= reorderLevel && after < reorderLevel;
}

export type ExpiryBand = 'expired' | 'expiring' | 'ok';

/** Days ahead that count as "expiring soon" for the nightly sweep. */
export const EXPIRY_WARNING_DAYS = 30;

export function expiryBand(
  expiryDate: Date | string | null | undefined,
  now = new Date(),
  warningDays = EXPIRY_WARNING_DAYS,
): ExpiryBand {
  if (!expiryDate) return 'ok';
  const expiry = new Date(expiryDate).getTime();
  if (expiry <= now.getTime()) return 'expired';
  const days = (expiry - now.getTime()) / 86_400_000;
  return days <= warningDays ? 'expiring' : 'ok';
}

export interface ExpiringBatch {
  id: string;
  name: string;
  batch_number: string | null;
  expiry_date: Date | string | null;
  quantity_on_hand: number;
}

/**
 * Batches worth telling someone about: expiring within the window, or already
 * expired and still holding stock. Zero-quantity batches are ignored — there is
 * nothing to pull off a shelf.
 */
export function expiringBatches<T extends ExpiringBatch>(
  batches: readonly T[],
  now = new Date(),
  warningDays = EXPIRY_WARNING_DAYS,
): Array<{ batch: T; band: Exclude<ExpiryBand, 'ok'>; days_remaining: number }> {
  return batches
    .filter((b) => b.quantity_on_hand > 0)
    .map((batch) => ({
      batch,
      band: expiryBand(batch.expiry_date, now, warningDays),
      days_remaining: batch.expiry_date
        ? Math.floor((new Date(batch.expiry_date).getTime() - now.getTime()) / 86_400_000)
        : Number.POSITIVE_INFINITY,
    }))
    .filter(
      (row): row is { batch: T; band: Exclude<ExpiryBand, 'ok'>; days_remaining: number } =>
        row.band !== 'ok',
    )
    .sort((a, b) => a.days_remaining - b.days_remaining);
}
