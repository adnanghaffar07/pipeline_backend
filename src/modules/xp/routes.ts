import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppDeps } from '../../create-app.js';
import type { AttemptLimiter } from '../../lib/attempt-limiter.js';
import { AppError } from '../../lib/errors.js';
import {
  badgeView,
  badgesResponse,
  eventBody,
  eventResponse,
  historyQuery,
  historyResponse,
  leaderboardQuery,
  leaderboardResponse,
  progressResponse,
  rulesResponse,
  streakQuery,
  streakResponse,
  tasksResponse,
  xpQuery,
  xpResponse,
} from './schemas.js';
import { XpService } from './service.js';

/** Mounted at /api/v1. */
export const xpRoutes: FastifyPluginAsyncZod<{ deps: AppDeps; limiter: AttemptLimiter }> = async (app, { deps, limiter }) => {
  const service = new XpService(deps.db);
  const tags = ['xp'];
  const secured = { onRequest: app.authenticate };
  const sec = { tags, security: [{ bearerAuth: [] }] };

  app.get('/xp/rules', { schema: { tags, response: { 200: rulesResponse } } }, async () => service.rules());

  app.post(
    '/events',
    { ...secured, schema: { ...sec, body: eventBody, response: { 200: eventResponse } } },
    async (req) => {
      const r = await limiter.hit(`events:${req.user.id}`, { max: 60, windowSec: 60 });
      if (!r.allowed) throw new AppError('RATE_LIMITED', 'Too many activity events. Please slow down.', { retryAfterSec: r.retryAfterSec });
      return service.recordEvent(req.user.id, req.body);
    },
  );

  app.get('/me/progress', { ...secured, schema: { ...sec, response: { 200: progressResponse } } }, async (req) =>
    service.progress(req.user.id),
  );

  app.get('/me/xp', { ...secured, schema: { ...sec, querystring: xpQuery, response: { 200: xpResponse } } }, async (req) =>
    service.xpSummary(req.user.id, req.query.period),
  );

  app.get(
    '/me/history',
    { ...secured, schema: { ...sec, querystring: historyQuery, response: { 200: historyResponse } } },
    async (req) => service.history(req.user.id, req.query.cursor, req.query.limit),
  );

  app.get('/me/streak', { ...secured, schema: { ...sec, querystring: streakQuery, response: { 200: streakResponse } } }, async (req) =>
    service.streak(req.user.id, req.query.year, req.query.month),
  );

  app.get('/me/tasks', { ...secured, schema: { ...sec, response: { 200: tasksResponse } } }, async (req) => service.tasks(req.user.id));

  app.get('/badges', { ...secured, schema: { ...sec, response: { 200: badgesResponse } } }, async (req) => service.badges(req.user.id));

  app.get(
    '/me/badges/next',
    { ...secured, schema: { ...sec, response: { 200: badgeView.nullable() } } },
    async (req) => service.nextBadgeOf((await service.badges(req.user.id)).items),
  );

  app.get(
    '/leaderboard',
    { ...secured, schema: { ...sec, querystring: leaderboardQuery, response: { 200: leaderboardResponse } } },
    async (req) => service.leaderboard(req.user.id, req.query.period, req.query.limit),
  );
};
