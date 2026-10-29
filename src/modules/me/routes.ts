import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppDeps } from '../../app.js';
import { profiles } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { toUserView, userViewSchema } from './view.js';

const meResponse = userViewSchema.extend({ unreadNotifications: z.number().int() });

export const meRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const common = { tags: ['me'], security: [{ bearerAuth: [] }] };
  app.addHook('preHandler', app.authenticate);

  app.get('/', { schema: { ...common, response: { 200: meResponse } } }, async (req) => {
    const [profile] = await deps.db.select().from(profiles).where(eq(profiles.id, req.user.id));
    if (!profile) throw new AppError('UNAUTHORIZED', 'Account not found or not active');
    // unreadNotifications is a placeholder until the notifications module exists.
    return { ...toUserView(profile), unreadNotifications: 0 };
  });

  // Deleting the Supabase user cascades to every row that references auth.users.
  app.delete('/', { schema: { ...common, response: { 204: z.null() } } }, async (req, reply) => {
    await deps.auth.deleteUser(req.user.id);
    return reply.status(204).send(null);
  });
};
