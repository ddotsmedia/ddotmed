/**
 * The video provider.
 *
 * Two implementations behind one shape: Daily.co when `DAILY_API_KEY` is set, and
 * a local mock when it is not. The mock is not a stub that throws — a developer,
 * and a demo environment, has to be able to walk the whole teleconsultation flow
 * without a vendor account, so the mock returns a working-shaped room and a token
 * the room page knows how to render.
 */
import { BadGatewayException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, randomUUID } from 'node:crypto';
import type { ParticipantRole, TeleconsultProvider } from './teleconsult';
import { isHost } from './teleconsult';

const DAILY_API_BASE = 'https://api.daily.co/v1';
const REQUEST_TIMEOUT_MS = 15_000;

export interface CreatedRoom {
  provider: TeleconsultProvider;
  room_id: string;
  room_name: string;
  room_url: string;
  expires_at: string;
}

export interface IssuedToken {
  provider: TeleconsultProvider;
  token: string;
  expires_at: string;
  is_host: boolean;
}

@Injectable()
export class VideoProviderService {
  private readonly log = new Logger(VideoProviderService.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string | undefined {
    const key = this.config.get<string>('DAILY_API_KEY');
    return key && key.trim() ? key.trim() : undefined;
  }

  /** `daily` once credentials exist, `mock` otherwise. */
  get provider(): TeleconsultProvider {
    return this.apiKey ? 'daily' : 'mock';
  }

  get isMock(): boolean {
    return this.provider === 'mock';
  }

  /** Where the browser is sent for a mock call; the room page renders it inline. */
  private get mockBaseUrl(): string {
    return (
      this.config.get<string>('TELECONSULT_MOCK_BASE_URL') ??
      this.config.get<string>('WEB_PUBLIC_URL') ??
      'http://localhost:3000'
    );
  }

  private async daily<T>(path: string, body: unknown): Promise<T> {
    const key = this.apiKey;
    if (!key) throw new ServiceUnavailableException('No video provider is configured');

    let response: Response;
    try {
      response = await fetch(`${DAILY_API_BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      this.log.error(`Daily.co unreachable at ${path}: ${(error as Error).message}`);
      throw new ServiceUnavailableException('The video provider is unavailable');
    }

    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail =
        (payload as { info?: string; error?: string }).info ??
        (payload as { error?: string }).error ??
        `Video provider returned ${response.status}`;
      this.log.warn(`Daily.co rejected ${path}: ${detail}`);
      throw new BadGatewayException(detail);
    }
    return payload as T;
  }

  /**
   * Creates — or re-creates — the room for a consultation.
   *
   * Private, and expiring at the appointment start plus the room lifetime with
   * `eject_at_room_exp`, so a link that leaks cannot become a standing open door
   * into a consulting room.
   *
   * A 400 from Daily because the name is already taken is not an error: the room
   * name is derived from the appointment id, so "already exists" means the room we
   * wanted is there, and its URL is deterministic.
   */
  async createRoom(input: { roomName: string; expiresAtUnix: number }): Promise<CreatedRoom> {
    const expiresAt = new Date(input.expiresAtUnix * 1000).toISOString();

    if (this.isMock) {
      return {
        provider: 'mock',
        room_id: input.roomName,
        room_name: input.roomName,
        room_url: `${this.mockBaseUrl.replace(/\/+$/, '')}/room/mock/${input.roomName}`,
        expires_at: expiresAt,
      };
    }

    try {
      const room = await this.daily<{ id?: string; name: string; url: string }>('/rooms', {
        name: input.roomName,
        privacy: 'private',
        properties: {
          exp: input.expiresAtUnix,
          eject_at_room_exp: true,
          enable_prejoin_ui: true,
          enable_screenshare: true,
          enable_chat: true,
          start_video_off: false,
          start_audio_off: false,
        },
      });
      return {
        provider: 'daily',
        room_id: room.id ?? room.name,
        room_name: room.name,
        room_url: room.url,
        expires_at: expiresAt,
      };
    } catch (error) {
      if (error instanceof BadGatewayException) {
        this.log.log(`Reusing existing Daily room ${input.roomName}`);
        return {
          provider: 'daily',
          room_id: input.roomName,
          room_name: input.roomName,
          room_url: this.dailyRoomUrl(input.roomName),
          expires_at: expiresAt,
        };
      }
      throw error;
    }
  }

  /** Daily room URLs are `https://<domain>.daily.co/<room>`. */
  private dailyRoomUrl(roomName: string): string {
    const domain = this.config.get<string>('DAILY_DOMAIN');
    return domain
      ? `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}/${roomName}`
      : `https://api.daily.co/v1/rooms/${roomName}`;
  }

  /**
   * A per-participant meeting token.
   *
   * The clinician gets an owner token — that is what lets them admit from the lobby
   * and end the call for everyone — and the patient a guest token. Both expire with
   * the room, so a token cannot outlive the consultation it was minted for.
   */
  async issueToken(input: {
    roomName: string;
    role: ParticipantRole;
    userName: string;
    userId: string;
    expiresAtUnix: number;
  }): Promise<IssuedToken> {
    const owner = isHost(input.role);
    const expiresAt = new Date(input.expiresAtUnix * 1000).toISOString();

    if (this.isMock) {
      return {
        provider: 'mock',
        token: this.mockToken(input),
        expires_at: expiresAt,
        is_host: owner,
      };
    }

    const issued = await this.daily<{ token: string }>('/meeting-tokens', {
      properties: {
        room_name: input.roomName,
        is_owner: owner,
        user_name: input.userName,
        user_id: input.userId,
        exp: input.expiresAtUnix,
        start_cloud_recording: false,
      },
    });
    return { provider: 'daily', token: issued.token, expires_at: expiresAt, is_host: owner };
  }

  /**
   * A development token that is at least unguessable.
   *
   * It is signed rather than random so it stays stable for one participant on one
   * room, which makes a reconnecting mock call behave like a real one. It is never
   * accepted as an authentication credential anywhere — the API always re-checks
   * the caller's own bearer token.
   */
  private mockToken(input: {
    roomName: string;
    role: ParticipantRole;
    userId: string;
    expiresAtUnix: number;
  }): string {
    const secret = this.config.get<string>('JWT_SECRET') ?? 'medicore-mock-teleconsult';
    const claim = `${input.roomName}.${input.role}.${input.userId}.${input.expiresAtUnix}`;
    const signature = createHmac('sha256', secret).update(claim).digest('base64url').slice(0, 32);
    return `mock.${Buffer.from(claim).toString('base64url')}.${signature}`;
  }

  /** A fresh opaque id, used for upload keys where no natural id exists yet. */
  newUploadId(): string {
    return randomUUID();
  }
}
