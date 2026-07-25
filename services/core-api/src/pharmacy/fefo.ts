export interface StockBatch {
  id: string;
  batch_number: string;
  expiry_date: Date;
  quantity_on_hand: number;
  quantity_reserved: number;
  is_recalled: boolean;
}

export interface PickLine {
  batch_id: string;
  batch_number: string;
  expiry_date: Date;
  quantity: number;
}

export interface PickResult {
  lines: PickLine[];
  short_by: number;
  /** Batches skipped, with the reason, so the pharmacist sees why stock was bypassed. */
  skipped: Array<{ batch_id: string; batch_number: string; reason: string }>;
}

/**
 * First-Expiring-First-Out picking.
 * Expired and recalled batches are never picked — an expiry sweep may not have run yet,
 * so the date is re-checked here at the moment of dispensing.
 */
export function pickFefo(batches: StockBatch[], required: number, now = new Date()): PickResult {
  if (required <= 0) return { lines: [], short_by: 0, skipped: [] };

  const skipped: PickResult['skipped'] = [];
  const usable: StockBatch[] = [];

  for (const b of batches) {
    const available = b.quantity_on_hand - b.quantity_reserved;
    if (b.is_recalled) {
      skipped.push({ batch_id: b.id, batch_number: b.batch_number, reason: 'recalled' });
      continue;
    }
    if (b.expiry_date <= now) {
      skipped.push({ batch_id: b.id, batch_number: b.batch_number, reason: 'expired' });
      continue;
    }
    if (available <= 0) {
      skipped.push({ batch_id: b.id, batch_number: b.batch_number, reason: 'no available quantity' });
      continue;
    }
    usable.push(b);
  }

  usable.sort((a, b) => {
    const byExpiry = a.expiry_date.getTime() - b.expiry_date.getTime();
    // Deterministic tiebreak so the same request always picks the same batch.
    return byExpiry !== 0 ? byExpiry : a.batch_number.localeCompare(b.batch_number);
  });

  const lines: PickLine[] = [];
  let remaining = required;

  for (const b of usable) {
    if (remaining === 0) break;
    const available = b.quantity_on_hand - b.quantity_reserved;
    const take = Math.min(available, remaining);
    lines.push({
      batch_id: b.id,
      batch_number: b.batch_number,
      expiry_date: b.expiry_date,
      quantity: take,
    });
    remaining -= take;
  }

  return { lines, short_by: remaining, skipped };
}

export interface FiveRightsInput {
  scanned_patient_barcode: string;
  expected_patient_barcode: string;
  scanned_medication_barcode: string;
  expected_medication_barcode: string;
  dose_given: number;
  dose_ordered: number;
  route_given: string;
  route_ordered: string;
  scheduled_at: Date | null;
  administered_at: Date;
  /** Minutes either side of the scheduled time that count as on-time. */
  time_window_minutes?: number;
}

export interface RightCheck {
  right: 'patient' | 'medication' | 'dose' | 'route' | 'time';
  ok: boolean;
  detail: string;
}

export interface FiveRightsResult {
  verified: boolean;
  /** A patient mismatch is fatal — the client must block every further action. */
  wrongPatient: boolean;
  checks: RightCheck[];
  failures: RightCheck[];
}

const norm = (v: string): string => v.trim().toUpperCase();

/** The five rights of medication administration, verified at the bedside. */
export function verifyFiveRights(input: FiveRightsInput): FiveRightsResult {
  const windowMinutes = input.time_window_minutes ?? 60;

  const patientOk = norm(input.scanned_patient_barcode) === norm(input.expected_patient_barcode);
  const medicationOk =
    norm(input.scanned_medication_barcode) === norm(input.expected_medication_barcode);
  const doseOk = input.dose_given === input.dose_ordered;
  const routeOk = norm(input.route_given) === norm(input.route_ordered);

  const driftMinutes = input.scheduled_at
    ? Math.abs(input.administered_at.getTime() - input.scheduled_at.getTime()) / 60_000
    : 0;
  const timeOk = !input.scheduled_at || driftMinutes <= windowMinutes;

  const checks: RightCheck[] = [
    {
      right: 'patient',
      ok: patientOk,
      detail: patientOk ? 'Patient wristband matches' : 'WRONG PATIENT — wristband does not match the order',
    },
    {
      right: 'medication',
      ok: medicationOk,
      detail: medicationOk ? 'Medication barcode matches' : 'Medication barcode does not match the order',
    },
    {
      right: 'dose',
      ok: doseOk,
      detail: doseOk ? 'Dose matches the order' : `Dose ${input.dose_given} does not match the ordered ${input.dose_ordered}`,
    },
    {
      right: 'route',
      ok: routeOk,
      detail: routeOk ? 'Route matches the order' : `Route ${input.route_given} does not match the ordered ${input.route_ordered}`,
    },
    {
      right: 'time',
      ok: timeOk,
      detail: timeOk
        ? 'Within the administration window'
        : `${Math.round(driftMinutes)} minutes outside the ${windowMinutes}-minute window`,
    },
  ];

  const failures = checks.filter((c) => !c.ok);
  return {
    verified: failures.length === 0,
    wrongPatient: !patientOk,
    checks,
    failures,
  };
}

export interface ExpiryBucket {
  expired: number;
  within30Days: number;
  within90Days: number;
}

export function bucketByExpiry(batches: StockBatch[], now = new Date()): ExpiryBucket {
  const day = 86_400_000;
  return batches.reduce<ExpiryBucket>(
    (acc, b) => {
      const delta = b.expiry_date.getTime() - now.getTime();
      if (delta <= 0) acc.expired += b.quantity_on_hand;
      else if (delta <= 30 * day) acc.within30Days += b.quantity_on_hand;
      else if (delta <= 90 * day) acc.within90Days += b.quantity_on_hand;
      return acc;
    },
    { expired: 0, within30Days: 0, within90Days: 0 },
  );
}
