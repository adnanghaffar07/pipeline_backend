import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { AppDeps } from '../../create-app.js';
import type { AttemptLimiter } from '../../lib/attempt-limiter.js';
import {
  adminReportList,
  adminReportsQuery,
  blockedList,
  connectionParams,
  connectionsQuery,
  connectionsResponse,
  memberProfile,
  peopleQuery,
  personCard,
  personList,
  personParams,
  reportBody,
  reportCreated,
  reportParams,
  reportPatch,
  sendBody,
} from './schemas.js';
import { NetworkingService } from './service.js';

/** Mounted at /api/v1. */
export const networkingRoutes: FastifyPluginAsyncZod<{ deps: AppDeps; limiter: AttemptLimiter }> = async (app, { deps, limiter }) => {
  const service = new NetworkingService(deps.db, limiter);
  const sec = { tags: ['networking'], security: [{ bearerAuth: [] }] };
  const secured = { onRequest: app.authenticate };

  app.get('/people', { ...secured, schema: { ...sec, querystring: peopleQuery, response: { 200: personList } } }, async (req) =>
    service.discover(req.user.id, req.query.q, req.query.cursor, req.query.limit),
  );

  app.get('/people/:personId', { ...secured, schema: { ...sec, params: personParams, response: { 200: memberProfile } } }, async (req) =>
    service.profile(req.user.id, req.params.personId),
  );

  app.get(
    '/connections',
    { ...secured, schema: { ...sec, querystring: connectionsQuery, response: { 200: connectionsResponse } } },
    async (req) => service.list(req.user.id, req.query.status, req.query.q, req.query.cursor, req.query.limit),
  );

  app.post(
    '/connections',
    { ...secured, schema: { ...sec, body: sendBody, response: { 200: personCard, 201: personCard } } },
    async (req, reply) => {
      const r = await service.send(req.user.id, req.body.toUserId);
      return reply.status(r.created ? 201 : 200).send(r.person);
    },
  );

  app.post(
    '/connections/:connectionId/accept',
    { ...secured, schema: { ...sec, params: connectionParams, response: { 200: personCard } } },
    async (req) => service.accept(req.user.id, req.params.connectionId),
  );

  app.post(
    '/connections/:connectionId/decline',
    { ...secured, schema: { ...sec, params: connectionParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await service.decline(req.user.id, req.params.connectionId);
      return reply.status(204).send(null);
    },
  );

  app.delete(
    '/connections/:connectionId',
    { ...secured, schema: { ...sec, params: connectionParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await service.remove(req.user.id, req.params.connectionId);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/people/:personId/block',
    { ...secured, schema: { ...sec, params: personParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await service.block(req.user.id, req.params.personId);
      return reply.status(204).send(null);
    },
  );

  app.delete(
    '/people/:personId/block',
    { ...secured, schema: { ...sec, params: personParams, response: { 204: z.null() } } },
    async (req, reply) => {
      await service.unblock(req.user.id, req.params.personId);
      return reply.status(204).send(null);
    },
  );

  app.get('/me/blocks', { ...secured, schema: { ...sec, response: { 200: blockedList } } }, async (req) => service.blocked(req.user.id));

  app.post(
    '/people/:personId/report',
    { ...secured, schema: { ...sec, params: personParams, body: reportBody, response: { 201: reportCreated } } },
    async (req, reply) =>
      reply
        .status(201)
        .send(await service.report(req.user.id, req.params.personId, req.body.reason, req.body.details, req.body.block)),
  );

  // ---- Admin ----
  const admin = { onRequest: app.authenticate, preHandler: app.requireAdmin };
  const adminSec = { tags: ['admin'], security: [{ bearerAuth: [] }] };

  app.get(
    '/admin/reports',
    { ...admin, schema: { ...adminSec, querystring: adminReportsQuery, response: { 200: adminReportList } } },
    async (req) => service.adminReports(req.query.status, req.query.cursor, req.query.limit),
  );

  app.patch(
    '/admin/reports/:reportId',
    { ...admin, schema: { ...adminSec, params: reportParams, body: reportPatch, response: { 204: z.null() } } },
    async (req, reply) => {
      await service.reviewReport(req.params.reportId, req.body.status);
      return reply.status(204).send(null);
    },
  );
};
