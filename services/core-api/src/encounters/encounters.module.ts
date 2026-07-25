import {
  BadRequestException,
  Body,
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
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { KAFKA_TOPICS, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { encounterToFhir } from '../fhir/mappers';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';

export const OpenEncounterDto = z.object({
  patient_id: z.string().uuid(),
  practitioner_id: z.string().uuid().nullable().optional(),
  location_id: z.string().uuid().nullable().optional(),
  organization_id: z.string().uuid().nullable().optional(),
  appointment_id: z.string().uuid().nullable().optional(),
  class: z.enum(['AMB', 'EMER', 'IMP', 'ACUTE', 'NONAC', 'OBSENC', 'VR', 'HH']).default('AMB'),
  type_code: z.string().optional(),
  type_display: z.string().optional(),
  reason_text: z.string().max(2000).optional(),
  triage_level: z.number().int().min(1).max(5).nullable().optional(),
});

export const DischargeDto = z.object({
  disposition: z.string().min(1),
  summary_note_id: z.string().uuid().nullable().optional(),
});

const STATUS_FLOW: Record<string, string[]> = {
  planned: ['arrived', 'cancelled'],
  arrived: ['triaged', 'in_progress', 'cancelled'],
  triaged: ['in_progress', 'cancelled'],
  in_progress: ['onleave', 'finished', 'cancelled'],
  onleave: ['in_progress', 'finished'],
  finished: ['closed'],
  closed: [],
  cancelled: [],
};

@Injectable()
export class EncountersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  async open(dto: z.infer<typeof OpenEncounterDto>) {
    const ctx = currentContext();
    const encounter = await this.prisma.encounter.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        practitioner_id: dto.practitioner_id ?? ctx.practitionerId ?? null,
        location_id: dto.location_id ?? null,
        organization_id: dto.organization_id ?? null,
        appointment_id: dto.appointment_id ?? null,
        status: 'in_progress',
        class: dto.class,
        type_code: dto.type_code,
        type_display: dto.type_display,
        reason_text: dto.reason_text,
        triage_level: dto.triage_level ?? null,
        period_start: new Date(),
      },
    });
    await this.sync(encounter.id, 'create');
    return encounter;
  }

  /** Status changes follow the FHIR Encounter lifecycle; illegal jumps are rejected. */
  async setStatus(id: string, next: string) {
    const encounter = await this.prisma.encounter.findFirst({
      where: { id, tenant_id: currentContext().tenantId, deleted_at: null },
    });
    if (!encounter) throw new BadRequestException('Encounter not found');
    if (!STATUS_FLOW[encounter.status]?.includes(next)) {
      throw new BadRequestException(
        `Cannot move an encounter from ${encounter.status} to ${next}`,
      );
    }
    const updated = await this.prisma.encounter.update({
      where: { id },
      data: {
        status: next as never,
        ...(next === 'finished' || next === 'closed' ? { period_end: new Date() } : {}),
      },
    });
    await this.sync(id, 'update');
    return updated;
  }

  /** Discharge closes the encounter and triggers the downstream FHIR sync. */
  async discharge(id: string, dto: z.infer<typeof DischargeDto>) {
    const encounter = await this.prisma.encounter.findFirst({
      where: { id, tenant_id: currentContext().tenantId, deleted_at: null },
    });
    if (!encounter) throw new BadRequestException('Encounter not found');
    if (encounter.status === 'closed' || encounter.status === 'cancelled') {
      throw new BadRequestException(`Encounter is already ${encounter.status}`);
    }

    const updated = await this.prisma.encounter.update({
      where: { id },
      data: {
        status: 'finished',
        period_end: new Date(),
        discharge_disposition: dto.disposition,
        discharge_summary_id: dto.summary_note_id ?? null,
      },
    });
    await this.sync(id, 'update');
    return updated;
  }

  async get(id: string) {
    const encounter = await this.prisma.encounter.findFirst({
      where: { id, tenant_id: currentContext().tenantId, deleted_at: null },
      include: {
        patient: { select: { id: true, mrn: true, given_names: true, family_name: true, birth_date: true, gender: true } },
        conditions: { where: { deleted_at: null } },
        clinical_notes: { where: { deleted_at: null }, orderBy: { created_at: 'desc' } },
        vitals: { where: { deleted_at: null }, orderBy: { recorded_at: 'desc' }, take: 10 },
        medications: { where: { deleted_at: null } },
        service_requests: { where: { deleted_at: null } },
      },
    });
    if (!encounter) throw new BadRequestException('Encounter not found');
    return encounter;
  }

  async listForPatient(patientId: string, limit = 25) {
    return this.prisma.encounter.findMany({
      where: { tenant_id: currentContext().tenantId, patient_id: patientId, deleted_at: null },
      orderBy: { period_start: 'desc' },
      take: limit,
    });
  }

  private async sync(id: string, operation: 'create' | 'update') {
    const row = await this.prisma.encounter.findUnique({ where: { id } });
    if (!row) return;
    const event: FhirSyncEvent = {
      tenant_id: row.tenant_id,
      resource_type: 'Encounter',
      internal_id: row.id,
      fhir_id: row.fhir_id,
      operation,
      payload: encounterToFhir(row as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, row.tenant_id, event);
  }
}

@ApiTags('encounters')
@Controller('encounters')
export class EncountersController {
  constructor(private readonly service: EncountersService) {}

  @Post()
  @RequirePermissions('encounter:write')
  @Audit({ action: 'encounter.open', resourceType: 'Encounter', isPhi: true })
  open(@ZodBody(OpenEncounterDto) dto: z.infer<typeof OpenEncounterDto>) {
    return this.service.open(dto);
  }

  @Get('patient/:patientId')
  @RequirePermissions('encounter:read')
  list(@Param('patientId', ParseUUIDPipe) patientId: string, @Query('limit') limit?: string) {
    return this.service.listForPatient(patientId, limit ? Number(limit) : 25);
  }

  @Get(':id')
  @RequirePermissions('encounter:read')
  @Audit({ action: 'encounter.read', resourceType: 'Encounter', isPhi: true })
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.get(id);
  }

  @Patch(':id/status')
  @RequirePermissions('encounter:write')
  @Audit({ action: 'encounter.status', resourceType: 'Encounter', isPhi: true })
  setStatus(@Param('id', ParseUUIDPipe) id: string, @Body('status') status: string) {
    return this.service.setStatus(id, status);
  }

  @Post(':id/discharge')
  @RequirePermissions('encounter:write')
  @Audit({ action: 'encounter.discharge', resourceType: 'Encounter', isPhi: true })
  discharge(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(DischargeDto) dto: z.infer<typeof DischargeDto>,
  ) {
    return this.service.discharge(id, dto);
  }
}

@Module({
  controllers: [EncountersController],
  providers: [EncountersService],
  exports: [EncountersService],
})
export class EncountersModule {}
