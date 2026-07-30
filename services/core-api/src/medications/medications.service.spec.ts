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

const ctx: RequestContext = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  roles: ['doctor'],
  permissions: [],
  practitionerId: 'prac1',
  isBreakGlass: false,
  ip: null,
  userAgent: null,
  requestId: 'r1',
};

const run = <T>(fn: () => Promise<T>): Promise<T> => requestContext.run(ctx, fn);

const baseDto = {
  patient_id: '0193c3f0-0000-7000-8000-000000000001',
  code: '161',
  code_display: 'Paracetamol 500mg',
  dose_quantity: 1,
  dose_unit: 'tablet',
  route: 'oral',
  frequency: 'QDS',
  quantity: 20,
  refills: 0,
  is_prn: false,
};

describe('MedicationsService prescribing gates', () => {
  let prisma: PrismaService;
  let kafka: KafkaService;
  let allergies: AllergiesService;
  let interactions: InteractionsService;
  let service: MedicationsService;

  beforeEach(() => {
    prisma = {
      medication: {
        create: jest.fn().mockResolvedValue({ id: 'm1', fhir_id: null }),
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      drugFormulary: { findFirst: jest.fn().mockResolvedValue(null) },
      drugInteraction: { findMany: jest.fn().mockResolvedValue([]) },
      allergy: { findMany: jest.fn().mockResolvedValue([]) },
      controlledDrugRegister: { create: jest.fn().mockResolvedValue({}) },
    } as unknown as PrismaService;
    kafka = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaService;
    allergies = new AllergiesService(prisma, kafka);
    interactions = new InteractionsService(prisma);
    service = new MedicationsService(prisma, kafka, allergies, interactions);
  });

  it('records both check timestamps on a clean prescription', async () => {
    await run(() => service.prescribe(baseDto));
    const data = (prisma.medication.create as jest.Mock).mock.calls[0][0].data;
    expect(data.allergy_checked_at).toBeInstanceOf(Date);
    expect(data.interaction_checked_at).toBeInstanceOf(Date);
  });

  it('blocks on a high-criticality allergy and never writes the order', async () => {
    (prisma.allergy.findMany as jest.Mock).mockResolvedValue([
      { id: 'a1', code: '161', code_display: 'Paracetamol', criticality: 'high', substance_rxnorm: '161', reaction: ['anaphylaxis'], clinical_status: 'active' },
    ]);
    await expect(run(() => service.prescribe(baseDto))).rejects.toThrow(
      UnprocessableEntityException,
    );
    expect(prisma.medication.create).not.toHaveBeenCalled();
  });

  it('a high-criticality allergy cannot be overridden with a reason', async () => {
    (prisma.allergy.findMany as jest.Mock).mockResolvedValue([
      { id: 'a1', code: '161', code_display: 'Paracetamol', criticality: 'high', substance_rxnorm: '161', reaction: [], clinical_status: 'active' },
    ]);
    await expect(
      run(() =>
        service.prescribe({ ...baseDto, allergy_override_reason: 'Benefit outweighs the risk here' }),
      ),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(prisma.medication.create).not.toHaveBeenCalled();
  });

  it('requires a documented reason to prescribe past a low-criticality allergy', async () => {
    (prisma.allergy.findMany as jest.Mock).mockResolvedValue([
      { id: 'a1', code: '161', code_display: 'Paracetamol', criticality: 'low', substance_rxnorm: '161', reaction: ['rash'], clinical_status: 'active' },
    ]);
    await expect(run(() => service.prescribe(baseDto))).rejects.toThrow(
      /reason is required/,
    );

    await run(() =>
      service.prescribe({ ...baseDto, allergy_override_reason: 'Mild rash only; benefit outweighs risk' }),
    );
    expect(prisma.medication.create).toHaveBeenCalled();
    const data = (prisma.medication.create as jest.Mock).mock.calls[0][0].data;
    expect(data.allergy_override_reason).toBe('Mild rash only; benefit outweighs risk');
  });

  it('blocks a contraindicated interaction even when an override reason is supplied', async () => {
    (prisma.medication.findMany as jest.Mock).mockResolvedValue([
      { code: '11289', code_display: 'Warfarin' },
    ]);
    (prisma.drugInteraction.findMany as jest.Mock).mockResolvedValue([
      { rxnorm_a: '161', rxnorm_b: '11289', severity: 'contraindicated', clinical_effect: 'Major bleeding risk', management: null },
    ]);
    await expect(
      run(() =>
        service.prescribe({ ...baseDto, interaction_override_reason: 'Accepting the risk for now' }),
      ),
    ).rejects.toThrow(UnprocessableEntityException);
    expect(prisma.medication.create).not.toHaveBeenCalled();
  });

  it('allows a major interaction to proceed with a documented reason', async () => {
    (prisma.medication.findMany as jest.Mock).mockResolvedValue([
      { code: '11289', code_display: 'Warfarin' },
    ]);
    (prisma.drugInteraction.findMany as jest.Mock).mockResolvedValue([
      { rxnorm_a: '161', rxnorm_b: '11289', severity: 'major', clinical_effect: 'Increased INR', management: 'Monitor INR closely' },
    ]);
    await expect(run(() => service.prescribe(baseDto))).rejects.toThrow(ConflictException);

    const result = await run(() =>
      service.prescribe({ ...baseDto, interaction_override_reason: 'INR monitored daily on the ward' }),
    );
    expect(prisma.medication.create).toHaveBeenCalled();
    // The accepted risk is carried on the order, not silently dropped.
    expect(result.safety.interaction_warnings).toHaveLength(1);
    expect(result.safety.overridden).toBe(true);
  });

  it('returns moderate interactions as warnings without blocking', async () => {
    (prisma.medication.findMany as jest.Mock).mockResolvedValue([
      { code: '11289', code_display: 'Warfarin' },
    ]);
    (prisma.drugInteraction.findMany as jest.Mock).mockResolvedValue([
      { rxnorm_a: '161', rxnorm_b: '11289', severity: 'moderate', clinical_effect: 'Minor additive effect', management: null },
    ]);
    const result = await run(() => service.prescribe(baseDto));
    expect(result.safety.interaction_warnings).toHaveLength(1);
    expect(prisma.medication.create).toHaveBeenCalled();
  });

  it('requires a witness for a controlled drug', async () => {
    (prisma.drugFormulary.findFirst as jest.Mock).mockResolvedValue({
      id: 'f1',
      generic_name: 'Morphine',
      is_controlled: true,
      controlled_schedule: 'CD2',
    });
    await expect(
      run(() => service.prescribe({ ...baseDto, drug_formulary_id: '0193c3f0-0000-7000-8000-0000000000f1' })),
    ).rejects.toThrow(BadRequestException);
  });

  it('refuses the prescriber as their own witness', async () => {
    (prisma.drugFormulary.findFirst as jest.Mock).mockResolvedValue({
      id: 'f1',
      generic_name: 'Morphine',
      is_controlled: true,
      controlled_schedule: 'CD2',
    });
    await expect(
      run(() =>
        service.prescribe({
          ...baseDto,
          drug_formulary_id: '0193c3f0-0000-7000-8000-0000000000f1',
          witness_id: 'u1',
        }),
      ),
    ).rejects.toThrow(/different person/);
  });

  it('writes a controlled drug register entry when a witness is supplied', async () => {
    (prisma.drugFormulary.findFirst as jest.Mock).mockResolvedValue({
      id: 'f1',
      generic_name: 'Morphine',
      is_controlled: true,
      controlled_schedule: 'CD2',
    });
    await run(() =>
      service.prescribe({
        ...baseDto,
        code_display: 'Morphine 10mg',
        drug_formulary_id: '0193c3f0-0000-7000-8000-0000000000f1',
        witness_id: '0193c3f0-0000-7000-8000-0000000000u2',
      }),
    );
    expect(prisma.controlledDrugRegister.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ schedule: 'CD2', entry_type: 'prescribed' }),
      }),
    );
  });

  it('publishes a FHIR sync event for the new MedicationRequest', async () => {
    await run(() => service.prescribe(baseDto));
    expect(kafka.emit).toHaveBeenCalledWith(
      'medicore.fhir.sync',
      't1',
      expect.objectContaining({ resource_type: 'MedicationRequest', operation: 'create' }),
    );
  });
});

