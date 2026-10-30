import { z } from 'zod';
import type { profiles } from '../../db/schema.js';
import { levelFor } from '../xp/config.js';

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
export function toUserView(p: typeof profiles.$inferSelect, xpTotal: number): UserView {
  const level = levelFor(xpTotal);
  return {
    id: p.id,
    fullName: p.fullName,
    email: p.email,
    avatarUrl: p.avatarUrl,
    xpTotal,
    level: { number: level.number, name: level.name },
    subscription: { status: 'free' },
  };
}
