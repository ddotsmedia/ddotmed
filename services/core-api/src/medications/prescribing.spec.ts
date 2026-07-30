/**
 * The e-prescribing safety gates, end to end through the service.
 *
 * Every case here is one a prescriber can actually hit, and every assertion is
 * about what does or does not reach the database — a check that throws but still
 * writes the order is worse than no check at all.
 */
import {
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { MedicationsService } from './medications.service';
import { InteractionsService } from './interactions.service';
import { AllergiesService } from '../allergies/allergies.service';
import type { PrismaService } from '../common/prisma.service';
import type { KafkaService } from '../messaging/kafka.service';
import { requestContext, type RequestContext } from '../common/tenant-context';

const MED_ID = '0193c3f0-0000-7000-8000-0000000000m1';
const PATIENT_ID = '0193c3f0-0000-7000-8000-000000000001';
const FORMULARY_ID = '0193c3f0-0000-7000-8000-0000000000f1';
const WITNESS_ID = '0193c3f0-0000-7000-8000-0000000000u2';

const ctx: RequestContext = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  roles: ['doctor'],
  permissions: ['medication:prescribe'],
  practitionerId: 'prac1',
  isBreakGlass: false,
  ip: null,
  userAgent: null,
  requestId: 'r1',
};

const run = <T>(fn: () => Promise<T>): Promise<T> => requestContext.run(ctx, fn);

const warfarin = {
  patient_id: PATIENT_ID,
  code: '11289',
  code_display: 'Warfarin 5mg',
  dose_quantity: 5,
  dose_unit: 'mg',
  route: 'oral',
  frequency: 'OD',
  quantity: 28,
  refills: 0,
  is_prn: false,
};

const allergyRow = (criticality: 'high' | 'low', substance = 'Warfarin') => ({
  id: 'a1',
  code: '11289',
  code_display: substance,
  criticality,
  substance_rxnorm: '11289',
  reaction: criticality === 'high' ? ['anaphylaxis'] : ['rash'],
  clinical_status: 'active',
});

