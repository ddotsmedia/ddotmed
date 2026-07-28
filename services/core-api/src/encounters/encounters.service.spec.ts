import { BadRequestException } from '@nestjs/common';
import { EncountersService } from './encounters.module';
import type { PrismaService } from '../common/prisma.service';
import type { KafkaService } from '../messaging/kafka.service';
import { requestContext, type RequestContext } from '../common/tenant-context';

const ENCOUNTER_ID = '0193c3f0-0000-7000-8000-0000000000e1';
const PATIENT_ID = '0193c3f0-0000-7000-8000-0000000000p1';
const APPOINTMENT_ID = '0193c3f0-0000-7000-8000-0000000000c1';

const ctx: RequestContext = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  roles: ['doctor'],
  permissions: ['encounter:write'],
  practitionerId: 'pr1',
  isBreakGlass: false,
  ip: null,
  userAgent: null,
  requestId: 'r1',
};

const run = <T>(fn: () => Promise<T>): Promise<T> => requestContext.run(ctx, fn);

const encounter = (over: Record<string, unknown> = {}) => ({
  id: ENCOUNTER_ID,
  tenant_id: 't1',
  patient_id: PATIENT_ID,
  practitioner_id: 'pr1',
  location_id: null,
  appointment_id: null,
  status: 'in_progress',
  class: 'AMB',
  period_start: new Date('2026-07-28T09:00:00Z'),
  period_end: null,
  discharge_disposition: null,
  discharge_summary_id: null,
  fhir_id: null,
  ...over,
});

const appointment = (over: Record<string, unknown> = {}) => ({
  id: APPOINTMENT_ID,
  tenant_id: 't1',
  patient_id: PATIENT_ID,
  practitioner_id: 'pr9',
  location_id: 'loc1',
  status: 'booked',
  service_type: 'Cardiology follow-up',
  reason_text: 'Palpitations',
  checked_in_at: null,
  ...over,
});

