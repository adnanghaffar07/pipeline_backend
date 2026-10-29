import { describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { createTokenVerifier } from '../../src/lib/token-verifier.js';
import { testConfig, TEST_JWT_SECRET } from '../helpers/test-config.js';

const config = testConfig();
const key = new TextEncoder().encode(TEST_JWT_SECRET);

function token(opts: { sub?: string; aud?: string; iss?: string; exp?: string | number; secret?: Uint8Array } = {}) {
  return new SignJWT({ role: 'authenticated' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(opts.sub ?? 'user-1')
    .setAudience(opts.aud ?? 'authenticated')
    .setIssuer(opts.iss ?? `${config.supabaseUrl}/auth/v1`)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '15m')
    .sign(opts.secret ?? key);
}

describe('token verifier (HS256)', () => {
  const v = createTokenVerifier(config);

  it('accepts a valid token and returns sub', async () => {
    expect(await v.verify(await token())).toEqual({ userId: 'user-1' });
  });

  it.each([
    ['expired', () => token({ exp: Math.floor(Date.now() / 1000) - 10 })],
    ['wrong audience', () => token({ aud: 'anon' })],
    ['wrong issuer', () => token({ iss: 'https://evil.supabase.co/auth/v1' })],
    ['bad signature', () => token({ secret: new TextEncoder().encode('x'.repeat(48)) })],
    ['garbage', async () => 'not-a-jwt'],
  ])('rejects %s with UNAUTHORIZED', async (_name, make) => {
    await expect(v.verify(await make())).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
