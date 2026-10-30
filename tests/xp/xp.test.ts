import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { xpEvents } from '../../src/db/schema.js';
import { streakFrom } from '../../src/modules/xp/engine.js';
import { levelFor } from '../../src/modules/xp/config.js';
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
const event = (u: User, payload: object) => t.app.inject({ method: 'POST', url: '/api/v1/events', headers: auth(u), payload });
const get = (u: User, url: string) => t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: auth(u) });
const read = (u: User, refId: string, kind = 'regular') =>
  event(u, { type: 'article_complete', refId, metadata: { kind, secondsOnPage: 120, scrollPercent: 95 } });
const daysAgo = (n: number) => new Date(Date.now() - n * 864e5);

describe('POST /events', () => {
  it('rejects a skim, then pays a real read once, plus the daily task once', async () => {
    const u = await signUp(t);
    const skim = await event(u, { type: 'article_complete', refId: 'a1', metadata: { secondsOnPage: 5, scrollPercent: 20 } });
    expect(skim.statusCode).toBe(200);
    expect(skim.json()).toMatchObject({ accepted: false, xpAwarded: 0 });
    expect(skim.json().reason).toMatch(/30 seconds/);

    const first = (await read(u, 'a1')).json();
    expect(first.accepted).toBe(true);
    expect(first.awards).toEqual([
      { type: 'article_read', label: 'Read an article', xp: 1 },
      { type: 'task_bonus', label: 'Read one article', xp: 1 },
    ]);
    expect(first.xpAwarded).toBe(2);

    const again = (await read(u, 'a1', 'magazine')).json();
    expect(again).toMatchObject({ accepted: true, xpAwarded: 0, awards: [] });

    const second = (await read(u, 'a2', 'magazine')).json();
    expect(second.awards).toEqual([{ type: 'magazine_article_read', label: 'Read a magazine article', xp: 2 }]);
    expect(second.xpTotal).toBe(4);
  });

  it('pays webinar attend and complete, the video task, and the first webinar badge', async () => {
    const u = await signUp(t);
    const low = (await event(u, { type: 'webinar_progress', refId: 'w1', metadata: { watchedPercent: 50 } })).json();
    expect(low).toMatchObject({ accepted: false, xpAwarded: 0 });
    const r = (await event(u, { type: 'webinar_progress', refId: 'w1', metadata: { watchedPercent: 96 } })).json();
    expect(r.awards.map((a: { type: string; xp: number }) => [a.type, a.xp])).toEqual([
      ['webinar_attend', 5],
      ['webinar_complete', 10],
      ['task_bonus', 10],
    ]);
    expect(r.newBadges).toEqual([{ id: 'webinar_starter', name: 'Webinar Starter' }]);
  });

  it('pays podcasts at 70%, shares and saves once per item, and research for the task only', async () => {
    const u = await signUp(t);
    expect((await event(u, { type: 'podcast_progress', refId: 'p1', metadata: { listenedPercent: 60 } })).json().accepted).toBe(false);
    const p = (await event(u, { type: 'podcast_progress', refId: 'p1', metadata: { listenedPercent: 75 } })).json();
    expect(p.xpAwarded).toBe(3);
    expect(p.newBadges.map((b: { id: string }) => b.id)).toEqual(['first_listener']);

    const share = { type: 'share', refType: 'news', refId: 'n1', metadata: { channel: 'whatsapp' } };
    expect((await event(u, share)).json().xpAwarded).toBe(4); // +2 share, +2 daily task
    expect((await event(u, share)).json().xpAwarded).toBe(0);

    const save = { type: 'content_save', refType: 'article', refId: 'a9' };
    expect((await event(u, save)).json().xpAwarded).toBe(1);
    expect((await event(u, save)).json().xpAwarded).toBe(0);

    expect((await event(u, { type: 'research_view' })).json().awards).toEqual([{ type: 'task_bonus', label: 'Explore Research Center', xp: 5 }]);
    expect((await event(u, { type: 'report_download', refType: 'report', refId: 'r1' })).json().xpAwarded).toBe(5);
  });

  it('validates the body and refuses server-only event types', async () => {
    const u = await signUp(t);
    expect((await event(u, { type: 'comment', refId: 'x' })).statusCode).toBe(422);
    expect((await event(u, { type: 'nope' })).statusCode).toBe(422);
    expect((await event(u, { type: 'issue_complete', refId: 'bad id!' })).statusCode).toBe(422);
    expect((await event(u, { type: 'podcast_progress', refId: 'p', metadata: { listenedPercent: 140 } })).statusCode).toBe(422);
    expect((await t.app.inject({ method: 'POST', url: '/api/v1/events', payload: { type: 'research_view' } })).statusCode).toBe(401);
  });

  it('reports a level-up', async () => {
    const u = await signUp(t);
    await t.db.insert(xpEvents).values({ userId: u.userId, eventType: 'issue_complete', amount: 99, refType: 'issue', refId: 'seed' });
    const r = (await read(u, 'lvl')).json();
    expect(r.xpTotal).toBe(101);
    expect(r.level).toMatchObject({ number: 2, name: 'Enthusiast', nextLevelXp: 501, xpToNext: 400 });
    expect(r.leveledUp).toBe(true);
  });

  it('pays the 7-day streak bonus once', async () => {
    const u = await signUp(t);
    for (let d = 1; d <= 6; d++) {
      await t.db.insert(xpEvents).values({ userId: u.userId, eventType: 'article_read', amount: 1, refType: 'article', refId: `old${d}`, createdAt: daysAgo(d) });
    }
    const r = (await read(u, 'today')).json();
    expect(r.streak).toEqual({ current: 7, longest: 7 });
    expect(r.awards).toContainEqual({ type: 'streak_bonus', label: '7-day streak', xp: 10 });
    const again = (await read(u, 'today2')).json();
    expect(again.awards.some((a: { type: string }) => a.type === 'streak_bonus')).toBe(false);

    const s = (await get(u, '/me/streak')).json();
    expect(s.current).toBe(7);
    expect(s.activeDates.length).toBeGreaterThan(0);
  });
});

