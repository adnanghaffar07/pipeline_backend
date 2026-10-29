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

/** XP, level and subscription are fixed defaults until the gamification and subscription modules exist. */
export function toUserView(p: typeof profiles.$inferSelect): UserView {
  return {
    id: p.id,
    fullName: p.fullName,
    email: p.email,
    avatarUrl: p.avatarUrl,
    xpTotal: 0,
    level: { number: 1, name: 'Explorer' },
    subscription: { status: 'free' },
  };
}
