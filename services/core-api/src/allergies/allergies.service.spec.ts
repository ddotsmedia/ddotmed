import { ConflictException } from '@nestjs/common';
import { AllergiesService } from './allergies.service';
import type { PrismaService } from '../common/prisma.service';
import type { KafkaService } from '../messaging/kafka.service';
import { requestContext, type RequestContext } from '../common/tenant-context';

const ctx: RequestContext = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  roles: ['doctor'],
  permissions: [],
  isBreakGlass: false,
  ip: null,
  userAgent: null,
  requestId: 'r1',
};

const run = <T>(fn: () => T): T => requestContext.run(ctx, fn);

describe('AllergiesService', () => {
  let prisma: PrismaService;
  let kafka: KafkaService;
  let service: AllergiesService;

  beforeEach(() => {
    prisma = {
      allergy: { findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
    } as unknown as PrismaService;
    kafka = { emit: jest.fn().mockResolvedValue(undefined) } as unknown as KafkaService;
    service = new AllergiesService(prisma, kafka);
  });

  const allergy = (over: Record<string, unknown> = {}) => ({
    id: 'a1',
    code: '387517004',
    code_display: 'Paracetamol',
    criticality: 'high',
    substance_rxnorm: '161',
    reaction: ['anaphylaxis'],
    clinical_status: 'active',
    ...over,
  });

  it('blocks when a high-criticality allergy matches by RxNorm code', async () => {
    (prisma.allergy.findMany as jest.Mock).mockResolvedValue([allergy()]);
    const result = await run(() =>
      service.checkAgainstDrug('p1', { rxnorm: '161', name: 'Panadol 500mg' }),
    );
    expect(result.blocked).toBe(true);
    expect(result.warnings[0]!.action).toBe('block');
  });

  it('blocks when a high-criticality allergy matches by substance name', async () => {
    (prisma.allergy.findMany as jest.Mock).mockResolvedValue([allergy({ substance_rxnorm: null })]);
    const result = await run(() =>
      service.checkAgainstDrug('p1', { rxnorm: null, name: 'Paracetamol 500mg tablet' }),
    );
    expect(result.blocked).toBe(true);
  });

  it('matches against an ingredient rather than only the brand name', async () => {
    (prisma.allergy.findMany as jest.Mock).mockResolvedValue([allergy({ substance_rxnorm: null })]);
    const result = await run(() =>
      service.checkAgainstDrug('p1', {
        rxnorm: null,
        name: 'Panadol Extra',
        ingredients: ['Paracetamol', 'Caffeine'],
      }),
    );
    expect(result.blocked).toBe(true);
  });

  it('warns but does not block for low criticality', async () => {
    (prisma.allergy.findMany as jest.Mock).mockResolvedValue([allergy({ criticality: 'low' })]);
    const result = await run(() =>
      service.checkAgainstDrug('p1', { rxnorm: '161', name: 'Paracetamol' }),
    );
    expect(result.blocked).toBe(false);
    expect(result.warnings[0]!.action).toBe('warn');
  });

  it('returns clear when no allergy matches the drug', async () => {
    (prisma.allergy.findMany as jest.Mock).mockResolvedValue([allergy()]);
    const result = await run(() =>
      service.checkAgainstDrug('p1', { rxnorm: '999', name: 'Amoxicillin' }),
    );
    expect(result.blocked).toBe(false);
    expect(result.warnings).toHaveLength(0);
  });

  it('only considers active allergies of a drug-relevant category', async () => {
    (prisma.allergy.findMany as jest.Mock).mockResolvedValue([]);
    await run(() => service.checkAgainstDrug('p1', { rxnorm: '161', name: 'Paracetamol' }));
    expect(prisma.allergy.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          clinical_status: 'active',
          deleted_at: null,
          category: { in: ['medication', 'biologic', 'contrast', 'latex'] },
        }),
      }),
    );
  });

  it('throws a ConflictException that forbids override when blocked', () => {
    expect(() =>
      service.assertNotBlocked(
        {
          blocked: true,
          warnings: [
            { allergy_id: 'a1', substance: 'Paracetamol', criticality: 'high', reaction: ['anaphylaxis'], action: 'block' },
          ],
        },
        'Panadol',
      ),
    ).toThrow(ConflictException);

    try {
      service.assertNotBlocked(
        {
          blocked: true,
          warnings: [
            { allergy_id: 'a1', substance: 'Paracetamol', criticality: 'high', reaction: [], action: 'block' },
          ],
        },
        'Panadol',
      );
    } catch (e) {
      const body = (e as ConflictException).getResponse() as Record<string, unknown>;
      expect(body.code).toBe('ALLERGY_CONTRAINDICATION');
      expect(body.override_allowed).toBe(false);
    }
  });

  it('does not throw when only warnings are present', () => {
    expect(() =>
      service.assertNotBlocked(
        {
          blocked: false,
          warnings: [
            { allergy_id: 'a1', substance: 'Paracetamol', criticality: 'low', reaction: [], action: 'warn' },
          ],
        },
        'Panadol',
      ),
    ).not.toThrow();
  });

  it('raises a critical alert when a high-criticality allergy is recorded', async () => {
    (prisma.allergy.create as jest.Mock).mockResolvedValue(
      allergy({ id: 'a9', fhir_id: null, patient_id: 'p1' }),
    );
    await run(() =>
      service.record({
        patient_id: 'p1',
        type: 'allergy',
        category: 'medication',
        criticality: 'high',
        code_system: 'http://snomed.info/sct',
        code: '387517004',
        code_display: 'Paracetamol',
        reaction: ['anaphylaxis'],
      }),
    );
    const topics = (kafka.emit as jest.Mock).mock.calls.map((c) => c[0]);
    expect(topics).toContain('medicore.clinical.critical-alert');
  });

  it('does not raise a critical alert for a low-criticality allergy', async () => {
    (prisma.allergy.create as jest.Mock).mockResolvedValue(
      allergy({ id: 'a9', criticality: 'low', fhir_id: null, patient_id: 'p1' }),
    );
    await run(() =>
      service.record({
        patient_id: 'p1',
        type: 'allergy',
        category: 'food',
        criticality: 'low',
        code_system: 'http://snomed.info/sct',
        code: '1',
        reaction: [],
      }),
    );
    const topics = (kafka.emit as jest.Mock).mock.calls.map((c) => c[0]);
    expect(topics).not.toContain('medicore.clinical.critical-alert');
  });
});
