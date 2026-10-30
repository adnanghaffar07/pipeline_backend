import { z } from 'zod';

const contentTypes = ['latest_issue', 'breaking_news', 'news', 'research', 'video', 'webinar', 'podcast', 'system'] as const;
const allTypes = [...contentTypes, 'connection_request', 'connection_accepted'] as const;

export const target = z.object({
  /** What to open: article, news, issue, video, webinar, podcast, research, person, url… */
  type: z.string().regex(/^[a-z_]{2,30}$/, 'Invalid target type'),
  id: z.string().min(1).max(2048),
});

export const notificationItem = z.object({
  id: z.string(),
  type: z.enum(allTypes),
  label: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  coverUrl: z.string().nullable(),
  xpValue: z.number().int().nullable(),
  isPremium: z.boolean(),
  target: target.nullable(),
  /** The member the notification is about (networking alerts); null otherwise. */
  actor: z.object({ id: z.string(), fullName: z.string(), avatarUrl: z.string().nullable() }).nullable(),
  read: z.boolean(),
  createdAt: z.string(),
});

export const feedQuery = z.object({
  filter: z.enum(['all', 'latest_issue', 'news', 'research']).default('all'),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const feedResponse = z.object({
  items: z.array(notificationItem),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
  unreadCount: z.number().int(),
});

export const idParams = z.object({ notificationId: z.uuid() });
export const unreadResponse = z.object({ unreadCount: z.number().int() });

export const deviceBody = z.object({
  /** FCM registration token from the Firebase SDK on the device. */
  token: z.string().trim().min(20).max(4096),
  platform: z.enum(['ios', 'android', 'web']),
  appVersion: z.string().trim().max(40).optional(),
});
export const deviceResponse = z.object({
  registered: z.boolean(),
  /** false until the server has Firebase credentials; the in-app feed works either way. */
  pushEnabled: z.boolean(),
});
export const deviceParams = z.object({ token: z.string().min(20).max(4096) });

export const broadcastBody = z.object({
  type: z.enum(contentTypes),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(300).optional(),
  /** Defaults by type ("Latest issue", "Breaking news", …). */
  label: z.string().trim().min(1).max(40).optional(),
  coverUrl: z.url().max(2048).optional(),
  xpValue: z.number().int().min(0).max(10_000).optional(),
  isPremium: z.boolean().default(false),
  target: target.optional(),
  /** Only members with at least one of these interests. Omit for everyone. */
  audienceTopicIds: z.array(z.number().int().positive()).max(50).optional(),
  push: z.boolean().default(true),
});

export const broadcastResponse = z.object({
  id: z.string(),
  pushEnabled: z.boolean(),
  push: z.object({ sent: z.number().int(), failed: z.number().int(), devices: z.number().int() }),
});

export const broadcastList = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      label: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      audienceTopicIds: z.array(z.number().int()).nullable(),
      target: target.nullable(),
      reads: z.number().int(),
      createdAt: z.string(),
    }),
  ),
});
