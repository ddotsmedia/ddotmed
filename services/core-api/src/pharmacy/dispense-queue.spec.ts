import {
  ESCALATE_AFTER_MINUTES,
  EXPIRY_WARNING_DAYS,
  QUEUE_RANK,
  crossedReorderLevel,
  expiringBatches,
  expiryBand,
  isBelowReorderLevel,
  queuePriority,
  sortQueue,
} from './dispense-queue';

const NOW = new Date('2026-07-31T10:00:00Z');
const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);

const candidate = (over: Partial<Parameters<typeof queuePriority>[0]> = {}) => ({
  id: 'm1',
  created_at: minutesAgo(5),
  is_controlled: false,
  is_prn: false,
  ...over,
});

describe('queuePriority', () => {
  it('puts an emergency encounter above everything else', () => {
    const entry = queuePriority(candidate({ encounter_class: 'EMER' }), NOW);
    expect(entry.priority).toBe('urgent');
    expect(entry.reason).toMatch(/Emergency/);
  });

  it('treats an acute encounter as urgent too', () => {
    expect(queuePriority(candidate({ encounter_class: 'ACUTE' }), NOW).priority).toBe('urgent');
  });

  it('raises a controlled drug, which needs a second person', () => {
    const entry = queuePriority(candidate({ is_controlled: true }), NOW);
    expect(entry.priority).toBe('high');
    expect(entry.reason).toMatch(/witness/);
  });

  it('raises a high-alert medication', () => {
    expect(queuePriority(candidate({ is_high_alert: true }), NOW).priority).toBe('high');
  });

  it('escalates anything that has waited too long', () => {
    const entry = queuePriority(candidate({ created_at: minutesAgo(ESCALATE_AFTER_MINUTES) }), NOW);
    expect(entry.priority).toBe('high');
    expect(entry.reason).toMatch(/Waiting 45 minutes/);
  });

  it('leaves a fresh routine prescription routine', () => {
    const entry = queuePriority(candidate(), NOW);
    expect(entry.priority).toBe('routine');
    expect(entry.waiting_minutes).toBe(5);
  });

  it('never lets a when-required order jump the queue', () => {
    const entry = queuePriority(candidate({ is_prn: true }), NOW);
    expect(entry.priority).toBe('routine');
    expect(entry.reason).toBe('When required');
  });

  it('reads a waiting time of zero rather than a negative one for a future timestamp', () => {
    expect(queuePriority(candidate({ created_at: new Date(NOW.getTime() + 60_000) }), NOW)
      .waiting_minutes).toBe(0);
  });

  it('ranks the three bands in order', () => {
    expect(QUEUE_RANK.urgent).toBeLessThan(QUEUE_RANK.high);
    expect(QUEUE_RANK.high).toBeLessThan(QUEUE_RANK.routine);
  });
});

describe('sortQueue', () => {
  it('orders by band, then by the longest wait inside a band', () => {
    const sorted = sortQueue(
      [
        candidate({ id: 'routine-new', created_at: minutesAgo(1) }),
        candidate({ id: 'controlled', is_controlled: true, created_at: minutesAgo(2) }),
        candidate({ id: 'emergency', encounter_class: 'EMER', created_at: minutesAgo(1) }),
        candidate({ id: 'routine-old', created_at: minutesAgo(20) }),
        candidate({ id: 'high-alert', is_high_alert: true, created_at: minutesAgo(30) }),
      ],
      NOW,
    );

    expect(sorted.map((e) => e.item.id)).toEqual([
      'emergency',
      'high-alert',
      'controlled',
      'routine-old',
      'routine-new',
    ]);
  });

  it('does not mutate the input', () => {
    const input = [candidate({ id: 'a' }), candidate({ id: 'b', encounter_class: 'EMER' })];
    sortQueue(input, NOW);
    expect(input[0]!.id).toBe('a');
  });

  it('returns an empty queue unchanged', () => {
    expect(sortQueue([], NOW)).toEqual([]);
  });
});

