import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../../create-app.js';
import {
  broadcastBody,
  broadcastList,
  broadcastResponse,
  deviceBody,
  deviceParams,
  deviceResponse,
  feedQuery,
  feedResponse,
  idParams,
  unreadResponse,
} from './schemas.js';
import type { NotificationsService } from './service.js';

/** Mounted at /api/v1. */
export const notificationsRoutes: FastifyPluginAsyncZod<{ deps: AppDeps; service: NotificationsService }> = async (app, { service }) => {
  const sec = { tags: ['notifications'], security: [{ bearerAuth: [] }] };
  const secured = { onRequest: app.authenticate };

  app.get('/notifications', { ...secured, schema: { ...sec, querystring: feedQuery, response: { 200: feedResponse } } }, async (req) =>
    service.feed(req.user.id, req.query.filter, req.query.cursor, req.query.limit),
  );

  app.post(
    '/notifications/:notificationId/read',
    { ...secured, schema: { ...sec, params: idParams, response: { 200: unreadResponse } } },
    async (req) => service.markRead(req.user.id, req.params.notificationId),
  );

  app.post('/notifications/read-all', { ...secured, schema: { ...sec, response: { 200: unreadResponse } } }, async (req) =>
    service.markAllRead(req.user.id),
  );

  app.post('/devices', { ...secured, schema: { ...sec, body: deviceBody, response: { 200: deviceResponse } } }, async (req) =>
    service.registerDevice(req.user.id, req.body.token, req.body.platform, req.body.appVersion),
  );

  app.delete(
    '/devices/:token',
    { ...secured, schema: { ...sec, params: deviceParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await service.removeDevice(req.user.id, req.params.token);
      return reply.status(204).send(null);
    },
  );

  // ---- Admin ----
  const admin = { onRequest: app.authenticate, preHandler: app.requireAdmin };
  const adminSec = { tags: ['admin'], security: [{ bearerAuth: [] }] };

  app.post(
    '/admin/notifications',
    { ...admin, schema: { ...adminSec, body: broadcastBody, response: { 201: broadcastResponse } } },
    async (req, reply) => {
      const r = await service.broadcast(req.user.id, req.body);
      req.log.info({ adminId: req.user.id, notificationId: r.id, push: r.push }, 'broadcast sent');
      return reply.status(201).send(r);
    },
  );

  app.get(
    '/admin/notifications',
    { ...admin, schema: { ...adminSec, querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) }), response: { 200: broadcastList } } },
    async (req) => service.listBroadcasts(req.query.limit),
  );

  app.delete(
    '/admin/notifications/:notificationId',
    { ...admin, schema: { ...adminSec, params: idParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await service.deleteBroadcast(req.params.notificationId);
      return reply.status(204).send(null);
    },
  );
};
