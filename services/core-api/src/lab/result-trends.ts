/**
 * Result trends for the chart sparkline.
 *
 * A single number rarely means much on its own — a creatinine of 1.6 is routine
 * in one patient and an acute injury in another. What changes a decision is the
 * direction of travel, so results are grouped per test and reduced to the last
 * few values with the movement between them made explicit.
 */

export type Interpretation = 'N' | 'L' | 'H' | 'LL' | 'HH';

export interface ResultPoint {
  id: string;
  performed_at: string;
  value: number | null;
  value_string: string | null;
  unit: string | null;
  interpretation: string | null;
  is_critical: boolean;
}

export interface ResultTrend {
  loinc_code: string;
  display: string;
  unit: string | null;
  reference_low: number | null;
  reference_high: number | null;
  /** Oldest to newest, so a sparkline can be drawn straight from it. */
  points: ResultPoint[];
  latest: ResultPoint;
  /** Change from the previous value, null when there is nothing to compare. */
  delta: number | null;
  direction: 'up' | 'down' | 'flat' | null;
  has_critical: boolean;
}

export interface RawResult {
  id: string;
  loinc_code: string;
  display: string;
  unit: string | null;
  value_quantity: number | string | null;
  value_string: string | null;
  reference_low: number | string | null;
  reference_high: number | string | null;
  interpretation: string | null;
  is_critical: boolean;
  performed_at: Date | string;
}

/** Default trend window. Five points is what fits a sparkline legibly on a phone. */
export const TREND_POINTS = 5;

const num = (value: number | string | null | undefined): number | null => {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
};

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

/**
 * Groups results by LOINC and keeps the most recent `limit` of each.
 *
 * Input may arrive in any order; output is always oldest-first within a test, and
 * tests are ordered by how recently each was resulted, so the newest activity is
 * at the top of the list.
 */
export function buildTrends(results: readonly RawResult[], limit = TREND_POINTS): ResultTrend[] {
  const byCode = new Map<string, RawResult[]>();
  for (const result of results) {
    const bucket = byCode.get(result.loinc_code);
    if (bucket) bucket.push(result);
    else byCode.set(result.loinc_code, [result]);
  }

  const trends: ResultTrend[] = [];

  for (const [loinc, rows] of byCode) {
    // Newest first so the slice keeps the most recent, then flip for display.
    const ordered = [...rows].sort(
      (a, b) => new Date(b.performed_at).getTime() - new Date(a.performed_at).getTime(),
    );
    const kept = ordered.slice(0, limit).reverse();
    const points: ResultPoint[] = kept.map((r) => ({
      id: r.id,
      performed_at: iso(r.performed_at),
      value: num(r.value_quantity),
      value_string: r.value_string,
      unit: r.unit,
      interpretation: r.interpretation,
      is_critical: r.is_critical,
    }));

    const latest = points[points.length - 1];
    if (!latest) continue;

    const newest = ordered[0]!;
    const previousNumeric = [...points]
      .slice(0, -1)
      .reverse()
      .find((p) => p.value !== null);
    const delta =
      latest.value !== null && previousNumeric?.value != null
        ? Number((latest.value - previousNumeric.value).toFixed(4))
        : null;

    trends.push({
      loinc_code: loinc,
      display: newest.display,
      unit: latest.unit ?? newest.unit,
      reference_low: num(newest.reference_low),
      reference_high: num(newest.reference_high),
      points,
      latest,
      delta,
      direction: delta === null ? null : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat',
      // Any critical value in the window, not only the latest: a value that was
      // critical yesterday and is normal today is still the reason to look.
      has_critical: points.some((p) => p.is_critical),
    });
  }

  return trends.sort(
    (a, b) => new Date(b.latest.performed_at).getTime() - new Date(a.latest.performed_at).getTime(),
  );
}

/**
 * Scales points to a 0-100 box for an inline sparkline.
 *
 * A flat series sits on the mid-line rather than collapsing to zero, which would
 * read as a fall to nothing.
 */
export function sparklinePoints(points: readonly ResultPoint[]): Array<{ x: number; y: number }> {
  const values = points.map((p) => p.value).filter((v): v is number => v !== null);
  if (values.length === 0) return [];
  if (values.length === 1) return [{ x: 0, y: 50 }];

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;

  return values.map((value, index) => ({
    x: Number(((index / (values.length - 1)) * 100).toFixed(2)),
    y: span === 0 ? 50 : Number((100 - ((value - min) / span) * 100).toFixed(2)),
  }));
}

const ABNORMAL: ReadonlySet<string> = new Set(['L', 'H', 'LL', 'HH']);

export function isAbnormal(interpretation: string | null): boolean {
  return interpretation !== null && ABNORMAL.has(interpretation);
}

/** How a flag should read to a clinician scanning a list. */
export function flagTone(interpretation: string | null): 'critical' | 'high' | 'low' | 'normal' {
  if (interpretation === 'HH' || interpretation === 'LL') return 'critical';
  if (interpretation === 'H') return 'high';
  if (interpretation === 'L') return 'low';
  return 'normal';
}