describe('reorder thresholds', () => {
  it('is below the level once on-hand drops under it', () => {
    expect(isBelowReorderLevel({ quantity_on_hand: 9, reorder_level: 10 })).toBe(true);
    expect(isBelowReorderLevel({ quantity_on_hand: 10, reorder_level: 10 })).toBe(false);
  });

  it('treats a level of zero as not tracked, not as always low', () => {
    expect(isBelowReorderLevel({ quantity_on_hand: 0, reorder_level: 0 })).toBe(false);
  });

  it('fires only on the dispense that crossed the line', () => {
    expect(crossedReorderLevel(12, 8, 10)).toBe(true);
    // Already below before this dispense — the alert has been raised once already.
    expect(crossedReorderLevel(9, 5, 10)).toBe(false);
    expect(crossedReorderLevel(20, 15, 10)).toBe(false);
  });

  it('never fires when reordering is not tracked', () => {
    expect(crossedReorderLevel(100, 0, 0)).toBe(false);
  });

  it('fires when a dispense empties the shelf exactly to the boundary', () => {
    expect(crossedReorderLevel(10, 9, 10)).toBe(true);
  });
});

describe('expiryBand', () => {
  it('calls a past date expired', () => {
    expect(expiryBand('2026-07-30T00:00:00Z', NOW)).toBe('expired');
  });

  it('calls anything inside the window expiring', () => {
    expect(expiryBand('2026-08-20T00:00:00Z', NOW)).toBe('expiring');
    expect(EXPIRY_WARNING_DAYS).toBe(30);
  });

  it('calls anything beyond the window fine', () => {
    expect(expiryBand('2027-01-01T00:00:00Z', NOW)).toBe('ok');
  });

  it('treats a batch with no expiry as fine rather than as expired', () => {
    expect(expiryBand(null, NOW)).toBe('ok');
    expect(expiryBand(undefined, NOW)).toBe('ok');
  });
});

describe('expiringBatches', () => {
  const batch = (over: Record<string, unknown>) => ({
    id: 'b1',
    name: 'Amoxicillin 500mg',
    batch_number: 'A1',
    expiry_date: '2026-08-10T00:00:00Z',
    quantity_on_hand: 40,
    ...over,
  });

  it('returns only what is expiring or already expired', () => {
    const rows = expiringBatches(
      [
        batch({ id: 'soon', expiry_date: '2026-08-10T00:00:00Z' }),
        batch({ id: 'later', expiry_date: '2027-01-01T00:00:00Z' }),
        batch({ id: 'gone', expiry_date: '2026-07-01T00:00:00Z' }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.batch.id)).toEqual(['gone', 'soon']);
  });

  it('ignores a batch with nothing left on the shelf', () => {
    expect(expiringBatches([batch({ quantity_on_hand: 0 })], NOW)).toEqual([]);
  });

  it('orders soonest first, with already-expired ahead of everything', () => {
    const rows = expiringBatches(
      [
        batch({ id: 'd25', expiry_date: '2026-08-25T00:00:00Z' }),
        batch({ id: 'd05', expiry_date: '2026-08-05T00:00:00Z' }),
        batch({ id: 'past', expiry_date: '2026-06-30T00:00:00Z' }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.batch.id)).toEqual(['past', 'd05', 'd25']);
    expect(rows[0]!.band).toBe('expired');
    expect(rows[0]!.days_remaining).toBeLessThan(0);
  });

  it('honours a custom warning window', () => {
    const rows = expiringBatches([batch({ expiry_date: '2026-08-25T00:00:00Z' })], NOW, 7);
    expect(rows).toEqual([]);
  });

  it('skips a batch with no expiry date at all', () => {
    expect(expiringBatches([batch({ expiry_date: null })], NOW)).toEqual([]);
  });
});
