import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { WS_EVENTS } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { RealtimeGateway } from '../messaging/realtime.gateway';
import { currentContext } from '../common/tenant-context';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { participantRole, type ParticipantRole } from './teleconsult';
import {
  DEFAULT_PRESIGN_TTL_SECONDS,
  MAX_ATTACHMENT_BYTES,
  attachmentObjectKey,
  presignExpiry,
  presignS3Url,
  type ObjectStoreConfig,
} from './presign';

export const SendMessageDto = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const v = value as Record<string, unknown>;
    return { ...v, appointment_id: v.appointment_id ?? v.appointmentId };
  },
  z
    .object({
      appointment_id: z.string().uuid(),
      body: z.string().max(5_000).optional(),
      /** The object key returned by the attachment endpoint, not a client-made URL. */
      attachment_key: z.string().max(1024).optional(),
      attachment_name: z.string().max(255).optional(),
      attachment_content_type: z.string().max(255).optional(),
      attachment_size_bytes: z.number().int().min(0).max(MAX_ATTACHMENT_BYTES).optional(),
    })
    // An empty message is not a message; one of the two has to carry something.
    .refine((v) => Boolean(v.body?.trim()) || Boolean(v.attachment_key), {
      message: 'A message needs either text or an attachment',
    }),
);

export const AttachmentRequestDto = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const v = value as Record<string, unknown>;
    return { ...v, appointment_id: v.appointment_id ?? v.appointmentId };
  },
  z.object({
    appointment_id: z.string().uuid(),
    filename: z.string().min(1).max(255),
    content_type: z.string().min(1).max(255).default('application/octet-stream'),
    size_bytes: z.number().int().positive(),
  }),
);

export const MarkReadDto = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const v = value as Record<string, unknown>;
    return { ...v, appointment_id: v.appointment_id ?? v.appointmentId };
  },
  z.object({ appointment_id: z.string().uuid() }),
);

/**
 * MinIO, reached over presigned URLs.
 *
 * The file never passes through this service: the browser PUTs straight to the
 * object store and GETs straight back from it. A 10 MB attachment through a Node
 * process is 10 MB of heap and a request that blocks a clinical write behind it.
 */
@Injectable()
export class ObjectStorageService {
  constructor(private readonly config: ConfigService) {}

  /**
   * The endpoint the *browser* will use.
   *
   * Signed against the public host on purpose: SigV4 signs the Host header, so a
   * URL signed for `http://minio:9000` — the compose-network name this service
   * uses — fails the moment a browser rewrites the host to reach it.
   */
  private get endpoint(): string | undefined {
    return (
      this.config.get<string>('MINIO_PUBLIC_URL') ??
      this.config.get<string>('S3_PUBLIC_URL') ??
      this.config.get<string>('MINIO_ENDPOINT') ??
      this.config.get<string>('S3_ENDPOINT')
    );
  }

  private get credentials(): { accessKeyId?: string; secretAccessKey?: string } {
    return {
      accessKeyId:
        this.config.get<string>('MINIO_ACCESS_KEY') ?? this.config.get<string>('S3_ACCESS_KEY_ID'),
      secretAccessKey:
        this.config.get<string>('MINIO_SECRET_KEY') ??
        this.config.get<string>('S3_SECRET_ACCESS_KEY'),
    };
  }

  get bucket(): string {
    return (
      this.config.get<string>('MINIO_BUCKET') ??
      this.config.get<string>('S3_BUCKET') ??
      'medicore-attachments'
    );
  }

  get isConfigured(): boolean {
    const { accessKeyId, secretAccessKey } = this.credentials;
    return Boolean(this.endpoint && accessKeyId && secretAccessKey);
  }