describe('e-prescribing safety gates', () => {
  let prisma: PrismaService;
  let kafka: KafkaService;
  let service: MedicationsService;

  beforeEach(() => {
    prisma = {
      medication: {
        create: jest.fn().mockResolvedValue({ id: MED_ID, fhir_id: null }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn().mockResolvedValue(null),
        update: jest.fn().mockResolvedValue({ id: MED_ID, fhir_id: null }),
      },
      medicationDispense: { create: jest.fn().mockResolvedValue({ id: 'd1', fhir_id: null, dispensed_at: new Date() }) },
      drugFormulary: { findFirst: jest.fn().mockResolvedValue(null) },
      drugInteraction: { findMany: jest.fn().mockResolvedValue([]) },
      allergy: { findMany: jest.fn().mockResolvedValue([]) },
      controlledDrugRegister: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    kafka = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaService;
    service = new MedicationsService(
      prisma,
      kafka,
      new AllergiesService(prisma, kafka),
      new InteractionsService(prisma),
    );
  });

  describe('allergy gate', () => {
    it('rejects a high-criticality allergy with 422 and names the allergen', async () => {
      (prisma.allergy.findMany as jest.Mock).mockResolvedValue([allergyRow('high')]);

      let thrown: unknown;
      await run(() => service.prescribe(warfarin)).catch((e: unknown) => {
        thrown = e;
      });

      expect(thrown).toBeInstanceOf(UnprocessableEntityException);
      const body = (thrown as UnprocessableEntityException).getResponse() as Record<string, unknown>;
      expect((thrown as UnprocessableEntityException).getStatus()).toBe(422);
      expect(body.code).toBe('ALLERGY_CONTRAINDICATION');
      expect(body.override_allowed).toBe(false);
      expect(String(body.message)).toContain('Warfarin');
      expect(prisma.medication.create).not.toHaveBeenCalled();
    });

    it('warns on a low-criticality allergy and saves once a reason is given', async () => {
      (prisma.allergy.findMany as jest.Mock).mockResolvedValue([allergyRow('low')]);

      await expect(run(() => service.prescribe(warfarin))).rejects.toThrow(ConflictException);
      expect(prisma.medication.create).not.toHaveBeenCalled();

      const result = await run(() =>
        service.prescribe({ ...warfarin, override_reason: 'Documented rash only; benefit outweighs risk' }),
      );

      expect(prisma.medication.create).toHaveBeenCalled();
      expect(result.safety.allergy_warnings).toHaveLength(1);
      expect(result.safety.allergy_warnings[0]!.criticality).toBe('low');
      expect(result.safety.overridden).toBe(true);
      const data = (prisma.medication.create as jest.Mock).mock.calls[0][0].data;
      expect(data.allergy_override_reason).toBe('Documented rash only; benefit outweighs risk');
    });

    it('does not stamp an override reason when there was nothing to override', async () => {
      await run(() => service.prescribe({ ...warfarin, override_reason: 'Not actually needed here' }));
      const data = (prisma.medication.create as jest.Mock).mock.calls[0][0].data;
      expect(data.allergy_override_reason).toBeNull();
      expect(data.interaction_override_reason).toBeNull();
    });
  });

  describe('drug-drug gate', () => {
    it('blocks a contraindicated pair with 422, reason or no reason', async () => {
      (prisma.medication.findMany as jest.Mock).mockResolvedValue([
        { code: '2551', code_display: 'Clarithromycin 500mg' },
      ]);

      let thrown: unknown;
      await run(() =>
        service.prescribe({
          ...warfarin,
          code: '36567',
          code_display: 'Simvastatin 40mg',
          override_reason: 'Accepting the risk for now',
        }),
      ).catch((e: unknown) => {
        thrown = e;
      });

      expect(thrown).toBeInstanceOf(UnprocessableEntityException);
      const body = (thrown as UnprocessableEntityException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('DRUG_INTERACTION');
      expect(body.override_allowed).toBe(false);
      expect(prisma.medication.create).not.toHaveBeenCalled();
    });

    it('warns on a major pair and saves once a reason is given', async () => {
      (prisma.medication.findMany as jest.Mock).mockResolvedValue([
        { code: '1191', code_display: 'Aspirin 75mg' },
      ]);

      let thrown: unknown;
      await run(() => service.prescribe(warfarin)).catch((e: unknown) => {
        thrown = e;
      });
      expect(thrown).toBeInstanceOf(ConflictException);
      const body = (thrown as ConflictException).getResponse() as Record<string, unknown>;
      expect(body.override_allowed).toBe(true);
      expect(prisma.medication.create).not.toHaveBeenCalled();

      const result = await run(() =>
        service.prescribe({ ...warfarin, override_reason: 'INR monitored daily on the ward' }),
      );
      expect(prisma.medication.create).toHaveBeenCalled();
      expect(result.safety.interaction_warnings).toHaveLength(1);
      expect(result.safety.interaction_warnings[0]!.severity).toBe('major');
    });

    it('lets a moderate pair through without a reason, but reports it', async () => {
      (prisma.medication.findMany as jest.Mock).mockResolvedValue([
        { code: '7646', code_display: 'Omeprazole 20mg' },
      ]);

      const result = await run(() =>
        service.prescribe({ ...warfarin, code: '42463', code_display: 'Clopidogrel 75mg' }),
      );

      expect(prisma.medication.create).toHaveBeenCalled();
      expect(result.safety.interaction_warnings[0]!.severity).toBe('moderate');
      expect(result.safety.overridden).toBe(false);
    });

    it('finds a bundled interaction with nothing loaded in the database', async () => {
      (prisma.medication.findMany as jest.Mock).mockResolvedValue([
        { code: '1191', code_display: 'Aspirin 75mg' },
      ]);
      (prisma.drugInteraction.findMany as jest.Mock).mockResolvedValue([]);

      await expect(run(() => service.prescribe(warfarin))).rejects.toThrow(ConflictException);
    });

    it('prefers a tenant row over the bundled entry for the same pair', async () => {
      (prisma.medication.findMany as jest.Mock).mockResolvedValue([
        { code: '1191', code_display: 'Aspirin 75mg' },
      ]);
      (prisma.drugInteraction.findMany as jest.Mock).mockResolvedValue([
        {
          rxnorm_a: '11289',
          rxnorm_b: '1191',
          severity: 'moderate',
          mechanism: null,
          clinical_effect: 'Local policy grades this lower',
          management: null,
          plain_explanation: 'House rule.',
        },
      ]);

      const result = await run(() => service.prescribe(warfarin));
      expect(result.safety.interaction_warnings).toHaveLength(1);
      expect(result.safety.interaction_warnings[0]!.source).toBe('tenant');
      expect(result.safety.interaction_warnings[0]!.explanation).toBe('House rule.');
    });
  });

  describe('controlled drugs', () => {
    const controlled = {
      id: 'f1',
      generic_name: 'Morphine',
      is_controlled: true,
      controlled_schedule: 'CD2',
    };

    it('rejects a controlled prescription with no witness, as a 400', async () => {
      (prisma.drugFormulary.findFirst as jest.Mock).mockResolvedValue(controlled);

      let thrown: unknown;
      await run(() =>
        service.prescribe({
          ...warfarin,
          code: '7052',
          code_display: 'Morphine 10mg',
          drug_formulary_id: FORMULARY_ID,
        }),
      ).catch((e: unknown) => {
        thrown = e;
      });

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect((thrown as BadRequestException).getStatus()).toBe(400);
      const body = (thrown as BadRequestException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('WITNESS_REQUIRED');
      expect(body.controlled_schedule).toBe('CD2');
      expect(prisma.medication.create).not.toHaveBeenCalled();
    });

    it('accepts it with a witness and opens a register entry', async () => {
      (prisma.drugFormulary.findFirst as jest.Mock).mockResolvedValue(controlled);

      await run(() =>
        service.prescribe({
          ...warfarin,
          code: '7052',
          code_display: 'Morphine 10mg',
          drug_formulary_id: FORMULARY_ID,
          witness_id: WITNESS_ID,
        }),
      );

      expect(prisma.medication.create).toHaveBeenCalled();
      expect(prisma.controlledDrugRegister.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ entry_type: 'prescribed', schedule: 'CD2' }),
        }),
      );
    });
  });

  describe('modify', () => {
    beforeEach(() => {
      (prisma.medication.findFirst as jest.Mock).mockResolvedValue({
        id: MED_ID,
        status: 'active',
        fhir_id: null,
      });
    });

    it('adjusts the dose in place', async () => {
      await run(() => service.modify(MED_ID, { dose_quantity: 2.5, frequency: 'BD' }));
      const data = (prisma.medication.update as jest.Mock).mock.calls[0][0].data;
      expect(data.dose_quantity).toBe(2.5);
      expect(data.frequency).toBe('BD');
      expect(data.status).toBeUndefined();
    });

    it('demands a reason before discontinuing', async () => {
      await expect(run(() => service.modify(MED_ID, { status: 'stopped' }))).rejects.toThrow(
        /reason is required/,
      );
      expect(prisma.medication.update).not.toHaveBeenCalled();
    });

    it('discontinues with a reason and closes the course', async () => {
      await run(() => service.modify(MED_ID, { status: 'stopped', reason: 'Rash developed' }));
      const data = (prisma.medication.update as jest.Mock).mock.calls[0][0].data;
      expect(data.status).toBe('stopped');
      expect(data.end_date).toBeInstanceOf(Date);
    });

    it('will not touch an already stopped prescription', async () => {
      (prisma.medication.findFirst as jest.Mock).mockResolvedValue({ id: MED_ID, status: 'stopped' });
      await expect(run(() => service.modify(MED_ID, { dose_quantity: 1 }))).rejects.toThrow(
        /already stopped/,
      );
    });

    it('emits an update to the FHIR sync topic', async () => {
      await run(() => service.modify(MED_ID, { frequency: 'TDS' }));
      expect(kafka.emit).toHaveBeenCalledWith(
        'medicore.fhir.sync',
        't1',
        expect.objectContaining({ resource_type: 'MedicationRequest', operation: 'update' }),
      );
    });
  });

  describe('dispense', () => {
    const active = (over: Record<string, unknown> = {}) => ({
      id: MED_ID,
      patient_id: PATIENT_ID,
      status: 'active',
      quantity: 28,
      refills: 0,
      code_display: 'Warfarin 5mg',
      is_controlled: false,
      controlled_schedule: null,
      dispenses: [],
      fhir_id: null,
      ...over,
    });

    it('creates a dispense record against the prescription', async () => {
      (prisma.medication.findFirst as jest.Mock).mockResolvedValue(active());

      const result = await run(() => service.dispense(MED_ID, { quantity: 28, substituted: false }));

      expect(prisma.medicationDispense.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            medication_id: MED_ID,
            patient_id: PATIENT_ID,
            quantity: 28,
            dispensed_by: 'u1',
          }),
        }),
      );
      expect(result.remaining_authorised).toBe(0);
    });

    it('completes the prescription once nothing remains authorised', async () => {
      (prisma.medication.findFirst as jest.Mock).mockResolvedValue(active());
      await run(() => service.dispense(MED_ID, { quantity: 28, substituted: false }));
      expect(prisma.medication.update).toHaveBeenCalledWith({
        where: { id: MED_ID },
        data: { status: 'completed' },
      });
    });

    it('leaves the prescription open while refills remain', async () => {
      (prisma.medication.findFirst as jest.Mock).mockResolvedValue(active({ refills: 2 }));
      const result = await run(() => service.dispense(MED_ID, { quantity: 28, substituted: false }));
      expect(result.remaining_authorised).toBe(56);
      expect(prisma.medication.update).not.toHaveBeenCalled();
    });

    it('refuses to dispense more than the prescription authorises', async () => {
      (prisma.medication.findFirst as jest.Mock).mockResolvedValue(
        active({ dispenses: [{ quantity: 20 }] }),
      );

      let thrown: unknown;
      await run(() => service.dispense(MED_ID, { quantity: 10, substituted: false })).catch(
        (e: unknown) => {
          thrown = e;
        },
      );

      expect(thrown).toBeInstanceOf(BadRequestException);
      const body = (thrown as BadRequestException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('QUANTITY_EXCEEDS_PRESCRIPTION');
      expect(prisma.medicationDispense.create).not.toHaveBeenCalled();
    });

    it('requires a witness to dispense a controlled drug', async () => {
      (prisma.medication.findFirst as jest.Mock).mockResolvedValue(
        active({ is_controlled: true, controlled_schedule: 'CD2' }),
      );

      let thrown: unknown;
      await run(() => service.dispense(MED_ID, { quantity: 10, substituted: false })).catch(
        (e: unknown) => {
          thrown = e;
        },
      );

      expect(thrown).toBeInstanceOf(BadRequestException);
      expect(
        ((thrown as BadRequestException).getResponse() as Record<string, unknown>).code,
      ).toBe('WITNESS_REQUIRED');
      expect(prisma.medicationDispense.create).not.toHaveBeenCalled();
    });

    it('writes a register entry when a controlled drug is dispensed with a witness', async () => {
      (prisma.medication.findFirst as jest.Mock).mockResolvedValue(
        active({ is_controlled: true, controlled_schedule: 'CD2' }),
      );

      await run(() =>
        service.dispense(MED_ID, { quantity: 10, witness_id: WITNESS_ID, substituted: false }),
      );

      expect(prisma.controlledDrugRegister.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ entry_type: 'dispensed', schedule: 'CD2' }),
        }),
      );
    });

    it('will not dispense against a stopped prescription', async () => {
      (prisma.medication.findFirst as jest.Mock).mockResolvedValue(active({ status: 'stopped' }));
      await expect(
        run(() => service.dispense(MED_ID, { quantity: 1, substituted: false })),
      ).rejects.toThrow(/stopped prescription/);
    });

    it('publishes the dispense to the FHIR sync topic', async () => {
      (prisma.medication.findFirst as jest.Mock).mockResolvedValue(active());
      await run(() => service.dispense(MED_ID, { quantity: 28, substituted: false }));
      expect(kafka.emit).toHaveBeenCalledWith(
        'medicore.fhir.sync',
        't1',
        expect.objectContaining({ resource_type: 'MedicationDispense', operation: 'create' }),
      );
    });
  });
});
