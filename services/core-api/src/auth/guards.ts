import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { JwtPayload, Permission, Role } from '@medicore/shared-types';
import { SESSION_IDLE_TIMEOUT_MS } from '@medicore/shared-types';
import { PERMISSIONS_KEY, PUBLIC_KEY, ROLES_KEY } from '../common/decorators';
import { PrismaService } from '../common/prisma.service';
import { TokenService } from './token.service';

interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: JwtPayload;
  ip?: string;
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const raw = typeof header === 'string' ? header : undefined;
    if (!raw?.startsWith('Bearer ')) throw new UnauthorizedException('Missing bearer token');

    let payload: JwtPayload;
    try {
      payload = await this.tokens.verify<JwtPayload>(raw.slice(7));
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }

    if (payload.session_id === 'mfa-challenge') {
      throw new UnauthorizedException('MFA verification is incomplete');
    }

    const session = await this.prisma.session.findUnique({
      where: { id: payload.session_id },
      select: { revoked_at: true, last_activity_at: true },
    });
    if (!session || session.revoked_at) throw new UnauthorizedException('Session revoked');

    // 15-minute idle auto-logout, enforced server-side so a stale tab cannot keep PHI open.
    const idleMs = Date.now() - session.last_activity_at.getTime();
    if (idleMs > SESSION_IDLE_TIMEOUT_MS) {
      await this.prisma.session.update({
        where: { id: payload.session_id },
        data: { revoked_at: new Date(), revoked_reason: 'idle-timeout' },
      });
      throw new UnauthorizedException('Session expired after inactivity');
    }

    await this.prisma.session.update({
      where: { id: payload.session_id },
      data: { last_activity_at: new Date() },
    });

    req.user = payload;
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const requiredPerms = this.reflector.getAllAndOverride<Permission[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length && !requiredPerms?.length) return true;

    const user = context.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user) throw new UnauthorizedException();

    if (required?.length && !required.some((r) => user.roles.includes(r))) {
      throw new ForbiddenException(`Requires one of: ${required.join(', ')}`);
    }
    if (requiredPerms?.length && !requiredPerms.every((p) => user.permissions.includes(p))) {
      const missing = requiredPerms.filter((p) => !user.permissions.includes(p));
      throw new ForbiddenException(`Missing permission: ${missing.join(', ')}`);
    }
    return true;
  }
}
