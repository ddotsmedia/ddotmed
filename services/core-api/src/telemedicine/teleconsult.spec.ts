import {
  JOIN_WINDOW_MINUTES,
  ROOM_LIFETIME_HOURS,
  billableMinutes,
  isHost,
  isJoinable,
  isParticipant,
  minutesUntilStart,
  participantRole,
  roomExpiry,
  roomExpiryUnix,
  roomNameForAppointment,
  sessionDurationSeconds,
  teleconsultNoteStub,
} from './teleconsult';

const START = new Date('2026-08-10T09:00:00Z');
const APPOINTMENT_ID = '0193c3f0-0000-7000-8000-0000000000a1';
const PATIENT_ID = '0193c3f0-0000-7000-8000-000000000001';
const PRACTITIONER_ID = '0193c3f0-0000-7000-8000-0000000000d1';

const appointment = { patient_id: PATIENT_ID, practitioner_id: PRACTITIONER_ID };
const minutesFromStart = (n: number) => new Date(START.getTime() + n * 60_000);

describe('participantRole', () => {
  it('recognises the patient by the token patient_id', () => {
    expect(participantRole(appointment, { patientId: PATIENT_ID })).toBe('patient');
  });

  it('recognises the practitioner by the token practitioner_id', () => {
    expect(participantRole(appointment, { practitionerId: PRACTITIONER_ID })).toBe('practitioner');
  });

  it('refuses a clinician who is not on this appointment', () => {
    expect(participantRole(appointment, { practitionerId: 'someone-else' })).toBeNull();
    expect(isParticipant(appointment, { practitionerId: 'someone-else' })).toBe(false);
  });

  it('refuses a caller who is neither, such as a receptionist', () => {
    expect(participantRole(appointment, {})).toBeNull();
    expect(participantRole(appointment, { patientId: null, practitionerId: null })).toBeNull();
  });

  it('does not let a null practitioner on the appointment match a null caller', () => {
    // Both sides absent must not read as "the same person".
    expect(
      participantRole(
        { patient_id: PATIENT_ID, practitioner_id: null },
        { practitionerId: null, patientId: null },
      ),
    ).toBeNull();
  });

  it('gives host rights to the clinician only', () => {
    expect(isHost('practitioner')).toBe(true);
    expect(isHost('patient')).toBe(false);
  });
});

describe('roomExpiry', () => {
  it('expires two hours after the appointment starts', () => {
    expect(roomExpiry(START).toISOString()).toBe('2026-08-10T11:00:00.000Z');
    expect(ROOM_LIFETIME_HOURS).toBe(2);
  });

  it('reports the same instant in Unix seconds for the provider', () => {
    expect(roomExpiryUnix(START)).toBe(Math.floor(Date.UTC(2026, 7, 10, 11, 0, 0) / 1000));
  });

  it('honours an overridden lifetime', () => {
    expect(roomExpiry(START, 4).toISOString()).toBe('2026-08-10T13:00:00.000Z');
  });
});

describe('roomNameForAppointment', () => {
  it('produces a provider-safe name derived from the appointment', () => {
    const name = roomNameForAppointment(APPOINTMENT_ID);
    expect(name).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(name).toBe(`mc-${APPOINTMENT_ID.replace(/-/g, '')}`);
  });

  it('is stable, so re-creating a room lands on the same one', () => {
    expect(roomNameForAppointment(APPOINTMENT_ID)).toBe(roomNameForAppointment(APPOINTMENT_ID));
  });
});

describe('isJoinable', () => {
  it('opens exactly fifteen minutes before the start', () => {
    expect(JOIN_WINDOW_MINUTES).toBe(15);
    expect(isJoinable(START, minutesFromStart(-16))).toBe(false);
    expect(isJoinable(START, minutesFromStart(-15))).toBe(true);
  });

  it('stays open through the consultation', () => {
    expect(isJoinable(START, minutesFromStart(0))).toBe(true);
    expect(isJoinable(START, minutesFromStart(45))).toBe(true);
  });

  it('closes when the room expires, because the provider ejects everyone', () => {
    expect(isJoinable(START, minutesFromStart(119))).toBe(true);
    expect(isJoinable(START, minutesFromStart(120))).toBe(false);
  });

  it('reports the countdown for the appointment list', () => {
    expect(minutesUntilStart(START, minutesFromStart(-10))).toBe(10);
    expect(minutesUntilStart(START, minutesFromStart(5))).toBe(-5);
  });
});

describe('sessionDurationSeconds', () => {
  it('measures the call in whole seconds', () => {
    expect(sessionDurationSeconds(START, minutesFromStart(12))).toBe(720);
  });

  it('truncates a part-second rather than rounding it up', () => {
    expect(sessionDurationSeconds(START, new Date(START.getTime() + 1_900))).toBe(1);
  });

  it('clamps a backwards clock to zero instead of billing a negative', () => {
    expect(sessionDurationSeconds(START, minutesFromStart(-5))).toBe(0);
  });
});

describe('billableMinutes', () => {
  it('rounds a part minute up, which is how a consultation is charged', () => {
    expect(billableMinutes(61)).toBe(2);
    expect(billableMinutes(600)).toBe(10);
  });

  it('charges nothing for a call that never connected', () => {
    expect(billableMinutes(0)).toBe(0);
    expect(billableMinutes(-30)).toBe(0);
  });
});

describe('teleconsultNoteStub', () => {
  it('records only what the system knows and leaves the clinical content empty', () => {
    const stub = teleconsultNoteStub({
      provider: 'daily',
      startedAt: START,
      endedAt: minutesFromStart(20),
      durationSeconds: 1_200,
    });

    expect(stub).toContain('Teleconsultation (daily)');
    expect(stub).toContain('Duration 20 minutes');
    expect(stub).toContain('to be completed by the attending clinician');
  });

  it('reads correctly for a one-minute call', () => {
    expect(
      teleconsultNoteStub({
        provider: 'mock',
        startedAt: START,
        endedAt: minutesFromStart(1),
        durationSeconds: 60,
      }),
    ).toContain('Duration 1 minute.');
  });
});