  private storeConfig(): ObjectStoreConfig {
    const { accessKeyId, secretAccessKey } = this.credentials;
    const endpoint = this.endpoint;
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new ServiceUnavailableException(
        'Attachment storage is not configured; set MINIO_ENDPOINT, MINIO_ACCESS_KEY and MINIO_SECRET_KEY',
      );
    }
    return {
      endpoint,
      region: this.config.get<string>('MINIO_REGION') ?? this.config.get<string>('S3_REGION') ?? 'us-east-1',
      bucket: this.bucket,
      accessKeyId,
      secretAccessKey,
      sessionToken: this.config.get<string>('S3_SESSION_TOKEN') ?? null,
    };
  }

  /** A URL the browser may PUT the file to, valid for a short window. */
  presignUpload(input: {
    key: string;
    contentType: string;
    expiresInSeconds?: number;
    now?: Date;
  }): { url: string; expires_at: string } {
    const now = input.now ?? new Date();
    const ttl = input.expiresInSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS;
    const url = presignS3Url({
      ...this.storeConfig(),
      method: 'PUT',
      key: input.key,
      expiresInSeconds: ttl,
      now,
      // Signed so the stored object cannot be given a different type than declared.
      headers: { 'content-type': input.contentType },
    });
    return { url, expires_at: presignExpiry(now, ttl).toISOString() };
  }

  /** A URL the browser may GET the file from, valid for a short window. */
  presignDownload(input: { key: string; expiresInSeconds?: number; now?: Date }): {
    url: string;
    expires_at: string;
  } {
    const now = input.now ?? new Date();
    const ttl = input.expiresInSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS;
    const url = presignS3Url({
      ...this.storeConfig(),
      method: 'GET',
      key: input.key,
      expiresInSeconds: ttl,
      now,
    });
    return { url, expires_at: presignExpiry(now, ttl).toISOString() };
  }
}

/**
 * The asynchronous message thread attached to an appointment.
 *
 * Same access rule as the video room: the patient and the practitioner on the
 * appointment, and nobody else. Attachments are stored by key rather than by URL,
 * so a link handed to a client always expires and a stored row never becomes a
 * permanent public pointer at a patient's document.
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly storage: ObjectStorageService,
  ) {}

  private async participantOn(appointmentId: string): Promise<{
    role: ParticipantRole;
    appointment: { id: string; patient_id: string; practitioner_id: string | null };
  }> {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, tenant_id: currentContext().tenantId, deleted_at: null },
      select: { id: true, patient_id: true, practitioner_id: true },
    });
    if (!appointment) throw new BadRequestException('Appointment not found');

    const role = participantRole(appointment, currentContext());
    if (!role) {
      throw new ForbiddenException(
        'Only the patient or the practitioner on this appointment may use its message thread',
      );
    }
    return { role, appointment };
  }

  /**
   * The thread, oldest first.
   *
   * Every attachment is re-signed on read rather than stored as a URL: the link a
   * client got yesterday is dead, and the one it gets now dies in fifteen minutes.
   */
  async thread(appointmentId: string) {
    const { role } = await this.participantOn(appointmentId);

    const rows = await this.prisma.appointmentMessage.findMany({
      where: {
        tenant_id: currentContext().tenantId,
        appointment_id: appointmentId,
        deleted_at: null,
      },
      orderBy: { created_at: 'asc' },
      take: 500,
    });

    const configured = this.storage.isConfigured;
    return {
      appointment_id: appointmentId,
      viewer_role: role,
      attachments_enabled: configured,
      messages: rows.map((message) => ({
        id: message.id,
        sender_role: message.sender_role,
        /** True when the viewer wrote it, which is all the UI needs to pick a side. */
        is_mine: message.sender_role === role,
        body: message.body,
        attachment_name: message.attachment_name,
        attachment_content_type: message.attachment_content_type,
        attachment_size_bytes: message.attachment_size_bytes,
        attachment_url:
          message.attachment_url && configured
            ? this.storage.presignDownload({ key: message.attachment_url }).url
            : null,
        read_at: message.read_at,
        created_at: message.created_at,
      })),
    };
  }

  /** Posts a message and pushes it to anyone watching the thread. */
  async send(dto: z.infer<typeof SendMessageDto>) {
    const ctx = currentContext();
    const { role } = await this.participantOn(dto.appointment_id);

    if (dto.attachment_key && dto.attachment_size_bytes !== undefined) {
      this.assertWithinLimit(dto.attachment_size_bytes);
    }

    const message = await this.prisma.appointmentMessage.create({
      data: {
        tenant_id: ctx.tenantId,
        appointment_id: dto.appointment_id,
        sender_user_id: ctx.userId,
        sender_role: role,
        body: dto.body?.trim() || null,
        // The object key, not a URL. Links are minted per read and always expire.
        attachment_url: dto.attachment_key ?? null,
        attachment_name: dto.attachment_name ?? null,
        attachment_content_type: dto.attachment_content_type ?? null,
        attachment_size_bytes: dto.attachment_size_bytes ?? null,
      },
    });

    this.realtime.emitToChannel(
      ctx.tenantId,
      `appointment:${dto.appointment_id}`,
      WS_EVENTS.MESSAGE_CREATED,
      {
        id: message.id,
        appointment_id: dto.appointment_id,
        sender_role: role,
        has_attachment: Boolean(dto.attachment_key),
        created_at: message.created_at.toISOString(),
      },
    );

    return {
      id: message.id,
      appointment_id: message.appointment_id,
      sender_role: message.sender_role,
      is_mine: true,
      body: message.body,
      attachment_name: message.attachment_name,
      attachment_content_type: message.attachment_content_type,
      attachment_size_bytes: message.attachment_size_bytes,
      attachment_url:
        message.attachment_url && this.storage.isConfigured
          ? this.storage.presignDownload({ key: message.attachment_url }).url
          : null,
      created_at: message.created_at,
    };
  }

  private assertWithinLimit(sizeBytes: number): void {
    if (sizeBytes > MAX_ATTACHMENT_BYTES) {
      throw new BadRequestException(
        `Attachments are limited to ${Math.floor(MAX_ATTACHMENT_BYTES / (1024 * 1024))} MB; this one is ${(
          sizeBytes /
          (1024 * 1024)
        ).toFixed(1)} MB`,
      );
    }
  }

  /**
   * Mints the upload URL for an attachment.
   *
   * The size is checked here, before a byte moves, so an over-large file is refused
   * by the clinic rather than by the object store after a long upload on a phone
   * connection. The key is server-chosen — a client cannot name its own object and
   * write over someone else's.
   */
  async attachmentUpload(dto: z.infer<typeof AttachmentRequestDto>) {
    const ctx = currentContext();
    await this.participantOn(dto.appointment_id);
    this.assertWithinLimit(dto.size_bytes);

    const key = attachmentObjectKey({
      tenantId: ctx.tenantId,
      appointmentId: dto.appointment_id,
      uploadId: randomUUID(),
      filename: dto.filename,
    });

    const upload = this.storage.presignUpload({ key, contentType: dto.content_type });

    return {
      object_key: key,
      upload_url: upload.url,
      expires_at: upload.expires_at,
      max_bytes: MAX_ATTACHMENT_BYTES,
      // The browser must send exactly this; it is part of what was signed.
      required_headers: { 'content-type': dto.content_type },
    };
  }

  /** Marks the other side's messages in this thread as read. */
  async markRead(dto: z.infer<typeof MarkReadDto>) {
    const ctx = currentContext();
    const { role } = await this.participantOn(dto.appointment_id);

    const result = await this.prisma.appointmentMessage.updateMany({
      where: {
        tenant_id: ctx.tenantId,
        appointment_id: dto.appointment_id,
        deleted_at: null,
        read_at: null,
        sender_role: { not: role },
      },
      data: { read_at: new Date() },
    });
    return { marked: result.count };
  }
}

