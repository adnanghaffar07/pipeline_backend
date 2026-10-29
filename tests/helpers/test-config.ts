import { loadConfig, type Config } from '../../src/config.js';

export const TEST_JWT_SECRET = 'test-jwt-secret-that-is-long-enough-for-hs256';

export function testConfig(overrides: Partial<Config> = {}): Config {
  const base = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://unused/unused',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
    SUPABASE_JWT_SECRET: TEST_JWT_SECRET,
    OTP_SECRET: 'o'.repeat(40),
    NOTIFIER: 'console',
    EMAIL_FROM: 'Pipeline <no-reply@example.com>',
    TERMS_VERSION: 'test-terms',
    RATE_LIMIT_GLOBAL_PER_MINUTE: '10000',
    RATE_LIMIT_AUTH_PER_MINUTE: '10000',
    RATE_LIMIT_LOGIN_PER_EMAIL_PER_15_MIN: '10000',
  });
  return { ...base, ...overrides, rateLimit: { ...base.rateLimit, ...overrides.rateLimit } };
}
