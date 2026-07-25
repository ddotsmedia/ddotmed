import { createHash, randomBytes } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { AuthService } from './auth.service';

interface PkceState {
  verifier: string;
  tenant: string;
  createdAt: number;
}

/** OAuth2 / OIDC authorization-code flow with PKCE. */
@Injectable()
export class OidcService {
  private readonly logger = new Logger(OidcService.name);
  private readonly states = new Map<string, PkceState>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
  ) {}

  private cfg() {
    return {
      issuer: this.config.get<string>('OIDC_ISSUER'),
      clientId: this.config.get<string>('OIDC_CLIENT_ID'),
      clientSecret: this.config.get<string>('OIDC_CLIENT_SECRET'),
      redirectUri: this.config.get<string>('OIDC_REDIRECT_URI'),
      authorizeUrl: this.config.get<string>('OIDC_AUTHORIZE_URL'),
      tokenUrl: this.config.get<string>('OIDC_TOKEN_URL'),
      userinfoUrl: this.config.get<string>('OIDC_USERINFO_URL'),
    };
  }

  buildAuthorizationUrl(tenant: string): { url: string; state: string } {
    const c = this.cfg();
    if (!c.authorizeUrl || !c.clientId) {
      throw new UnauthorizedException('OIDC is not configured for this deployment');
    }
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const state = randomBytes(16).toString('base64url');

    this.states.set(state, { verifier, tenant, createdAt: Date.now() });
    this.sweep();

    const url = new URL(c.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', c.clientId);
    url.searchParams.set('redirect_uri', c.redirectUri ?? '');
    url.searchParams.set('scope', 'openid profile email');
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return { url: url.toString(), state };
  }

  private sweep(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of this.states) if (v.createdAt < cutoff) this.states.delete(k);
  }

  async handleCallback(
    tenantSlug: string,
    code: string,
    state: string,
    meta: { ip: string | null; userAgent: string | null },
  ) {
    const stored = this.states.get(state);
    if (!stored || stored.tenant !== tenantSlug) throw new UnauthorizedException('Invalid state');
    this.states.delete(state);

    const c = this.cfg();
    const res = await fetch(c.tokenUrl!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: c.redirectUri ?? '',
        client_id: c.clientId ?? '',
        client_secret: c.clientSecret ?? '',
        code_verifier: stored.verifier,
      }),
    });
    if (!res.ok) throw new UnauthorizedException('Identity provider rejected the code exchange');

    const tokens = (await res.json()) as { access_token: string; id_token?: string };
    const infoRes = await fetch(c.userinfoUrl!, {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!infoRes.ok) throw new UnauthorizedException('Unable to read the identity provider profile');

    const info = (await infoRes.json()) as { sub: string; email?: string };
    return this.linkAndIssue(tenantSlug, info.sub, info.email, c.issuer ?? 'oidc', meta);
  }

  /** Shared by OIDC and SAML: match the federated subject to a provisioned user. */
  async linkAndIssue(
    tenantSlug: string,
    subject: string,
    email: string | undefined,
    issuer: string,
    meta: { ip: string | null; userAgent: string | null },
  ) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { slug: tenantSlug, deleted_at: null, is_active: true },
    });
    if (!tenant) throw new UnauthorizedException('Unknown tenant');

    const user = await this.prisma.user.findFirst({
      where: {
        tenant_id: tenant.id,
        deleted_at: null,
        is_active: true,
        OR: [{ oidc_subject: subject }, ...(email ? [{ email: email.toLowerCase() }] : [])],
      },
    });
    // No just-in-time provisioning: a federated identity must map to an account an
    // administrator already created, with roles already assigned.
    if (!user) throw new UnauthorizedException('No provisioned account for this identity');

    if (!user.oidc_subject) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { oidc_subject: subject, oidc_issuer: issuer },
      });
    }

    return this.auth.ssoSession(user.id, tenant.id, meta);
  }
}
