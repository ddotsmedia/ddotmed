import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { getCountryPack } from '@medicore/country-packs';
import { KAFKA_TOPICS, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { patientToFhir } from '../fhir/mappers';
import { PatientsRepository } from './patients.repository';
import { normalizeName, scoreDuplicates } from './duplicate-detection';
import type { MergePatientDto, RegisterPatientDto, SearchPatientDto, UpdatePatientDto } from './patients.dto';

@Injectable()
export class PatientsService {
  constructor(
    private readonly repo: PatientsRepository,
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  private async countryPack() {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: currentContext().tenantId },
      select: { country_pack: true },
    });
    return getCountryPack(tenant?.country_pack ?? 'uae');
  }

  private searchKey(given: string[], family: string): string {
    return [...given, family].map(normalizeName).join(' ');
  }

  async findDuplicates(dto: Pick<RegisterPatientDto, 'given_names' | 'family_name' | 'birth_date' | 'gender'>) {
    const candidates = await this.repo.findDuplicateCandidates(dto.family_name, dto.birth_date);
    return scoreDuplicates(dto, candidates);
  }

  async register(dto: RegisterPatientDto) {
    const pack = await this.countryPack();

    // Validate every supplied identifier against the active country pack before writing.
    const normalizedIdentifiers = dto.identifiers.map((i) => {
      const result = pack.validatePatientId(i.type, i.value);
      if (!result.valid) {
        throw new BadRequestException(`${i.type}: ${result.error ?? 'invalid identifier'}`);
      }
      return {
        ...i,
        value: result.normalized ?? i.value,
        value_normalized: (result.normalized ?? i.value).replace(/[\s-]/g, '').toUpperCase(),
      };
    });

    if (!dto.force_create) {
      const duplicates = await this.findDuplicates(dto);
      if (duplicates.length > 0) {
        throw new ConflictException({
          message: 'Possible duplicate patient records found',
          code: 'DUPLICATE_PATIENT',
          candidates: duplicates.slice(0, 5).map((d) => ({
            id: d.patient.id,
            mrn: d.patient.mrn,
            name: `${d.patient.given_names.join(' ')} ${d.patient.family_name}`,
            birth_date: d.patient.birth_date,
            score: d.score,
            reasons: d.reasons,
          })),
          hint: 'Resubmit with force_create=true to register a new record anyway',
        });
      }
    }

    const mrn = await this.repo.allocateMrn();
    const tenantId = currentContext().tenantId;

    const patient = await this.prisma.patient.create({
      data: {
        tenant_id: tenantId,
        mrn,
        given_names: dto.given_names,
        family_name: dto.family_name,
        name_search: this.searchKey(dto.given_names, dto.family_name),
        gender: dto.gender,
        birth_date: new Date(dto.birth_date),
        nationality: dto.nationality,
        preferred_language: dto.preferred_language,
        marital_status: dto.marital_status,
        blood_group: dto.blood_group,
        address: dto.address ?? undefined,
        photo_url: dto.photo_url ?? null,
        is_vip: dto.is_vip,
        country_pack: pack.code,
        identifiers: {
          create: [
            { tenant_id: tenantId, type: 'mrn', value: mrn, value_normalized: mrn, is_primary: true },
            ...normalizedIdentifiers.map((i) => ({
              tenant_id: tenantId,
              type: i.type,
              value: i.value,
              value_normalized: i.value_normalized,
              system: i.system,
              country: i.country,
              is_primary: i.is_primary,
              expires_at: i.expires_at ?? null,
            })),
          ],
        },
        contacts: {
          create: dto.contacts.map((c) => ({
            tenant_id: tenantId,
            relationship: c.relationship,
            given_names: c.given_names,
            family_name: c.family_name,
            system: c.system,
            value: c.value,
            use: c.use,
            is_emergency: c.is_emergency,
            is_primary: c.is_primary,
          })),
        },
      },
      include: { identifiers: true, contacts: true },
    });

    // Coverage is created after the patient so it can reference the new id, and is
    // best-effort: a bad payer reference must not lose a completed registration.
    if (dto.insurance) {
      await this.prisma.coverage
        .create({
          data: {
            tenant_id: tenantId,
            patient_id: patient.id,
            payer_id: dto.insurance.payer_id,
            member_id: dto.insurance.member_id,
            policy_number: dto.insurance.policy_number,
            plan_name: dto.insurance.plan_name,
            relationship: dto.insurance.relationship,
            status: 'active',
            starts_at: dto.insurance.starts_at,
            ends_at: dto.insurance.ends_at ?? null,
          },
        })
        .catch(() => undefined);
    }

    await this.publishSync(patient.id, 'create');
    return patient;
  }

  async search(dto: SearchPatientDto) {
    return this.repo.search({
      q: dto.q,
      mrn: dto.mrn,
      identifier: dto.identifier,
      identifierType: dto.identifier_type,
      birthDate: dto.birth_date,
      gender: dto.gender,
      phone: dto.phone,
      includeMerged: dto.include_merged,
      page: dto.page,
      limit: dto.limit,
    });
  }

  async getFullProfile(id: string) {
    const patient = await this.repo.fullProfile(id);
    if (!patient) throw new NotFoundException(`Patient ${id} not found`);
    return patient;
  }

  async update(id: string, dto: UpdatePatientDto) {
    const existing = await this.repo.findById(id);
    if (existing.merged_into_id) {
      throw new ConflictException('This record has been merged; update the surviving record instead');
    }

    const nameChanged = dto.given_names || dto.family_name;
    const patient = await this.prisma.patient.update({
      where: { id },
      data: {
        ...(dto.given_names ? { given_names: dto.given_names } : {}),
        ...(dto.family_name ? { family_name: dto.family_name } : {}),
        ...(nameChanged
          ? {
              name_search: this.searchKey(
                dto.given_names ?? existing.given_names,
                dto.family_name ?? existing.family_name,
              ),
            }
          : {}),
        ...(dto.gender ? { gender: dto.gender } : {}),
        ...(dto.birth_date ? { birth_date: new Date(dto.birth_date) } : {}),
        ...(dto.nationality !== undefined ? { nationality: dto.nationality } : {}),
        ...(dto.preferred_language ? { preferred_language: dto.preferred_language } : {}),
        ...(dto.marital_status !== undefined ? { marital_status: dto.marital_status } : {}),
        ...(dto.blood_group !== undefined ? { blood_group: dto.blood_group } : {}),
        ...(dto.address !== undefined ? { address: dto.address ?? undefined } : {}),
        ...(dto.is_vip !== undefined ? { is_vip: dto.is_vip } : {}),
      },
      include: { identifiers: true, contacts: true },
    });

    await this.publishSync(id, 'update');
    return patient;
  }

  async timeline(patientId: string, limit = 100) {
    await this.repo.findById(patientId);
    return this.repo.timeline(patientId, limit);
  }

  /**
   * Merge points the source record at the target and re-parents every clinical row.
   * The source is retained (never deleted) so the merge stays reversible.
   */
  async merge(dto: MergePatientDto) {
    if (dto.source_id === dto.target_id) {
      throw new BadRequestException('Cannot merge a patient into itself');
    }
    const [source, target] = await Promise.all([
      this.repo.findById(dto.source_id),
      this.repo.findById(dto.target_id),
    ]);
    if (source.merged_into_id) throw new ConflictException('Source record is already merged');
    if (target.merged_into_id) throw new ConflictException('Target record is itself merged');

    const userId = currentContext().userId;
    const scope = { tenant_id: currentContext().tenantId, patient_id: dto.source_id };
    const to = { patient_id: dto.target_id };

    await this.prisma.$transaction([
      this.prisma.encounter.updateMany({ where: scope, data: to }),
      this.prisma.condition.updateMany({ where: scope, data: to }),
      this.prisma.allergy.updateMany({ where: scope, data: to }),
      this.prisma.vital.updateMany({ where: scope, data: to }),
      this.prisma.medication.updateMany({ where: scope, data: to }),
      this.prisma.medicationDispense.updateMany({ where: scope, data: to }),
      this.prisma.medicationAdministration.updateMany({ where: scope, data: to }),
      this.prisma.clinicalNote.updateMany({ where: scope, data: to }),
      this.prisma.carePlan.updateMany({ where: scope, data: to }),
      this.prisma.serviceRequest.updateMany({ where: scope, data: to }),
      this.prisma.labResult.updateMany({ where: scope, data: to }),
      this.prisma.labSpecimen.updateMany({ where: scope, data: to }),
      this.prisma.imagingStudy.updateMany({ where: scope, data: to }),
      this.prisma.appointment.updateMany({ where: scope, data: to }),
      this.prisma.invoice.updateMany({ where: scope, data: to }),
      this.prisma.payment.updateMany({ where: scope, data: to }),
      this.prisma.coverage.updateMany({ where: scope, data: to }),
      this.prisma.insuranceClaim.updateMany({ where: scope, data: to }),
      this.prisma.admission.updateMany({ where: scope, data: to }),
      this.prisma.aiSession.updateMany({ where: scope, data: to }),
      this.prisma.patient.update({
        where: { id: dto.source_id },
        data: {
          merged_into_id: dto.target_id,
          merged_at: new Date(),
          merged_by: userId,
          deleted_reason: dto.reason,
        },
      }),
    ]);

    await Promise.all([this.publishSync(dto.target_id, 'update'), this.publishSync(dto.source_id, 'update')]);
    return this.getFullProfile(dto.target_id);
  }

  /**
   * Unmerge clears the merge pointer only. Clinical rows moved during the merge are
   * NOT moved back automatically — attribution after the fact is a clinical decision,
   * so the surviving links are listed for manual reassignment instead.
   */
  async unmerge(patientId: string, reason: string) {
    const patient = await this.repo.findById(patientId);
    if (!patient.merged_into_id) throw new BadRequestException('This record is not merged');

    const targetId = patient.merged_into_id;
    await this.prisma.patient.update({
      where: { id: patientId },
      data: { merged_into_id: null, merged_at: null, merged_by: null, deleted_reason: reason },
    });

    const movedSince = patient.merged_at ?? new Date(0);
    const scope = { tenant_id: currentContext().tenantId, patient_id: targetId, updated_at: { gte: movedSince } };
    const [encounters, conditions, invoices] = await Promise.all([
      this.prisma.encounter.count({ where: scope }),
      this.prisma.condition.count({ where: scope }),
      this.prisma.invoice.count({ where: scope }),
    ]);

    await this.publishSync(patientId, 'update');
    return {
      patient_id: patientId,
      previously_merged_into: targetId,
      requires_manual_reassignment: { encounters, conditions, invoices },
      note: 'Clinical records moved during the merge remain on the target record and must be reassigned individually.',
    };
  }

  private async publishSync(patientId: string, operation: 'create' | 'update' | 'delete') {
    const row = await this.prisma.patient.findUnique({
      where: { id: patientId },
      include: { identifiers: true, contacts: true },
    });
    if (!row) return;
    const event: FhirSyncEvent = {
      tenant_id: row.tenant_id,
      resource_type: 'Patient',
      internal_id: row.id,
      fhir_id: row.fhir_id,
      operation,
      payload: patientToFhir(row as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, row.tenant_id, event);
  }

  /** International Patient Summary (FHIR Composition + supporting resources). */
  async ipsSummary(patientId: string) {
    const p = await this.getFullProfile(patientId);
    const { allergyToFhir, conditionToFhir, medicationRequestToFhir } = await import('../fhir/mappers');
    const entries = [
      patientToFhir(p as unknown as Record<string, unknown>),
      ...p.allergies.map((a) => allergyToFhir(a as unknown as Record<string, unknown>)),
      ...p.conditions.map((c) => conditionToFhir(c as unknown as Record<string, unknown>)),
      ...p.medications.map((m) => medicationRequestToFhir(m as unknown as Record<string, unknown>)),
    ];

    return {
      resourceType: 'Bundle',
      type: 'document',
      timestamp: new Date().toISOString(),
      meta: { profile: ['http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips'] },
      entry: [
        {
          resource: {
            resourceType: 'Composition',
            status: 'final',
            type: {
              coding: [{ system: 'http://loinc.org', code: '60591-5', display: 'Patient summary Document' }],
            },
            subject: { reference: `Patient/${p.fhir_id ?? p.id}` },
            date: new Date().toISOString(),
            title: 'International Patient Summary',
            section: [
              { title: 'Allergies and Intolerances', entry: p.allergies.map((a) => ({ reference: `AllergyIntolerance/${a.fhir_id ?? a.id}` })) },
              { title: 'Problem List', entry: p.conditions.map((c) => ({ reference: `Condition/${c.fhir_id ?? c.id}` })) },
              { title: 'Medication Summary', entry: p.medications.map((m) => ({ reference: `MedicationRequest/${m.fhir_id ?? m.id}` })) },
            ],
          },
        },
        ...entries.map((resource) => ({ resource })),
      ],
    };
  }
}
