import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/create-app.js';
import type { Config } from '../../src/config.js';
import { createTokenVerifier } from '../../src/lib/token-verifier.js';
import type { Db } from '../../src/db/client.js';
import { createTestDb } from './test-db.js';
import { FakeAuthProvider, FakeAvatarStorage, FakeNotifier, signTestToken } from './fakes.js';
import { testConfig } from './test-config.js';

export interface TestApp {
  app: FastifyInstance;
  db: Db;
  auth: FakeAuthProvider;
  notifier: FakeNotifier;
  avatars: FakeAvatarStorage;
  signToken: typeof signTestToken;
  close(): Promise<void>;
}

/** The real app on a fresh PGlite database, with Supabase Auth and email faked. */
export async function createTestApp(overrides: Partial<Config> = {}): Promise<TestApp> {
  const testDb = await createTestDb();
  const config = testConfig(overrides);
  const auth = new FakeAuthProvider(testDb.db);
  const notifier = new FakeNotifier();
  const avatars = new FakeAvatarStorage();
  const app = await buildApp({ config, db: testDb.db, auth, notifier, avatars, tokens: createTokenVerifier(config) });
  await app.ready();
  return {
    app,
    db: testDb.db,
    auth,
    notifier,
    avatars,
    signToken: signTestToken,
    async close() {
      await app.close();
      await testDb.close();
    },
  };
}

let n = 0;
export function uniqueEmail(prefix = 'user'): string {
  n += 1;
  return `${prefix}${n}.${Date.now()}@example.com`;
}

export function registerBody(email: string, overrides: Record<string, unknown> = {}) {
  return {
    fullName: 'Adnan Ghaffar',
    email,
    countryName: 'Pakistan',
    dialCode: '+92',
    mobile: '3001234567',
    password: 'correct-horse-9',
    termsAccepted: true,
    ...overrides,
  };
}

/** Registers and verifies an account; returns its tokens and id. */
export async function signUp(t: TestApp, email = uniqueEmail(), password = 'correct-horse-9') {
  const reg = await t.app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: registerBody(email, { password }) });
  if (reg.statusCode !== 201) throw new Error(`register failed: ${reg.body}`);
  const verify = await t.app.inject({
    method: 'POST',
    url: '/api/v1/auth/otp/verify',
    payload: { challengeId: reg.json().challengeId, code: t.notifier.lastCode(email.trim().toLowerCase()) },
  });
  if (verify.statusCode !== 200) throw new Error(`verify failed: ${verify.body}`);
  const body = verify.json();
  return { email: email.trim().toLowerCase(), password, userId: body.user.id as string, accessToken: body.accessToken as string, refreshToken: body.refreshToken as string };
}
