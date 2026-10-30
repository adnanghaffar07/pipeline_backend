import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { exportPKCS8, generateKeyPair } from 'jose';
import { devices, profiles } from '../../src/db/schema.js';
import { FcmPush } from '../../src/integrations/push.js';
import { loadConfig } from '../../src/config.js';
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

let n = 0;
async function member(name?: string) {
  const u = await signUp(t);
  n += 1;
  await t.db.update(profiles).set({ fullName: name ?? `Person${n} Notify${n}`, jobTitle: 'Engineer', company: 'Acme' }).where(eq(profiles.id, u.userId));
  return u;
}
const token = (label: string) => `fcm-token-${label}-${'x'.repeat(30)}`;
const feed = async (u: User, qs = '') => (await call(u, 'GET', `/notifications${qs}`)).json();

describe('networking alerts', () => {
  it('notifies on request and on accept, and retracts the handled request', async () => {
    const a = await member('Alice Sender');
    const b = await member('Bob Receiver');
    await call(b, 'POST', '/devices', { token: token('bob'), platform: 'android' });

    const sent = (await call(a, 'POST', '/connections', { toUserId: b.userId })).json();
    const bf = await feed(b);
    expect(bf.unreadCount).toBe(1);
    expect(bf.items[0]).toMatchObject({
      type: 'connection_request',
      label: 'Networking',
      title: 'Alice Sender wants to connect',
      description: 'Engineer at Acme',
      target: { type: 'person', id: a.userId },
      actor: { id: a.userId, fullName: 'Alice Sender' },
      read: false,
    });
    expect((await call(b, 'GET', '/me')).json().unreadNotifications).toBe(1);
    expect(t.push.tokensFor(/Alice Sender wants to connect/)).toEqual([token('bob')]);

    await call(b, 'POST', `/connections/${sent.connectionId}/accept`);
    expect((await feed(b)).items.some((i: { type: string }) => i.type === 'connection_request')).toBe(false);
    const af = await feed(a);
    expect(af.items[0]).toMatchObject({ type: 'connection_accepted', title: 'Bob Receiver accepted your connection request', actor: { id: b.userId } });
  });

  it('removes the alert when a request is cancelled', async () => {
    const a = await member();
    const b = await member();
    const sent = (await call(a, 'POST', '/connections', { toUserId: b.userId })).json();
    expect((await feed(b)).total).toBe(1);
    await call(a, 'DELETE', `/connections/${sent.connectionId}`);
    expect((await feed(b)).total).toBe(0);
  });
});

describe('feed and read state', () => {
  it('filters, marks one read, then all read', async () => {
    const admin = await member('Admin Sender');
    await t.db.update(profiles).set({ role: 'admin' }).where(eq(profiles.id, admin.userId));
    const u = await member();
    await call(admin, 'POST', '/admin/notifications', { type: 'latest_issue', title: 'Issue 48 is out', push: false, target: { type: 'issue', id: 'issue-48' } });
    await call(admin, 'POST', '/admin/notifications', { type: 'breaking_news', title: 'Breaking: 6G spectrum', push: false });
    await call(admin, 'POST', '/admin/notifications', { type: 'research', title: 'New report', push: false, xpValue: 5, isPremium: true });

    const all = await feed(u);
    expect(all.items.slice(0, 3).map((i: { title: string }) => i.title)).toEqual(['New report', 'Breaking: 6G spectrum', 'Issue 48 is out']);
    expect(all.items[0]).toMatchObject({ label: 'Research Center', xpValue: 5, isPremium: true, actor: null });
    expect((await feed(u, '?filter=latest_issue')).items.map((i: { title: string }) => i.title)).toContain('Issue 48 is out');
    expect((await feed(u, '?filter=news')).items.every((i: { type: string }) => ['news', 'breaking_news'].includes(i.type))).toBe(true);

    const before = all.unreadCount;
    const one = await call(u, 'POST', `/notifications/${all.items[0].id}/read`);
    expect(one.json().unreadCount).toBe(before - 1);
    expect((await feed(u)).items[0].read).toBe(true);
    expect((await call(u, 'POST', '/notifications/read-all')).json()).toEqual({ unreadCount: 0 });
    expect((await call(u, 'GET', '/me')).json().unreadNotifications).toBe(0);

    // Something new after "read all" is unread again.
    await call(admin, 'POST', '/admin/notifications', { type: 'news', title: 'Later news', push: false });
    expect((await feed(u)).unreadCount).toBe(1);
  });

  it('pages the feed and hides other people’s notifications', async () => {
    const a = await member();
    const b = await member();
    const c = await member();
    await call(a, 'POST', '/connections', { toUserId: c.userId });
    await call(b, 'POST', '/connections', { toUserId: c.userId });
    const p1 = await feed(c, '?limit=1');
    const p2 = await feed(c, `?limit=1&cursor=${p1.nextCursor}`);
    expect(p1.items[0].id).not.toBe(p2.items[0].id);

    const mine = (await feed(c)).items.find((i: { type: string }) => i.type === 'connection_request');
    expect((await call(a, 'POST', `/notifications/${mine.id}/read`)).json().error.code).toBe('NOTIFICATION_NOT_FOUND');
  });
});