describe('XP from other modules', () => {
  it('caps comment XP at 5 a day and pays the author once per distinct liker', async () => {
    const author = await signUp(t);
    const fan = await signUp(t);
    const xp: number[] = [];
    let firstId = '';
    for (let i = 0; i < 6; i++) {
      const r = await t.app.inject({ method: 'POST', url: '/api/v1/articles/art-xp/comments', headers: auth(author), payload: { text: `c${i}` } });
      xp.push(r.json().xpAwarded);
      firstId ||= r.json().comment.id;
    }
    expect(xp).toEqual([3, 3, 3, 3, 3, 0]);

    const totalBefore = (await get(author, '/me')).json().xpTotal;
    const like = (u: User) => t.app.inject({ method: 'POST', url: `/api/v1/comments/${firstId}/like`, headers: auth(u) });
    const unlike = (u: User) => t.app.inject({ method: 'DELETE', url: `/api/v1/comments/${firstId}/like`, headers: auth(u) });
    await like(author); // self-like: nothing
    await like(fan);
    await unlike(fan);
    await like(fan); // same liker again: nothing
    expect((await get(author, '/me')).json().xpTotal).toBe(totalBefore + 1);

    const reply = await t.app.inject({ method: 'POST', url: `/api/v1/comments/${firstId}/replies`, headers: auth(fan), payload: { text: 'r' } });
    expect(reply.json().xpAwarded).toBe(2);
  });

  it('pays each profile milestone once and interests once', async () => {
    const u = await signUp(t);
    const patch = (payload: object) => t.app.inject({ method: 'PATCH', url: '/api/v1/me/profile', headers: auth(u), payload });
    expect((await patch({ jobTitle: 'CTO' })).json().xpAwarded).toBe(5);
    expect((await patch({ jobTitle: 'CEO' })).json().xpAwarded).toBe(0);
    const all = await patch({
      company: 'Acme',
      location: 'Lahore',
      expertiseAreas: ['AI'],
      linkedinUrl: 'linkedin.com/in/x',
      facebookUrl: 'facebook.com/x',
      instagramUrl: 'instagram.com/x',
      websiteUrl: 'acme.com',
    });
    expect(all.json().xpAwarded).toBe(25); // company 5 + expertise 10 + complete profile 10

    const put = () => t.app.inject({ method: 'PUT', url: '/api/v1/me/interests', headers: auth(u), payload: { topicIds: [1] } });
    expect((await put()).json().xpAwarded).toBe(5);
    expect((await put()).json().xpAwarded).toBe(0);

    const me = (await get(u, '/me')).json();
    expect(me.xpTotal).toBe(35);
    expect(me.level).toEqual({ number: 1, name: 'Explorer' });
  });
});

