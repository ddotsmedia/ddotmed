/**
 * Dispensing at the counter: the second safety gate, FEFO stock movement and
 * what happens to the shelf afterwards.
 */
import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PharmacyService } from './pharmacy.module';
import { AllergiesService } from '../allergies/allergies.service';
import { InteractionsService } from '../medications/interactions.service';
import { NotificationsService } from '../notifications/notifications.module';
import type { PrismaService } from '../common/prisma.service';
import type { KafkaService } from '../messaging/kafka.service';
import type { RealtimeGateway } from '../messaging/realtime.gateway';
import { requestContext, type RequestContext } from '../common/tenant-context';

const MED_ID = '0193c3f0-0000-7000-8000-0000000000m1';
const PATIENT_ID = '0193c3f0-0000-7000-8000-000000000001';
const WITNESS_ID = '0193c3f0-0000-7000-8000-0000000000u2';

const ctx: RequestContext = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  roles: ['pharmacist'],
  permissions: ['medication:dispense'],
  isBreakGlass: false,
  ip: null,
  userAgent: null,
  requestId: 'r1',
};

const run = <T>(fn: () => Promise<T>): Promise<T> => requestContext.run(ctx, fn);

const medication = (over: Record<string, unknown> = {}) => ({
  id: MED_ID,
  tenant_id: 't1',
  patient_id: PATIENT_ID,
  code: '723',
  code_display: 'Amoxicillin 500mg',
  dose_quantity: 1,
  dose_unit: 'capsule',
  route: 'oral',
  is_controlled: false,
  controlled_schedule: null,
  drug_formulary_id: 'f1',
  patient: { mrn: 'MRN26000001' },
  formulary: { id: 'f1', generic_name: 'Amoxicillin', strength: '500 mg', dose_form: 'capsule' },
  ...over,
});

const batch = (over: Record<string, unknown> = {}) => ({
  id: 'b1',
  tenant_id: 't1',
  item_code: 'AMOX500',
  name: 'Amoxicillin 500mg',
  batch_number: 'A1',
  expiry_date: new Date('2027-01-01'),
  quantity_on_hand: 100,
  quantity_reserved: 0,
  is_recalled: false,
  reorder_level: 0,
  reorder_quantity: 0,
  location_id: null,
  drug_formulary_id: 'f1',
  ...over,
});

const scanned = {
  scanned_patient_barcode: 'MRN26000001',
  scanned_medication_barcode: '723',
};

