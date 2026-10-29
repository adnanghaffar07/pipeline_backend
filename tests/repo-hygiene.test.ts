import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

describe('repository hygiene', () => {
  // Committed node_modules from Windows lose the executable bit, so `tsc` fails on Vercel with exit 126.
  it('does not track node_modules or build output', () => {
    expect(git('ls-files', 'node_modules', 'dist').trim()).toBe('');
  });

  it('ignores node_modules, dist and .env (no stray whitespace in .gitignore patterns)', () => {
    const ignored = git('check-ignore', '--no-index', 'node_modules/x/package.json', 'dist/index.js', '.env')
      .trim()
      .split('\n');
    expect(ignored).toEqual(['node_modules/x/package.json', 'dist/index.js', '.env']);
  });
});
