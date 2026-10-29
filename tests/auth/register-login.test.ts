import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { profiles } from '../../src/db/schema.js';
import { createTestApp, registerBody, signUp, uniqueEmail, type TestApp } from '../helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const post = (url: string, payload: unknown) => t.app.inject({ method: 'POST', url: `/api/v1/auth${url}`, payload: payload as object });

describe('POST /auth/register', () => {
  it('creates a pending account and emails a code', async () => {
    const email = uniqueEmail();
    const res = await post('/register', registerBody(email));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      challengeId: expect.any(String),
      channel: 'email',
      destinationMasked: expect.stringMatching(/^u\*\*\*\d@example\.com$/),
      resendAvailableInSec: 27,
    });
    const [p] = await t.db.select().from(profiles).where(eq(profiles.email, email));
    expect(p).toMatchObject({ status: 'pending', termsVersion: 'test-terms', phoneE164: '+923001234567', dialCode: '+92' });
    expect(p?.termsAcceptedAt).toBeInstanceOf(Date);
    expect(t.notifier.lastCode(email)).toMatch(/^\d{4}$/);
  });

  it.each([
    ['termsAccepted missing', { termsAccepted: undefined }, 'termsAccepted'],
    ['termsAccepted false', { termsAccepted: false }, 'termsAccepted'],
    ['short password', { password: 'short12' }, 'password'],
    ['bad email', { email: 'not-an-email' }, 'email'],
    ['bad dial code', { dialCode: '92' }, 'dialCode'],
    ['blank name', { fullName: '   ' }, 'fullName'],
  ])('rejects %s with 422 on that field', async (_n, override, field) => {
    const res = await post('/register', registerBody(uniqueEmail(), override));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.fields).toHaveProperty(field);
  });

  it('rejects an invalid mobile with 422 on mobile', async () => {
    const res = await post('/register', registerBody(uniqueEmail(), { mobile: '12' }));
    expect(res.statusCode).toBe(422);
    expect(res.json().error.fields).toHaveProperty('mobile');
  });

  it('rejects an active email with 409 EMAIL_TAKEN', async () => {
    const { email } = await signUp(t);
    const res = await post('/register', registerBody(email));
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('lets a pending registration be restarted with a new password', async () => {
    const email = uniqueEmail();
    await post('/register', registerBody(email, { password: 'first-pass-1' }));
    const again = await post('/register', registerBody(email, { password: 'second-pass-2', fullName: 'Real Owner' }));
    expect(again.statusCode).toBe(201);
    expect(t.auth.byEmail(email)?.password).toBe('second-pass-2');
    const [p] = await t.db.select().from(profiles).where(eq(profiles.email, email));
    expect(p?.fullName).toBe('Real Owner');
  });

  it('re-registering invalidates the earlier sign-up code', async () => {
    const email = uniqueEmail();
    const first = await post('/register', registerBody(email, { password: 'victim-pass-1' }));
    const firstCode = t.notifier.lastCode(email);
    const second = await post('/register', registerBody(email, { password: 'attacker-pass-2' }));
    const stale = await post('/otp/verify', { challengeId: first.json().challengeId, code: firstCode });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('OTP_ALREADY_USED');
    const fresh = await post('/otp/verify', { challengeId: second.json().challengeId, code: t.notifier.lastCode(email) });
    expect(fresh.statusCode).toBe(200);
  });

  it('returns 503 EMAIL_DELIVERY_FAILED when email sending fails', async () => {
    t.notifier.failNext();
    const res = await post('/register', registerBody(uniqueEmail()));
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('EMAIL_DELIVERY_FAILED');
  });

  it('never echoes the password', async () => {
    const res = await post('/register', registerBody(uniqueEmail(), { password: 'very-secret-pw' }));
    expect(res.body).not.toContain('very-secret-pw');
    expect(res.body).not.toContain('code_hash');
  });
});

