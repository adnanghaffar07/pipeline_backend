import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { buildApp, type AppDeps } from '../src/app.js';
import { AppError } from '../src/lib/errors.js';
import type { Config } from '../src/config.js';
import { createTestDb, type TestDb } from './helpers/test-db.js';
import { testConfig } from './helpers/test-config.js';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await t.close();
});

const unused = new Proxy({}, { get: () => () => Promise.reject(new Error('not used in this test')) });

async function makeApp(overrides: Partial<Config> = {}, logStream?: Writable): Promise<FastifyInstance> {
  const deps: AppDeps = {
    config: testConfig(overrides),
    db: t.db,
    auth: unused as AppDeps['auth'],
    notifier: unused as AppDeps['notifier'],
    tokens: unused as AppDeps['tokens'],
  };
  const app = await buildApp(deps, { logStream });
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post('/t/validate', { schema: { body: z.object({ email: z.email(), password: z.string() }) } }, async () => ({ ok: true }));
  r.get('/t/app-error', async () => {
    throw new AppError('EMAIL_TAKEN', 'That email is already registered');
  });
  r.get('/t/boom', async () => {
    throw new Error('database password leaked in stack');
  });
  r.get('/t/ok', async () => ({ ok: true }));
  r.post('/t/log', async (req) => {
    req.log.info({ body: req.body, headers: req.headers }, 'debug dump');
    return { ok: true };
  });
  await app.ready();
  return app;
}

describe('app skeleton', () => {
  it('unknown route returns 404 NOT_FOUND envelope', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
    await app.close();
  });

  it('zod failure returns 422 VALIDATION_FAILED with field reasons', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/t/validate', payload: { email: 'bad', password: 'x' } });
    expect(res.statusCode).toBe(422);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.fields).toHaveProperty('email');
    await app.close();
  });

  it('malformed JSON returns 400 with the error envelope', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST',
      url: '/t/validate',
      headers: { 'content-type': 'application/json' },
      payload: '{bad',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
    await app.close();
  });

  it('thrown AppError returns its status and code', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/t/app-error' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: { code: 'EMAIL_TAKEN', message: 'That email is already registered' } });
    await app.close();
  });

  it('unexpected Error returns 500 INTERNAL without internals', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'GET', url: '/t/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'Internal server error' } });
    expect(res.body).not.toContain('leaked');
    await app.close();
  });

  it('echoes x-request-id and generates one when absent', async () => {
    const app = await makeApp();
    const echoed = await app.inject({ method: 'GET', url: '/t/ok', headers: { 'x-request-id': 'abc-123' } });
    expect(echoed.headers['x-request-id']).toBe('abc-123');
    const generated = await app.inject({ method: 'GET', url: '/t/ok' });
    expect(generated.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    await app.close();
  });

  it('health endpoints report ok', async () => {
    const app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/health/live' })).json()).toEqual({ status: 'ok' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok', db: 'ok' });
    await app.close();
  });

  it('logs redact password and authorization', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        lines.push(String(chunk));
        cb();
      },
    });
    const app = await makeApp({ logLevel: 'trace' }, stream);
    await app.inject({
      method: 'POST',
      url: '/t/log',
      headers: { authorization: 'Bearer secret-token-xyz' },
      payload: { email: 'a@b.com', password: 'secret123' },
    });
    const out = lines.join('');
    expect(out).toContain('debug dump');
    expect(out).toContain('[REDACTED]');
    expect(out).not.toContain('secret123');
    expect(out).not.toContain('secret-token-xyz');
    await app.close();
  });

  it('rate limit returns 429 RATE_LIMITED envelope', async () => {
    const app = await makeApp({ rateLimit: { globalPerMinute: 2, authPerMinute: 2, loginPerEmailPer15Min: 2 } });
    await app.inject({ method: 'GET', url: '/t/ok' });
    await app.inject({ method: 'GET', url: '/t/ok' });
    const res = await app.inject({ method: 'GET', url: '/t/ok' });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    await app.close();
  });

  it('serves an OpenAPI 3 document when docs are enabled', async () => {
    const app = await makeApp({ docsEnabled: true });
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toMatch(/^3\./);
    await app.close();
  });

  it('hides docs when disabled', async () => {
    const app = await makeApp({ docsEnabled: false });
    expect((await app.inject({ method: 'GET', url: '/docs/json' })).statusCode).toBe(404);
    await app.close();
  });
});
