import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
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

const RefreshSchema = z.object({ refresh_token: z.string().min(10) });

const BreakGlassSchema = z.object({
  reason: z.string().min(10).max(500),
  patient_id: z.string().uuid().nullable().optional(),
});

interface RawReq {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

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

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Password login; returns an MFA challenge when MFA is enabled' })
  async login(@ZodBody(LoginSchema) body: z.infer<typeof LoginSchema>, @Req() req: RawReq) {
    return this.auth.login(body.tenant, body.email, body.password, {
      ...metaOf(req),
      deviceId: body.device_id,
    });
  }

  @Public()
  @Post('mfa/verify')
  @HttpCode(200)
  async verifyMfa(@ZodBody(MfaSchema) body: z.infer<typeof MfaSchema>, @Req() req: RawReq) {
    return this.auth.verifyMfa(body.mfa_token, body.code, metaOf(req));
  }

  @Public()
  @Post('refresh')
  @HttpCode(200)
  async refresh(@ZodBody(RefreshSchema) body: z.infer<typeof RefreshSchema>, @Req() req: RawReq) {
    return this.auth.refresh(body.refresh_token, metaOf(req));
  }

  @Post('logout')
  @HttpCode(204)
  @Audit({ action: 'auth.logout', resourceType: 'Session' })
  async logout(@Ctx() ctx: RequestContext): Promise<void> {
    if (ctx.sessionId) await this.auth.logout(ctx.sessionId);
  }

  @Post('mfa/setup')
  async setupMfa(@Ctx() ctx: RequestContext) {
    if (!ctx.userId) throw new UnauthorizedException();
    return this.auth.setupMfa(ctx.userId, ctx.tenantId, ctx.userId);
  }

  @Post('mfa/confirm')
  @HttpCode(204)
  async confirmMfa(
    @Body('code') code: string,
    @Ctx() ctx: RequestContext,
  ): Promise<void> {
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
  ) {
    if (!ctx.userId) throw new UnauthorizedException();
    return this.auth.breakGlass(
      ctx.userId,
      ctx.tenantId,
      body.reason,
      body.patient_id ?? null,
      metaOf(req),
    );
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
  ) {
    return this.oidc.handleCallback(body.tenant, body.code, body.state, metaOf(req));
  }

  @Public()
  @Get('saml/metadata')
  samlMetadata() {
    return this.saml.serviceProviderMetadata();
  }

  @Public()
  @Post('saml/acs')
  @HttpCode(200)
  async samlAcs(@Body() body: { SAMLResponse: string; RelayState?: string }, @Req() req: RawReq) {
    return this.saml.consumeAssertion(body.SAMLResponse, body.RelayState, metaOf(req));
  }
}
