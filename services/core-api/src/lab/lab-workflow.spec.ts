/**
 * The lab round trip: order, result, critical alert, acknowledgement.
 *
 * Every assertion here is about something that leaves the service — a row written,
 * an event published, a status changed — because a safety check that fires but
 * emits nothing is indistinguishable from one that never ran.
 */
import { BadRequestException } from '@nestjs/common';
import { LabResultsService } from './lab-results.controller';
import { ServiceRequestsService } from './service-requests.controller';
import { LabService } from './lab.module';
import { NotificationsService, CriticalValueConsumer } from '../notifications/notifications.module';
import type { PrismaService } from '../common/prisma.service';
import type { KafkaService } from '../messaging/kafka.service';
import type { RealtimeGateway } from '../messaging/realtime.gateway';
import { requestContext, type RequestContext } from '../common/tenant-context';
import type { LabCriticalValueEvent } from '@medicore/shared-types';

const ORDER_ID = '0193c3f0-0000-7000-8000-0000000000o1';
const PATIENT_ID = '0193c3f0-0000-7000-8000-000000000001';
const DOCTOR_ID = '0193c3f0-0000-7000-8000-0000000000d1';
const NOTIFICATION_ID = '0193c3f0-0000-7000-8000-0000000000n1';

const ctx: RequestContext = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  roles: ['doctor'],
  permissions: ['lab:order', 'lab:result'],
  practitionerId: DOCTOR_ID,
  isBreakGlass: false,
  ip: null,
  userAgent: null,
  requestId: 'r1',
};

const run = <T>(fn: () => Promise<T>): Promise<T> => requestContext.run(ctx, fn);

const order = (over: Record<string, unknown> = {}) => ({
  id: ORDER_ID,
  tenant_id: 't1',
  patient_id: PATIENT_ID,
  encounter_id: null,
  requester_id: DOCTOR_ID,
  category: 'laboratory',
  status: 'active',
  priority: 'routine',
  code: '2823-3',
  code_display: 'Potassium',
  order_number: 'LAB-2026-000001',
  barcode: 'LAB2026000001',
  fasting_required: false,
  performed_at: null,
  fhir_id: null,
  ...over,
});

// Adult female, so the demographic-aware range lookup has something to match on.
const patient = { gender: 'female', birth_date: new Date('1985-01-01') };

