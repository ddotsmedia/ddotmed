import {
  BadGatewayException,
  Controller,
  Injectable,
  Logger,
  Module,
  Post,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Audit, RequirePermissions } from '../common/decorators';
import { ZodBody } from '../common/zod.pipe';
import { currentContext } from '../common/tenant-context';
import { toScribeDraft, publicStreamUrl, type ScribeDraft } from './scribe-draft';

export const ScribeStartDto = z.object({
  patient_id: z.string().uuid(),
  encounter_id: z.string().uuid().nullable().optional(),
  language: z.string().min(2).max(10).default('en'),
  /** Ambient recording without recorded consent is not a feature, it is a breach. */
  consent_obtained: z.literal(true),
});

export const ScribeFinaliseDto = z.object({
  session_id: z.string().min(1),
  language: z.string().min(2).max(10).optional(),
});

export interface ScribeSession {
  session_id: string;
  websocket_url: string;
  sample_rate: number;
  expires_at: string;
}

/**
 * Fronts the Python AI service so clinical clients only ever talk to one origin,
 * with one token and one audit trail. The heavy lifting — Whisper, Haiku — stays
 * where the models are; this hands over identity and normalises the contract.
 *
 * Calls go out as the caller, not as a shared service account, so the AI service
 * can refuse work the clinician themselves would not be allowed to do.
 */
@Injectable()
export class AiClient {
  private readonly log = new Logger(AiClient.name);

  constructor(private readonly config: ConfigService) {}

  get baseUrl(): string {
    return (this.config.get<string>('AI_SERVICE_URL') ?? 'http://ai-service:8000').replace(/\/+$/, '');
  }

  /** Where a browser should open the audio socket. Defaults to the service itself. */
  get publicBase(): string {
    return (this.config.get<string>('AI_SERVICE_PUBLIC_URL') ?? this.baseUrl).replace(/\/+$/, '');
  }

  get model(): string {
    return this.config.get<string>('ANTHROPIC_MODEL') ?? 'claude-haiku-4-5';
  }

  private get timeoutMs(): number {
    return Number(this.config.get<string>('AI_REQUEST_TIMEOUT_MS') ?? 120_000);
  }

  async post(path: string, body: unknown): Promise<unknown> {
    const token = currentContext().accessToken;
    if (!token) {
      throw new ServiceUnavailableException('No caller token available to reach the AI service');
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      this.log.error(`AI service unreachable at ${path}: ${(error as Error).message}`);
      throw new ServiceUnavailableException('The AI service is unavailable');
    }

    const payload: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail =
        (payload as { detail?: string }).detail ?? `AI service returned ${response.status}`;
      this.log.warn(`AI service rejected ${path}: ${detail}`);
      throw new BadGatewayException(detail);
    }
    return payload;
  }
}

@Injectable()
export class AiScribeService {
  constructor(private readonly ai: AiClient) {}

  private get publicBase(): string {
    return this.ai.publicBase;
  }

  private get model(): string {
    return this.ai.model;
  }

  private call(path: string, body: unknown): Promise<unknown> {
    return this.ai.post(path, body);
  }

  async start(dto: z.infer<typeof ScribeStartDto>): Promise<ScribeSession> {
    const raw = (await this.call('/ai/scribe/start', dto)) as Partial<ScribeSession>;
    const sessionId = String(raw.session_id ?? '');
    return {
      session_id: sessionId,
      websocket_url: publicStreamUrl(sessionId, `${this.publicBase}/ai`),
      sample_rate: Number(raw.sample_rate ?? 16_000),
      expires_at: String(raw.expires_at ?? ''),
    };
  }

  async finalise(dto: z.infer<typeof ScribeFinaliseDto>): Promise<ScribeDraft> {
    const raw = await this.call('/ai/scribe/finalise', dto);
    return toScribeDraft(raw, this.model);
  }
}

@ApiTags('ai')
@Controller('ai')
export class AiController {
  constructor(private readonly service: AiScribeService) {}

  @Post('scribe/start')
  @RequirePermissions('ai:use')
  @Audit({ action: 'ai.scribe.start', resourceType: 'AiSession', isPhi: true })
  @ApiOperation({ summary: 'Open an ambient scribe session and get its audio socket' })
  start(@ZodBody(ScribeStartDto) dto: z.infer<typeof ScribeStartDto>) {
    return this.service.start(dto);
  }

  @Post('scribe/finalise')
  @RequirePermissions('ai:use')
  @Audit({ action: 'ai.scribe.finalise', resourceType: 'AiSession', isPhi: true })
  @ApiOperation({ summary: 'Transcribe the session and draft a SOAP note for approval' })
  finalise(@ZodBody(ScribeFinaliseDto) dto: z.infer<typeof ScribeFinaliseDto>) {
    return this.service.finalise(dto);
  }
}

@Module({
  controllers: [AiController],
  providers: [AiClient, AiScribeService],
  exports: [AiClient, AiScribeService],
})
export class AiModule {}
