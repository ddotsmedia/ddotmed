import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { KAFKA_TOPICS, type FhirSyncEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { clinicalNoteToFhir } from '../fhir/mappers';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';

const LinkedEvidence = z.object({
  sentence: z.string(),
  audio_offset_ms: z.number().int().min(0),
  confidence: z.number().min(0).max(1),
});

export const WriteNoteDto = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid(),
  type: z.enum(['soap', 'progress', 'nursing', 'discharge', 'sbar']).default('soap'),
  subjective: z.string().max(20000).optional(),
  objective: z.string().max(20000).optional(),
  assessment: z.string().max(20000).optional(),
  plan: z.string().max(20000).optional(),
  body: z.string().max(50000).optional(),
  ai_drafted: z.boolean().default(false),
  ai_session_id: z.string().uuid().nullable().optional(),
  ai_model_version: z.string().optional(),
  ai_confidence: z.number().min(0).max(1).nullable().optional(),
  linked_evidence: z.array(LinkedEvidence).default([]),
});

@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
  ) {}

  /** AI-drafted notes always land as pending-approval, never as draft the author owns silently. */
  async write(dto: z.infer<typeof WriteNoteDto>) {
    const ctx = currentContext();
    const note = await this.prisma.clinicalNote.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: dto.patient_id,
        encounter_id: dto.encounter_id,
        author_id: ctx.userId!,
        type: dto.type,
        status: dto.ai_drafted ? 'pending_approval' : 'draft',
        subjective: dto.subjective,
        objective: dto.objective,
        assessment: dto.assessment,
        plan: dto.plan,
        body: dto.body,
        ai_drafted: dto.ai_drafted,
        ai_session_id: dto.ai_session_id ?? null,
        ai_model_version: dto.ai_model_version,
        ai_confidence: dto.ai_confidence ?? null,
        linked_evidence: dto.linked_evidence,
      },
    });
    return note;
  }

  /**
   * Amending a signed note never mutates it: a new version supersedes the old one,
   * so the record retains what was signed and when.
   */
  async amend(id: string, patch: Partial<z.infer<typeof WriteNoteDto>>) {
    const ctx = currentContext();
    const existing = await this.prisma.clinicalNote.findFirst({
      where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!existing) throw new BadRequestException('Note not found');

    if (existing.status !== 'signed') {
      return this.prisma.clinicalNote.update({
        where: { id },
        data: {
          subjective: patch.subjective ?? existing.subjective,
          objective: patch.objective ?? existing.objective,
          assessment: patch.assessment ?? existing.assessment,
          plan: patch.plan ?? existing.plan,
          body: patch.body ?? existing.body,
        },
      });
    }

    const [, next] = await this.prisma.$transaction([
      this.prisma.clinicalNote.update({ where: { id }, data: { status: 'amended' } }),
      this.prisma.clinicalNote.create({
        data: {
          tenant_id: existing.tenant_id,
          patient_id: existing.patient_id,
          encounter_id: existing.encounter_id,
          author_id: ctx.userId!,
          type: existing.type,
          status: 'draft',
          subjective: patch.subjective ?? existing.subjective,
          objective: patch.objective ?? existing.objective,
          assessment: patch.assessment ?? existing.assessment,
          plan: patch.plan ?? existing.plan,
          body: patch.body ?? existing.body,
          ai_drafted: false,
          linked_evidence: existing.linked_evidence as never,
          version: existing.version + 1,
          supersedes_id: existing.id,
        },
      }),
    ]);
    return next;
  }

  /** Signing is the act that puts a note into the legal record. Only a clinician may do it. */
  async sign(id: string) {
    const ctx = currentContext();
    const note = await this.prisma.clinicalNote.findFirst({
      where: { id, tenant_id: ctx.tenantId, deleted_at: null },
    });
    if (!note) throw new BadRequestException('Note not found');
    if (note.status === 'signed') throw new BadRequestException('Note is already signed');
    if (!ctx.permissions.includes('note:sign')) {
      throw new ForbiddenException('Your role may not sign clinical notes');
    }

    const signed = await this.prisma.clinicalNote.update({
      where: { id },
      data: { status: 'signed', approved_by: ctx.userId, approved_at: new Date() },
    });

    const event: FhirSyncEvent = {
      tenant_id: signed.tenant_id,
      resource_type: 'Composition',
      internal_id: signed.id,
      fhir_id: signed.fhir_id,
      operation: 'create',
      payload: clinicalNoteToFhir(signed as unknown as Record<string, unknown>),
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.FHIR_SYNC, signed.tenant_id, event);
    return signed;
  }

  async discard(id: string, reason: string) {
    return this.prisma.clinicalNote.update({
      where: { id },
      data: { status: 'entered_in_error', deleted_at: new Date(), deleted_reason: reason },
    });
  }

  async forEncounter(encounterId: string) {
    return this.prisma.clinicalNote.findMany({
      where: { tenant_id: currentContext().tenantId, encounter_id: encounterId, deleted_at: null },
      orderBy: { created_at: 'desc' },
    });
  }

  /** Full version chain for a note, oldest first. */
  async versionHistory(id: string) {
    const chain: Awaited<ReturnType<typeof this.prisma.clinicalNote.findFirst>>[] = [];
    let cursor: string | null = id;
    let guard = 0;
    // Guard against a cycle in supersedes_id created by a bad migration or manual edit.
    while (cursor && guard++ < 100) {
      const note: Awaited<ReturnType<typeof this.prisma.clinicalNote.findFirst>> =
        await this.prisma.clinicalNote.findFirst({
          where: { id: cursor, tenant_id: currentContext().tenantId },
        });
      if (!note) break;
      chain.push(note);
      cursor = note.supersedes_id;
    }
    return chain.reverse();
  }
}

@ApiTags('clinical-notes')
@Controller('notes')
export class NotesController {
  constructor(private readonly service: NotesService) {}

  @Post()
  @RequirePermissions('note:write')
  @Audit({ action: 'note.write', resourceType: 'Composition', isPhi: true })
  write(@ZodBody(WriteNoteDto) dto: z.infer<typeof WriteNoteDto>) {
    return this.service.write(dto);
  }

  @Get('encounter/:encounterId')
  @RequirePermissions('note:read')
  forEncounter(@Param('encounterId', ParseUUIDPipe) encounterId: string) {
    return this.service.forEncounter(encounterId);
  }

  @Get(':id/versions')
  @RequirePermissions('note:read')
  versions(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.versionHistory(id);
  }

  @Patch(':id')
  @RequirePermissions('note:write')
  @Audit({ action: 'note.amend', resourceType: 'Composition', isPhi: true })
  @ApiOperation({ summary: 'Amend a note; a signed note is superseded by a new version' })
  amend(@Param('id', ParseUUIDPipe) id: string, @Body() patch: Record<string, string>) {
    return this.service.amend(id, patch);
  }

  @Post(':id/sign')
  @RequirePermissions('note:sign')
  @Audit({ action: 'note.sign', resourceType: 'Composition', isPhi: true })
  sign(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.sign(id);
  }

  @Post(':id/discard')
  @RequirePermissions('note:write')
  @Audit({ action: 'note.discard', resourceType: 'Composition', isPhi: true })
  discard(@Param('id', ParseUUIDPipe) id: string, @Body('reason') reason: string) {
    return this.service.discard(id, reason);
  }
}

@Module({
  controllers: [NotesController],
  providers: [NotesService],
  exports: [NotesService],
})
export class NotesModule {}
