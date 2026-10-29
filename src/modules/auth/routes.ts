import type { FastifyRequest } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppDeps } from '../../create-app.js';
import type { AttemptLimiter } from '../../lib/attempt-limiter.js';
import { AppError } from '../../lib/errors.js';
import { OtpService } from './otp.js';
import { AuthService } from './service.js';
import {
  challengeResponse,
  forgotBody,
  loginBody,
  loginResponse,
  oauthBody,
  oauthParams,
  refreshBody,
  refreshResponse,
  registerBody,
  resendBody,
  resetBody,
  tokenResponse,
  verifyBody,
} from './schemas.js';
import { z } from 'zod';

export const authRoutes: FastifyPluginAsyncZod<{ deps: AppDeps; limiter: AttemptLimiter }> = async (
  app,
  { deps, limiter },
) => {
  const { config } = deps;
  const service = new AuthService(deps, new OtpService(deps.db, deps.notifier, config));
  const strict = { rateLimit: { max: config.rateLimit.authPerMinute, timeWindow: '1 minute' } };
  const tags = ['auth'];

  // Separate from the per-IP limit: stops password guessing against one account from many IPs.
  const perEmailLogin = async (req: FastifyRequest) => {
    const { email } = req.body as { email: string };
    const r = await limiter.hit(`login:${email}`, { max: config.rateLimit.loginPerEmailPer15Min, windowSec: 15 * 60 });
    if (!r.allowed) {
      throw new AppError('RATE_LIMITED', 'Too many sign-in attempts for this account. Please try again later.', {
        retryAfterSec: r.retryAfterSec,
      });
    }
  };

  app.post(
    '/register',
    { config: strict, schema: { tags, body: registerBody, response: { 201: challengeResponse } } },
    async (req, reply) => reply.status(201).send(await service.register(req.body, req.ip)),
  );

  app.post(
    '/login',
    { config: strict, preHandler: perEmailLogin, schema: { tags, body: loginBody, response: { 200: loginResponse } } },
    async (req) => service.login(req.body.email, req.body.password, req.ip),
  );

  app.post(
    '/otp/verify',
    { config: strict, schema: { tags, body: verifyBody, response: { 200: tokenResponse } } },
    async (req) => service.verifyOtp(req.body.challengeId, req.body.code),
  );

  app.post(
    '/otp/resend',
    { config: strict, schema: { tags, body: resendBody, response: { 200: challengeResponse } } },
    async (req) => service.resendOtp(req.body.challengeId),
  );

  app.post(
    '/password/forgot',
    { config: strict, schema: { tags, body: forgotBody, response: { 200: challengeResponse } } },
    async (req) => service.forgotPassword(req.body.email, req.ip),
  );

  app.post(
    '/password/reset',
    { config: strict, schema: { tags, body: resetBody, response: { 204: z.null() } } },
    async (req, reply) => {
      await service.resetPassword(req.body.challengeId, req.body.code, req.body.newPassword);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/refresh',
    { schema: { tags, body: refreshBody, response: { 200: refreshResponse } } },
    async (req) => service.refresh(req.body.refreshToken),
  );

  app.post(
    '/logout',
    { preHandler: app.authenticate, schema: { tags, security: [{ bearerAuth: [] }], response: { 204: z.null() } } },
    async (req, reply) => {
      await service.logout(req.user.accessToken);
      return reply.status(204).send(null);
    },
  );

  app.post(
    '/oauth/:provider',
    { config: strict, schema: { tags, params: oauthParams, body: oauthBody, response: { 200: tokenResponse } } },
    async (req) => service.oauth(req.params.provider, req.body.idToken, req.body.nonce),
  );
};
