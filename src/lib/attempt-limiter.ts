import type { Redis } from 'ioredis';

export interface LimitResult {
  allowed: boolean;
  retryAfterSec?: number;
}

/** Fixed-window counter keyed by an arbitrary string (e.g. an email address), independent of the per-IP limiter. */
export interface AttemptLimiter {
  hit(key: string, opts: { max: number; windowSec: number }): Promise<LimitResult>;
}

export class MemoryAttemptLimiter implements AttemptLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async hit(key: string, { max, windowSec }: { max: number; windowSec: number }): Promise<LimitResult> {
    const now = this.now();
    if (this.windows.size > 10_000) {
      for (const [k, w] of this.windows) if (w.resetAt <= now) this.windows.delete(k);
    }
    let w = this.windows.get(key);
    if (!w || w.resetAt <= now) {
      w = { count: 0, resetAt: now + windowSec * 1000 };
      this.windows.set(key, w);
    }
    w.count += 1;
    if (w.count <= max) return { allowed: true };
    return { allowed: false, retryAfterSec: Math.ceil((w.resetAt - now) / 1000) };
  }
}

export class RedisAttemptLimiter implements AttemptLimiter {
  constructor(private readonly redis: Redis) {}

  async hit(key: string, { max, windowSec }: { max: number; windowSec: number }): Promise<LimitResult> {
    const k = `pipeline-al:${key}`;
    // Create the key with its expiry in the same MULTI as the increment, so it can never exist without a TTL.
    const res = (await this.redis.multi().set(k, 0, 'EX', windowSec, 'NX').incr(k).ttl(k).exec()) as Array<
      [Error | null, unknown]
    >;
    const failed = res.find(([err]) => err);
    if (failed) throw failed[0];
    const count = res[1]?.[1] as number;
    const ttl = res[2]?.[1] as number;
    if (count <= max) return { allowed: true };
    return { allowed: false, retryAfterSec: ttl > 0 ? ttl : windowSec };
  }
}
