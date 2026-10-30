import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { profiles, xpEvents } from '../../src/db/schema.js';
import { localDay } from '../../src/modules/xp/engine.js';
import { createTestApp, signUp, type TestApp } from '../helpers/test-app.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});

type User = Awaited<ReturnType<typeof signUp>>;
const auth = (u: User) => ({ authorization: `Bearer ${u.accessToken}` });
const call = (u: User, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
  t.app.inject({ method, url: `/api/v1${url}`, headers: auth(u), ...(payload ? { payload } : {}) });
const read = (u: User, refId: string) =>
  call(u, 'POST', '/events', { type: 'article_complete', refId, metadata: { secondsOnPage: 120, scrollPercent: 95 } });

async function makeAdmin() {
  const a = await signUp(t);
  await t.db.update(profiles).set({ role: 'admin' }).where(eq(profiles.id, a.userId));
  return a;
}

describe('time zones', () => {
  it('counts streak days in the user’s time zone', async () => {
    const u = await signUp(t);
    // 20:00 UTC on 1 Jan is already 2 Jan in Karachi (UTC+5).
    await t.db.insert(xpEvents).values({ userId: u.userId, eventType: 'article_read', amount: 1, refId: 'tz', createdAt: new Date('2026-01-01T20:00:00Z') });
    const utc = (await call(u, 'GET', '/me/streak?year=2026&month=1')).json();
    expect(utc).toMatchObject({ timezone: 'UTC', activeDates: ['2026-01-01'] });

    const set = await call(u, 'PATCH', '/me/settings', { timezone: 'Asia/Karachi' });
    expect(set.json()).toMatchObject({ timezone: 'Asia/Karachi', showOnLeaderboard: true });
    const pk = (await call(u, 'GET', '/me/streak?year=2026&month=1')).json();
    expect(pk).toMatchObject({ timezone: 'Asia/Karachi', activeDates: ['2026-01-02'] });

    expect((await call(u, 'PATCH', '/me/settings', { timezone: 'Mars/Olympus' })).statusCode).toBe(422);
    expect((await call(u, 'PATCH', '/me/settings', { timezone: null })).json().timezone).toBeNull();
  });

  it('formats local days', () => {
    expect(localDay(new Date('2026-01-01T20:00:00Z'), 'Asia/Karachi')).toBe('2026-01-02');
    expect(localDay(new Date('2026-01-01T20:00:00Z'))).toBe('2026-01-01');
    expect(localDay(new Date('2026-01-01T03:00:00Z'), 'America/New_York')).toBe('2025-12-31');
  });
});

describe('comment XP quality', () => {
  it('pays nothing for a too-short comment but still counts it', async () => {
    const u = await signUp(t);
    const r = await call(u, 'POST', '/articles/q1/comments', { text: 'ok' });
    expect(r.statusCode).toBe(201);
    expect(r.json().xpAwarded).toBe(0);
    const badges = (await call(u, 'GET', '/badges')).json();
    expect(badges.items.find((b: { id: string }) => b.id === 'conversation_starter').earned).toBe(true);
  });

  it('stops paying for a burst of likes from one person', async () => {
    const author = await signUp(t);
    const fan = await signUp(t);
    const ids: string[] = [];
    for (let i = 0; i < 7; i++) {
      ids.push((await call(author, 'POST', '/articles/burst/comments', { text: `Burst comment number ${i}` })).json().comment.id);
    }
    const before = (await call(author, 'GET', '/me')).json().xpTotal;
    for (const id of ids) await call(fan, 'POST', `/comments/${id}/like`);
    expect((await call(author, 'GET', '/me')).json().xpTotal).toBe(before + 5);
  });
});

describe('leaderboard privacy', () => {
  it('hides opted-out members from everyone and tells them so', async () => {
    const shy = await signUp(t);
    const other = await signUp(t);
    await t.db.insert(xpEvents).values([
      { userId: shy.userId, eventType: 'issue_complete', amount: 500, refId: 'lbp' },
      { userId: other.userId, eventType: 'issue_complete', amount: 10, refId: 'lbp' },
    ]);
    await call(shy, 'PATCH', '/me/settings', { showOnLeaderboard: false });

    const seen = (await call(other, 'GET', '/leaderboard?limit=100')).json();
    expect(seen.items.some((i: { userId: string }) => i.userId === shy.userId)).toBe(false);
    const mine = (await call(shy, 'GET', '/leaderboard')).json();
    expect(mine.me).toMatchObject({ rank: null, xp: 500, hidden: true });
  });
});

describe('admin', () => {
  it('is admin-only', async () => {
    const u = await signUp(t);
    expect((await call(u, 'GET', '/admin/xp/config')).statusCode).toBe(403);
    expect((await call(u, 'POST', '/admin/xp/reversals', { eventId: crypto.randomUUID(), reason: 'nope' })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/admin/xp/config' })).statusCode).toBe(401);
  });

  it('reverses an award once and hides it from badge progress', async () => {
    const admin = await makeAdmin();
    const u = await signUp(t);
    await read(u, 'rev1');
    const events = (await call(admin, 'GET', `/admin/xp/events?userId=${u.userId}`)).json();
    const award = events.items.find((e: { type: string }) => e.type === 'article_read');
    expect(award).toMatchObject({ userId: u.userId, xp: 1 });

    const r = await call(admin, 'POST', '/admin/xp/reversals', { eventId: award.id, reason: 'Bot traffic' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ userId: u.userId, xpRemoved: 1, xpTotal: 1 });
    expect((await call(admin, 'POST', '/admin/xp/reversals', { eventId: award.id, reason: 'again' })).json().error.code).toBe('ALREADY_REVERSED');
    expect((await call(admin, 'POST', '/admin/xp/reversals', { eventId: crypto.randomUUID(), reason: 'none' })).statusCode).toBe(404);

    const h = (await call(u, 'GET', '/me/history')).json();
    expect(h.items[0]).toMatchObject({ type: 'reversal', xp: -1, reason: 'Bot traffic', label: 'XP adjustment' });
    const reader = (await call(u, 'GET', '/badges')).json().items.find((b: { id: string }) => b.id === 'reader');
    expect(reader.requirements[0].current).toBe(0);
  });

  it('changes rules, levels, badges and names at runtime, then resets', async () => {
    const admin = await makeAdmin();
    const put = (body: object) => call(admin, 'PUT', '/admin/xp/config', body);

    expect((await put({ rules: { streak_bonus: { xp: 5 } } })).statusCode).toBe(422);
    expect((await put({ levels: [{ name: 'A', minXp: 10 }] })).statusCode).toBe(422);
    expect((await put({ bogus: true })).statusCode).toBe(422);

    const ok = await put({
      rules: { article_read: { xp: 7 }, comment: { dailyCap: null } },
      levels: [
        { name: 'Rookie', minXp: 0 },
        { name: 'Pro', minXp: 5 },
      ],
      badges: { reader: { target: 2, iconUrl: 'https://cdn.example.com/reader.png' } },
      leaderboard: { nameStyle: 'first_initial' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().override.rules.article_read).toEqual({ xp: 7 });

    const rules = (await t.app.inject({ method: 'GET', url: '/api/v1/xp/rules' })).json();
    expect(rules.rules).toContainEqual({ type: 'article_read', label: 'Read an article', xp: 7, dailyCap: null });
    expect(rules.rules).toContainEqual({ type: 'comment', label: 'Comment', xp: 3, dailyCap: null });
    expect(rules.levels).toEqual([
      { number: 1, name: 'Rookie', minXp: 0 },
      { number: 2, name: 'Pro', minXp: 5 },
    ]);

    const u = await signUp(t);
    const r = (await read(u, 'cfg1')).json();
    expect(r.awards[0]).toMatchObject({ type: 'article_read', xp: 7 });
    expect(r).toMatchObject({ leveledUp: true, level: { name: 'Pro' } });
    expect((await call(u, 'GET', '/me')).json().level).toEqual({ number: 2, name: 'Pro' });

    const reader = (await call(u, 'GET', '/badges')).json().items.find((b: { id: string }) => b.id === 'reader');
    expect(reader).toMatchObject({ description: 'Read 2 articles', iconUrl: 'https://cdn.example.com/reader.png' });
    expect(reader.requirements[0]).toMatchObject({ target: 2, label: 'Read 2 articles' });

    const viewer = await signUp(t);
    const lb = (await call(viewer, 'GET', '/leaderboard?limit=100')).json();
    expect(lb.items.find((i: { userId: string }) => i.userId === u.userId).name).toBe('Adnan G.');

    const reset = await put({});
    expect(reset.json().override).toEqual({});
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/xp/rules' })).json().levels).toHaveLength(7);
  });
});
