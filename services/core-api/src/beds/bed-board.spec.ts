import {
  HOUSEKEEPING_FLOW,
  admissionBlocker,
  bedTone,
  canCleanTransition,
  eddStatus,
  isAdmittable,
  lengthOfStayDays,
  summariseWard,
  type BedState,
} from './bed-board';

const bed = (over: Partial<BedState & { isolation_flag: boolean; ward: string }> = {}) => ({
  status: 'available' as const,
  housekeeping_status: 'clean' as const,
  ward: 'A',
  ...over,
});

describe('housekeeping state machine', () => {
  it('walks dirty → in progress → clean', () => {
    expect(canCleanTransition('dirty', 'in_progress')).toBe(true);
    expect(canCleanTransition('in_progress', 'clean')).toBe(true);
  });

  it('refuses to jump straight from dirty to clean', () => {
    expect(canCleanTransition('dirty', 'clean')).toBe(false);
  });

  it('lets a clean bed be soiled again', () => {
    expect(canCleanTransition('clean', 'dirty')).toBe(true);
  });

  it('lets a cleaner hand a bed back as still dirty', () => {
    expect(canCleanTransition('in_progress', 'dirty')).toBe(true);
  });

  it('refuses to start cleaning a bed that is already clean', () => {
    expect(canCleanTransition('clean', 'in_progress')).toBe(false);
  });

  it('covers every state in the flow table', () => {
    expect(Object.keys(HOUSEKEEPING_FLOW).sort()).toEqual(['clean', 'dirty', 'in_progress']);
  });
});

describe('isAdmittable', () => {
  it('accepts a free, clean bed', () => {
    expect(isAdmittable(bed())).toBe(true);
    expect(isAdmittable(bed({ status: 'reserved' }))).toBe(true);
  });

  it('refuses an occupied bed however clean it is', () => {
    expect(isAdmittable(bed({ status: 'occupied' }))).toBe(false);
  });

  it('refuses a free bed that has not been turned around', () => {
    expect(isAdmittable(bed({ housekeeping_status: 'dirty' }))).toBe(false);
    expect(isAdmittable(bed({ housekeeping_status: 'in_progress' }))).toBe(false);
  });

  it('refuses a blocked or out-of-service bed', () => {
    expect(isAdmittable(bed({ status: 'blocked' }))).toBe(false);
    expect(isAdmittable(bed({ status: 'maintenance' }))).toBe(false);
  });
});

describe('admissionBlocker', () => {
  it('says nothing about a bed that can take a patient', () => {
    expect(admissionBlocker(bed())).toBeNull();
  });

  it('names the status when the bed is not free', () => {
    expect(admissionBlocker(bed({ status: 'occupied' }))).toBe('The bed is occupied');
  });

  it('distinguishes not-yet-cleaned from being-cleaned', () => {
    expect(admissionBlocker(bed({ housekeeping_status: 'dirty' }))).toMatch(/not been cleaned/);
    expect(admissionBlocker(bed({ housekeeping_status: 'in_progress' }))).toMatch(/being cleaned/);
  });
});

describe('bedTone', () => {
  it('shows isolation above everything else', () => {
    expect(bedTone(bed({ isolation_flag: true }))).toBe('isolation');
    expect(bedTone(bed({ status: 'occupied', isolation_flag: true }))).toBe('isolation');
  });

  it('colours a free clean bed available and an occupied one occupied', () => {
    expect(bedTone(bed())).toBe('available');
    expect(bedTone(bed({ status: 'occupied' }))).toBe('occupied');
  });

  it('colours anything awaiting a clean dirty', () => {
    expect(bedTone(bed({ housekeeping_status: 'dirty' }))).toBe('dirty');
    expect(bedTone(bed({ status: 'cleaning' }))).toBe('dirty');
  });

  it('colours a blocked or out-of-service bed apart from a dirty one', () => {
    expect(bedTone(bed({ status: 'blocked' }))).toBe('blocked');
    expect(bedTone(bed({ status: 'maintenance' }))).toBe('blocked');
  });
});

describe('lengthOfStayDays', () => {
  it('counts calendar days, not elapsed hours', () => {
    // Admitted late on day one, still in early on day two: that is two days on a ward.
    expect(lengthOfStayDays('2026-08-01T23:00:00Z', '2026-08-02T01:00:00Z')).toBe(1);
  });

  it('reads a same-day admission as zero', () => {
    expect(lengthOfStayDays('2026-08-01T08:00:00Z', '2026-08-01T20:00:00Z')).toBe(0);
  });

  it('counts a week correctly', () => {
    expect(lengthOfStayDays('2026-08-01T08:00:00Z', '2026-08-08T09:00:00Z')).toBe(7);
  });

  it('never returns a negative stay', () => {
    expect(lengthOfStayDays('2026-08-10T00:00:00Z', '2026-08-01T00:00:00Z')).toBe(0);
  });
});

describe('eddStatus', () => {
  const now = '2026-08-05T12:00:00Z';

  it('reports days remaining before the date', () => {
    const status = eddStatus('2026-08-08T00:00:00Z', now);
    expect(status.days_remaining).toBe(3);
    expect(status.overdue).toBe(false);
    expect(status.days_overdue).toBe(0);
  });

  it('is not overdue on the day itself — the day is not over', () => {
    const status = eddStatus('2026-08-05T09:00:00Z', now);
    expect(status.days_remaining).toBe(0);
    expect(status.overdue).toBe(false);
  });

  it('flags overdue once the date has passed', () => {
    const status = eddStatus('2026-08-02T00:00:00Z', now);
    expect(status.overdue).toBe(true);
    expect(status.days_overdue).toBe(3);
    expect(status.days_remaining).toBe(-3);
  });

  it('says nothing when no discharge date was planned', () => {
    expect(eddStatus(null, now)).toEqual({
      expected_discharge_at: null,
      days_remaining: null,
      overdue: false,
      days_overdue: 0,
    });
  });

  it('normalises the date it echoes back', () => {
    expect(eddStatus('2026-08-08T00:00:00Z', now).expected_discharge_at).toBe(
      '2026-08-08T00:00:00.000Z',
    );
  });
});

describe('summariseWard', () => {
  it('counts occupancy, availability, dirty and isolation separately', () => {
    const summary = summariseWard('A', [
      bed({ status: 'occupied' }),
      bed({ status: 'occupied', isolation_flag: true }),
      bed(),
      bed({ housekeeping_status: 'dirty', status: 'cleaning' }),
    ]);

    expect(summary).toEqual({
      ward: 'A',
      total: 4,
      occupied: 2,
      available: 1,
      dirty: 1,
      isolation: 1,
      occupancy_pct: 50,
    });
  });

  it('does not divide by zero on an empty ward', () => {
    expect(summariseWard('B', []).occupancy_pct).toBe(0);
  });

  it('does not count a dirty bed as available', () => {
    const summary = summariseWard('C', [bed({ housekeeping_status: 'dirty' })]);
    expect(summary.available).toBe(0);
    expect(summary.dirty).toBe(1);
  });
});
