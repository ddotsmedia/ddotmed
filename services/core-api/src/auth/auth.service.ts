import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { ROLE_PERMISSIONS, type Permission, type Role } from '@medicore/shared-types';
import { PrismaService } from '../common/prisma.service';
import { AuditService } from '../audit/audit.service';
import { TokenService, type TokenPair } from './token.service';

const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;

export interface LoginResult extends Partial<TokenPair> {
  mfa_required?: boolean;
  mfa_token?: string;
  user?: { id: string; email: string; roles: Role[]; locale: string };
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
    private readonly audit: AuditService,
  ) {}

  async hashPassword(plain: string): Promise<string> {
    return hash(plain, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
  }

  private async verifyPassword(digest: string, plain: string): Promise<boolean> {
    try {
      return await verify(digest, plain);
    } catch {
      return false;
    }
  }

  private async loadUser(tenantSlug: string, email: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { slug: tenantSlug, deleted_at: null, is_active: true },
      select: { id: true },
    });
    if (!tenant) return null;
    return this.prisma.user.findFirst({
      where: { tenant_id: tenant.id, email: email.toLowerCase(), deleted_at: null },
      include: { user_roles: { include: { role: true } }, practitioner: true },
    });
  }

  private rolesOf(user: { user_roles: Array<{ role: { key: string } }> }): Role[] {
    return user.user_roles.map((ur) => ur.role.key as Role);
  }

  private permissionsOf(roles: Role[]): Permission[] {
    return [...new Set(roles.flatMap((r) => ROLE_PERMISSIONS[r] ?? []))];
  }

  async login(
    tenantSlug: string,
    email: string,
    password: string,
    meta: { ip: string | null; userAgent: string | null; deviceId?: string },
  ): Promise<LoginResult> {
    const user = await this.loadUser(tenantSlug, email);

    // Always run a verification so a missing user and a wrong password cost the same time.
    const digest = user?.password_hash ?? '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const passwordOk = await this.verifyPassword(digest, password);

    if (!user || !user.password_hash || !passwordOk || !user.is_active) {
      if (user) await this.registerFailure(user.id, user.tenant_id, user.failed_login_attempts, meta);
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.locked_until && user.locked_until > new Date()) {
      throw new ForbiddenException('Account is temporarily locked');
    }

    const roles = this.rolesOf(user);
    if (roles.length === 0) throw new ForbiddenException('No roles assigned');

    if (user.mfa_enabled) {
      // Short-lived challenge token; it carries no roles and cannot access PHI routes.
      const mfaToken = await this.tokens.signAccessToken({
        sub: user.id,
        tenant_id: user.tenant_id,
        roles: [],
        permissions: [],
        session_id: 'mfa-challenge',
        mfa_verified: false,
      });
      return { mfa_required: true, mfa_token: mfaToken };
    }

    return this.issueSession(user.id, user.tenant_id, roles, false, meta, {
      email: user.email,
      locale: user.preferred_locale,
      practitionerId: user.practitioner?.id ?? null,
    });
  }

  async verifyMfa(
    mfaToken: string,
    code: string,
    meta: { ip: string | null; userAgent: string | null; deviceId?: string },
  ): Promise<LoginResult> {
    const claims = await this.tokens.verify<{ sub: string; tenant_id: string }>(mfaToken).catch(() => {
      throw new UnauthorizedException('MFA challenge expired');
    });

    const user = await this.prisma.user.findFirst({
      where: { id: claims.sub, tenant_id: claims.tenant_id, deleted_at: null },
      include: { user_roles: { include: { role: true } }, practitioner: true },
    });
    if (!user?.mfa_secret) throw new UnauthorizedException('MFA is not configured');

    const normalized = code.replace(/\s/g, '');
    const totpOk = authenticator.verify({ token: normalized, secret: user.mfa_secret });
    const recoveryIndex = user.mfa_recovery_codes.findIndex(
      (c) => c === createHash('sha256').update(normalized).digest('hex'),
    );

    if (!totpOk && recoveryIndex === -1) {
      await this.registerFailure(user.id, user.tenant_id, user.failed_login_attempts, meta);
      throw new UnauthorizedException('Invalid authentication code');
    }

    if (recoveryIndex >= 0) {
      // Recovery codes are single-use.
      const remaining = user.mfa_recovery_codes.filter((_, i) => i !== recoveryIndex);
      await this.prisma.user.update({
        where: { id: user.id },
        data: { mfa_recovery_codes: remaining },
      });
    }

    return this.issueSession(user.id, user.tenant_id, this.rolesOf(user), true, meta, {
      email: user.email,
      locale: user.preferred_locale,
      practitionerId: user.practitioner?.id ?? null,
    });
  }

  private async registerFailure(
    userId: string,
    tenantId: string,
    current: number,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<void> {
    const attempts = current + 1;
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        failed_login_attempts: attempts,
        locked_until:
          attempts >= MAX_FAILED_ATTEMPTS
            ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000)
            : undefined,
      },
    });
    await this.audit.record({
      tenant_id: tenantId,
      user_id: userId,
      action: 'auth.login.failed',
      resource_type: 'User',
      resource_id: userId,
      patient_id: null,
      outcome: 'failure',
      is_break_glass: false,
      ip: meta.ip,
      user_agent: meta.userAgent,
      occurred_at: new Date().toISOString(),
    });
  }

  private async issueSession(
    userId: string,
    tenantId: string,
    roles: Role[],
    mfaVerified: boolean,
    meta: { ip: string | null; userAgent: string | null; deviceId?: string },
    profile: { email: string; locale: string; practitionerId: string | null },
    breakGlass = false,
  ): Promise<LoginResult> {
    const jti = this.tokens.newJti();
    const session = await this.prisma.session.create({
      data: {
        tenant_id: tenantId,
        user_id: userId,
        refresh_token_jti: jti,
        refresh_expires_at: this.tokens.refreshExpiresAt,
        ip: meta.ip,
        user_agent: meta.userAgent,
        device_id: meta.deviceId,
        mfa_verified: mfaVerified,
        is_break_glass: breakGlass,
      },
    });

    const permissions = this.permissionsOf(roles);
    const [access_token, refresh_token] = await Promise.all([
      this.tokens.signAccessToken({
        sub: userId,
        tenant_id: tenantId,
        roles,
        permissions,
        session_id: session.id,
        mfa_verified: mfaVerified,
        practitioner_id: profile.practitionerId,
        break_glass: breakGlass,
      }),
      this.tokens.signRefreshToken(userId, tenantId, jti),
    ]);

    await this.prisma.user.update({
      where: { id: userId },
      data: { last_login_at: new Date(), failed_login_attempts: 0, locked_until: null },
    });

    await this.audit.record({
      tenant_id: tenantId,
      user_id: userId,
      action: breakGlass ? 'auth.break-glass.granted' : 'auth.login.success',
      resource_type: 'Session',
      resource_id: session.id,
      patient_id: null,
      outcome: 'success',
      is_break_glass: breakGlass,
      ip: meta.ip,
      user_agent: meta.userAgent,
      occurred_at: new Date().toISOString(),
    });

    return {
      access_token,
      refresh_token,
      expires_in: this.tokens.accessTtlSeconds,
      token_type: 'Bearer',
      user: { id: userId, email: profile.email, roles, locale: profile.locale },
    };
  }

  async refresh(refreshToken: string, _meta: { ip: string | null; userAgent: string | null }) {
    const claims = await this.tokens
      .verify<{ sub: string; tenant_id: string; jti: string; typ: string }>(refreshToken)
      .catch(() => {
        throw new UnauthorizedException('Invalid refresh token');
      });
    if (claims.typ !== 'refresh') throw new UnauthorizedException('Not a refresh token');

    const session = await this.prisma.session.findUnique({
      where: { refresh_token_jti: claims.jti },
    });
    if (!session || session.revoked_at || session.refresh_expires_at < new Date()) {
      throw new UnauthorizedException('Session is no longer valid');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: claims.sub, deleted_at: null, is_active: true },
      include: { user_roles: { include: { role: true } }, practitioner: true },
    });
    if (!user) throw new UnauthorizedException('User is no longer active');

    // Rotate: the presented refresh token is burned and replaced.
    const nextJti = this.tokens.newJti();
    await this.prisma.session.update({
      where: { id: session.id },
      data: {
        refresh_token_jti: nextJti,
        refresh_expires_at: this.tokens.refreshExpiresAt,
        last_activity_at: new Date(),
      },
    });

    const roles = this.rolesOf(user);
    const [access_token, refresh_token] = await Promise.all([
      this.tokens.signAccessToken({
        sub: user.id,
        tenant_id: user.tenant_id,
        roles,
        permissions: this.permissionsOf(roles),
        session_id: session.id,
        mfa_verified: session.mfa_verified,
        practitioner_id: user.practitioner?.id ?? null,
        break_glass: session.is_break_glass,
      }),
      this.tokens.signRefreshToken(user.id, user.tenant_id, nextJti),
    ]);

    return {
      access_token,
      refresh_token,
      expires_in: this.tokens.accessTtlSeconds,
      token_type: 'Bearer' as const,
    };
  }

  async logout(sessionId: string, reason = 'user-logout'): Promise<void> {
    await this.prisma.session.updateMany({
      where: { id: sessionId, revoked_at: null },
      data: { revoked_at: new Date(), revoked_reason: reason },
    });
  }

  async setupMfa(userId: string, tenantId: string, accountLabel: string) {
    const secret = authenticator.generateSecret();
    const recovery = Array.from({ length: 8 }, () =>
      Math.random().toString(36).slice(2, 8).toUpperCase(),
    );
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        mfa_secret: secret,
        mfa_recovery_codes: recovery.map((c) => createHash('sha256').update(c).digest('hex')),
      },
    });
    return {
      secret,
      otpauth_url: authenticator.keyuri(accountLabel, 'MediCore', secret),
      recovery_codes: recovery,
      tenant_id: tenantId,
    };
  }

  async confirmMfa(userId: string, code: string): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user?.mfa_secret) throw new BadRequestException('Start MFA setup first');
    if (!authenticator.verify({ token: code.replace(/\s/g, ''), secret: user.mfa_secret })) {
      throw new UnauthorizedException('Invalid authentication code');
    }
    await this.prisma.user.update({ where: { id: userId }, data: { mfa_enabled: true } });
  }

  /** Issues a normal session for an already-authenticated federated identity (OIDC/SAML). */
  async ssoSession(
    userId: string,
    tenantId: string,
    meta: { ip: string | null; userAgent: string | null; deviceId?: string },
  ): Promise<LoginResult> {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenant_id: tenantId, deleted_at: null, is_active: true },
      include: { user_roles: { include: { role: true } }, practitioner: true },
    });
    if (!user) throw new UnauthorizedException();
    const roles = this.rolesOf(user);
    if (roles.length === 0) throw new ForbiddenException('No roles assigned');
    // The IdP already asserted the second factor; we do not re-challenge locally.
    return this.issueSession(user.id, tenantId, roles, true, meta, {
      email: user.email,
      locale: user.preferred_locale,
      practitionerId: user.practitioner?.id ?? null,
    });
  }

  /**
   * Break-glass: grants a time-boxed elevated session for an unfolding emergency.
   * The audit entry is written before the token is returned — never after.
   */
  async breakGlass(
    userId: string,
    tenantId: string,
    reason: string,
    patientId: string | null,
    meta: { ip: string | null; userAgent: string | null },
  ): Promise<LoginResult> {
    if (reason.trim().length < 10) {
      throw new BadRequestException('A break-glass reason of at least 10 characters is required');
    }
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenant_id: tenantId, deleted_at: null, is_active: true },
      include: { user_roles: { include: { role: true } }, practitioner: true },
    });
    if (!user) throw new UnauthorizedException();

    const roles = this.rolesOf(user);
    if (!this.permissionsOf(roles).includes('break-glass')) {
      throw new ForbiddenException('Your role may not invoke break-glass access');
    }

    await this.audit.record({
      tenant_id: tenantId,
      user_id: userId,
      action: 'auth.break-glass.invoked',
      resource_type: 'Patient',
      resource_id: patientId,
      patient_id: patientId,
      outcome: 'success',
      is_break_glass: true,
      break_glass_reason: reason,
      ip: meta.ip,
      user_agent: meta.userAgent,
      occurred_at: new Date().toISOString(),
    });

    return this.issueSession(
      userId,
      tenantId,
      roles,
      user.mfa_enabled,
      meta,
      { email: user.email, locale: user.preferred_locale, practitionerId: user.practitioner?.id ?? null },
      true,
    );
  }
}
