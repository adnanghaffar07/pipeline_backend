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
    const [[, count], [, ttl]] = (await this.redis.multi().incr(k).ttl(k).exec()) as [[null, number], [null, number]];
    if (ttl < 0) await this.redis.expire(k, windowSec);
    if (count <= max) return { allowed: true };
    return { allowed: false, retryAfterSec: ttl > 0 ? ttl : windowSec };
  }
}
