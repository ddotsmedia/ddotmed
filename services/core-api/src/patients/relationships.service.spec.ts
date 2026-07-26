import { BadRequestException } from '@nestjs/common';
import { RelationshipsService, RELATIONSHIP_TYPES } from './relationships.service';
import type { PrismaService } from '../common/prisma.service';
import { requestContext, type RequestContext } from '../common/tenant-context';

const ctx: RequestContext = {
  tenantId: 't1',
  userId: 'u1',
  sessionId: 's1',
  roles: ['receptionist'],
  permissions: [],
  isBreakGlass: false,
  ip: null,
  userAgent: null,
  requestId: 'r1',
};

const run = <T>(fn: () => Promise<T>): Promise<T> => requestContext.run(ctx, fn);

const A = '0193c3f0-0000-7000-8000-00000000000a';
const B = '0193c3f0-0000-7000-8000-00000000000b';

describe('RelationshipsService', () => {
  let prisma: PrismaService;
  let service: RelationshipsService;

  beforeEach(() => {
    prisma = {
      patient: { findFirst: jest.fn().mockResolvedValue({ id: 'exists' }) },
      patientRelationship: {
        upsert: jest.fn().mockResolvedValue({ id: 'rel1' }),
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      $transaction: jest.fn((ops: unknown[]) => Promise.resolve(ops)),
    } as unknown as PrismaService;
    service = new RelationshipsService(prisma);
  });

  it('exposes a relationship vocabulary', () => {
    expect(RELATIONSHIP_TYPES).toEqual(expect.arrayContaining(['mother', 'child', 'spouse', 'sibling']));
  });

  it('refuses to relate a patient to themselves', async () => {
    await expect(
      run(() => service.link({ patient_id: A, related_patient_id: A, relationship: 'sibling', is_emergency_contact: false, is_guarantor: false })),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects a link when either patient does not exist', async () => {
    (prisma.patient.findFirst as jest.Mock).mockResolvedValueOnce(null);
    await expect(
      run(() => service.link({ patient_id: A, related_patient_id: B, relationship: 'spouse', is_emergency_contact: false, is_guarantor: false })),
    ).rejects.toThrow(/Both patients must exist/);
  });

  it('writes the inverse link so the relationship shows on both charts', async () => {
    await run(() =>
      service.link({ patient_id: A, related_patient_id: B, relationship: 'mother', is_emergency_contact: false, is_guarantor: false }),
    );

    const calls = (prisma.patientRelationship.upsert as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);

    // A is mother of B
    expect(calls[0][0].create).toMatchObject({
      patient_id: A,
      related_patient_id: B,
      relationship: 'mother',
      is_primary_record: true,
    });
    // therefore B is child of A
    expect(calls[1][0].create).toMatchObject({
      patient_id: B,
      related_patient_id: A,
      relationship: 'child',
      is_primary_record: false,
    });
  });

  it('marks genetic relationships as biological and social ones as not', async () => {
    await run(() =>
      service.link({ patient_id: A, related_patient_id: B, relationship: 'sibling', is_emergency_contact: false, is_guarantor: false }),
    );
    expect((prisma.patientRelationship.upsert as jest.Mock).mock.calls[0][0].create.is_biological).toBe(true);

    (prisma.patientRelationship.upsert as jest.Mock).mockClear();
    await run(() =>
      service.link({ patient_id: A, related_patient_id: B, relationship: 'spouse', is_emergency_contact: false, is_guarantor: false }),
    );
    expect((prisma.patientRelationship.upsert as jest.Mock).mock.calls[0][0].create.is_biological).toBe(false);
  });

  it('uses a symmetric inverse for spouse and sibling', async () => {
    for (const relationship of ['spouse', 'sibling'] as const) {
      (prisma.patientRelationship.upsert as jest.Mock).mockClear();
      await run(() =>
        service.link({ patient_id: A, related_patient_id: B, relationship, is_emergency_contact: false, is_guarantor: false }),
      );
      const calls = (prisma.patientRelationship.upsert as jest.Mock).mock.calls;
      expect(calls[1][0].create.relationship).toBe(relationship);
    }
  });

  it('soft-deletes both directions on unlink', async () => {
    (prisma.patientRelationship.findFirst as jest.Mock).mockResolvedValue({
      id: 'rel1',
      patient_id: A,
      related_patient_id: B,
      relationship: 'father',
    });

    await run(() => service.unlink('rel1', 'entered in error'));

    expect(prisma.patientRelationship.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'rel1' } }),
    );
    expect(prisma.patientRelationship.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ patient_id: B, related_patient_id: A, relationship: 'child' }),
      }),
    );
  });

  it('rejects unlinking a relationship that does not exist', async () => {
    (prisma.patientRelationship.findFirst as jest.Mock).mockResolvedValue(null);
    await expect(run(() => service.unlink('missing', 'x'))).rejects.toThrow(BadRequestException);
  });
});
