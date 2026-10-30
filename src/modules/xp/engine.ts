import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { profiles, userBadges, xpEvents } from '../../db/schema.js';
import { LEARNING_TYPES, getXpConfig, levelFor, type BadgeMetric, type XpConfig, type XpEventType } from './config.js';

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Conn = Db | Tx;

export interface AwardInput {
  type: XpEventType;
  refType?: string | null;
  refId?: string | null;
  /** Once-ever key: the first row with XP for this key pays, later ones are logged with 0. */
  key?: string | null;
  metadata?: Record<string, unknown>;
  /** Profile-style awards: once the key has paid, later calls log nothing at all. */
  silentIfPaid?: boolean;
  /** Log the activity (it still counts for badges and tasks) but pay nothing, e.g. a too-short comment. */
  zeroXp?: boolean;
}

export interface AwardResult {
  awards: Array<{ type: XpEventType; label: string; xp: number }>;
  xpAwarded: number;
  xpTotal: number;
  level: ReturnType<typeof levelFor>;
  leveledUp: boolean;
  newBadges: Array<{ id: string; name: string }>;
  streak: { current: number; longest: number };
}

const DAY_MS = 864e5;
export const UTC = 'UTC';

/** Calendar day (YYYY-MM-DD) of `d` in an IANA time zone. */
export function localDay(d: Date, tz: string = UTC): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const utcDay = (d: Date) => d.toISOString().slice(0, 10);
export const startOfUtcDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (day: string, n: number) => utcDay(new Date(Date.parse(day) + n * DAY_MS));

/** The ledger row's own id, table-qualified (Drizzle drops the table name in single-table queries). */
const rowId = sql.raw('"xp_events"."id"');
/** Rows an admin reversed don't count towards badges. */
const notReversed = sql`not exists (select 1 from ${xpEvents} rv where rv.event_type = 'reversal' and rv.ref_id = ${rowId}::text)`;

export async function userTimeZone(db: Conn, userId: string): Promise<string> {
  const [p] = await db.select({ tz: profiles.timezone }).from(profiles).where(eq(profiles.id, userId));
  return p?.tz && isValidTimeZone(p.tz) ? p.tz : UTC;
}