describe('pharmacy dispensing', () => {
  let prisma: PrismaService;
  let kafka: KafkaService;
  let realtime: RealtimeGateway;
  let notifications: NotificationsService;
  let service: PharmacyService;
  let batches: ReturnType<typeof batch>[];

  const dispense = (over: Record<string, unknown> = {}) =>
    run(() =>
      service.dispense({
        medication_id: MED_ID,
        quantity: 10,
        partial_dispense: false,
        allow_substitution: false,
        ...scanned,
        ...over,
      } as never),
    );

  beforeEach(() => {
    batches = [batch()];

    const tx = {
      pharmacyItem: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        aggregate: jest.fn().mockResolvedValue({ _sum: { quantity_on_hand: 90 } }),
      },
      medicationDispense: {
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'd1', fhir_id: null, ...args.data }),
        ),
      },
      controlledDrugRegister: { create: jest.fn().mockResolvedValue({}) },
    };

    prisma = {
      medication: { findFirst: jest.fn().mockResolvedValue(medication()), findMany: jest.fn().mockResolvedValue([]) },
      pharmacyItem: {
        findMany: jest.fn(() => Promise.resolve(batches)),
        findFirst: jest.fn((args: { where: { id: string } }) =>
          Promise.resolve(batches.find((b) => b.id === args.where.id) ?? null),
        ),
      },
      inventoryItem: { findMany: jest.fn().mockResolvedValue([]) },
      drugFormulary: { findMany: jest.fn().mockResolvedValue([]) },
      drugInteraction: { findMany: jest.fn().mockResolvedValue([]) },
      allergy: { findMany: jest.fn().mockResolvedValue([]) },
      notification: {
        upsert: jest.fn((args: { create: Record<string, unknown> }) =>
          Promise.resolve({ id: 'n1', ...args.create }),
        ),
        create: jest.fn((args: { data: Record<string, unknown> }) =>
          Promise.resolve({ id: 'n1', ...args.data }),
        ),
      },
      $transaction: jest.fn((fn: (t: unknown) => Promise<unknown>) => fn(tx)),
    } as unknown as PrismaService;

    kafka = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaService;
    realtime = { emitToChannel: jest.fn(), emitToRoles: jest.fn() } as unknown as RealtimeGateway;
    notifications = new NotificationsService(prisma, realtime);

    service = new PharmacyService(
      prisma,
      kafka,
      new AllergiesService(prisma, kafka),
      new InteractionsService(prisma),
      notifications,
    );

    // Reachable from the tests that assert on what the transaction wrote.
    (service as unknown as { tx: typeof tx }).tx = tx;
  });

  const txOf = () => (service as unknown as { tx: { medicationDispense: { create: jest.Mock }; pharmacyItem: { updateMany: jest.Mock }; controlledDrugRegister: { create: jest.Mock } } }).tx;
  const emitted = (topic: string) =>
    (kafka.emit as jest.Mock).mock.calls.filter((c) => c[0] === topic);

  describe('FEFO', () => {
    it('picks the batch that expires first', async () => {
      batches = [
        batch({ id: 'late', batch_number: 'L', expiry_date: new Date('2027-06-01') }),
        batch({ id: 'early', batch_number: 'E', expiry_date: new Date('2026-09-01') }),
      ];

      const result = await dispense({ quantity: 10 });

      expect(result.picked.map((l) => l.batch_id)).toEqual(['early']);
      expect(txOf().pharmacyItem.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: 'early' }) }),
      );
    });

    it('spans batches when the earliest cannot cover the order', async () => {
      batches = [
        batch({ id: 'early', batch_number: 'E', expiry_date: new Date('2026-09-01'), quantity_on_hand: 4 }),
        batch({ id: 'late', batch_number: 'L', expiry_date: new Date('2027-06-01'), quantity_on_hand: 50 }),
      ];

      const result = await dispense({ quantity: 10 });

      expect(result.picked).toEqual([
        expect.objectContaining({ batch_id: 'early', quantity: 4 }),
        expect.objectContaining({ batch_id: 'late', quantity: 6 }),
      ]);
    });

    it('never picks an expired or recalled batch', async () => {
      batches = [
        batch({ id: 'expired', batch_number: 'X', expiry_date: new Date('2020-01-01') }),
        batch({ id: 'recalled', batch_number: 'R', is_recalled: true }),
        batch({ id: 'good', batch_number: 'G' }),
      ];

      const result = await dispense({ quantity: 10 });

      expect(result.picked.map((l) => l.batch_id)).toEqual(['good']);
      expect(result.dispensed_quantity).toBe(10);
    });

    it('honours a nominated batch only when nothing expires sooner', async () => {
      batches = [
        batch({ id: 'early', batch_number: 'E', expiry_date: new Date('2026-09-01') }),
        batch({ id: 'chosen', batch_number: 'C', expiry_date: new Date('2027-06-01') }),
      ];

      const result = await dispense({ quantity: 10, batch_no: 'C' });

      // FEFO wins: the older stock would otherwise expire on the shelf.
      expect(result.picked.map((l) => l.batch_id)).toEqual(['early']);
    });

    it('uses the nominated batch when it is the earliest anyway', async () => {
      batches = [
        batch({ id: 'chosen', batch_number: 'C', expiry_date: new Date('2026-09-01') }),
        batch({ id: 'late', batch_number: 'L', expiry_date: new Date('2027-06-01') }),
      ];

      const result = await dispense({ quantity: 10, batch_no: 'C' });
      expect(result.picked.map((l) => l.batch_id)).toEqual(['chosen']);
    });
  });

  describe('insufficient stock', () => {
    it('refuses with 409 and reports what is actually available', async () => {
      batches = [batch({ quantity_on_hand: 3 })];

      let thrown: unknown;
      await dispense({ quantity: 10 }).catch((e: unknown) => {
        thrown = e;
      });

      expect(thrown).toBeInstanceOf(ConflictException);
      expect((thrown as ConflictException).getStatus()).toBe(409);
      const body = (thrown as ConflictException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('INSUFFICIENT_STOCK');
      expect(body.available_quantity).toBe(3);
      expect(body.requested_quantity).toBe(10);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('allows a short supply only when it was asked for', async () => {
      batches = [batch({ quantity_on_hand: 3 })];

      const result = await dispense({ quantity: 10, partial_dispense: true });

      expect(result.partial).toBe(true);
      expect(result.dispensed_quantity).toBe(3);
      expect(result.requested_quantity).toBe(10);
      expect(txOf().medicationDispense.create.mock.calls[0][0].data.quantity).toBe(3);
      // A partial supply is not a finished one.
      expect(txOf().medicationDispense.create.mock.calls[0][0].data.status).toBe('in-progress');
    });

    it('refuses even a partial supply when there is nothing at all', async () => {
      batches = [];
      await expect(dispense({ quantity: 10, partial_dispense: true })).rejects.toThrow(
        ConflictException,
      );
    });
  });

  describe('second safety gate', () => {
    it('blocks on a high-criticality allergy recorded since prescribing', async () => {
      (prisma.allergy.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'a1',
          code: '723',
          code_display: 'Amoxicillin',
          criticality: 'high',
          substance_rxnorm: '723',
          reaction: ['anaphylaxis'],
          clinical_status: 'active',
        },
      ]);

      let thrown: unknown;
      await dispense().catch((e: unknown) => {
        thrown = e;
      });

      expect(thrown).toBeInstanceOf(UnprocessableEntityException);
      expect(
        ((thrown as UnprocessableEntityException).getResponse() as Record<string, unknown>).code,
      ).toBe('ALLERGY_CONTRAINDICATION');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('blocks a contraindication picked up since prescribing', async () => {
      (prisma.medication.findMany as jest.Mock).mockResolvedValue([
        { code: '2551', code_display: 'Clarithromycin 500mg' },
      ]);
      (prisma.medication.findFirst as jest.Mock).mockResolvedValue(
        medication({ code: '36567', code_display: 'Simvastatin 40mg' }),
      );

      await expect(dispense({ scanned_medication_barcode: '36567' })).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('demands a reason for an overridable warning, then lets it through', async () => {
      (prisma.allergy.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'a1',
          code: '723',
          code_display: 'Amoxicillin',
          criticality: 'low',
          substance_rxnorm: '723',
          reaction: ['rash'],
          clinical_status: 'active',
        },
      ]);

      await expect(dispense()).rejects.toThrow(ConflictException);

      const result = await dispense({ override_reason: 'Mild rash only; prescriber aware' });
      expect(result.safety.allergy.warnings).toHaveLength(1);
    });

    it('lets a clean prescription through untouched', async () => {
      const result = await dispense();
      expect(result.safety.allergy.warnings).toEqual([]);
      expect(result.safety.interaction.findings).toEqual([]);
      expect(result.partial).toBe(false);
    });
  });

  describe('controlled drugs', () => {
    beforeEach(() => {
      (prisma.medication.findFirst as jest.Mock).mockResolvedValue(
        medication({ is_controlled: true, controlled_schedule: 'CD2' }),
      );
    });

    it('refuses with 400 when no witness is named', async () => {
      let thrown: unknown;
      await dispense().catch((e: unknown) => {
        thrown = e;
      });

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).getStatus()).toBe(400);
      const body = (thrown as BadRequestException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('WITNESS_REQUIRED');
      expect(body.controlled_schedule).toBe('CD2');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('refuses the pharmacist as their own witness', async () => {
      await expect(dispense({ witness_id: 'u1' })).rejects.toThrow(/different person/);
    });

    it('writes a register entry with the quantity actually handed over', async () => {
      await dispense({ witness_id: WITNESS_ID });
      const entry = txOf().controlledDrugRegister.create.mock.calls[0][0].data;
      expect(entry.entry_type).toBe('dispensed');
      expect(entry.schedule).toBe('CD2');
      expect(entry.quantity_change).toBe(-10);
      expect(entry.witness_id).toBe(WITNESS_ID);
    });
  });

  describe('barcode verification', () => {
    it('records the dispense as verified when both barcodes scanned', async () => {
      await dispense();
      expect(txOf().medicationDispense.create.mock.calls[0][0].data.barcode_verified).toBe(true);
    });

    it('aborts on a wrong-patient scan before any stock moves', async () => {
      let thrown: unknown;
      await dispense({ scanned_patient_barcode: 'MRN99999999' }).catch((e: unknown) => {
        thrown = e;
      });
      expect(
        ((thrown as ConflictException).getResponse() as Record<string, unknown>).code,
      ).toBe('WRONG_PATIENT');
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('records an unscanned dispense honestly as unverified', async () => {
      await dispense({
        scanned_patient_barcode: undefined,
        scanned_medication_barcode: undefined,
        barcode_override_reason: 'Label damaged in transit; identity confirmed verbally',
      });
      expect(txOf().medicationDispense.create.mock.calls[0][0].data.barcode_verified).toBe(false);
    });
  });

  describe('events and low stock', () => {
    it('publishes pharmacy.dispensed with the batches that moved', async () => {
      const result = await dispense();

      const published = emitted('medicore.pharmacy.dispensed');
      expect(published).toHaveLength(1);
      expect(published[0]![2]).toMatchObject({
        tenant_id: 't1',
        dispense_id: result.dispense.id,
        drug_name: 'Amoxicillin 500mg',
        quantity: 10,
        partial: false,
      });
      expect((published[0]![2] as { batches: unknown[] }).batches).toHaveLength(1);
    });

    it('raises a low-stock alert on the dispense that crossed the line', async () => {
      batches = [batch({ quantity_on_hand: 25, reorder_level: 20, reorder_quantity: 100 })];
      (prisma.pharmacyItem.findFirst as jest.Mock).mockResolvedValue(
        batch({ quantity_on_hand: 15, reorder_level: 20, reorder_quantity: 100 }),
      );

      await dispense({ quantity: 10 });

      expect(emitted('medicore.inventory.low-stock')).toHaveLength(1);
      const notification = (prisma.notification.upsert as jest.Mock).mock.calls[0][0];
      expect(notification.create).toMatchObject({
        category: 'inventory-low-stock',
        severity: 'warning',
        role: 'pharmacist',
      });
      expect(notification.create.body).toContain('100');
    });

    it('does not re-alert when stock was already below the line', async () => {
      batches = [batch({ quantity_on_hand: 15, reorder_level: 20 })];
      (prisma.pharmacyItem.findFirst as jest.Mock).mockResolvedValue(
        batch({ quantity_on_hand: 10, reorder_level: 20 }),
      );

      await dispense({ quantity: 5 });

      expect(emitted('medicore.inventory.low-stock')).toHaveLength(0);
      expect(prisma.notification.upsert).not.toHaveBeenCalled();
    });

    it('says nothing when the item is not tracked for reordering', async () => {
      (prisma.pharmacyItem.findFirst as jest.Mock).mockResolvedValue(
        batch({ quantity_on_hand: 0, reorder_level: 0 }),
      );
      await dispense();
      expect(emitted('medicore.inventory.low-stock')).toHaveLength(0);
    });
  });
});

describe('expiry sweep', () => {
  let prisma: PrismaService;
  let notifications: NotificationsService;
  let service: PharmacyService;

  const NOW = new Date('2026-07-31T03:00:00Z');

  beforeEach(() => {
    prisma = {
      pharmacyItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'p-soon',
            tenant_id: 't1',
            name: 'Amoxicillin 500mg',
            batch_number: 'A1',
            expiry_date: new Date('2026-08-10T00:00:00Z'),
            quantity_on_hand: 40,
          },
          {
            id: 'p-gone',
            tenant_id: 't1',
            name: 'Cefalexin 250mg',
            batch_number: 'C9',
            expiry_date: new Date('2026-07-01T00:00:00Z'),
            quantity_on_hand: 12,
          },
          {
            id: 'p-empty',
            tenant_id: 't1',
            name: 'Empty batch',
            batch_number: 'E0',
            expiry_date: new Date('2026-08-02T00:00:00Z'),
            quantity_on_hand: 0,
          },
        ]),
      },
      inventoryItem: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'i-soon',
            tenant_id: 't2',
            name: 'Sterile gloves',
            batch_number: 'G7',
            expiry_date: new Date('2026-08-15T00:00:00Z'),
            quantity_on_hand: 200,
          },
        ]),
      },
      notification: {
        upsert: jest.fn((args: { create: Record<string, unknown> }) =>
          Promise.resolve({ id: 'n1', ...args.create }),
        ),
      },
    } as unknown as PrismaService;

    const kafka = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaService;
    const realtime = { emitToChannel: jest.fn(), emitToRoles: jest.fn() } as unknown as RealtimeGateway;
    notifications = new NotificationsService(prisma, realtime);
    service = new PharmacyService(
      prisma,
      kafka,
      new AllergiesService(prisma, kafka),
      new InteractionsService(prisma),
      notifications,
    );
  });

  it('flags what is expiring and what has expired, and nothing else', async () => {
    const result = await service.expirySweep(NOW);
    expect(result.flagged).toBe(3);

    const ids = (prisma.notification.upsert as jest.Mock).mock.calls.map(
      (c) => c[0].create.resource_id,
    );
    expect(ids).toEqual(expect.arrayContaining(['p-soon', 'p-gone', 'i-soon']));
    expect(ids).not.toContain('p-empty');
  });

  it('marks already-expired stock critical and demands acknowledgement', async () => {
    await service.expirySweep(NOW);
    const expired = (prisma.notification.upsert as jest.Mock).mock.calls
      .map((c) => c[0].create)
      .find((n) => n.resource_id === 'p-gone');

    expect(expired.severity).toBe('critical');
    expect(expired.requires_acknowledgement).toBe(true);
    expect(expired.title).toMatch(/Expired stock/);
  });

  it('warns without demanding acknowledgement for stock still in date', async () => {
    await service.expirySweep(NOW);
    const soon = (prisma.notification.upsert as jest.Mock).mock.calls
      .map((c) => c[0].create)
      .find((n) => n.resource_id === 'p-soon');

    expect(soon.severity).toBe('warning');
    expect(soon.requires_acknowledgement).toBe(false);
    // 31 Jul 03:00 to 10 Aug 00:00 is 9 whole days remaining, not 10.
    expect(soon.body).toContain('9 days');
  });

  it('files each tenant’s stock against that tenant', async () => {
    await service.expirySweep(NOW);
    const byResource = new Map(
      (prisma.notification.upsert as jest.Mock).mock.calls.map((c) => [
        c[0].create.resource_id,
        c[0].create.tenant_id,
      ]),
    );
    expect(byResource.get('p-soon')).toBe('t1');
    expect(byResource.get('i-soon')).toBe('t2');
  });

  it('keeps one standing alert per batch', async () => {
    await service.expirySweep(NOW);
    const keys = (prisma.notification.upsert as jest.Mock).mock.calls.map(
      (c) => c[0].where.tenant_id_dedupe_key.dedupe_key,
    );
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('expiry:PharmacyItem:p-soon');
  });
});
