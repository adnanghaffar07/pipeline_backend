import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { profiles } from '../../src/db/schema.js';
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
/** A member with a unique, searchable name. */
async function member(fullName?: string, extra: Partial<typeof profiles.$inferInsert> = {}) {
  const u = await signUp(t);
  n += 1;
  const name = fullName ?? `Member${n} Test${n}`;
  await t.db.update(profiles).set({ fullName: name, ...extra }).where(eq(profiles.id, u.userId));
  return u;
}

async function connect(a: User, b: User) {
  const sent = await call(a, 'POST', '/connections', { toUserId: b.userId });
  const accepted = await call(b, 'POST', `/connections/${sent.json().connectionId}/accept`);
  expect(accepted.statusCode).toBe(200);
}

describe('connection requests', () => {
  it('sends, shows on both sides, and accepts', async () => {
    const a = await member();
    const b = await member();
    const sent = await call(a, 'POST', '/connections', { toUserId: b.userId });
    expect(sent.statusCode).toBe(201);
    expect(sent.json()).toMatchObject({ id: b.userId, connectionState: 'sent' });
    const id = sent.json().connectionId;

    const again = await call(a, 'POST', '/connections', { toUserId: b.userId });
    expect(again.statusCode).toBe(200);
    expect(again.json().connectionId).toBe(id);

    const sentList = (await call(a, 'GET', '/connections?status=sent')).json();
    expect(sentList.items.map((p: { id: string }) => p.id)).toEqual([b.userId]);
    expect(sentList.counts).toEqual({ connected: 0, received: 0, sent: 1 });
    const received = (await call(b, 'GET', '/connections?status=received')).json();
    expect(received.items[0]).toMatchObject({ id: a.userId, connectionState: 'received', connectionId: id });
    expect(received.counts.received).toBe(1);

    expect((await call(a, 'POST', `/connections/${id}/accept`)).statusCode).toBe(404); // only the addressee
    const acc = await call(b, 'POST', `/connections/${id}/accept`);
    expect(acc.json()).toMatchObject({ id: a.userId, connectionState: 'connected' });
    expect((await call(a, 'GET', '/connections')).json().counts).toEqual({ connected: 1, received: 0, sent: 0 });
    expect((await call(a, 'POST', '/connections', { toUserId: b.userId })).json().error.code).toBe('ALREADY_CONNECTED');
  });

  it('accepts automatically when both ask each other', async () => {
    const a = await member();
    const b = await member();
    await call(a, 'POST', '/connections', { toUserId: b.userId });
    const back = await call(b, 'POST', '/connections', { toUserId: a.userId });
    expect(back.statusCode).toBe(200);
    expect(back.json().connectionState).toBe('connected');
  });

  it('declines, cancels and removes', async () => {
    const a = await member();
    const b = await member();
    const id1 = (await call(a, 'POST', '/connections', { toUserId: b.userId })).json().connectionId;
    expect((await call(b, 'POST', `/connections/${id1}/decline`)).statusCode).toBe(204);
    expect((await call(a, 'GET', '/connections?status=sent')).json().total).toBe(0);

    const id2 = (await call(a, 'POST', '/connections', { toUserId: b.userId })).json().connectionId;
    expect((await call(a, 'DELETE', `/connections/${id2}`)).statusCode).toBe(204);

    await connect(a, b);
    const conn = (await call(a, 'GET', '/connections')).json().items[0].connectionId;
    expect((await call(b, 'DELETE', `/connections/${conn}`)).statusCode).toBe(204);
    expect((await call(a, 'GET', '/connections')).json().total).toBe(0);

    // A fresh pair: a has already asked b 3 times (the per-pair limit).
    const c = await member();
    const stranger = await member();
    const id3 = (await call(a, 'POST', '/connections', { toUserId: c.userId })).json().connectionId;
    expect((await call(stranger, 'DELETE', `/connections/${id3}`)).statusCode).toBe(404);
  });

  it('validates the target', async () => {
    const a = await member();
    expect((await call(a, 'POST', '/connections', { toUserId: a.userId })).statusCode).toBe(422);
    expect((await call(a, 'POST', '/connections', { toUserId: crypto.randomUUID() })).json().error.code).toBe('PERSON_NOT_FOUND');
    expect((await call(a, 'POST', '/connections', { toUserId: 'nope' })).statusCode).toBe(422);
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/people' })).statusCode).toBe(401);
  });

  it('limits repeat requests to the same person', async () => {
    const a = await member();
    const b = await member();
    for (let i = 0; i < 3; i++) {
      const id = (await call(a, 'POST', '/connections', { toUserId: b.userId })).json().connectionId;
      await call(b, 'POST', `/connections/${id}/decline`);
    }
    expect((await call(a, 'POST', '/connections', { toUserId: b.userId })).json().error.code).toBe('RATE_LIMITED');
  });
});

