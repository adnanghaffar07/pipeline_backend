import multipart from '@fastify/multipart';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { AppDeps } from '../../create-app.js';
import { AppError } from '../../lib/errors.js';
import {
  avatarResponse,
  contactSharing,
  profilePatchBody,
  profileResponse,
  settingsPatchBody,
  settingsResponse,
} from './schemas.js';
import { ProfileService } from './service.js';

/** Vercel rejects request bodies over 4.5 MB, so stay under it with room for the multipart framing. */
export const AVATAR_MAX_BYTES = 4 * 1024 * 1024;

/** Mounted at /api/v1/me. */
export const profileRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const service = new ProfileService(deps.db, deps.avatars);
  const common = { tags: ['profile'], security: [{ bearerAuth: [] }] };
  // onRequest, not preHandler: check the token before the body, so an anonymous caller gets 401, not 422.
  app.addHook('onRequest', app.authenticate);
  // Scoped to this plugin: no other route accepts multipart bodies.
  await app.register(multipart, { limits: { fileSize: AVATAR_MAX_BYTES, files: 1, fields: 0, parts: 2 } });

  app.get('/profile', { schema: { ...common, response: { 200: profileResponse } } }, async (req) =>
    service.getProfile(req.user.id),
  );

  app.patch(
    '/profile',
    { schema: { ...common, body: profilePatchBody, response: { 200: profileResponse } } },
    async (req) => service.updateProfile(req.user.id, req.body),
  );

  app.get('/settings', { schema: { ...common, response: { 200: settingsResponse } } }, async (req) =>
    service.getSettings(req.user.id),
  );

  app.patch(
    '/settings',
    { schema: { ...common, body: settingsPatchBody, response: { 200: settingsResponse } } },
    async (req) => service.updateSettings(req.user.id, req.body),
  );

  app.put(
    '/privacy/contact-sharing',
    { schema: { ...common, body: contactSharing, response: { 200: contactSharing } } },
    async (req) => service.setContactSharing(req.user.id, req.body),
  );

  app.post(
    '/avatar',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        ...common,
        consumes: ['multipart/form-data'],
        description: 'multipart/form-data with one file field (any name). JPEG, PNG or WebP, max 4 MB.',
        response: { 200: avatarResponse },
      },
    },
    async (req) => {
      if (!req.isMultipart()) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Send the photo as multipart/form-data');
      const file = await req.file();
      if (!file) throw new AppError('BAD_REQUEST', 'No photo was attached');
      // toBuffer() throws a 413 when the file is over the limit.
      const data = await file.toBuffer();
      if (data.length === 0) throw new AppError('BAD_REQUEST', 'The photo is empty');
      return service.setAvatar(req.user.id, data);
    },
  );

  app.delete('/avatar', { schema: { ...common, response: { 200: avatarResponse } } }, async (req) =>
    service.removeAvatar(req.user.id),
  );
};
