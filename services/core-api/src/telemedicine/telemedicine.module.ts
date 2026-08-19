import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Logger,
  Module,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { KAFKA_TOPICS, type TeleconsultCompletedEvent } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { KafkaService } from '../messaging/kafka.service';
import { currentContext } from '../common/tenant-context';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { VideoProviderService } from './video-provider.service';
import { MessagesController, MessagesService } from './messages.controller';
import {
  ROOM_LIFETIME_HOURS,
  billableMinutes,
  isJoinable,
  participantRole,
  roomExpiry,
  roomExpiryUnix,
  roomNameForAppointment,
  sessionDurationSeconds,
  teleconsultNoteStub,
  type ParticipantRole,
} from './teleconsult';

export const CreateRoomDto = z.preprocess(
  (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const v = value as Record<string, unknown>;
    return { ...v, appointment_id: v.appointment_id ?? v.appointmentId };
  },
  z.object({
    appointment_id: z.string().uuid(),
    /** Overrides the default two-hour room lifetime for a long consultation. */
    lifetime_hours: z.number().min(0.25).max(12).default(ROOM_LIFETIME_HOURS),
  }),
);

/** Every field is optional — hanging up sends no body at all — so an absent one parses. */
export const EndSessionDto = z.preprocess(
  (value) => value ?? {},
  z.object({
    recording_url: z.string().url().max(2048).nullable().optional(),
    /** Left unset in normal use; supplied only when a client reports a late hang-up. */
    ended_at: z.coerce.date().optional(),
  }),
);

/** What the room page needs to get a browser into a call. */
export interface JoinPayload {
  appointment_id: string;
  session_id: string;
  provider: string;
  room_id: string;
  room_url: string;
  token: string | null;
  expires_at: string;
  role: ParticipantRole | null;
  is_host: boolean;
  is_mock: boolean;
  joinable: boolean;
  starts_at: string;
}

@Injectable()
export class TelemedicineService {
  private readonly log = new Logger(TelemedicineService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly kafka: KafkaService,
    private readonly video: VideoProviderService,
  ) {}

