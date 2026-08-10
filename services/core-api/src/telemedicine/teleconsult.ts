/**
 * Teleconsultation rules: who may join, when, and for how long the room lives.
 *
 * Kept free of Prisma and of the provider SDK because these are the decisions that
 * decide whether a patient can get into their own appointment — and they need to be
 * readable and testable without a video vendor or a database in the room.
 */

/** How early a participant may enter the room, in minutes before the start time. */
export const JOIN_WINDOW_MINUTES = 15;

/** How long the room stays alive after the appointment starts, in hours. */
export const ROOM_LIFETIME_HOURS = 2;

/** Providers this build knows how to talk to. `mock` is the no-credentials path. */
export type TeleconsultProvider = 'daily' | 'mock';

/** Which side of the consultation a caller is on. */
export type ParticipantRole = 'patient' | 'practitioner';

export interface AppointmentParticipants {
  patient_id: string;
  practitioner_id: string | null;
}

export interface CallerIdentity {
  patientId?: string | null;
  practitionerId?: string | null;
}

/**
 * The caller's side of this consultation, or null if they are on neither.
 *
 * Deliberately strict: a receptionist with `patient:read` can see that the
 * appointment exists, but a video room is a consulting room with the door shut and
 * only the two people in it belong there. Identity comes from the token's own
 * `patient_id` / `practitioner_id`, never from the request body.
 */
export function participantRole(
  appointment: AppointmentParticipants,
  caller: CallerIdentity,
): ParticipantRole | null {
  if (caller.patientId && caller.patientId === appointment.patient_id) return 'patient';
  if (
    caller.practitionerId &&
    appointment.practitioner_id &&
    caller.practitionerId === appointment.practitioner_id
  ) {
    return 'practitioner';
  }
  return null;
}

export function isParticipant(
  appointment: AppointmentParticipants,
  caller: CallerIdentity,
): boolean {
  return participantRole(appointment, caller) !== null;
}

/**
 * The practitioner hosts; the patient is a guest.
 *
 * Host rights are what let a clinician admit someone from the lobby and end the
 * call for everyone, so they follow the clinical role rather than who dialled in
 * first.
 */
export function isHost(role: ParticipantRole): boolean {
  return role === 'practitioner';
}

/** When the room stops accepting anyone, as a Date. */
export function roomExpiry(start: Date, hours: number = ROOM_LIFETIME_HOURS): Date {
  return new Date(start.getTime() + hours * 3_600_000);
}

/** The same instant as Unix seconds, which is what Daily's `exp` takes. */
export function roomExpiryUnix(start: Date, hours: number = ROOM_LIFETIME_HOURS): number {
  return Math.floor(roomExpiry(start, hours).getTime() / 1000);
}

/**
 * A room name the provider will accept: alphanumerics, dashes and underscores only.
 *
 * Derived from the appointment id rather than random, so a repeated create call
 * lands on the same room instead of stranding a patient in an empty one.
 */
export function roomNameForAppointment(appointmentId: string): string {
  return `mc-${appointmentId.replace(/[^a-zA-Z0-9]/g, '')}`;
}

/** Minutes from now until the appointment starts; negative once it has begun. */
export function minutesUntilStart(start: Date, now: Date): number {
  return (start.getTime() - now.getTime()) / 60_000;
}

/**
 * Whether the join button should be live.
 *
 * Opens {@link JOIN_WINDOW_MINUTES} before the start so a patient can settle in,
 * and closes when the room expires — after that the provider ejects everyone, so
 * offering a link that cannot connect would be worse than offering none.
 */
export function isJoinable(start: Date, now: Date, hours: number = ROOM_LIFETIME_HOURS): boolean {
  return minutesUntilStart(start, now) <= JOIN_WINDOW_MINUTES && now < roomExpiry(start, hours);
}

/**
 * Consultation length in whole seconds.
 *
 * Clamped at zero: clock skew between the app server and the caller's device has
 * produced an end before the start before now, and a negative duration would go
 * straight into a bill.
 */
export function sessionDurationSeconds(startedAt: Date, endedAt: Date): number {
  return Math.max(0, Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000));
}

/** Consultation length rounded up to whole minutes, which is how it is billed. */
export function billableMinutes(durationSeconds: number): number {
  return Math.ceil(Math.max(0, durationSeconds) / 60);
}

/**
 * The note the clinician finds waiting when the call drops.
 *
 * A stub, not a note: it records what the system knows for certain — that a video
 * consultation happened, on which provider, for how long — and leaves every
 * clinical field empty for the person who was actually in the room.
 */
export function teleconsultNoteStub(input: {
  provider: string;
  startedAt: Date;
  endedAt: Date;
  durationSeconds: number;
}): string {
  const minutes = billableMinutes(input.durationSeconds);
  return [
    `Teleconsultation (${input.provider}).`,
    `Started ${input.startedAt.toISOString()}, ended ${input.endedAt.toISOString()}.`,
    `Duration ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    '',
    'Clinical content to be completed by the attending clinician.',
  ].join('\n');
}
