/**
 * Process entrypoint. Starts the server unconditionally, so it works both when run directly
 * (`node dist/index.js`, Docker) and when imported by Vercel's Fastify preset, which expects it to call listen().
 *
 * Vercel picks its entrypoint from src/{app,index,server}.* among files that reference fastify, so this must
 * stay the only file with one of those names, and it must keep the fastify import below.
 */
import type { FastifyInstance } from 'fastify';
import { startServer } from './start-server.js';

try {
  const { app, stop }: { app: FastifyInstance; stop(): Promise<void> } = await startServer();
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
} catch (err) {
  // Typically invalid configuration: print the list of bad variables, never their values.
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}
