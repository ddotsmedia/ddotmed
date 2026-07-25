import { randomUUID, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { JwtPayload, Permission, Role } from '@medicore/shared-types';

/** Accepts "15m" / "7d" / plain seconds and normalises to seconds. */
function parseDuration(value: string): number {
  const m = /^(\d+)\s*([smhd])?$/.exec(value.trim());
  if (!m) return 900;
  const mult = { s: 1, m: 60, h: 3600, d: 86400 }[(m[2] ?? 's') as 's' | 'm' | 'h' | 'd'];
  return Number(m[1]) * mult;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'Bearer';
}

export interface AccessTokenClaims {
  sub: string;
  tenant_id: string;
  roles: Role[];
  permissions: Permission[];
  session_id: string;
  mfa_verified: boolean;
  practitioner_id?: string | null;
  patient_id?: string | null;
  break_glass?: boolean;
}

/**
 * RS256 asymmetric signing: the API signs with the private key, and any downstream
 * service (ai-service, FHIR facade) verifies with the public key alone.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly privateKey: string;
  readonly publicKey: string;
  private readonly accessTtl: number;
  private readonly refreshTtlSeconds: number;
  private readonly issuer: string;
  private readonly audience: string;

  constructor(
    private readonly jwt: JwtService,
    config: ConfigService,
  ) {
    const priv = config.get<string>('JWT_PRIVATE_KEY');
    const pub = config.get<string>('JWT_PUBLIC_KEY');

    if (priv && pub) {
      this.privateKey = priv.replace(/\\n/g, '\n');
      this.publicKey = pub.replace(/\\n/g, '\n');
    } else {
      // Ephemeral dev keypair. Restarting invalidates issued tokens, which is the
      // intended behaviour — production must supply JWT_PRIVATE_KEY/JWT_PUBLIC_KEY.
      if (config.get('NODE_ENV') === 'production') {
        throw new Error('JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required in production');
      }
      this.logger.warn('No RS256 keypair configured — generating an ephemeral development keypair');
      const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      this.privateKey = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      this.publicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    }

    createPrivateKey(this.privateKey);
    createPublicKey(this.publicKey);

    this.accessTtl = parseDuration(config.get<string>('JWT_ACCESS_TTL') ?? '15m');
    this.refreshTtlSeconds = Number(config.get('JWT_REFRESH_TTL_SECONDS') ?? 60 * 60 * 24 * 7);
    this.issuer = config.get<string>('JWT_ISSUER') ?? 'medicore';
    this.audience = config.get<string>('JWT_AUDIENCE') ?? 'medicore-api';
  }

  async signAccessToken(claims: AccessTokenClaims): Promise<string> {
    return this.jwt.signAsync(claims, {
      algorithm: 'RS256',
      privateKey: this.privateKey,
      expiresIn: this.accessTtl,
      issuer: this.issuer,
      audience: this.audience,
    });
  }

  async signRefreshToken(userId: string, tenantId: string, jti: string): Promise<string> {
    return this.jwt.signAsync(
      { sub: userId, tenant_id: tenantId, jti, typ: 'refresh' },
      {
        algorithm: 'RS256',
        privateKey: this.privateKey,
        expiresIn: this.refreshTtlSeconds,
        issuer: this.issuer,
        audience: this.audience,
      },
    );
  }

  async verify<T extends object = JwtPayload>(token: string): Promise<T> {
    return this.jwt.verifyAsync<T>(token, {
      algorithms: ['RS256'],
      publicKey: this.publicKey,
      issuer: this.issuer,
      audience: this.audience,
    });
  }

  newJti(): string {
    return randomUUID();
  }

  get refreshExpiresAt(): Date {
    return new Date(Date.now() + this.refreshTtlSeconds * 1000);
  }

  get accessTtlSeconds(): number {
    return this.accessTtl;
  }

  /** JWKS document so other services can verify tokens without sharing the private key. */
  jwks(): { keys: object[] } {
    const key = createPublicKey(this.publicKey).export({ format: 'jwk' }) as Record<string, string>;
    return { keys: [{ ...key, use: 'sig', alg: 'RS256', kid: 'medicore-1' }] };
  }
}