describe('InteractionsService', () => {
  let prisma: PrismaService;
  let service: InteractionsService;

  beforeEach(() => {
    prisma = {
      medication: { findMany: jest.fn() },
      drugInteraction: { findMany: jest.fn() },
    } as unknown as PrismaService;
    service = new InteractionsService(prisma);
  });

  it('short-circuits when the patient has no other active medications', async () => {
    (prisma.medication.findMany as jest.Mock).mockResolvedValue([]);
    const r = await run(() => service.check('p1', { rxnorm: '161', name: 'Paracetamol' }));
    expect(r.blocked).toBe(false);
    expect(prisma.drugInteraction.findMany).not.toHaveBeenCalled();
  });

  it('matches a pair regardless of the stored column order', async () => {
    (prisma.medication.findMany as jest.Mock).mockResolvedValue([{ code: '11289', code_display: 'Warfarin' }]);
    (prisma.drugInteraction.findMany as jest.Mock).mockResolvedValue([
      { rxnorm_a: '11289', rxnorm_b: '161', severity: 'major', clinical_effect: 'Bleeding', management: null },
    ]);
    const r = await run(() => service.check('p1', { rxnorm: '161', name: 'Paracetamol' }));
    expect(r.blocked).toBe(false);
    expect(r.requires_override).toBe(true);
    expect(r.findings[0]!.drug_a).toBe('Warfarin');
    expect(r.findings[0]!.drug_b).toBe('Paracetamol');
  });

  it('excludes the candidate drug from its own interaction pair set', async () => {
    (prisma.medication.findMany as jest.Mock).mockResolvedValue([{ code: '161', code_display: 'Paracetamol' }]);
    const r = await run(() => service.check('p1', { rxnorm: '161', name: 'Paracetamol' }));
    expect(r.findings).toHaveLength(0);
  });

  it('only a contraindication reaches assertNotBlocked; a major one is the caller\'s to override', () => {
    const finding = {
      rxnorm_a: 'a',
      rxnorm_b: 'b',
      drug_a: 'A',
      drug_b: 'B',
      severity: 'major' as const,
      mechanism: null,
      clinical_effect: 'x',
      management: null,
      explanation: 'x',
      action: 'override' as const,
      source: 'bundled' as const,
    };

    // Major does not block, so nothing is thrown here at all.
    expect(() =>
      service.assertNotBlocked(
        { blocked: false, requires_override: true, findings: [finding] },
        'A',
      ),
    ).not.toThrow();

    const contra = {
      blocked: true,
      requires_override: false,
      findings: [{ ...finding, severity: 'contraindicated' as const, action: 'block' as const }],
    };
    expect(() => service.assertNotBlocked(contra, 'A')).toThrow(UnprocessableEntityException);
    try {
      service.assertNotBlocked(contra, 'A');
    } catch (e) {
      const body = (e as UnprocessableEntityException).getResponse() as Record<string, unknown>;
      expect(body.override_allowed).toBe(false);
      expect(body.code).toBe('DRUG_INTERACTION');
    }
  });
});
