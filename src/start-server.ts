import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from './create-app.js';
import { loadConfig, type Config } from './config.js';
import { createDb, isSupabaseSessionPooler } from './db/client.js';
import { SupabaseAuthProvider } from './integrations/auth-provider.js';
import { SupabaseAvatarStorage } from './integrations/avatar-storage.js';
import { createPush } from './integrations/push.js';
import { createNotifier } from './integrations/notifier.js';
import { createTokenVerifier } from './lib/token-verifier.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

type CreateDeps = (config: Config) => Promise<{ deps: AppDeps; close(): Promise<void> }>;

const createProductionDeps: CreateDeps = async (config) => {
  const { db, close } = createDb(config.databaseUrl, { max: config.dbPoolMax });
  if (config.serverless && isSupabaseSessionPooler(config.databaseUrl)) {
    // Never log the URL itself: it contains the database password.
    console.warn(
      'DATABASE_URL uses the Supabase session pooler (port 5432). Serverless instances can exhaust it; use the transaction pooler (port 6543).',
    );
  }
  const deps: AppDeps = {
    config,
    db,
    auth: new SupabaseAuthProvider(config),
    notifier: createNotifier(config, console),
    tokens: createTokenVerifier(config),
    avatars: new SupabaseAvatarStorage(config),
    push: createPush(config, { warn: (o, m) => console.warn(m, o) }),
  };
  return { deps, close };
};

/** Builds a ready app without binding a port (serverless platforms feed it requests directly). */
export async function createServerApp(
  env: NodeJS.ProcessEnv = process.env,
  opts: { createDeps?: CreateDeps } = {},
): Promise<{ app: FastifyInstance; config: Config; stop(): Promise<void> }> {
  const config = loadConfig(env);
  const { deps, close } = await (opts.createDeps ?? createProductionDeps)(config);
  const app = await buildApp(deps);
  await app.ready();

  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      // Stop accepting connections and let in-flight requests finish, but never hang a deploy.
      const timeout = new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref());
      await Promise.race([app.close(), timeout]);
      await close();
    })());

  return { app, config, stop };
}

/** Builds the app and listens on HOST:PORT (Docker, `npm start`). */
export async function startServer(
  env: NodeJS.ProcessEnv = process.env,
  opts: { createDeps?: CreateDeps } = {},
): Promise<{ app: FastifyInstance; stop(): Promise<void> }> {
  const { app, config, stop } = await createServerApp(env, opts);
  await app.listen({ host: config.host, port: config.port });
  return { app, stop };
}
