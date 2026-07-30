import {
  TREND_POINTS,
  buildTrends,
  flagTone,
  isAbnormal,
  sparklinePoints,
  type RawResult,
} from './result-trends';

const result = (over: Partial<RawResult> & { id: string; performed_at: string }): RawResult => ({
  loinc_code: '718-7',
  display: 'Haemoglobin',
  unit: 'g/dL',
  value_quantity: 13,
  value_string: null,
  reference_low: 12,
  reference_high: 15.5,
  interpretation: 'N',
  is_critical: false,
  ...over,
});

describe('buildTrends', () => {
  it('groups by LOINC and returns oldest-to-newest points', () => {
    const trends = buildTrends([
      result({ id: 'c', performed_at: '2026-07-30T09:00:00Z', value_quantity: 11 }),
      result({ id: 'a', performed_at: '2026-07-28T09:00:00Z', value_quantity: 13 }),
      result({ id: 'b', performed_at: '2026-07-29T09:00:00Z', value_quantity: 12 }),
    ]);

    expect(trends).toHaveLength(1);
    expect(trends[0]!.points.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(trends[0]!.latest.id).toBe('c');
  });

  it('keeps only the most recent five values by default', () => {
    const rows = Array.from({ length: 9 }, (_, i) =>
      result({
        id: `r${i}`,
        performed_at: `2026-07-${String(10 + i).padStart(2, '0')}T09:00:00Z`,
        value_quantity: i,
      }),
    );
    const [trend] = buildTrends(rows);
    expect(TREND_POINTS).toBe(5);
    expect(trend!.points).toHaveLength(5);
    expect(trend!.points.map((p) => p.id)).toEqual(['r4', 'r5', 'r6', 'r7', 'r8']);
  });

  it('honours a custom window', () => {
    const rows = Array.from({ length: 4 }, (_, i) =>
      result({ id: `r${i}`, performed_at: `2026-07-1${i}T09:00:00Z`, value_quantity: i }),
    );
    expect(buildTrends(rows, 2)[0]!.points).toHaveLength(2);
  });

  it('separates two different tests', () => {
    const trends = buildTrends([
      result({ id: 'hb', performed_at: '2026-07-30T09:00:00Z' }),
      result({
        id: 'k',
        performed_at: '2026-07-30T10:00:00Z',
        loinc_code: '2823-3',
        display: 'Potassium',
      }),
    ]);
    expect(trends.map((t) => t.loinc_code)).toEqual(['2823-3', '718-7']);
  });

  it('reports the change since the previous value', () => {
    const [trend] = buildTrends([
      result({ id: 'a', performed_at: '2026-07-28T09:00:00Z', value_quantity: 13 }),
      result({ id: 'b', performed_at: '2026-07-30T09:00:00Z', value_quantity: 11.5 }),
    ]);
    expect(trend!.delta).toBe(-1.5);
    expect(trend!.direction).toBe('down');
  });

  it('reads an unchanged value as flat, not as no data', () => {
    const [trend] = buildTrends([
      result({ id: 'a', performed_at: '2026-07-28T09:00:00Z', value_quantity: 13 }),
      result({ id: 'b', performed_at: '2026-07-30T09:00:00Z', value_quantity: 13 }),
    ]);
    expect(trend!.delta).toBe(0);
    expect(trend!.direction).toBe('flat');
  });

  it('has no delta on a single result', () => {
    const [trend] = buildTrends([result({ id: 'a', performed_at: '2026-07-30T09:00:00Z' })]);
    expect(trend!.delta).toBeNull();
    expect(trend!.direction).toBeNull();
  });

  it('skips a non-numeric result when looking for the previous value', () => {
    const [trend] = buildTrends([
      result({ id: 'a', performed_at: '2026-07-28T09:00:00Z', value_quantity: 10 }),
      result({
        id: 'b',
        performed_at: '2026-07-29T09:00:00Z',
        value_quantity: null,
        value_string: 'haemolysed',
      }),
      result({ id: 'c', performed_at: '2026-07-30T09:00:00Z', value_quantity: 12 }),
    ]);
    expect(trend!.delta).toBe(2);
  });

  it('flags the trend when any value in the window was critical', () => {
    const [trend] = buildTrends([
      result({ id: 'a', performed_at: '2026-07-28T09:00:00Z', value_quantity: 6, is_critical: true }),
      result({ id: 'b', performed_at: '2026-07-30T09:00:00Z', value_quantity: 13 }),
    ]);
    expect(trend!.latest.is_critical).toBe(false);
    expect(trend!.has_critical).toBe(true);
  });

  it('coerces decimal columns arriving as strings', () => {
    const [trend] = buildTrends([
      result({
        id: 'a',
        performed_at: '2026-07-30T09:00:00Z',
        value_quantity: '13.4000',
        reference_low: '12.0000',
        reference_high: '15.5000',
      }),
    ]);
    expect(trend!.latest.value).toBe(13.4);
    expect(trend!.reference_low).toBe(12);
    expect(trend!.reference_high).toBe(15.5);
  });

  it('orders tests by how recently each was resulted', () => {
    const trends = buildTrends([
      result({ id: 'old', performed_at: '2026-07-01T09:00:00Z' }),
      result({
        id: 'new',
        performed_at: '2026-07-30T09:00:00Z',
        loinc_code: '2345-7',
        display: 'Glucose',
      }),
    ]);
    expect(trends[0]!.display).toBe('Glucose');
  });

  it('returns nothing for no results', () => {
    expect(buildTrends([])).toEqual([]);
  });
});

describe('sparklinePoints', () => {
  it('scales a rising series across the box', () => {
    const points = sparklinePoints([
      { id: 'a', performed_at: '', value: 10, value_string: null, unit: null, interpretation: null, is_critical: false },
      { id: 'b', performed_at: '', value: 20, value_string: null, unit: null, interpretation: null, is_critical: false },
      { id: 'c', performed_at: '', value: 30, value_string: null, unit: null, interpretation: null, is_critical: false },
    ]);
    // y is inverted: the highest value sits at the top of the box.
    expect(points).toEqual([
      { x: 0, y: 100 },
      { x: 50, y: 50 },
      { x: 100, y: 0 },
    ]);
  });

  it('draws a flat series on the mid-line, not on the floor', () => {
    const flat = sparklinePoints([
      { id: 'a', performed_at: '', value: 5, value_string: null, unit: null, interpretation: null, is_critical: false },
      { id: 'b', performed_at: '', value: 5, value_string: null, unit: null, interpretation: null, is_critical: false },
    ]);
    expect(flat.every((p) => p.y === 50)).toBe(true);
  });

  it('places a lone point in the middle', () => {
    const one = sparklinePoints([
      { id: 'a', performed_at: '', value: 7, value_string: null, unit: null, interpretation: null, is_critical: false },
    ]);
    expect(one).toEqual([{ x: 0, y: 50 }]);
  });

  it('draws nothing when no value is numeric', () => {
    expect(
      sparklinePoints([
        { id: 'a', performed_at: '', value: null, value_string: 'clotted', unit: null, interpretation: null, is_critical: false },
      ]),
    ).toEqual([]);
  });
});

describe('flags', () => {
  it('treats every out-of-range code as abnormal', () => {
    for (const code of ['L', 'H', 'LL', 'HH']) expect(isAbnormal(code)).toBe(true);
  });

  it('treats normal and unknown as not abnormal', () => {
    expect(isAbnormal('N')).toBe(false);
    expect(isAbnormal(null)).toBe(false);
  });

  it('maps codes to the tone a clinician reads', () => {
    expect(flagTone('HH')).toBe('critical');
    expect(flagTone('LL')).toBe('critical');
    expect(flagTone('H')).toBe('high');
    expect(flagTone('L')).toBe('low');
    expect(flagTone('N')).toBe('normal');
    expect(flagTone(null)).toBe('normal');
  });
});
