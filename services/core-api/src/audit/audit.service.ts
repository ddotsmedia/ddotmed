import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { AuditEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { KAFKA_TOPICS } from '@medicore/shared-types';

export type AuditInput = Omit<AuditEvent, 'before' | 'after'> & {
  session_id?: string | null;
  break_glass_reason?: string;
  before_state?: Record<string, unknown> | null;
  after_state?: Record<string, unknown> | null;
};

@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  async record(event: AuditInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        tenant_id: event.tenant_id,
        user_id: event.user_id ?? null,
        session_id: event.session_id ?? null,
        action: event.action,
        resource_type: event.resource_type,
        resource_id: event.resource_id ?? null,
        patient_id: event.patient_id ?? null,
        outcome: event.outcome,
        is_break_glass: event.is_break_glass,
        break_glass_reason: event.break_glass_reason ?? null,
        ip: event.ip,
        user_agent: event.user_agent,
        before_state: (event.before_state ?? undefined) as Prisma.InputJsonValue | undefined,
        after_state: (event.after_state ?? undefined) as Prisma.InputJsonValue | undefined,
        occurred_at: new Date(event.occurred_at),
      },
    });

    // Mirror to Kafka so SIEM ingestion does not have to poll the database.
    void this.kafka.emit(KAFKA_TOPICS.AUDIT, event.tenant_id, event);
  }

  async search(params: {
    tenantId: string;
    patientId?: string;
    userId?: string;
    action?: string;
    breakGlassOnly?: boolean;
    from?: Date;
    to?: Date;
    page?: number;
    limit?: number;
  }) {
    const { tenantId, page = 1, limit = 50 } = params;
    const where = {
      tenant_id: tenantId,
      ...(params.patientId ? { patient_id: params.patientId } : {}),
      ...(params.userId ? { user_id: params.userId } : {}),
      ...(params.action ? { action: { contains: params.action } } : {}),
      ...(params.breakGlassOnly ? { is_break_glass: true } : {}),
      ...(params.from || params.to
        ? { occurred_at: { ...(params.from ? { gte: params.from } : {}), ...(params.to ? { lte: params.to } : {}) } }
        : {}),
    };
    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { occurred_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLog.count({ where }),
    ]);
    return { data, total, page, limit, pages: Math.ceil(total / limit) };
  }
}
