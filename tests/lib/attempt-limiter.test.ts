import { describe, expect, it } from 'vitest';
import { MemoryAttemptLimiter } from '../../src/lib/attempt-limiter.js';

describe('MemoryAttemptLimiter', () => {
  it('allows max hits per window then blocks with retryAfterSec', async () => {
    let now = 1_000_000;
    const l = new MemoryAttemptLimiter(() => now);
    const opts = { max: 2, windowSec: 900 };
    expect((await l.hit('k', opts)).allowed).toBe(true);
    expect((await l.hit('k', opts)).allowed).toBe(true);
    expect(await l.hit('k', opts)).toEqual({ allowed: false, retryAfterSec: 900 });
    now += 300_000;
    expect(await l.hit('k', opts)).toEqual({ allowed: false, retryAfterSec: 600 });
  });

  it('tracks keys independently and resets after the window', async () => {
    let now = 0;
    const l = new MemoryAttemptLimiter(() => now);
    const opts = { max: 1, windowSec: 60 };
    await l.hit('a', opts);
    expect((await l.hit('a', opts)).allowed).toBe(false);
    expect((await l.hit('b', opts)).allowed).toBe(true);
    now += 60_001;
    expect((await l.hit('a', opts)).allowed).toBe(true);
  });
});
