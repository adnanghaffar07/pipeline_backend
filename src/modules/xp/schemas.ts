import { z } from 'zod';

const refId = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'Invalid content id');
const refType = z.enum(['article', 'news', 'issue', 'research', 'report', 'video', 'podcast', 'webinar']);
const percent = z.number().min(0).max(100);

/** What the app reports. The server decides what (if anything) it is worth. */
export const eventBody = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('article_complete'),
    refId,
    metadata: z.object({
      kind: z.enum(['regular', 'magazine', 'sponsored']).default('regular'),
      secondsOnPage: z.number().min(0).max(86_400),
      scrollPercent: percent,
    }),
  }),
  z.object({ type: z.literal('quiz_complete'), refId }),
  z.object({ type: z.literal('issue_complete'), refId }),
  z.object({
    type: z.literal('share'),
    refType,
    refId,
    metadata: z.object({ channel: z.string().trim().min(1).max(40) }),
  }),
  z.object({ type: z.literal('webinar_progress'), refId, metadata: z.object({ watchedPercent: percent }) }),
  z.object({ type: z.literal('podcast_progress'), refId, metadata: z.object({ listenedPercent: percent }) }),
  z.object({ type: z.literal('video_progress'), refId, metadata: z.object({ watchedPercent: percent }) }),
  z.object({ type: z.literal('report_download'), refType: z.enum(['report', 'research']), refId }),
  z.object({ type: z.literal('content_save'), refType, refId }),
  z.object({ type: z.literal('research_view') }),
]);

export type EventBody = z.infer<typeof eventBody>;

export const levelView = z.object({
  number: z.number().int(),
  name: z.string(),
  minXp: z.number().int(),
  nextLevelXp: z.number().int().nullable(),
  xpToNext: z.number().int(),
});

const badgeRef = z.object({ id: z.string(), name: z.string() });
const streakView = z.object({ current: z.number().int(), longest: z.number().int() });

export const eventResponse = z.object({
  accepted: z.boolean(),
  /** Why nothing was logged, e.g. "Read for at least 30 seconds and scroll 80% of the article". */
  reason: z.string().nullable(),
  awards: z.array(z.object({ type: z.string(), label: z.string(), xp: z.number().int() })),
  xpAwarded: z.number().int(),
  xpTotal: z.number().int(),
  level: levelView,
  leveledUp: z.boolean(),
  newBadges: z.array(badgeRef),
  streak: streakView,
});

const requirementView = z.object({
  label: z.string(),
  current: z.number().int(),
  target: z.number().int(),
  unit: z.string(),
  percent: z.number().int(),
  complete: z.boolean(),
});

export const badgeView = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  group: z.string(),
  /** null until hosted artwork is set; show the app's own icon for `id`. */
  iconUrl: z.string().nullable(),
  earned: z.boolean(),
  earnedAt: z.string().nullable(),
  requirements: z.array(requirementView),
  completedCount: z.number().int(),
  totalCount: z.number().int(),
});

export const badgesResponse = z.object({
  items: z.array(badgeView),
  earnedCount: z.number().int(),
  totalCount: z.number().int(),
});

export const taskView = z.object({ id: z.string(), label: z.string(), xp: z.number().int(), done: z.boolean() });
export const tasksResponse = z.object({ items: z.array(taskView), doneCount: z.number().int(), totalCount: z.number().int() });

export const progressResponse = z.object({
  xpTotal: z.number().int(),
  level: levelView,
  streak: streakView,
  stats: z.object({ xpThisWeek: z.number().int(), articlesRead: z.number().int(), currentStreak: z.number().int() }),
  dailyTasks: tasksResponse,
  nextBadge: badgeView.nullable(),
  recentBadges: z.array(badgeView),
  profileCompletion: z.number().int(),
});

