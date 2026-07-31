import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { KAFKA_TOPICS, WS_EVENTS, type AdtEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { RealtimeGateway } from '../messaging/realtime.gateway';
import { currentContext } from '../common/tenant-context';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { BedsService } from './beds.module';
import {
  admissionBlocker,
  bedTone,
  canCleanTransition,
  eddStatus,
  isAdmittable,
  lengthOfStayDays,
  type BedState,
  type HousekeepingStatus,
} from './bed-board';

/** The client handed to a `$transaction` callback: the full client minus its own transaction controls. */
type TransactionClient = Parameters<Parameters<PrismaService['$transaction']>[0]>[0];

export const CreateAdmissionDto = z.object({
  patient_id: z.string().uuid(),
  bed_id: z.string().uuid(),
  admission_type: z.enum(['emergency', 'elective', 'transfer', 'newborn']).default('elective'),
  admitting_practitioner_id: z.string().uuid(),
  attending_practitioner_id: z.string().uuid().nullable().optional(),
  edd: z.coerce.date().nullable().optional(),
  diagnosis_code: z.string().max(20).optional(),
  diagnosis_display: z.string().max(200).optional(),
  admission_reason: z.string().max(1000).optional(),
  /** Reuse an existing chart rather than opening an inpatient one. */
  encounter_id: z.string().uuid().nullable().optional(),
});

export const TransferAdmissionDto = z.object({
  to_bed_id: z.string().uuid(),
  reason: z.string().min(3).max(500),
  transfer_type: z.enum(['internal', 'external', 'escalation']).default('internal'),
});

export const DischargeAdmissionDto = z.object({
  discharge_disposition: z.string().min(1).max(200),
  discharge_notes: z.string().max(4000).optional(),
  follow_up_date: z.coerce.date().nullable().optional(),
  follow_up_service_type: z.string().max(120).optional(),
  discharge_summary_id: z.string().uuid().nullable().optional(),
});

export const HousekeepingDto = z.object({
  housekeeping_status: z.enum(['clean', 'dirty', 'in_progress']),
  notes: z.string().max(500).optional(),
});

const ADMITTABLE_STATUS: BedState['status'][] = ['available', 'reserved'];

@Injectable()
export class AdmissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly realtime: RealtimeGateway,
    private readonly beds: BedsService,
  ) {}

  private async nextAdmissionNumber(): Promise<string> {
    const stem = `ADM-${new Date().getFullYear()}-`;
    const last = await this.prisma.admission.findFirst({
      where: { tenant_id: currentContext().tenantId, admission_number: { startsWith: stem } },
      orderBy: { admission_number: 'desc' },
      select: { admission_number: true },
    });
    const n = last ? Number(last.admission_number.slice(stem.length)) + 1 : 1;
    return `${stem}${String(n).padStart(6, '0')}`;
  }

  /**
   * The bed board for one ward or location.
   *
   * Flat rather than grouped: this feeds a grid, and the occupancy figures a
   * dashboard wants come from `/beds/board`.
   */
  async bedBoard(params: { locationId?: string; ward?: string; status?: string }) {
    const beds = await this.prisma.bed.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        ...(params.locationId ? { location_id: params.locationId } : {}),
        ...(params.ward ? { ward: params.ward } : {}),
        ...(params.status ? { status: params.status as never } : {}),
      },
      include: {
        admissions: {
          where: { deleted_at: null, status: 'admitted' },
          include: {
            patient: {
              select: {
                id: true,
                mrn: true,
                given_names: true,
                family_name: true,
                gender: true,
                birth_date: true,
              },
            },
          },
          take: 1,
        },
      },
      orderBy: [{ ward: 'asc' }, { room: 'asc' }, { bed_number: 'asc' }],
      take: 500,
    });

    return beds.map((bed) => {
      const admission = bed.admissions[0] ?? null;
      const state: BedState = {
        status: bed.status as BedState['status'],
        housekeeping_status: bed.housekeeping_status as HousekeepingStatus,
      };
      return {
        id: bed.id,
        bed_number: bed.bed_number,
        room: bed.room,
        ward: bed.ward,
        ward_id: bed.ward_id,
        location_id: bed.location_id,
        bed_type: bed.bed_type,
        status: bed.status,
        housekeeping_status: bed.housekeeping_status,
        isolation_flag: bed.isolation_flag,
        isolation_reason: bed.isolation_reason,
        gender_restriction: bed.gender_restriction,
        tone: bedTone({ ...state, isolation_flag: bed.isolation_flag }),
        admittable: isAdmittable(state),
        blocker: admissionBlocker(state),
        admission: admission
          ? {
              id: admission.id,
              admission_number: admission.admission_number,
              admitted_at: admission.admitted_at,
              length_of_stay_days: lengthOfStayDays(admission.admitted_at),
              ...eddStatus(admission.expected_discharge_at),
              patient: admission.patient,
            }
          : null,
      };
    });
  }

  /**
   * Admits a patient to a bed.
   *
   * The bed is claimed inside the transaction with a conditional update, so two
   * clerks admitting into the same bed at the same moment cannot both win. An
   * inpatient encounter is opened here unless the caller supplied one.
   */
  async admit(dto: z.infer<typeof CreateAdmissionDto>) {
    const ctx = currentContext();
    const admissionNumber = await this.nextAdmissionNumber();

    const { admission, encounterId } = await this.prisma.$transaction(async (tx) => {
      const bed = await tx.bed.findFirst({
        where: { id: dto.bed_id, tenant_id: ctx.tenantId, deleted_at: null },
      });
      if (!bed) throw new BadRequestException('Bed not found');

      const state: BedState = {
        status: bed.status as BedState['status'],
        housekeeping_status: bed.housekeeping_status as HousekeepingStatus,
      };
      const blocker = admissionBlocker(state);
      if (blocker) {
        throw new ConflictException({
          code: 'BED_UNAVAILABLE',
          message: `${bed.ward}/${bed.room}/${bed.bed_number}: ${blocker}`,
          bed_status: bed.status,
          housekeeping_status: bed.housekeeping_status,
        });
      }

      const patient = await tx.patient.findFirst({
        where: { id: dto.patient_id, tenant_id: ctx.tenantId, deleted_at: null },
        select: { id: true, gender: true },
      });
      if (!patient) throw new BadRequestException('Patient not found');
      if (bed.gender_restriction && patient.gender !== bed.gender_restriction) {
        throw new ConflictException({
          code: 'BED_UNAVAILABLE',
          message: `This bay is restricted to ${bed.gender_restriction} patients`,
        });
      }

      // A patient cannot be in two beds at once.
      const open = await tx.admission.findFirst({
        where: {
          tenant_id: ctx.tenantId,
          patient_id: dto.patient_id,
          status: 'admitted',
          deleted_at: null,
        },
      });
      if (open) {
        throw new ConflictException({
          code: 'ALREADY_ADMITTED',
          message: `This patient is already admitted under ${open.admission_number}`,
          admission_id: open.id,
        });
      }

      const claimed = await tx.bed.updateMany({
        where: { id: dto.bed_id, status: { in: ADMITTABLE_STATUS as never }, housekeeping_status: 'clean' },
        data: { status: 'occupied' },
      });
      if (claimed.count === 0) throw new ConflictException('That bed was just taken');

      const encounter =
        dto.encounter_id ??
        (
          await tx.encounter.create({
            data: {
              tenant_id: ctx.tenantId,
              patient_id: dto.patient_id,
              practitioner_id: dto.admitting_practitioner_id,
              location_id: bed.location_id,
              status: 'in_progress',
              class: 'IMP',
              type_code: dto.diagnosis_code,
              type_display: dto.diagnosis_display,
              reason_text: dto.admission_reason,
              period_start: new Date(),
            },
          })
        ).id;

      const created = await tx.admission.create({
        data: {
          tenant_id: ctx.tenantId,
          patient_id: dto.patient_id,
          encounter_id: encounter,
          bed_id: dto.bed_id,
          admission_number: admissionNumber,
          admitting_doctor_id: dto.admitting_practitioner_id,
          attending_doctor_id: dto.attending_practitioner_id ?? null,
          status: 'admitted',
          admission_type: dto.admission_type,
          admission_reason: dto.admission_reason,
          expected_discharge_at: dto.edd ?? null,
        },
      });

      await tx.bed.update({ where: { id: dto.bed_id }, data: { current_admission_id: created.id } });

      if (dto.diagnosis_code) {
        await tx.condition.create({
          data: {
            tenant_id: ctx.tenantId,
            patient_id: dto.patient_id,
            encounter_id: encounter,
            code_system: 'http://hl7.org/fhir/sid/icd-10',
            code: dto.diagnosis_code,
            code_display: dto.diagnosis_display,
            category: 'encounter_diagnosis',
            clinical_status: 'active',
            verification_status: 'provisional',
            is_primary: true,
            recorded_by: ctx.userId!,
          },
        });
      }

      return { admission: created, encounterId: encounter };
    });

    await this.emitAdt(admission, 'admit', undefined, dto.bed_id);
    return { ...admission, encounter_id: encounterId };
  }

  /**
   * Moves a patient to another bed.
   *
   * The target is claimed before the source is released, so a failed transfer
   * never leaves the patient with no bed at all.
   */
  async transfer(admissionId: string, dto: z.infer<typeof TransferAdmissionDto>) {
    const ctx = currentContext();

    const { transfer, admission } = await this.prisma.$transaction(async (tx) => {
      const current = await tx.admission.findFirst({
        where: { id: admissionId, tenant_id: ctx.tenantId, deleted_at: null },
        include: { bed: true },
      });
      if (!current) throw new BadRequestException('Admission not found');
      if (current.status !== 'admitted') {
        throw new BadRequestException('This patient is not currently admitted');
      }
      if (current.bed_id === dto.to_bed_id) {
        throw new BadRequestException('The patient is already in that bed');
      }

      const target = await tx.bed.findFirst({
        where: { id: dto.to_bed_id, tenant_id: ctx.tenantId, deleted_at: null },
      });
      if (!target) throw new BadRequestException('Target bed not found');

      const blocker = admissionBlocker({
        status: target.status as BedState['status'],
        housekeeping_status: target.housekeeping_status as HousekeepingStatus,
      });
      if (blocker) {
        throw new ConflictException({
          code: 'BED_UNAVAILABLE',
          message: `${target.ward}/${target.room}/${target.bed_number}: ${blocker}`,
          bed_status: target.status,
          housekeeping_status: target.housekeeping_status,
        });
      }

      const claimed = await tx.bed.updateMany({
        where: { id: dto.to_bed_id, status: { in: ADMITTABLE_STATUS as never }, housekeeping_status: 'clean' },
        data: { status: 'occupied', current_admission_id: current.id },
      });
      if (claimed.count === 0) throw new ConflictException('The target bed was just taken');

      if (current.bed_id) {
        await this.releaseBed(tx, current.bed_id, 'terminal-clean');
      }

      const created = await tx.transfer.create({
        data: {
          tenant_id: ctx.tenantId,
          admission_id: current.id,
          from_bed_id: current.bed_id,
          to_bed_id: dto.to_bed_id,
          from_ward: current.bed?.ward ?? null,
          to_ward: target.ward,
          reason: dto.reason,
          transfer_type: dto.transfer_type,
          requested_by: ctx.userId!,
          status: 'completed',
          transferred_at: new Date(),
        },
      });

      const updated = await tx.admission.update({
        where: { id: current.id },
        data: { bed_id: dto.to_bed_id },
      });

      return { transfer: created, admission: updated };
    });

    await this.emitAdt(admission, 'transfer', transfer.from_bed_id ?? undefined, dto.to_bed_id);
    return transfer;
  }

  /**
   * Discharges the patient, closes the inpatient chart and turns the bed around.
   *
   * The follow-up appointment is booked in the same transaction: a discharge that
   * promises a review and does not create one is the commonest reason a patient
   * is never seen again.
   */
  async discharge(admissionId: string, dto: z.infer<typeof DischargeAdmissionDto>) {
    const ctx = currentContext();

    const result = await this.prisma.$transaction(async (tx) => {
      const admission = await tx.admission.findFirst({
        where: { id: admissionId, tenant_id: ctx.tenantId, deleted_at: null },
        include: { bed: true },
      });
      if (!admission) throw new BadRequestException('Admission not found');
      if (admission.status === 'discharged') {
        throw new BadRequestException('This patient has already been discharged');
      }

      const dischargedAt = new Date();

      const updated = await tx.admission.update({
        where: { id: admissionId },
        data: {
          status: 'discharged',
          discharged_at: dischargedAt,
          discharge_disposition: dto.discharge_disposition,
          discharge_summary_id: dto.discharge_summary_id ?? null,
        },
      });

      await tx.encounter.update({
        where: { id: admission.encounter_id },
        data: {
          status: 'closed',
          period_end: dischargedAt,
          discharge_disposition: dto.discharge_disposition,
          discharge_summary_id: dto.discharge_summary_id ?? null,
        },
      });

      if (dto.discharge_notes) {
        await tx.clinicalNote.create({
          data: {
            tenant_id: ctx.tenantId,
            patient_id: admission.patient_id,
            encounter_id: admission.encounter_id,
            author_id: ctx.userId!,
            type: 'discharge',
            status: 'draft',
            body: dto.discharge_notes,
          },
        });
      }

      if (admission.bed_id) {
        await this.releaseBed(tx, admission.bed_id, 'terminal-clean');
      }

      let followUp = null;
      if (dto.follow_up_date) {
        const start = dto.follow_up_date;
        const end = new Date(start.getTime() + 20 * 60_000);
        followUp = await tx.appointment.create({
          data: {
            tenant_id: ctx.tenantId,
            patient_id: admission.patient_id,
            practitioner_id: admission.attending_doctor_id ?? admission.admitting_doctor_id,
            status: 'booked',
            service_type: dto.follow_up_service_type ?? 'Post-discharge review',
            start,
            end,
            minutes_duration: 20,
            reason_text: `Follow-up after admission ${admission.admission_number}`,
            channel: 'discharge',
            created_by: ctx.userId,
          },
        });
      }

      return { admission: updated, follow_up: followUp, length_of_stay_days: lengthOfStayDays(admission.admitted_at, dischargedAt) };
    });

    await this.emitAdt(result.admission, 'discharge', result.admission.bed_id ?? undefined);
    return result;
  }

  /** Frees a bed and raises the clean. Shared by transfer and discharge. */
  private async releaseBed(
    tx: TransactionClient,
    bedId: string,
    taskType: string,
  ): Promise<void> {
    const ctx = currentContext();
    // The bed is free but not usable: dirty until housekeeping signs it off.
    await tx.bed.update({
      where: { id: bedId },
      data: { status: 'cleaning', housekeeping_status: 'dirty', current_admission_id: null },
    });
    await tx.housekeepingTask.create({
      data: {
        tenant_id: ctx.tenantId,
        bed_id: bedId,
        task_type: taskType,
        priority: 'routine',
        status: 'pending',
        requested_by: ctx.userId,
      },
    });
  }

  /**
   * Moves a bed through the cleaning cycle.
   *
   * Signing a bed off clean releases it for admission in the same write — a bed
   * that is clean but still marked "cleaning" is a bed nobody can use.
   */
  async setHousekeeping(bedId: string, dto: z.infer<typeof HousekeepingDto>) {
    const ctx = currentContext();
    const bed = await this.prisma.bed.findFirst({
      where: { id: bedId, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!bed) throw new BadRequestException('Bed not found');

    const from = bed.housekeeping_status as HousekeepingStatus;
    if (from === dto.housekeeping_status) return bed;
    if (!canCleanTransition(from, dto.housekeeping_status)) {
      throw new BadRequestException({
        code: 'ILLEGAL_HOUSEKEEPING_TRANSITION',
        message: `A bed cannot go from ${from} to ${dto.housekeeping_status}`,
        allowed: canCleanTransition(from, 'in_progress') ? ['in_progress'] : [],
      });
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.bed.update({
        where: { id: bedId },
        data: {
          housekeeping_status: dto.housekeeping_status,
          // A signed-off bed is only released if nobody is in it.
          ...(dto.housekeeping_status === 'clean' && bed.status === 'cleaning'
            ? { status: 'available' }
            : {}),
        },
      });

      await tx.housekeepingTask.updateMany({
        where: { tenant_id: ctx.tenantId, bed_id: bedId, status: { in: ['pending', 'in_progress'] } },
        data:
          dto.housekeeping_status === 'clean'
            ? { status: 'completed', completed_at: new Date(), assigned_to: ctx.userId }
            : { status: 'in_progress', started_at: new Date(), assigned_to: ctx.userId },
      });

      return next;
    });

    this.realtime.emitToTenant(ctx.tenantId, WS_EVENTS.BED_UPDATED, {
      bed_id: bedId,
      status: updated.status,
      housekeeping_status: updated.housekeeping_status,
    });

    return updated;
  }

  /** Active admissions with length of stay and where they stand against their EDD. */
  async list(params: { status?: string; ward?: string; locationId?: string; limit?: number }) {
    const status = params.status === 'active' ? 'admitted' : params.status;

    const rows = await this.prisma.admission.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        ...(status ? { status } : {}),
        ...(params.ward || params.locationId
          ? {
              bed: {
                ...(params.ward ? { ward: params.ward } : {}),
                ...(params.locationId ? { location_id: params.locationId } : {}),
              },
            }
          : {}),
      },
      include: {
        patient: { select: { id: true, mrn: true, given_names: true, family_name: true, birth_date: true } },
        bed: { select: { id: true, ward: true, room: true, bed_number: true, isolation_flag: true } },
      },
      orderBy: { admitted_at: 'asc' },
      take: params.limit ?? 200,
    });

    return rows.map((row) => ({
      ...row,
      length_of_stay_days: lengthOfStayDays(row.admitted_at, row.discharged_at ?? new Date()),
      ...eddStatus(row.expected_discharge_at),
    }));
  }

  private async emitAdt(
    admission: { id: string; tenant_id: string; patient_id: string },
    event: AdtEvent['event'],
    fromBedId?: string,
    toBedId?: string,
  ): Promise<void> {
    const payload: AdtEvent = {
      tenant_id: admission.tenant_id,
      patient_id: admission.patient_id,
      admission_id: admission.id,
      event,
      from_bed_id: fromBedId,
      to_bed_id: toBedId,
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.ADT, admission.tenant_id, payload);
    this.realtime.emitToTenant(admission.tenant_id, WS_EVENTS.BED_UPDATED, payload);
  }
}