export async function xpTotal(db: Conn, userId: string): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${xpEvents.amount}), 0)`.mapWith(Number) })
    .from(xpEvents)
    .where(eq(xpEvents.userId, userId));
  return row?.n ?? 0;
}

/** XP total and level for the user object in /me and the sign-in responses. */
export async function userXp(db: Db, userId: string) {
  const [total, config] = await Promise.all([xpTotal(db, userId), getXpConfig(db)]);
  const level = levelFor(total, config.levels);
  return { xpTotal: total, level: { number: level.number, name: level.name } };
}

/** Distinct days (in the user's time zone) with learning activity, newest first. */
export async function learningDays(db: Conn, userId: string, tz: string): Promise<string[]> {
  const day = sql<string>`((${xpEvents.createdAt} at time zone ${tz})::date)::text`;
  const rows = await db
    .selectDistinct({ d: day })
    .from(xpEvents)
    .where(and(eq(xpEvents.userId, userId), inArray(xpEvents.eventType, LEARNING_TYPES)))
    .orderBy(sql`1 desc`);
  return rows.map((r) => r.d);
}

/** Current streak counts back from today, or from yesterday when today has no activity yet. */
export function streakFrom(daysDesc: string[], today: string) {
  let current = 0;
  if (daysDesc[0] === today || daysDesc[0] === addDays(today, -1)) {
    current = 1;
    for (let i = 1; i < daysDesc.length && daysDesc[i] === addDays(daysDesc[i - 1]!, -1); i++) current++;
  }
  let longest = 0;
  let run = 0;
  for (let i = 0; i < daysDesc.length; i++) {
    run = i > 0 && daysDesc[i] === addDays(daysDesc[i - 1]!, -1) ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return { current, longest, runStart: current > 0 ? addDays(daysDesc[0]!, -(current - 1)) : null };
}

export async function badgeMetrics(db: Conn, userId: string, longestStreak: number): Promise<Record<BadgeMetric, number>> {
  const [m] = await db
    .select({
      articles: sql<number>`count(distinct ${xpEvents.refId}) filter (where ${xpEvents.eventType} in ('article_read', 'magazine_article_read', 'sponsored_article_read'))`.mapWith(Number),
      webinars: sql<number>`count(distinct ${xpEvents.refId}) filter (where ${xpEvents.eventType} = 'webinar_attend')`.mapWith(Number),
      podcasts: sql<number>`count(distinct ${xpEvents.refId}) filter (where ${xpEvents.eventType} = 'podcast_listen')`.mapWith(Number),
      comments: sql<number>`count(*) filter (where ${xpEvents.eventType} in ('comment', 'reply'))`.mapWith(Number),
    })
    .from(xpEvents)
    .where(and(eq(xpEvents.userId, userId), notReversed));
  return {
    articles_read: m?.articles ?? 0,
    webinars_attended: m?.webinars ?? 0,
    podcasts_listened: m?.podcasts ?? 0,
    comments_posted: m?.comments ?? 0,
    longest_streak: longestStreak,
  };
}

/** The single place XP is written. Everything runs in one transaction under a per-user lock. */
export class XpEngine {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async award(userId: string, inputs: AwardInput[]): Promise<AwardResult> {
    const config = await getXpConfig(this.db);
    return this.db.transaction(async (tx) => {
      // Serialises one user's awards, so daily caps and once-only keys can't be raced past with parallel requests.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
      const tz = await userTimeZone(tx, userId);
      const today = localDay(this.now(), tz);
      const before = await xpTotal(tx, userId);
      const awards: AwardResult['awards'] = [];
      const logged = new Set<XpEventType>();

      const alreadyPaid = async (key: string) =>
        (await tx.select({ id: xpEvents.id }).from(xpEvents).where(and(eq(xpEvents.userId, userId), eq(xpEvents.idempotencyKey, key))).limit(1))
          .length > 0;

      for (const input of inputs) {
        const rule = config.rules[input.type];
        let amount = input.zeroXp ? 0 : rule.xp;
        if (amount > 0 && input.key && (await alreadyPaid(input.key))) {
          if (input.silentIfPaid) continue;
          amount = 0;
        }
        if (amount > 0 && rule.dailyCap) {
          const [c] = await tx
            .select({ n: sql<number>`count(*)`.mapWith(Number) })
            .from(xpEvents)
            .where(
              and(
                eq(xpEvents.userId, userId),
                eq(xpEvents.eventType, input.type),
                sql`${xpEvents.amount} > 0`,
                sql`(${xpEvents.createdAt} at time zone ${tz})::date = ${today}::date`,
              ),
            );
          if ((c?.n ?? 0) >= rule.dailyCap) amount = 0;
        }
        await tx.insert(xpEvents).values({
          userId,
          eventType: input.type,
          amount,
          refType: input.refType ?? null,
          refId: input.refId ?? null,
          idempotencyKey: amount > 0 ? (input.key ?? null) : null,
          metadata: input.metadata ?? null,
        });
        logged.add(input.type);
        if (amount > 0) awards.push({ type: input.type, label: rule.label, xp: amount });
      }

      // Bonuses ride on the activity just logged; their keys make each one pay once.
      const bonus = async (type: 'streak_bonus' | 'task_bonus', xp: number, key: string, label: string, metadata: Record<string, unknown>) => {
        if (xp <= 0 || (await alreadyPaid(key))) return;
        await tx.insert(xpEvents).values({ userId, eventType: type, amount: xp, idempotencyKey: key, metadata });
        awards.push({ type, label, xp });
      };

      const streak = streakFrom(await learningDays(tx, userId, tz), today);
      if (LEARNING_TYPES.some((t) => logged.has(t)) && streak.runStart) {
        for (const b of config.streakBonuses) {
          if (streak.current >= b.days) {
            await bonus('streak_bonus', b.xp, `streak:${b.days}:${streak.runStart}`, `${b.days}-day streak`, { days: b.days });
          }
        }
      }
      for (const task of config.dailyTasks) {
        if (task.completedBy.some((t) => logged.has(t))) {
          await bonus('task_bonus', task.xp, `task:${task.id}:${today}`, task.label, { taskId: task.id });
        }
      }

      const after = await xpTotal(tx, userId);
      const newBadges = await this.evaluateBadges(tx, userId, streak.longest, config);
      const level = levelFor(after, config.levels);
      return {
        awards,
        xpAwarded: after - before,
        xpTotal: after,
        level,
        leveledUp: level.number > levelFor(before, config.levels).number,
        newBadges,
        streak: { current: streak.current, longest: streak.longest },
      };
    });
  }

  /** Admin correction: a negative row that cancels one award. Each award can be reversed once. */
  async reverse(eventId: string, reason: string, adminId: string) {
    return this.db.transaction(async (tx) => {
      const [ev] = await tx.select().from(xpEvents).where(eq(xpEvents.id, eventId));
      if (!ev || ev.eventType === 'reversal' || ev.amount <= 0) return { status: 'not_reversible' as const };
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ev.userId}))`);
      const [row] = await tx
        .insert(xpEvents)
        .values({
          userId: ev.userId,
          eventType: 'reversal',
          amount: -ev.amount,
          refType: 'xp_event',
          refId: ev.id,
          idempotencyKey: `reversal:${ev.id}`,
          metadata: { reason, adminId, reversedType: ev.eventType },
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return { status: 'already_reversed' as const };
      return { status: 'reversed' as const, reversal: row, userId: ev.userId, xpTotal: await xpTotal(tx, ev.userId) };
    });
  }

  private async evaluateBadges(tx: Tx, userId: string, longestStreak: number, config: XpConfig) {
    const metrics = await badgeMetrics(tx, userId, longestStreak);
    const have = new Set(
      (await tx.select({ id: userBadges.badgeId }).from(userBadges).where(eq(userBadges.userId, userId))).map((r) => r.id),
    );
    const earned = config.badges.filter((b) => !have.has(b.id) && b.requirements.every((r) => metrics[r.metric] >= r.target));
    if (earned.length > 0) {
      await tx
        .insert(userBadges)
        .values(earned.map((b) => ({ userId, badgeId: b.id })))
        .onConflictDoNothing();
    }
    return earned.map((b) => ({ id: b.id, name: b.name }));
  }
}
