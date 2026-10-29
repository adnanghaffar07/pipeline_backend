import fp from 'fastify-plugin';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

export default fp<{ db: Db }>(async (app, { db }) => {
  const opts = { config: { rateLimit: false }, schema: { hide: true } } as const;

  app.get('/health/live', opts, async () => ({ status: 'ok' }));

  app.get('/health/ready', opts, async (req, reply) => {
    try {
      await db.execute(sql`select 1`);
      return { status: 'ok', db: 'ok' };
    } catch (err) {
      req.log.error({ err }, 'readiness check failed');
      return reply.status(503).send({ status: 'error', db: 'error' });
    }
  });
});
