import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../../db/client.js';
import { profiles, userBadges, xpEvents } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { decodeCursor, encodeCursor, listEnvelope } from '../../lib/pagination.js';
import { completion } from '../profile/service.js';
import {
  BADGES,
  DAILY_TASKS,
  LEVELS,
  MEDIA_RULES,
  METRIC_UNITS,
  READ_RULES,
  STREAK_BONUSES,
  XP_RULES,
  levelFor,
  type BadgeDef,
  type XpEventType,
  type XpRule,
} from './config.js';
import { XpEngine, badgeMetrics, learningDays, startOfUtcDay, streakFrom, utcDay, xpTotal, type AwardInput } from './engine.js';
import type { EventBody, badgeView } from './schemas.js';

const DAY_MS = 864e5;
type BadgeView = z.infer<typeof badgeView>;

const labelOf = (type: string) => (XP_RULES as Record<string, XpRule>)[type]?.label ?? type;

/** Monday 00:00 UTC of the week containing `d`. */
function startOfUtcWeek(d: Date) {
  const day = startOfUtcDay(d);
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * DAY_MS);
}
const startOfUtcMonth = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase() || '?';
}

export class XpService {
  readonly engine: XpEngine;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.engine = new XpEngine(db, now);
  }

  // ---- POST /events -------------------------------------------------------------------------------------------

  /** Turns an app-reported activity into ledger entries, applying the integrity rules (requirements 8.7). */
  async recordEvent(userId: string, e: EventBody) {
    const inputs: AwardInput[] = [];
    let reason: string | null = null;

    switch (e.type) {
      case 'article_complete': {
        const { kind, secondsOnPage, scrollPercent } = e.metadata;
        if (secondsOnPage < READ_RULES.minSeconds || scrollPercent < READ_RULES.minScrollPercent) {
          reason = `Read for at least ${READ_RULES.minSeconds} seconds and scroll ${READ_RULES.minScrollPercent}% of the article`;
          break;
        }
        const type = kind === 'magazine' ? 'magazine_article_read' : kind === 'sponsored' ? 'sponsored_article_read' : 'article_read';
        // One key per article, whatever kind is claimed, so an article can only ever pay once.
        inputs.push({ type, refType: 'article', refId: e.refId, key: `read:article:${e.refId}`, metadata: e.metadata });
        break;
      }
      case 'quiz_complete':
        inputs.push({ type: 'sponsored_quiz_complete', refType: 'article', refId: e.refId, key: `quiz:article:${e.refId}` });
        break;
      case 'issue_complete':
        inputs.push({ type: 'issue_complete', refType: 'issue', refId: e.refId, key: `issue:${e.refId}` });
        break;
      case 'share':
        inputs.push({ type: 'share', refType: e.refType, refId: e.refId, key: `share:${e.refType}:${e.refId}`, metadata: e.metadata });
        break;
      case 'webinar_progress': {
        const pct = e.metadata.watchedPercent;
        if (pct < MEDIA_RULES.webinarAttendPercent) {
          reason = `Watch at least ${MEDIA_RULES.webinarAttendPercent}% of the webinar`;
          break;
        }
        inputs.push({ type: 'webinar_attend', refType: 'webinar', refId: e.refId, key: `webinar_attend:${e.refId}`, metadata: e.metadata });
        if (pct >= MEDIA_RULES.webinarCompletePercent) {
          inputs.push({ type: 'webinar_complete', refType: 'webinar', refId: e.refId, key: `webinar_complete:${e.refId}`, metadata: e.metadata });
        }
        break;
      }
      case 'podcast_progress':
        if (e.metadata.listenedPercent < MEDIA_RULES.podcastPercent) {
          reason = `Listen to at least ${MEDIA_RULES.podcastPercent}% of the episode`;
          break;
        }
        inputs.push({ type: 'podcast_listen', refType: 'podcast', refId: e.refId, key: `podcast:${e.refId}`, metadata: e.metadata });
        break;
      case 'video_progress':
        if (e.metadata.watchedPercent < MEDIA_RULES.videoPercent) {
          reason = `Watch at least ${MEDIA_RULES.videoPercent}% of the video`;
          break;
        }
        inputs.push({ type: 'video_watch', refType: 'video', refId: e.refId, metadata: e.metadata });
        break;
      case 'report_download':
        inputs.push({ type: 'report_download', refType: e.refType, refId: e.refId, key: `download:${e.refType}:${e.refId}` });
        break;
      case 'content_save':
        inputs.push({ type: 'content_save', refType: e.refType, refId: e.refId, key: `save:${e.refType}:${e.refId}` });
        break;
      case 'research_view':
        inputs.push({ type: 'research_view' });
        break;
    }

    const result = await this.engine.award(userId, inputs);
    return { accepted: inputs.length > 0, reason, ...result };
  }

  // ---- Reads --------------------------------------------------------------------------------------------------

  async tasks(userId: string) {
    const today = utcDay(this.now());
    const rows = await this.db
      .select({ key: xpEvents.idempotencyKey })
      .from(xpEvents)
      .where(and(eq(xpEvents.userId, userId), eq(xpEvents.eventType, 'task_bonus'), sql`${xpEvents.idempotencyKey} like ${`task:%:${today}`}`));
    const done = new Set(rows.map((r) => r.key));
    const items = DAILY_TASKS.map((t) => ({ id: t.id, label: t.label, xp: t.xp, done: done.has(`task:${t.id}:${today}`) }));
    return { items, doneCount: items.filter((i) => i.done).length, totalCount: items.length };
  }

  async badges(userId: string) {
    const streak = streakFrom(await learningDays(this.db, userId), utcDay(this.now()));
    const metrics = await badgeMetrics(this.db, userId, streak.longest);
    const earned = new Map(
      (await this.db.select().from(userBadges).where(eq(userBadges.userId, userId))).map((r) => [r.badgeId, r.earnedAt]),
    );
    const view = (b: BadgeDef): BadgeView => {
      const requirements = b.requirements.map((r) => {
        const current = Math.min(metrics[r.metric], r.target);
        return {
          label: r.label,
          current,
          target: r.target,
          unit: METRIC_UNITS[r.metric],
          percent: Math.floor((current / r.target) * 100),
          complete: current >= r.target,
        };
      });
      const at = earned.get(b.id);
      return {
        id: b.id,
        name: b.name,
        description: b.description,
        group: b.group,
        earned: Boolean(at),
        earnedAt: at ? at.toISOString() : null,
        requirements,
        completedCount: requirements.filter((r) => r.complete).length,
        totalCount: requirements.length,
      };
    };
    const items = BADGES.map(view);
    return { items, earnedCount: items.filter((b) => b.earned).length, totalCount: items.length };
  }

  /** The unearned badge the user is closest to (highest average progress; catalogue order breaks ties). */
  nextBadgeOf(items: BadgeView[]) {
    const avg = (b: BadgeView) => b.requirements.reduce((s, r) => s + r.current / r.target, 0) / b.requirements.length;
    let best: BadgeView | null = null;
    for (const b of items) if (!b.earned && (!best || avg(b) > avg(best))) best = b;
    return best;
  }

  private async sumSince(userId: string, from: Date, to?: Date) {
    const [r] = await this.db
      .select({ n: sql<number>`coalesce(sum(${xpEvents.amount}), 0)`.mapWith(Number) })
      .from(xpEvents)
      .where(and(eq(xpEvents.userId, userId), gte(xpEvents.createdAt, from), to ? lt(xpEvents.createdAt, to) : undefined));
    return r?.n ?? 0;
  }

  async progress(userId: string) {
    const now = this.now();
    const [total, days, tasks, badges, xpThisWeek, [profile]] = await Promise.all([
      xpTotal(this.db, userId),
      learningDays(this.db, userId),
      this.tasks(userId),
      this.badges(userId),
      this.sumSince(userId, startOfUtcWeek(now)),
      this.db.select().from(profiles).where(eq(profiles.id, userId)),
    ]);
    const streak = streakFrom(days, utcDay(now));
    const metrics = await badgeMetrics(this.db, userId, streak.longest);
    const recentBadges = badges.items
      .filter((b) => b.earned)
      .sort((a, b) => (b.earnedAt ?? '').localeCompare(a.earnedAt ?? ''))
      .slice(0, 3);
    return {
      xpTotal: total,
      level: levelFor(total),
      streak: { current: streak.current, longest: streak.longest },
      stats: { xpThisWeek, articlesRead: metrics.articles_read, currentStreak: streak.current },
      dailyTasks: tasks,
      nextBadge: this.nextBadgeOf(badges.items),
      recentBadges,
      profileCompletion: profile ? completion(profile).percent : 0,
    };
  }

  async xpSummary(userId: string, period: 'week' | 'month') {
    const now = this.now();
    const from = period === 'week' ? startOfUtcWeek(now) : startOfUtcMonth(now);
    const prevFrom =
      period === 'week' ? new Date(from.getTime() - 7 * DAY_MS) : new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() - 1, 1));
    const to = period === 'week' ? new Date(from.getTime() + 7 * DAY_MS) : new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));

    const [total, previousTotal, byType, byDay] = await Promise.all([
      this.sumSince(userId, from),
      this.sumSince(userId, prevFrom, from),
      this.db
        .select({
          type: xpEvents.eventType,
          count: sql<number>`count(*)`.mapWith(Number),
          xp: sql<number>`sum(${xpEvents.amount})`.mapWith(Number),
        })
        .from(xpEvents)
        .where(and(eq(xpEvents.userId, userId), gte(xpEvents.createdAt, from), sql`${xpEvents.amount} > 0`))
        .groupBy(xpEvents.eventType),
      this.db
        .select({
          day: sql<string>`((${xpEvents.createdAt} at time zone 'utc')::date)::text`,
          xp: sql<number>`sum(${xpEvents.amount})`.mapWith(Number),
        })
        .from(xpEvents)
        .where(and(eq(xpEvents.userId, userId), gte(xpEvents.createdAt, from)))
        .groupBy(sql`1`),
    ]);

    const perDay = new Map(byDay.map((d) => [d.day, d.xp]));
    const daily: Array<{ date: string; xp: number }> = [];
    for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) {
      const date = utcDay(new Date(t));
      daily.push({ date, xp: perDay.get(date) ?? 0 });
    }
    const fixed = (type: string) => {
      const rule = (XP_RULES as Record<string, XpRule>)[type];
      return rule && rule.xp > 0 ? rule.xp : null;
    };
    return {
      period,
      from: utcDay(from),
      to: utcDay(new Date(to.getTime() - DAY_MS)),
      total,
      previousTotal,
      growthPercent: previousTotal > 0 ? Math.round(((total - previousTotal) / previousTotal) * 100) : null,
      breakdown: byType
        .map((r) => ({ type: r.type, label: labelOf(r.type), count: r.count, xpPerUnit: fixed(r.type), xp: r.xp }))
        .sort((a, b) => b.xp - a.xp),
      daily,
    };
  }

  async history(userId: string, rawCursor: string | undefined, limit: number) {
    let after;
    if (rawCursor) {
      const c = decodeCursor<{ t: string; id: string }>(rawCursor);
      if (typeof c.t !== 'string' || typeof c.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(c.id)) {
        throw new AppError('VALIDATION_FAILED', 'Invalid cursor', { fields: { cursor: 'Invalid cursor' } });
      }
      after = sql`(${xpEvents.createdAt}, ${xpEvents.id}) < (${c.t}::timestamptz, ${c.id}::uuid)`;
    }
    const mine = and(eq(xpEvents.userId, userId), sql`${xpEvents.amount} > 0`);
    const [rows, [count]] = await Promise.all([
      this.db
        .select({
          id: xpEvents.id,
          type: xpEvents.eventType,
          xp: xpEvents.amount,
          refType: xpEvents.refType,
          refId: xpEvents.refId,
          metadata: xpEvents.metadata,
          createdAt: xpEvents.createdAt,
          t: sql<string>`${xpEvents.createdAt}::text`,
        })
        .from(xpEvents)
        .where(and(mine, after))
        .orderBy(desc(xpEvents.createdAt), desc(xpEvents.id))
        .limit(limit + 1),
      this.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(xpEvents).where(mine),
    ]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return listEnvelope(
      page.map((r) => {
        // Bonus rows carry their own label (e.g. "7-day streak", "Read one article").
        const m = (r.metadata ?? {}) as { days?: number; taskId?: string };
        const label =
          r.type === 'streak_bonus' && m.days
            ? `${m.days}-day streak`
            : r.type === 'task_bonus' && m.taskId
              ? `Daily task: ${DAILY_TASKS.find((t) => t.id === m.taskId)?.label ?? m.taskId}`
              : labelOf(r.type);
        return { id: r.id, type: r.type, label, xp: r.xp, refType: r.refType, refId: r.refId, createdAt: r.createdAt.toISOString() };
      }),
      rows.length > limit && last ? encodeCursor({ t: last.t, id: last.id }) : null,
      count?.n ?? 0,
    );
  }

  async streak(userId: string, year?: number, month?: number) {
    const now = this.now();
    const y = year ?? now.getUTCFullYear();
    const m = month ?? now.getUTCMonth() + 1;
    const days = await learningDays(this.db, userId);
    const s = streakFrom(days, utcDay(now));
    const prefix = `${y}-${String(m).padStart(2, '0')}-`;
    return { current: s.current, longest: s.longest, year: y, month: m, activeDates: days.filter((d) => d.startsWith(prefix)).sort() };
  }

  async leaderboard(userId: string, period: 'weekly' | 'monthly' | 'all_time', limit: number) {
    const now = this.now();
    const from = period === 'weekly' ? startOfUtcWeek(now) : period === 'monthly' ? startOfUtcMonth(now) : null;
    const totals = this.db
      .select({
        userId: xpEvents.userId,
        xp: sql<number>`sum(${xpEvents.amount})::int`.as('xp'),
        // Ties go to whoever reached the score first.
        reachedAt: sql`max(${xpEvents.createdAt})`.as('reached_at'),
      })
      .from(xpEvents)
      .where(from ? gte(xpEvents.createdAt, from) : undefined)
      .groupBy(xpEvents.userId)
      .having(sql`sum(${xpEvents.amount}) > 0`)
      .as('totals');
    const ranked = this.db
      .select({
        userId: totals.userId,
        xp: totals.xp,
        rank: sql<number>`(row_number() over (order by ${totals.xp} desc, ${totals.reachedAt} asc))::int`.as('rank'),
      })
      .from(totals)
      .as('ranked');
    const pick = {
      rank: sql<number>`${ranked.rank}`.mapWith(Number),
      userId: ranked.userId,
      xp: sql<number>`${ranked.xp}`.mapWith(Number),
      fullName: profiles.fullName,
      avatarUrl: profiles.avatarUrl,
    };
    const [top, [me], xpThisWeek] = await Promise.all([
      this.db.select(pick).from(ranked).leftJoin(profiles, eq(profiles.id, ranked.userId)).orderBy(ranked.rank).limit(limit),
      this.db.select(pick).from(ranked).leftJoin(profiles, eq(profiles.id, ranked.userId)).where(eq(ranked.userId, userId)),
      this.sumSince(userId, startOfUtcWeek(now)),
    ]);
    const crowns = ['gold', 'silver', 'bronze'] as const;
    return {
      period,
      items: top.map((r) => {
        const name = r.fullName ?? 'Pipeline member';
        return {
          rank: r.rank,
          userId: r.userId,
          name,
          initials: initials(name),
          avatarUrl: r.avatarUrl ?? null,
          xp: r.xp,
          crown: r.rank <= 3 ? crowns.at(r.rank - 1)! : null,
          isMe: r.userId === userId,
        };
      }),
      me: { rank: me?.rank ?? null, xp: me?.xp ?? 0, xpThisWeek },
    };
  }

  rules() {
    return {
      rules: (Object.entries(XP_RULES) as Array<[XpEventType, XpRule]>)
        .filter(([type]) => type !== 'streak_bonus' && type !== 'task_bonus')
        .map(([type, r]) => ({ type, label: r.label, xp: r.xp, dailyCap: r.dailyCap ?? null })),
      levels: LEVELS.map((l) => ({ number: l.number, name: l.name, minXp: l.minXp })),
      streakBonuses: STREAK_BONUSES.map((b) => ({ days: b.days, xp: b.xp })),
      dailyTasks: DAILY_TASKS.map((t) => ({ id: t.id, label: t.label, xp: t.xp })),
    };
  }
}
