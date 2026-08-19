import {
  alosByWard,
  averageLengthOfStay,
  averageTurnaroundMinutes,
  averageWaitMinutes,
  bedTurnoverRate,
  bpToPct,
  dailyTrend,
  dischargeDelayCount,
  lastNDays,
  mean,
  meanRounded,
  percent,
  ratioBp,
  readmissionRate30d,
  revenueByDepartment,
  startOfDay,
  startOfMonth,
  stayDays,
  topDiagnoses,
} from './analytics-metrics';

const NOW = new Date('2026-08-19T14:30:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe('ratioBp and percent', () => {
  it('carries a ratio as basis points', () => {
    expect(ratioBp(1, 4)).toBe(2_500);
    expect(ratioBp(1, 3)).toBe(3_333);
  });

  it('returns zero for an empty denominator rather than NaN', () => {
    expect(ratioBp(5, 0)).toBe(0);
    expect(percent(5, 0)).toBe(0);
  });

  it('renders basis points as a one-decimal percentage', () => {
    expect(bpToPct(3_333)).toBe(33.3);
    expect(bpToPct(10_000)).toBe(100);
  });

  it('rounds a whole percent for a KPI tile', () => {
    expect(percent(37, 50)).toBe(74);
  });
});

describe('date windows', () => {
  it('takes midnight UTC as the start of the day', () => {
    expect(startOfDay(NOW).toISOString()).toBe('2026-08-19T00:00:00.000Z');
  });

  it('takes the first of the month, in UTC', () => {
    expect(startOfMonth(NOW).toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('spans whole days ending at the start of tomorrow', () => {
    const window = lastNDays(7, NOW);
    expect(window.to.toISOString()).toBe('2026-08-20T00:00:00.000Z');
    expect(window.from.toISOString()).toBe('2026-08-13T00:00:00.000Z');
  });
});

describe('mean', () => {
  it('is null for an empty list, not zero', () => {
    // Zero would read as "the average is zero", which is a different claim.
    expect(mean([])).toBeNull();
    expect(meanRounded([])).toBeNull();
  });

  it('rounds to one decimal by default', () => {
    expect(meanRounded([1, 2, 2])).toBe(1.7);
  });
});

describe('stayDays', () => {
  it('measures a stay in days to one decimal', () => {
    expect(stayDays('2026-08-01T08:00:00Z', '2026-08-04T20:00:00Z')).toBe(3.5);
  });

  it('reports a same-day stay as zero, not a whole day', () => {
    expect(stayDays('2026-08-01T08:00:00Z', '2026-08-01T11:00:00Z')).toBe(0.1);
  });

  it('clamps a discharge before the admission to zero', () => {
    expect(stayDays('2026-08-04T08:00:00Z', '2026-08-01T08:00:00Z')).toBe(0);
  });
});

describe('averageLengthOfStay', () => {
  const stays = [
    { patient_id: 'p1', admitted_at: daysAgo(10), discharged_at: daysAgo(6) },
    { patient_id: 'p2', admitted_at: daysAgo(8), discharged_at: daysAgo(6) },
  ];

  it('averages completed stays', () => {
    expect(averageLengthOfStay(stays)).toBe(3);
  });

  it('ignores patients who are still in a bed', () => {
    // Counting days-so-far would drag the average down exactly when occupancy rises.
    expect(
      averageLengthOfStay([...stays, { patient_id: 'p3', admitted_at: daysAgo(20), discharged_at: null }]),
    ).toBe(3);
  });

  it('is null when nobody has been discharged', () => {
    expect(
      averageLengthOfStay([{ patient_id: 'p1', admitted_at: daysAgo(2), discharged_at: null }]),
    ).toBeNull();
  });
});

describe('alosByWard', () => {
  it('splits by ward and sorts by the longest stay', () => {
    const rows = alosByWard([
      { patient_id: 'p1', admitted_at: daysAgo(10), discharged_at: daysAgo(8), ward: 'Ward A' },
      { patient_id: 'p2', admitted_at: daysAgo(10), discharged_at: daysAgo(4), ward: 'ICU' },
      { patient_id: 'p3', admitted_at: daysAgo(9), discharged_at: daysAgo(8), ward: 'Ward A' },
    ]);

    expect(rows.map((r) => r.ward)).toEqual(['ICU', 'Ward A']);
    expect(rows[0].alos_days).toBe(6);
    expect(rows[1]).toEqual({ ward: 'Ward A', discharges: 2, alos_days: 1.5 });
  });

  it('files a discharge with no bed under Unassigned rather than dropping it', () => {
    const rows = alosByWard([
      { patient_id: 'p1', admitted_at: daysAgo(4), discharged_at: daysAgo(2), ward: null },
    ]);
    expect(rows[0].ward).toBe('Unassigned');
  });
});

describe('readmissionRate30d', () => {
  it('counts a discharge whose patient comes back inside thirty days', () => {
    const rate = readmissionRate30d([
      { patient_id: 'p1', admitted_at: daysAgo(60), discharged_at: daysAgo(55) },
      { patient_id: 'p1', admitted_at: daysAgo(40), discharged_at: daysAgo(38) },
    ]);

    expect(rate.discharges).toBe(2);
    expect(rate.readmissions).toBe(1);
    expect(rate.rate_bp).toBe(5_000);
  });

  it('does not count a return after the window closes', () => {
    const rate = readmissionRate30d([
      { patient_id: 'p1', admitted_at: daysAgo(90), discharged_at: daysAgo(85) },
      { patient_id: 'p1', admitted_at: daysAgo(40), discharged_at: daysAgo(38) },
    ]);
    expect(rate.readmissions).toBe(0);
  });

  it('counts the index discharge, not the readmission, so a bouncer is not double-counted', () => {
    // Three stays: the first two discharges each have a return inside 30 days.
    const rate = readmissionRate30d([
      { patient_id: 'p1', admitted_at: daysAgo(60), discharged_at: daysAgo(58) },
      { patient_id: 'p1', admitted_at: daysAgo(50), discharged_at: daysAgo(48) },
      { patient_id: 'p1', admitted_at: daysAgo(40), discharged_at: daysAgo(38) },
    ]);

    expect(rate.discharges).toBe(3);
    expect(rate.readmissions).toBe(2);
  });

  it('never treats a different patient as a readmission', () => {
    const rate = readmissionRate30d([
      { patient_id: 'p1', admitted_at: daysAgo(40), discharged_at: daysAgo(38) },
      { patient_id: 'p2', admitted_at: daysAgo(30), discharged_at: daysAgo(28) },
    ]);
    expect(rate.readmissions).toBe(0);
  });

  it('keeps an open stay out of the denominator', () => {
    const rate = readmissionRate30d([
      { patient_id: 'p1', admitted_at: daysAgo(10), discharged_at: null },
    ]);
    expect(rate).toEqual({ discharges: 0, readmissions: 0, rate_bp: 0 });
  });
});

describe('averageTurnaroundMinutes', () => {
  it('averages completed pairs only', () => {
    expect(
      averageTurnaroundMinutes([
        { ordered_at: '2026-08-19T08:00:00Z', completed_at: '2026-08-19T09:00:00Z' },
        { ordered_at: '2026-08-19T08:00:00Z', completed_at: '2026-08-19T08:30:00Z' },
      ]),
    ).toBe(45);
  });

  it('excludes an order still outstanding instead of scoring it zero', () => {
    // Counting a backlog as instant turnaround would invert the metric.
    expect(
      averageTurnaroundMinutes([
        { ordered_at: '2026-08-19T08:00:00Z', completed_at: '2026-08-19T09:00:00Z' },
        { ordered_at: '2026-08-19T08:00:00Z', completed_at: null },
      ]),
    ).toBe(60);
  });

  it('is null when nothing has completed', () => {
    expect(averageTurnaroundMinutes([{ ordered_at: null, completed_at: null }])).toBeNull();
  });

  it('measures an outpatient wait from joining the queue to being called', () => {
    expect(
      averageWaitMinutes([
        { created_at: '2026-08-19T08:00:00Z', called_at: '2026-08-19T08:20:00Z' },
        { created_at: '2026-08-19T08:10:00Z', called_at: null },
      ]),
    ).toBe(20);
  });
});

describe('bedTurnoverRate', () => {
  it('reports discharges per bed for the period', () => {
    expect(bedTurnoverRate(45, 30)).toBe(1.5);
  });

  it('is zero when there are no beds', () => {
    expect(bedTurnoverRate(5, 0)).toBe(0);
  });
});

describe('dischargeDelayCount', () => {
  it('counts only stays that are overdue and still open', () => {
    expect(
      dischargeDelayCount(
        [
          { expected_discharge_at: daysAgo(2), discharged_at: null },
          { expected_discharge_at: daysAgo(2), discharged_at: daysAgo(1) },
          { expected_discharge_at: new Date(NOW.getTime() + 86_400_000), discharged_at: null },
          { expected_discharge_at: null, discharged_at: null },
        ],
        NOW,
      ),
    ).toBe(1);
  });
});

describe('revenueByDepartment', () => {
  it('groups by charge-master category, largest first', () => {
    const rows = revenueByDepartment([
      { category: 'Radiology', total_minor: 5_000 },
      { category: 'Pharmacy', total_minor: 12_000 },
      { category: 'Radiology', total_minor: 3_000 },
    ]);

    expect(rows).toEqual([
      { department: 'Pharmacy', line_count: 1, billed_minor: 12_000 },
      { department: 'Radiology', line_count: 2, billed_minor: 8_000 },
    ]);
  });

  it('reports an uncategorised line rather than dropping the money', () => {
    const rows = revenueByDepartment([{ category: null, total_minor: 900 }]);
    expect(rows).toEqual([{ department: 'Uncategorised', line_count: 1, billed_minor: 900 }]);
  });
});

describe('topDiagnoses', () => {
  it('sorts by frequency and caps the list', () => {
    const rows = topDiagnoses(
      [
        { code: 'E11', display: 'Type 2 diabetes', count: 4 },
        { code: 'I10', display: 'Hypertension', count: 9 },
        { code: 'J45', display: 'Asthma', count: 4 },
      ],
      2,
    );
    expect(rows.map((r) => r.code)).toEqual(['I10', 'E11']);
  });
});

describe('dailyTrend', () => {
  it('emits a point for every day in the window, including empty ones', () => {
    const points = dailyTrend([], [], 7, NOW);
    expect(points).toHaveLength(7);
    expect(points[0].date).toBe('2026-08-13');
    expect(points[6].date).toBe('2026-08-19');
    expect(points.every((p) => p.admissions === 0 && p.discharges === 0)).toBe(true);
  });

  it('lands each event on its own day', () => {
    const points = dailyTrend(
      [{ admitted_at: '2026-08-18T09:00:00Z' }, { admitted_at: '2026-08-18T22:00:00Z' }],
      [{ discharged_at: '2026-08-19T07:00:00Z' }],
      7,
      NOW,
    );

    expect(points.find((p) => p.date === '2026-08-18')).toEqual({
      date: '2026-08-18',
      admissions: 2,
      discharges: 0,
    });
    expect(points.find((p) => p.date === '2026-08-19')?.discharges).toBe(1);
  });

  it('ignores an event that falls outside the window', () => {
    const points = dailyTrend([{ admitted_at: '2026-07-01T09:00:00Z' }], [], 7, NOW);
    expect(points.reduce((sum, p) => sum + p.admissions, 0)).toBe(0);
  });
});
