import { calculateBmi, calculateEws, detectCriticalVitals } from './ews';

const normal = {
  respiratory_rate: 16,
  spo2: 98,
  supplemental_o2: false,
  temperature_c: 36.8,
  systolic_bp: 120,
  heart_rate: 72,
  consciousness: 'A' as const,
};

describe('calculateEws (NEWS2)', () => {
  it('scores a fully normal set as 0 / low risk', () => {
    const r = calculateEws(normal);
    expect(r.score).toBe(0);
    expect(r.risk).toBe('low');
    expect(r.hasRedScore).toBe(false);
    expect(r.missing).toHaveLength(0);
  });

  it('adds 2 for supplemental oxygen', () => {
    expect(calculateEws({ ...normal, supplemental_o2: true }).score).toBe(2);
  });

  it('scores each parameter band correctly', () => {
    expect(calculateEws({ ...normal, respiratory_rate: 22 }).components.respiratory_rate).toBe(2);
    expect(calculateEws({ ...normal, respiratory_rate: 10 }).components.respiratory_rate).toBe(1);
    expect(calculateEws({ ...normal, respiratory_rate: 26 }).components.respiratory_rate).toBe(3);
    expect(calculateEws({ ...normal, spo2: 93 }).components.spo2).toBe(2);
    expect(calculateEws({ ...normal, spo2: 90 }).components.spo2).toBe(3);
    expect(calculateEws({ ...normal, temperature_c: 35.5 }).components.temperature_c).toBe(1);
    expect(calculateEws({ ...normal, temperature_c: 39.5 }).components.temperature_c).toBe(2);
    expect(calculateEws({ ...normal, systolic_bp: 105 }).components.systolic_bp).toBe(1);
    expect(calculateEws({ ...normal, systolic_bp: 95 }).components.systolic_bp).toBe(2);
    expect(calculateEws({ ...normal, systolic_bp: 85 }).components.systolic_bp).toBe(3);
    expect(calculateEws({ ...normal, systolic_bp: 230 }).components.systolic_bp).toBe(3);
    expect(calculateEws({ ...normal, heart_rate: 120 }).components.heart_rate).toBe(2);
    expect(calculateEws({ ...normal, heart_rate: 45 }).components.heart_rate).toBe(1);
    expect(calculateEws({ ...normal, heart_rate: 135 }).components.heart_rate).toBe(3);
  });

  it('scores any non-alert consciousness level as 3', () => {
    for (const level of ['C', 'V', 'P', 'U'] as const) {
      expect(calculateEws({ ...normal, consciousness: level }).components.consciousness).toBe(3);
    }
  });

  it('escalates to medium on a single red score even when the total is low', () => {
    // SpO2 90 scores 3 on its own; aggregate is only 3.
    const r = calculateEws({ ...normal, spo2: 90 });
    expect(r.score).toBe(3);
    expect(r.hasRedScore).toBe(true);
    expect(r.risk).toBe('medium');
  });

  it('classifies aggregate 5-6 as medium and 7+ as high', () => {
    // RR 22 (2) + SpO2 93 (2) + HR 95 (1) = 5, no single 3.
    const medium = calculateEws({ ...normal, respiratory_rate: 22, spo2: 93, heart_rate: 95 });
    expect(medium.score).toBe(5);
    expect(medium.risk).toBe('medium');
    expect(medium.hasRedScore).toBe(false);

    // RR 26 (3) + SpO2 90 (3) + O2 (2) = 8.
    const high = calculateEws({
      ...normal,
      respiratory_rate: 26,
      spo2: 90,
      supplemental_o2: true,
    });
    expect(high.score).toBe(8);
    expect(high.risk).toBe('high');
  });

  it('reports missing parameters rather than silently scoring them zero', () => {
    const r = calculateEws({ respiratory_rate: 16, supplemental_o2: false });
    expect(r.missing).toEqual(
      expect.arrayContaining(['spo2', 'temperature_c', 'systolic_bp', 'heart_rate', 'consciousness']),
    );
    expect(r.components.respiratory_rate).toBe(0);
    expect(r.components.spo2).toBeUndefined();
  });

  it('gives an escalation instruction matched to the risk band', () => {
    expect(calculateEws(normal).response).toMatch(/12 hourly/);
    expect(calculateEws({ ...normal, spo2: 94 }).response).toMatch(/4-6 hourly/);
    expect(calculateEws({ ...normal, respiratory_rate: 22, spo2: 93, heart_rate: 95 }).response).toMatch(/Urgent/);
    expect(calculateEws({ ...normal, respiratory_rate: 26, spo2: 90, supplemental_o2: true }).response).toMatch(/critical care/);
  });
});

describe('detectCriticalVitals', () => {
  it('finds nothing in a normal set', () => {
    expect(detectCriticalVitals(normal)).toHaveLength(0);
  });

  it('flags profound hypoxia and hypotension', () => {
    const found = detectCriticalVitals({ ...normal, spo2: 85, systolic_bp: 70 });
    expect(found.map((f) => f.parameter)).toEqual(
      expect.arrayContaining(['SpO2', 'Systolic BP']),
    );
  });

  it('flags both bradycardia and tachycardia extremes', () => {
    expect(detectCriticalVitals({ ...normal, heart_rate: 30 })).toHaveLength(1);
    expect(detectCriticalVitals({ ...normal, heart_rate: 150 })).toHaveLength(1);
  });

  it('ignores parameters that were not recorded', () => {
    expect(detectCriticalVitals({ spo2: null, systolic_bp: null })).toHaveLength(0);
  });
});

describe('calculateBmi', () => {
  it('computes BMI from weight and height', () => {
    expect(calculateBmi(70, 175)).toBe(22.86);
  });

  it('returns null when either measurement is missing or invalid', () => {
    expect(calculateBmi(70, null)).toBeNull();
    expect(calculateBmi(null, 175)).toBeNull();
    expect(calculateBmi(70, 0)).toBeNull();
  });
});
