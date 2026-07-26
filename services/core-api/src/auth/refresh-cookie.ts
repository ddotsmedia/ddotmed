/**
 * The refresh token is delivered as an httpOnly cookie so that XSS in the web app
 * cannot read it. The access token stays in memory on the client and is never
 * persisted — losing it on reload is acceptable because the cookie can mint a new one.
 *
 * Native clients (Flutter) cannot rely on a browser cookie jar, so the refresh
 * endpoint still accepts a body token as a fallback.
 */
export const REFRESH_COOKIE = 'medicore_rt';

/** Scoped to the auth routes: no other endpoint ever needs to see this cookie. */
const COOKIE_PATH = '/api/auth';

/**
 * Structural types rather than fastify imports: only the cookie surface is used,
 * so the auth layer does not take a direct dependency on the HTTP adapter.
 */
export interface CookieCapableReply {
  setCookie(name: string, value: string, options?: Record<string, unknown>): unknown;
  clearCookie(name: string, options?: Record<string, unknown>): unknown;
}

export interface CookieCapableRequest {
  cookies?: Record<string, string | undefined>;
}

export function setRefreshCookie(
  reply: CookieCapableReply,
  token: string,
  maxAgeSeconds: number,
): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    // Lax still sends the cookie on the top-level navigation back from an SSO
    // provider, which Strict would block.
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: COOKIE_PATH,
    maxAge: maxAgeSeconds,
    signed: false,
  });
}

export function clearRefreshCookie(reply: CookieCapableReply): void {
  reply.clearCookie(REFRESH_COOKIE, { path: COOKIE_PATH });
}

export function readRefreshToken(
  request: CookieCapableRequest,
  bodyToken?: string | null,
): string | null {
  return request.cookies?.[REFRESH_COOKIE] ?? bodyToken ?? null;
}

/**
 * Strips the refresh token from a response body once it has been placed in a cookie,
 * so a browser client never receives it anywhere JavaScript can reach.
 */
export function withoutRefreshToken<T extends { refresh_token?: string }>(
  result: T,
): Omit<T, 'refresh_token'> {
  const { refresh_token: _omitted, ...rest } = result;
  return rest;
}
