import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { appSettings } from '../../db/schema.js';

/**
 * Tech XP configuration, from the designer PRD (requirements section 8).
 * The defaults live here; an admin can override any number at runtime (PUT /admin/xp/config), which is stored in
 * `app_settings` under the key "xp" and merged over these defaults. Values the client has not confirmed are marked
 * "placeholder".
 */

export interface XpRule {
  label: string;
  xp: number;
  /** Max awards with XP per day (user's time zone); later ones are logged with 0 XP. */
  dailyCap?: number;
  /** Counts as a learning day for the streak. Not overridable. */
  learning?: boolean;
}

const DEFAULT_RULES = {
  article_read: { label: 'Read an article', xp: 1, learning: true },
  magazine_article_read: { label: 'Read a magazine article', xp: 2, learning: true },
  sponsored_article_read: { label: 'Read a sponsored article', xp: 2, learning: true },
  sponsored_quiz_complete: { label: 'Complete a sponsored quiz or poll', xp: 5 },
  issue_complete: { label: 'Complete a magazine issue', xp: 10, learning: true },
  share: { label: 'Share content', xp: 2 },
  webinar_attend: { label: 'Attend a webinar', xp: 5, learning: true },
  webinar_complete: { label: 'Complete a webinar', xp: 10, learning: true },
  podcast_listen: { label: 'Listen to a podcast', xp: 3, learning: true },
  video_watch: { label: 'Watch a video', xp: 0, learning: true },
  research_view: { label: 'Explore the Research Center', xp: 0 },
  report_download: { label: 'Download a report', xp: 5 },
  content_save: { label: 'Save content', xp: 1 },
  comment: { label: 'Comment', xp: 3, dailyCap: 5 },
  reply: { label: 'Reply to a comment', xp: 2, dailyCap: 5 },
  like_received: { label: 'Comment received a like', xp: 1, dailyCap: 10 },
  profile_job_title: { label: 'Add job role', xp: 5 },
  profile_company: { label: 'Add company information', xp: 5 },
  profile_expertise: { label: 'Add expertise areas', xp: 10 },
  profile_complete: { label: 'Complete profile', xp: 10 },
  interests_selected: { label: 'Select technology interests', xp: 5 },
  streak_bonus: { label: 'Streak bonus', xp: 0 },
  task_bonus: { label: 'Daily task', xp: 0 },
  reversal: { label: 'XP adjustment', xp: 0 },
} as const satisfies Record<string, XpRule>;

export type XpEventType = keyof typeof DEFAULT_RULES;
export const XP_EVENT_TYPES = Object.keys(DEFAULT_RULES) as XpEventType[];
/** Rows written only by the engine itself; their amount is not a rule value. */
const SYSTEM_TYPES = new Set<XpEventType>(['streak_bonus', 'task_bonus', 'reversal']);

export const LEARNING_TYPES = XP_EVENT_TYPES.filter((t) => (DEFAULT_RULES[t] as XpRule).learning);

export type BadgeMetric = 'articles_read' | 'webinars_attended' | 'podcasts_listened' | 'comments_posted' | 'longest_streak';

export const METRIC_UNITS: Record<BadgeMetric, string> = {
  articles_read: 'articles',
  webinars_attended: 'webinars',
  podcasts_listened: 'podcasts',
  comments_posted: 'comments',
  longest_streak: 'days',
};

export interface BadgeDef {
  id: string;
  name: string;
  description: string;
  group: 'reading' | 'webinars' | 'podcasts' | 'community';
  /** null until hosted artwork exists; the app shows its own icon for the badge id. */
  iconUrl: string | null;
  requirements: Array<{ metric: BadgeMetric; target: number; label: string }>;
}

const badge = (id: string, name: string, group: BadgeDef['group'], metric: BadgeMetric, target: number, noun: string, verb: string): BadgeDef => ({
  id,
  name,
  group,
  description: `${verb} ${target === 1 ? `your first ${noun}` : `${target.toLocaleString('en-US')} ${noun}s`}`,
  iconUrl: null,
  requirements: [{ metric, target, label: `${verb} ${target.toLocaleString('en-US')} ${target === 1 ? noun : `${noun}s`}` }],
});

