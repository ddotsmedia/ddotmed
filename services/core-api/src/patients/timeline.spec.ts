import { filterTimeline, groupByDay, sortTimeline, type TimelineEntry } from './timeline';

// `at` is overridden as an ISO string for readability, so it must be omitted from
// the Partial or the intersection collapses to `Date & string`.
const entry = (
  over: Omit<Partial<TimelineEntry>, 'at'> & { id: string; at: string },
): TimelineEntry => ({
  type: 'note',
  title: 'Note',
  detail: null,
  severity: 'normal',
  encounter_id: null,
  data: {},
  ...over,
  at: new Date(over.at),
});

describe('sortTimeline', () => {
  it('orders newest first', () => {
    const sorted = sortTimeline([
      entry({ id: 'old', at: '2026-01-01T10:00:00Z' }),
      entry({ id: 'new', at: '2026-07-01T10:00:00Z' }),
      entry({ id: 'mid', at: '2026-04-01T10:00:00Z' }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
  });

  it('does not mutate the input array', () => {
    const input = [
      entry({ id: 'a', at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'b', at: '2026-02-01T00:00:00Z' }),
    ];
    sortTimeline(input);
    expect(input.map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('breaks a same-instant tie by type then id, so pagination never repeats', () => {
    const at = '2026-05-05T08:00:00Z';
    const first = sortTimeline([
      entry({ id: 'z', at, type: 'vitals' }),
      entry({ id: 'a', at, type: 'lab' }),
      entry({ id: 'b', at, type: 'lab' }),
    ]);
    expect(first.map((e) => `${e.type}:${e.id}`)).toEqual(['lab:a', 'lab:b', 'vitals:z']);

    // Same input in a different order must produce the same output.
    const second = sortTimeline([
      entry({ id: 'b', at, type: 'lab' }),
      entry({ id: 'z', at, type: 'vitals' }),
      entry({ id: 'a', at, type: 'lab' }),
    ]);
    expect(second.map((e) => e.id)).toEqual(first.map((e) => e.id));
  });

  it('handles an empty timeline', () => {
    expect(sortTimeline([])).toEqual([]);
  });

  it('interleaves events from different clinical domains by time alone', () => {
    const sorted = sortTimeline([
      entry({ id: 'lab', at: '2026-03-02T09:00:00Z', type: 'lab' }),
      entry({ id: 'enc', at: '2026-03-03T09:00:00Z', type: 'encounter' }),
      entry({ id: 'med', at: '2026-03-01T09:00:00Z', type: 'medication' }),
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['enc', 'lab', 'med']);
  });
});

describe('groupByDay', () => {
  it('groups a sorted timeline into calendar days, preserving order', () => {
    const groups = groupByDay(
      sortTimeline([
        entry({ id: 'a', at: '2026-07-01T08:00:00Z' }),
        entry({ id: 'b', at: '2026-07-01T18:00:00Z' }),
        entry({ id: 'c', at: '2026-06-30T12:00:00Z' }),
      ]),
    );
    expect(groups.map((g) => g.day)).toEqual(['2026-07-01', '2026-06-30']);
    expect(groups[0]!.entries.map((e) => e.id)).toEqual(['b', 'a']);
    expect(groups[1]!.entries).toHaveLength(1);
  });

  it('returns nothing for an empty timeline', () => {
    expect(groupByDay([])).toEqual([]);
  });
});

describe('filterTimeline', () => {
  const entries = [
    entry({ id: 'lab', at: '2026-07-01T00:00:00Z', type: 'lab' }),
    entry({ id: 'med', at: '2026-06-01T00:00:00Z', type: 'medication' }),
    entry({ id: 'enc', at: '2026-05-01T00:00:00Z', type: 'encounter' }),
  ];

  it('filters by type', () => {
    expect(filterTimeline(entries, { types: ['lab', 'encounter'] }).map((e) => e.id)).toEqual([
      'lab',
      'enc',
    ]);
  });

  it('treats an empty type list as no filter', () => {
    expect(filterTimeline(entries, { types: [] })).toHaveLength(3);
  });

  it('filters by date range inclusively', () => {
    const filtered = filterTimeline(entries, {
      from: new Date('2026-06-01T00:00:00Z'),
      to: new Date('2026-07-01T00:00:00Z'),
    });
    expect(filtered.map((e) => e.id)).toEqual(['lab', 'med']);
  });

  it('combines type and range filters', () => {
    const filtered = filterTimeline(entries, {
      types: ['lab'],
      from: new Date('2026-06-15T00:00:00Z'),
    });
    expect(filtered.map((e) => e.id)).toEqual(['lab']);
  });
});
