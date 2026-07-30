import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { KAFKA_TOPICS, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { serviceRequestToFhir } from '../fhir/mappers';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { LabService } from './lab.module';
import {
  barcodeFor,
  canChangePriority,
  canTransition,
  isTerminal,
  labelFor,
  sortByUrgency,
  type OrderPriority,
  type OrderStatus,
} from './lab-orders';

export const CreateServiceRequestDto = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid().nullable().optional(),
  loinc_code: z.string().min(1),
  test_name: z.string().min(1),
  priority: z.enum(['routine', 'urgent', 'asap', 'stat']).default('routine'),
  fasting_required: z.boolean().default(false),
  clinical_notes: z.string().max(2000).optional(),
  specimen_type: z.string().default('blood'),
  scheduled_for: z.coerce.date().optional(),
});

export const UpdateServiceRequestDto = z.object({
  status: z.enum(['active', 'on_hold', 'revoked', 'completed']).optional(),
  priority: z.enum(['routine', 'urgent', 'asap', 'stat']).optional(),
  clinical_notes: z.string().max(2000).optional(),
  reason: z.string().min(3).max(500).optional(),
});

@Injectable()
export class ServiceRequestsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly lab: LabService,
  ) {}

  async list(params: {
    patientId?: string;
    encounterId?: string;
    category?: string;
    status?: string;
    limit?: number;
  }) {
    const rows = await this.prisma.serviceRequest.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        deleted_at: null,
        ...(params.patientId ? { patient_id: params.patientId } : {}),
        ...(params.encounterId ? { encounter_id: params.encounterId } : {}),
        ...(params.category ? { category: params.category } : {}),
        ...(params.status ? { status: params.status as never } : {}),
      },
      include: {
        specimens: true,
        patient: { select: { mrn: true, given_names: true, family_name: true } },
        results: {
          where: { deleted_at: null },
          select: { id: true, interpretation: true, is_critical: true, performed_at: true },
        },
      },
      take: params.limit ?? 100,
    });

    // Ordered here rather than in SQL: priority is a word, and its urgency order
    // is not its alphabetical one.
    return sortByUrgency(rows);
  }

  async get(id: string) {
    const order = await this.prisma.serviceRequest.findFirst({
      where: { id, tenant_id: currentContext().tenantId, deleted_at: null },
      include: {
        specimens: true,
        results: { where: { deleted_at: null }, orderBy: { performed_at: 'desc' } },
        patient: { select: { mrn: true, given_names: true, family_name: true } },
      },
    });
    if (!order) throw new BadRequestException('Order not found');
    return order;
  }

  /**
   * Cancel, hold or re-prioritise a live order.
   *
   * Priority may be raised but not lowered — see `canChangePriority`. Revoking
   * needs a reason, which is what a lab tech reads when the tube arrives for a
   * test nobody wants any more.
   */
  async update(id: string, dto: z.infer<typeof UpdateServiceRequestDto>) {
    const ctx = currentContext();
    const order = await this.prisma.serviceRequest.findFirst({
      where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!order) throw new BadRequestException('Order not found');

    const current = order.status as OrderStatus;
    if (isTerminal(current)) {
      throw new BadRequestException(`This order is already ${current} and cannot be changed`);
    }

    if (dto.status && dto.status !== current && !canTransition(current, dto.status)) {
      throw new BadRequestException(`Cannot move an order from ${current} to ${dto.status}`);
    }
    if (dto.status === 'revoked' && !dto.reason) {
      throw new BadRequestException('A reason is required to cancel an order');
    }
    if (
      dto.priority &&
      dto.priority !== order.priority &&
      !canChangePriority(current, order.priority as OrderPriority, dto.priority)
    ) {
      throw new BadRequestException(
        `Cannot lower the priority of a ${order.priority} order — cancel it and reorder instead`,
      );
    }

    const updated = await this.prisma.serviceRequest.update({
      where: { id },
      data: {
        ...(dto.status ? { status: dto.status as never } : {}),
        ...(dto.priority ? { priority: dto.priority } : {}),
        ...(dto.clinical_notes ? { clinical_notes: dto.clinical_notes } : {}),
        ...(dto.status === 'revoked'
          ? { deleted_reason: dto.reason, performed_at: order.performed_at }
          : {}),
      },
    });

    // A cancelled order must not leave a tube on the phlebotomy list.
    if (dto.status === 'revoked') {
      await this.prisma.labSpecimen.updateMany({
        where: {
          tenant_id: ctx.tenantId,
          service_request_id: id,
          status: 'pending-collection',
          deleted_at: null,
        },
        data: { status: 'cancelled' },
      });
    }

    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, {
      tenant_id: ctx.tenantId,
      resource_type: 'ServiceRequest',
      internal_id: updated.id,
      fhir_id: updated.fhir_id,
      operation: 'update',
      payload: serviceRequestToFhir(updated as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    } satisfies FhirSyncEvent);

    return updated;
  }

  /** The fields a label printer needs, resolved in one call. */
  async label(id: string) {
    const order = await this.get(id);
    return labelFor(
      {
        order_number: order.order_number,
        barcode: order.barcode,
        code_display: order.code_display,
        priority: order.priority,
        fasting_required: order.fasting_required,
      },
      order.patient,
      new Date(),
    );
  }
}

@ApiTags('service-requests')
@Controller('service-requests')
export class ServiceRequestsController {
  constructor(
    private readonly service: ServiceRequestsService,
    private readonly lab: LabService,
  ) {}

  @Post()
  @RequirePermissions('lab:order')
  @Audit({ action: 'lab.order', resourceType: 'ServiceRequest', isPhi: true })
  @ApiOperation({ summary: 'Order a test; returns the barcode to print on the tube' })
  async create(@ZodBody(CreateServiceRequestDto) dto: z.infer<typeof CreateServiceRequestDto>) {
    const order = await this.lab.order({
      patient_id: dto.patient_id,
      encounter_id: dto.encounter_id ?? null,
      loinc_code: dto.loinc_code,
      display: dto.test_name,
      priority: dto.priority,
      specimen_type: dto.specimen_type,
      fasting_required: dto.fasting_required,
      scheduled_for: dto.scheduled_for,
      clinical_notes: dto.clinical_notes,
    });

    return {
      ...order,
      // Named for what the caller does with it: this is the label payload.
      barcode_id: order.barcode ?? barcodeFor(order.order_number),
    };
  }

  @Get()
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Orders for a patient, most urgent first' })
  list(
    @Query('patientId') patientId?: string,
    @Query('encounterId') encounterId?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    if (!patientId && !encounterId) {
      throw new BadRequestException('patientId or encounterId is required');
    }
    return this.service.list({
      patientId,
      encounterId,
      category,
      status,
      limit: limit ? Number(limit) : 100,
    });
  }

  @Get(':id')
  @RequirePermissions('patient:read')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Get(':id/label')
  @RequirePermissions('lab:order')
  @ApiOperation({ summary: 'Label fields for the specimen tube' })
  label(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.label(id);
  }

  @Patch(':id')
  @RequirePermissions('lab:order')
  @Audit({ action: 'lab.order.update', resourceType: 'ServiceRequest', isPhi: true })
  @ApiOperation({ summary: 'Cancel, hold or raise the priority of an order' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(UpdateServiceRequestDto) dto: z.infer<typeof UpdateServiceRequestDto>,
  ) {
    return this.service.update(id, dto);
  }
}
