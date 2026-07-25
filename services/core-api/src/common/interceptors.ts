import { randomUUID } from 'node:crypto';
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import type { JwtPayload } from '@medicore/shared-types';
import { AUDIT_KEY, type AuditMeta } from './decorators';
import { contextFromJwt, requestContext } from './tenant-context';
import { AuditService } from '../audit/audit.service';

interface Req {
  user?: JwtPayload;
  ip?: string;
  method: string;
  url: string;
  params?: Record<string, string>;
  body?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
}

const header = (req: Req, key: string): string | null => {
  const v = req.headers[key];
  return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
};

/**
 * Binds tenant scope to the request's async context. Every repository reads the
 * tenant from here, so a query can never silently run unscoped.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Req>();
    const requestId = header(req, 'x-request-id') ?? randomUUID();
    const meta = {
      ip: header(req, 'x-forwarded-for')?.split(',')[0]?.trim() ?? req.ip ?? null,
      userAgent: header(req, 'user-agent'),
      requestId,
    };

    if (!req.user) return next.handle();

    return new Observable((subscriber) => {
      requestContext.run(contextFromJwt(req.user!, meta), () => {
        next.handle().subscribe(subscriber);
      });
    });
  }
}

const PHI_WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Writes an audit row after every mutating request that touched PHI. */
@Injectable()
export class AuditLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditLogInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Req>();
    const meta = this.reflector.getAllAndOverride<AuditMeta | undefined>(AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const shouldAudit = meta ?? (PHI_WRITE_METHODS.has(req.method) ? undefined : null);
    if (shouldAudit === null || !req.user) return next.handle();

    const action = meta?.action ?? `${req.method.toLowerCase()} ${req.url.split('?')[0]}`;
    const resourceType = meta?.resourceType ?? 'Unknown';

    return next.handle().pipe(
      tap({
        next: (result) => void this.write(req, action, resourceType, result, 'success'),
        error: (err) => void this.write(req, action, resourceType, null, 'failure', err),
      }),
    );
  }

  private async write(
    req: Req,
    action: string,
    resourceType: string,
    result: unknown,
    outcome: 'success' | 'failure',
    error?: unknown,
  ): Promise<void> {
    const user = req.user!;
    const record = (result ?? {}) as Record<string, unknown>;
    const patientId =
      (typeof record.patient_id === 'string' ? record.patient_id : null) ??
      req.params?.patientId ??
      (typeof req.body?.patient_id === 'string' ? req.body.patient_id : null) ??
      null;

    try {
      await this.audit.record({
        tenant_id: user.tenant_id,
        user_id: user.sub,
        session_id: user.session_id,
        action,
        resource_type: resourceType,
        resource_id: (typeof record.id === 'string' ? record.id : null) ?? req.params?.id ?? null,
        patient_id: patientId,
        outcome,
        is_break_glass: user.break_glass === true,
        ip: header(req, 'x-forwarded-for')?.split(',')[0]?.trim() ?? req.ip ?? null,
        user_agent: header(req, 'user-agent'),
        after_state: outcome === 'failure' ? { error: String(error) } : null,
        occurred_at: new Date().toISOString(),
      });
    } catch (e) {
      // Auditing must never take down the request path; surface loudly instead.
      this.logger.error(`Failed to write audit record for ${action}: ${String(e)}`);
    }
  }
}
