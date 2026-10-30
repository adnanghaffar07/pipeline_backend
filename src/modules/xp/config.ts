/**
 * Tech XP configuration, from the designer PRD (requirements section 8). Every number the app shows comes from here,
 * so a rule change is a one-line edit. Values the client has not confirmed are marked "placeholder".
 */

export interface XpRule {
  label: string;
  xp: number;
  /** Max awards with XP per UTC day; later ones are logged with 0 XP. */
  dailyCap?: number;
  /** Counts as a learning day for the streak. */
  learning?: boolean;
}

export const XP_RULES = {
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
} as const satisfies Record<string, XpRule>;

export type XpEventType = keyof typeof XP_RULES;

export const LEARNING_TYPES = (Object.keys(XP_RULES) as XpEventType[]).filter(
  (t) => (XP_RULES[t] as XpRule).learning,
);

/** Minimums for an article read to count (requirements 8.7). */
export const READ_RULES = { minSeconds: 30, minScrollPercent: 80 };
export const MEDIA_RULES = { webinarAttendPercent: 80, webinarCompletePercent: 95, podcastPercent: 70, videoPercent: 80 };

/** Sage ends at 14,999 so 15,000 is unambiguously Visionary (the PRD lists 15,000 in both). */
export const LEVELS = [
  { number: 1, name: 'Explorer', minXp: 0 },
  { number: 2, name: 'Enthusiast', minXp: 101 },
  { number: 3, name: 'Techie', minXp: 501 },
  { number: 4, name: 'Expert', minXp: 1501 },
  { number: 5, name: 'Guru', minXp: 3501 },
  { number: 6, name: 'Sage', minXp: 7501 },
  { number: 7, name: 'Visionary', minXp: 15000 },
] as const;

export const STREAK_BONUSES = [
  { days: 7, xp: 10 },
  { days: 14, xp: 25 },
  { days: 30, xp: 50 },
  { days: 90, xp: 150 },
  { days: 365, xp: 500 },
] as const;

/** Today's Tasks. Each awards its bonus once per UTC day when any of its activities is logged. */
export const DAILY_TASKS = [
  { id: 'read_article', label: 'Read one article', xp: 1, completedBy: ['article_read', 'magazine_article_read', 'sponsored_article_read'] },
  { id: 'share_insight', label: 'Share an insight', xp: 2, completedBy: ['share'] },
  { id: 'watch_video', label: 'Watch a video', xp: 10, completedBy: ['video_watch', 'webinar_attend'] },
  { id: 'explore_research', label: 'Explore Research Center', xp: 5, completedBy: ['research_view'] },
] as const satisfies ReadonlyArray<{ id: string; label: string; xp: number; completedBy: readonly XpEventType[] }>;

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
  requirements: Array<{ metric: BadgeMetric; target: number; label: string }>;
}

const one = (metric: BadgeMetric, target: number, label: string) => [{ metric, target, label }];

/** Reading targets are from the PRD; the other groups' targets are placeholders until the client defines them. */
export const BADGES: BadgeDef[] = [
  { id: 'first_read', name: 'First Read', description: 'Read your first article', group: 'reading', requirements: one('articles_read', 1, 'Read 1 article') },
  { id: 'reader', name: 'Reader', description: 'Read 50 articles', group: 'reading', requirements: one('articles_read', 50, 'Read 50 articles') },
  { id: 'researcher', name: 'Researcher', description: 'Read 250 articles', group: 'reading', requirements: one('articles_read', 250, 'Read 250 articles') },
  { id: 'knowledge_master', name: 'Knowledge Master', description: 'Read 1,000 articles', group: 'reading', requirements: one('articles_read', 1000, 'Read 1,000 articles') },
  { id: 'webinar_starter', name: 'Webinar Starter', description: 'Attend your first webinar', group: 'webinars', requirements: one('webinars_attended', 1, 'Attend 1 webinar') },
  { id: 'webinar_explorer', name: 'Webinar Explorer', description: 'Attend 5 webinars', group: 'webinars', requirements: one('webinars_attended', 5, 'Attend 5 webinars') },
  { id: 'webinar_expert', name: 'Webinar Expert', description: 'Attend 20 webinars', group: 'webinars', requirements: one('webinars_attended', 20, 'Attend 20 webinars') },
  { id: 'first_listener', name: 'First Listener', description: 'Listen to your first podcast', group: 'podcasts', requirements: one('podcasts_listened', 1, 'Listen to 1 podcast') },
  { id: 'podcast_explorer', name: 'Podcast Explorer', description: 'Listen to 10 podcasts', group: 'podcasts', requirements: one('podcasts_listened', 10, 'Listen to 10 podcasts') },
  { id: 'podcast_master', name: 'Podcast Master', description: 'Listen to 50 podcasts', group: 'podcasts', requirements: one('podcasts_listened', 50, 'Listen to 50 podcasts') },
  { id: 'conversation_starter', name: 'Conversation Starter', description: 'Post your first comment', group: 'community', requirements: one('comments_posted', 1, 'Post 1 comment') },
  { id: 'active_voice', name: 'Active Voice', description: 'Post 25 comments', group: 'community', requirements: one('comments_posted', 25, 'Post 25 comments') },
  { id: 'discussion_expert', name: 'Discussion Expert', description: 'Post 100 comments', group: 'community', requirements: one('comments_posted', 100, 'Post 100 comments') },
];

export function levelFor(xp: number) {
  let i = 0;
  for (let k = 0; k < LEVELS.length; k++) if (xp >= LEVELS[k]!.minXp) i = k;
  const cur = LEVELS[i]!;
  const next = LEVELS[i + 1];
  return {
    number: cur.number,
    name: cur.name,
    minXp: cur.minXp,
    nextLevelXp: next ? next.minXp : null,
    xpToNext: next ? next.minXp - xp : 0,
  };
}
