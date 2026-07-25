import { SetMetadata, createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Permission, Role } from '@medicore/shared-types';
import { currentContext, type RequestContext } from './tenant-context';

export const ROLES_KEY = 'medicore:roles';
export const PERMISSIONS_KEY = 'medicore:permissions';
export const PUBLIC_KEY = 'medicore:public';
export const AUDIT_KEY = 'medicore:audit';
export const SKIP_MFA_KEY = 'medicore:skip-mfa';

export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
export const RequirePermissions = (...perms: Permission[]) => SetMetadata(PERMISSIONS_KEY, perms);
export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const SkipMfa = () => SetMetadata(SKIP_MFA_KEY, true);

export interface AuditMeta {
  action: string;
  resourceType: string;
  /** PHI writes are always audited; reads are audited when explicitly marked. */
  isPhi?: boolean;
}
export const Audit = (meta: AuditMeta) => SetMetadata(AUDIT_KEY, meta);

export const Ctx = createParamDecorator(
  (field: keyof RequestContext | undefined, _c: ExecutionContext) => {
    const ctx = currentContext();
    return field ? ctx[field] : ctx;
  },
);

export const TenantId = createParamDecorator(() => currentContext().tenantId);
export const UserId = createParamDecorator(() => currentContext().userId);