describe('EncountersService', () => {
  let prisma: PrismaService;
  let kafka: KafkaService;
  let service: EncountersService;

  beforeEach(() => {
    prisma = {
      encounter: {
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve(encounter(args.data)),
        ),
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue(encounter()),
        update: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve(encounter(args.data)),
        ),
      },
      appointment: {
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue(appointment()),
      },
    } as unknown as PrismaService;
    kafka = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaService;
    service = new EncountersService(prisma, kafka);
  });

  describe('open', () => {
    it('opens a walk-in chart straight into in_progress', async () => {
      await run(() => service.open({ patient_id: PATIENT_ID, class: 'AMB' }));
      const data = (prisma.encounter.create as jest.Mock).mock.calls[0][0].data;
      expect(data.status).toBe('in_progress');
      expect(data.patient_id).toBe(PATIENT_ID);
      expect(data.appointment_id).toBeNull();
      expect(data.practitioner_id).toBe('pr1');
    });

    it('requires a patient when there is no appointment to take one from', async () => {
      await expect(run(() => service.open({ class: 'AMB' }))).rejects.toThrow(/patient_id is required/);
    });

    it('inherits patient, clinician and location from the appointment', async () => {
      (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(appointment());

      await run(() => service.open({ appointment_id: APPOINTMENT_ID, class: 'AMB' }));

      const data = (prisma.encounter.create as jest.Mock).mock.calls[0][0].data;
      expect(data.patient_id).toBe(PATIENT_ID);
      expect(data.practitioner_id).toBe('pr9');
      expect(data.location_id).toBe('loc1');
      expect(data.type_display).toBe('Cardiology follow-up');
      expect(data.reason_text).toBe('Palpitations');
    });

    it('checks the patient in so the waiting room stops showing them', async () => {
      (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(appointment());
      await run(() => service.open({ appointment_id: APPOINTMENT_ID, class: 'AMB' }));
      expect(prisma.appointment.update).toHaveBeenCalledWith({
        where: { id: APPOINTMENT_ID },
        data: expect.objectContaining({ status: 'checked_in' }),
      });
    });

    it('returns the existing chart rather than opening a second one for the same visit', async () => {
      (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(appointment());
      (prisma.encounter.findFirst as jest.Mock).mockResolvedValue(encounter({ id: 'already-open' }));

      const result = await run(() => service.open({ appointment_id: APPOINTMENT_ID, class: 'AMB' }));

      expect(result.id).toBe('already-open');
      expect(prisma.encounter.create).not.toHaveBeenCalled();
    });

    it('rejects an appointment that belongs to a different patient', async () => {
      (prisma.appointment.findFirst as jest.Mock).mockResolvedValue(appointment());
      await expect(
        run(() =>
          service.open({
            appointment_id: APPOINTMENT_ID,
            patient_id: '0193c3f0-0000-7000-8000-0000000000p2',
            class: 'AMB',
          }),
        ),
      ).rejects.toThrow(/different patient/);
    });

    it('rejects an appointment that does not exist', async () => {
      await expect(
        run(() => service.open({ appointment_id: APPOINTMENT_ID, class: 'AMB' })),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('close', () => {
    beforeEach(() => {
      (prisma.encounter.findFirst as jest.Mock).mockResolvedValue(encounter());
    });

    it('closes the encounter and stamps the end of the visit', async () => {
      await run(() => service.close(ENCOUNTER_ID, {}));
      const data = (prisma.encounter.update as jest.Mock).mock.calls[0][0].data;
      expect(data.status).toBe('closed');
      expect(data.period_end).toBeInstanceOf(Date);
    });

    it('emits a FHIR sync event carrying the Encounter resource', async () => {
      (prisma.encounter.findUnique as jest.Mock).mockResolvedValue(
        encounter({ status: 'closed', period_end: new Date('2026-07-28T10:00:00Z') }),
      );

      await run(() => service.close(ENCOUNTER_ID, { disposition: 'home' }));

      expect(kafka.emit).toHaveBeenCalledTimes(1);
      const [topic, key, event] = (kafka.emit as jest.Mock).mock.calls[0];
      expect(topic).toBe('medicore.fhir.sync');
      expect(key).toBe('t1');
      expect(event).toMatchObject({
        tenant_id: 't1',
        resource_type: 'Encounter',
        internal_id: ENCOUNTER_ID,
        operation: 'update',
      });
      expect(event.payload).toBeDefined();
      expect(typeof event.occurred_at).toBe('string');
    });

    it('records the disposition and discharge summary when supplied', async () => {
      await run(() =>
        service.close(ENCOUNTER_ID, { disposition: 'home', summary_note_id: 'note-1' }),
      );
      const data = (prisma.encounter.update as jest.Mock).mock.calls[0][0].data;
      expect(data.discharge_disposition).toBe('home');
      expect(data.discharge_summary_id).toBe('note-1');
    });

    it('keeps a period_end that was already set', async () => {
      const ended = new Date('2026-07-28T10:30:00Z');
      (prisma.encounter.findFirst as jest.Mock).mockResolvedValue(encounter({ period_end: ended }));
      await run(() => service.close(ENCOUNTER_ID, {}));
      expect((prisma.encounter.update as jest.Mock).mock.calls[0][0].data.period_end).toBe(ended);
    });

    it('fulfils the linked appointment', async () => {
      (prisma.encounter.findFirst as jest.Mock).mockResolvedValue(
        encounter({ appointment_id: APPOINTMENT_ID }),
      );
      await run(() => service.close(ENCOUNTER_ID, {}));
      expect(prisma.appointment.update).toHaveBeenCalledWith({
        where: { id: APPOINTMENT_ID },
        data: { status: 'fulfilled' },
      });
    });

    it('refuses to close an already closed encounter', async () => {
      (prisma.encounter.findFirst as jest.Mock).mockResolvedValue(encounter({ status: 'closed' }));
      await expect(run(() => service.close(ENCOUNTER_ID, {}))).rejects.toThrow(/already closed/);
      expect(kafka.emit).not.toHaveBeenCalled();
    });

    it('refuses to close a cancelled encounter', async () => {
      (prisma.encounter.findFirst as jest.Mock).mockResolvedValue(encounter({ status: 'cancelled' }));
      await expect(run(() => service.close(ENCOUNTER_ID, {}))).rejects.toThrow(/cancelled/);
    });

    it('rejects an encounter that does not exist', async () => {
      (prisma.encounter.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(run(() => service.close(ENCOUNTER_ID, {}))).rejects.toThrow(BadRequestException);
    });
  });
});