  private async appointment(id: string) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id, tenant_id: currentContext().tenantId, deleted_at: null },
      include: {
        patient: { select: { id: true, given_names: true, family_name: true } },
        practitioner: { select: { id: true, user_id: true, given_names: true, family_name: true } },
      },
    });
    if (!appointment) throw new BadRequestException('Appointment not found');
    return appointment;
  }

  /**
   * The caller's side of the consultation, or a 403.
   *
   * A video room is a consulting room with the door shut. Being able to *see* the
   * appointment — which any receptionist can — is not being in it, so the check is
   * against the token's own `patient_id` / `practitioner_id` and nothing else.
   */
  private requireParticipant(
    appointment: { patient_id: string; practitioner_id: string | null },
    action: string,
  ): ParticipantRole {
    const ctx = currentContext();
    const role = participantRole(appointment, ctx);
    if (!role) {
      throw new ForbiddenException(
        `Only the patient or the practitioner on this appointment may ${action}`,
      );
    }
    return role;
  }

  /**
   * Provisions the video room and stamps it onto the appointment.
   *
   * Idempotent by construction: the room name is derived from the appointment id,
   * so calling this twice re-provisions the same room rather than stranding one
   * party in an empty second one.
   *
   * Front-desk staff may provision a room they will not join — that is how a
   * consultation gets set up ahead of time — but only a participant is handed a
   * token with it.
   */
  async createRoom(dto: z.infer<typeof CreateRoomDto>): Promise<JoinPayload> {
    const ctx = currentContext();
    const appointment = await this.appointment(dto.appointment_id);
    const role = participantRole(appointment, ctx);
    if (!role && !ctx.permissions.includes('patient:write')) {
      throw new ForbiddenException(
        'Only the patient, the practitioner, or scheduling staff may open a video room',
      );
    }
    if (['cancelled', 'noshow'].includes(appointment.status)) {
      throw new BadRequestException(`This appointment is ${appointment.status}`);
    }

    const roomName = roomNameForAppointment(appointment.id);
    const expiresAtUnix = roomExpiryUnix(appointment.start, dto.lifetime_hours);
    const room = await this.video.createRoom({ roomName, expiresAtUnix });

    await this.prisma.appointment.update({
      where: { id: appointment.id },
      data: {
        is_telehealth: true,
        teleconsult_url: room.room_url,
        teleconsult_room_id: room.room_id,
        teleconsult_provider: room.provider,
        // The portal has always read `telehealth_url`; keep it pointing at the room.
        telehealth_url: room.room_url,
      },
    });

    const session = await this.openSession(appointment.id, room.room_id, room.provider);
    const token = role
      ? await this.issueToken(appointment, role, roomName, expiresAtUnix)
      : null;

    return {
      appointment_id: appointment.id,
      session_id: session.id,
      provider: room.provider,
      room_id: room.room_id,
      room_url: room.room_url,
      token: token?.token ?? null,
      expires_at: room.expires_at,
      role,
      is_host: token?.is_host ?? false,
      is_mock: this.video.isMock,
      joinable: isJoinable(appointment.start, new Date(), dto.lifetime_hours),
      starts_at: appointment.start.toISOString(),
    };
  }

  /**
   * Hands a participant the token that gets them into the room.
   *
   * The room is created on demand when it does not exist yet, so a patient who
   * opens the link before anyone has provisioned anything still gets in rather than
   * being told to call the clinic.
   */
  async joinToken(appointmentId: string): Promise<JoinPayload> {
    const appointment = await this.appointment(appointmentId);
    const role = this.requireParticipant(appointment, 'join this consultation');

    if (['cancelled', 'noshow'].includes(appointment.status)) {
      throw new BadRequestException(`This appointment is ${appointment.status}`);
    }

    const roomName = roomNameForAppointment(appointment.id);
    const expiresAtUnix = roomExpiryUnix(appointment.start);
    const expiresAt = roomExpiry(appointment.start).toISOString();

    let roomUrl = appointment.teleconsult_url;
    let roomId = appointment.teleconsult_room_id;
    let provider = appointment.teleconsult_provider;

    if (!roomUrl || !roomId || provider !== this.video.provider) {
      const room = await this.video.createRoom({ roomName, expiresAtUnix });
      await this.prisma.appointment.update({
        where: { id: appointment.id },
        data: {
          is_telehealth: true,
          teleconsult_url: room.room_url,
          teleconsult_room_id: room.room_id,
          teleconsult_provider: room.provider,
          telehealth_url: room.room_url,
        },
      });
      roomUrl = room.room_url;
      roomId = room.room_id;
      provider = room.provider;
    }

    const token = await this.issueToken(appointment, role, roomName, expiresAtUnix);
    const session = await this.openSession(appointment.id, roomId, provider ?? 'mock');

    return {
      appointment_id: appointment.id,
      session_id: session.id,
      provider: provider ?? 'mock',
      room_id: roomId,
      room_url: roomUrl,
      token: token.token,
      expires_at: expiresAt,
      role,
      is_host: token.is_host,
      is_mock: this.video.isMock,
      joinable: isJoinable(appointment.start, new Date()),
      starts_at: appointment.start.toISOString(),
    };
  }

  private issueToken(
    appointment: {
      id: string;
      patient: { given_names: string[]; family_name: string };
      practitioner: { given_names: string[]; family_name: string } | null;
    },
    role: ParticipantRole,
    roomName: string,
    expiresAtUnix: number,
  ) {
    const ctx = currentContext();
    const person = role === 'patient' ? appointment.patient : appointment.practitioner;
    const userName = person
      ? [...person.given_names, person.family_name].filter(Boolean).join(' ')
      : role;

    return this.video.issueToken({
      roomName,
      role,
      userName: role === 'practitioner' ? `Dr ${userName}` : userName,
      userId: ctx.userId ?? appointment.id,
      expiresAtUnix,
    });
  }

  /**
   * Reuses the open session for this appointment, or starts one.
   *
   * Both participants join the same row so the recorded duration is the length of
   * the consultation, not the sum of two people's screen time.
   */
  private async openSession(appointmentId: string, roomId: string, provider: string) {
    const tenantId = currentContext().tenantId;
    const open = await this.prisma.teleconsultSession.findFirst({
      where: { tenant_id: tenantId, appointment_id: appointmentId, ended_at: null },
      orderBy: { started_at: 'desc' },
    });
    if (open) return open;

    return this.prisma.teleconsultSession.create({
      data: {
        tenant_id: tenantId,
        appointment_id: appointmentId,
        room_id: roomId,
        provider,
      },
    });
  }

  /**
   * Ends the call: closes the session, leaves a note stub for the clinician, and
   * tells billing.
   *
   * The note is written before the event is published. A charge for a consultation
   * with no chart entry behind it is the thing an auditor finds, and the ordering
   * here is what stops it.
   */
  async endSession(sessionId: string, dto: z.infer<typeof EndSessionDto>) {
    const ctx = currentContext();
    const session = await this.prisma.teleconsultSession.findFirst({
      where: { id: sessionId, tenant_id: ctx.tenantId },
    });
    if (!session) throw new BadRequestException('Teleconsult session not found');

    const appointment = await this.appointment(session.appointment_id);
    this.requireParticipant(appointment, 'end this consultation');

    if (session.ended_at) {
      // Both sides hanging up is normal; the first one to land owns the duration.
      return {
        session,
        encounter_id: null,
        note_id: null,
        duration_seconds: session.duration_seconds ?? 0,
        already_ended: true,
      };
    }

    const endedAt = dto.ended_at ?? new Date();
    const durationSeconds = sessionDurationSeconds(session.started_at, endedAt);

    const closed = await this.prisma.teleconsultSession.update({
      where: { id: session.id },
      data: {
        ended_at: endedAt,
        duration_seconds: durationSeconds,
        recording_url: dto.recording_url ?? session.recording_url,
      },
    });

    const { encounterId, noteId } = await this.writeNoteStub({
      appointment,
      session: closed,
      endedAt,
      durationSeconds,
    });

    const event: TeleconsultCompletedEvent = {
      tenant_id: ctx.tenantId,
      event: 'teleconsult_completed',
      session_id: closed.id,
      appointment_id: appointment.id,
      patient_id: appointment.patient_id,
      practitioner_id: appointment.practitioner_id,
      encounter_id: encounterId,
      provider: closed.provider,
      room_id: closed.room_id,
      started_at: closed.started_at.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_seconds: durationSeconds,
      billable_minutes: billableMinutes(durationSeconds),
      occurred_at: new Date().toISOString(),
    };
    await this.kafka.emit(KAFKA_TOPICS.BILLING, ctx.tenantId, event);

    return {
      session: closed,
      encounter_id: encounterId,
      note_id: noteId,
      duration_seconds: durationSeconds,
      billable_minutes: billableMinutes(durationSeconds),
      already_ended: false,
    };
  }

  /**
   * Opens the virtual encounter if the consultation never had one, and files the
   * stub note against it.
   *
   * Authorship follows the clinician, not whoever pressed "end call" — a patient
   * hanging up must not put their name on a chart entry. When no clinician can be
   * resolved the note is skipped rather than misattributed; the session and the
   * billing event still stand on their own.
   */
  private async writeNoteStub(input: {
    appointment: {
      id: string;
      patient_id: string;
      practitioner_id: string | null;
      location_id: string | null;
      service_type: string;
      start: Date;
      practitioner: { user_id: string | null } | null;
    };
    session: { provider: string; started_at: Date };
    endedAt: Date;
    durationSeconds: number;
  }): Promise<{ encounterId: string | null; noteId: string | null }> {
    const ctx = currentContext();
    const { appointment } = input;

    const authorId = appointment.practitioner?.user_id ?? null;

    const existing = await this.prisma.encounter.findFirst({
      where: { tenant_id: ctx.tenantId, appointment_id: appointment.id, deleted_at: null },
      orderBy: { period_start: 'desc' },
      select: { id: true },
    });

    const encounter =
      existing ??
      (await this.prisma.encounter.create({
        data: {
          tenant_id: ctx.tenantId,
          patient_id: appointment.patient_id,
          practitioner_id: appointment.practitioner_id,
          location_id: appointment.location_id,
          appointment_id: appointment.id,
          status: 'finished',
          // VR is the FHIR class for a virtual encounter; an in-person AMB here
          // would misreport every teleconsultation in the activity returns.
          class: 'VR',
          type_display: appointment.service_type,
          period_start: input.session.started_at,
          period_end: input.endedAt,
        },
        select: { id: true },
      }));

    if (!authorId) {
      this.log.warn(
        `No clinician account on appointment ${appointment.id}; teleconsult note stub not written`,
      );
      return { encounterId: encounter.id, noteId: null };
    }

    const note = await this.prisma.clinicalNote.create({
      data: {
        tenant_id: ctx.tenantId,
        patient_id: appointment.patient_id,
        encounter_id: encounter.id,
        author_id: authorId,
        type: 'progress',
        // A draft, deliberately: nothing here has been reviewed by a clinician yet.
        status: 'draft',
        body: teleconsultNoteStub({
          provider: input.session.provider,
          startedAt: input.session.started_at,
          endedAt: input.endedAt,
          durationSeconds: input.durationSeconds,
        }),
      },
      select: { id: true },
    });

    return { encounterId: encounter.id, noteId: note.id };
  }

  /** Every session recorded against one appointment, newest first. */
  async sessionsFor(appointmentId: string) {
    const appointment = await this.appointment(appointmentId);
    this.requireParticipant(appointment, 'read this consultation');
    return this.prisma.teleconsultSession.findMany({
      where: { tenant_id: currentContext().tenantId, appointment_id: appointmentId },
      orderBy: { started_at: 'desc' },
      take: 50,
    });
  }
}