@ApiTags('admissions')
@Controller('admissions')
export class AdmissionsController {
  constructor(private readonly service: AdmissionsService) {}

  @Post()
  @RequirePermissions('adt:manage')
  @Audit({ action: 'adt.admit', resourceType: 'Admission', isPhi: true })
  @ApiOperation({ summary: 'Admit to a bed; the bed must be free and clean' })
  admit(@ZodBody(CreateAdmissionDto) dto: z.infer<typeof CreateAdmissionDto>) {
    return this.service.admit(dto);
  }

  @Get()
  @RequirePermissions('bed:manage')
  @ApiOperation({ summary: 'Admissions with length of stay and EDD status' })
  list(
    @Query('status') status?: string,
    @Query('ward') ward?: string,
    @Query('locationId') locationId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.list({ status, ward, locationId, limit: limit ? Number(limit) : 200 });
  }

  @Post(':id/transfer')
  @RequirePermissions('adt:manage')
  @Audit({ action: 'adt.transfer', resourceType: 'Transfer', isPhi: true })
  @ApiOperation({ summary: 'Move to another bed; the target must be free and clean' })
  transfer(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(TransferAdmissionDto) dto: z.infer<typeof TransferAdmissionDto>,
  ) {
    return this.service.transfer(id, dto);
  }

  @Post(':id/discharge')
  @RequirePermissions('adt:manage')
  @Audit({ action: 'adt.discharge', resourceType: 'Admission', isPhi: true })
  @ApiOperation({ summary: 'Discharge, close the chart and book any follow-up' })
  discharge(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(DischargeAdmissionDto) dto: z.infer<typeof DischargeAdmissionDto>,
  ) {
    return this.service.discharge(id, dto);
  }
}
