import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { profiles } from '../../src/db/schema.js';
import { createTestApp, registerBody, signUp, uniqueEmail, type TestApp } from '../helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const post = (url: string, payload?: unknown, token?: string) =>
  t.app.inject({
    method: 'POST',
    url: `/api/v1/auth${url}`,
    ...(payload !== undefined ? { payload: payload as object } : {}),
    ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}),
  });

describe('POST /auth/refresh', () => {
  it('returns new tokens and rotates the refresh token', async () => {
    const { refreshToken } = await signUp(t);
    const res = await post('/refresh', { refreshToken });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String), expiresIn: 900 });
    expect(res.json().refreshToken).not.toBe(refreshToken);
    expect((await post('/refresh', { refreshToken })).statusCode).toBe(401);
  });

  it('rejects an unknown refresh token with 401 INVALID_REFRESH_TOKEN', async () => {
    const res = await post('/refresh', { refreshToken: 'rt_nope' });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_REFRESH_TOKEN');
  });
});

describe('POST /auth/logout', () => {
  it('requires a bearer token', async () => {
    const res = await post('/logout');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a malformed authorization header', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { authorization: 'Token abc' } });
    expect(res.statusCode).toBe(401);
  });

  it('revokes the session and returns 204', async () => {
    const { accessToken, refreshToken } = await signUp(t);
    const res = await post('/logout', undefined, accessToken);
    expect(res.statusCode).toBe(204);
    expect(t.auth.isRevoked(accessToken)).toBe(true);
    expect((await post('/refresh', { refreshToken })).statusCode).toBe(401);
  });
});

describe('password reset', () => {
  it('emails a reset code to an active account', async () => {
    const { email } = await signUp(t);
    const res = await post('/password/forgot', { email });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ challengeId: expect.any(String), channel: 'email' });
    expect(t.notifier.sent.at(-1)).toMatchObject({ destination: email, purpose: 'password_reset' });
  });

  it('answers identically for unknown and pending emails without sending anything', async () => {
    const pending = uniqueEmail('pending');
    await post('/register', registerBody(pending));
    const sentBefore = t.notifier.sent.length;
    for (const email of [uniqueEmail('ghost'), pending]) {
      const res = await post('/password/forgot', { email });
      expect(res.statusCode).toBe(200);
      expect(Object.keys(res.json()).sort()).toEqual(['challengeId', 'channel', 'destinationMasked', 'resendAvailableInSec']);
    }
    expect(t.notifier.sent.length).toBe(sentBefore);
  });

  it('resets the password and signs out every device', async () => {
    const { email, userId } = await signUp(t);
    await t.db.execute(sql`insert into auth.sessions (user_id) values (${userId}), (${userId})`);
    const f = await post('/password/forgot', { email });
    const res = await post('/password/reset', {
      challengeId: f.json().challengeId,
      code: t.notifier.lastCode(email),
      newPassword: 'brand-new-pass-1',
    });
    expect(res.statusCode).toBe(204);
    expect(t.auth.byEmail(email)?.password).toBe('brand-new-pass-1');
    const left = await t.db.execute<{ n: number }>(sql`select count(*)::int as n from auth.sessions where user_id = ${userId}`);
    expect((left as unknown as { rows: { n: number }[] }).rows[0]?.n).toBe(0);

    expect((await post('/login', { email, password: 'correct-horse-9' })).statusCode).toBe(401);
    expect((await post('/login', { email, password: 'brand-new-pass-1' })).statusCode).toBe(200);
  });

  it('a decoy challenge for an unknown email never resets anything', async () => {
    const f = await post('/password/forgot', { email: uniqueEmail('ghost') });
    for (const code of ['0000', '1234', '9999']) {
      const res = await post('/password/reset', { challengeId: f.json().challengeId, code, newPassword: 'whatever-123' });
      expect(res.statusCode).toBe(400);
      expect(['OTP_INVALID']).toContain(res.json().error.code);
    }
  });

  it('rejects a short new password with 422', async () => {
    const res = await post('/password/reset', { challengeId: randomUUID(), code: '1234', newPassword: 'short' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.fields).toHaveProperty('newPassword');
  });

  it('rejects a login challenge with 400 WRONG_CHALLENGE', async () => {
    const { email } = await signUp(t);
    const l = await post('/login', { email, password: 'correct-horse-9' });
    const res = await post('/password/reset', {
      challengeId: l.json().challengeId,
      code: t.notifier.lastCode(email),
      newPassword: 'brand-new-pass-1',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('WRONG_CHALLENGE');
  });
});

describe('POST /auth/oauth/:provider', () => {
  it('creates an active profile on first Google sign-in', async () => {
    const email = uniqueEmail('google');
    const res = await post('/oauth/google', { idToken: `valid:${email}:` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ isNewUser: true, user: { email, fullName: email.split('@')[0] } });
    const [p] = await t.db.select().from(profiles).where(eq(profiles.email, email));
    expect(p?.status).toBe('active');

    const again = await post('/oauth/google', { idToken: `valid:${email}:` });
    expect(again.json().isNewUser).toBe(false);
  });

  it('maps microsoft to the azure provider and uses the provider name', async () => {
    const email = uniqueEmail('ms');
    const res = await post('/oauth/microsoft', { idToken: `valid:${email}:Ms User` });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.fullName).toBe('Ms User');
    expect(t.auth.idTokenCalls.at(-1)?.provider).toBe('azure');
  });

  it('activates a pending registration for the same email', async () => {
    const email = uniqueEmail('pend');
    await post('/register', registerBody(email));
    const res = await post('/oauth/google', { idToken: `valid:${email}:` });
    expect(res.statusCode).toBe(200);
    const [p] = await t.db.select().from(profiles).where(eq(profiles.email, email));
    expect(p?.status).toBe('active');
  });

  it('rejects linkedin with 422', async () => {
    expect((await post('/oauth/linkedin', { idToken: 'valid:x@y.com:' })).statusCode).toBe(422);
  });

  it('rejects a bad provider token with 401', async () => {
    const res = await post('/oauth/google', { idToken: 'forged' });
    expect(res.statusCode).toBe(401);
  });
});