describe('devices and push', () => {
  it('registers, moves a token to the latest user, removes it, and respects the toggle', async () => {
    const a = await member();
    const b = await member();
    const r = await call(a, 'POST', '/devices', { token: token('shared'), platform: 'ios', appVersion: '1.0.0' });
    expect(r.json()).toEqual({ registered: true, pushEnabled: true });
    await call(b, 'POST', '/devices', { token: token('shared'), platform: 'ios' });
    const [row] = await t.db.select().from(devices).where(eq(devices.token, token('shared')));
    expect(row?.userId).toBe(b.userId);

    // Notifications off: still in the feed, but no push.
    await call(b, 'PATCH', '/me/settings', { notificationsEnabled: false });
    const sender = await member('Quiet Test');
    await call(sender, 'POST', '/connections', { toUserId: b.userId });
    expect(t.push.tokensFor(/Quiet Test/)).toEqual([]);
    expect((await feed(b)).items.some((i: { title: string }) => i.title === 'Quiet Test wants to connect')).toBe(true);

    expect((await call(b, 'DELETE', `/devices/${encodeURIComponent(token('shared'))}`)).statusCode).toBe(204);
    expect(await t.db.select().from(devices).where(eq(devices.token, token('shared')))).toHaveLength(0);
    expect((await call(a, 'POST', '/devices', { token: 'short', platform: 'ios' })).statusCode).toBe(422);
  });

  it('drops tokens FCM reports as dead', async () => {
    const u = await member();
    await call(u, 'POST', '/devices', { token: token('dead'), platform: 'android' });
    t.push.dead.add(token('dead'));
    const sender = await member('Dead Token');
    await call(sender, 'POST', '/connections', { toUserId: u.userId });
    expect(await t.db.select().from(devices).where(eq(devices.token, token('dead')))).toHaveLength(0);
  });
});

