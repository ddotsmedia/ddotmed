/**
 * Teleconsultation through the service.
 *
 * The assertions here are about the two things that go wrong with video visits:
 * somebody who should not be in the room getting a way in, and a consultation that
 * happened leaving no trace — no duration, no chart entry, no charge.
 */
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { TelemedicineService } from './telemedicine.module';
import { MessagesService, ObjectStorageService } from './messages.controller';
import { VideoProviderService } from './video-provider.service';
import type { PrismaService } from '../common/prisma.service';
import type { KafkaService } from '../messaging/kafka.service';
import type { RealtimeGateway } from '../messaging/realtime.gateway';
import { requestContext, type RequestContext } from '../common/tenant-context';
import { MAX_ATTACHMENT_BYTES } from './presign';
import { roomNameForAppointment } from './teleconsult';

const APPOINTMENT_ID = '0193c3f0-0000-7000-8000-0000000000a1';
const SESSION_ID = '0193c3f0-0000-7000-8000-0000000000s1';
const PATIENT_ID = '0193c3f0-0000-7000-8000-000000000001';
const PRACTITIONER_ID = '0193c3f0-0000-7000-8000-0000000000d1';
const DOCTOR_USER_ID = '0193c3f0-0000-7000-8000-0000000000u1';
const ENCOUNTER_ID = '0193c3f0-0000-7000-8000-0000000000e1';
const NOTE_ID = '0193c3f0-0000-7000-8000-0000000000n1';

const START = new Date('2026-08-10T09:00:00Z');

const baseCtx: RequestContext = {
  tenantId: 't1',
  userId: DOCTOR_USER_ID,
  sessionId: 's1',
  roles: ['doctor'],
  permissions: ['patient:read', 'patient:write'],
  practitionerId: PRACTITIONER_ID,
  patientId: null,
  isBreakGlass: false,
  ip: null,
  userAgent: null,
  requestId: 'r1',
};

const asDoctor = <T>(fn: () => Promise<T>): Promise<T> => requestContext.run(baseCtx, fn);
const asPatient = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run(
    { ...baseCtx, roles: ['patient'], permissions: ['patient:read'], practitionerId: null, patientId: PATIENT_ID },
    fn,
  );
/** A receptionist: can see the appointment, is not in the consultation. */
const asReceptionist = <T>(fn: () => Promise<T>): Promise<T> =>
  requestContext.run(
    {
      ...baseCtx,
      roles: ['receptionist'],
      permissions: ['patient:read', 'patient:write'],
      practitionerId: null,
      patientId: null,
    },
    fn,
  );

const appointment = (over: Record<string, unknown> = {}) => ({
  id: APPOINTMENT_ID,
  tenant_id: 't1',
  patient_id: PATIENT_ID,
  practitioner_id: PRACTITIONER_ID,
  location_id: null,
  status: 'booked',
  service_type: 'Follow-up',
  start: START,
  is_telehealth: true,
  teleconsult_url: null,
  teleconsult_room_id: null,
  teleconsult_provider: null,
  patient: { id: PATIENT_ID, given_names: ['Amina'], family_name: 'Rahman' },
  practitioner: {
    id: PRACTITIONER_ID,
    user_id: DOCTOR_USER_ID,
    given_names: ['Yusuf'],
    family_name: 'Kaya',
  },
  ...over,
});

const session = (over: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  tenant_id: 't1',
  appointment_id: APPOINTMENT_ID,
  room_id: roomNameForAppointment(APPOINTMENT_ID),
  provider: 'mock',
  started_at: START,
  ended_at: null,
  duration_seconds: null,
  recording_url: null,
  created_at: START,
  ...over,
});

const configOf = (values: Record<string, string | undefined>) =>
  ({ get: (key: string) => values[key] }) as unknown as ConfigService;

