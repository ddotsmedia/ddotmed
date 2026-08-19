/**
 * MinIO, reached over presigned URLs.
 *
 * Nothing large passes through this service: the browser PUTs a message
 * attachment straight to the object store and GETs it straight back, and an
 * exported report is written once and handed over as a link. A 10 MB file through
 * a Node process is 10 MB of heap and a request that blocks a clinical write
 * behind it.
 *
 * Every method degrades honestly when the store is unconfigured — `isConfigured`
 * is false and the callers offer the inline path instead of pretending.
 */
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEFAULT_PRESIGN_TTL_SECONDS,
  presignExpiry,
  presignS3Url,
  type ObjectStoreConfig,
} from './presign';

@Injectable()
export class ObjectStorageService {
  private readonly log = new Logger(ObjectStorageService.name);

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

  /** The endpoint this *service* uses to write. Falls back to the public one. */
  private get internalEndpoint(): string | undefined {
    return (
      this.config.get<string>('MINIO_ENDPOINT') ??
      this.config.get<string>('S3_ENDPOINT') ??
      this.endpoint
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

  private storeConfig(endpoint: string | undefined): ObjectStoreConfig {
    const { accessKeyId, secretAccessKey } = this.credentials;
    if (!endpoint || !accessKeyId || !secretAccessKey) {
      throw new ServiceUnavailableException(
        'Object storage is not configured; set MINIO_ENDPOINT, MINIO_ACCESS_KEY and MINIO_SECRET_KEY',
      );
    }
    return {
      endpoint,
      region:
        this.config.get<string>('MINIO_REGION') ?? this.config.get<string>('S3_REGION') ?? 'us-east-1',
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
      ...this.storeConfig(this.endpoint),
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
      ...this.storeConfig(this.endpoint),
      method: 'GET',
      key: input.key,
      expiresInSeconds: ttl,
      now,
    });
    return { url, expires_at: presignExpiry(now, ttl).toISOString() };
  }

  /**
   * Writes an object from this service and returns a download link for it.
   *
   * Used by report export, where the file is generated server-side. Returns null
   * rather than throwing when the store is unreachable — an export that cannot be
   * parked in MinIO is still perfectly deliverable inline, and failing the whole
   * request over a storage outage would be the wrong trade.
   */
  async putObject(input: {
    key: string;
    body: string | Buffer;
    contentType: string;
    downloadTtlSeconds?: number;
  }): Promise<{ url: string; expires_at: string; key: string } | null> {
    if (!this.isConfigured) return null;

    const now = new Date();
    try {
      const target = presignS3Url({
        ...this.storeConfig(this.internalEndpoint),
        method: 'PUT',
        key: input.key,
        expiresInSeconds: 300,
        now,
        headers: { 'content-type': input.contentType },
      });

      const response = await fetch(target, {
        method: 'PUT',
        headers: { 'content-type': input.contentType },
        body: input.body,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        this.log.warn(`Object store rejected ${input.key}: ${response.status}`);
        return null;
      }

      const link = this.presignDownload({
        key: input.key,
        expiresInSeconds: input.downloadTtlSeconds,
        now,
      });
      return { ...link, key: input.key };
    } catch (error) {
      this.log.warn(`Object store unreachable for ${input.key}: ${(error as Error).message}`);
      return null;
    }
  }
}