describe('admin broadcasts', () => {
  it('targets by interest, pushes to eligible devices, lists and deletes', async () => {
    const admin = await member('Broadcast Admin');
    await t.db.update(profiles).set({ role: 'admin' }).where(eq(profiles.id, admin.userId));
    const fan = await member();
    const other = await member();
    await call(fan, 'PUT', '/me/interests', { topicIds: [11] });
    await call(other, 'PUT', '/me/interests', { topicIds: [2] });
    await call(fan, 'POST', '/devices', { token: token('fan'), platform: 'ios' });
    await call(other, 'POST', '/devices', { token: token('other'), platform: 'ios' });

    expect((await call(fan, 'POST', '/admin/notifications', { type: 'news', title: 'x' })).statusCode).toBe(403);
    const r = await call(admin, 'POST', '/admin/notifications', {
      type: 'latest_issue',
      title: '5G special issue',
      description: 'Out now',
      audienceTopicIds: [11],
      target: { type: 'issue', id: 'i-49' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ pushEnabled: true, push: { sent: 1, failed: 0, devices: 1 } });
    expect(t.push.tokensFor(/5G special issue/)).toEqual([token('fan')]);
    expect((await feed(fan)).items.some((i: { title: string }) => i.title === '5G special issue')).toBe(true);
    expect((await feed(other)).items.some((i: { title: string }) => i.title === '5G special issue')).toBe(false);

    const id = r.json().id;
    await call(fan, 'POST', `/notifications/${id}/read`);
    const list = (await call(admin, 'GET', '/admin/notifications')).json();
    expect(list.items.find((i: { id: string }) => i.id === id)).toMatchObject({ reads: 1, audienceTopicIds: [11] });

    expect((await call(admin, 'DELETE', `/admin/notifications/${id}`)).statusCode).toBe(204);
    expect((await feed(fan)).items.some((i: { id: string }) => i.id === id)).toBe(false);
    expect((await call(admin, 'POST', '/admin/notifications', { type: 'connection_request', title: 'x' })).statusCode).toBe(422);
  });
});

describe('FCM sender', () => {
  it('signs in once, sends per token and reports dead tokens', async () => {
    const { privateKey } = await generateKeyPair('RS256', { extractable: true });
    const pem = await exportPKCS8(privateKey);
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: String(init.body) });
      if (url.includes('oauth2')) return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), { status: 200 });
      const msg = JSON.parse(String(init.body)) as { message: { token: string } };
      if (msg.message.token === 'gone') {
        return new Response(JSON.stringify({ error: { details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const fcm = new FcmPush({ projectId: 'proj', clientEmail: 'svc@proj.iam.gserviceaccount.com', privateKey: pem }, fakeFetch, { warn: () => undefined });

    const r1 = await fcm.send(['ok1', 'gone'], { title: 'Hi', body: 'There', data: { a: '1' } });
    const r2 = await fcm.send(['ok2'], { title: 'Again', data: {} });
    expect(r1).toEqual({ sent: 1, failed: 1, invalidTokens: ['gone'] });
    expect(r2.sent).toBe(1);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
    const sendCall = calls.find((c) => c.url.includes('/v1/projects/proj/messages:send'))!;
    expect(JSON.parse(sendCall.body).message).toMatchObject({ notification: { title: 'Hi', body: 'There' }, data: { a: '1' } });
  });

  it('reads FIREBASE_SERVICE_ACCOUNT as JSON or base64, and rejects junk', () => {
    const json = JSON.stringify({ project_id: 'p', client_email: 'e@p', private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n' });
    const base = baseEnv();
    expect(loadConfig(base).firebase).toBeUndefined();
    expect(loadConfig({ ...base, FIREBASE_SERVICE_ACCOUNT: json }).firebase).toMatchObject({ projectId: 'p', clientEmail: 'e@p' });
    expect(loadConfig({ ...base, FIREBASE_SERVICE_ACCOUNT: json }).firebase?.privateKey).toContain('\nabc\n');
    expect(loadConfig({ ...base, FIREBASE_SERVICE_ACCOUNT: Buffer.from(json).toString('base64') }).firebase?.projectId).toBe('p');
    expect(() => loadConfig({ ...base, FIREBASE_SERVICE_ACCOUNT: '{"nope":1}' })).toThrow(/FIREBASE_SERVICE_ACCOUNT/);
  });
});

function baseEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://u:p@h/db',
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_ANON_KEY: 'a',
    SUPABASE_SERVICE_ROLE_KEY: 's',
    OTP_SECRET: 'o'.repeat(40),
    NOTIFIER: 'console',
    EMAIL_FROM: 'a@b.c',
    TERMS_VERSION: 't',
  };
}
