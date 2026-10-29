import fp from 'fastify-plugin';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { Redis } from 'ioredis';
import type { Config } from '../config.js';
import { AppError } from '../lib/errors.js';

export default fp<{ config: Config }>(async (app, { config }) => {
  // The API only serves JSON; the one HTML page (/docs) needs inline scripts, so CSP is off.
  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });

  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: false,
  });

  const redis = config.redisUrl ? new Redis(config.redisUrl, { connectTimeout: 2000, maxRetriesPerRequest: 1 }) : undefined;
  if (redis) app.addHook('onClose', async () => void (await redis.quit()));

  await app.register(rateLimit, {
    global: true,
    max: config.rateLimit.globalPerMinute,
    timeWindow: '1 minute',
    ...(redis ? { redis, nameSpace: 'pipeline-rl-' } : {}),
    errorResponseBuilder: (_req, ctx) =>
      new AppError('RATE_LIMITED', 'Too many requests, please try again later', {
        retryAfterSec: Math.ceil(ctx.ttl / 1000),
      }),
  });
});
