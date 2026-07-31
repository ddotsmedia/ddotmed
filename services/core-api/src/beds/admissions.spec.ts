/**
 * Admission, transfer and discharge through the service.
 *
 * Every assertion is about something that left the service — a bed claimed, a
 * chart closed, an event published — because an ADT step that half-completes
 * leaves a patient with no bed or a bed with two patients.
 */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { AdmissionsService } from './admissions.controller';
import { BedsService } from './beds.module';
import type { PrismaService } from '../common/prisma.service';
import type { KafkaService } from '../messaging/kafka.service';
import type { RealtimeGateway } from '../messaging/realtime.gateway';
import { requestContext, type RequestContext } from '../common/tenant-context';

const BED_ID = '0193c3f0-0000-7000-8000-0000000000b1';
const TARGET_BED_ID = '0193c3f0-0000-7000-8000-0000000000b2';
const PATIENT_ID = '0193c3f0-0000-7000-8000-000000000001';
const DOCTOR_ID = '0193c3f0-0000-7000-8000-0000000000d1';
const ADMISSION_ID = '0193c3f0-0000-7000-8000-0000000000a1';
const ENCOUNTER_ID = '0193c3f0-0000-7000-8000-0000000000e1';

const ctx: RequestContext = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  roles: ['nurse'],
  permissions: ['adt:manage', 'bed:manage'],
  isBreakGlass: false,
  ip: null,
  userAgent: null,
  requestId: 'r1',
};

const run = <T>(fn: () => Promise<T>): Promise<T> => requestContext.run(ctx, fn);

const bed = (over: Record<string, unknown> = {}) => ({
  id: BED_ID,
  tenant_id: 't1',
  location_id: 'loc1',
  ward: 'Ward A',
  room: '101',
  bed_number: '1',
  status: 'available',
  housekeeping_status: 'clean',
  isolation_flag: false,
  isolation_reason: null,
  gender_restriction: null,
  ward_id: null,
  bed_type: 'general',
  ...over,
});

const admission = (over: Record<string, unknown> = {}) => ({
  id: ADMISSION_ID,
  tenant_id: 't1',
  patient_id: PATIENT_ID,
  encounter_id: ENCOUNTER_ID,
  bed_id: BED_ID,
  admission_number: 'ADM-2026-000001',
  admitting_doctor_id: DOCTOR_ID,
  attending_doctor_id: null,
  status: 'admitted',
  admitted_at: new Date('2026-07-28T09:00:00Z'),
  discharged_at: null,
  expected_discharge_at: null,
  bed: bed({ status: 'occupied' }),
  ...over,
});