/** Reading targets are from the PRD; the other groups' targets are placeholders until the client defines them. */
const DEFAULT_BADGES: BadgeDef[] = [
  badge('first_read', 'First Read', 'reading', 'articles_read', 1, 'article', 'Read'),
  badge('reader', 'Reader', 'reading', 'articles_read', 50, 'article', 'Read'),
  badge('researcher', 'Researcher', 'reading', 'articles_read', 250, 'article', 'Read'),
  badge('knowledge_master', 'Knowledge Master', 'reading', 'articles_read', 1000, 'article', 'Read'),
  badge('webinar_starter', 'Webinar Starter', 'webinars', 'webinars_attended', 1, 'webinar', 'Attend'),
  badge('webinar_explorer', 'Webinar Explorer', 'webinars', 'webinars_attended', 5, 'webinar', 'Attend'),
  badge('webinar_expert', 'Webinar Expert', 'webinars', 'webinars_attended', 20, 'webinar', 'Attend'),
  badge('first_listener', 'First Listener', 'podcasts', 'podcasts_listened', 1, 'podcast', 'Listen to'),
  badge('podcast_explorer', 'Podcast Explorer', 'podcasts', 'podcasts_listened', 10, 'podcast', 'Listen to'),
  badge('podcast_master', 'Podcast Master', 'podcasts', 'podcasts_listened', 50, 'podcast', 'Listen to'),
  badge('conversation_starter', 'Conversation Starter', 'community', 'comments_posted', 1, 'comment', 'Post'),
  badge('active_voice', 'Active Voice', 'community', 'comments_posted', 25, 'comment', 'Post'),
  badge('discussion_expert', 'Discussion Expert', 'community', 'comments_posted', 100, 'comment', 'Post'),
];

const DEFAULT_TASKS = [
  { id: 'read_article', label: 'Read one article', xp: 1, completedBy: ['article_read', 'magazine_article_read', 'sponsored_article_read'] },
  { id: 'share_insight', label: 'Share an insight', xp: 2, completedBy: ['share'] },
  { id: 'watch_video', label: 'Watch a video', xp: 10, completedBy: ['video_watch', 'webinar_attend'] },
  { id: 'explore_research', label: 'Explore Research Center', xp: 5, completedBy: ['research_view'] },
] satisfies Array<{ id: string; label: string; xp: number; completedBy: XpEventType[] }>;

export const DEFAULT_XP_CONFIG = {
  rules: DEFAULT_RULES as Record<XpEventType, XpRule>,
  /** Sage ends at 14,999 so 15,000 is unambiguously Visionary (the PRD lists 15,000 in both). */
  levels: [
    { number: 1, name: 'Explorer', minXp: 0 },
    { number: 2, name: 'Enthusiast', minXp: 101 },
    { number: 3, name: 'Techie', minXp: 501 },
    { number: 4, name: 'Expert', minXp: 1501 },
    { number: 5, name: 'Guru', minXp: 3501 },
    { number: 6, name: 'Sage', minXp: 7501 },
    { number: 7, name: 'Visionary', minXp: 15000 },
  ],
  streakBonuses: [
    { days: 7, xp: 10 },
    { days: 14, xp: 25 },
    { days: 30, xp: 50 },
    { days: 90, xp: 150 },
    { days: 365, xp: 500 },
  ],
  dailyTasks: DEFAULT_TASKS as Array<{ id: string; label: string; xp: number; completedBy: XpEventType[] }>,
  badges: DEFAULT_BADGES,
  /** Minimums for an article read to count (requirements 8.7). */
  read: { minSeconds: 30, minScrollPercent: 80 },
  media: { webinarAttendPercent: 80, webinarCompletePercent: 95, podcastPercent: 70, videoPercent: 80 },
  /** Comment quality (8.7): short comments still post but earn nothing; a burst of likes from one person pays nothing more. */
  community: { minCommentLengthForXp: 10, maxLikeXpPerLikerPerAuthorPerHour: 5 },
  leaderboard: { nameStyle: 'full' as 'full' | 'first_initial' },
};

export type XpConfig = typeof DEFAULT_XP_CONFIG;

const int = (min = 0) => z.number().int().min(min);

/** What an admin may change. Every field is optional; anything left out keeps its default. */
export const xpConfigOverride = z
  .object({
    rules: z
      .record(z.string(), z.object({ xp: int().max(10_000).optional(), dailyCap: int(1).max(1000).nullable().optional() }))
      .refine((r) => Object.keys(r).every((k) => XP_EVENT_TYPES.includes(k as XpEventType) && !SYSTEM_TYPES.has(k as XpEventType)), {
        message: 'Unknown or system event type',
      }),
    levels: z
      .array(z.object({ name: z.string().trim().min(1).max(40), minXp: int() }))
      .min(1)
      .max(20)
      .refine((l) => l[0]!.minXp === 0 && l.every((x, i) => i === 0 || x.minXp > l[i - 1]!.minXp), {
        message: 'Levels must start at 0 XP and increase',
      }),
    streakBonuses: z
      .array(z.object({ days: int(2).max(3650), xp: int().max(10_000) }))
      .max(20)
      .refine((b) => new Set(b.map((x) => x.days)).size === b.length, { message: 'Streak days must be unique' }),
    dailyTasks: z.record(z.string(), z.object({ xp: int().max(10_000) })).refine(
      (t) => Object.keys(t).every((k) => DEFAULT_TASKS.some((d) => d.id === k)),
      { message: 'Unknown task id' },
    ),
    badges: z
      .record(z.string(), z.object({ target: int(1).max(1_000_000).optional(), iconUrl: z.url().max(2048).nullable().optional() }))
      .refine((b) => Object.keys(b).every((k) => DEFAULT_BADGES.some((d) => d.id === k)), { message: 'Unknown badge id' }),
    read: z.object({ minSeconds: int().max(3600), minScrollPercent: int().max(100) }).partial(),
    media: z
      .object({ webinarAttendPercent: int().max(100), webinarCompletePercent: int().max(100), podcastPercent: int().max(100), videoPercent: int().max(100) })
      .partial(),
    community: z.object({ minCommentLengthForXp: int().max(500), maxLikeXpPerLikerPerAuthorPerHour: int().max(1000) }).partial(),
    leaderboard: z.object({ nameStyle: z.enum(['full', 'first_initial']) }).partial(),
  })
  .partial()
  .strict();

