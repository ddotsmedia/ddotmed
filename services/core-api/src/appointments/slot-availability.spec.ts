import {
  availableSlots,
  dayBounds,
  groupSlotsByPartOfDay,
  hasConflict,
  SLOT_HOLDING_STATUSES,
  type ClaimingAppointment,
  type RawSlot,
} from './slot-availability';

const NOW = new Date('2026-07-27T08:00:00Z');

// `start` is overridden as an ISO string for readability, so it must be omitted
// from the Partial or the intersection collapses to `Date & string`.
const slot = (over: Omit<Partial<RawSlot>, 'start'> & { id: string; start: string }): RawSlot => ({
  end: new Date(new Date(over.start).getTime() + 15 * 60_000),
  status: 'free',
  overbooked: false,
  schedule_id: 'sch1',
  ...over,
  start: new Date(over.start),
});

const claim = (
  over: Omit<Partial<ClaimingAppointment>, 'start'> & { start: string },
): ClaimingAppointment => ({
  slot_id: null,
  end: new Date(new Date(over.start).getTime() + 15 * 60_000),
  status: 'booked',
  ...over,
  start: new Date(over.start),
});

describe('availableSlots', () => {
  it('returns free future slots in chronological order', () => {
    const result = availableSlots(
      [
        slot({ id: 'later', start: '2026-07-27T11:00:00Z' }),
        slot({ id: 'earlier', start: '2026-07-27T09:00:00Z' }),
      ],
      [],
      { now: NOW },
    );
    expect(result.map((s) => s.id)).toEqual(['earlier', 'later']);
  });

  it('excludes slots that are not free', () => {
    const result = availableSlots(
      [
        slot({ id: 'busy', start: '2026-07-27T09:00:00Z', status: 'busy' }),
        slot({ id: 'free', start: '2026-07-27T10:00:00Z' }),
      ],
      [],
      { now: NOW },
    );
    expect(result.map((s) => s.id)).toEqual(['free']);
  });

  it('excludes slots already in the past', () => {
    const result = availableSlots(
      [
        slot({ id: 'past', start: '2026-07-27T07:00:00Z' }),
        slot({ id: 'future', start: '2026-07-27T09:00:00Z' }),
      ],
      [],
      { now: NOW },
    );
    expect(result.map((s) => s.id)).toEqual(['future']);
  });

  it('honours a minimum lead time', () => {
    const result = availableSlots(
      [
        slot({ id: 'tooSoon', start: '2026-07-27T08:15:00Z' }),
        slot({ id: 'ok', start: '2026-07-27T10:00:00Z' }),
      ],
      [],
      { now: NOW, minLeadMinutes: 60 },
    );
    expect(result.map((s) => s.id)).toEqual(['ok']);
  });

  it('excludes a slot already claimed by a live appointment', () => {
    const result = availableSlots(
      [slot({ id: 's1', start: '2026-07-27T09:00:00Z' })],
      [claim({ slot_id: 's1', start: '2026-07-27T09:00:00Z', status: 'booked' })],
      { now: NOW },
    );
    expect(result).toHaveLength(0);
  });

  it('re-offers a slot whose appointment was cancelled or marked no-show', () => {
    for (const status of ['cancelled', 'noshow']) {
      const result = availableSlots(
        [slot({ id: 's1', start: '2026-07-27T09:00:00Z' })],
        [claim({ slot_id: 's1', start: '2026-07-27T09:00:00Z', status })],
        { now: NOW },
      );
      expect(result).toHaveLength(1);
    }
  });

  it('treats every slot-holding status as a claim', () => {
    for (const status of SLOT_HOLDING_STATUSES) {
      const result = availableSlots(
        [slot({ id: 's1', start: '2026-07-27T09:00:00Z' })],
        [claim({ slot_id: 's1', start: '2026-07-27T09:00:00Z', status })],
        { now: NOW },
      );
      expect(result).toHaveLength(0);
    }
  });

  it('still offers an overbooked slot, flagged, even when claimed', () => {
    const result = availableSlots(
      [slot({ id: 's1', start: '2026-07-27T09:00:00Z', overbooked: true })],
      [claim({ slot_id: 's1', start: '2026-07-27T09:00:00Z' })],
      { now: NOW },
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.overbooked).toBe(true);
  });

  it('reports slot length in minutes', () => {
    const result = availableSlots(
      [
        {
          id: 's1',
          start: new Date('2026-07-27T09:00:00Z'),
          end: new Date('2026-07-27T09:30:00Z'),
          status: 'free',
          overbooked: false,
          schedule_id: 'sch1',
        },
      ],
      [],
      { now: NOW },
    );
    expect(result[0]!.minutes).toBe(30);
  });

  it('returns nothing when there are no slots', () => {
    expect(availableSlots([], [], { now: NOW })).toEqual([]);
  });
});

