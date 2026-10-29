import type { Writable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Db } from './db/client.js';
import type { AuthProvider } from './integrations/auth-provider.js';
import type { Notifier } from './integrations/notifier.js';
import type { TokenVerifier } from './lib/token-verifier.js';
import { errorHandler, notFoundHandler } from './lib/errors.js';
import { genReqId, loggerOptions } from './lib/logger.js';
import security from './plugins/security.js';
import swagger from './plugins/swagger.js';
import health from './plugins/health.js';

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
    trustProxy: config.trustProxy,
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

  await app.register(security, { config });
  if (config.docsEnabled) await app.register(swagger);
  await app.register(health, { db: deps.db });

  return app;
}
