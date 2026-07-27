/**
 * Slot availability.
 *
 * Kept pure so the rules that decide whether a patient can be offered a time are
 * testable without a database. The repository supplies raw slots and the
 * appointments that already claim them; everything else is decided here.
 */

export interface RawSlot {
  id: string;
  start: Date;
  end: Date;
  status: string;
  overbooked: boolean;
  schedule_id: string;
}

export interface ClaimingAppointment {
  slot_id: string | null;
  start: Date;
  end: Date;
  status: string;
}

/** Appointment states that still hold a slot. Cancelled and no-show release it. */
export const SLOT_HOLDING_STATUSES: ReadonlySet<string> = new Set([
  'proposed',
  'pending',
  'booked',
  'arrived',
  'checked_in',
]);

export interface AvailableSlot {
  id: string;
  start: Date;
  end: Date;
  minutes: number;
  schedule_id: string;
  overbooked: boolean;
}

export interface AvailabilityOptions {
  /** Slots starting before this are not offerable. Defaults to "now". */
  now?: Date;
  /** Refuse bookings closer than this many minutes to the start time. */
  minLeadMinutes?: number;
}

/**
 * Filters a day's slots down to what can actually be booked.
 *
 * A slot is offerable when it is free, in the future by at least the lead time,
 * and not already claimed by a live appointment. A slot marked `overbooked` is
 * still returned — that is a deliberate capacity decision by the scheduler — but
 * flagged so the UI can mark it.
 */
export function availableSlots(
  slots: RawSlot[],
  claims: ClaimingAppointment[],
  options: AvailabilityOptions = {},
): AvailableSlot[] {
  const now = options.now ?? new Date();
  const minLeadMs = (options.minLeadMinutes ?? 0) * 60_000;
  const earliest = new Date(now.getTime() + minLeadMs);

  const claimedSlotIds = new Set(
    claims
      .filter((c) => SLOT_HOLDING_STATUSES.has(c.status) && c.slot_id)
      .map((c) => c.slot_id as string),
  );

  return slots
    .filter((slot) => {
      if (slot.status !== 'free') return false;
      if (slot.start < earliest) return false;
      if (claimedSlotIds.has(slot.id) && !slot.overbooked) return false;
      return true;
    })
    .map((slot) => ({
      id: slot.id,
      start: slot.start,
      end: slot.end,
      minutes: Math.round((slot.end.getTime() - slot.start.getTime()) / 60_000),
      schedule_id: slot.schedule_id,
      overbooked: slot.overbooked,
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * True when a proposed [start, end) overlaps any appointment that still holds
 * time on the practitioner's diary. Touching boundaries do not overlap: a 09:30
 * finish and a 09:30 start are back-to-back, not a clash.
 */
export function hasConflict(
  start: Date,
  end: Date,
  existing: ClaimingAppointment[],
): boolean {
  return existing.some(
    (appointment) =>
      SLOT_HOLDING_STATUSES.has(appointment.status) &&
      appointment.start < end &&
      appointment.end > start,
  );
}

/** Groups slots into morning / afternoon / evening for the picker. */
export function groupSlotsByPartOfDay(
  slots: AvailableSlot[],
): Array<{ period: 'morning' | 'afternoon' | 'evening'; slots: AvailableSlot[] }> {
  const buckets: Record<'morning' | 'afternoon' | 'evening', AvailableSlot[]> = {
    morning: [],
    afternoon: [],
    evening: [],
  };

  for (const slot of slots) {
    const hour = slot.start.getUTCHours();
    if (hour < 12) buckets.morning.push(slot);
    else if (hour < 17) buckets.afternoon.push(slot);
    else buckets.evening.push(slot);
  }

  return (['morning', 'afternoon', 'evening'] as const)
    .map((period) => ({ period, slots: buckets[period] }))
    .filter((group) => group.slots.length > 0);
}

/** Inclusive UTC day bounds for a YYYY-MM-DD string. */
export function dayBounds(isoDay: string): { from: Date; to: Date } {
  return {
    from: new Date(`${isoDay}T00:00:00.000Z`),
    to: new Date(`${isoDay}T23:59:59.999Z`),
  };
}
