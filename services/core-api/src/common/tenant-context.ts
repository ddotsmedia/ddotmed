import { AsyncLocalStorage } from 'node:async_hooks';
import type { JwtPayload } from '@medicore/shared-types';

export interface RequestContext {
  tenantId: string;
  userId: string | null;
  sessionId: string | null;
  roles: string[];
  permissions: string[];
  practitionerId?: string | null;
  patientId?: string | null;
  isBreakGlass: boolean;
  ip: string | null;
  userAgent: string | null;
  requestId: string;
  /**
   * The caller's own bearer token, kept only for the life of the request so
   * internal services (the AI service) can be called as the caller rather than
   * with a shared service credential. Never logged, never persisted.
   */
  accessToken?: string | null;
}

/**
 * Request-scoped tenant context. Repositories read `tenantId` from here rather than
 * accepting it as a parameter, so a forgotten argument cannot leak cross-tenant PHI.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

export function currentContext(): RequestContext {
  const ctx = requestContext.getStore();
  if (!ctx) throw new Error('No request context — tenant scope is unavailable');
  return ctx;
}

export function currentTenantId(): string {
  return currentContext().tenantId;
}

export function contextFromJwt(
  payload: JwtPayload,
  meta: {
    ip: string | null;
    userAgent: string | null;
    requestId: string;
    accessToken?: string | null;
  },
): RequestContext {
  return {
    tenantId: payload.tenant_id,
    userId: payload.sub,
    sessionId: payload.session_id,
    roles: payload.roles,
    permissions: payload.permissions,
    practitionerId: payload.practitioner_id ?? null,
    patientId: payload.patient_id ?? null,
    isBreakGlass: payload.break_glass === true,
    ...meta,
  };
}
