import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { Audit, Ctx, Public } from '../common/decorators';
import type { RequestContext } from '../common/tenant-context';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';
import { OidcService } from './oidc.service';
import { SamlService } from './saml.service';
import { ZodBody } from '../common/zod.pipe';
import {
  clearRefreshCookie,
  readRefreshToken,
  setRefreshCookie,
  withoutRefreshToken,
  type CookieCapableReply,
  type CookieCapableRequest,
} from './refresh-cookie';

const LoginSchema = z.object({
  tenant: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8).max(200),
  device_id: z.string().optional(),
});

const MfaSchema = z.object({
  mfa_token: z.string().min(10),
  code: z.string().min(6).max(10),
});

/** Optional: browsers send the cookie, native clients send the body field. */
const RefreshSchema = z.object({ refresh_token: z.string().min(10).optional() });

const BreakGlassSchema = z.object({
  reason: z.string().min(10).max(500),
  patient_id: z.string().uuid().nullable().optional(),
});

type RawReq = CookieCapableRequest & {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
};

const metaOf = (req: RawReq) => {
  const fwd = req.headers['x-forwarded-for'];
  const ua = req.headers['user-agent'];
  return {
    ip: (typeof fwd === 'string' ? fwd.split(',')[0]?.trim() : undefined) ?? req.ip ?? null,
    userAgent: typeof ua === 'string' ? ua : null,
  };
};

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly tokens: TokenService,
    private readonly oidc: OidcService,
    private readonly saml: SamlService,
  ) {}

  /** Moves the refresh token out of the JSON body and into an httpOnly cookie. */
  private issue<T extends { refresh_token?: string }>(reply: CookieCapableReply, result: T) {
    if (result.refresh_token) {
      setRefreshCookie(reply, result.refresh_token, this.tokens.refreshTtlSeconds);
      return withoutRefreshToken(result);
    }
    return result;
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Password login; returns an MFA challenge when MFA is enabled' })
  async login(
    @ZodBody(LoginSchema) body: z.infer<typeof LoginSchema>,
    @Req() req: RawReq,
    @Res({ passthrough: true }) reply: CookieCapableReply,
  ) {
    const result = await this.auth.login(body.tenant, body.email, body.password, {
      ...metaOf(req),
      deviceId: body.device_id,
    });
    return this.issue(reply, result);
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(
    @ZodBody(MfaSchema) body: z.infer<typeof MfaSchema>,
    @Req() req: RawReq,
    @Res({ passthrough: true }) reply: CookieCapableReply,
  ) {
    const result = await this.auth.verifyMfa(body.mfa_token, body.code, metaOf(req));
    return this.issue(reply, result);
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the session; reads the refresh token from cookie or body' })
  async refresh(
    @ZodBody(RefreshSchema) body: z.infer<typeof RefreshSchema>,
    @Req() req: RawReq,
    @Res({ passthrough: true }) reply: CookieCapableReply,
  ) {
    const token = readRefreshToken(req, body.refresh_token);
    if (!token) throw new UnauthorizedException('No refresh token supplied');

    try {
      const result = await this.auth.refresh(token, metaOf(req));
      return this.issue(reply, result);
    } catch (error) {
      // A rejected refresh means the session is finished; drop the stale cookie so
      // the browser stops replaying it on every subsequent request.
      clearRefreshCookie(reply);
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(204)
  @Audit({ action: 'auth.logout', resourceType: 'Session' })
  async logout(
    @Ctx() ctx: RequestContext,
    @Res({ passthrough: true }) reply: CookieCapableReply,
  ): Promise<void> {
    if (ctx.sessionId) await this.auth.logout(ctx.sessionId);
    clearRefreshCookie(reply);
  }

  @Post('mfa/setup')
  async setupMfa(@Ctx() ctx: RequestContext) {
    if (!ctx.userId) throw new UnauthorizedException();
    return this.auth.setupMfa(ctx.userId, ctx.tenantId, ctx.userId);
  }

  @Post('mfa/confirm')
  @HttpCode(204)
  async confirmMfa(@Body('code') code: string, @Ctx() ctx: RequestContext): Promise<void> {
    if (!ctx.userId) throw new UnauthorizedException();
    await this.auth.confirmMfa(ctx.userId, code);
  }

  @Post('break-glass')
  @HttpCode(200)
  @ApiOperation({ summary: 'Emergency PHI access. Audited before the token is issued.' })
  async breakGlass(
    @ZodBody(BreakGlassSchema) body: z.infer<typeof BreakGlassSchema>,
    @Ctx() ctx: RequestContext,
    @Req() req: RawReq,
    @Res({ passthrough: true }) reply: CookieCapableReply,
  ) {
    if (!ctx.userId) throw new UnauthorizedException();
    const result = await this.auth.breakGlass(
      ctx.userId,
      ctx.tenantId,
      body.reason,
      body.patient_id ?? null,
      metaOf(req),
    );
    return this.issue(reply, result);
  }

  @Public()
  @Get('.well-known/jwks.json')
  jwks() {
    return this.tokens.jwks();
  }

  @Public()
  @Get('oauth/authorize')
  authorize(@Body('tenant') tenant: string) {
    return this.oidc.buildAuthorizationUrl(tenant);
  }

  @Public()
  @Post('oauth/callback')
  @HttpCode(200)
  async oauthCallback(
    @Body() body: { code: string; state: string; tenant: string },
    @Req() req: RawReq,
    @Res({ passthrough: true }) reply: CookieCapableReply,
  ) {
    const result = await this.oidc.handleCallback(body.tenant, body.code, body.state, metaOf(req));
    return this.issue(reply, result);
  }

  @Public()
  @Get('saml/metadata')
  samlMetadata() {
    return this.saml.serviceProviderMetadata();
  }

  @Public()
  @Post('saml/acs')
  @HttpCode(200)
  async samlAcs(
    @Body() body: { SAMLResponse: string; RelayState?: string },
    @Req() req: RawReq,
    @Res({ passthrough: true }) reply: CookieCapableReply,
  ) {
    const result = await this.saml.consumeAssertion(body.SAMLResponse, body.RelayState, metaOf(req));
    return this.issue(reply, result);
  }
}
