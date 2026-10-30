import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppDeps } from '../../create-app.js';
import type { AttemptLimiter } from '../../lib/attempt-limiter.js';
import { appSettings } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { XP_SETTINGS_KEY, getXpConfig, getXpOverride, invalidateXpConfig, xpConfigOverride } from './config.js';
import {
  adminConfigResponse,
  adminEventsQuery,
  adminEventsResponse,
  reversalBody,
  reversalResponse,
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

  // ---- Admin ------------------------------------------------------------------------------------------------
  const admin = { onRequest: app.authenticate, preHandler: app.requireAdmin };
  const adminSec = { tags: ['admin'], security: [{ bearerAuth: [] }] };
  const configView = async () => ({
    override: ((await getXpOverride(deps.db)) as Record<string, unknown> | null) ?? null,
    effective: (await getXpConfig(deps.db)) as unknown as Record<string, unknown>,
  });

  app.get('/admin/xp/config', { ...admin, schema: { ...adminSec, response: { 200: adminConfigResponse } } }, configView);

  // Replaces the whole override: send everything that should differ from the defaults ({} = back to defaults).
  app.put(
    '/admin/xp/config',
    { ...admin, schema: { ...adminSec, body: xpConfigOverride, response: { 200: adminConfigResponse } } },
    async (req) => {
      await deps.db
        .insert(appSettings)
        .values({ key: XP_SETTINGS_KEY, value: req.body, updatedBy: req.user.id })
        .onConflictDoUpdate({ target: appSettings.key, set: { value: req.body, updatedBy: req.user.id, updatedAt: new Date() } });
      invalidateXpConfig(deps.db);
      req.log.info({ adminId: req.user.id }, 'xp config updated');
      return configView();
    },
  );

  app.get(
    '/admin/xp/events',
    { ...admin, schema: { ...adminSec, querystring: adminEventsQuery, response: { 200: adminEventsResponse } } },
    async (req) => service.history(req.query.userId ?? null, req.query.cursor, req.query.limit),
  );

  app.post(
    '/admin/xp/reversals',
    { ...admin, schema: { ...adminSec, body: reversalBody, response: { 201: reversalResponse } } },
    async (req, reply) => {
      const r = await service.engine.reverse(req.body.eventId, req.body.reason, req.user.id);
      if (r.status === 'not_reversible') throw new AppError('NOT_FOUND', 'No XP award with that id (reversals and 0-XP rows cannot be reversed)');
      if (r.status === 'already_reversed') throw new AppError('ALREADY_REVERSED', 'This award was already reversed');
      req.log.info({ adminId: req.user.id, eventId: req.body.eventId }, 'xp reversed');
      return reply.status(201).send({ reversalId: r.reversal.id, userId: r.userId, xpRemoved: -r.reversal.amount, xpTotal: r.xpTotal });
    },
  );
};