describe('discover and member profiles', () => {
  it('lists others, hides connections, searches by name, role or company', async () => {
    const me = await member('Discover Owner');
    const friend = await member('Friendly Person');
    const target = await member('Zainab Qureshi', { jobTitle: 'Network Architect', company: 'Telenor' });
    await connect(me, friend);

    const all = (await call(me, 'GET', '/people?limit=50')).json();
    const ids = all.items.map((p: { id: string }) => p.id);
    expect(ids).not.toContain(me.userId);
    expect(ids).not.toContain(friend.userId);
    expect(ids).toContain(target.userId);

    for (const q of ['zain', 'qureshi', 'network arch', 'telen']) {
      const r = (await call(me, 'GET', `/people?q=${encodeURIComponent(q)}`)).json();
      expect(r.items.map((p: { id: string }) => p.id)).toEqual([target.userId]);
    }
    expect((await call(me, 'GET', '/people?q=enor')).json().items).toHaveLength(0); // word starts only
    expect((await call(me, 'GET', '/people?q=%25')).json().items).toHaveLength(0); // wildcards are literal
  });

  it('pages discover and ranks shared interests first', async () => {
    const me = await member();
    await call(me, 'PUT', '/me/interests', { topicIds: [3, 4] });
    const twin = await member('Aaa Twin');
    await call(twin, 'PUT', '/me/interests', { topicIds: [3, 4, 5] });
    const first = (await call(me, 'GET', '/people?limit=1')).json();
    expect(first.items[0]).toMatchObject({ id: twin.userId, sharedInterests: 2 });
    const second = (await call(me, 'GET', `/people?limit=1&cursor=${first.nextCursor}`)).json();
    expect(second.items[0].id).not.toBe(twin.userId);
  });

  it('counts mutual connections', async () => {
    const a = await member();
    const b = await member();
    const shared = await member();
    await connect(a, shared);
    await connect(b, shared);
    const card = (await call(a, 'GET', `/people/${b.userId}`)).json();
    expect(card.mutualConnections).toBe(1);
  });

  it('shows contact details only when connected AND shared', async () => {
    const owner = await member('Contact Owner', { bio: 'Telecom strategist' });
    const viewer = await member();
    await call(owner, 'PUT', '/me/interests', { topicIds: [1] });

    let p = (await call(viewer, 'GET', `/people/${owner.userId}`)).json();
    expect(p).toMatchObject({ fullName: 'Contact Owner', bio: 'Telecom strategist', connectionState: 'none', contact: { email: null, phone: null, locked: true } });
    expect(p.interests).toEqual([{ id: 1, name: 'Network Transformation' }]);

    await call(owner, 'PUT', '/me/privacy/contact-sharing', { enabled: true, email: true, phone: false });
    p = (await call(viewer, 'GET', `/people/${owner.userId}`)).json();
    expect(p.contact.locked).toBe(true); // not connected yet

    await connect(viewer, owner);
    p = (await call(viewer, 'GET', `/people/${owner.userId}`)).json();
    expect(p.contact).toEqual({ email: owner.email, phone: null, locked: false });

    await call(owner, 'PUT', '/me/privacy/contact-sharing', { enabled: false, email: true, phone: true });
    p = (await call(viewer, 'GET', `/people/${owner.userId}`)).json();
    expect(p.contact.locked).toBe(true); // master switch off

    const self = (await call(owner, 'GET', `/people/${owner.userId}`)).json();
    expect(self).toMatchObject({ connectionState: 'self', contact: { email: owner.email, locked: false } });
  });

  it('saves bio on the profile', async () => {
    const u = await member();
    const r = await call(u, 'PATCH', '/me/profile', { bio: 'I build networks' });
    expect(r.json().bio).toBe('I build networks');
    expect((await call(u, 'PATCH', '/me/profile', { bio: 'x'.repeat(501) })).statusCode).toBe(422);
  });
});

