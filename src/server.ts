import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from './create-app.js';
import { loadConfig, type Config } from './config.js';
import { createDb } from './db/client.js';
import { SupabaseAuthProvider } from './integrations/auth-provider.js';
import { createNotifier } from './integrations/notifier.js';
import { createTokenVerifier } from './lib/token-verifier.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

type CreateDeps = (config: Config) => Promise<{ deps: AppDeps; close(): Promise<void> }>;

const createProductionDeps: CreateDeps = async (config) => {
  const { db, close } = createDb(config.databaseUrl);
  const deps: AppDeps = {
    config,
    db,
    auth: new SupabaseAuthProvider(config),
    notifier: createNotifier(config, console),
    tokens: createTokenVerifier(config),
  };
  return { deps, close };
};

export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
  opts: { createDeps?: CreateDeps } = {},
): Promise<{ app: FastifyInstance; stop(): Promise<void> }> {
  const config = loadConfig(env);
  const { deps, close } = await (opts.createDeps ?? createProductionDeps)(config);
  const app = await buildApp(deps);
  await app.listen({ host: config.host, port: config.port });

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      // Stop accepting connections and let in-flight requests finish, but never hang a deploy.
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref());
      await Promise.race([app.close(), timeout]);
      await close();
    })());

  return { app, stop };
}
