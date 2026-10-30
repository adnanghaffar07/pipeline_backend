import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../../create-app.js';
import type { AttemptLimiter } from '../../lib/attempt-limiter.js';
import {
  articleParams,
  commentBody,
  commentList,
  commentParams,
  createdComment,
  likeState,
  listQuery,
} from './schemas.js';
import { CommentsService } from './service.js';

/** Mounted at /api/v1. */
export const commentsRoutes: FastifyPluginAsyncZod<{ deps: AppDeps; limiter: AttemptLimiter }> = async (
  app,
  { deps, limiter },
) => {
  const service = new CommentsService(deps.db, limiter);
  const common = { tags: ['comments'], security: [{ bearerAuth: [] }] };
  // onRequest, not preHandler: check the token before the body, so an anonymous caller gets 401, not 422.
  app.addHook('onRequest', app.authenticate);

  app.get(
    '/articles/:articleId/comments',
    { schema: { ...common, params: articleParams, querystring: listQuery, response: { 200: commentList } } },
    async (req) => service.listForArticle(req.user.id, req.params.articleId, req.query.cursor, req.query.limit),
  );

  app.post(
    '/articles/:articleId/comments',
    { schema: { ...common, params: articleParams, body: commentBody, response: { 201: createdComment } } },
    async (req, reply) => reply.status(201).send(await service.create(req.user.id, req.params.articleId, req.body.text)),
  );

  app.get(
    '/comments/:commentId/replies',
    { schema: { ...common, params: commentParams, querystring: listQuery, response: { 200: commentList } } },
    async (req) => service.listReplies(req.user.id, req.params.commentId, req.query.cursor, req.query.limit),
  );

  app.post(
    '/comments/:commentId/replies',
    { schema: { ...common, params: commentParams, body: commentBody, response: { 201: createdComment } } },
    async (req, reply) => reply.status(201).send(await service.reply(req.user.id, req.params.commentId, req.body.text)),
  );

  app.delete(
    '/comments/:commentId',
    { schema: { ...common, params: commentParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await service.remove(req.user.id, req.params.commentId);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/comments/:commentId/like',
    { schema: { ...common, params: commentParams, response: { 200: likeState } } },
    async (req) => service.like(req.user.id, req.params.commentId),
  );

  app.delete(
    '/comments/:commentId/like',
    { schema: { ...common, params: commentParams, response: { 200: likeState } } },
    async (req) => service.unlike(req.user.id, req.params.commentId),
  );
};
