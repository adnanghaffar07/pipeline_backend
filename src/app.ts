import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { MemoryAttemptLimiter, RedisAttemptLimiter } from './lib/attempt-limiter.js';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { AuthProvider } from './integrations/auth-provider.js';
import type { Notifier } from './integrations/notifier.js';
import type { TokenVerifier } from './lib/token-verifier.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import authGuard from './lib/auth-guard.js';
import { genReqId, loggerOptions } from './lib/logger.js';
import security from './plugins/security.js';
import swagger from './plugins/swagger.js';
import health from './plugins/health.js';
import { authRoutes } from './modules/auth/routes.js';
import { meRoutes } from './modules/me/routes.js';
import { interestsRoutes } from './modules/interests/routes.js';

export interface AppDeps {
  config: Config;
  db: Db;
  auth: AuthProvider;
  notifier: Notifier;
  tokens: TokenVerifier;
}

export interface BuildOptions {
  /** Redirect logs (tests). */
  logStream?: Writable;
}

/** Assembles the app without listening, so the server and the tests share one wiring. */
export async function buildApp(deps: AppDeps, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    logger: loggerOptions(config, opts.logStream),
    genReqId,
    requestIdLogLabel: 'requestId',
    // A hop count N means "trust the N nearest proxies".
    trustProxy:
      typeof config.trustProxy === 'number'
        ? (_addr: string, hop: number) => hop < (config.trustProxy as number)
        : config.trustProxy,
    bodyLimit: 100 * 1024,
    disableRequestLogging: false,
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler(notFoundHandler);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  const redis = config.redisUrl ? new Redis(config.redisUrl, { connectTimeout: 2000, maxRetriesPerRequest: 1 }) : undefined;
  if (redis) app.addHook('onClose', async () => void (await redis.quit()));
  const limiter = redis ? new RedisAttemptLimiter(redis) : new MemoryAttemptLimiter();

  await app.register(security, { config, redis });
  if (config.docsEnabled) await app.register(swagger);
  await app.register(health, { db: deps.db });
  await app.register(authGuard, { db: deps.db, tokens: deps.tokens });
  await app.register(authRoutes, { prefix: '/api/v1/auth', deps, limiter });
  await app.register(meRoutes, { prefix: '/api/v1/me', deps });
  await app.register(interestsRoutes, { prefix: '/api/v1', deps });

  return app;
}
