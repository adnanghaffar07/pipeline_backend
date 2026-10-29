import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { otpChallenges, profiles, userInterests } from '../../src/db/schema.js';
import { createTestApp, signUp, type TestApp } from '../helpers/test-app.js';
import { signTestToken } from '../helpers/fakes.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

const me = (method: 'GET' | 'DELETE', token?: string) =>
  t.app.inject({ method, url: '/api/v1/me', ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });

describe('GET /me', () => {
  it('returns the user with default progress and subscription', async () => {
    const { accessToken, userId, email } = await signUp(t);
    const res = await me('GET', accessToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      id: userId,
      fullName: 'Adnan Ghaffar',
      email,
      avatarUrl: null,
      xpTotal: 0,
      level: { number: 1, name: 'Explorer' },
      subscription: { status: 'free' },
      unreadNotifications: 0,
    });
  });

  it('requires a token', async () => {
    expect((await me('GET')).statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    const { userId } = await signUp(t);
    const expired = await signTestToken(userId, Math.floor(Date.now() / 1000) - 5);
    const res = await me('GET', expired);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });

  it('rejects a still-valid token after the account was deleted', async () => {
    const { accessToken, userId } = await signUp(t);
    await t.auth.deleteUser(userId);
    const res = await me('GET', accessToken);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('UNAUTHORIZED');
  });
});

describe('DELETE /me', () => {
  it('deletes the account and all of its data', async () => {
    const { accessToken, userId } = await signUp(t);
    await t.app.inject({
      method: 'PUT',
      url: '/api/v1/me/interests',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { topicIds: [1, 2] },
    });

    const res = await me('DELETE', accessToken);
    expect(res.statusCode).toBe(204);
    expect(t.auth.users.has(userId)).toBe(false);
    expect(await t.db.select().from(profiles).where(eq(profiles.id, userId))).toHaveLength(0);
    expect(await t.db.select().from(userInterests).where(eq(userInterests.userId, userId))).toHaveLength(0);
    expect(await t.db.select().from(otpChallenges).where(eq(otpChallenges.userId, userId))).toHaveLength(0);
    expect((await me('GET', accessToken)).statusCode).toBe(401);
  });
});