describe('AdmissionsService', () => {
  let prisma: PrismaService;
  let kafka: KafkaService;
  let realtime: RealtimeGateway;
  let service: AdmissionsService;
  let tx: Record<string, Record<string, jest.Mock>>;

  beforeEach(() => {
    tx = {
      bed: {
        findFirst: jest.fn().mockResolvedValue(bed()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(bed()),
      },
      patient: { findFirst: jest.fn().mockResolvedValue({ id: PATIENT_ID, gender: 'female' }) },
      admission: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve(admission(args.data)),
        ),
        update: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve(admission(args.data)),
        ),
      },
      encounter: {
        create: jest.fn().mockResolvedValue({ id: ENCOUNTER_ID }),
        update: jest.fn().mockResolvedValue({ id: ENCOUNTER_ID }),
      },
      condition: { create: jest.fn().mockResolvedValue({}) },
      clinicalNote: { create: jest.fn().mockResolvedValue({}) },
      housekeepingTask: { create: jest.fn().mockResolvedValue({}), updateMany: jest.fn() },
      transfer: { create: jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve({ id: 'tr1', ...args.data })) },
      appointment: { create: jest.fn().mockResolvedValue({ id: 'appt1' }) },
    };

    prisma = {
      admission: { findFirst: jest.fn().mockResolvedValue(null), findMany: jest.fn().mockResolvedValue([]) },
      bed: {
        findFirst: jest.fn().mockResolvedValue(bed()),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn((args: { data: Record<string, unknown> }) => Promise.resolve(bed(args.data))),
      },
      housekeepingTask: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;

    kafka = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaService;
    realtime = {
      emitToTenant: jest.fn(),
      emitToRoles: jest.fn(),
      emitToChannel: jest.fn(),
    } as unknown as RealtimeGateway;

    service = new AdmissionsService(
      prisma,
      kafka,
      realtime,
      new BedsService(prisma, kafka, realtime),
    );
  });

  const adtEvents = () =>
    (kafka.emit as jest.Mock).mock.calls.filter((c) => c[0] === 'medicore.adt');

  const admitDto = {
    patient_id: PATIENT_ID,
    bed_id: BED_ID,
    admission_type: 'elective' as const,
    admitting_practitioner_id: DOCTOR_ID,
  };

  describe('admit', () => {
    it('claims the bed and opens an inpatient chart', async () => {
      const result = await run(() => service.admit(admitDto));

      expect(tx.bed.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'occupied' } }),
      );
      expect(tx.encounter.create.mock.calls[0][0].data.class).toBe('IMP');
      expect(tx.encounter.create.mock.calls[0][0].data.status).toBe('in_progress');
      expect(result.encounter_id).toBe(ENCOUNTER_ID);
      expect(tx.admission.create.mock.calls[0][0].data.status).toBe('admitted');
    });

    it('refuses a bed that has not been cleaned, with 409', async () => {
      tx.bed.findFirst.mockResolvedValue(bed({ housekeeping_status: 'dirty' }));

      let thrown: unknown;
      await run(() => service.admit(admitDto)).catch((e: unknown) => {
        thrown = e;
      });

      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as ConflictException).getStatus()).toBe(409);
      const body = (thrown as ConflictException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('BED_UNAVAILABLE');
      expect(body.housekeeping_status).toBe('dirty');
      expect(String(body.message)).toMatch(/not been cleaned/);
      expect(tx.admission.create).not.toHaveBeenCalled();
    });

    it('refuses a bed still being cleaned', async () => {
      tx.bed.findFirst.mockResolvedValue(bed({ housekeeping_status: 'in_progress' }));
      await expect(run(() => service.admit(admitDto))).rejects.toThrow(ConflictException);
    });

    it('refuses an occupied bed', async () => {
      tx.bed.findFirst.mockResolvedValue(bed({ status: 'occupied' }));
      let thrown: unknown;
      await run(() => service.admit(admitDto)).catch((e: unknown) => {
        thrown = e;
      });
      const body = (thrown as ConflictException).getResponse() as Record<string, unknown>;
      expect(String(body.message)).toContain('occupied');
      expect(tx.admission.create).not.toHaveBeenCalled();
    });

    it('refuses when the bed is taken between the read and the claim', async () => {
      tx.bed.updateMany.mockResolvedValue({ count: 0 });
      await expect(run(() => service.admit(admitDto))).rejects.toThrow(/just taken/);
      expect(tx.admission.create).not.toHaveBeenCalled();
    });

    it('refuses to put a patient in two beds at once', async () => {
      tx.admission.findFirst.mockResolvedValue(admission());
      let thrown: unknown;
      await run(() => service.admit(admitDto)).catch((e: unknown) => {
        thrown = e;
      });
      expect(
        ((thrown as ConflictException).getResponse() as Record<string, unknown>).code,
      ).toBe('ALREADY_ADMITTED');
    });

    it('honours a gender-restricted bay', async () => {
      tx.bed.findFirst.mockResolvedValue(bed({ gender_restriction: 'male' }));
      await expect(run(() => service.admit(admitDto))).rejects.toThrow(/restricted to male/);
    });

    it('records the admitting diagnosis as a provisional encounter diagnosis', async () => {
      await run(() => service.admit({ ...admitDto, diagnosis_code: 'J18.9', diagnosis_display: 'Pneumonia' }));
      const condition = tx.condition.create.mock.calls[0][0].data;
      expect(condition.code).toBe('J18.9');
      expect(condition.verification_status).toBe('provisional');
      expect(condition.is_primary).toBe(true);
    });

    it('reuses a supplied chart instead of opening a second one', async () => {
      await run(() => service.admit({ ...admitDto, encounter_id: ENCOUNTER_ID }));
      expect(tx.encounter.create).not.toHaveBeenCalled();
    });

    it('publishes an ADT admit event', async () => {
      await run(() => service.admit(admitDto));
      const events = adtEvents();
      expect(events).toHaveLength(1);
      expect(events[0]![2]).toMatchObject({ event: 'admit', to_bed_id: BED_ID, patient_id: PATIENT_ID });
    });
  });

  describe('transfer', () => {
    beforeEach(() => {
      tx.admission.findFirst.mockResolvedValue(admission());
      tx.bed.findFirst.mockResolvedValue(bed({ id: TARGET_BED_ID, room: '202', bed_number: '4' }));
    });

    const transferDto = { to_bed_id: TARGET_BED_ID, reason: 'Step down from HDU', transfer_type: 'internal' as const };

    it('claims the target and releases the source as dirty', async () => {
      await run(() => service.transfer(ADMISSION_ID, transferDto));

      expect(tx.bed.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: TARGET_BED_ID }),
          data: expect.objectContaining({ status: 'occupied' }),
        }),
      );
      expect(tx.bed.update).toHaveBeenCalledWith({
        where: { id: BED_ID },
        data: { status: 'cleaning', housekeeping_status: 'dirty', current_admission_id: null },
      });
      expect(tx.housekeepingTask.create).toHaveBeenCalled();
    });

    it('moves the admission onto the new bed', async () => {
      await run(() => service.transfer(ADMISSION_ID, transferDto));
      expect(tx.admission.update).toHaveBeenCalledWith({
        where: { id: ADMISSION_ID },
        data: { bed_id: TARGET_BED_ID },
      });
    });

    it('refuses a dirty target and leaves the patient where they are', async () => {
      tx.bed.findFirst.mockResolvedValue(
        bed({ id: TARGET_BED_ID, housekeeping_status: 'dirty' }),
      );

      await expect(run(() => service.transfer(ADMISSION_ID, transferDto))).rejects.toThrow(
        ConflictException,
      );
      expect(tx.bed.update).not.toHaveBeenCalled();
      expect(tx.transfer.create).not.toHaveBeenCalled();
    });

    it('refuses when the target is claimed between the read and the write', async () => {
      tx.bed.updateMany.mockResolvedValue({ count: 0 });
      await expect(run(() => service.transfer(ADMISSION_ID, transferDto))).rejects.toThrow(
        /just taken/,
      );
      // The source bed is untouched: the patient still has somewhere to be.
      expect(tx.bed.update).not.toHaveBeenCalled();
    });

    it('refuses to transfer a discharged patient', async () => {
      tx.admission.findFirst.mockResolvedValue(admission({ status: 'discharged' }));
      await expect(run(() => service.transfer(ADMISSION_ID, transferDto))).rejects.toThrow(
        /not currently admitted/,
      );
    });

    it('refuses a transfer to the bed the patient is already in', async () => {
      await expect(
        run(() => service.transfer(ADMISSION_ID, { ...transferDto, to_bed_id: BED_ID })),
      ).rejects.toThrow(/already in that bed/);
    });

    it('records both wards on the transfer', async () => {
      await run(() => service.transfer(ADMISSION_ID, transferDto));
      const created = tx.transfer.create.mock.calls[0][0].data;
      expect(created.from_bed_id).toBe(BED_ID);
      expect(created.to_bed_id).toBe(TARGET_BED_ID);
      expect(created.status).toBe('completed');
    });

    it('publishes an ADT transfer event naming both beds', async () => {
      await run(() => service.transfer(ADMISSION_ID, transferDto));
      expect(adtEvents()[0]![2]).toMatchObject({
        event: 'transfer',
        from_bed_id: BED_ID,
        to_bed_id: TARGET_BED_ID,
      });
    });
  });

  describe('discharge', () => {
    beforeEach(() => {
      tx.admission.findFirst.mockResolvedValue(admission());
    });

    const dischargeDto = { discharge_disposition: 'home' };

    it('closes the inpatient chart', async () => {
      await run(() => service.discharge(ADMISSION_ID, dischargeDto));
      expect(tx.encounter.update).toHaveBeenCalledWith({
        where: { id: ENCOUNTER_ID },
        data: expect.objectContaining({ status: 'closed', discharge_disposition: 'home' }),
      });
      expect(tx.encounter.update.mock.calls[0][0].data.period_end).toBeInstanceOf(Date);
    });

    it('sends the bed for cleaning rather than straight back into service', async () => {
      await run(() => service.discharge(ADMISSION_ID, dischargeDto));
      expect(tx.bed.update).toHaveBeenCalledWith({
        where: { id: BED_ID },
        data: { status: 'cleaning', housekeeping_status: 'dirty', current_admission_id: null },
      });
      expect(tx.housekeepingTask.create).toHaveBeenCalled();
    });

    it('books the follow-up when a date was promised', async () => {
      await run(() =>
        service.discharge(ADMISSION_ID, {
          ...dischargeDto,
          follow_up_date: new Date('2026-08-15T09:00:00Z'),
        }),
      );
      const appointment = tx.appointment.create.mock.calls[0][0].data;
      expect(appointment.patient_id).toBe(PATIENT_ID);
      expect(appointment.status).toBe('booked');
      expect(appointment.minutes_duration).toBe(20);
      expect(appointment.reason_text).toContain('ADM-2026-000001');
    });

    it('books nothing when no follow-up was planned', async () => {
      await run(() => service.discharge(ADMISSION_ID, dischargeDto));
      expect(tx.appointment.create).not.toHaveBeenCalled();
    });

    it('files the discharge notes as a draft note', async () => {
      await run(() =>
        service.discharge(ADMISSION_ID, { ...dischargeDto, discharge_notes: 'Home with antibiotics.' }),
      );
      const note = tx.clinicalNote.create.mock.calls[0][0].data;
      expect(note.type).toBe('discharge');
      expect(note.status).toBe('draft');
    });

    it('reports the length of stay', async () => {
      const result = await run(() => service.discharge(ADMISSION_ID, dischargeDto));
      expect(result.length_of_stay_days).toBeGreaterThanOrEqual(0);
    });

    it('refuses to discharge twice', async () => {
      tx.admission.findFirst.mockResolvedValue(admission({ status: 'discharged' }));
      await expect(run(() => service.discharge(ADMISSION_ID, dischargeDto))).rejects.toThrow(
        /already been discharged/,
      );
      expect(tx.encounter.update).not.toHaveBeenCalled();
    });

    it('publishes an ADT discharge event', async () => {
      await run(() => service.discharge(ADMISSION_ID, dischargeDto));
      expect(adtEvents()[0]![2]).toMatchObject({ event: 'discharge' });
    });
  });

  describe('housekeeping', () => {
    it('starts a clean and marks the task in progress', async () => {
      (prisma.bed.findFirst as jest.Mock).mockResolvedValue(bed({ housekeeping_status: 'dirty', status: 'cleaning' }));

      await run(() => service.setHousekeeping(BED_ID, { housekeeping_status: 'in_progress' }));

      expect(tx.bed.update.mock.calls[0][0].data.housekeeping_status).toBe('in_progress');
      expect(tx.bed.update.mock.calls[0][0].data.status).toBeUndefined();
      expect(tx.housekeepingTask.updateMany.mock.calls[0][0].data.status).toBe('in_progress');
    });

    it('releases the bed for admission when it is signed off clean', async () => {
      (prisma.bed.findFirst as jest.Mock).mockResolvedValue(
        bed({ housekeeping_status: 'in_progress', status: 'cleaning' }),
      );

      await run(() => service.setHousekeeping(BED_ID, { housekeeping_status: 'clean' }));

      const data = tx.bed.update.mock.calls[0][0].data;
      expect(data.housekeeping_status).toBe('clean');
      expect(data.status).toBe('available');
      expect(tx.housekeepingTask.updateMany.mock.calls[0][0].data.status).toBe('completed');
    });

    it('does not free an occupied bed just because it was cleaned', async () => {
      (prisma.bed.findFirst as jest.Mock).mockResolvedValue(
        bed({ housekeeping_status: 'in_progress', status: 'occupied' }),
      );
      await run(() => service.setHousekeeping(BED_ID, { housekeeping_status: 'clean' }));
      expect(tx.bed.update.mock.calls[0][0].data.status).toBeUndefined();
    });

    it('rejects a jump from dirty straight to clean', async () => {
      (prisma.bed.findFirst as jest.Mock).mockResolvedValue(bed({ housekeeping_status: 'dirty' }));

      let thrown: unknown;
      await run(() => service.setHousekeeping(BED_ID, { housekeeping_status: 'clean' })).catch(
        (e: unknown) => {
          thrown = e;
        },
      );

      expect(thrown).toBeInstanceOf(BadRequestException);
      const body = (thrown as BadRequestException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('ILLEGAL_HOUSEKEEPING_TRANSITION');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('is a no-op when the status is already what was asked for', async () => {
      (prisma.bed.findFirst as jest.Mock).mockResolvedValue(bed({ housekeeping_status: 'clean' }));
      await run(() => service.setHousekeeping(BED_ID, { housekeeping_status: 'clean' }));
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects an unknown bed', async () => {
      (prisma.bed.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(
        run(() => service.setHousekeeping(BED_ID, { housekeeping_status: 'in_progress' })),
      ).rejects.toThrow(BadRequestException);
    });
  });

  describe('list', () => {
    it('maps status=active onto admitted and returns stay and EDD figures', async () => {
      (prisma.admission.findMany as jest.Mock).mockResolvedValue([
        admission({
          admitted_at: new Date('2026-07-28T09:00:00Z'),
          expected_discharge_at: new Date('2026-07-30T09:00:00Z'),
          patient: { id: PATIENT_ID, mrn: 'MRN1', given_names: ['A'], family_name: 'B', birth_date: new Date() },
          bed: bed(),
        }),
      ]);

      const rows = await run(() => service.list({ status: 'active' }));

      expect((prisma.admission.findMany as jest.Mock).mock.calls[0][0].where.status).toBe('admitted');
      expect(rows[0]!.length_of_stay_days).toBeGreaterThan(0);
      expect(rows[0]!.overdue).toBe(true);
    });
  });
});
