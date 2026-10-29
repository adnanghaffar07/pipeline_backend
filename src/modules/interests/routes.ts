import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppDeps } from '../../app.js';
import { listEnvelope } from '../../lib/pagination.js';
import { InterestsService } from './service.js';

const topic = z.object({ id: z.number().int(), name: z.string() });
const topicsResponse = z.object({ items: z.array(topic), nextCursor: z.string().nullable(), total: z.number().int() });
const selection = z.object({ topicIds: z.array(z.number().int()) });
const selectionBody = z.object({
  topicIds: z
    .array(z.number().int().positive())
    .min(1, 'Select at least one topic')
    .max(50)
    .refine((ids) => new Set(ids).size === ids.length, 'Topic ids must be unique'),
});

export const interestsRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const service = new InterestsService(deps.db);
  const tags = ['interests'];
  const secured = { preHandler: app.authenticate };

  app.get('/interests/topics', { schema: { tags, response: { 200: topicsResponse } } }, async () => {
    const topics = await service.listTopics();
    return listEnvelope(topics, null, topics.length);
  });

  app.get(
    '/me/interests',
    { ...secured, schema: { tags, security: [{ bearerAuth: [] }], response: { 200: selection } } },
    async (req) => ({ topicIds: await service.getSelection(req.user.id) }),
  );

  // The +5 XP "select interests" award is added when the gamification module lands.
  app.put(
    '/me/interests',
    { ...secured, schema: { tags, security: [{ bearerAuth: [] }], body: selectionBody, response: { 200: selection } } },
    async (req) => ({ topicIds: await service.replaceSelection(req.user.id, req.body.topicIds) }),
  );
};