export const xpQuery = z.object({ period: z.enum(['week', 'month']).default('week') });
export const xpResponse = z.object({
  period: z.enum(['week', 'month']),
  from: z.string(),
  to: z.string(),
  total: z.number().int(),
  previousTotal: z.number().int(),
  /** null when the previous period had no XP. */
  growthPercent: z.number().int().nullable(),
  breakdown: z.array(
    z.object({ type: z.string(), label: z.string(), count: z.number().int(), xpPerUnit: z.number().int().nullable(), xp: z.number().int() }),
  ),
  daily: z.array(z.object({ date: z.string(), xp: z.number().int() })),
});

export const historyQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export const historyResponse = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      label: z.string(),
      xp: z.number().int(),
      refType: z.string().nullable(),
      refId: z.string().nullable(),
      /** Set on admin XP adjustments (negative `xp`). */
      reason: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
});

export const streakQuery = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
  month: z.coerce.number().int().min(1).max(12).optional(),
});
export const streakResponse = z.object({
  current: z.number().int(),
  longest: z.number().int(),
  year: z.number().int(),
  month: z.number().int(),
  /** The time zone the days are counted in (the user's setting, or UTC). */
  timezone: z.string(),
  activeDates: z.array(z.string()),
});

export const leaderboardQuery = z.object({
  period: z.enum(['weekly', 'monthly', 'all_time']).default('weekly'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export const leaderboardResponse = z.object({
  period: z.enum(['weekly', 'monthly', 'all_time']),
  items: z.array(
    z.object({
      rank: z.number().int(),
      userId: z.string(),
      name: z.string(),
      initials: z.string(),
      avatarUrl: z.string().nullable(),
      xp: z.number().int(),
      crown: z.enum(['gold', 'silver', 'bronze']).nullable(),
      isMe: z.boolean(),
    }),
  ),
  /** `hidden` = the user opted out, so they have no rank and others don't see them. */
  me: z.object({ rank: z.number().int().nullable(), xp: z.number().int(), xpThisWeek: z.number().int(), hidden: z.boolean() }),
});

export const rulesResponse = z.object({
  rules: z.array(z.object({ type: z.string(), label: z.string(), xp: z.number().int(), dailyCap: z.number().int().nullable() })),
  levels: z.array(z.object({ number: z.number().int(), name: z.string(), minXp: z.number().int() })),
  streakBonuses: z.array(z.object({ days: z.number().int(), xp: z.number().int() })),
  dailyTasks: z.array(z.object({ id: z.string(), label: z.string(), xp: z.number().int() })),
  thresholds: z.object({
    read: z.object({ minSeconds: z.number().int(), minScrollPercent: z.number().int() }),
    media: z.object({
      webinarAttendPercent: z.number().int(),
      webinarCompletePercent: z.number().int(),
      podcastPercent: z.number().int(),
      videoPercent: z.number().int(),
    }),
    community: z.object({ minCommentLengthForXp: z.number().int(), maxLikeXpPerLikerPerAuthorPerHour: z.number().int() }),
  }),
});

// ---- Admin ----------------------------------------------------------------------------------------------------

export const adminConfigResponse = z.object({
  /** What the admin has changed (null = all defaults). */
  override: z.record(z.string(), z.unknown()).nullable(),
  /** The full rule set in force: defaults merged with the override. */
  effective: z.record(z.string(), z.unknown()),
});

export const adminEventsQuery = historyQuery.extend({ userId: z.uuid().optional() });
export const adminEventsResponse = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      userId: z.string(),
      type: z.string(),
      label: z.string(),
      xp: z.number().int(),
      refType: z.string().nullable(),
      refId: z.string().nullable(),
      reason: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
});

export const reversalBody = z.object({
  eventId: z.uuid(),
  reason: z.string().trim().min(3, 'Say why (at least 3 characters)').max(500),
});
export const reversalResponse = z.object({
  reversalId: z.string(),
  userId: z.string(),
  xpRemoved: z.number().int(),
  xpTotal: z.number().int(),
});
