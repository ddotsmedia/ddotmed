/**
 * Presigned MinIO URLs.
 *
 * The cross-check in `signature` re-walks the SigV4 steps from the specification
 * inside the test rather than reusing the module's own helpers. That catches drift
 * in how the canonical request is assembled — the failure mode that shows up as an
 * unexplained 403 from the object store — though it cannot catch a misreading of
 * the specification shared by both. Everything else here is a property the store
 * enforces directly: the credential scope, the signed headers, the expiry.
 */
import { createHash, createHmac } from 'node:crypto';
import {
  DEFAULT_PRESIGN_TTL_SECONDS,
  MAX_ATTACHMENT_BYTES,
  MAX_PRESIGN_TTL_SECONDS,
  amzDate,
  amzDateStamp,
  attachmentObjectKey,
  presignExpiry,
  presignS3Url,
  safeFilename,
  uriEncode,
} from './presign';

const NOW = new Date('2026-08-10T09:15:00.000Z');
const TENANT_ID = '0193c3f0-0000-7000-8000-00000000t001'.replace('t', '0');
const APPOINTMENT_ID = '0193c3f0-0000-7000-8000-0000000000a1';

const store = {
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'medicore-attachments',
  accessKeyId: 'medicore',
  secretAccessKey: 'medicore_dev_secret',
};

const params = (url: string) => new URL(url).searchParams;

describe('uriEncode', () => {
  it('leaves the RFC 3986 unreserved set alone', () => {
    expect(uriEncode('AZaz09-_.~')).toBe('AZaz09-_.~');
  });

  it('encodes the characters encodeURIComponent would not', () => {
    expect(uriEncode("!*'()")).toBe('%21%2A%27%28%29');
  });

  it('encodes a slash in a query value but keeps it in a path', () => {
    expect(uriEncode('a/b')).toBe('a%2Fb');
    expect(uriEncode('a/b', false)).toBe('a/b');
  });

  it('encodes non-ASCII byte by byte as UTF-8', () => {
    expect(uriEncode('é')).toBe('%C3%A9');
  });

  it('encodes a space as %20, never as a plus', () => {
    expect(uriEncode('a b')).toBe('a%20b');
  });
});

describe('amzDate', () => {
  it('renders the basic-format stamp SigV4 expects', () => {
    expect(amzDate(NOW)).toBe('20260810T091500Z');
    expect(amzDateStamp(NOW)).toBe('20260810');
  });
});