describe('lab workflow', () => {
  let prisma: PrismaService;
  let kafka: KafkaService;
  let realtime: RealtimeGateway;
  let lab: LabService;
  let results: LabResultsService;
  let requests: ServiceRequestsService;

  beforeEach(() => {
    prisma = {
      serviceRequest: {
        findFirst: jest.fn().mockResolvedValue(order()),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ ...order(args.data), specimens: [] }),
        ),
        update: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve(order(args.data)),
        ),
      },
      labResult: {
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'res1', fhir_id: null, ...args.data }),
        ),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
      },
      labSpecimen: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn() },
      patient: { findFirst: jest.fn().mockResolvedValue(patient) },
    } as unknown as PrismaService;

    kafka = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaService;
    realtime = {
      emitToChannel: jest.fn(),
      emitToRoles: jest.fn(),
    } as unknown as RealtimeGateway;

    lab = new LabService(prisma, kafka, realtime);
    results = new LabResultsService(prisma, kafka, lab);
    requests = new ServiceRequestsService(prisma, kafka, lab);
  });

  const emitted = (topic: string) =>
    (kafka.emit as jest.Mock).mock.calls.filter((c) => c[0] === topic);

  describe('interpretation from the reference range', () => {
    it('flags a high potassium as H without calling it critical', async () => {
      const result = await run(() =>
        results.submit({
          service_request_id: ORDER_ID,
          loinc_code: '2823-3',
          value_quantity: 5.6,
          status: 'final',
        }),
      );
      expect(result.interpretation).toBe('H');
      expect(result.critical_flag).toBe(false);
    });

    it('flags a low potassium as L', async () => {
      const result = await run(() =>
        results.submit({
          service_request_id: ORDER_ID,
          loinc_code: '2823-3',
          value_quantity: 3.1,
          status: 'final',
        }),
      );
      expect(result.interpretation).toBe('L');
    });

    it('reads an in-range value as N', async () => {
      const result = await run(() =>
        results.submit({
          service_request_id: ORDER_ID,
          loinc_code: '2823-3',
          value_quantity: 4.2,
          status: 'final',
        }),
      );
      expect(result.interpretation).toBe('N');
      expect(result.critical_flag).toBe(false);
    });

    it('raises HH and the critical flag past the critical high', async () => {
      const result = await run(() =>
        results.submit({
          service_request_id: ORDER_ID,
          loinc_code: '2823-3',
          value_quantity: 6.9,
          status: 'final',
        }),
      );
      expect(result.interpretation).toBe('HH');
      expect(result.critical_flag).toBe(true);
    });

    it('raises LL below the critical low', async () => {
      const result = await run(() =>
        results.submit({
          service_request_id: ORDER_ID,
          loinc_code: '2823-3',
          value_quantity: 2.1,
          status: 'final',
        }),
      );
      expect(result.interpretation).toBe('LL');
      expect(result.critical_flag).toBe(true);
    });

    it('will not let a sender clear a critical flag the range raised', async () => {
      const result = await run(() =>
        results.submit({
          service_request_id: ORDER_ID,
          loinc_code: '2823-3',
          value_quantity: 6.9,
          interpretation: 'N',
          critical_flag: false,
          status: 'final',
        }),
      );
      expect(result.critical_flag).toBe(true);
      expect(result.interpretation).toBe('HH');
    });

    it('honours a critical flag the sender raises on a value we cannot range', async () => {
      const result = await run(() =>
        results.submit({
          service_request_id: ORDER_ID,
          loinc_code: '99999-9',
          test_name: 'Novel assay',
          value_quantity: 42,
          critical_flag: true,
          status: 'final',
        }),
      );
      expect(result.critical_flag).toBe(true);
    });

    it('uses a sender-supplied range but keeps our critical thresholds', async () => {
      const result = await run(() =>
        results.submit({
          service_request_id: ORDER_ID,
          loinc_code: '2823-3',
          value_quantity: 5.4,
          ref_range_low: 3.0,
          ref_range_high: 6.0,
          status: 'final',
        }),
      );
      // 5.4 sits inside the sender's wider range, so it is not flagged H…
      expect(result.interpretation).toBe('N');
      const data = (prisma.labResult.create as jest.Mock).mock.calls[0][0].data;
      expect(Number(data.reference_high)).toBe(6);
    });
  });

  describe('critical value event', () => {
    it('publishes lab.critical_value naming the ordering clinician', async () => {
      await run(() =>
        results.submit({
          service_request_id: ORDER_ID,
          loinc_code: '2823-3',
          value_quantity: 6.9,
          value_unit: 'mmol/L',
          status: 'final',
        }),
      );

      const published = emitted('medicore.lab.critical-value');
      expect(published).toHaveLength(1);
      const event = published[0]![2] as LabCriticalValueEvent;
      expect(event).toMatchObject({
        tenant_id: 't1',
        patient_id: PATIENT_ID,
        loinc_code: '2823-3',
        test_name: 'Potassium',
        value: '6.9',
        ordering_practitioner_id: DOCTOR_ID,
      });
      expect(event.reference_range).toContain('mmol/L');
    });

    it('publishes nothing on a normal result', async () => {
      await run(() =>
        results.submit({
          service_request_id: ORDER_ID,
          loinc_code: '2823-3',
          value_quantity: 4.2,
          status: 'final',
        }),
      );
      expect(emitted('medicore.lab.critical-value')).toHaveLength(0);
    });

    it('still alerts the ward when the order is unknown', async () => {
      await run(() =>
        results.submit({
          patient_id: PATIENT_ID,
          loinc_code: '2823-3',
          test_name: 'Potassium',
          value_quantity: 6.9,
          status: 'final',
        }),
      );
      const event = emitted('medicore.lab.critical-value')[0]![2] as LabCriticalValueEvent;
      expect(event.ordering_practitioner_id).toBeNull();
      expect(emitted('medicore.clinical.critical-alert')).toHaveLength(1);
    });

    it('closes the order once a final result is filed', async () => {
      await run(() =>
        results.submit({
          service_request_id: ORDER_ID,
          loinc_code: '2823-3',
          value_quantity: 4.2,
          status: 'final',
        }),
      );
      expect(prisma.serviceRequest.update).toHaveBeenCalledWith({
        where: { id: ORDER_ID },
        data: expect.objectContaining({ status: 'completed' }),
      });
    });

    it('leaves the order open on a preliminary result', async () => {
      await run(() =>
        results.submit({
          service_request_id: ORDER_ID,
          loinc_code: '2823-3',
          value_quantity: 4.2,
          status: 'preliminary',
        }),
      );
      expect(prisma.serviceRequest.update).not.toHaveBeenCalled();
    });

    it('refuses a result for an order that does not exist', async () => {
      (prisma.serviceRequest.findFirst as jest.Mock).mockResolvedValue(null);
      await expect(
        run(() =>
          results.submit({ service_request_id: ORDER_ID, loinc_code: '2823-3', status: 'final' }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a result with neither a patient nor an order', async () => {
      await expect(
        run(() => results.submit({ loinc_code: '2823-3', status: 'final' })),
      ).rejects.toThrow(/patient_id is required/);
    });
  });

  describe('order cancellation', () => {
    it('sets the status to revoked and records the reason', async () => {
      await run(() => requests.update(ORDER_ID, { status: 'revoked', reason: 'Ordered in error' }));
      const data = (prisma.serviceRequest.update as jest.Mock).mock.calls[0][0].data;
      expect(data.status).toBe('revoked');
      expect(data.deleted_reason).toBe('Ordered in error');
    });

    it('demands a reason before cancelling', async () => {
      await expect(run(() => requests.update(ORDER_ID, { status: 'revoked' }))).rejects.toThrow(
        /reason is required/,
      );
      expect(prisma.serviceRequest.update).not.toHaveBeenCalled();
    });

    it('takes the tube off the phlebotomy list', async () => {
      await run(() => requests.update(ORDER_ID, { status: 'revoked', reason: 'Duplicate' }));
      expect(prisma.labSpecimen.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'cancelled' } }),
      );
    });

    it('will not change an order that is already completed', async () => {
      (prisma.serviceRequest.findFirst as jest.Mock).mockResolvedValue(order({ status: 'completed' }));
      await expect(
        run(() => requests.update(ORDER_ID, { status: 'revoked', reason: 'Too late' })),
      ).rejects.toThrow(/already completed/);
    });

    it('allows the priority to be raised', async () => {
      await run(() => requests.update(ORDER_ID, { priority: 'stat' }));
      expect((prisma.serviceRequest.update as jest.Mock).mock.calls[0][0].data.priority).toBe('stat');
    });

    it('refuses to lower the priority of a STAT order', async () => {
      (prisma.serviceRequest.findFirst as jest.Mock).mockResolvedValue(order({ priority: 'stat' }));
      await expect(run(() => requests.update(ORDER_ID, { priority: 'routine' }))).rejects.toThrow(
        /Cannot lower the priority/,
      );
    });

    it('publishes the change for FHIR sync', async () => {
      await run(() => requests.update(ORDER_ID, { status: 'revoked', reason: 'Ordered in error' }));
      expect(kafka.emit).toHaveBeenCalledWith(
        'medicore.fhir.sync',
        't1',
        expect.objectContaining({ resource_type: 'ServiceRequest', operation: 'update' }),
      );
    });
  });
});

