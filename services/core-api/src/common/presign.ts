/**
 * Presigned MinIO (S3) URLs, signed with AWS Signature Version 4.
 *
 * Implemented here rather than pulled in as an SDK for two reasons: the whole of
 * what this service needs is one signed PUT and one signed GET, and a signature is
 * something that has to be verifiable by reading it — a bad canonical request fails
 * as an opaque 403 from the object store, which is a miserable thing to debug.
 *
 * Path-style addressing throughout (`/bucket/key`), because MinIO is reached by
 * hostname on the compose network and virtual-host style would need DNS per bucket.
 *
 * Reference: AWS SigV4 query-parameter authentication.
 */
import { createHash, createHmac } from 'node:crypto';

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
/** Query-signed requests never hash a body; the payload is declared unsigned. */
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

/** The hard ceiling on a message attachment: 10 MB. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/** How long an upload or download link stays valid, in seconds. */
export const DEFAULT_PRESIGN_TTL_SECONDS = 15 * 60;

/** S3 refuses anything over seven days. */
export const MAX_PRESIGN_TTL_SECONDS = 7 * 24 * 3600;

export interface ObjectStoreConfig {
  /** Base endpoint, e.g. `http://minio:9000`. */
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Optional STS token; included as X-Amz-Security-Token when present. */
  sessionToken?: string | null;
}

export interface PresignInput extends ObjectStoreConfig {
  method: 'GET' | 'PUT' | 'HEAD';
  key: string;
  expiresInSeconds?: number;
  now?: Date;
  /** Extra headers that must be signed, e.g. `content-type` on an upload. */
  headers?: Record<string, string>;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value, 'utf8').digest();
}

/**
 * RFC 3986 percent-encoding.
 *
 * `encodeURIComponent` is not enough: it leaves `!`, `'`, `(`, `)` and `*` alone,
 * and S3 expects those encoded. A single mismatched byte here and the signature
 * simply does not match.
 */
export function uriEncode(value: string, encodeSlash = true): string {
  let out = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const char = String.fromCharCode(byte);
    if (
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      (byte >= 0x30 && byte <= 0x39)
    ) {
      out += char;
    } else if (char === '-' || char === '_' || char === '.' || char === '~') {
      out += char;
    } else if (char === '/') {
      out += encodeSlash ? '%2F' : '/';
    } else {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
  }
  return out;
}

/** `20260810T091500Z` — the basic-format ISO 8601 stamp SigV4 uses. */
export function amzDate(now: Date): string {
  return `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
}

/** `20260810` — the date half of the credential scope. */
export function amzDateStamp(now: Date): string {
  return amzDate(now).slice(0, 8);
}

function signingKey(secret: string, dateStamp: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, SERVICE);
  return hmac(kService, 'aws4_request');
}

/**
 * Builds a presigned URL that anyone holding it may use until it expires.
 *
 * The URL carries the credential in the query string, so it has to be treated as a
 * bearer token for that one object: handed to the uploading browser and never
 * logged.
 */
export function presignS3Url(input: PresignInput): string {
  const now = input.now ?? new Date();
  const expires = Math.min(
    Math.max(1, Math.floor(input.expiresInSeconds ?? DEFAULT_PRESIGN_TTL_SECONDS)),
    MAX_PRESIGN_TTL_SECONDS,
  );

  const endpoint = new URL(input.endpoint);
  // `host` keeps the port when there is one, which MinIO always has.
  const host = endpoint.host;
  const stamp = amzDate(now);
  const dateStamp = stamp.slice(0, 8);
  const scope = `${dateStamp}/${input.region}/${SERVICE}/aws4_request`;

  const basePath = endpoint.pathname.replace(/\/+$/, '');
  const canonicalUri = `${basePath}/${uriEncode(input.bucket)}/${uriEncode(input.key, false)}`;

  const signedHeaderEntries = Object.entries({ host, ...(input.headers ?? {}) })
    .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const signedHeaders = signedHeaderEntries.map(([name]) => name).join(';');
  const canonicalHeaders = signedHeaderEntries.map(([n, v]) => `${n}:${v}\n`).join('');

  const query: Record<string, string> = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${input.accessKeyId}/${scope}`,
    'X-Amz-Date': stamp,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': signedHeaders,
    ...(input.sessionToken ? { 'X-Amz-Security-Token': input.sessionToken } : {}),
  };

  // The canonical query string is sorted by encoded key, and both halves encoded.
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(query[k])}`)
    .join('&');

  const canonicalRequest = [
    input.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, stamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = hmac(
    signingKey(input.secretAccessKey, dateStamp, input.region),
    stringToSign,
  ).toString('hex');

  return `${endpoint.origin}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** The instant a URL signed at `now` for `ttl` seconds stops working. */
export function presignExpiry(now: Date, expiresInSeconds: number): Date {
  return new Date(now.getTime() + expiresInSeconds * 1000);
}

/**
 * Strips a client-supplied filename down to something safe to put in a key.
 *
 * Path separators and `..` are removed, so an attachment named `../../etc/passwd`
 * lands as `etc-passwd` inside its own prefix rather than anywhere else in the
 * bucket. Everything outside the allowed set — control characters included —
 * becomes a dash.
 */
export function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'file';
  const cleaned = base
    .replace(/\.{2,}/g, '.')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 120);
  return cleaned || 'file';
}

/**
 * Where a message attachment lives.
 *
 * Tenant first so a bucket policy can be written per tenant, then the appointment,
 * so an entire consultation's attachments can be listed or expired as one prefix.
 */
export function attachmentObjectKey(input: {
  tenantId: string;
  appointmentId: string;
  uploadId: string;
  filename: string;
}): string {
  return [
    'tenants',
    input.tenantId,
    'appointments',
    input.appointmentId,
    'messages',
    `${input.uploadId}-${safeFilename(input.filename)}`,
  ].join('/');
}
