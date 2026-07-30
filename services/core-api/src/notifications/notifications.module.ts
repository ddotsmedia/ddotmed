import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  KAFKA_TOPICS,
  WS_EVENTS,
  type LabCriticalValueEvent,
} from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { RealtimeGateway } from '../messaging/realtime.gateway';
import { currentContext } from '../common/tenant-context';
import { Audit, RequirePermissions } from '../common/decorators';

export interface CreateNotification {
  tenant_id: string;
  user_id?: string | null;
  role?: string | null;
  category: string;
  severity?: 'info' | 'warning' | 'critical';
  title: string;
  body: string;
  patient_id?: string | null;
  encounter_id?: string | null;
  resource_type?: string | null;
  resource_id?: string | null;
  dedupe_key?: string | null;
  requires_acknowledgement?: boolean;
}

/**
 * The durable half of alerting.
 *
 * Kafka and the WebSocket fan-out are both best-effort — a clinician who was on a
 * different screen, or off shift, never saw them. This table is what remains, and
 * an alert that demanded acknowledgement stays outstanding until someone gives it.
 */
@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Writes the notification, collapsing repeats of the same clinical fact.
   *
   * Deduplication is on the fact, not the delivery: a result re-filed by an
   * analyser retry must not produce a second alert the clinician has to dismiss
   * twice, but it must also not silently reset an acknowledgement already given.
   */
  async create(input: CreateNotification) {
    const data = {
      tenant_id: input.tenant_id,
      user_id: input.user_id ?? null,
      role: input.role ?? null,
      category: input.category,
      severity: input.severity ?? 'info',
      title: input.title,
      body: input.body,
      patient_id: input.patient_id ?? null,
      encounter_id: input.encounter_id ?? null,
      resource_type: input.resource_type ?? null,
      resource_id: input.resource_id ?? null,
      dedupe_key: input.dedupe_key ?? null,
      requires_acknowledgement: input.requires_acknowledgement ?? false,
    };

    const notification = input.dedupe_key
      ? await this.prisma.notification.upsert({
          where: {
            tenant_id_dedupe_key: { tenant_id: input.tenant_id, dedupe_key: input.dedupe_key },
          },
          create: data,
          // Only the wording is refreshed; acknowledgement state is left alone.
          update: { title: data.title, body: data.body, severity: data.severity },
        })
      : await this.prisma.notification.create({ data });

    if (notification.user_id) {
      this.realtime.emitToChannel(
        input.tenant_id,
        `user:${notification.user_id}`,
        WS_EVENTS.NOTIFICATION,
        notification,
      );
    } else if (notification.role) {
      this.realtime.emitToRoles(input.tenant_id, [notification.role], WS_EVENTS.NOTIFICATION, notification);
    }

    return notification;
  }

  /** The signed-in user's inbox: their own alerts plus anything sent to their roles. */
  async inbox(params: { onlyUnacknowledged?: boolean; category?: string; limit?: number } = {}) {
    const ctx = currentContext();
    return this.prisma.notification.findMany({
      where: {
        tenant_id: ctx.tenantId,
        deleted_at: null,
        OR: [{ user_id: ctx.userId }, { role: { in: ctx.roles } }],
        ...(params.category ? { category: params.category } : {}),
        ...(params.onlyUnacknowledged ? { acknowledged_at: null } : {}),
      },
      orderBy: [{ acknowledged_at: { sort: 'asc', nulls: 'first' } }, { created_at: 'desc' }],
      take: params.limit ?? 50,
    });
  }

  async unacknowledgedCount() {
    const ctx = currentContext();
    const count = await this.prisma.notification.count({
      where: {
        tenant_id: ctx.tenantId,
        deleted_at: null,
        acknowledged_at: null,
        requires_acknowledgement: true,
        OR: [{ user_id: ctx.userId }, { role: { in: ctx.roles } }],
      },
    });
    return { count };
  }

  /**
   * Acknowledgement is a named act with a time on it — that is the whole point of
   * the record. Re-acknowledging is refused rather than silently overwriting who
   * took responsibility first.
   */
  async acknowledge(id: string) {
    const ctx = currentContext();
    const notification = await this.prisma.notification.findFirst({
      where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!notification) throw new BadRequestException('Notification not found');
    if (notification.acknowledged_at) {
      throw new BadRequestException('This notification has already been acknowledged');
    }

    return this.prisma.notification.update({
      where: { id },
      data: { acknowledged_at: new Date(), acknowledged_by: ctx.userId, read_at: new Date() },
    });
  }

  async markRead(id: string) {
    const ctx = currentContext();
    const notification = await this.prisma.notification.findFirst({
      where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!notification) throw new BadRequestException('Notification not found');
    if (notification.read_at) return notification;
    return this.prisma.notification.update({ where: { id }, data: { read_at: new Date() } });
  }

  /** Turns a critical lab value into an inbox item for whoever ordered the test. */
  async fromCriticalLabValue(event: LabCriticalValueEvent) {
    const range = event.reference_range ? ` (reference ${event.reference_range})` : '';
    return this.create({
      tenant_id: event.tenant_id,
      // Straight to the requester when we know them; to the wards when we do not.
      user_id: event.ordering_practitioner_id,
      role: event.ordering_practitioner_id ? null : 'doctor',
      category: 'lab-critical',
      severity: 'critical',
      title: `Critical result: ${event.test_name}`,
      body: `${event.value}${event.unit ? ` ${event.unit}` : ''}${range}. Acknowledge and act.`,
      patient_id: event.patient_id,
      encounter_id: event.encounter_id,
      resource_type: 'Observation',
      resource_id: event.result_id,
      dedupe_key: `lab-critical:${event.result_id}`,
      requires_acknowledgement: true,
    });
  }
}

/**
 * Consumes critical lab values off the bus and files them.
 *
 * Runs outside a request, so it has no tenant context to read — the tenant comes
 * from the event itself and every write here is explicit about it.
 */
@Injectable()
export class CriticalValueConsumer implements OnModuleInit {
  private readonly log = new Logger(CriticalValueConsumer.name);

  constructor(
    private readonly kafka: KafkaService,
    private readonly notifications: NotificationsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.kafka.subscribe(
      KAFKA_TOPICS.LAB_CRITICAL_VALUE,
      'medicore-lab-critical-value',
      async (payload) => {
        await this.handle(payload as LabCriticalValueEvent);
      },
    );
  }

  /** Exposed so the behaviour can be exercised without a broker. */
  async handle(event: LabCriticalValueEvent): Promise<void> {
    if (!event?.tenant_id || !event.result_id) {
      this.log.warn('Discarded a lab.critical_value event with no tenant or result id');
      return;
    }
    await this.notifications.fromCriticalLabValue(event);
    this.log.log(`Filed a critical value notification for result ${event.result_id}`);
  }
}

@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly service: NotificationsService) {}

  @Get()
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'The signed-in user’s inbox, unacknowledged first' })
  inbox(
    @Query('unacknowledged') unacknowledged?: string,
    @Query('category') category?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.inbox({
      onlyUnacknowledged: unacknowledged === 'true',
      category,
      limit: limit ? Number(limit) : 50,
    });
  }

  @Get('unacknowledged-count')
  @RequirePermissions('patient:read')
  count() {
    return this.service.unacknowledgedCount();
  }

  @Patch(':id/acknowledge')
  @RequirePermissions('patient:read')
  @Audit({ action: 'notification.acknowledge', resourceType: 'Composition', isPhi: true })
  @ApiOperation({ summary: 'Record that this clinician has seen and accepted the alert' })
  acknowledge(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.acknowledge(id);
  }

  @Patch(':id/read')
  @RequirePermissions('patient:read')
  read(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.markRead(id);
  }
}

@Module({
  controllers: [NotificationsController],
  providers: [NotificationsService, CriticalValueConsumer],
  exports: [NotificationsService],
})
export class NotificationsModule {}
