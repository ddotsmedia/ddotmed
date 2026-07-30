import type { Paginated } from '@medicore/shared-types';

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
    readonly body: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /**
   * A deliberate clinical block from the server, not a transport failure.
   *
   * 422 is an absolute refusal — a high-criticality allergy, a contraindicated
   * pair — and 409 is a warning the clinician may override with a documented
   * reason. Both are decisions, not errors, and the UI renders them as such.
   */
  get isClinicalBlock(): boolean {
    return (
      (this.status === 409 || this.status === 422 || this.status === 400) &&
      typeof this.code === 'string' &&
      [
        'ALLERGY_CONTRAINDICATION',
        'DRUG_INTERACTION',
        'WRONG_PATIENT',
        'FIVE_RIGHTS_FAILED',
        'ALLERGY_WARNING_UNACKNOWLEDGED',
        'INSUFFICIENT_STOCK',
        'WITNESS_REQUIRED',
        'QUANTITY_EXCEEDS_PRESCRIPTION',
      ].includes(this.code)
    );
  }

  /** True when the block can be passed with a documented reason. */
  get isOverridable(): boolean {
    return (
      this.isClinicalBlock &&
      this.status === 409 &&
      (this.body as { override_allowed?: boolean } | null)?.override_allowed === true
    );
  }

  /** True once refreshing has been attempted and the session is genuinely over. */
  get isSessionExpired(): boolean {
    return this.status === 401;
  }
}

// ── token storage ─────────────────────────────────────────────────────────────
// The access token lives in memory only. It is never written to localStorage or
// sessionStorage, so an XSS payload cannot exfiltrate it by reading storage.
// The refresh token is an httpOnly cookie the browser holds and JS cannot read.

let accessToken: string | null = null;
let onSessionLost: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function setSessionLostHandler(handler: (() => void) | null): void {
  onSessionLost = handler;
}

// ── single-flight refresh ─────────────────────────────────────────────────────
// Several queries can 401 at the same moment when a token expires. Without
// coordination each would fire its own refresh, and because the server rotates
// refresh tokens every request after the first would present a burned token and
// log the user out. One shared promise means exactly one refresh happens.

let refreshInFlight: Promise<boolean> | null = null;

async function performRefresh(): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Required for the browser to send the httpOnly refresh cookie.
      credentials: 'include',
      body: JSON.stringify({}),
    });
    if (!response.ok) return false;

    const payload = (await response.json()) as { access_token?: string };
    if (!payload.access_token) return false;

    setAccessToken(payload.access_token);
    return true;
  } catch {
    return false;
  }
}

export function refreshSession(): Promise<boolean> {
  refreshInFlight ??= performRefresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

// ── request ───────────────────────────────────────────────────────────────────

export interface RequestOptions extends Omit<RequestInit, 'body'> {
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  /** Internal: prevents a refreshed request from recursing if it 401s again. */
  _isRetry?: boolean;
  /** Opt out of the refresh dance, e.g. for the login call itself. */
  skipAuthRefresh?: boolean;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  const origin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const url = new URL(`${API_BASE}${path}`, origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

export async function apiFetch<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { body, query, headers, _isRetry, skipAuthRefresh, ...rest } = options;

  const response = await fetch(buildUrl(path, query), {
    ...rest,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  if (response.status === 401 && !_isRetry && !skipAuthRefresh) {
    const refreshed = await refreshSession();
    if (refreshed) {
      // Replay the original request once, now with the new access token.
      return apiFetch<T>(path, { ...options, _isRetry: true });
    }
    // Refresh genuinely failed: the session is over.
    setAccessToken(null);
    onSessionLost?.();
    throw new ApiError(401, 'SESSION_EXPIRED', 'Session expired', null);
  }

  if (response.status === 204) return undefined as T;

  const payload: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const record = (payload ?? {}) as { message?: string; code?: string };
    throw new ApiError(
      response.status,
      record.code,
      record.message ?? `Request failed with ${response.status}`,
      payload,
    );
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query']) =>
    apiFetch<T>(path, { method: 'GET', query }),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    apiFetch<T>(path, { ...options, method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PATCH', body }),
  put: <T>(path: string, body?: unknown) => apiFetch<T>(path, { method: 'PUT', body }),
  del: <T>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
};

export type { Paginated };
