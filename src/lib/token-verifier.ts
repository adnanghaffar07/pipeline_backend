import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Config } from '../config.js';
import { AppError } from './errors.js';

export interface TokenVerifier {
  /** Throws AppError UNAUTHORIZED for any invalid, expired or foreign token. */
  verify(token: string): Promise<{ userId: string }>;
}

/**
 * Verifies Supabase access tokens locally (no network call per request).
 * Uses the project's JWKS (asymmetric signing keys) unless a legacy HS256 secret is configured.
 */
export function createTokenVerifier(config: Config): TokenVerifier {
  const issuer = `${config.supabaseUrl}/auth/v1`;
  const key: Uint8Array | JWTVerifyGetKey = config.supabaseJwtSecret
    ? new TextEncoder().encode(config.supabaseJwtSecret)
    : createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cacheMaxAge: 10 * 60 * 1000 });

  return {
    async verify(token) {
      try {
        const { payload } = await jwtVerify(token, key as Uint8Array, { issuer, audience: 'authenticated' });
        if (!payload.sub) throw new Error('missing sub');
        return { userId: payload.sub };
      } catch {
        throw new AppError('UNAUTHORIZED', 'Invalid or expired access token');
      }
    },
  };
}
