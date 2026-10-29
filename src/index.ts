/**
 * Process entrypoint. Starts the server unconditionally, so it works both when run directly
 * (`node dist/index.js`, Docker) and when imported by a platform loader (Vercel's Fastify preset
 * picks the first of src/app, src/index, src/server and expects it to call listen()).
 */
import { startServer } from './server.js';

try {
  const { app, stop } = await startServer();
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