@ApiTags('telemedicine')
@Controller('telemedicine')
export class TelemedicineController {
  constructor(private readonly service: TelemedicineService) {}

  @Post('rooms')
  @RequirePermissions('patient:read')
  @Audit({ action: 'teleconsult.room.create', resourceType: 'Appointment', isPhi: true })
  @ApiOperation({ summary: 'Create the private video room for an appointment' })
  createRoom(@ZodBody(CreateRoomDto) dto: z.infer<typeof CreateRoomDto>) {
    return this.service.createRoom(dto);
  }

  @Get('token')
  @RequirePermissions('patient:read')
  @Audit({ action: 'teleconsult.token.issue', resourceType: 'Appointment', isPhi: true })
  @ApiOperation({ summary: 'Join token for the patient or practitioner on the appointment' })
  token(@Query('appointmentId') appointmentId?: string, @Query('appointment_id') snake?: string) {
    const id = appointmentId ?? snake;
    if (!id) throw new BadRequestException('appointmentId is required');
    return this.service.joinToken(id);
  }

  @Post('sessions/:id/end')
  @RequirePermissions('patient:read')
  @Audit({ action: 'teleconsult.session.end', resourceType: 'TeleconsultSession', isPhi: true })
  @ApiOperation({ summary: 'End the call, record its duration and open a note stub' })
  end(
    @Param('id', ParseUUIDPipe) id: string,
    @ZodBody(EndSessionDto) dto: z.infer<typeof EndSessionDto>,
  ) {
    return this.service.endSession(id, dto);
  }

  @Get('sessions')
  @RequirePermissions('patient:read')
  @ApiOperation({ summary: 'Sessions recorded against an appointment' })
  sessions(@Query('appointmentId') appointmentId?: string, @Query('appointment_id') snake?: string) {
    const id = appointmentId ?? snake;
    if (!id) throw new BadRequestException('appointmentId is required');
    return this.service.sessionsFor(id);
  }
}

@Module({
  controllers: [TelemedicineController, MessagesController],
  providers: [TelemedicineService, VideoProviderService, MessagesService],
  exports: [TelemedicineService, MessagesService],
})
export class TelemedicineModule {}
