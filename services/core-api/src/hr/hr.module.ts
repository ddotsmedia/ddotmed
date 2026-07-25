import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { KAFKA_TOPICS, type NotificationEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';

export const ScheduleShiftDto = z.object({
  staff_profile_id: z.string().uuid(),
  shift_id: z.string().uuid(),
  shift_date: z.coerce.date(),
  location_id: z.string().uuid().nullable().optional(),
  ward: z.string().optional(),
  notes: z.string().max(500).optional(),
});

export const ClockDto = z.object({
  staff_schedule_id: z.string().uuid(),
  method: z.enum(['biometric', 'card', 'manual', 'mobile']).default('biometric'),
  biometric_id: z.string().optional(),
});

export const CredentialDto = z.object({
  staff_profile_id: z.string().uuid(),
  type: z.string().min(1),
  name: z.string().min(1),
  identifier: z.string().min(1),
  issuing_authority: z.string().min(1),
  issued_at: z.coerce.date(),
  expires_at: z.coerce.date().nullable().optional(),
  document_url: z.string().url().optional(),
});

/** Maximum patients per nurse by ward acuity; breaching this raises an alert. */
const NURSE_RATIOS: Record<string, number> = {
  icu: 2,
  hdu: 3,
  nicu: 2,
  picu: 2,
  er: 4,
  maternity: 4,
  general: 6,
};

@Injectable()
export class HrService {
  private readonly logger = new Logger(HrService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  async scheduleShift(dto: z.infer<typeof ScheduleShiftDto>) {
    const ctx = currentContext();

    // A person cannot work two shifts on the same day.
    const clash = await this.prisma.staffSchedule.findFirst({
      where: {
        tenant_id: ctx.tenantId,
        staff_profile_id: dto.staff_profile_id,
        shift_date: dto.shift_date,
        deleted_at: null,
        status: { not: 'cancelled' },
      },
    });
    if (clash) throw new ConflictException('This staff member is already rostered on that date');

    return this.prisma.staffSchedule.create({
      data: {
        tenant_id: ctx.tenantId,
        staff_profile_id: dto.staff_profile_id,
        shift_id: dto.shift_id,
        location_id: dto.location_id ?? null,
        ward: dto.ward,
        shift_date: dto.shift_date,
        status: 'scheduled',
        notes: dto.notes,
      },
    });
  }

  async roster(from: Date, to: Date, ward?: string) {
    return this.prisma.staffSchedule.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        shift_date: { gte: from, lte: to },
        ...(ward ? { ward } : {}),
      },
      include: {
        shift: true,
        staff_profile: {
          include: { user: { select: { email: true } } },
        },
      },
      orderBy: [{ shift_date: 'asc' }, { ward: 'asc' }],
    });
  }

  async clockIn(dto: z.infer<typeof ClockDto>) {
    const ctx = currentContext();
    const schedule = await this.prisma.staffSchedule.findFirst({
      where: { id: dto.staff_schedule_id, tenant_id: ctx.tenantId, deleted_at: null },
      include: { staff_profile: true },
    });
    if (!schedule) throw new BadRequestException('Roster entry not found');
    if (schedule.clock_in_at) throw new BadRequestException('Already clocked in');

    // Biometric identity must match the enrolled template for this employee.
    if (dto.method === 'biometric') {
      if (!dto.biometric_id) throw new BadRequestException('Biometric identifier is required');
      if (schedule.staff_profile.biometric_id !== dto.biometric_id) {
        throw new ConflictException('Biometric identifier does not match this staff member');
      }
    }

    return this.prisma.staffSchedule.update({
      where: { id: dto.staff_schedule_id },
      data: { clock_in_at: new Date(), clock_in_method: dto.method, status: 'on-duty' },
    });
  }

  async clockOut(scheduleId: string) {
    const schedule = await this.prisma.staffSchedule.findFirst({
      where: { id: scheduleId, tenant_id: currentContext().tenantId, deleted_at: null },
    });
    if (!schedule) throw new BadRequestException('Roster entry not found');
    if (!schedule.clock_in_at) throw new BadRequestException('Not clocked in');

    return this.prisma.staffSchedule.update({
      where: { id: scheduleId },
      data: { clock_out_at: new Date(), status: 'completed' },
    });
  }

  async addCredential(dto: z.infer<typeof CredentialDto>) {
    const ctx = currentContext();
    const status =
      dto.expires_at && dto.expires_at < new Date() ? 'expired' : 'valid';

    return this.prisma.credential.create({
      data: {
        tenant_id: ctx.tenantId,
        staff_profile_id: dto.staff_profile_id,
        type: dto.type,
        name: dto.name,
        identifier: dto.identifier,
        issuing_authority: dto.issuing_authority,
        issued_at: dto.issued_at,
        expires_at: dto.expires_at ?? null,
        document_url: dto.document_url,
        status,
        verified_by: ctx.userId,
        verified_at: new Date(),
      },
    });
  }

  /** Credentials expiring within the horizon, ordered by urgency. */
  async expiringCredentials(days = 90) {
    const cutoff = new Date(Date.now() + days * 86_400_000);
    return this.prisma.credential.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        status: { in: ['valid', 'expiring'] },
        expires_at: { not: null, lte: cutoff },
      },
      include: {
        staff_profile: { include: { user: { select: { email: true } } } },
      },
      orderBy: { expires_at: 'asc' },
    });
  }

  /**
   * Nurse-to-patient ratio monitoring for the current shift.
   * A ward is breaching when its census exceeds rostered nurses x the acuity ratio.
   */
  async nurseRatios(date = new Date()) {
    const ctx = currentContext();
    const day = new Date(date);
    day.setHours(0, 0, 0, 0);

    const [rostered, occupiedBeds] = await Promise.all([
      this.prisma.staffSchedule.findMany({
        where: {
          tenant_id: ctx.tenantId,
          deleted_at: null,
          shift_date: day,
          status: { in: ['scheduled', 'on-duty'] },
        },
        include: { staff_profile: { select: { designation: true, department: true } } },
      }),
      this.prisma.bed.findMany({
        where: { tenant_id: ctx.tenantId, deleted_at: null, status: 'occupied' },
        select: { ward: true, bed_type: true },
      }),
    ]);

    const nursesByWard = new Map<string, number>();
    for (const r of rostered) {
      if (!/nurse/i.test(r.staff_profile.designation)) continue;
      const ward = r.ward ?? r.staff_profile.department;
      nursesByWard.set(ward, (nursesByWard.get(ward) ?? 0) + 1);
    }

    const censusByWard = new Map<string, { count: number; type: string }>();
    for (const b of occupiedBeds) {
      const entry = censusByWard.get(b.ward) ?? { count: 0, type: b.bed_type };
      entry.count += 1;
      // Highest-acuity bed type in the ward drives the required ratio.
      if ((NURSE_RATIOS[b.bed_type] ?? 6) < (NURSE_RATIOS[entry.type] ?? 6)) entry.type = b.bed_type;
      censusByWard.set(b.ward, entry);
    }

    const wards = [...censusByWard.entries()].map(([ward, census]) => {
      const nurses = nursesByWard.get(ward) ?? 0;
      const maxRatio = NURSE_RATIOS[census.type] ?? NURSE_RATIOS.general!;
      const capacity = nurses * maxRatio;
      const actualRatio = nurses > 0 ? Number((census.count / nurses).toFixed(2)) : null;
      return {
        ward,
        acuity: census.type,
        patients: census.count,
        nurses,
        max_patients_per_nurse: maxRatio,
        actual_ratio: actualRatio,
        capacity,
        breaching: census.count > capacity,
        shortfall_nurses: census.count > capacity ? Math.ceil(census.count / maxRatio) - nurses : 0,
      };
    });

    return { date: day.toISOString().slice(0, 10), wards, breaching: wards.filter((w) => w.breaching) };
  }

  /**
   * Nightly credential-expiry sweep. Alerts at 90/30/7 days and marks expired
   * credentials so a lapsed licence cannot silently keep practising.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async credentialExpirySweep(): Promise<void> {
    const now = new Date();
    const horizon = new Date(now.getTime() + 90 * 86_400_000);

    const credentials = await this.prisma.credential.findMany({
      where: {
        deleted_at: null,
        status: { in: ['valid', 'expiring'] },
        expires_at: { not: null, lte: horizon },
      },
      include: { staff_profile: { include: { user: { select: { email: true } } } } },
      take: 2000,
    });

    let expired = 0;
    let alerted = 0;

    for (const c of credentials) {
      if (!c.expires_at) continue;
      const daysLeft = Math.floor((c.expires_at.getTime() - now.getTime()) / 86_400_000);

      if (daysLeft < 0) {
        await this.prisma.credential.update({ where: { id: c.id }, data: { status: 'expired' } });
        expired += 1;
      } else if (c.status !== 'expiring') {
        await this.prisma.credential.update({ where: { id: c.id }, data: { status: 'expiring' } });
      }

      const milestone = [90, 30, 7, 0].includes(daysLeft);
      const alreadyAlertedToday =
        c.last_alert_sent_at && now.getTime() - c.last_alert_sent_at.getTime() < 86_400_000;

      if ((milestone || daysLeft < 0) && !alreadyAlertedToday) {
        const event: NotificationEvent = {
          tenant_id: c.tenant_id,
          channel: 'email',
          recipient: c.staff_profile.user.email,
          template: daysLeft < 0 ? 'credential.expired' : 'credential.expiring',
          params: {
            credential: c.name,
            identifier: c.identifier,
            expires_at: c.expires_at.toISOString().slice(0, 10),
            days_left: String(daysLeft),
          },
        };
        await this.kafka.emit(KAFKA_TOPICS.NOTIFICATION, c.tenant_id, event);
        await this.prisma.credential.update({
          where: { id: c.id },
          data: { last_alert_sent_at: now },
        });
        alerted += 1;
      }
    }

    if (credentials.length) {
      this.logger.log(`Credential sweep: ${expired} expired, ${alerted} alerts raised`);
    }
  }
}

@ApiTags('hr')
@Controller('hr')
export class HrController {
  constructor(private readonly service: HrService) {}

  @Get('roster')
  @RequirePermissions('hr:manage')
  roster(@Query() q: Record<string, string>) {
    return this.service.roster(
      new Date(q.from ?? Date.now()),
      new Date(q.to ?? Date.now() + 7 * 86_400_000),
      q.ward,
    );
  }

  @Post('roster')
  @RequirePermissions('hr:manage')
  @Audit({ action: 'hr.shift.schedule', resourceType: 'StaffSchedule' })
  schedule(@ZodBody(ScheduleShiftDto) dto: z.infer<typeof ScheduleShiftDto>) {
    return this.service.scheduleShift(dto);
  }

  @Post('clock-in')
  @Audit({ action: 'hr.clock-in', resourceType: 'StaffSchedule' })
  clockIn(@ZodBody(ClockDto) dto: z.infer<typeof ClockDto>) {
    return this.service.clockIn(dto);
  }

  @Post('clock-out/:scheduleId')
  @Audit({ action: 'hr.clock-out', resourceType: 'StaffSchedule' })
  clockOut(@Param('scheduleId', ParseUUIDPipe) id: string) {
    return this.service.clockOut(id);
  }

  @Post('credentials')
  @RequirePermissions('hr:manage')
  @Audit({ action: 'hr.credential.add', resourceType: 'Credential' })
  addCredential(@ZodBody(CredentialDto) dto: z.infer<typeof CredentialDto>) {
    return this.service.addCredential(dto);
  }

  @Get('credentials/expiring')
  @RequirePermissions('hr:manage')
  expiring(@Query('days') days?: string) {
    return this.service.expiringCredentials(days ? Number(days) : 90);
  }

  @Get('nurse-ratios')
  @RequirePermissions('hr:manage')
  @ApiOperation({ summary: 'Nurse-to-patient ratio by ward with breach detection' })
  ratios(@Query('date') date?: string) {
    return this.service.nurseRatios(date ? new Date(date) : new Date());
  }
}

@Module({
  controllers: [HrController],
  providers: [HrService],
  exports: [HrService],
})
export class HrModule {}