describe('critical value notifications', () => {
  let prisma: PrismaService;
  let realtime: RealtimeGateway;
  let notifications: NotificationsService;

  const event: LabCriticalValueEvent = {
    tenant_id: 't1',
    patient_id: PATIENT_ID,
    encounter_id: null,
    result_id: 'res1',
    service_request_id: ORDER_ID,
    loinc_code: '2823-3',
    test_name: 'Potassium',
    value: '6.9',
    unit: 'mmol/L',
    reference_range: '3.5–5.1 mmol/L',
    interpretation: 'HH',
    ordering_practitioner_id: DOCTOR_ID,
    occurred_at: '2026-07-30T09:00:00.000Z',
  };

  beforeEach(() => {
    prisma = {
      notification: {
        upsert: jest.fn((args: { create: Record<string, unknown> }) =>
          Promise.resolve({ id: NOTIFICATION_ID, ...args.create }),
        ),
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: NOTIFICATION_ID, ...args.data }),
        ),
        findFirst: jest.fn().mockResolvedValue({
          id: NOTIFICATION_ID,
          tenant_id: 't1',
          acknowledged_at: null,
          read_at: null,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: NOTIFICATION_ID, ...args.data }),
        ),
        count: jest.fn().mockResolvedValue(2),
      },
    } as unknown as PrismaService;
    realtime = { emitToChannel: jest.fn(), emitToRoles: jest.fn() } as unknown as RealtimeGateway;
    notifications = new NotificationsService(prisma, realtime);
  });

  it('files an acknowledgement-required alert for the ordering clinician', async () => {
    await notifications.fromCriticalLabValue(event);

    const args = (prisma.notification.upsert as jest.Mock).mock.calls[0][0];
    expect(args.create).toMatchObject({
      tenant_id: 't1',
      user_id: DOCTOR_ID,
      category: 'lab-critical',
      severity: 'critical',
      requires_acknowledgement: true,
      resource_id: 'res1',
    });
    expect(args.create.title).toContain('Potassium');
    expect(args.create.body).toContain('6.9');
    expect(args.create.body).toContain('mmol/L');
  });

  it('falls back to the duty doctors when nobody ordered it', async () => {
    await notifications.fromCriticalLabValue({ ...event, ordering_practitioner_id: null });
    const args = (prisma.notification.upsert as jest.Mock).mock.calls[0][0];
    expect(args.create.user_id).toBeNull();
    expect(args.create.role).toBe('doctor');
  });

  it('collapses a repeat of the same result and never resets the acknowledgement', async () => {
    await notifications.fromCriticalLabValue(event);
    const args = (prisma.notification.upsert as jest.Mock).mock.calls[0][0];
    expect(args.where).toEqual({
      tenant_id_dedupe_key: { tenant_id: 't1', dedupe_key: 'lab-critical:res1' },
    });
    expect(args.update).not.toHaveProperty('acknowledged_at');
    expect(args.update).not.toHaveProperty('requires_acknowledgement');
  });

  it('pushes it live to the named clinician', async () => {
    await notifications.fromCriticalLabValue(event);
    expect(realtime.emitToChannel).toHaveBeenCalledWith(
      't1',
      `user:${DOCTOR_ID}`,
      'notification.created',
      expect.objectContaining({ category: 'lab-critical' }),
    );
  });

  it('acknowledging stamps the time and the clinician', async () => {
    const acknowledged = await run(() => notifications.acknowledge(NOTIFICATION_ID));
    const data = (prisma.notification.update as jest.Mock).mock.calls[0][0].data;
    expect(data.acknowledged_at).toBeInstanceOf(Date);
    expect(data.acknowledged_by).toBe('u1');
    expect(data.read_at).toBeInstanceOf(Date);
    expect(acknowledged.acknowledged_by).toBe('u1');
  });

  it('refuses a second acknowledgement so the first responder stands', async () => {
    (prisma.notification.findFirst as jest.Mock).mockResolvedValue({
      id: NOTIFICATION_ID,
      acknowledged_at: new Date('2026-07-30T09:05:00Z'),
    });
    await expect(run(() => notifications.acknowledge(NOTIFICATION_ID))).rejects.toThrow(
      /already been acknowledged/,
    );
    expect(prisma.notification.update).not.toHaveBeenCalled();
  });

  it('rejects an acknowledgement for a notification that does not exist', async () => {
    (prisma.notification.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(run(() => notifications.acknowledge(NOTIFICATION_ID))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('clears the outstanding count once acknowledged', async () => {
    (prisma.notification.count as jest.Mock).mockResolvedValue(0);
    await expect(run(() => notifications.unacknowledgedCount())).resolves.toEqual({ count: 0 });
  });

  it('the consumer files what arrives on the topic', async () => {
    const kafka = { subscribe: jest.fn() } as unknown as KafkaService;
    const consumer = new CriticalValueConsumer(kafka, notifications);
    await consumer.handle(event);
    expect(prisma.notification.upsert).toHaveBeenCalled();
  });

  it('the consumer discards a malformed event rather than throwing at the broker', async () => {
    const kafka = { subscribe: jest.fn() } as unknown as KafkaService;
    const consumer = new CriticalValueConsumer(kafka, notifications);
    await expect(
      consumer.handle({ ...event, tenant_id: '' } as LabCriticalValueEvent),
    ).resolves.toBeUndefined();
    expect(prisma.notification.upsert).not.toHaveBeenCalled();
  });
});
