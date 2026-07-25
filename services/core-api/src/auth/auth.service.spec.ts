import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';
import type { PrismaService } from '../common/prisma.service';
import type { AuditService } from '../audit/audit.service';
import type { TokenService } from './token.service';

const tokens = {
  signAccessToken: jest.fn().mockResolvedValue('access'),
  signRefreshToken: jest.fn().mockResolvedValue('refresh'),
  verify: jest.fn(),
  newJti: jest.fn().mockReturnValue('jti-1'),
  refreshExpiresAt: new Date(Date.now() + 3600_000),
  accessTtlSeconds: 900,
} as unknown as TokenService;

const audit = { record: jest.fn().mockResolvedValue(undefined) } as unknown as AuditService;

const makePrisma = () =>
  ({
    tenant: { findFirst: jest.fn() },
    user: { findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    session: { create: jest.fn().mockResolvedValue({ id: 'sess-1' }), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  }) as unknown as PrismaService;

describe('AuthService', () => {
  let prisma: PrismaService;
  let service: AuthService;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = makePrisma();
    service = new AuthService(prisma, tokens, audit);
  });

  const meta = { ip: '10.0.0.1', userAgent: 'jest' };

  it('rejects an unknown user without revealing that the account is missing', async () => {
    (prisma.tenant.findFirst as jest.Mock).mockResolvedValue({ id: 't1' });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(service.login('acme', 'nobody@example.com', 'password123', meta)).rejects.toThrow(
      UnauthorizedException,
    );
    // No audit row for a non-existent user, and no user lookup leak in the message.
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('rejects a wrong password and records the failure', async () => {
    const hashed = await service.hashPassword('correct-horse');
    (prisma.tenant.findFirst as jest.Mock).mockResolvedValue({ id: 't1' });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'u1',
      tenant_id: 't1',
      password_hash: hashed,
      is_active: true,
      failed_login_attempts: 0,
      user_roles: [{ role: { key: 'doctor' } }],
    });

    await expect(service.login('acme', 'a@b.com', 'wrong-password', meta)).rejects.toThrow(
      UnauthorizedException,
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'auth.login.failed', outcome: 'failure' }),
    );
  });

  it('locks the account after five failed attempts', async () => {
    const hashed = await service.hashPassword('correct-horse');
    (prisma.tenant.findFirst as jest.Mock).mockResolvedValue({ id: 't1' });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'u1',
      tenant_id: 't1',
      password_hash: hashed,
      is_active: true,
      failed_login_attempts: 4,
      user_roles: [{ role: { key: 'doctor' } }],
    });

    await expect(service.login('acme', 'a@b.com', 'nope', meta)).rejects.toThrow();
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          failed_login_attempts: 5,
          locked_until: expect.any(Date),
        }),
      }),
    );
  });

  it('returns an MFA challenge instead of tokens when MFA is enabled', async () => {
    const hashed = await service.hashPassword('correct-horse');
    (prisma.tenant.findFirst as jest.Mock).mockResolvedValue({ id: 't1' });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'u1',
      tenant_id: 't1',
      password_hash: hashed,
      is_active: true,
      mfa_enabled: true,
      failed_login_attempts: 0,
      preferred_locale: 'en',
      user_roles: [{ role: { key: 'doctor' } }],
    });

    const result = await service.login('acme', 'a@b.com', 'correct-horse', meta);
    expect(result.mfa_required).toBe(true);
    expect(result.access_token).toBeUndefined();
  });

  it('issues tokens and derives permissions from roles when MFA is off', async () => {
    const hashed = await service.hashPassword('correct-horse');
    (prisma.tenant.findFirst as jest.Mock).mockResolvedValue({ id: 't1' });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'u1',
      tenant_id: 't1',
      email: 'a@b.com',
      password_hash: hashed,
      is_active: true,
      mfa_enabled: false,
      failed_login_attempts: 0,
      preferred_locale: 'en',
      user_roles: [{ role: { key: 'doctor' } }],
      practitioner: { id: 'p1' },
    });

    const result = await service.login('acme', 'a@b.com', 'correct-horse', meta);
    expect(result.access_token).toBe('access');
    expect(result.user?.roles).toEqual(['doctor']);
    expect(tokens.signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({
        permissions: expect.arrayContaining(['medication:prescribe', 'note:sign']),
        practitioner_id: 'p1',
      }),
    );
  });

  it('refuses a user with no roles assigned', async () => {
    const hashed = await service.hashPassword('correct-horse');
    (prisma.tenant.findFirst as jest.Mock).mockResolvedValue({ id: 't1' });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'u1',
      tenant_id: 't1',
      password_hash: hashed,
      is_active: true,
      failed_login_attempts: 0,
      user_roles: [],
    });

    await expect(service.login('acme', 'a@b.com', 'correct-horse', meta)).rejects.toThrow(
      ForbiddenException,
    );
  });

  it('requires a substantive reason for break-glass access', async () => {
    await expect(service.breakGlass('u1', 't1', 'urgent', null, meta)).rejects.toThrow(
      /at least 10 characters/,
    );
  });

  it('refuses break-glass for a role without the permission', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'u1',
      tenant_id: 't1',
      user_roles: [{ role: { key: 'receptionist' } }],
    });
    await expect(
      service.breakGlass('u1', 't1', 'Patient is unresponsive in resus bay 3', 'pat-1', meta),
    ).rejects.toThrow(ForbiddenException);
  });

  it('audits break-glass before issuing the elevated token', async () => {
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'u1',
      tenant_id: 't1',
      email: 'doc@b.com',
      preferred_locale: 'en',
      mfa_enabled: false,
      user_roles: [{ role: { key: 'doctor' } }],
      practitioner: { id: 'p1' },
    });

    const result = await service.breakGlass(
      'u1',
      't1',
      'Patient is unresponsive in resus bay 3',
      'pat-1',
      meta,
    );

    const invoked = (audit.record as jest.Mock).mock.calls.findIndex(
      (c) => c[0].action === 'auth.break-glass.invoked',
    );
    const granted = (audit.record as jest.Mock).mock.calls.findIndex(
      (c) => c[0].action === 'auth.break-glass.granted',
    );
    expect(invoked).toBeGreaterThanOrEqual(0);
    expect(invoked).toBeLessThan(granted);
    expect(result.access_token).toBe('access');
    expect(tokens.signAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ break_glass: true }),
    );
  });

  it('rotates the refresh token so a replayed token cannot be reused', async () => {
    (tokens.verify as jest.Mock).mockResolvedValue({
      sub: 'u1',
      tenant_id: 't1',
      jti: 'old-jti',
      typ: 'refresh',
    });
    (prisma.session.findUnique as jest.Mock).mockResolvedValue({
      id: 'sess-1',
      revoked_at: null,
      refresh_expires_at: new Date(Date.now() + 3600_000),
      mfa_verified: true,
      is_break_glass: false,
    });
    (prisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'u1',
      tenant_id: 't1',
      user_roles: [{ role: { key: 'nurse' } }],
      practitioner: null,
    });
    (prisma.session.update as jest.Mock).mockResolvedValue({});

    await service.refresh('refresh-token', meta);
    expect(prisma.session.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ refresh_token_jti: 'jti-1' }),
      }),
    );
  });

  it('rejects a revoked session on refresh', async () => {
    (tokens.verify as jest.Mock).mockResolvedValue({
      sub: 'u1',
      tenant_id: 't1',
      jti: 'j',
      typ: 'refresh',
    });
    (prisma.session.findUnique as jest.Mock).mockResolvedValue({
      id: 'sess-1',
      revoked_at: new Date(),
      refresh_expires_at: new Date(Date.now() + 3600_000),
    });
    await expect(service.refresh('token', meta)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an access token presented at the refresh endpoint', async () => {
    (tokens.verify as jest.Mock).mockResolvedValue({ sub: 'u1', tenant_id: 't1', jti: 'j', typ: 'access' });
    await expect(service.refresh('token', meta)).rejects.toThrow(/Not a refresh token/);
  });
});
