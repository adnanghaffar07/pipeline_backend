/**
 * Process entrypoint, for both Vercel and long-running hosts (Docker, `npm start`).
 *
 * Vercel's Fastify preset picks its entrypoint from src/{app,index,server}.* among files that reference fastify,
 * so this must stay the only file with one of those names, and it must keep the fastify import below.
 *
 * On Vercel the default export handles each request. Vercel patches http.Server#listen so the listen callback
 * never fires, and waits for this module to finish loading before routing traffic, so nothing here may wait on
 * listen(). Elsewhere the module starts a normal server.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import { createServerApp, startServer } from './start-server.js';

let appPromise: Promise<FastifyInstance> | undefined;

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Built once per function instance; a failed build is retried on the next request instead of being cached.
  appPromise ??= createServerApp().then(({ app }) => app);
  let app: FastifyInstance;
  try {
    app = await appPromise;
  } catch (err) {
    appPromise = undefined;
    // Typically invalid configuration: log which variables are wrong (never their values).
    console.error(err instanceof Error ? err.message : err);
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'INTERNAL', message: 'Internal server error' } }));
    return;
  }
  app.server.emit('request', req, res);
}

if (!process.env.VERCEL) {
  startServer()
    .then(({ app, stop }) => {
      for (const signal of ['SIGTERM', 'SIGINT'] as const) {
        process.once(signal, () => {
          app.log.info({ signal }, 'shutting down');
          stop()
            .then(() => process.exit(0))
            .catch((err: unknown) => {
              app.log.error({ err }, 'shutdown failed');
              process.exit(1);
            });
        });
      }
      process.on('unhandledRejection', (err) => {
        app.log.fatal({ err }, 'unhandled rejection');
        process.exit(1);
      });
    })
    .catch((err: unknown) => {
      // Typically invalid configuration: print the list of bad variables, never their values.
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
