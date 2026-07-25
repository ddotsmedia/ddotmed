import { Injectable } from '@nestjs/common';
import type { Patient } from '@prisma/client';
import { BaseRepository, type DelegateLike } from '../common/base.repository';
import { PrismaService } from '../common/prisma.service';
import { normalizeName } from './duplicate-detection';

@Injectable()
export class PatientsRepository extends BaseRepository<Patient> {
  protected readonly resourceName = 'Patient';
  protected readonly delegate: DelegateLike;

  constructor(private readonly prisma: PrismaService) {
    super();
    this.delegate = prisma.patient as unknown as DelegateLike;
  }

  /**
   * MRN format: <prefix><YY><6-digit sequence>. Allocated inside a transaction that
   * re-reads the current maximum, so two concurrent registrations cannot collide.
   */
  async allocateMrn(prefix = 'MRN'): Promise<string> {
    const year = new Date().getFullYear().toString().slice(2);
    const stem = `${prefix}${year}`;
    return this.prisma.$transaction(async (tx) => {
      const last = await tx.patient.findFirst({
        where: { tenant_id: this.tenantId, mrn: { startsWith: stem } },
        orderBy: { mrn: 'desc' },
        select: { mrn: true },
      });
      const next = last ? Number(last.mrn.slice(stem.length)) + 1 : 1;
      return `${stem}${String(next).padStart(6, '0')}`;
    });
  }

  async findDuplicateCandidates(familyName: string, birthDate: string) {
    const year = birthDate.slice(0, 4);
    return this.prisma.patient.findMany({
      where: {
        tenant_id: this.tenantId,
        deleted_at: null,
        merged_into_id: null,
        OR: [
          { name_search: { contains: normalizeName(familyName) } },
          {
            birth_date: {
              gte: new Date(`${year}-01-01T00:00:00Z`),
              lte: new Date(`${year}-12-31T23:59:59Z`),
            },
          },
        ],
      },
      select: {
        id: true,
        mrn: true,
        given_names: true,
        family_name: true,
        birth_date: true,
        gender: true,
      },
      take: 200,
    });
  }

  async search(params: {
    q?: string;
    mrn?: string;
    identifier?: string;
    identifierType?: string;
    birthDate?: string;
    gender?: string;
    phone?: string;
    includeMerged: boolean;
    page: number;
    limit: number;
  }) {
    const where: Record<string, unknown> = {
      tenant_id: this.tenantId,
      deleted_at: null,
      ...(params.includeMerged ? {} : { merged_into_id: null }),
      ...(params.mrn ? { mrn: params.mrn } : {}),
      ...(params.gender ? { gender: params.gender } : {}),
      ...(params.birthDate ? { birth_date: new Date(params.birthDate) } : {}),
      ...(params.q ? { name_search: { contains: normalizeName(params.q) } } : {}),
      ...(params.identifier
        ? {
            identifiers: {
              some: {
                deleted_at: null,
                value_normalized: params.identifier.replace(/[\s-]/g, '').toUpperCase(),
                ...(params.identifierType ? { type: params.identifierType } : {}),
              },
            },
          }
        : {}),
      ...(params.phone
        ? { contacts: { some: { deleted_at: null, value: { contains: params.phone } } } }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.patient.findMany({
        where,
        include: { identifiers: { where: { deleted_at: null } }, contacts: { where: { deleted_at: null } } },
        orderBy: { updated_at: 'desc' },
        skip: (params.page - 1) * params.limit,
        take: params.limit,
      }),
      this.prisma.patient.count({ where }),
    ]);

    return {
      data,
      total,
      page: params.page,
      limit: params.limit,
      pages: Math.ceil(total / params.limit),
    };
  }

  async fullProfile(id: string) {
    return this.prisma.patient.findFirst({
      where: { id, tenant_id: this.tenantId, deleted_at: null },
      include: {
        identifiers: { where: { deleted_at: null } },
        contacts: { where: { deleted_at: null } },
        allergies: { where: { deleted_at: null, clinical_status: 'active' } },
        conditions: {
          where: { deleted_at: null, category: 'problem_list_item', clinical_status: 'active' },
        },
        medications: { where: { deleted_at: null, status: 'active' } },
        coverages: { where: { deleted_at: null, status: 'active' }, include: { payer: true } },
        encounters: { where: { deleted_at: null }, orderBy: { period_start: 'desc' }, take: 5 },
        vitals: { where: { deleted_at: null }, orderBy: { recorded_at: 'desc' }, take: 1 },
      },
    });
  }

  /** Reverse-chronological clinical timeline assembled across the record types. */
  async timeline(patientId: string, limit: number) {
    const scope = { tenant_id: this.tenantId, patient_id: patientId, deleted_at: null };
    const [encounters, conditions, meds, labs, notes, imaging, vitals] = await Promise.all([
      this.prisma.encounter.findMany({ where: scope, orderBy: { period_start: 'desc' }, take: limit }),
      this.prisma.condition.findMany({ where: scope, orderBy: { created_at: 'desc' }, take: limit }),
      this.prisma.medication.findMany({ where: scope, orderBy: { created_at: 'desc' }, take: limit }),
      this.prisma.labResult.findMany({ where: scope, orderBy: { performed_at: 'desc' }, take: limit }),
      this.prisma.clinicalNote.findMany({ where: scope, orderBy: { created_at: 'desc' }, take: limit }),
      this.prisma.imagingStudy.findMany({ where: scope, orderBy: { created_at: 'desc' }, take: limit }),
      this.prisma.vital.findMany({ where: scope, orderBy: { recorded_at: 'desc' }, take: limit }),
    ]);

    const entries = [
      ...encounters.map((e) => ({ type: 'encounter', at: e.period_start, id: e.id, summary: e.reason_text ?? e.type_display ?? e.class, data: e })),
      ...conditions.map((c) => ({ type: 'condition', at: c.created_at, id: c.id, summary: `${c.code} ${c.code_display ?? ''}`.trim(), data: c })),
      ...meds.map((m) => ({ type: 'medication', at: m.created_at, id: m.id, summary: m.code_display, data: m })),
      ...labs.map((l) => ({ type: 'lab', at: l.performed_at, id: l.id, summary: `${l.display}: ${l.value_quantity ?? l.value_string ?? ''} ${l.unit ?? ''}`.trim(), data: l })),
      ...notes.map((n) => ({ type: 'note', at: n.created_at, id: n.id, summary: `${n.type} note`, data: n })),
      ...imaging.map((i) => ({ type: 'imaging', at: i.created_at, id: i.id, summary: `${i.modality} ${i.description ?? ''}`.trim(), data: i })),
      ...vitals.map((v) => ({ type: 'vitals', at: v.recorded_at, id: v.id, summary: `EWS ${v.ews_score ?? '-'}`, data: v })),
    ];

    return entries.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
  }
}
