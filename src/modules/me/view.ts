import { z } from 'zod';
import type { profiles } from '../../db/schema.js';

export const userViewSchema = z.object({
  id: z.string(),
  fullName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  xpTotal: z.number().int(),
  level: z.object({ number: z.number().int(), name: z.string() }),
  subscription: z.object({ status: z.enum(['free', 'active', 'grace', 'expired', 'canceled']) }),
});

export type UserView = z.infer<typeof userViewSchema>;

/** Subscription is a fixed default until the subscription module exists. */
export function toUserView(
  p: typeof profiles.$inferSelect,
  xp: { xpTotal: number; level: { number: number; name: string } },
): UserView {
  return {
    id: p.id,
    fullName: p.fullName,
    email: p.email,
    avatarUrl: p.avatarUrl,
    xpTotal: xp.xpTotal,
    level: xp.level,
    subscription: { status: 'free' },
  };
}