describe('TelemedicineService', () => {
  let prisma: PrismaService;
  let kafka: KafkaService;
  let video: VideoProviderService;
  let service: TelemedicineService;

  beforeEach(() => {
    prisma = {
      appointment: {
        findFirst: jest.fn().mockResolvedValue(appointment()),
        update: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve(appointment(args.data)),
        ),
      },
      teleconsultSession: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve(session(args.data)),
        ),
        update: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve(session(args.data)),
        ),
        findMany: jest.fn().mockResolvedValue([]),
      },
      encounter: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: ENCOUNTER_ID }),
      },
      clinicalNote: { create: jest.fn().mockResolvedValue({ id: NOTE_ID }) },
    } as unknown as PrismaService;

    kafka = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaService;
    // No DAILY_API_KEY: the mock provider, which is the development path.
    video = new VideoProviderService(configOf({ WEB_PUBLIC_URL: 'https://clinic.example' }));
    service = new TelemedicineService(prisma, kafka, video);
  });

  const billingEvents = () =>
    (kafka.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'medicore.billing');

  describe('createRoom', () => {
    it('creates a room that expires two hours after the appointment starts', async () => {
      const result = await asDoctor(() =>
        service.createRoom({ appointment_id: APPOINTMENT_ID, lifetime_hours: 2 }),
      );

      expect(result.expires_at).toBe('2026-08-10T11:00:00.000Z');
      expect(result.room_id).toBe(roomNameForAppointment(APPOINTMENT_ID));
      expect(result.provider).toBe('mock');
      expect(result.is_mock).toBe(true);
    });

    it('honours an overridden room lifetime', async () => {
      const result = await asDoctor(() =>
        service.createRoom({ appointment_id: APPOINTMENT_ID, lifetime_hours: 4 }),
      );
      expect(result.expires_at).toBe('2026-08-10T13:00:00.000Z');
    });

    it('stamps the room onto the appointment so it can be re-joined', async () => {
      await asDoctor(() =>
        service.createRoom({ appointment_id: APPOINTMENT_ID, lifetime_hours: 2 }),
      );

      const data = (prisma.appointment.update as jest.Mock).mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.teleconsult_room_id).toBe(roomNameForAppointment(APPOINTMENT_ID));
      expect(data.teleconsult_provider).toBe('mock');
      expect(data.is_telehealth).toBe(true);
      // The portal has always read telehealth_url; it must point at the same room.
      expect(data.telehealth_url).toBe(data.teleconsult_url);
    });

    it('hands the practitioner a host token', async () => {
      const result = await asDoctor(() =>
        service.createRoom({ appointment_id: APPOINTMENT_ID, lifetime_hours: 2 }),
      );
      expect(result.role).toBe('practitioner');
      expect(result.is_host).toBe(true);
      expect(result.token).toBeTruthy();
    });

    it('lets scheduling staff provision a room but gives them no token', async () => {
      const result = await asReceptionist(() =>
        service.createRoom({ appointment_id: APPOINTMENT_ID, lifetime_hours: 2 }),
      );
      expect(result.role).toBeNull();
      expect(result.token).toBeNull();
      expect(result.room_url).toBeTruthy();
    });

    it('refuses a cancelled appointment', async () => {
      (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
        appointment({ status: 'cancelled' }),
      );
      await expect(
        asDoctor(() => service.createRoom({ appointment_id: APPOINTMENT_ID, lifetime_hours: 2 })),
      ).rejects.toThrow('cancelled');
    });
  });

  describe('joinToken', () => {
    it('gives the patient a guest token on the same room', async () => {
      const result = await asPatient(() => service.joinToken(APPOINTMENT_ID));

      expect(result.role).toBe('patient');
      expect(result.is_host).toBe(false);
      expect(result.token).toBeTruthy();
      expect(result.room_id).toBe(roomNameForAppointment(APPOINTMENT_ID));
    });

    it('gives the practitioner a different token from the patient', async () => {
      const doctorToken = (await asDoctor(() => service.joinToken(APPOINTMENT_ID))).token;
      const patientToken = (await asPatient(() => service.joinToken(APPOINTMENT_ID))).token;

      expect(doctorToken).toBeTruthy();
      expect(patientToken).toBeTruthy();
      expect(doctorToken).not.toBe(patientToken);
    });

    it('refuses a caller who is on neither side of the appointment, with 403', async () => {
      let thrown: unknown;
      await asReceptionist(() => service.joinToken(APPOINTMENT_ID)).catch((e: unknown) => {
        thrown = e;
      });

      expect(thrown).toBeInstanceOf(ForbiddenException);
      expect((thrown as ForbiddenException).getStatus()).toBe(403);
    });

    it('refuses a clinician who is not the one on the appointment, with 403', async () => {
      const other = { ...baseCtx, practitionerId: 'another-practitioner-id' };
      let thrown: unknown;
      await requestContext
        .run(other, () => service.joinToken(APPOINTMENT_ID))
        .catch((e: unknown) => {
          thrown = e;
        });

      expect(thrown).toBeInstanceOf(ForbiddenException);
    });

    it('creates the room on demand when nobody has provisioned one', async () => {
      await asPatient(() => service.joinToken(APPOINTMENT_ID));
      expect(prisma.appointment.update).toHaveBeenCalled();
    });

    it('reuses the room already on the appointment', async () => {
      (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
        appointment({
          teleconsult_url: 'https://clinic.example/room/mock/mc-existing',
          teleconsult_room_id: 'mc-existing',
          teleconsult_provider: 'mock',
        }),
      );

      const result = await asPatient(() => service.joinToken(APPOINTMENT_ID));

      expect(result.room_id).toBe('mc-existing');
      expect(prisma.appointment.update).not.toHaveBeenCalled();
    });

    it('puts both participants in the one open session', async () => {
      (prisma.teleconsultSession.findFirst as jest.Mock).mockResolvedValue(session());

      const doctor = await asDoctor(() => service.joinToken(APPOINTMENT_ID));
      const patient = await asPatient(() => service.joinToken(APPOINTMENT_ID));

      expect(doctor.session_id).toBe(SESSION_ID);
      expect(patient.session_id).toBe(SESSION_ID);
      expect(prisma.teleconsultSession.create).not.toHaveBeenCalled();
    });
  });

  describe('endSession', () => {
    beforeEach(() => {
      (prisma.teleconsultSession.findFirst as jest.Mock).mockResolvedValue(session());
    });

    it('records the end time and the duration in seconds', async () => {
      const endedAt = new Date('2026-08-10T09:18:30Z');
      const result = await asDoctor(() => service.endSession(SESSION_ID, { ended_at: endedAt }));

      expect(result.duration_seconds).toBe(1_110);
      const data = (prisma.teleconsultSession.update as jest.Mock).mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.ended_at).toBe(endedAt);
      expect(data.duration_seconds).toBe(1_110);
    });

    it('bills part minutes as whole minutes', async () => {
      const result = await asDoctor(() =>
        service.endSession(SESSION_ID, { ended_at: new Date('2026-08-10T09:18:30Z') }),
      );
      expect(result.billable_minutes).toBe(19);
    });

    it('opens a virtual encounter and files a draft note stub against it', async () => {
      const result = await asDoctor(() =>
        service.endSession(SESSION_ID, { ended_at: new Date('2026-08-10T09:20:00Z') }),
      );

      expect((prisma.encounter.create as jest.Mock).mock.calls[0][0].data.class).toBe('VR');
      const note = (prisma.clinicalNote.create as jest.Mock).mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(note.status).toBe('draft');
      expect(note.author_id).toBe(DOCTOR_USER_ID);
      expect(String(note.body)).toContain('Teleconsultation');
      expect(result.note_id).toBe(NOTE_ID);
    });

    it('attributes the note to the clinician even when the patient hung up', async () => {
      await asPatient(() =>
        service.endSession(SESSION_ID, { ended_at: new Date('2026-08-10T09:20:00Z') }),
      );

      const note = (prisma.clinicalNote.create as jest.Mock).mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(note.author_id).toBe(DOCTOR_USER_ID);
    });

    it('reuses an encounter the consultation already had', async () => {
      (prisma.encounter.findFirst as jest.Mock).mockResolvedValue({ id: ENCOUNTER_ID });

      const result = await asDoctor(() => service.endSession(SESSION_ID, {}));

      expect(prisma.encounter.create).not.toHaveBeenCalled();
      expect(result.encounter_id).toBe(ENCOUNTER_ID);
    });

    it('skips the note rather than misattributing it when no clinician account exists', async () => {
      (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(
        appointment({ practitioner: { id: PRACTITIONER_ID, user_id: null, given_names: ['Y'], family_name: 'K' } }),
      );

      const result = await asDoctor(() => service.endSession(SESSION_ID, {}));

      expect(prisma.clinicalNote.create).not.toHaveBeenCalled();
      expect(result.note_id).toBeNull();
      expect(result.encounter_id).toBe(ENCOUNTER_ID);
    });

    it('publishes teleconsult_completed for billing, with the duration', async () => {
      await asDoctor(() =>
        service.endSession(SESSION_ID, { ended_at: new Date('2026-08-10T09:20:00Z') }),
      );

      expect(billingEvents()).toHaveLength(1);
      const event = billingEvents()[0][2] as Record<string, unknown>;
      expect(event.event).toBe('teleconsult_completed');
      expect(event.duration_seconds).toBe(1_200);
      expect(event.billable_minutes).toBe(20);
      expect(event.appointment_id).toBe(APPOINTMENT_ID);
      expect(event.encounter_id).toBe(ENCOUNTER_ID);
    });

    it('refuses a caller who was not in the consultation, with 403', async () => {
      let thrown: unknown;
      await asReceptionist(() => service.endSession(SESSION_ID, {})).catch((e: unknown) => {
        thrown = e;
      });
      expect(thrown).toBeInstanceOf(ForbiddenException);
    });

    it('is idempotent: the second hang-up neither re-bills nor re-notes', async () => {
      (prisma.teleconsultSession.findFirst as jest.Mock).mockResolvedValue(
        session({ ended_at: new Date('2026-08-10T09:20:00Z'), duration_seconds: 1_200 }),
      );

      const result = await asPatient(() => service.endSession(SESSION_ID, {}));

      expect(result.already_ended).toBe(true);
      expect(result.duration_seconds).toBe(1_200);
      expect(prisma.teleconsultSession.update).not.toHaveBeenCalled();
      expect(prisma.clinicalNote.create).not.toHaveBeenCalled();
      expect(billingEvents()).toHaveLength(0);
    });
  });
});