export type XpConfigOverride = z.infer<typeof xpConfigOverride>;

export function mergeXpConfig(o: XpConfigOverride | null | undefined): XpConfig {
  const d = DEFAULT_XP_CONFIG;
  if (!o) return d;
  const rules = { ...d.rules };
  for (const [k, v] of Object.entries(o.rules ?? {})) {
    const base = rules[k as XpEventType];
    const next: XpRule = { ...base, xp: v.xp ?? base.xp };
    if (v.dailyCap === null) delete next.dailyCap;
    else if (v.dailyCap !== undefined) next.dailyCap = v.dailyCap;
    rules[k as XpEventType] = next;
  }
  return {
    rules,
    levels: o.levels ? o.levels.map((l, i) => ({ number: i + 1, name: l.name, minXp: l.minXp })) : d.levels,
    streakBonuses: o.streakBonuses ? [...o.streakBonuses].sort((a, b) => a.days - b.days) : d.streakBonuses,
    dailyTasks: d.dailyTasks.map((t) => ({ ...t, xp: o.dailyTasks?.[t.id]?.xp ?? t.xp })),
    badges: d.badges.map((b) => {
      const ov = o.badges?.[b.id];
      if (!ov) return b;
      const target = ov.target ?? b.requirements[0]!.target;
      const rebuilt = badge(b.id, b.name, b.group, b.requirements[0]!.metric, target, ...nounVerb(b));
      return { ...rebuilt, iconUrl: ov.iconUrl === undefined ? b.iconUrl : ov.iconUrl };
    }),
    read: { ...d.read, ...o.read },
    media: { ...d.media, ...o.media },
    community: { ...d.community, ...o.community },
    leaderboard: { ...d.leaderboard, ...o.leaderboard },
  };
}

function nounVerb(b: BadgeDef): [string, string] {
  switch (b.group) {
    case 'reading':
      return ['article', 'Read'];
    case 'webinars':
      return ['webinar', 'Attend'];
    case 'podcasts':
      return ['podcast', 'Listen to'];
    default:
      return ['comment', 'Post'];
  }
}

export const XP_SETTINGS_KEY = 'xp';
const CACHE_MS = 30_000;
const cache = new WeakMap<Db, { at: number; config: XpConfig; override: XpConfigOverride | null }>();

async function load(db: Db) {
  const hit = cache.get(db);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit;
  const [row] = await db.select({ value: appSettings.value }).from(appSettings).where(eq(appSettings.key, XP_SETTINGS_KEY));
  const parsed = row ? xpConfigOverride.safeParse(row.value) : null;
  // A stored value that no longer validates (e.g. after a code change) falls back to defaults rather than failing requests.
  const override = parsed?.success ? parsed.data : null;
  const entry = { at: Date.now(), config: mergeXpConfig(override), override };
  cache.set(db, entry);
  return entry;
}

/** Effective config: defaults merged with the admin override. Cached for 30 s per process. */
export async function getXpConfig(db: Db): Promise<XpConfig> {
  return (await load(db)).config;
}

export async function getXpOverride(db: Db): Promise<XpConfigOverride | null> {
  return (await load(db)).override;
}

export function invalidateXpConfig(db: Db) {
  cache.delete(db);
}

export function levelFor(xp: number, levels: XpConfig['levels'] = DEFAULT_XP_CONFIG.levels) {
  let i = 0;
  for (let k = 0; k < levels.length; k++) if (xp >= levels[k]!.minXp) i = k;
  const cur = levels[i]!;
  const next = levels[i + 1];
  return {
    number: cur.number,
    name: cur.name,
    minXp: cur.minXp,
    nextLevelXp: next ? next.minXp : null,
    xpToNext: next ? next.minXp - xp : 0,
  };
}
