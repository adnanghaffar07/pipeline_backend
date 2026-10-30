import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { comments } from '../../src/db/schema.js';
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
let n = 0;
const article = () => `article-${++n}-${Date.now()}`;

const post = (u: User, articleId: string, text: string) =>
  t.app.inject({ method: 'POST', url: `/api/v1/articles/${articleId}/comments`, headers: auth(u), payload: { text } });
const list = (u: User, articleId: string, qs = '') =>
  t.app.inject({ method: 'GET', url: `/api/v1/articles/${articleId}/comments${qs}`, headers: auth(u) });
const reply = (u: User, commentId: string, text: string) =>
  t.app.inject({ method: 'POST', url: `/api/v1/comments/${commentId}/replies`, headers: auth(u), payload: { text } });
const replies = (u: User, commentId: string, qs = '') =>
  t.app.inject({ method: 'GET', url: `/api/v1/comments/${commentId}/replies${qs}`, headers: auth(u) });
const del = (u: User, commentId: string) =>
  t.app.inject({ method: 'DELETE', url: `/api/v1/comments/${commentId}`, headers: auth(u) });

describe('posting and listing', () => {
  it('creates a comment and lists it with author details', async () => {
    const u = await signUp(t);
    const a = article();
    const res = await post(u, a, '  Great read on 5G slicing  ');
    expect(res.statusCode).toBe(201);
    const { comment, xpAwarded } = res.json();
    expect(xpAwarded).toBe(0);
    expect(comment).toMatchObject({
      articleId: a,
      parentId: null,
      text: 'Great read on 5G slicing',
      isDeleted: false,
      isMine: true,
      author: { id: u.userId, fullName: 'Adnan Ghaffar', avatarUrl: null },
      likeCount: 0,
      likedByMe: false,
      replyCount: 0,
    });

    const other = await signUp(t);
    const l = await list(other, a);
    expect(l.statusCode).toBe(200);
    expect(l.json().total).toBe(1);
    expect(l.json().items[0]).toMatchObject({ id: comment.id, isMine: false });
  });

  it('lists newest first and pages with a cursor without gaps or repeats', async () => {
    const u = await signUp(t);
    const a = article();
    for (let i = 1; i <= 5; i++) expect((await post(u, a, `comment ${i}`)).statusCode).toBe(201);

    const first = (await list(u, a, '?limit=2')).json();
    expect(first.total).toBe(5);
    expect(first.items.map((c: { text: string }) => c.text)).toEqual(['comment 5', 'comment 4']);
    const second = (await list(u, a, `?limit=2&cursor=${first.nextCursor}`)).json();
    const third = (await list(u, a, `?limit=2&cursor=${second.nextCursor}`)).json();
    expect([...second.items, ...third.items].map((c: { text: string }) => c.text)).toEqual(['comment 3', 'comment 2', 'comment 1']);
    expect(third.nextCursor).toBeNull();
  });

  it('keeps articles separate', async () => {
    const u = await signUp(t);
    const a = article();
    await post(u, a, 'on a');
    expect((await list(u, article())).json().total).toBe(0);
  });

  it('validates text, ids and cursor', async () => {
    const u = await signUp(t);
    const a = article();
    expect((await post(u, a, '   ')).statusCode).toBe(422);
    expect((await post(u, a, 'x'.repeat(501))).statusCode).toBe(422);
    expect((await post(u, a, 'x'.repeat(500))).statusCode).toBe(201);
    expect((await post(u, 'bad$id', 'hello')).statusCode).toBe(422);
    expect((await list(u, a, '?cursor=not-a-cursor')).statusCode).toBe(422);
    expect((await del(u, 'not-a-uuid')).statusCode).toBe(422);
  });

  it('rejects the same text twice in a row', async () => {
    const u = await signUp(t);
    const a = article();
    expect((await post(u, a, 'Same thing')).statusCode).toBe(201);
    const again = await post(u, a, 'Same thing');
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('DUPLICATE_COMMENT');
  });

  it('rate limits fast posting', async () => {
    const u = await signUp(t);
    const a = article();
    for (let i = 0; i < 10; i++) expect((await post(u, a, `burst ${i}`)).statusCode).toBe(201);
    const res = await post(u, a, 'one too many');
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
  });

  it('requires a token', async () => {
    const res = await t.app.inject({ method: 'POST', url: `/api/v1/articles/${article()}/comments`, payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('replies', () => {
  it('replies, lists them oldest first, and counts them', async () => {
    const a1 = await signUp(t);
    const a2 = await signUp(t);
    const a = article();
    const top = (await post(a1, a, 'Top')).json().comment;

    const r1 = await reply(a2, top.id, 'First reply');
    expect(r1.statusCode).toBe(201);
    expect(r1.json().comment).toMatchObject({ parentId: top.id, articleId: a, text: 'First reply' });
    await reply(a1, top.id, 'Second reply');

    const lr = (await replies(a1, top.id)).json();
    expect(lr.items.map((c: { text: string }) => c.text)).toEqual(['First reply', 'Second reply']);
    expect(lr.total).toBe(2);

    const tl = (await list(a1, a)).json();
    expect(tl.total).toBe(1); // replies don't appear at the top level
    expect(tl.items[0].replyCount).toBe(2);
  });

  it('attaches a reply to a reply to the same thread', async () => {
    const u = await signUp(t);
    const top = (await post(u, article(), 'Top')).json().comment;
    const r1 = (await reply(u, top.id, 'r1')).json().comment;
    const r2 = await reply(u, r1.id, 'r2');
    expect(r2.json().comment.parentId).toBe(top.id);
  });

  it('404s for an unknown comment', async () => {
    const u = await signUp(t);
    const res = await reply(u, randomUUID(), 'hello');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('COMMENT_NOT_FOUND');
  });
});

describe('deleting', () => {
  it('lets only the author delete', async () => {
    const owner = await signUp(t);
    const other = await signUp(t);
    const a = article();
    const c = (await post(owner, a, 'Mine')).json().comment;
    const res = await del(other, c.id);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
    expect((await del(owner, c.id)).statusCode).toBe(204);
    expect((await list(owner, a)).json().total).toBe(0);
    expect((await del(owner, c.id)).statusCode).toBe(404);
  });

  it('keeps a deleted comment as a placeholder while it has replies', async () => {
    const owner = await signUp(t);
    const other = await signUp(t);
    const a = article();
    const c = (await post(owner, a, 'Will be deleted')).json().comment;
    const r = (await reply(other, c.id, 'A reply')).json().comment;
    await del(owner, c.id);

    const l = (await list(other, a)).json();
    expect(l.total).toBe(1);
    expect(l.items[0]).toMatchObject({ id: c.id, text: null, isDeleted: true, author: null, isMine: false, replyCount: 1 });
    const rr = await replies(other, c.id);
    expect(rr.json()).toMatchObject({ total: 1 });
    expect(rr.json().items).toHaveLength(1);
    expect((await reply(other, c.id, 'reply to deleted')).statusCode).toBe(404);

    // Once the last reply goes, the placeholder goes too.
    await del(other, r.id);
    expect((await list(other, a)).json().total).toBe(0);
  });

  it('hides moderator-hidden comments', async () => {
    const u = await signUp(t);
    const a = article();
    const c = (await post(u, a, 'Spam')).json().comment;
    await t.db.update(comments).set({ status: 'hidden' }).where(eq(comments.id, c.id));
    expect((await list(u, a)).json().total).toBe(0);
    expect((await reply(u, c.id, 'x')).statusCode).toBe(404);
  });
});

describe('likes', () => {
  it('likes and unlikes idempotently', async () => {
    const owner = await signUp(t);
    const fan = await signUp(t);
    const a = article();
    const c = (await post(owner, a, 'Like me')).json().comment;
    const like = () => t.app.inject({ method: 'POST', url: `/api/v1/comments/${c.id}/like`, headers: auth(fan) });
    const unlike = () => t.app.inject({ method: 'DELETE', url: `/api/v1/comments/${c.id}/like`, headers: auth(fan) });

    expect((await like()).json()).toEqual({ likeCount: 1, likedByMe: true });
    expect((await like()).json()).toEqual({ likeCount: 1, likedByMe: true });
    const seen = (await list(fan, a)).json().items[0];
    expect(seen).toMatchObject({ likeCount: 1, likedByMe: true });
    expect((await list(owner, a)).json().items[0]).toMatchObject({ likeCount: 1, likedByMe: false });
    expect((await unlike()).json()).toEqual({ likeCount: 0, likedByMe: false });
    expect((await unlike()).json()).toEqual({ likeCount: 0, likedByMe: false });
  });

  it('cannot like a deleted comment', async () => {
    const u = await signUp(t);
    const c = (await post(u, article(), 'Gone')).json().comment;
    await del(u, c.id);
    const res = await t.app.inject({ method: 'POST', url: `/api/v1/comments/${c.id}/like`, headers: auth(u) });
    expect(res.statusCode).toBe(404);
  });
});

describe('account deletion', () => {
  it('removes the user’s comments and likes', async () => {
    const u = await signUp(t);
    const a = article();
    const c = (await post(u, a, 'Bye')).json().comment;
    await t.app.inject({ method: 'DELETE', url: '/api/v1/me', headers: auth(u) });
    expect(await t.db.select().from(comments).where(eq(comments.id, c.id))).toHaveLength(0);
  });
});
