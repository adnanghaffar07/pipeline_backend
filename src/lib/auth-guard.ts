import fp from 'fastify-plugin';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/client.js';
import { profiles } from '../db/schema.js';
import { AppError } from './errors.js';
import type { TokenVerifier } from './token-verifier.js';

export interface AuthUser {
  id: string;
  email: string;
  accessToken: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** preHandler: requires a valid Supabase access token for an active account. */
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    user: AuthUser;
  }
}

export default fp<{ db: Db; tokens: TokenVerifier }>(async (app, { db, tokens }) => {
  app.decorateRequest('user', null as unknown as AuthUser);

  app.decorate('authenticate', async (req: FastifyRequest) => {
    const header = req.headers.authorization;
    const match = typeof header === 'string' ? /^Bearer ([^\s]+)$/i.exec(header) : null;
    if (!match?.[1]) throw new AppError('UNAUTHORIZED', 'Missing or malformed Authorization header');

    const { userId } = await tokens.verify(match[1]);
    // A still-valid token for a deleted or unverified account must not work.
    const [profile] = await db
      .select({ id: profiles.id, email: profiles.email, status: profiles.status })
      .from(profiles)
      .where(eq(profiles.id, userId));
    if (!profile || profile.status !== 'active') throw new AppError('UNAUTHORIZED', 'Account not found or not active');

    req.user = { id: profile.id, email: profile.email, accessToken: match[1] };
  });
});
