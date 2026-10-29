import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { otpChallenges } from '../../src/db/schema.js';
import { OtpService, generateCode, hashCode } from '../../src/modules/auth/otp.js';
import { createTestDb, insertAuthUser, type TestDb } from '../helpers/test-db.js';
import { FakeNotifier } from '../helpers/fakes.js';
import { testConfig } from '../helpers/test-config.js';

let t: TestDb;
let notifier: FakeNotifier;
let clock: Date;
let otp: OtpService;
let userId: string;
let email: string;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  notifier = new FakeNotifier();
  clock = new Date('2026-10-29T10:00:00Z');
  otp = new OtpService(t.db, notifier, testConfig(), () => clock);
  userId = randomUUID();
  email = `${userId}@example.com`;
  await insertAuthUser(t.db, userId, email);
});

const advance = (sec: number) => {
  clock = new Date(clock.getTime() + sec * 1000);
};
const issue = () => otp.issue({ userId, purpose: 'login', channel: 'email', destination: email, ip: '203.0.113.9' });
const wrongCode = (code: string) => (code === '0000' ? '0001' : '0000');
const errorCode = async (p: Promise<unknown>) => p.then(() => 'resolved', (e: { code?: string }) => e.code);

describe('code helpers', () => {
  it('generates 4 digit codes including leading zeros', () => {
    const codes = new Set(Array.from({ length: 2000 }, generateCode));
    for (const c of codes) expect(c).toMatch(/^\d{4}$/);
    expect([...codes].some((c) => c.startsWith('0'))).toBe(true);
  });

  it('hashes with the secret', () => {
    expect(hashCode('1234', 'a'.repeat(32))).not.toBe(hashCode('1234', 'b'.repeat(32)));
  });
});

describe('OtpService', () => {
  it('stores a hash, never the code, and sends the code', async () => {
    const info = await issue();
    const code = notifier.lastCode(email);
    expect(code).toMatch(/^\d{4}$/);
    const [row] = await t.db.select().from(otpChallenges).where(eq(otpChallenges.id, info.challengeId));
    expect(row?.codeHash).not.toContain(code);
    expect(row?.codeHash).toHaveLength(64);
    expect(info).toEqual({
      challengeId: expect.any(String),
      channel: 'email',
      destinationMasked: expect.stringContaining('***'),
      resendAvailableInSec: 27,
    });
  });

  it('verify succeeds with the right code and consumes the challenge', async () => {
    const { challengeId } = await issue();
    expect(await otp.verify(challengeId, notifier.lastCode(email))).toEqual({ userId, purpose: 'login' });
    const [row] = await t.db.select().from(otpChallenges).where(eq(otpChallenges.id, challengeId));
    expect(row?.consumedAt).not.toBeNull();
  });

  it('second verify of a consumed challenge is OTP_ALREADY_USED', async () => {
    const { challengeId } = await issue();
    const code = notifier.lastCode(email);
    const results = await Promise.allSettled([otp.verify(challengeId, code), otp.verify(challengeId, code)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await errorCode(otp.verify(challengeId, code))).toBe('OTP_ALREADY_USED');
  });

  it('counts wrong attempts down and locks after 5', async () => {
    const { challengeId } = await issue();
    const good = notifier.lastCode(email);
    for (const remaining of [4, 3, 2, 1]) {
      await expect(otp.verify(challengeId, wrongCode(good))).rejects.toMatchObject({
        code: 'OTP_INVALID',
        extra: { attemptsRemaining: remaining },
      });
    }
    expect(await errorCode(otp.verify(challengeId, wrongCode(good)))).toBe('OTP_LOCKED');
    expect(await errorCode(otp.verify(challengeId, good))).toBe('OTP_LOCKED');
  });

  it('expires after 300 seconds', async () => {
    const { challengeId } = await issue();
    advance(301);
    expect(await errorCode(otp.verify(challengeId, notifier.lastCode(email)))).toBe('OTP_EXPIRED');
  });

  it('resend before the cooldown is OTP_RESEND_TOO_SOON with retryAfterSec', async () => {
    const { challengeId } = await issue();
    advance(10);
    await expect(otp.resend(challengeId)).rejects.toMatchObject({
      code: 'OTP_RESEND_TOO_SOON',
      extra: { retryAfterSec: 17 },
    });
  });

  it('resend after 27 s issues a new code and resets expiry', async () => {
    const { challengeId } = await issue();
    const first = notifier.lastCode(email);
    advance(290);
    const info = await otp.resend(challengeId);
    expect(info.challengeId).toBe(challengeId);
    const second = notifier.lastCode(email);
    advance(60); // 350 s after the first issue, 60 s after the resend
    if (first !== second) expect(await errorCode(otp.verify(challengeId, first))).toBe('OTP_INVALID');
    expect(await otp.verify(challengeId, second)).toMatchObject({ userId });
  });

  it('allows 5 resends then OTP_RATE_LIMITED', async () => {
    const { challengeId } = await issue();
    for (let i = 0; i < 5; i++) {
      advance(27);
      await otp.resend(challengeId);
    }
    advance(27);
    expect(await errorCode(otp.resend(challengeId))).toBe('OTP_RATE_LIMITED');
  });

  it('caps a destination at 10 challenges per hour', async () => {
    for (let i = 0; i < 10; i++) await issue();
    expect(await errorCode(issue())).toBe('OTP_RATE_LIMITED');
    advance(3601);
    await expect(issue()).resolves.toBeDefined();
  });

  it('unknown or malformed ids are CHALLENGE_NOT_FOUND', async () => {
    expect(await errorCode(otp.verify(randomUUID(), '1234'))).toBe('CHALLENGE_NOT_FOUND');
    expect(await errorCode(otp.verify('not-a-uuid', '1234'))).toBe('CHALLENGE_NOT_FOUND');
    expect(await errorCode(otp.resend('not-a-uuid'))).toBe('CHALLENGE_NOT_FOUND');
  });

  it('notifier failure surfaces EMAIL_DELIVERY_FAILED and leaves no usable challenge', async () => {
    notifier.failNext();
    expect(await errorCode(issue())).toBe('EMAIL_DELIVERY_FAILED');
    expect(await t.db.select().from(otpChallenges).where(eq(otpChallenges.destination, email))).toHaveLength(0);
  });

  it('deliver:false stores a challenge without sending anything', async () => {
    const info = await otp.issue({ userId: null, purpose: 'password_reset', channel: 'email', destination: email, deliver: false });
    expect(notifier.sent).toHaveLength(0);
    expect(info.challengeId).toBeDefined();
  });
});