describe('POST /auth/otp/verify (signup)', () => {
  it('activates the account and returns tokens with isNewUser', async () => {
    const email = uniqueEmail();
    const reg = await post('/register', registerBody(email));
    const res = await post('/otp/verify', { challengeId: reg.json().challengeId, code: t.notifier.lastCode(email) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      expiresIn: 900,
      isNewUser: true,
      user: {
        id: expect.any(String),
        fullName: 'Adnan Ghaffar',
        email,
        avatarUrl: null,
        xpTotal: 0,
        level: { number: 1, name: 'Explorer' },
        subscription: { status: 'free' },
      },
    });
    const [p] = await t.db.select().from(profiles).where(eq(profiles.email, email));
    expect(p?.status).toBe('active');
    expect(t.auth.byEmail(email)?.confirmed).toBe(true);
  });

  it.each([
    ['numeric code', 42],
    ['short string code', '42'],
    ['letters', 'abcd'],
  ])('rejects %s with 422', async (_n, code) => {
    const res = await post('/otp/verify', { challengeId: crypto.randomUUID(), code });
    expect(res.statusCode).toBe(422);
  });

  it('accepts a code with leading zeros', async () => {
    const res = await post('/otp/verify', { challengeId: crypto.randomUUID(), code: '0042' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CHALLENGE_NOT_FOUND');
  });

  it('wrong code is 400 OTP_INVALID with attemptsRemaining', async () => {
    const email = uniqueEmail();
    const reg = await post('/register', registerBody(email));
    const good = t.notifier.lastCode(email);
    const res = await post('/otp/verify', { challengeId: reg.json().challengeId, code: good === '1111' ? '2222' : '1111' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'OTP_INVALID', attemptsRemaining: 4 });
  });
});

describe('POST /auth/login', () => {
  it('handles email casing and whitespace across register and login', async () => {
    const raw = ` Mixed.Case${Date.now()}@Example.COM `;
    const { email } = await signUp(t, raw);
    const res = await post('/login', { email: email, password: 'correct-horse-9' });
    expect(res.statusCode).toBe(200);
    const upper = await post('/login', { email: email.toUpperCase(), password: 'correct-horse-9' });
    expect(upper.statusCode).toBe(200);
  });

  it('sends a login code, revokes the password-check session, and verify returns isNewUser false', async () => {
    const { email } = await signUp(t);
    const before = t.auth.sessions.length;
    const res = await post('/login', { email, password: 'correct-horse-9' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ otpRequired: true, challengeId: expect.any(String), channel: 'email' });
    const checkSession = t.auth.sessions[before];
    expect(checkSession && t.auth.isRevoked(checkSession.accessToken)).toBe(true);

    const v = await post('/otp/verify', { challengeId: res.json().challengeId, code: t.notifier.lastCode(email) });
    expect(v.statusCode).toBe(200);
    expect(v.json().isNewUser).toBe(false);
  });

  it('rejects a pending account with 403 ACCOUNT_NOT_VERIFIED', async () => {
    const email = uniqueEmail();
    await post('/register', registerBody(email));
    const res = await post('/login', { email, password: 'correct-horse-9' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ACCOUNT_NOT_VERIFIED');
  });

  it('gives the same 401 for a wrong password and an unknown email', async () => {
    const { email } = await signUp(t);
    const wrong = await post('/login', { email, password: 'wrong-password' });
    const unknown = await post('/login', { email: uniqueEmail('ghost'), password: 'wrong-password' });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
    expect(wrong.json().error.code).toBe('INVALID_CREDENTIALS');
  });

  it('returns 503 AUTH_PROVIDER_UNAVAILABLE when Supabase is down', async () => {
    const { email } = await signUp(t);
    t.auth.failNext();
    const res = await post('/login', { email, password: 'correct-horse-9' });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('AUTH_PROVIDER_UNAVAILABLE');
  });

  it('rejects a password_reset challenge at /otp/verify with 400 WRONG_CHALLENGE', async () => {
    const { email } = await signUp(t);
    const f = await post('/password/forgot', { email });
    const res = await post('/otp/verify', { challengeId: f.json().challengeId, code: t.notifier.lastCode(email) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('WRONG_CHALLENGE');
  });
});

describe('client IP handling', () => {
  it('ignores an unparseable forwarded address instead of failing the request', async () => {
    const t4 = await createTestApp({ trustProxy: true });
    try {
      const email = uniqueEmail();
      const res = await t4.app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { 'x-forwarded-for': 'not-an-ip' },
        payload: registerBody(email),
      });
      expect(res.statusCode).toBe(201);
    } finally {
      await t4.close();
    }
  });
});

describe('login without OTP', () => {
  it('returns tokens directly when LOGIN_OTP_REQUIRED=false', async () => {
    const t2 = await createTestApp({ loginOtpRequired: false });
    try {
      const { email } = await signUp(t2);
      const res = await t2.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'correct-horse-9' } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ otpRequired: false, accessToken: expect.any(String), isNewUser: false });
    } finally {
      await t2.close();
    }
  });
});

describe('rate limits', () => {
  it('limits login attempts per email', async () => {
    const t3 = await createTestApp({ rateLimit: { globalPerMinute: 1000, authPerMinute: 1000, loginPerEmailPer15Min: 3 } });
    try {
      const email = uniqueEmail();
      const codes: number[] = [];
      for (let i = 0; i < 4; i++) {
        codes.push((await t3.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: 'x' } })).statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 429]);
      const other = await t3.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: uniqueEmail(), password: 'x' } });
      expect(other.statusCode).toBe(401);
    } finally {
      await t3.close();
    }
  });

  it('resend right away is 429 OTP_RESEND_TOO_SOON', async () => {
    const email = uniqueEmail();
    const reg = await post('/register', registerBody(email));
    const res = await post('/otp/resend', { challengeId: reg.json().challengeId });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toMatchObject({ code: 'OTP_RESEND_TOO_SOON', retryAfterSec: expect.any(Number) });
  });
});
