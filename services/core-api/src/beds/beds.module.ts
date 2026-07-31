import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
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
import {
  AdmissionsController,
  AdmissionsService,
  HousekeepingDto,
} from './admissions.controller';

export const AdmitDto = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid(),
  bed_id: z.string().uuid(),
  admitting_doctor_id: z.string().uuid(),
  attending_doctor_id: z.string().uuid().nullable().optional(),
  admission_type: z.enum(['elective', 'emergency', 'transfer', 'newborn']).default('elective'),
  admission_reason: z.string().max(1000).optional(),
  expected_discharge_at: z.coerce.date().nullable().optional(),
});

export const TransferDto = z.object({
  admission_id: z.string().uuid(),
  to_bed_id: z.string().uuid(),
  reason: z.string().min(3).max(500),
  transfer_type: z.enum(['internal', 'external', 'escalation']).default('internal'),
});

@Injectable()
export class BedsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Live bed board grouped by ward, with occupancy percentages for the dashboard. */
  async board(ward?: string) {
    const beds = await this.prisma.bed.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        ...(ward ? { ward } : {}),
      },
      include: {
        admissions: {
          where: { deleted_at: null, status: 'admitted' },
          include: {
            patient: { select: { id: true, mrn: true, given_names: true, family_name: true, gender: true } },
          },
          take: 1,
        },
      },
      orderBy: [{ ward: 'asc' }, { room: 'asc' }, { bed_number: 'asc' }],
    });

    const wards = new Map<string, { total: number; occupied: number; available: number; beds: typeof beds }>();
    for (const bed of beds) {
      const entry = wards.get(bed.ward) ?? { total: 0, occupied: 0, available: 0, beds: [] as typeof beds };
      entry.total += 1;
      if (bed.status === 'occupied') entry.occupied += 1;
      if (bed.status === 'available') entry.available += 1;
      entry.beds.push(bed);
      wards.set(bed.ward, entry);
    }

    return {
      wards: [...wards.entries()].map(([name, w]) => ({
        ward: name,
        total: w.total,
        occupied: w.occupied,
        available: w.available,
        occupancy_pct: w.total ? Math.round((w.occupied / w.total) * 100) : 0,
        beds: w.beds,
      })),
      totals: {
        total: beds.length,
        occupied: beds.filter((b) => b.status === 'occupied').length,
        available: beds.filter((b) => b.status === 'available').length,
      },
    };
  }

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

  /** Bed allocation and admission happen atomically — a bed can never be double-booked. */
  async admit(dto: z.infer<typeof AdmitDto>) {
    const ctx = currentContext();
    const admissionNumber = await this.nextAdmissionNumber();

    const admission = await this.prisma.$transaction(async (tx) => {
      const bed = await tx.bed.findFirst({
        where: { id: dto.bed_id, tenant_id: ctx.tenantId, deleted_at: null },
      });
      if (!bed) throw new BadRequestException('Bed not found');
      if (bed.status !== 'available' && bed.status !== 'reserved') {
        throw new ConflictException(`Bed ${bed.ward}/${bed.room}/${bed.bed_number} is ${bed.status}`);
      }

      if (bed.gender_restriction) {
        const patient = await tx.patient.findUnique({
          where: { id: dto.patient_id },
          select: { gender: true },
        });
        if (patient && patient.gender !== bed.gender_restriction) {
          throw new ConflictException(
            `This bay is restricted to ${bed.gender_restriction} patients`,
          );
        }
      }

      const claimed = await tx.bed.updateMany({
        where: { id: dto.bed_id, status: { in: ['available', 'reserved'] } },
        data: { status: 'occupied' },
      });
      if (claimed.count === 0) throw new ConflictException('That bed was just taken');

      const created = await tx.admission.create({
        data: {
          tenant_id: ctx.tenantId,
          patient_id: dto.patient_id,
          encounter_id: dto.encounter_id,
          bed_id: dto.bed_id,
          admission_number: admissionNumber,
          admitting_doctor_id: dto.admitting_doctor_id,
          attending_doctor_id: dto.attending_doctor_id ?? null,
          status: 'admitted',
          admission_type: dto.admission_type,
          admission_reason: dto.admission_reason,
          expected_discharge_at: dto.expected_discharge_at ?? null,
        },
      });

      await tx.bed.update({ where: { id: dto.bed_id }, data: { current_admission_id: created.id } });
      return created;
    });

    await this.emitAdt(admission.id, 'admit', undefined, dto.bed_id);
    return admission;
  }

  async discharge(admissionId: string, disposition: string, summaryNoteId?: string) {
    const ctx = currentContext();

    const result = await this.prisma.$transaction(async (tx) => {
      const admission = await tx.admission.findFirst({
        where: { id: admissionId, tenant_id: ctx.tenantId, deleted_at: null },
      });
      if (!admission) throw new BadRequestException('Admission not found');
      if (admission.status === 'discharged') throw new BadRequestException('Already discharged');

      const updated = await tx.admission.update({
        where: { id: admissionId },
        data: {
          status: 'discharged',
          discharged_at: new Date(),
          discharge_disposition: disposition,
          discharge_summary_id: summaryNoteId ?? null,
        },
      });

      if (admission.bed_id) {
        // The bed goes to cleaning, not straight to available — housekeeping must sign it off.
        await tx.bed.update({
          where: { id: admission.bed_id },
          data: { status: 'cleaning', current_admission_id: null },
        });
        await tx.housekeepingTask.create({
          data: {
            tenant_id: ctx.tenantId,
            bed_id: admission.bed_id,
            task_type: 'terminal-clean',
            priority: 'routine',
            status: 'pending',
            requested_by: ctx.userId,
          },
        });
      }

      return updated;
    });

    await this.emitAdt(admissionId, 'discharge', result.bed_id ?? undefined);
    return result;
  }

  async transfer(dto: z.infer<typeof TransferDto>) {
    const ctx = currentContext();

    const result = await this.prisma.$transaction(async (tx) => {
      const admission = await tx.admission.findFirst({
        where: { id: dto.admission_id, tenant_id: ctx.tenantId, deleted_at: null },
        include: { bed: true },
      });
      if (!admission) throw new BadRequestException('Admission not found');
      if (admission.status !== 'admitted') throw new BadRequestException('Patient is not currently admitted');

      const target = await tx.bed.findFirst({
        where: { id: dto.to_bed_id, tenant_id: ctx.tenantId, deleted_at: null },
      });
      if (!target) throw new BadRequestException('Target bed not found');

      const claimed = await tx.bed.updateMany({
        where: { id: dto.to_bed_id, status: { in: ['available', 'reserved'] } },
        data: { status: 'occupied', current_admission_id: admission.id },
      });
      if (claimed.count === 0) throw new ConflictException('The target bed is not available');

      if (admission.bed_id) {
        await tx.bed.update({
          where: { id: admission.bed_id },
          data: { status: 'cleaning', current_admission_id: null },
        });
        await tx.housekeepingTask.create({
          data: {
            tenant_id: ctx.tenantId,
            bed_id: admission.bed_id,
            task_type: 'terminal-clean',
            status: 'pending',
            requested_by: ctx.userId,
          },
        });
      }

      const transfer = await tx.transfer.create({
        data: {
          tenant_id: ctx.tenantId,
          admission_id: admission.id,
          from_bed_id: admission.bed_id,
          to_bed_id: dto.to_bed_id,
          from_ward: admission.bed?.ward ?? null,
          to_ward: target.ward,
          reason: dto.reason,
          transfer_type: dto.transfer_type,
          requested_by: ctx.userId!,
          status: 'completed',
          transferred_at: new Date(),
        },
      });

      await tx.admission.update({ where: { id: admission.id }, data: { bed_id: dto.to_bed_id } });
      return transfer;
    });

    await this.emitAdt(dto.admission_id, 'transfer', result.from_bed_id ?? undefined, dto.to_bed_id);
    return result;
  }

  /**
   * Escalation triggered by a sustained high EWS. Raises the admission's escalation
   * level and surfaces an ICU/HDU bed suggestion rather than moving the patient
   * automatically — the transfer decision stays with a clinician.
   */
  async escalate(admissionId: string, ewsScore: number) {
    const ctx = currentContext();
    const admission = await this.prisma.admission.findFirst({
      where: { id: admissionId, tenant_id: ctx.tenantId, deleted_at: null },
      include: { bed: true },
    });
    if (!admission) throw new BadRequestException('Admission not found');

    const level = ewsScore >= 7 ? 2 : ewsScore >= 5 ? 1 : 0;
    if (level <= admission.escalation_level) {
      return { escalated: false, current_level: admission.escalation_level };
    }

    const targetType = level === 2 ? 'icu' : 'hdu';
    const candidates = await this.prisma.bed.findMany({
      where: {
        tenant_id: ctx.tenantId,
        deleted_at: null,
        status: 'available',
        bed_type: targetType,
      },
      take: 5,
    });

    await this.prisma.admission.update({
      where: { id: admissionId },
      data: { escalation_level: level },
    });

    this.realtime.emitToRoles(ctx.tenantId, ['doctor', 'nurse'], WS_EVENTS.BED_UPDATED, {
      admission_id: admissionId,
      escalation_level: level,
      suggested_beds: candidates.map((b) => ({ id: b.id, ward: b.ward, room: b.room, bed: b.bed_number })),
    });

    return {
      escalated: true,
      current_level: level,
      recommended_bed_type: targetType,
      available_beds: candidates,
      note: 'Escalation raised. A clinician must authorise the transfer.',
    };
  }

  async housekeepingQueue(status = 'pending') {
    return this.prisma.housekeepingTask.findMany({
      where: { tenant_id: currentContext().tenantId, deleted_at: null, status: status as never },
      include: { bed: true },
      orderBy: [{ priority: 'desc' }, { requested_at: 'asc' }],
    });
  }

  async completeHousekeeping(taskId: string) {
    const ctx = currentContext();
    return this.prisma.$transaction(async (tx) => {
      const task = await tx.housekeepingTask.findFirst({
        where: { id: taskId, tenant_id: ctx.tenantId, deleted_at: null },
      });
      if (!task) throw new BadRequestException('Task not found');

      const updated = await tx.housekeepingTask.update({
        where: { id: taskId },
        data: { status: 'completed', completed_at: new Date(), assigned_to: ctx.userId },
      });
      if (task.bed_id) {
        await tx.bed.updateMany({
          where: { id: task.bed_id, status: 'cleaning' },
          data: { status: 'available' },
        });
      }
      return updated;
    });
  }

  private async emitAdt(
    admissionId: string,
    event: AdtEvent['event'],
    fromBedId?: string,
    toBedId?: string,
  ): Promise<void> {
    const admission = await this.prisma.admission.findUnique({ where: { id: admissionId } });
    if (!admission) return;
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

@ApiTags('beds')
@Controller('beds')
export class BedsController {
  constructor(
    private readonly service: BedsService,
    private readonly admissions: AdmissionsService,
  ) {}

  @Get()
  @RequirePermissions('bed:manage')
  @ApiOperation({ summary: 'Bed board for a ward or location, one row per bed' })
  list(
    @Query('locationId') locationId?: string,
    @Query('ward') ward?: string,
    @Query('status') status?: string,
  ) {
    return this.admissions.bedBoard({ locationId, ward, status });
  }

  @Get('board')
  @RequirePermissions('bed:manage')
  @ApiOperation({ summary: 'Live bed board grouped by ward with occupancy' })
  board(@Query('ward') ward?: string) {
    return this.service.board(ward);
  }

  @Patch(':id/housekeeping')
  @RequirePermissions('bed:manage')
  @Audit({ action: 'bed.housekeeping', resourceType: 'Bed' })
  @ApiOperation({ summary: 'Move a bed through dirty → in progress → clean' })
  housekeepingStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(HousekeepingDto) dto: z.infer<typeof HousekeepingDto>,
  ) {
    return this.admissions.setHousekeeping(id, dto);
  }

  @Post('admit')
  @RequirePermissions('adt:manage')
  @Audit({ action: 'adt.admit', resourceType: 'Admission', isPhi: true })
  admit(@ZodBody(AdmitDto) dto: z.infer<typeof AdmitDto>) {
    return this.service.admit(dto);
  }

  @Post('discharge/:admissionId')
  @RequirePermissions('adt:manage')
  @Audit({ action: 'adt.discharge', resourceType: 'Admission', isPhi: true })
  discharge(
    @Param('admissionId', ParseUUIDPipe) id: string,
    @Body() body: { disposition: string; summary_note_id?: string },
  ) {
    return this.service.discharge(id, body.disposition, body.summary_note_id);
  }

  @Post('transfer')
  @RequirePermissions('adt:manage')
  @Audit({ action: 'adt.transfer', resourceType: 'Transfer', isPhi: true })
  transfer(@ZodBody(TransferDto) dto: z.infer<typeof TransferDto>) {
    return this.service.transfer(dto);
  }

  @Post('escalate/:admissionId')
  @RequirePermissions('adt:manage')
  @Audit({ action: 'adt.escalate', resourceType: 'Admission', isPhi: true })
  escalate(@Param('admissionId', ParseUUIDPipe) id: string, @Body('ews_score') ews: number) {
    return this.service.escalate(id, ews);
  }

  @Get('housekeeping')
  @RequirePermissions('bed:manage')
  housekeeping(@Query('status') status?: string) {
    return this.service.housekeepingQueue(status ?? 'pending');
  }

  @Post('housekeeping/:taskId/complete')
  @RequirePermissions('bed:manage')
  completeTask(@Param('taskId', ParseUUIDPipe) id: string) {
    return this.service.completeHousekeeping(id);
  }
}

@Module({
  controllers: [BedsController, AdmissionsController],
  providers: [BedsService, AdmissionsService],
  exports: [BedsService, AdmissionsService],
})
export class BedsModule {}
