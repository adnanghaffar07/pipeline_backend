import { describe, expect, it } from 'vitest';
import { startServer } from '../src/server.js';
import { createTokenVerifier } from '../src/lib/token-verifier.js';
import { createTestDb } from './helpers/test-db.js';
import { FakeAuthProvider, FakeNotifier } from './helpers/fakes.js';

const env = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  HOST: '127.0.0.1',
  PORT: '0',
  DATABASE_URL: 'postgres://unused/unused',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  SUPABASE_JWT_SECRET: 'test-jwt-secret-that-is-long-enough-for-hs256',
  OTP_SECRET: 'o'.repeat(40),
  NOTIFIER: 'console',
  EMAIL_FROM: 'Pipeline <no-reply@example.com>',
  TERMS_VERSION: 'test-terms',
};

describe('startServer', () => {
  it('rejects an invalid env, listing the bad variables', async () => {
    await expect(startServer({ ...env, OTP_SECRET: 'short', SUPABASE_URL: 'nope' })).rejects.toThrow(
      /OTP_SECRET[\s\S]*SUPABASE_URL|SUPABASE_URL[\s\S]*OTP_SECRET/,
    );
  });

  it('listens, serves health over HTTP, and stops cleanly', async () => {
    let dbClosed = false;
    const { app, stop } = await startServer(env, {
      createDeps: async (config) => {
        const t = await createTestDb();
        return {
          deps: { config, db: t.db, auth: new FakeAuthProvider(t.db), notifier: new FakeNotifier(), tokens: createTokenVerifier(config) },
          close: async () => {
            dbClosed = true;
            await t.close();
          },
        };
      },
    });
    const address = app.server.address();
    if (!address || typeof address === 'string') throw new Error('no address');
    const res = await fetch(`http://127.0.0.1:${address.port}/health/ready`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', db: 'ok' });

    await stop();
    expect(app.server.listening).toBe(false);
    expect(dbClosed).toBe(true);
  });
});
