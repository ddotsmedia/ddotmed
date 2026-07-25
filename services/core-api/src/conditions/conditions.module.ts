import {
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Body,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { KAFKA_TOPICS, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { conditionToFhir } from '../fhir/mappers';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';

const ICD10 = 'http://hl7.org/fhir/sid/icd-10';
const ICD11 = 'http://id.who.int/icd/release/11/mms';

export const RecordConditionDto = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid().nullable().optional(),
  code_system: z.enum([ICD10, ICD11]).default(ICD10),
  code: z.string().min(1).max(20),
  code_display: z.string().optional(),
  snomed_code: z.string().optional(),
  /** problem_list_item persists across encounters; encounter_diagnosis is scoped to one visit. */
  category: z.enum(['problem_list_item', 'encounter_diagnosis']).default('encounter_diagnosis'),
  clinical_status: z
    .enum(['active', 'recurrence', 'relapse', 'inactive', 'remission', 'resolved'])
    .default('active'),
  verification_status: z
    .enum(['unconfirmed', 'provisional', 'differential', 'confirmed', 'refuted', 'entered_in_error'])
    .default('confirmed'),
  severity: z.enum(['mild', 'moderate', 'severe']).optional(),
  body_site: z.string().optional(),
  onset_date: z.coerce.date().optional(),
  is_primary: z.boolean().default(false),
  notes: z.string().max(2000).optional(),
});

@Injectable()
export class ConditionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  async record(dto: z.infer<typeof RecordConditionDto>) {
    const ctx = currentContext();

    // Only one primary diagnosis per encounter — demote any previous holder.
    if (dto.is_primary && dto.encounter_id) {
      await this.prisma.condition.updateMany({
        where: {
          tenant_id: ctx.tenantId,
          encounter_id: dto.encounter_id,
          is_primary: true,
          deleted_at: null,
        },
        data: { is_primary: false },
      });
    }

    const condition = await this.prisma.condition.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        encounter_id: dto.encounter_id ?? null,
        code_system: dto.code_system,
        code: dto.code,
        code_display: dto.code_display,
        snomed_code: dto.snomed_code,
        category: dto.category,
        clinical_status: dto.clinical_status,
        verification_status: dto.verification_status,
        severity: dto.severity,
        body_site: dto.body_site,
        onset_date: dto.onset_date,
        is_primary: dto.is_primary,
        notes: dto.notes,
        recorded_by: ctx.userId!,
      },
    });

    const event: FhirSyncEvent = {
      tenant_id: ctx.tenantId,
      resource_type: 'Condition',
      internal_id: condition.id,
      fhir_id: condition.fhir_id,
      operation: 'create',
      payload: conditionToFhir(condition as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, ctx.tenantId, event);
    return condition;
  }

  async problemList(patientId: string) {
    return this.prisma.condition.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        patient_id: patientId,
        deleted_at: null,
        category: 'problem_list_item',
        clinical_status: { in: ['active', 'recurrence', 'relapse'] },
      },
      orderBy: [{ is_primary: 'desc' }, { onset_date: 'desc' }],
    });
  }

  async forEncounter(encounterId: string) {
    return this.prisma.condition.findMany({
      where: { tenant_id: currentContext().tenantId, encounter_id: encounterId, deleted_at: null },
      orderBy: [{ is_primary: 'desc' }, { created_at: 'asc' }],
    });
  }

  async resolve(id: string, abatementDate?: Date) {
    const updated = await this.prisma.condition.update({
      where: { id },
      data: { clinical_status: 'resolved', abatement_date: abatementDate ?? new Date() },
    });
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, updated.tenant_id, {
      tenant_id: updated.tenant_id,
      resource_type: 'Condition',
      internal_id: updated.id,
      fhir_id: updated.fhir_id,
      operation: 'update',
      payload: conditionToFhir(updated as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    } satisfies FhirSyncEvent);
    return updated;
  }

  /** Promotes an encounter diagnosis onto the persistent problem list. */
  async promoteToProblemList(id: string) {
    return this.prisma.condition.update({
      where: { id },
      data: { category: 'problem_list_item' },
    });
  }
}

@ApiTags('conditions')
@Controller('conditions')
export class ConditionsController {
  constructor(private readonly service: ConditionsService) {}

  @Post()
  @RequirePermissions('condition:write')
  @Audit({ action: 'condition.record', resourceType: 'Condition', isPhi: true })
  record(@ZodBody(RecordConditionDto) dto: z.infer<typeof RecordConditionDto>) {
    return this.service.record(dto);
  }

  @Get('patient/:patientId/problem-list')
  @RequirePermissions('patient:read')
  problemList(@Param('patientId', ParseUUIDPipe) patientId: string) {
    return this.service.problemList(patientId);
  }

  @Get('encounter/:encounterId')
  @RequirePermissions('encounter:read')
  forEncounter(@Param('encounterId', ParseUUIDPipe) encounterId: string) {
    return this.service.forEncounter(encounterId);
  }

  @Patch(':id/resolve')
  @RequirePermissions('condition:write')
  @Audit({ action: 'condition.resolve', resourceType: 'Condition', isPhi: true })
  resolve(@Param('id', ParseUUIDPipe) id: string, @Query('date') date?: string) {
    return this.service.resolve(id, date ? new Date(date) : undefined);
  }

  @Patch(':id/promote')
  @RequirePermissions('condition:write')
  @Audit({ action: 'condition.promote', resourceType: 'Condition', isPhi: true })
  promote(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.promoteToProblemList(id);
  }
}

@Module({
  controllers: [ConditionsController],
  providers: [ConditionsService],
  exports: [ConditionsService],
})
export class ConditionsModule {}