describe('progress reads', () => {
  it('summarises progress, XP, history, tasks and badges', async () => {
    const u = await signUp(t);
    await read(u, 'p1');
    await t.app.inject({ method: 'POST', url: '/api/v1/articles/p1/comments', headers: auth(u), payload: { text: 'hello' } });

    const p = (await get(u, '/me/progress')).json();
    expect(p).toMatchObject({
      xpTotal: 5,
      level: { number: 1, name: 'Explorer', xpToNext: 96 },
      streak: { current: 1, longest: 1 },
      stats: { xpThisWeek: 5, articlesRead: 1, currentStreak: 1 },
      profileCompletion: 30,
    });
    expect(p.dailyTasks.doneCount).toBe(1);
    expect(p.recentBadges.map((b: { id: string }) => b.id).sort()).toEqual(['conversation_starter', 'first_read']);
    expect(p.nextBadge).not.toBeNull();

    const x = (await get(u, '/me/xp?period=week')).json();
    expect(x.total).toBe(5);
    expect(x.daily).toHaveLength(7);
    expect(x.breakdown).toContainEqual({ type: 'comment', label: 'Comment', count: 1, xpPerUnit: 3, xp: 3 });
    expect((await get(u, '/me/xp?period=month')).json().daily.length).toBeGreaterThanOrEqual(28);

    const h = (await get(u, '/me/history?limit=2')).json();
    expect(h.total).toBe(3);
    expect(h.items).toHaveLength(2);
    const h2 = (await get(u, `/me/history?limit=2&cursor=${h.nextCursor}`)).json();
    expect(h2.items).toHaveLength(1);
    expect([...h.items, ...h2.items].map((i: { label: string }) => i.label).sort()).toEqual(['Comment', 'Daily task: Read one article', 'Read an article']);

    const b = (await get(u, '/badges')).json();
    expect(b).toMatchObject({ earnedCount: 2, totalCount: 13 });
    const reader = b.items.find((i: { id: string }) => i.id === 'reader');
    expect(reader.requirements[0]).toEqual({ label: 'Read 50 articles', current: 1, target: 50, unit: 'articles', percent: 2, complete: false });

    const next = (await get(u, '/me/badges/next')).json();
    expect(next.earned).toBe(false);
  });

  it('ranks the leaderboard and always includes me', async () => {
    const a = await signUp(t);
    const b = await signUp(t);
    const c = await signUp(t);
    await t.db.insert(xpEvents).values([
      { userId: a.userId, eventType: 'issue_complete', amount: 900, refId: 'lb' },
      { userId: b.userId, eventType: 'issue_complete', amount: 800, refId: 'lb' },
    ]);
    const l = (await get(a, '/leaderboard?period=weekly&limit=100')).json();
    const mine = l.items.find((i: { userId: string }) => i.userId === a.userId);
    expect(mine).toMatchObject({ isMe: true, xp: 900, initials: 'AG' });
    const rankOf = (id: string) => l.items.find((i: { userId: string }) => i.userId === id)?.rank;
    expect(rankOf(a.userId)).toBeLessThan(rankOf(b.userId));
    expect(l.items[0].crown).toBe('gold');
    expect(l.me).toMatchObject({ rank: mine.rank, xp: 900, xpThisWeek: 900 });

    const nobody = (await get(c, '/leaderboard')).json();
    expect(nobody.me).toEqual({ rank: null, xp: 0, xpThisWeek: 0 });
  });

  it('serves the rule catalogue without a token', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/v1/xp/rules' });
    expect(r.statusCode).toBe(200);
    expect(r.json().levels).toHaveLength(7);
    expect(r.json().rules).toContainEqual({ type: 'comment', label: 'Comment', xp: 3, dailyCap: 5 });
  });
});

describe('pure helpers', () => {
  it('computes levels at the edges', () => {
    expect(levelFor(0).name).toBe('Explorer');
    expect(levelFor(100).name).toBe('Explorer');
    expect(levelFor(101).name).toBe('Enthusiast');
    expect(levelFor(14999).name).toBe('Sage');
    expect(levelFor(15000)).toMatchObject({ name: 'Visionary', nextLevelXp: null, xpToNext: 0 });
  });

  it('computes streaks, keeping yesterday alive and breaking on a gap', () => {
    expect(streakFrom(['2026-10-29', '2026-10-28'], '2026-10-30')).toMatchObject({ current: 2, longest: 2 });
    expect(streakFrom(['2026-10-27'], '2026-10-30')).toMatchObject({ current: 0, longest: 1 });
    expect(streakFrom(['2026-10-30', '2026-10-28', '2026-10-27', '2026-10-26'], '2026-10-30')).toMatchObject({ current: 1, longest: 3 });
    expect(streakFrom([], '2026-10-30')).toMatchObject({ current: 0, longest: 0, runStart: null });
  });
});
