import { BadRequestException, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { currentContext } from '../common/tenant-context';

/** Relationship terms and the inverse written on the other patient's chart. */
const INVERSE: Record<string, string> = {
  mother: 'child',
  father: 'child',
  parent: 'child',
  child: 'parent',
  son: 'parent',
  daughter: 'parent',
  spouse: 'spouse',
  sibling: 'sibling',
  brother: 'sibling',
  sister: 'sibling',
  guardian: 'ward',
  ward: 'guardian',
  grandparent: 'grandchild',
  grandchild: 'grandparent',
  other: 'other',
};

export const RELATIONSHIP_TYPES = Object.keys(INVERSE);

/** Links that imply shared genetics, used to drive family-history prompts. */
const BIOLOGICAL = new Set([
  'mother', 'father', 'parent', 'child', 'son', 'daughter',
  'sibling', 'brother', 'sister', 'grandparent', 'grandchild',
]);

export const LinkRelativeDto = z.object({
  patient_id: z.string().uuid(),
  related_patient_id: z.string().uuid(),
  relationship: z.enum(RELATIONSHIP_TYPES as [string, ...string[]]),
  is_emergency_contact: z.boolean().default(false),
  is_guarantor: z.boolean().default(false),
  notes: z.string().max(500).optional(),
});

@Injectable()
export class RelationshipsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates the link and its inverse in one transaction, so a relationship is
   * never visible from only one side of the family.
   */
  async link(dto: z.infer<typeof LinkRelativeDto>) {
    const ctx = currentContext();
    if (dto.patient_id === dto.related_patient_id) {
      throw new BadRequestException('A patient cannot be related to themselves');
    }

    const [patient, relative] = await Promise.all([
      this.prisma.patient.findFirst({
        where: { id: dto.patient_id, tenant_id: ctx.tenantId, deleted_at: null },
        select: { id: true },
      }),
      this.prisma.patient.findFirst({
        where: { id: dto.related_patient_id, tenant_id: ctx.tenantId, deleted_at: null },
        select: { id: true },
      }),
    ]);
    if (!patient || !relative) throw new BadRequestException('Both patients must exist');

    const inverse = INVERSE[dto.relationship] ?? 'other';
    const biological = BIOLOGICAL.has(dto.relationship);

    const [primary] = await this.prisma.$transaction([
      this.prisma.patientRelationship.upsert({
        where: {
          patient_id_related_patient_id_relationship: {
            patient_id: dto.patient_id,
            related_patient_id: dto.related_patient_id,
            relationship: dto.relationship,
          },
        },
        update: {
          is_emergency_contact: dto.is_emergency_contact,
          is_guarantor: dto.is_guarantor,
          notes: dto.notes,
          deleted_at: null,
        },
        create: {
          tenant_id: ctx.tenantId,
          patient_id: dto.patient_id,
          related_patient_id: dto.related_patient_id,
          relationship: dto.relationship,
          is_primary_record: true,
          is_biological: biological,
          is_emergency_contact: dto.is_emergency_contact,
          is_guarantor: dto.is_guarantor,
          notes: dto.notes,
          recorded_by: ctx.userId,
        },
      }),
      this.prisma.patientRelationship.upsert({
        where: {
          patient_id_related_patient_id_relationship: {
            patient_id: dto.related_patient_id,
            related_patient_id: dto.patient_id,
            relationship: inverse,
          },
        },
        update: { deleted_at: null },
        create: {
          tenant_id: ctx.tenantId,
          patient_id: dto.related_patient_id,
          related_patient_id: dto.patient_id,
          relationship: inverse,
          is_primary_record: false,
          is_biological: biological,
          recorded_by: ctx.userId,
        },
      }),
    ]);

    return primary;
  }

  async forPatient(patientId: string) {
    return this.prisma.patientRelationship.findMany({
      where: { tenant_id: currentContext().tenantId, patient_id: patientId, deleted_at: null },
      include: {
        related_patient: {
          select: {
            id: true,
            mrn: true,
            given_names: true,
            family_name: true,
            birth_date: true,
            gender: true,
          },
        },
      },
      orderBy: { created_at: 'asc' },
    });
  }

  /** Soft-deletes both directions so neither chart keeps a dangling link. */
  async unlink(id: string, reason: string) {
    const ctx = currentContext();
    const row = await this.prisma.patientRelationship.findFirst({
      where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!row) throw new BadRequestException('Relationship not found');

    const inverse = INVERSE[row.relationship] ?? 'other';
    await this.prisma.$transaction([
      this.prisma.patientRelationship.update({
        where: { id: row.id },
        data: { deleted_at: new Date(), deleted_reason: reason },
      }),
      this.prisma.patientRelationship.updateMany({
        where: {
          tenant_id: ctx.tenantId,
          patient_id: row.related_patient_id,
          related_patient_id: row.patient_id,
          relationship: inverse,
          deleted_at: null,
        },
        data: { deleted_at: new Date(), deleted_reason: reason },
      }),
    ]);
    return { unlinked: true };
  }
}
