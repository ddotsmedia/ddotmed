/**
 * Bed board rules: cleaning state, availability and length of stay.
 *
 * Kept free of Prisma because these are the decisions that get argued about on a
 * ward round — whether a bed can take a patient, and whether one has been in it
 * longer than planned — and they should be readable and testable on their own.
 */

export type HousekeepingStatus = 'clean' | 'dirty' | 'in_progress';

export type BedStatus =
  | 'available'
  | 'occupied'
  | 'reserved'
  | 'cleaning'
  | 'blocked'
  | 'maintenance';

/**
 * The cleaning cycle. A bed goes dirty when it is vacated, a cleaner picks it up,
 * and it is signed off clean. Nothing skips a step: "clean" straight from "dirty"
 * would mean nobody was ever assigned the job.
 */
export const HOUSEKEEPING_FLOW: Record<HousekeepingStatus, HousekeepingStatus[]> = {
  dirty: ['in_progress'],
  in_progress: ['clean', 'dirty'],
  clean: ['dirty'],
};

export function canCleanTransition(from: HousekeepingStatus, to: HousekeepingStatus): boolean {
  return HOUSEKEEPING_FLOW[from]?.includes(to) ?? false;
}

/** Statuses from which a bed can take a new patient, given it is also clean. */
const ADMITTABLE_STATUSES: ReadonlySet<BedStatus> = new Set(['available', 'reserved']);

export interface BedState {
  status: BedStatus;
  housekeeping_status: HousekeepingStatus;
}

/**
 * A bed is admittable only when it is both free and clean.
 *
 * The two are separate facts. A discharge frees the bed immediately but leaves it
 * dirty, and putting a patient into it before it has been turned around is the
 * exact failure this guards.
 */
export function isAdmittable(bed: BedState): boolean {
  return ADMITTABLE_STATUSES.has(bed.status) && bed.housekeeping_status === 'clean';
}

/** Why a bed cannot take a patient, phrased for the person looking at the board. */
export function admissionBlocker(bed: BedState): string | null {
  if (!ADMITTABLE_STATUSES.has(bed.status)) return `The bed is ${bed.status}`;
  if (bed.housekeeping_status === 'dirty') return 'The bed has not been cleaned since the last patient';
  if (bed.housekeeping_status === 'in_progress') return 'The bed is being cleaned';
  return null;
}

export type BedTone = 'available' | 'occupied' | 'dirty' | 'isolation' | 'blocked';

/**
 * The single colour a bed shows on the board.
 *
 * Isolation wins over everything: it changes how staff approach the bay, and a
 * bed that is merely occupied looks the same as one that needs a gown and mask
 * unless it is called out.
 */
export function bedTone(bed: BedState & { isolation_flag?: boolean }): BedTone {
  if (bed.isolation_flag) return 'isolation';
  if (bed.status === 'blocked' || bed.status === 'maintenance') return 'blocked';
  if (bed.status === 'occupied') return 'occupied';
  if (bed.housekeeping_status !== 'clean' || bed.status === 'cleaning') return 'dirty';
  return 'available';
}

/**
 * Whole calendar days between two instants, signed.
 *
 * Midnight to midnight rather than elapsed hours: a patient admitted at 23:00 and
 * still in at 01:00 has been in for a day, which is how a ward counts it and how
 * the bed is billed. Negative when `to` falls before `from`.
 */
export function wholeDaysBetween(from: Date | string, to: Date | string): number {
  const start = new Date(from);
  const end = new Date(to);
  const startDay = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate());
  const endDay = Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate());
  return Math.round((endDay - startDay) / 86_400_000);
}

/** Days since admission. Never negative — a stay cannot run backwards. */
export function lengthOfStayDays(
  admittedAt: Date | string,
  reference: Date | string = new Date(),
): number {
  return Math.max(0, wholeDaysBetween(admittedAt, reference));
}

export interface EddStatus {
  expected_discharge_at: string | null;
  days_remaining: number | null;
  /** True once the expected discharge date has passed and the patient is still in. */
  overdue: boolean;
  days_overdue: number;
}

/**
 * Where a patient sits against their expected discharge date.
 *
 * Overdue is measured in whole days past the EDD, so a patient whose EDD is today
 * is not yet overdue — the day is not over.
 */
export function eddStatus(
  expectedDischargeAt: Date | string | null | undefined,
  reference: Date | string = new Date(),
): EddStatus {
  if (!expectedDischargeAt) {
    return { expected_discharge_at: null, days_remaining: null, overdue: false, days_overdue: 0 };
  }

  const edd = new Date(expectedDischargeAt);
  // Signed, so a future date reports days left and a past one days overdue.
  const remaining = wholeDaysBetween(reference, edd);

  return {
    expected_discharge_at: edd.toISOString(),
    days_remaining: remaining,
    overdue: remaining < 0,
    days_overdue: remaining < 0 ? -remaining : 0,
  };
}

export interface WardSummary {
  ward: string;
  total: number;
  occupied: number;
  available: number;
  dirty: number;
  isolation: number;
  occupancy_pct: number;
}

export function summariseWard<T extends BedState & { ward: string; isolation_flag?: boolean }>(
  ward: string,
  beds: readonly T[],
): WardSummary {
  const tones = beds.map((bed) => bedTone(bed));
  const occupied = beds.filter((b) => b.status === 'occupied').length;
  return {
    ward,
    total: beds.length,
    occupied,
    available: beds.filter((b) => isAdmittable(b)).length,
    dirty: tones.filter((t) => t === 'dirty').length,
    isolation: beds.filter((b) => b.isolation_flag).length,
    occupancy_pct: beds.length ? Math.round((occupied / beds.length) * 100) : 0,
  };
}
