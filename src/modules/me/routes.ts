import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppDeps } from '../../create-app.js';
import { profiles } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { toUserView, userViewSchema } from './view.js';
import { xpTotal } from '../xp/engine.js';

const meResponse = userViewSchema.extend({ unreadNotifications: z.number().int() });

export const meRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const common = { tags: ['me'], security: [{ bearerAuth: [] }] };
  // onRequest, not preHandler: check the token before the body, so an anonymous caller gets 401, not 422.
  app.addHook('onRequest', app.authenticate);

  app.get('/', { schema: { ...common, response: { 200: meResponse } } }, async (req) => {
    const [profile] = await deps.db.select().from(profiles).where(eq(profiles.id, req.user.id));
    if (!profile) throw new AppError('UNAUTHORIZED', 'Account not found or not active');
    // unreadNotifications is a placeholder until the notifications module exists.
    return { ...toUserView(profile, await xpTotal(deps.db, profile.id)), unreadNotifications: 0 };
  });

  // Deleting the Supabase user cascades to every row that references auth.users.
  app.delete('/', { schema: { ...common, response: { 204: z.null() } } }, async (req, reply) => {
    const [profile] = await deps.db.select({ avatarPath: profiles.avatarPath }).from(profiles).where(eq(profiles.id, req.user.id));
    await deps.auth.deleteUser(req.user.id);
    // Storage objects are not covered by the database cascade.
    if (profile?.avatarPath) {
      await deps.avatars.remove([profile.avatarPath]).catch((err: unknown) => req.log.warn({ err }, 'avatar cleanup failed'));
    }
    return reply.status(204).send(null);
  });
};
