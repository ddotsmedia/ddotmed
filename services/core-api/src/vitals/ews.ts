export interface EwsInput {
  respiratory_rate?: number | null;
  spo2?: number | null;
  supplemental_o2?: boolean;
  temperature_c?: number | null;
  systolic_bp?: number | null;
  heart_rate?: number | null;
  /** ACVPU: Alert, new Confusion, Voice, Pain, Unresponsive. */
  consciousness?: 'A' | 'C' | 'V' | 'P' | 'U' | null;
}

export type EwsRisk = 'low' | 'medium' | 'high';

export interface EwsResult {
  score: number;
  risk: EwsRisk;
  /** True when any single parameter scores 3 — that alone mandates escalation. */
  hasRedScore: boolean;
  components: Record<string, number>;
  missing: string[];
  response: string;
}

const band = (value: number, bands: Array<[number, number, number]>): number => {
  for (const [low, high, score] of bands) if (value >= low && value <= high) return score;
  return 3;
};

/**
 * NEWS2 (RCP UK, 2017). Scale 1 SpO2 only — Scale 2 for hypercapnic respiratory
 * failure requires an explicit clinical flag and is not inferred here.
 */
export function calculateEws(v: EwsInput): EwsResult {
  const components: Record<string, number> = {};
  const missing: string[] = [];

  if (v.respiratory_rate == null) missing.push('respiratory_rate');
  else
    components.respiratory_rate = band(v.respiratory_rate, [
      [0, 8, 3],
      [9, 11, 1],
      [12, 20, 0],
      [21, 24, 2],
    ]);

  if (v.spo2 == null) missing.push('spo2');
  else
    components.spo2 = band(v.spo2, [
      [0, 91, 3],
      [92, 93, 2],
      [94, 95, 1],
      [96, 100, 0],
    ]);

  components.supplemental_o2 = v.supplemental_o2 ? 2 : 0;

  if (v.temperature_c == null) missing.push('temperature_c');
  else
    components.temperature_c = band(v.temperature_c, [
      [0, 35.0, 3],
      [35.1, 36.0, 1],
      [36.1, 38.0, 0],
      [38.1, 39.0, 1],
      [39.1, 99, 2],
    ]);

  if (v.systolic_bp == null) missing.push('systolic_bp');
  else
    components.systolic_bp = band(v.systolic_bp, [
      [0, 90, 3],
      [91, 100, 2],
      [101, 110, 1],
      [111, 219, 0],
    ]);

  if (v.heart_rate == null) missing.push('heart_rate');
  else
    components.heart_rate = band(v.heart_rate, [
      [0, 40, 3],
      [41, 50, 1],
      [51, 90, 0],
      [91, 110, 1],
      [111, 130, 2],
    ]);

  if (v.consciousness == null) missing.push('consciousness');
  else components.consciousness = v.consciousness === 'A' ? 0 : 3;

  const score = Object.values(components).reduce((a, b) => a + b, 0);
  const hasRedScore = Object.values(components).some((c) => c === 3);

  // A single red score escalates even when the aggregate is low.
  const risk: EwsRisk = score >= 7 ? 'high' : score >= 5 || hasRedScore ? 'medium' : 'low';

  const response =
    risk === 'high'
      ? 'Emergency assessment by a critical care team; continuous monitoring'
      : risk === 'medium'
        ? 'Urgent review by a clinician with acute competencies; monitor at least hourly'
        : score >= 1
          ? 'Ward-based response; minimum 4-6 hourly observations'
          : 'Routine monitoring; minimum 12 hourly observations';

  return { score, risk, hasRedScore, components, missing, response };
}

export interface CriticalVital {
  parameter: string;
  value: number;
  threshold: string;
}

/** Absolute values that warrant an immediate alert regardless of the aggregate score. */
export function detectCriticalVitals(v: EwsInput): CriticalVital[] {
  const out: CriticalVital[] = [];
  if (v.spo2 != null && v.spo2 < 88) out.push({ parameter: 'SpO2', value: v.spo2, threshold: '< 88%' });
  if (v.systolic_bp != null && v.systolic_bp < 80)
    out.push({ parameter: 'Systolic BP', value: v.systolic_bp, threshold: '< 80 mmHg' });
  if (v.systolic_bp != null && v.systolic_bp > 220)
    out.push({ parameter: 'Systolic BP', value: v.systolic_bp, threshold: '> 220 mmHg' });
  if (v.heart_rate != null && v.heart_rate < 35)
    out.push({ parameter: 'Heart rate', value: v.heart_rate, threshold: '< 35 /min' });
  if (v.heart_rate != null && v.heart_rate > 140)
    out.push({ parameter: 'Heart rate', value: v.heart_rate, threshold: '> 140 /min' });
  if (v.respiratory_rate != null && v.respiratory_rate < 6)
    out.push({ parameter: 'Respiratory rate', value: v.respiratory_rate, threshold: '< 6 /min' });
  if (v.respiratory_rate != null && v.respiratory_rate > 30)
    out.push({ parameter: 'Respiratory rate', value: v.respiratory_rate, threshold: '> 30 /min' });
  if (v.temperature_c != null && v.temperature_c < 34)
    out.push({ parameter: 'Temperature', value: v.temperature_c, threshold: '< 34 °C' });
  if (v.temperature_c != null && v.temperature_c > 40)
    out.push({ parameter: 'Temperature', value: v.temperature_c, threshold: '> 40 °C' });
  return out;
}

export function calculateBmi(weightKg?: number | null, heightCm?: number | null): number | null {
  if (!weightKg || !heightCm || heightCm <= 0) return null;
  const m = heightCm / 100;
  return Number((weightKg / (m * m)).toFixed(2));
}