describe('block and report', () => {
  it('blocking removes the connection and hides both people from each other', async () => {
    const a = await member();
    const b = await member();
    await connect(a, b);
    expect((await call(a, 'POST', `/people/${b.userId}/block`)).statusCode).toBe(204);

    expect((await call(a, 'GET', '/connections')).json().total).toBe(0);
    expect((await call(b, 'GET', `/people/${a.userId}`)).statusCode).toBe(404);
    expect((await call(a, 'GET', `/people/${b.userId}`)).statusCode).toBe(404);
    expect((await call(b, 'GET', '/people?limit=50')).json().items.map((p: { id: string }) => p.id)).not.toContain(a.userId);
    expect((await call(b, 'POST', '/connections', { toUserId: a.userId })).json().error.code).toBe('PERSON_NOT_FOUND');

    const blocked = (await call(a, 'GET', '/me/blocks')).json();
    expect(blocked.items.map((x: { id: string }) => x.id)).toEqual([b.userId]);
    expect((await call(a, 'DELETE', `/people/${b.userId}/block`)).statusCode).toBe(204);
    expect((await call(b, 'GET', `/people/${a.userId}`)).statusCode).toBe(200);
  });

  it('reports a member (optionally blocking) and lets admins review', async () => {
    const reporter = await member('Report Maker');
    const bad = await member('Spammy Account');
    const r = await call(reporter, 'POST', `/people/${bad.userId}/report`, { reason: 'spam', details: 'Sends links', block: true });
    expect(r.statusCode).toBe(201);
    expect(r.json().blocked).toBe(true);
    expect((await call(reporter, 'GET', `/people/${bad.userId}`)).statusCode).toBe(404);
    expect((await call(reporter, 'POST', `/people/${bad.userId}/report`, { reason: 'nonsense' })).statusCode).toBe(422);

    expect((await call(reporter, 'GET', '/admin/reports')).statusCode).toBe(403);
    const admin = await member('Admin Person', { role: 'admin' });
    const list = (await call(admin, 'GET', '/admin/reports')).json();
    const item = list.items.find((i: { id: string }) => i.id === r.json().reportId);
    expect(item).toMatchObject({
      reason: 'spam',
      details: 'Sends links',
      status: 'open',
      reporter: { id: reporter.userId, fullName: 'Report Maker' },
      reported: { id: bad.userId, fullName: 'Spammy Account' },
      reportsAgainstMember: 1,
    });
    expect((await call(admin, 'PATCH', `/admin/reports/${item.id}`, { status: 'reviewed' })).statusCode).toBe(204);
    expect((await call(admin, 'GET', '/admin/reports?status=reviewed')).json().items.some((i: { id: string }) => i.id === item.id)).toBe(true);
    expect((await call(admin, 'PATCH', `/admin/reports/${crypto.randomUUID()}`, { status: 'reviewed' })).statusCode).toBe(404);
  });

  it('deleting an account removes its connections', async () => {
    const a = await member();
    const b = await member();
    await connect(a, b);
    await call(a, 'DELETE', '/me');
    expect((await call(b, 'GET', '/connections')).json().total).toBe(0);
  });
});
