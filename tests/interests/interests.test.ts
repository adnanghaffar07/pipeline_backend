import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, signUp, type TestApp } from '../helpers/test-app.js';

let t: TestApp;
let token: string;
beforeAll(async () => {
  t = await createTestApp();
  ({ accessToken: token } = await signUp(t));
});
afterAll(async () => {
  await t.close();
});

const put = (topicIds: unknown, auth = token) =>
  t.app.inject({
    method: 'PUT',
    url: '/api/v1/me/interests',
    headers: { authorization: `Bearer ${auth}` },
    payload: { topicIds } as object,
  });
const get = () => t.app.inject({ method: 'GET', url: '/api/v1/me/interests', headers: { authorization: `Bearer ${token}` } });

describe('GET /interests/topics', () => {
  it('lists the 17 topics publicly in order', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/v1/interests/topics' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(17);
    expect(body.nextCursor).toBeNull();
    expect(body.items).toHaveLength(17);
    expect(body.items[0]).toEqual({ id: 1, name: 'Network Transformation' });
    expect(body.items[16].name).toBe('Operational Agility');
  });
});

describe('/me/interests', () => {
  it('starts empty', async () => {
    const fresh = await signUp(t);
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/v1/me/interests',
      headers: { authorization: `Bearer ${fresh.accessToken}` },
    });
    expect(res.json()).toEqual({ topicIds: [] });
  });

  it('replaces the selection and returns sorted ids', async () => {
    expect((await put([5, 1, 3])).json()).toEqual({ topicIds: [1, 3, 5] });
    expect((await put([2])).json()).toEqual({ topicIds: [2] });
    expect((await get()).json()).toEqual({ topicIds: [2] });
  });

  it.each([
    ['empty', []],
    ['duplicates', [1, 1]],
    ['non-integers', [1.5]],
    ['strings', ['1']],
  ])('rejects %s with 422', async (_n, ids) => {
    expect((await put(ids)).statusCode).toBe(422);
  });

  it('rejects unknown topic ids with 400 INVALID_TOPICS and keeps the old selection', async () => {
    await put([4]);
    const res = await put([1, 999]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({ code: 'INVALID_TOPICS', invalidIds: [999] });
    expect((await get()).json()).toEqual({ topicIds: [4] });
  });

  it('requires a token', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/v1/me/interests' })).statusCode).toBe(401);
  });
});
