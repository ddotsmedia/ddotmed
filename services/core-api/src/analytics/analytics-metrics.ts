/**
 * The arithmetic behind the dashboards.
 *
 * Kept free of Prisma because these are the numbers a board meeting argues over —
 * readmission rate, length of stay, turnaround time — and each one is a definition
 * as much as a calculation. A definition that lives inside a query is a definition
 * nobody can check.
 *
 * Two conventions throughout, matching the revenue-cycle module: money is integer
 * minor units, and ratios are basis points. A percentage carried as a float is how
 * a collection rate ends up disagreeing with the ledger it came from.
 */

/** 10 000 bp = 100%. An empty denominator is 0, not NaN. */
export function ratioBp(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000);
}

/** Basis points as a percentage to one decimal, for display only. */
export function bpToPct(bp: number): number {
  return Math.round(bp / 10) / 10;
}

/** Whole percent, which is what a KPI tile shows. */
export function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 100);
}

export const DAY_MS = 86_400_000;

/** Midnight UTC at the start of the given day. */
export function startOfDay(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Start of the current month, in UTC — the period every MTD figure is measured over. */
export function startOfMonth(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** The last `days` whole days, ending at the start of tomorrow. */
export function lastNDays(days: number, now: Date = new Date()): { from: Date; to: Date } {
  const to = new Date(startOfDay(now).getTime() + DAY_MS);
  return { from: new Date(to.getTime() - days * DAY_MS), to };
}

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** Mean of a list, or null when there is nothing to average — never NaN, never 0. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Mean rounded to `dp`, preserving the null-for-empty contract. */
export function meanRounded(values: readonly number[], dp = 1): number | null {
  const m = mean(values);
  if (m === null) return null;
  const factor = 10 ** dp;
  return Math.round(m * factor) / factor;
}

// ── length of stay ────────────────────────────────────────────────────────────

export interface StayRecord {
  patient_id: string;
  admitted_at: Date | string;
  discharged_at: Date | string | null;
  ward?: string | null;
}

/** Length of one stay in days, to one decimal. A same-day stay is 0, not a day. */
export function stayDays(admittedAt: Date | string, dischargedAt: Date | string): number {
  const days = (asDate(dischargedAt).getTime() - asDate(admittedAt).getTime()) / DAY_MS;
  return Math.round(Math.max(0, days) * 10) / 10;
}

/**
 * Average length of stay over *completed* stays only.
 *
 * A patient still in a bed has no length of stay yet, and counting their days so
 * far drags the average down every time occupancy rises — which is exactly when
 * the figure gets looked at.
 */
export function averageLengthOfStay(stays: readonly StayRecord[]): number | null {
  const completed = stays
    .filter((s) => s.discharged_at)
    .map((s) => stayDays(s.admitted_at, s.discharged_at!));
  return meanRounded(completed);
}

export interface WardStayRow {
  ward: string;
  discharges: number;
  alos_days: number;
}

/** ALOS split by the ward the patient was discharged from, longest first. */
export function alosByWard(stays: readonly StayRecord[]): WardStayRow[] {
  const rows = new Map<string, number[]>();

  for (const stay of stays) {
    if (!stay.discharged_at) continue;
    const ward = stay.ward ?? 'Unassigned';
    const list = rows.get(ward) ?? [];
    list.push(stayDays(stay.admitted_at, stay.discharged_at));
    rows.set(ward, list);
  }

  return [...rows.entries()]
    .map(([ward, days]) => ({
      ward,
      discharges: days.length,
      alos_days: meanRounded(days) ?? 0,
    }))
    .sort((a, b) => b.alos_days - a.alos_days || a.ward.localeCompare(b.ward));
}

// ── readmission ───────────────────────────────────────────────────────────────

export interface ReadmissionRate {
  discharges: number;
  readmissions: number;
  rate_bp: number;
}

/**
 * The 30-day readmission rate.
 *
 * Measured the way regulators measure it: the denominator is discharges, and a
 * discharge counts as a readmission if *that same patient* is admitted again
 * within 30 days. The index event is the discharge, not the readmission, so a
 * patient who bounces back three times still contributes one readmission per
 * qualifying discharge rather than inflating the numerator.
 *
 * The final discharge in the window is still counted in the denominator even
 * though its 30 days may not have elapsed — dropping it would quietly shrink the
 * denominator and flatter the number.
 */
export function readmissionRate30d(
  admissions: readonly StayRecord[],
  windowDays = 30,
): ReadmissionRate {
  const byPatient = new Map<string, StayRecord[]>();
  for (const admission of admissions) {
    const list = byPatient.get(admission.patient_id) ?? [];
    list.push(admission);
    byPatient.set(admission.patient_id, list);
  }

  let discharges = 0;
  let readmissions = 0;

  for (const stays of byPatient.values()) {
    const ordered = [...stays].sort(
      (a, b) => asDate(a.admitted_at).getTime() - asDate(b.admitted_at).getTime(),
    );

    for (const [index, stay] of ordered.entries()) {
      if (!stay.discharged_at) continue;
      discharges += 1;

      const dischargedAt = asDate(stay.discharged_at).getTime();
      const readmitted = ordered
        .slice(index + 1)
        .some((later) => {
          const gap = asDate(later.admitted_at).getTime() - dischargedAt;
          return gap >= 0 && gap <= windowDays * DAY_MS;
        });
      if (readmitted) readmissions += 1;
    }
  }

  return { discharges, readmissions, rate_bp: ratioBp(readmissions, discharges) };
}

// ── turnaround and waiting ────────────────────────────────────────────────────

export interface TurnaroundPair {
  ordered_at: Date | string | null;
  completed_at: Date | string | null;
}

/**
 * Average turnaround in minutes over pairs that actually completed.
 *
 * An order still in the lab has no turnaround time. Including it as zero would
 * make a backlog look like excellent performance, which is the wrong way round.
 */
export function averageTurnaroundMinutes(pairs: readonly TurnaroundPair[]): number | null {
  const minutes = pairs
    .filter((p) => p.ordered_at && p.completed_at)
    .map((p) => (asDate(p.completed_at!).getTime() - asDate(p.ordered_at!).getTime()) / 60_000)
    .filter((m) => m >= 0);
  return meanRounded(minutes);
}

export interface QueueWait {
  created_at: Date | string;
  called_at: Date | string | null;
}

/** Average outpatient wait, from joining the queue to being called. */
export function averageWaitMinutes(entries: readonly QueueWait[]): number | null {
  return averageTurnaroundMinutes(
    entries.map((e) => ({ ordered_at: e.created_at, completed_at: e.called_at })),
  );
}

// ── bed flow ──────────────────────────────────────────────────────────────────

/**
 * Bed turnover: discharges per bed over the period.
 *
 * Reported for the period as measured, not annualised — an annualised figure from
 * seven days of data reads as precision that is not there.
 */
export function bedTurnoverRate(discharges: number, totalBeds: number): number {
  if (totalBeds <= 0) return 0;
  return Math.round((discharges / totalBeds) * 100) / 100;
}

export interface DischargeDelayRecord {
  expected_discharge_at: Date | string | null;
  discharged_at: Date | string | null;
}

/**
 * Stays that have passed their expected discharge and are still open.
 *
 * A bed that should be free and is not is the operational problem this counts;
 * a stay discharged late but discharged is no longer blocking anything.
 */
export function dischargeDelayCount(
  admissions: readonly DischargeDelayRecord[],
  now: Date = new Date(),
): number {
  return admissions.filter(
    (a) =>
      !a.discharged_at &&
      a.expected_discharge_at &&
      asDate(a.expected_discharge_at).getTime() < now.getTime(),
  ).length;
}

// ── revenue by department ─────────────────────────────────────────────────────

export interface DepartmentLine {
  category: string | null;
  total_minor: number;
  quantity?: number;
}

export interface DepartmentRevenueRow {
  department: string;
  line_count: number;
  billed_minor: number;
}

/**
 * Revenue grouped by charge-master category, which is what a department is here.
 *
 * A line whose charge code is not in the charge master has no department; it is
 * reported as Uncategorised rather than dropped, because money that vanishes
 * between two reports is the fastest way to lose trust in both.
 */
export function revenueByDepartment(lines: readonly DepartmentLine[]): DepartmentRevenueRow[] {
  const rows = new Map<string, DepartmentRevenueRow>();

  for (const line of lines) {
    const department = line.category ?? 'Uncategorised';
    const row = rows.get(department) ?? { department, line_count: 0, billed_minor: 0 };
    row.line_count += 1;
    row.billed_minor += line.total_minor;
    rows.set(department, row);
  }

  return [...rows.values()].sort(
    (a, b) => b.billed_minor - a.billed_minor || a.department.localeCompare(b.department),
  );
}

// ── diagnoses ─────────────────────────────────────────────────────────────────

export interface DiagnosisCount {
  code: string;
  display: string | null;
  count: number;
}

/** Top coded diagnoses, most frequent first, ties broken by code for stability. */
export function topDiagnoses(rows: readonly DiagnosisCount[], limit = 10): DiagnosisCount[] {
  return [...rows]
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, limit);
}

// ── trends ────────────────────────────────────────────────────────────────────

export interface TrendPoint {
  date: string;
  admissions: number;
  discharges: number;
}

/**
 * A dense daily series for the admission trend chart.
 *
 * Every day in the window gets a point, including the quiet ones. A line chart
 * that silently skips empty days draws a straight line across a shutdown and
 * reports it as steady activity.
 */
export function dailyTrend(
  admissions: readonly { admitted_at: Date | string }[],
  discharges: readonly { discharged_at: Date | string | null }[],
  days: number,
  now: Date = new Date(),
): TrendPoint[] {
  const points = new Map<string, TrendPoint>();
  const end = startOfDay(now);

  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const key = new Date(end.getTime() - offset * DAY_MS).toISOString().slice(0, 10);
    points.set(key, { date: key, admissions: 0, discharges: 0 });
  }

  for (const row of admissions) {
    const key = asDate(row.admitted_at).toISOString().slice(0, 10);
    const point = points.get(key);
    if (point) point.admissions += 1;
  }

  for (const row of discharges) {
    if (!row.discharged_at) continue;
    const key = asDate(row.discharged_at).toISOString().slice(0, 10);
    const point = points.get(key);
    if (point) point.discharges += 1;
  }

  return [...points.values()];
}