describe('MessagesService', () => {
  let prisma: PrismaService;
  let realtime: RealtimeGateway;
  let storage: ObjectStorageService;
  let service: MessagesService;

  const minioConfig = {
    MINIO_ENDPOINT: 'http://localhost:9000',
    MINIO_ACCESS_KEY: 'medicore',
    MINIO_SECRET_KEY: 'medicore_dev_secret',
    MINIO_BUCKET: 'medicore-attachments',
  };

  const build = (config: Record<string, string | undefined> = minioConfig) => {
    storage = new ObjectStorageService(configOf(config));
    service = new MessagesService(prisma, realtime, storage);
  };

  beforeEach(() => {
    prisma = {
      appointment: { findFirst: jest.fn().mockResolvedValue(appointment()) },
      appointmentMessage: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'm1', created_at: START, attachment_url: null, ...args.data }),
        ),
        updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    } as unknown as PrismaService;
    realtime = { emitToChannel: jest.fn() } as unknown as RealtimeGateway;
    build();
  });

  describe('attachmentUpload', () => {
    it('mints a presigned PUT under the tenant and appointment prefix', async () => {
      const result = await asPatient(() =>
        service.attachmentUpload({
          appointment_id: APPOINTMENT_ID,
          filename: 'blood-panel.pdf',
          content_type: 'application/pdf',
          size_bytes: 2_000_000,
        }),
      );

      expect(result.object_key).toBe(
        `tenants/t1/appointments/${APPOINTMENT_ID}/messages/${result.object_key.split('/').pop()}`,
      );
      expect(result.object_key).toMatch(/blood-panel\.pdf$/);

      const url = new URL(result.upload_url);
      expect(url.origin).toBe('http://localhost:9000');
      expect(url.pathname.startsWith('/medicore-attachments/tenants/t1/')).toBe(true);
      expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
      expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
      expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
      expect(result.required_headers['content-type']).toBe('application/pdf');
      expect(result.max_bytes).toBe(MAX_ATTACHMENT_BYTES);
    });

    it('chooses the object key itself so a client cannot overwrite another', async () => {
      const first = await asPatient(() =>
        service.attachmentUpload({
          appointment_id: APPOINTMENT_ID,
          filename: 'scan.pdf',
          content_type: 'application/pdf',
          size_bytes: 100,
        }),
      );
      const second = await asPatient(() =>
        service.attachmentUpload({
          appointment_id: APPOINTMENT_ID,
          filename: 'scan.pdf',
          content_type: 'application/pdf',
          size_bytes: 100,
        }),
      );
      expect(first.object_key).not.toBe(second.object_key);
    });

    it('refuses a file over 10 MB before a byte is uploaded', async () => {
      await expect(
        asPatient(() =>
          service.attachmentUpload({
            appointment_id: APPOINTMENT_ID,
            filename: 'scan.pdf',
            content_type: 'application/pdf',
            size_bytes: MAX_ATTACHMENT_BYTES + 1,
          }),
        ),
      ).rejects.toThrow(/10 MB/);
    });

    it('accepts a file exactly at the limit', async () => {
      await expect(
        asPatient(() =>
          service.attachmentUpload({
            appointment_id: APPOINTMENT_ID,
            filename: 'scan.pdf',
            content_type: 'application/pdf',
            size_bytes: MAX_ATTACHMENT_BYTES,
          }),
        ),
      ).resolves.toBeDefined();
    });

    it('refuses a non-participant, with 403', async () => {
      let thrown: unknown;
      await asReceptionist(() =>
        service.attachmentUpload({
          appointment_id: APPOINTMENT_ID,
          filename: 'scan.pdf',
          content_type: 'application/pdf',
          size_bytes: 100,
        }),
      ).catch((e: unknown) => {
        thrown = e;
      });
      expect(thrown).toBeInstanceOf(ForbiddenException);
    });

    it('says so plainly when object storage has no credentials', async () => {
      build({ MINIO_ENDPOINT: 'http://localhost:9000' });
      await expect(
        asPatient(() =>
          service.attachmentUpload({
            appointment_id: APPOINTMENT_ID,
            filename: 'scan.pdf',
            content_type: 'application/pdf',
            size_bytes: 100,
          }),
        ),
      ).rejects.toThrow(/not configured/);
    });
  });

  describe('thread', () => {
    it('re-signs each attachment on read instead of storing a lasting URL', async () => {
      (prisma.appointmentMessage.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'm1',
          sender_role: 'patient',
          body: 'Photo of the rash',
          attachment_url: `tenants/t1/appointments/${APPOINTMENT_ID}/messages/u1-rash.jpg`,
          attachment_name: 'rash.jpg',
          attachment_content_type: 'image/jpeg',
          attachment_size_bytes: 400_000,
          read_at: null,
          created_at: START,
        },
      ]);

      const result = await asPatient(() => service.thread(APPOINTMENT_ID));

      expect(result.messages[0].attachment_url).toContain('X-Amz-Signature=');
      expect(result.messages[0].is_mine).toBe(true);
      expect(result.viewer_role).toBe('patient');
    });

    it('marks the other side’s messages as not mine', async () => {
      (prisma.appointmentMessage.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'm1',
          sender_role: 'practitioner',
          body: 'Please send a photo',
          attachment_url: null,
          attachment_name: null,
          attachment_content_type: null,
          attachment_size_bytes: null,
          read_at: null,
          created_at: START,
        },
      ]);

      const result = await asPatient(() => service.thread(APPOINTMENT_ID));
      expect(result.messages[0].is_mine).toBe(false);
    });

    it('reports attachments as unavailable when storage is unconfigured', async () => {
      build({});
      const result = await asPatient(() => service.thread(APPOINTMENT_ID));
      expect(result.attachments_enabled).toBe(false);
    });

    it('refuses a non-participant, with 403', async () => {
      let thrown: unknown;
      await asReceptionist(() => service.thread(APPOINTMENT_ID)).catch((e: unknown) => {
        thrown = e;
      });
      expect(thrown).toBeInstanceOf(ForbiddenException);
    });
  });

  describe('send', () => {
    it('stamps the sender’s side from the token, not from the body', async () => {
      await asPatient(() => service.send({ appointment_id: APPOINTMENT_ID, body: 'Hello' }));

      const data = (prisma.appointmentMessage.create as jest.Mock).mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.sender_role).toBe('patient');
      expect(data.tenant_id).toBe('t1');
    });

    it('stores the object key rather than a URL', async () => {
      const key = `tenants/t1/appointments/${APPOINTMENT_ID}/messages/u1-scan.pdf`;
      await asPatient(() =>
        service.send({
          appointment_id: APPOINTMENT_ID,
          attachment_key: key,
          attachment_name: 'scan.pdf',
          attachment_size_bytes: 1_000,
        }),
      );

      const data = (prisma.appointmentMessage.create as jest.Mock).mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data.attachment_url).toBe(key);
    });

    it('pushes the message to the appointment channel', async () => {
      await asDoctor(() => service.send({ appointment_id: APPOINTMENT_ID, body: 'On my way' }));

      expect(realtime.emitToChannel).toHaveBeenCalledWith(
        't1',
        `appointment:${APPOINTMENT_ID}`,
        'message.created',
        expect.objectContaining({ sender_role: 'practitioner' }),
      );
    });

    it('refuses a non-participant, with 403', async () => {
      let thrown: unknown;
      await asReceptionist(() =>
        service.send({ appointment_id: APPOINTMENT_ID, body: 'hello' }),
      ).catch((e: unknown) => {
        thrown = e;
      });
      expect(thrown).toBeInstanceOf(ForbiddenException);
    });
  });

  describe('markRead', () => {
    it('marks only the other side’s messages', async () => {
      await asPatient(() => service.markRead({ appointment_id: APPOINTMENT_ID }));

      const where = (prisma.appointmentMessage.updateMany as jest.Mock).mock.calls[0][0]
        .where as Record<string, unknown>;
      expect(where.sender_role).toEqual({ not: 'patient' });
    });
  });
});