describe('hasConflict', () => {
  const start = new Date('2026-07-27T09:00:00Z');
  const end = new Date('2026-07-27T09:30:00Z');

  it('detects an exact overlap', () => {
    expect(hasConflict(start, end, [claim({ start: '2026-07-27T09:00:00Z' })])).toBe(true);
  });

  it('detects a partial overlap on either side', () => {
    expect(
      hasConflict(start, end, [
        { slot_id: null, start: new Date('2026-07-27T08:45:00Z'), end: new Date('2026-07-27T09:15:00Z'), status: 'booked' },
      ]),
    ).toBe(true);
    expect(
      hasConflict(start, end, [
        { slot_id: null, start: new Date('2026-07-27T09:15:00Z'), end: new Date('2026-07-27T09:45:00Z'), status: 'booked' },
      ]),
    ).toBe(true);
  });

  it('treats touching boundaries as back-to-back, not a clash', () => {
    expect(
      hasConflict(start, end, [
        { slot_id: null, start: new Date('2026-07-27T08:30:00Z'), end: new Date('2026-07-27T09:00:00Z'), status: 'booked' },
      ]),
    ).toBe(false);
    expect(
      hasConflict(start, end, [
        { slot_id: null, start: new Date('2026-07-27T09:30:00Z'), end: new Date('2026-07-27T10:00:00Z'), status: 'booked' },
      ]),
    ).toBe(false);
  });

  it('ignores cancelled appointments', () => {
    expect(
      hasConflict(start, end, [claim({ start: '2026-07-27T09:00:00Z', status: 'cancelled' })]),
    ).toBe(false);
  });

  it('is false against an empty diary', () => {
    expect(hasConflict(start, end, [])).toBe(false);
  });
});

describe('groupSlotsByPartOfDay', () => {
  it('buckets by morning, afternoon and evening and drops empty groups', () => {
    const slots = availableSlots(
      [
        slot({ id: 'am', start: '2026-07-27T09:00:00Z' }),
        slot({ id: 'pm', start: '2026-07-27T14:00:00Z' }),
        slot({ id: 'eve', start: '2026-07-27T18:00:00Z' }),
      ],
      [],
      { now: NOW },
    );
    const groups = groupSlotsByPartOfDay(slots);
    expect(groups.map((g) => g.period)).toEqual(['morning', 'afternoon', 'evening']);

    const morningOnly = groupSlotsByPartOfDay(
      availableSlots([slot({ id: 'am', start: '2026-07-27T09:00:00Z' })], [], { now: NOW }),
    );
    expect(morningOnly.map((g) => g.period)).toEqual(['morning']);
  });
});

describe('dayBounds', () => {
  it('spans the whole UTC day inclusively', () => {
    const { from, to } = dayBounds('2026-07-27');
    expect(from.toISOString()).toBe('2026-07-27T00:00:00.000Z');
    expect(to.toISOString()).toBe('2026-07-27T23:59:59.999Z');
  });
});
