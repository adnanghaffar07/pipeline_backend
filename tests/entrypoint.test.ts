import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));

// Vercel's Fastify preset takes the first of these that exists and expects it to call listen().
const VERCEL_ENTRY_ORDER = ['src/app', 'src/index', 'src/server', 'app', 'index', 'server'];
const EXTENSIONS = ['js', 'mjs', 'cjs', 'ts', 'cts', 'mts'];

describe('deployment entrypoint', () => {
  it('src/index.ts is the first file Vercel would pick', () => {
    const first = VERCEL_ENTRY_ORDER.flatMap((base) => EXTENSIONS.map((ext) => `${base}.${ext}`)).find((f) =>
      existsSync(`${root}/${f}`),
    );
    expect(first).toBe('src/index.ts');
  });

  it('starts listening when imported as a module (how Vercel loads it), not only when run directly', async () => {
    const port = 39_000 + Math.floor(Math.random() * 1000);
    const child = spawn(process.execPath, ['--import', 'tsx', '-e', "await import('./src/index.ts')"], {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        NODE_ENV: 'production',
        LOG_LEVEL: 'silent',
        HOST: '127.0.0.1',
        PORT: String(port),
        // Nothing here is contacted by /health/live: postgres.js and the Supabase clients connect lazily.
        DATABASE_URL: 'postgres://u:p@127.0.0.1:1/db',
        SUPABASE_URL: 'https://test.supabase.co',
        SUPABASE_ANON_KEY: 'anon',
        SUPABASE_SERVICE_ROLE_KEY: 'service',
        SUPABASE_JWT_SECRET: 'test-jwt-secret-that-is-long-enough-for-hs256',
        OTP_SECRET: 'o'.repeat(40),
        RESEND_API_KEY: 're_test',
        EMAIL_FROM: 'Pipeline <no-reply@example.com>',
        TERMS_VERSION: 'test-terms',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += String(d)));
    try {
      let status = 0;
      for (let i = 0; i < 60 && status !== 200; i++) {
        status = await fetch(`http://127.0.0.1:${port}/health/live`).then(
          (r) => r.status,
          () => 0,
        );
        if (status !== 200) await new Promise((r) => setTimeout(r, 250));
        if (child.exitCode !== null) break;
      }
      expect(status, stderr).toBe(200);
    } finally {
      child.kill();
    }
  }, 30_000);
});
