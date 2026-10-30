import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const base = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_ANON_KEY: 'anon',
  SUPABASE_SERVICE_ROLE_KEY: 'service',
  OTP_SECRET: 'x'.repeat(32),
  NOTIFIER: 'console',
  EMAIL_FROM: 'Pipeline <no-reply@pipelinepub.com>',
  TERMS_VERSION: '2026-10-01',
};

describe('loadConfig', () => {
  it('loads a valid env with defaults', () => {
    const c = loadConfig({ ...base, CORS_ORIGINS: 'https://a.com, https://b.com' });
    expect(c.otpTtlSeconds).toBe(300);
    expect(c.otpResendSeconds).toBe(27);
    expect(c.loginOtpRequired).toBe(true);
    expect(c.port).toBe(3000);
    expect(c.corsOrigins).toEqual(['https://a.com', 'https://b.com']);
  });

  it('treats empty variables (as shipped in .env.example) as unset', () => {
    const c = loadConfig({ ...base, DOCS_ENABLED: '', REDIS_URL: '', SUPABASE_JWT_SECRET: '', TRUST_PROXY: '', PORT: '' });
    expect(c.docsEnabled).toBe(true);
    expect(c.redisUrl).toBeUndefined();
    expect(c.trustProxy).toBe(false);
    expect(c.port).toBe(3000);
  });

  it('rejects a DATABASE_URL that is not a complete URL (e.g. cut off at an unquoted #)', () => {
    expect(() => loadConfig({ ...base, DATABASE_URL: 'postgresql://postgres.abc:.secret' })).toThrow(/DATABASE_URL/);
  });

  it('parses boolean flags', () => {
    expect(loadConfig({ ...base, LOGIN_OTP_REQUIRED: 'false' }).loginOtpRequired).toBe(false);
  });

  it('parses TRUST_PROXY as boolean, hop count, or address list', () => {
    expect(loadConfig(base).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...base, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...base, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).trustProxy).toBe('10.0.0.0/8,127.0.0.1');
  });

  it('rejects TRUST_PROXY=true, which would trust a spoofable X-Forwarded-For', () => {
    expect(() => loadConfig({ ...base, TRUST_PROXY: 'true' })).toThrow(/TRUST_PROXY/);
  });

  it('rejects short OTP_SECRET', () => {
    expect(() => loadConfig({ ...base, OTP_SECRET: 'short' })).toThrow(/OTP_SECRET/);
  });

  it('reports every invalid variable at once', () => {
    expect(() => loadConfig({ ...base, OTP_SECRET: 'short', SUPABASE_URL: 'nope' })).toThrow(
      /OTP_SECRET[\s\S]*SUPABASE_URL|SUPABASE_URL[\s\S]*OTP_SECRET/,
    );
  });

  it('rejects console notifier in production', () => {
    expect(() =>
      loadConfig({ ...base, NODE_ENV: 'production', RESEND_API_KEY: 're_x' }),
    ).toThrow(/NOTIFIER/);
  });

  it('requires RESEND_API_KEY when NOTIFIER=resend', () => {
    expect(() => loadConfig({ ...base, NOTIFIER: 'resend' })).toThrow(/RESEND_API_KEY/);
  });

  it('docsEnabled defaults to false in production, true otherwise', () => {
    expect(loadConfig(base).docsEnabled).toBe(true);
    expect(
      loadConfig({ ...base, NODE_ENV: 'production', NOTIFIER: 'resend', RESEND_API_KEY: 're_x' })
        .docsEnabled,
    ).toBe(false);
  });
});

describe('database pool', () => {
  it('keeps the pool small on Vercel and honours DB_POOL_MAX', async () => {
    expect(loadConfig(base).dbPoolMax).toBe(10);
    expect(loadConfig({ ...base, VERCEL: '1' })).toMatchObject({ dbPoolMax: 3, serverless: true });
    expect(loadConfig({ ...base, VERCEL: '1', DB_POOL_MAX: '5' }).dbPoolMax).toBe(5);
    expect(() => loadConfig({ ...base, DB_POOL_MAX: '0' })).toThrow(/DB_POOL_MAX/);
  });

  it('recognises the Supabase session pooler', async () => {
    const { isSupabaseSessionPooler } = await import('../src/db/client.js');
    expect(isSupabaseSessionPooler('postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:5432/postgres')).toBe(true);
    expect(isSupabaseSessionPooler('postgresql://u:p@aws-0-eu-west-1.pooler.supabase.com:6543/postgres')).toBe(false);
    expect(isSupabaseSessionPooler('postgresql://u:p@db.abc.supabase.co:5432/postgres')).toBe(false);
    expect(isSupabaseSessionPooler('not a url')).toBe(false);
  });
});