@ApiTags('messages')
@Controller('messages')
export class MessagesController {
  constructor(private readonly service: MessagesService) {}

  @Get()
  @RequirePermissions('patient:read')
  @Audit({ action: 'message.thread.read', resourceType: 'AppointmentMessage', isPhi: true })
  @ApiOperation({ summary: 'The message thread for one appointment' })
  thread(@Query('appointmentId') appointmentId?: string, @Query('appointment_id') snake?: string) {
    const id = appointmentId ?? snake;
    if (!id) throw new BadRequestException('appointmentId is required');
    return this.service.thread(id);
  }

  @Post()
  @RequirePermissions('patient:read')
  @Audit({ action: 'message.send', resourceType: 'AppointmentMessage', isPhi: true })
  @ApiOperation({ summary: 'Send a message on an appointment thread' })
  send(@ZodBody(SendMessageDto) dto: z.infer<typeof SendMessageDto>) {
    return this.service.send(dto);
  }

  @Post('attachments')
  @RequirePermissions('patient:read')
  @Audit({ action: 'message.attachment.presign', resourceType: 'AppointmentMessage', isPhi: true })
  @ApiOperation({ summary: 'Presigned MinIO URL for a message attachment, 10 MB maximum' })
  attachment(@ZodBody(AttachmentRequestDto) dto: z.infer<typeof AttachmentRequestDto>) {
    return this.service.attachmentUpload(dto);
  }

  @Post('read')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Mark the other side of a thread as read' })
  markRead(@ZodBody(MarkReadDto) dto: z.infer<typeof MarkReadDto>) {
    return this.service.markRead(dto);
  }
}
