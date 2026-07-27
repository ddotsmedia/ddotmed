import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { KAFKA_TOPICS, WS_EVENTS, type FhirSyncEvent, type NotificationEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { RealtimeGateway } from '../messaging/realtime.gateway';
import { currentContext } from '../common/tenant-context';
import { appointmentToFhir } from '../fhir/mappers';
import { Audit, RequirePermissions } from '../common/decorators';
import { hasConflict } from './slot-availability';
import { issueToken, queueSnapshot, estimateWaitMinutes } from './queue-token';
import { ZodBody } from '../common/zod.pipe';

export const BookAppointmentDto = z.object({
  patient_id: z.string().uuid(),
  practitioner_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  slot_id: z.string().uuid().nullable().optional(),
  service_type: z.string().min(1),
  specialty: z.string().optional(),
  start: z.coerce.date(),
  minutes_duration: z.number().int().min(5).max(480).default(15),
  reason_text: z.string().max(1000).optional(),
  channel: z.enum(['walk-in', 'phone', 'online', 'app', 'voice-agent', 'referral']).default('online'),
  is_telehealth: z.boolean().default(false),
});

export const WalkInDto = z.object({
  patient_id: z.string().uuid(),
  location_id: z.string().uuid().nullable().optional(),
  practitioner_id: z.string().uuid().nullable().optional(),
  service_type: z.string().min(1).default('walk-in'),
  queue_name: z.string().min(1).default('general'),
  reason_text: z.string().max(1000).optional(),
  /** Raised by triage so an unwell walk-in is called ahead without renumbering. */
  priority: z.number().int().min(0).max(5).default(0),
});

export const RescheduleDto = z.object({
  action: z.enum(['reschedule', 'cancel']),
  start: z.coerce.date().optional(),
  slot_id: z.string().uuid().nullable().optional(),
  minutes_duration: z.number().int().min(5).max(480).optional(),
  reason: z.string().max(500).optional(),
});

export const AvailabilityQuery = z.object({
  practitioner_id: z.string().uuid().optional(),
  location_id: z.string().uuid().optional(),
  service_type: z.string().optional(),
  from: z.coerce.date(),
  to: z.coerce.date(),
});

@Injectable()
export class AppointmentsService {
  private readonly logger = new Logger(AppointmentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly realtime: RealtimeGateway,
    private readonly config: ConfigService,
  ) {}

  /** Free slots in a window, excluding any already claimed by a live appointment. */
  async availability(q: z.infer<typeof AvailabilityQuery>) {
    const tenantId = currentContext().tenantId;
    return this.prisma.slot.findMany({
      where: {
        tenant_id: tenantId,
        deleted_at: null,
        status: 'free',
        start: { gte: q.from },
        end: { lte: q.to },
        schedule: {
          deleted_at: null,
          is_active: true,
          ...(q.practitioner_id ? { practitioner_id: q.practitioner_id } : {}),
          ...(q.location_id ? { location_id: q.location_id } : {}),
          ...(q.service_type ? { service_type: q.service_type } : {}),
        },
        appointments: {
          none: { deleted_at: null, status: { in: ['booked', 'arrived', 'checked_in', 'pending'] } },
        },
      },
      include: { schedule: { select: { practitioner_id: true, location_id: true, service_type: true } } },
      orderBy: { start: 'asc' },
      take: 500,
    });
  }

  /**
   * Booking claims the slot in the same transaction that creates the appointment, so
   * two concurrent online bookings cannot both take the last slot.
   */
  async book(dto: z.infer<typeof BookAppointmentDto>) {
    const ctx = currentContext();
    const end = new Date(dto.start.getTime() + dto.minutes_duration * 60_000);

    const appointment = await this.prisma.$transaction(async (tx) => {
      if (dto.slot_id) {
        const claimed = await tx.slot.updateMany({
          where: { id: dto.slot_id, tenant_id: ctx.tenantId, status: 'free', deleted_at: null },
          data: { status: 'busy' },
        });
        if (claimed.count === 0) throw new ConflictException('That slot has just been taken');
      } else if (dto.practitioner_id) {
        const clash = await tx.appointment.findFirst({
          where: {
            tenant_id: ctx.tenantId,
            practitioner_id: dto.practitioner_id,
            deleted_at: null,
            status: { in: ['booked', 'arrived', 'checked_in', 'pending'] },
            start: { lt: end },
            end: { gt: dto.start },
          },
        });
        if (clash) throw new ConflictException('The practitioner already has an appointment at that time');
      }

      return tx.appointment.create({
        data: {
          tenant_id: ctx.tenantId,
          patient_id: dto.patient_id,
          practitioner_id: dto.practitioner_id ?? null,
          location_id: dto.location_id ?? null,
          slot_id: dto.slot_id ?? null,
          status: 'booked',
          service_type: dto.service_type,
          specialty: dto.specialty,
          start: dto.start,
          end,
          minutes_duration: dto.minutes_duration,
          reason_text: dto.reason_text,
          channel: dto.channel,
          is_telehealth: dto.is_telehealth,
          noshow_risk: await this.estimateNoShowRisk(tx, ctx.tenantId, dto.patient_id, dto.start),
          created_by: ctx.userId,
        },
      });
    });

    const event: FhirSyncEvent = {
      tenant_id: ctx.tenantId,
      resource_type: 'Appointment',
      internal_id: appointment.id,
      fhir_id: appointment.fhir_id,
      operation: 'create',
      payload: appointmentToFhir(appointment as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, event);
    await this.sendBookingConfirmation(appointment.id);
    return appointment;
  }

  /** True only when Twilio credentials are actually present. */
  private get smsEnabled(): boolean {
    return Boolean(
      this.config.get('TWILIO_ACCOUNT_SID') && this.config.get('TWILIO_AUTH_TOKEN'),
    );
  }

  /**
   * Queues a booking-confirmation SMS. A no-op when Twilio is unconfigured: an
   * absent gateway must never fail a booking that is already written, and a dev
   * environment has no credentials at all.
   */
  private async sendBookingConfirmation(appointmentId: string): Promise<void> {
    if (!this.smsEnabled) return;
    try {
      const appointment = await this.prisma.appointment.findUnique({
        where: { id: appointmentId },
        include: {
          patient: {
            select: {
              given_names: true,
              preferred_language: true,
              contacts: {
                where: { deleted_at: null, system: { in: ['phone', 'sms'] } },
                orderBy: { is_primary: 'desc' },
                take: 1,
              },
            },
          },
          practitioner: { select: { given_names: true, family_name: true } },
        },
      });
      const contact = appointment?.patient.contacts[0];
      if (!appointment || !contact) return;

      const event: NotificationEvent = {
        tenant_id: appointment.tenant_id,
        channel: 'sms',
        recipient: contact.value,
        template: 'appointment.confirmed',
        params: {
          name: appointment.patient.given_names[0] ?? '',
          date: appointment.start.toISOString(),
          service: appointment.service_type,
          practitioner: appointment.practitioner
            ? [appointment.practitioner.given_names[0] ?? '', appointment.practitioner.family_name]
                .filter(Boolean)
                .join(' ')
            : '',
          locale: appointment.patient.preferred_language,
        },
      };
      await this.kafka.emit(KAFKA_TOPICS.NOTIFICATION, appointment.tenant_id, event);
    } catch (e) {
      this.logger.warn('Booking confirmation not queued for ' + appointmentId + ': ' + String(e));
    }
  }

  /**
   * Registers an unscheduled arrival and issues a queue token in one transaction.
   * The sequence is read and written together, so two front-desk terminals cannot
   * mint the same token.
   */
  async walkIn(dto: z.infer<typeof WalkInDto>) {
    const ctx = currentContext();
    const now = new Date();
    const today = new Date(now);
    today.setUTCHours(0, 0, 0, 0);

    const result = await this.prisma.$transaction(async (tx) => {
      const last = await tx.queue.findFirst({
        where: { tenant_id: ctx.tenantId, queue_name: dto.queue_name, queue_date: today },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });

      const issued = issueToken({
        queueName: dto.queue_name,
        lastSequence: last?.sequence ?? 0,
        priority: dto.priority,
      });

      const waitingBefore = await tx.queue.count({
        where: {
          tenant_id: ctx.tenantId,
          queue_name: dto.queue_name,
          queue_date: today,
          status: 'waiting',
        },
      });

      const appointment = await tx.appointment.create({
        data: {
          tenant_id: ctx.tenantId,
          patient_id: dto.patient_id,
          practitioner_id: dto.practitioner_id ?? null,
          location_id: dto.location_id ?? null,
          slot_id: null,
          status: 'walk_in',
          service_type: dto.service_type,
          // A walk-in has no scheduled time; start is the arrival moment so the day
          // view still orders it sensibly against booked appointments.
          start: now,
          end: new Date(now.getTime() + 15 * 60_000),
          minutes_duration: 15,
          reason_text: dto.reason_text,
          channel: 'walk-in',
          queue_token: issued.token,
          checked_in_at: now,
          created_by: ctx.userId,
        },
      });

      const queue = await tx.queue.create({
        data: {
          tenant_id: ctx.tenantId,
          location_id: dto.location_id ?? null,
          appointment_id: appointment.id,
          patient_id: dto.patient_id,
          queue_name: dto.queue_name,
          token: issued.token,
          sequence: issued.sequence,
          priority: issued.priority,
          status: 'waiting',
          queue_date: today,
          estimated_wait_minutes: estimateWaitMinutes(waitingBefore, 15, 1),
        },
      });

      return { appointment, queue };
    });

    this.realtime.emitToChannel(
      ctx.tenantId,
      'queue:' + dto.queue_name,
      WS_EVENTS.QUEUE_UPDATED,
      { token: result.queue.token, action: 'joined', queue_name: dto.queue_name },
    );

    return {
      appointment_id: result.appointment.id,
      token: result.queue.token,
      sequence: result.queue.sequence,
      estimated_wait_minutes: result.queue.estimated_wait_minutes,
      queue_name: dto.queue_name,
    };
  }

  /** A patient's appointments, split into upcoming and past. */
  async forPatient(patientId: string) {
    const rows = await this.prisma.appointment.findMany({
      where: { tenant_id: currentContext().tenantId, patient_id: patientId, deleted_at: null },
      include: {
        practitioner: { select: { given_names: true, family_name: true, specialties: true } },
        location: { select: { name: true } },
      },
      orderBy: { start: 'desc' },
      take: 100,
    });

    const now = new Date();
    const isUpcoming = (a: (typeof rows)[number]) =>
      a.start >= now && !['cancelled', 'noshow', 'fulfilled'].includes(a.status);

    return {
      upcoming: rows.filter(isUpcoming).sort((a, b) => a.start.getTime() - b.start.getTime()),
      past: rows.filter((a) => !isUpcoming(a)),
    };
  }

  /**
   * Reschedule or cancel. Rescheduling claims the new slot before releasing the
   * old one, inside one transaction, so a failure cannot leave the patient
   * holding both or neither.
   */
  async reschedule(id: string, dto: z.infer<typeof RescheduleDto>) {
    const ctx = currentContext();

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.appointment.findFirst({
        where: { id, tenant_id: ctx.tenantId, deleted_at: null },
      });
      if (!existing) throw new BadRequestException('Appointment not found');
      if (['cancelled', 'fulfilled'].includes(existing.status)) {
        throw new BadRequestException('Appointment is already ' + existing.status);
      }

      if (dto.action === 'cancel') {
        if (existing.slot_id) {
          await tx.slot.updateMany({ where: { id: existing.slot_id }, data: { status: 'free' } });
        }
        return tx.appointment.update({
          where: { id },
          data: { status: 'cancelled', cancellation_reason: dto.reason ?? 'cancelled by user' },
        });
      }

      if (!dto.start) throw new BadRequestException('start is required to reschedule');

      const minutes = dto.minutes_duration ?? existing.minutes_duration;
      const end = new Date(dto.start.getTime() + minutes * 60_000);

      if (dto.slot_id) {
        const claimed = await tx.slot.updateMany({
          where: { id: dto.slot_id, tenant_id: ctx.tenantId, status: 'free', deleted_at: null },
          data: { status: 'busy' },
        });
        if (claimed.count === 0) throw new ConflictException('That slot has just been taken');
      } else if (existing.practitioner_id) {
        const others = await tx.appointment.findMany({
          where: {
            tenant_id: ctx.tenantId,
            practitioner_id: existing.practitioner_id,
            deleted_at: null,
            id: { not: id },
            start: { gte: new Date(dto.start.getTime() - 12 * 3_600_000) },
            end: { lte: new Date(end.getTime() + 12 * 3_600_000) },
          },
          select: { slot_id: true, start: true, end: true, status: true },
        });
        if (hasConflict(dto.start, end, others)) {
          throw new ConflictException('The practitioner already has an appointment at that time');
        }
      }

      if (existing.slot_id && existing.slot_id !== dto.slot_id) {
        await tx.slot.updateMany({ where: { id: existing.slot_id }, data: { status: 'free' } });
      }

      return tx.appointment.update({
        where: { id },
        data: {
          start: dto.start,
          end,
          minutes_duration: minutes,
          slot_id: dto.slot_id ?? null,
          status: 'booked',
          // The reminder must go out again for the new time.
          reminder_sent_at: null,
        },
      });
    });
  }

  /** Live queue state for the waiting-room display. */
  async queueDisplay(queueName: string, locationId?: string) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    const entries = await this.prisma.queue.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        queue_name: queueName,
        queue_date: today,
        deleted_at: null,
        ...(locationId ? { location_id: locationId } : {}),
      },
      select: {
        id: true,
        token: true,
        sequence: true,
        priority: true,
        status: true,
        called_at: true,
        counter: true,
      },
    });

    const snapshot = queueSnapshot(entries);
    return {
      queue_name: queueName,
      now_serving: snapshot.nowServing.slice(0, 3),
      waiting: snapshot.waiting.slice(0, 20),
      waiting_count: snapshot.waitingCount,
      generated_at: new Date().toISOString(),
    };
  }

  /**
   * Heuristic no-show risk from the patient's own history, lead time and slot timing.
   * A trained model is served by ai-service; this is the deterministic fallback used
   * at booking time so a value always exists.
   */
  private async estimateNoShowRisk(
    tx: Prisma.TransactionClient,
    tenantId: string,
    patientId: string,
    start: Date,
  ): Promise<number> {
    const [total, noShows] = await Promise.all([
      tx.appointment.count({
        where: { tenant_id: tenantId, patient_id: patientId, deleted_at: null, status: { in: ['fulfilled', 'noshow'] } },
      }),
      tx.appointment.count({
        where: { tenant_id: tenantId, patient_id: patientId, deleted_at: null, status: 'noshow' },
      }),
    ]);

    // Laplace smoothing keeps a first-ever booking off both extremes.
    const historyRate = (noShows + 1) / (total + 4);
    const leadDays = (start.getTime() - Date.now()) / 86_400_000;
    const leadPenalty = leadDays > 30 ? 0.12 : leadDays > 14 ? 0.06 : 0;
    const hour = start.getHours();
    const timePenalty = hour < 9 || hour >= 17 ? 0.05 : 0;

    return Number(Math.min(0.95, historyRate + leadPenalty + timePenalty).toFixed(3));
  }

  async list(params: { from: Date; to: Date; practitionerId?: string; status?: string }) {
    return this.prisma.appointment.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        start: { gte: params.from, lte: params.to },
        ...(params.practitionerId ? { practitioner_id: params.practitionerId } : {}),
        ...(params.status ? { status: params.status as never } : {}),
      },
      include: {
        patient: { select: { id: true, mrn: true, given_names: true, family_name: true } },
      },
      orderBy: { start: 'asc' },
    });
  }

  async cancel(id: string, reason: string) {
    const ctx = currentContext();
    const appointment = await this.prisma.appointment.findFirst({
      where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!appointment) throw new BadRequestException('Appointment not found');

    const [updated] = await this.prisma.$transaction([
      this.prisma.appointment.update({
        where: { id },
        data: { status: 'cancelled', cancellation_reason: reason },
      }),
      ...(appointment.slot_id
        ? [this.prisma.slot.update({ where: { id: appointment.slot_id }, data: { status: 'free' } })]
        : []),
    ]);
    return updated;
  }

  async markNoShow(id: string) {
    return this.prisma.appointment.update({ where: { id }, data: { status: 'noshow' } });
  }

  /**
   * Check-in issues a per-queue, per-day token. The sequence is allocated inside a
   * transaction so two front-desk terminals cannot mint the same token.
   */
  async checkIn(appointmentId: string, queueName = 'general') {
    const ctx = currentContext();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = await this.prisma.$transaction(async (tx) => {
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId, tenant_id: ctx.tenantId, deleted_at: null },
      });
      if (!appointment) throw new BadRequestException('Appointment not found');
      if (appointment.queue_token) return { appointment, queue: null };

      const last = await tx.queue.findFirst({
        where: { tenant_id: ctx.tenantId, queue_name: queueName, queue_date: today },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const sequence = (last?.sequence ?? 0) + 1;
      const token = `${queueName.slice(0, 1).toUpperCase()}${String(sequence).padStart(3, '0')}`;

      const waiting = await tx.queue.count({
        where: { tenant_id: ctx.tenantId, queue_name: queueName, queue_date: today, status: 'waiting' },
      });

      const queue = await tx.queue.create({
        data: {
          tenant_id: ctx.tenantId,
          location_id: appointment.location_id,
          appointment_id: appointment.id,
          patient_id: appointment.patient_id,
          queue_name: queueName,
          token,
          sequence,
          queue_date: today,
          estimated_wait_minutes: waiting * appointment.minutes_duration,
        },
      });

      const updated = await tx.appointment.update({
        where: { id: appointmentId },
        data: { status: 'checked_in', checked_in_at: new Date(), queue_token: token },
      });
      return { appointment: updated, queue };
    });

    this.realtime.emitToChannel(ctx.tenantId, `queue:${queueName}`, WS_EVENTS.QUEUE_UPDATED, {
      token: result.queue?.token,
      action: 'joined',
    });
    return result;
  }

  async callNext(queueName: string, counter: string) {
    const ctx = currentContext();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const next = await this.prisma.queue.findFirst({
      where: { tenant_id: ctx.tenantId, queue_name: queueName, queue_date: today, status: 'waiting' },
      orderBy: [{ priority: 'desc' }, { sequence: 'asc' }],
    });
    if (!next) return null;

    const called = await this.prisma.queue.update({
      where: { id: next.id },
      data: { status: 'called', called_at: new Date(), counter },
    });
    this.realtime.emitToChannel(ctx.tenantId, `queue:${queueName}`, WS_EVENTS.QUEUE_UPDATED, {
      token: called.token,
      counter,
      action: 'called',
    });
    return called;
  }

  async queueState(queueName: string) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return this.prisma.queue.findMany({
      where: { tenant_id: currentContext().tenantId, queue_name: queueName, queue_date: today, deleted_at: null },
      orderBy: [{ status: 'asc' }, { priority: 'desc' }, { sequence: 'asc' }],
    });
  }

  /**
   * Reminder sweep. Emits notification events for appointments starting in the next
   * 24-26h that have not been reminded; the notification worker owns Twilio delivery.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async sendReminders(): Promise<void> {
    const from = new Date(Date.now() + 24 * 3_600_000);
    const to = new Date(Date.now() + 26 * 3_600_000);

    const due = await this.prisma.appointment.findMany({
      where: {
        deleted_at: null,
        status: 'booked',
        reminder_sent_at: null,
        start: { gte: from, lte: to },
      },
      include: {
        patient: {
          select: {
            given_names: true,
            family_name: true,
            preferred_language: true,
            contacts: { where: { deleted_at: null, system: { in: ['phone', 'sms'] } }, take: 1 },
          },
        },
      },
      take: 500,
    });

    for (const appt of due) {
      const contact = appt.patient.contacts[0];
      if (!contact) continue;
      // High no-show risk gets WhatsApp (higher open rate) in addition to the SMS default.
      const channel: NotificationEvent['channel'] =
        Number(appt.noshow_risk ?? 0) > 0.5 ? 'whatsapp' : 'sms';
      const event: NotificationEvent = {
        tenant_id: appt.tenant_id,
        channel,
        recipient: contact.value,
        template: 'appointment.reminder',
        params: {
          name: appt.patient.given_names[0] ?? '',
          date: appt.start.toISOString(),
          service: appt.service_type,
          locale: appt.patient.preferred_language,
        },
      };
      await this.kafka.emit(KAFKA_TOPICS.NOTIFICATION, appt.tenant_id, event);
      await this.prisma.appointment.update({
        where: { id: appt.id },
        data: { reminder_sent_at: new Date(), reminder_channel: channel },
      });
    }

    if (due.length) this.logger.log(`Queued ${due.length} appointment reminders`);
  }
}

@ApiTags('appointments')
@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly service: AppointmentsService) {}

  @Get('availability')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Free slots in a window for online booking' })
  availability(@Query() q: Record<string, string>) {
    return this.service.availability(AvailabilityQuery.parse(q));
  }

  @Get()
  @RequirePermissions('patient:read')
  list(@Query() q: Record<string, string>) {
    return this.service.list({
      from: new Date(q.from ?? Date.now()),
      to: new Date(q.to ?? Date.now() + 86_400_000),
      practitionerId: q.practitioner_id,
      status: q.status,
    });
  }

  @Post()
  @RequirePermissions('patient:write')
  @Audit({ action: 'appointment.book', resourceType: 'Appointment', isPhi: true })
  book(@ZodBody(BookAppointmentDto) dto: z.infer<typeof BookAppointmentDto>) {
    return this.service.book(dto);
  }

  @Post(':id/check-in')
  @RequirePermissions('patient:write')
  @Audit({ action: 'appointment.check-in', resourceType: 'Appointment', isPhi: true })
  checkIn(@Param('id', ParseUUIDPipe) id: string, @Body('queue') queue?: string) {
    return this.service.checkIn(id, queue ?? 'general');
  }

  @Patch(':id/cancel')
  @RequirePermissions('patient:write')
  @Audit({ action: 'appointment.cancel', resourceType: 'Appointment', isPhi: true })
  cancel(@Param('id', ParseUUIDPipe) id: string, @Body('reason') reason: string) {
    return this.service.cancel(id, reason);
  }

  @Patch(':id/no-show')
  @RequirePermissions('patient:write')
  @Audit({ action: 'appointment.no-show', resourceType: 'Appointment', isPhi: true })
  noShow(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.markNoShow(id);
  }

  @Get('patient/:patientId')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'A patient\'s appointments, split into upcoming and past' })
  forPatient(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.service.forPatient(patientId);
  }

  @Post('walk-in')
  @RequirePermissions('patient:write')
  @Audit({ action: 'appointment.walk-in', resourceType: 'Appointment', isPhi: true })
  @ApiOperation({ summary: 'Register an unscheduled arrival and issue a queue token' })
  walkIn(@ZodBody(WalkInDto) dto: z.infer<typeof WalkInDto>) {
    return this.service.walkIn(dto);
  }

  @Patch(':id')
  @RequirePermissions('patient:write')
  @Audit({ action: 'appointment.reschedule', resourceType: 'Appointment', isPhi: true })
  @ApiOperation({ summary: 'Reschedule or cancel an appointment' })
  reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(RescheduleDto) dto: z.infer<typeof RescheduleDto>,
  ) {
    return this.service.reschedule(id, dto);
  }

  @Get('queue/:name/display')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Waiting-room display: now serving and next up' })
  queueDisplay(@Param('name') name: string, @Query('location_id') locationId?: string) {
    return this.service.queueDisplay(name, locationId);
  }

  @Get('queue/:name')
  @RequirePermissions('patient:read')
  queue(@Param('name') name: string) {
    return this.service.queueState(name);
  }

  @Post('queue/:name/call-next')
  @RequirePermissions('patient:write')
  callNext(@Param('name') name: string, @Body('counter') counter: string) {
    return this.service.callNext(name, counter);
  }
}

@Module({
  controllers: [AppointmentsController],
  providers: [AppointmentsService],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
