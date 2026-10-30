import { z } from 'zod';

export const connectionState = z.enum(['none', 'sent', 'received', 'connected', 'self']);

/** A member as shown on Discover, Requests and Connections cards. */
export const personCard = z.object({
  id: z.string(),
  fullName: z.string(),
  initials: z.string(),
  avatarUrl: z.string().nullable(),
  jobTitle: z.string().nullable(),
  company: z.string().nullable(),
  location: z.string().nullable(),
  /** none · sent (I asked) · received (they asked) · connected · self */
  connectionState,
  /** Pass to accept / decline / DELETE; null when state is none or self. */
  connectionId: z.string().nullable(),
  mutualConnections: z.number().int(),
  sharedInterests: z.number().int(),
});

export const personList = z.object({
  items: z.array(personCard),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
});

export const memberProfile = personCard.extend({
  bio: z.string().nullable(),
  expertiseAreas: z.array(z.string()),
  interests: z.array(z.object({ id: z.number().int(), name: z.string() })),
  /** Filled only when connected AND the member shares that field; otherwise show the "not shared yet" lock card. */
  contact: z.object({
    email: z.string().nullable(),
    phone: z.string().nullable(),
    locked: z.boolean(),
  }),
});

export const peopleQuery = z.object({
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const connectionsQuery = peopleQuery.extend({
  status: z.enum(['connected', 'received', 'sent']).default('connected'),
});

export const connectionsResponse = personList.extend({
  counts: z.object({ connected: z.number().int(), received: z.number().int(), sent: z.number().int() }),
});

export const personParams = z.object({ personId: z.uuid({ message: 'Invalid member id' }) });
export const connectionParams = z.object({ connectionId: z.uuid({ message: 'Invalid connection id' }) });
export const sendBody = z.object({ toUserId: z.uuid({ message: 'Invalid member id' }) });

export const reportBody = z.object({
  reason: z.enum(['spam', 'harassment', 'fake_profile', 'inappropriate', 'other']),
  details: z.string().trim().max(1000).optional(),
  /** Also block them in the same call. */
  block: z.boolean().default(false),
});
export const reportCreated = z.object({ reportId: z.string(), blocked: z.boolean() });

export const blockedList = z.object({
  items: z.array(
    z.object({ id: z.string(), fullName: z.string(), initials: z.string(), avatarUrl: z.string().nullable(), blockedAt: z.string() }),
  ),
});

// ---- Admin ----
export const adminReportsQuery = z.object({
  status: z.enum(['open', 'reviewed', 'dismissed']).default('open'),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const adminReport = z.object({
  id: z.string(),
  reason: z.string(),
  details: z.string().nullable(),
  status: z.string(),
  createdAt: z.string(),
  reviewedAt: z.string().nullable(),
  reporter: z.object({ id: z.string(), fullName: z.string(), email: z.string() }).nullable(),
  reported: z.object({ id: z.string(), fullName: z.string(), email: z.string() }),
  reportsAgainstMember: z.number().int(),
});
export const adminReportList = z.object({ items: z.array(adminReport), nextCursor: z.string().nullable(), total: z.number().int() });
export const reportParams = z.object({ reportId: z.uuid() });
export const reportPatch = z.object({ status: z.enum(['reviewed', 'dismissed']) });
