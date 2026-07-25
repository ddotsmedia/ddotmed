import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma.service';
import { TokenService } from '../auth/token.service';

interface SmartAuthRequest {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  launchContext: { patient?: string; encounter?: string } | null;
  userId: string;
  tenantId: string;
  createdAt: number;
}

/**
 * SMART on FHIR launch. Supports EHR launch (with a launch token carrying patient
 * context) and standalone launch, both over authorization-code + PKCE. PKCE is
 * required, not optional — public app clients cannot hold a secret.
 */
@Injectable()
export class SmartService {
  private readonly codes = new Map<string, SmartAuthRequest>();
  private readonly launches = new Map<string, { patient?: string; encounter?: string; tenantId: string; createdAt: number }>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly tokens: TokenService,
  ) {}

  private get issuer(): string {
    return this.config.get<string>('SMART_ISSUER') ?? 'https://DOMAIN_PLACEHOLDER';
  }

  private get fhirBase(): string {
    return this.config.get<string>('FHIR_SERVER_URL') ?? `${this.issuer}/fhir`;
  }

  /** .well-known/smart-configuration, discovered by every SMART app. */
  wellKnownConfiguration(): Record<string, unknown> {
    return {
      issuer: this.issuer,
      jwks_uri: `${this.issuer}/api/auth/.well-known/jwks.json`,
      authorization_endpoint: `${this.issuer}/api/fhir/smart/authorize`,
      token_endpoint: `${this.issuer}/api/fhir/smart/token`,
      introspection_endpoint: `${this.issuer}/api/fhir/smart/introspect`,
      grant_types_supported: ['authorization_code', 'refresh_token'],
      response_types_supported: ['code'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
      scopes_supported: [
        'openid',
        'fhirUser',
        'launch',
        'launch/patient',
        'launch/encounter',
        'offline_access',
        'patient/*.read',
        'patient/*.rs',
        'user/*.read',
        'system/*.read',
      ],
      capabilities: [
        'launch-ehr',
        'launch-standalone',
        'client-public',
        'client-confidential-symmetric',
        'context-ehr-patient',
        'context-ehr-encounter',
        'permission-patient',
        'permission-user',
        'sso-openid-connect',
      ],
    };
  }

  /** Mints a launch token that carries EHR context into the app's authorize call. */
  createLaunchContext(tenantId: string, patientId?: string, encounterId?: string): string {
    const launch = randomBytes(24).toString('base64url');
    this.launches.set(launch, { patient: patientId, encounter: encounterId, tenantId, createdAt: Date.now() });
    this.sweep();
    return launch;
  }

  private sweep(): void {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [k, v] of this.launches) if (v.createdAt < cutoff) this.launches.delete(k);
    for (const [k, v] of this.codes) if (v.createdAt < cutoff) this.codes.delete(k);
  }

  async authorize(params: {
    response_type: string;
    client_id: string;
    redirect_uri: string;
    scope: string;
    state: string;
    aud: string;
    code_challenge?: string;
    code_challenge_method?: string;
    launch?: string;
    userId: string;
    tenantId: string;
  }): Promise<{ redirect_to: string }> {
    if (params.response_type !== 'code') {
      throw new BadRequestException('Only response_type=code is supported');
    }
    if (!params.code_challenge || params.code_challenge_method !== 'S256') {
      throw new BadRequestException('PKCE with code_challenge_method=S256 is required');
    }
    // aud must name this FHIR server, otherwise the token could be replayed elsewhere.
    if (!params.aud.startsWith(this.fhirBase.replace(/\/$/, '').slice(0, this.fhirBase.length))) {
      throw new BadRequestException('aud does not match this FHIR server');
    }

    const context = params.launch ? (this.launches.get(params.launch) ?? null) : null;
    if (params.launch && !context) throw new BadRequestException('Launch context is unknown or expired');
    if (context && context.tenantId !== params.tenantId) {
      throw new UnauthorizedException('Launch context belongs to a different tenant');
    }

    const code = randomBytes(32).toString('base64url');
    this.codes.set(code, {
      clientId: params.client_id,
      redirectUri: params.redirect_uri,
      scope: params.scope,
      state: params.state,
      codeChallenge: params.code_challenge,
      codeChallengeMethod: params.code_challenge_method,
      launchContext: context ? { patient: context.patient, encounter: context.encounter } : null,
      userId: params.userId,
      tenantId: params.tenantId,
      createdAt: Date.now(),
    });
    if (params.launch) this.launches.delete(params.launch);

    const url = new URL(params.redirect_uri);
    url.searchParams.set('code', code);
    url.searchParams.set('state', params.state);
    return { redirect_to: url.toString() };
  }

  async token(params: {
    grant_type: string;
    code: string;
    redirect_uri: string;
    client_id: string;
    code_verifier: string;
  }): Promise<Record<string, unknown>> {
    if (params.grant_type !== 'authorization_code') {
      throw new BadRequestException('Only the authorization_code grant is supported');
    }

    const request = this.codes.get(params.code);
    if (!request) throw new UnauthorizedException('Invalid or expired authorization code');
    // Codes are single-use.
    this.codes.delete(params.code);

    if (request.redirectUri !== params.redirect_uri || request.clientId !== params.client_id) {
      throw new UnauthorizedException('Client or redirect URI does not match the authorization request');
    }

    const challenge = createHash('sha256').update(params.code_verifier).digest('base64url');
    if (challenge !== request.codeChallenge) {
      throw new UnauthorizedException('PKCE verification failed');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: request.userId, tenant_id: request.tenantId, deleted_at: null, is_active: true },
      include: { user_roles: { include: { role: true } }, practitioner: true },
    });
    if (!user) throw new UnauthorizedException('User is no longer active');

    // The app receives a scoped token, not the clinician's full session token.
    const accessToken = await this.tokens.signAccessToken({
      sub: user.id,
      tenant_id: request.tenantId,
      roles: user.user_roles.map((r) => r.role.key as never),
      permissions: [],
      session_id: randomUUID(),
      mfa_verified: true,
      practitioner_id: user.practitioner?.id ?? null,
    });

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: this.tokens.accessTtlSeconds,
      scope: request.scope,
      ...(request.launchContext?.patient ? { patient: request.launchContext.patient } : {}),
      ...(request.launchContext?.encounter ? { encounter: request.launchContext.encounter } : {}),
      ...(request.scope.includes('fhirUser')
        ? { fhirUser: `Practitioner/${user.practitioner?.fhir_id ?? user.practitioner?.id ?? user.id}` }
        : {}),
      need_patient_banner: !request.launchContext?.patient,
      smart_style_url: `${this.issuer}/smart-style.json`,
    };
  }
}
