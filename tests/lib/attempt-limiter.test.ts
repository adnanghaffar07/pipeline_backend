import { describe, expect, it } from 'vitest';
import { MemoryAttemptLimiter, RedisAttemptLimiter } from '../../src/lib/attempt-limiter.js';

/** Just enough Redis for the limiter: SET (EX/NX), INCR, TTL in a MULTI; standalone EXPIRE always fails. */
class TinyRedis {
  now = 0;
  private data = new Map<string, { v: number; exp: number | null }>();
  private live(k: string) {
    const e = this.data.get(k);
    if (e && e.exp !== null && e.exp <= this.now) this.data.delete(k);
    return this.data.get(k);
  }
  multi() {
    const ops: Array<() => [null, unknown]> = [];
    const chain = {
      set: (k: string, v: number, _ex: 'EX', sec: number, _nx: 'NX') => {
        ops.push(() => {
          if (this.live(k)) return [null, null];
          this.data.set(k, { v, exp: this.now + sec * 1000 });
          return [null, 'OK'];
        });
        return chain;
      },
      incr: (k: string) => {
        ops.push(() => {
          const e = this.live(k) ?? { v: 0, exp: null };
          e.v += 1;
          this.data.set(k, e);
          return [null, e.v];
        });
        return chain;
      },
      ttl: (k: string) => {
        ops.push(() => {
          const e = this.live(k);
          if (!e) return [null, -2];
          return [null, e.exp === null ? -1 : Math.ceil((e.exp - this.now) / 1000)];
        });
        return chain;
      },
      exec: async () => ops.map((op) => op()),
    };
    return chain;
  }
  async expire(): Promise<number> {
    throw new Error('connection lost');
  }
}

describe('RedisAttemptLimiter', () => {
  it('sets the window expiry atomically, so a failed follow-up call cannot lock a key forever', async () => {
    const redis = new TinyRedis();
    const l = new RedisAttemptLimiter(redis as never);
    const opts = { max: 1, windowSec: 60 };
    expect((await l.hit('k', opts)).allowed).toBe(true);
    expect(await l.hit('k', opts)).toEqual({ allowed: false, retryAfterSec: 60 });
    redis.now += 60_001;
    expect((await l.hit('k', opts)).allowed).toBe(true);
  });
});

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
