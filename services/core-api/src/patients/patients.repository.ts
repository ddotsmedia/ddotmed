import { Injectable } from '@nestjs/common';
import type { Patient } from '@prisma/client';
import { BaseRepository, type DelegateLike } from '../common/base.repository';
import { PrismaService } from '../common/prisma.service';
import { normalizeName } from './duplicate-detection';
import { parseQuery, rankPatients, type RankedPatient } from './search-ranking';
import { sortTimeline, type TimelineEntry } from './timeline';

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

  /**
   * Unified search. One box on the screen, so the query shape decides which
   * columns are even worth touching: a numeric string never runs a name scan.
   * A wide OR fetches candidates, then ranking orders them by how uniquely the
   * matched field identifies a person.
   */
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
    const base: Record<string, unknown> = {
      tenant_id: this.tenantId,
      deleted_at: null,
      ...(params.includeMerged ? {} : { merged_into_id: null }),
      ...(params.gender ? { gender: params.gender } : {}),
    };

    // Explicit field filters still work and are combined with AND.
    if (params.mrn) base.mrn = params.mrn;
    if (params.birthDate) base.birth_date = new Date(params.birthDate);
    if (params.identifier) {
      base.identifiers = {
        some: {
          deleted_at: null,
          value_normalized: params.identifier.replace(/[\s-]/g, '').toUpperCase(),
          ...(params.identifierType ? { type: params.identifierType } : {}),
        },
      };
    }
    if (params.phone) {
      base.contacts = { some: { deleted_at: null, value: { contains: params.phone } } };
    }

    const parsed = parseQuery(params.q ?? '');
    const include = {
      identifiers: { where: { deleted_at: null } },
      contacts: { where: { deleted_at: null } },
      coverages: {
        where: { deleted_at: null, status: 'active' },
        include: { payer: { select: { name: true, code: true } } },
      },
    } as const;

    if (parsed.kind === 'empty') {
      const where = base;
      const [data, total] = await Promise.all([
        this.prisma.patient.findMany({
          where,
          include,
          orderBy: { updated_at: 'desc' },
          skip: (params.page - 1) * params.limit,
          take: params.limit,
        }),
        this.prisma.patient.count({ where }),
      ]);
      return {
        data: data.map((p) => ({ ...p, match_score: null, matched_on: null })),
        total,
        page: params.page,
        limit: params.limit,
        pages: Math.ceil(total / params.limit),
      };
    }

    const or: Record<string, unknown>[] = [];
    if (parsed.normalized && parsed.kind !== 'numeric') {
      or.push({ name_search: { contains: parsed.normalized } });
    }
    if (parsed.identifier) {
      or.push({ mrn: { contains: parsed.identifier, mode: 'insensitive' } });
      or.push({
        identifiers: {
          some: { deleted_at: null, value_normalized: { contains: parsed.identifier } },
        },
      });
      or.push({
        coverages: {
          some: {
            deleted_at: null,
            OR: [
              { member_id: { contains: parsed.identifier, mode: 'insensitive' } },
              { policy_number: { contains: parsed.identifier, mode: 'insensitive' } },
            ],
          },
        },
      });
    }
    if (parsed.digits.length >= 4) {
      or.push({ contacts: { some: { deleted_at: null, value: { contains: parsed.digits } } } });
    }
    if (parsed.isoDate) {
      or.push({ birth_date: new Date(parsed.isoDate) });
    }

    const where = { ...base, ...(or.length ? { OR: or } : {}) };

    // Ranking needs the whole candidate set, so fetch a bounded superset and
    // paginate after scoring rather than letting the database order the page.
    const candidates = await this.prisma.patient.findMany({
      where,
      include,
      take: 500,
      orderBy: { updated_at: 'desc' },
    });

    const ranked = rankPatients(params.q ?? '', candidates as never) as RankedPatient<
      (typeof candidates)[number]
    >[];
    const offset = (params.page - 1) * params.limit;

    return {
      data: ranked.slice(offset, offset + params.limit).map((r) => ({
        ...r.patient,
        match_score: r.score,
        matched_on: r.matchedOn,
      })),
      total: ranked.length,
      page: params.page,
      limit: params.limit,
      pages: Math.max(1, Math.ceil(ranked.length / params.limit)),
      truncated: candidates.length === 500,
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

  /**
   * Reverse-chronological clinical timeline across every domain.
   * Each domain is read on its own (tenant, patient, time) index and merged in
   * memory; a UNION over eight differently-shaped tables would be slower and
   * far harder to extend.
   */
  async timeline(patientId: string, limit: number): Promise<TimelineEntry[]> {
    const scope = { tenant_id: this.tenantId, patient_id: patientId, deleted_at: null };
    const take = Math.min(limit, 200);

    const [encounters, conditions, meds, labs, notes, imaging, vitals, admissions] =
      await Promise.all([
        this.prisma.encounter.findMany({ where: scope, orderBy: { period_start: 'desc' }, take }),
        this.prisma.condition.findMany({ where: scope, orderBy: { created_at: 'desc' }, take }),
        this.prisma.medication.findMany({ where: scope, orderBy: { created_at: 'desc' }, take }),
        this.prisma.labResult.findMany({ where: scope, orderBy: { performed_at: 'desc' }, take }),
        this.prisma.clinicalNote.findMany({ where: scope, orderBy: { created_at: 'desc' }, take }),
        this.prisma.imagingStudy.findMany({ where: scope, orderBy: { created_at: 'desc' }, take }),
        this.prisma.vital.findMany({ where: scope, orderBy: { recorded_at: 'desc' }, take }),
        this.prisma.admission.findMany({ where: scope, orderBy: { admitted_at: 'desc' }, take }),
      ]);

    const entries: TimelineEntry[] = [
      ...encounters.map((e) => ({
        id: e.id,
        type: 'encounter' as const,
        at: e.period_start,
        title: e.type_display ?? e.class,
        detail: e.reason_text,
        severity: (e.triage_level !== null && e.triage_level <= 2 ? 'critical' : 'normal') as
          TimelineEntry['severity'],
        encounter_id: e.id,
        data: e as unknown as Record<string, unknown>,
      })),
      ...conditions.map((c) => ({
        id: c.id,
        type: 'condition' as const,
        at: c.created_at,
        title: c.code_display ?? c.code,
        detail: c.code,
        severity: (c.severity === 'severe' ? 'warning' : 'normal') as TimelineEntry['severity'],
        encounter_id: c.encounter_id,
        data: c as unknown as Record<string, unknown>,
      })),
      ...meds.map((m) => ({
        id: m.id,
        type: 'medication' as const,
        at: m.created_at,
        title: m.code_display,
        detail: `${m.dose_quantity} ${m.dose_unit} ${m.route} ${m.frequency}`,
        severity: (m.is_controlled ? 'warning' : 'normal') as TimelineEntry['severity'],
        encounter_id: m.encounter_id,
        data: m as unknown as Record<string, unknown>,
      })),
      ...labs.map((l) => ({
        id: l.id,
        type: 'lab' as const,
        at: l.performed_at,
        title: l.display,
        detail: [l.value_quantity ?? l.value_string, l.unit].filter(Boolean).join(' ') || null,
        severity: (l.is_critical ? 'critical' : l.interpretation && l.interpretation !== 'N' ? 'warning' : 'normal') as
          TimelineEntry['severity'],
        encounter_id: l.encounter_id,
        data: l as unknown as Record<string, unknown>,
      })),
      ...notes.map((n) => ({
        id: n.id,
        type: 'note' as const,
        at: n.created_at,
        title: `${n.type} note`,
        detail: n.status,
        severity: 'normal' as TimelineEntry['severity'],
        encounter_id: n.encounter_id,
        data: n as unknown as Record<string, unknown>,
      })),
      ...imaging.map((i) => ({
        id: i.id,
        type: 'imaging' as const,
        at: i.created_at,
        title: `${i.modality} ${i.description ?? ''}`.trim(),
        detail: i.body_site,
        severity: 'normal' as TimelineEntry['severity'],
        encounter_id: i.encounter_id,
        data: i as unknown as Record<string, unknown>,
      })),
      ...vitals.map((v) => ({
        id: v.id,
        type: 'vitals' as const,
        at: v.recorded_at,
        title: v.ews_score !== null ? `EWS ${v.ews_score}` : 'Vitals',
        detail: [
          v.systolic_bp ? `BP ${v.systolic_bp}/${v.diastolic_bp ?? ''}` : null,
          v.heart_rate ? `HR ${v.heart_rate}` : null,
          v.spo2 ? `SpO2 ${v.spo2}%` : null,
        ]
          .filter(Boolean)
          .join('  ') || null,
        severity: (v.ews_risk === 'high' ? 'critical' : v.ews_risk === 'medium' ? 'warning' : 'normal') as
          TimelineEntry['severity'],
        encounter_id: v.encounter_id,
        data: v as unknown as Record<string, unknown>,
      })),
      ...admissions.map((a) => ({
        id: a.id,
        type: 'admission' as const,
        at: a.admitted_at,
        title: `Admitted (${a.admission_type})`,
        detail: a.admission_reason,
        severity: 'normal' as TimelineEntry['severity'],
        encounter_id: a.encounter_id,
        data: a as unknown as Record<string, unknown>,
      })),
    ];

    return sortTimeline(entries).slice(0, limit);
  }
}