describe('presignS3Url', () => {
  const upload = () =>
    presignS3Url({
      ...store,
      method: 'PUT',
      key: 'tenants/t1/appointments/a1/messages/u1-scan.pdf',
      expiresInSeconds: 900,
      now: NOW,
      headers: { 'content-type': 'application/pdf' },
    });

  it('addresses the object path-style, on the endpoint host', () => {
    const url = new URL(upload());
    expect(url.origin).toBe('http://localhost:9000');
    expect(url.pathname).toBe(
      '/medicore-attachments/tenants/t1/appointments/a1/messages/u1-scan.pdf',
    );
  });

  it('carries the algorithm, credential scope, stamp and expiry', () => {
    const q = params(upload());
    expect(q.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(q.get('X-Amz-Credential')).toBe('medicore/20260810/us-east-1/s3/aws4_request');
    expect(q.get('X-Amz-Date')).toBe('20260810T091500Z');
    expect(q.get('X-Amz-Expires')).toBe('900');
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('signs the content type on an upload, so the stored type cannot be swapped', () => {
    expect(params(upload()).get('X-Amz-SignedHeaders')).toBe('content-type;host');
  });

  it('signs only the host on a download', () => {
    const q = params(
      presignS3Url({ ...store, method: 'GET', key: 'tenants/t1/x.pdf', now: NOW }),
    );
    expect(q.get('X-Amz-SignedHeaders')).toBe('host');
    expect(q.get('X-Amz-Expires')).toBe(String(DEFAULT_PRESIGN_TTL_SECONDS));
  });

  it('never puts the signature inside the signed query string', () => {
    // X-Amz-Signature is appended after signing; including it would be circular.
    const url = upload();
    expect(url.indexOf('X-Amz-Signature')).toBe(url.lastIndexOf('X-Amz-Signature'));
  });

  it('is deterministic for the same request', () => {
    expect(upload()).toBe(upload());
  });

  it.each([
    ['a different key', { key: 'tenants/t1/other.pdf' }],
    ['a different method', { method: 'GET' as const }],
    ['a different expiry', { expiresInSeconds: 60 }],
    ['a different secret', { secretAccessKey: 'not-the-secret' }],
    ['a different bucket', { bucket: 'other-bucket' }],
  ])('produces a different signature for %s', (_label, override) => {
    const changed = presignS3Url({
      ...store,
      method: 'PUT',
      key: 'tenants/t1/appointments/a1/messages/u1-scan.pdf',
      expiresInSeconds: 900,
      now: NOW,
      headers: { 'content-type': 'application/pdf' },
      ...override,
    });
    expect(params(changed).get('X-Amz-Signature')).not.toBe(
      params(upload()).get('X-Amz-Signature'),
    );
  });

  it('percent-encodes a space in the key rather than leaving it raw', () => {
    const url = presignS3Url({ ...store, method: 'GET', key: 'tenants/t1/lab report.pdf', now: NOW });
    expect(url).toContain('lab%20report.pdf');
  });

  it('clamps an absurd expiry to the seven days S3 allows', () => {
    const q = params(
      presignS3Url({ ...store, method: 'GET', key: 'k', expiresInSeconds: 999_999_999, now: NOW }),
    );
    expect(q.get('X-Amz-Expires')).toBe(String(MAX_PRESIGN_TTL_SECONDS));
  });

  it('matches a signature derived independently from the SigV4 steps', () => {
    const key = 'tenants/t1/appointments/a1/messages/u1-scan.pdf';
    const stamp = '20260810T091500Z';
    const scope = '20260810/us-east-1/s3/aws4_request';

    const query = [
      `X-Amz-Algorithm=${uriEncode('AWS4-HMAC-SHA256')}`,
      `X-Amz-Credential=${uriEncode(`medicore/${scope}`)}`,
      `X-Amz-Date=${stamp}`,
      'X-Amz-Expires=900',
      `X-Amz-SignedHeaders=${uriEncode('content-type;host')}`,
    ].join('&');

    const canonicalRequest = [
      'PUT',
      `/medicore-attachments/${key}`,
      query,
      'content-type:application/pdf\nhost:localhost:9000\n',
      'content-type;host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      stamp,
      scope,
      createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
    ].join('\n');

    const sign = (k: Buffer | string, v: string) =>
      createHmac('sha256', k).update(v, 'utf8').digest();
    const signature = sign(
      sign(sign(sign(sign(`AWS4${store.secretAccessKey}`, '20260810'), 'us-east-1'), 's3'), 'aws4_request'),
      stringToSign,
    ).toString('hex');

    expect(params(upload()).get('X-Amz-Signature')).toBe(signature);
  });
});

describe('presignExpiry', () => {
  it('reports when the link dies', () => {
    expect(presignExpiry(NOW, 900).toISOString()).toBe('2026-08-10T09:30:00.000Z');
  });
});

describe('safeFilename', () => {
  it('keeps an ordinary name intact', () => {
    expect(safeFilename('blood-panel_2026.pdf')).toBe('blood-panel_2026.pdf');
  });

  it('strips a traversal attempt down to its last segment', () => {
    expect(safeFilename('../../etc/passwd')).toBe('passwd');
    expect(safeFilename('..\\..\\windows\\system32\\config')).toBe('config');
  });

  it('collapses a doubled dot so no traversal survives', () => {
    expect(safeFilename('report..pdf')).toBe('report.pdf');
  });

  it('replaces anything outside the allowed set', () => {
    expect(safeFilename('scan résultat (1).png')).toBe('scan-r-sultat--1-.png');
  });

  it('never returns an empty name', () => {
    expect(safeFilename('...')).toBe('file');
    expect(safeFilename('')).toBe('file');
  });
});

describe('attachmentObjectKey', () => {
  it('files the object under its tenant and appointment', () => {
    const key = attachmentObjectKey({
      tenantId: TENANT_ID,
      appointmentId: APPOINTMENT_ID,
      uploadId: 'u1',
      filename: 'scan.pdf',
    });
    expect(key).toBe(
      `tenants/${TENANT_ID}/appointments/${APPOINTMENT_ID}/messages/u1-scan.pdf`,
    );
  });

  it('cannot be walked out of its own prefix by a hostile filename', () => {
    const key = attachmentObjectKey({
      tenantId: TENANT_ID,
      appointmentId: APPOINTMENT_ID,
      uploadId: 'u1',
      filename: '../../../other-tenant/secret.pdf',
    });
    expect(key).toContain(`tenants/${TENANT_ID}/appointments/${APPOINTMENT_ID}/messages/`);
    expect(key).not.toContain('..');
  });
});

describe('MAX_ATTACHMENT_BYTES', () => {
  it('is the 10 MB the messaging screen advertises', () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(10 * 1024 * 1024);
  });
});
