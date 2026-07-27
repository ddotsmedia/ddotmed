/**
 * Walk-in queue tokens.
 *
 * Tokens are per queue, per day. They are the only identifier a walk-in patient
 * holds before registration completes, so they must be short enough to call
 * across a waiting room and unambiguous when read aloud.
 */

/** Letters that survive being called out and read off a screen. */
const PREFIX_FALLBACK = 'Q';

export interface TokenInput {
  queueName: string;
  /** Highest sequence already issued for this queue today; 0 when none. */
  lastSequence: number;
  /** Higher priority is called before lower, regardless of sequence. */
  priority?: number;
}

export interface IssuedToken {
  token: string;
  sequence: number;
  priority: number;
}

/**
 * Derives the display prefix from the queue name: "general" → G, "ent" → E.
 * Non-alphabetic queue names fall back to Q rather than producing a digit or
 * symbol that would be confusing when announced.
 */
export function tokenPrefix(queueName: string): string {
  const first = queueName.trim().charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : PREFIX_FALLBACK;
}

/**
 * Issues the next token in a queue. Pure: the caller is responsible for reading
 * `lastSequence` and persisting the result inside one transaction, which is what
 * actually prevents two terminals minting the same number.
 */
export function issueToken(input: TokenInput): IssuedToken {
  const sequence = Math.max(0, Math.floor(input.lastSequence)) + 1;
  return {
    token: `${tokenPrefix(input.queueName)}${String(sequence).padStart(3, '0')}`,
    sequence,
    priority: input.priority ?? 0,
  };
}

export interface QueueEntry {
  id: string;
  token: string;
  sequence: number;
  priority: number;
  status: string;
  called_at: Date | null;
}

/**
 * Call order: higher priority first, then arrival order. Priority exists so a
 * triage nurse can move an unwell walk-in ahead without renumbering the queue.
 */
export function callOrder(entries: QueueEntry[]): QueueEntry[] {
  return [...entries]
    .filter((entry) => entry.status === 'waiting')
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      return a.sequence - b.sequence;
    });
}

/**
 * Estimated wait for a position in the queue. Deliberately coarse: an estimate
 * that looks precise invites complaints when it slips, so it is rounded to five
 * minutes and floored at zero.
 */
export function estimateWaitMinutes(
  positionInQueue: number,
  averageConsultMinutes: number,
  activeCounters: number,
): number {
  if (positionInQueue <= 0) return 0;
  const counters = Math.max(1, activeCounters);
  const raw = (positionInQueue / counters) * averageConsultMinutes;
  return Math.max(0, Math.round(raw / 5) * 5);
}

/** Splits a queue into what is being served now and what is still waiting. */
export function queueSnapshot(entries: QueueEntry[]): {
  nowServing: QueueEntry[];
  waiting: QueueEntry[];
  waitingCount: number;
} {
  const nowServing = entries
    .filter((e) => e.status === 'called')
    .sort((a, b) => (b.called_at?.getTime() ?? 0) - (a.called_at?.getTime() ?? 0));
  const waiting = callOrder(entries);
  return { nowServing, waiting, waitingCount: waiting.length };
}
