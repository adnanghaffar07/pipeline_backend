import { and, desc, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { devices, notificationReads, notifications, profiles, userInterests, type DevicePlatform, type NotificationType } from '../../db/schema.js';
import type { PushSender } from '../../integrations/push.js';
import { AppError } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';

export const DEFAULT_LABELS: Record<NotificationType, string> = {
  latest_issue: 'Latest issue',
  breaking_news: 'Breaking news',
  news: 'News',
  research: 'Research Center',
  video: 'Video',
  webinar: 'Webinar',
  podcast: 'Podcast',
  connection_request: 'Networking',
  connection_accepted: 'Networking',
  system: 'Pipeline',
};

/** Feed filter chips → notification types. */
const FILTERS: Record<'latest_issue' | 'news' | 'research', NotificationType[]> = {
  latest_issue: ['latest_issue'],
  news: ['breaking_news', 'news'],
  research: ['research'],
};

/** Broadcasts older than this drop out of the feed, so a new member doesn't start with a wall of old alerts. */
const BROADCAST_DAYS = 90;
/** Upper bound on devices pushed per broadcast request (one FCM call each). */
const BROADCAST_PUSH_CAP = 2000;

export interface NotifyInput {
  type: NotificationType;
  title: string;
  description?: string | null;
  label?: string;
  coverUrl?: string | null;
  xpValue?: number | null;
  isPremium?: boolean;
  target?: { type: string; id: string } | null;
  actorId?: string | null;
}

/** Outer notification row, table-qualified for use inside subqueries. */
const nid = sql.raw('"notifications"."id"');
const nAudience = sql.raw('"notifications"."audience_topic_ids"');

export class NotificationsService {
  constructor(
    private readonly db: Db,
    private readonly push: PushSender,
    private readonly log: { warn: (o: object, m: string) => void } = { warn: () => undefined },
  ) {}

  /** Personal notifications plus the broadcasts this member is in the audience for. */
  private visibleTo(me: string): SQL {
    return or(
      eq(notifications.userId, me),
      and(
        isNull(notifications.userId),
        sql`${notifications.createdAt} > now() - make_interval(days => ${BROADCAST_DAYS})`,
        sql`(${nAudience} is null or exists (select 1 from ${userInterests} ui where ui.user_id = ${me} and ui.topic_id = any(${nAudience})))`,
      ),
    )!;
  }

  private isRead(me: string): SQL {
    return sql`(exists (select 1 from ${notificationReads} r where r.user_id = ${me} and r.notification_id = ${nid})
      or ${notifications.createdAt} <= coalesce((select p.notifications_read_at from ${profiles} p where p.id = ${me}), '-infinity'::timestamptz))`;
  }

  async unreadCount(me: string): Promise<number> {
    const [r] = await this.db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(notifications)
      .where(and(this.visibleTo(me), sql`not ${this.isRead(me)}`));
    return r?.n ?? 0;
  }

  async feed(me: string, filter: 'all' | 'latest_issue' | 'news' | 'research', rawCursor: string | undefined, limit: number) {
    let after: SQL | undefined;
    if (rawCursor) {
      const c = decodeCursor<{ t: string; id: string }>(rawCursor);
      if (typeof c.t !== 'string' || typeof c.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(c.id)) {
        throw new AppError('VALIDATION_FAILED', 'Invalid cursor', { fields: { cursor: 'Invalid cursor' } });
      }
      after = sql`(${notifications.createdAt}, ${notifications.id}) < (${c.t}::timestamptz, ${c.id}::uuid)`;
    }
    const where = and(this.visibleTo(me), filter === 'all' ? undefined : inArray(notifications.type, FILTERS[filter]));
    const [rows, [count], unread] = await Promise.all([
      this.db
        .select({
          n: notifications,
          read: sql<boolean>`${this.isRead(me)}`,
          t: sql<string>`${notifications.createdAt}::text`,
          actorName: profiles.fullName,
          actorAvatar: profiles.avatarUrl,
        })
        .from(notifications)
        .leftJoin(profiles, eq(profiles.id, notifications.actorId))
        .where(and(where, after))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(limit + 1),
      this.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(notifications).where(where),
      this.unreadCount(me),
    ]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return {
      items: page.map(({ n, read, actorName, actorAvatar }) => ({
        id: n.id,
        type: n.type,
        label: n.label,
        title: n.title,
        description: n.description,
        coverUrl: n.coverUrl,
        xpValue: n.xpValue,
        isPremium: n.isPremium,
        target: n.targetType && n.targetId ? { type: n.targetType, id: n.targetId } : null,
        actor: n.actorId && actorName ? { id: n.actorId, fullName: actorName, avatarUrl: actorAvatar ?? null } : null,
        read: Boolean(read),
        createdAt: n.createdAt.toISOString(),
      })),
      nextCursor: rows.length > limit && last ? encodeCursor({ t: last.t, id: last.n.id }) : null,
      total: count?.n ?? 0,
      unreadCount: unread,
    };
  }

  async markRead(me: string, id: string) {
    const [n] = await this.db.select({ id: notifications.id }).from(notifications).where(and(eq(notifications.id, id), this.visibleTo(me)));
    if (!n) throw new AppError('NOTIFICATION_NOT_FOUND', 'Notification not found');
    await this.db.insert(notificationReads).values({ userId: me, notificationId: id }).onConflictDoNothing();
    return { unreadCount: await this.unreadCount(me) };
  }

  async markAllRead(me: string) {
    await this.db.update(profiles).set({ notificationsReadAt: new Date() }).where(eq(profiles.id, me));
    return { unreadCount: await this.unreadCount(me) };
  }

  // ---- Devices ----------------------------------------------------------------------------------------------------

  async registerDevice(me: string, token: string, platform: DevicePlatform, appVersion?: string) {
    const now = new Date();
    // A token moves to whoever signed in on that phone last.
    await this.db
      .insert(devices)
      .values({ token, userId: me, platform, appVersion: appVersion ?? null })
      .onConflictDoUpdate({ target: devices.token, set: { userId: me, platform, appVersion: appVersion ?? null, lastSeenAt: now } });
    return { registered: true, pushEnabled: this.push.enabled };
  }

  async removeDevice(me: string, token: string) {
    await this.db.delete(devices).where(and(eq(devices.token, token), eq(devices.userId, me)));
  }

  // ---- Sending ----------------------------------------------------------------------------------------------------

  private values(input: NotifyInput) {
    return {
      type: input.type,
      label: input.label ?? DEFAULT_LABELS[input.type],
      title: input.title,
      description: input.description ?? null,
      coverUrl: input.coverUrl ?? null,
      xpValue: input.xpValue ?? null,
      isPremium: input.isPremium ?? false,
      targetType: input.target?.type ?? null,
      targetId: input.target?.id ?? null,
      actorId: input.actorId ?? null,
    };
  }

  private async pushTo(tokens: string[], row: { id: string; type: string; title: string; description: string | null; coverUrl: string | null; targetType: string | null; targetId: string | null }) {
    if (!this.push.enabled || tokens.length === 0) return { sent: 0, failed: 0 };
    const r = await this.push.send(tokens, {
      title: row.title,
      body: row.description,
      imageUrl: row.coverUrl,
      data: { notificationId: row.id, type: row.type, targetType: row.targetType ?? '', targetId: row.targetId ?? '' },
    });
    if (r.invalidTokens.length > 0) await this.db.delete(devices).where(inArray(devices.token, r.invalidTokens));
    return { sent: r.sent, failed: r.failed };
  }

  /** In-app notification for one member, pushed to their devices when they have notifications switched on. */
  async notifyUser(userId: string, input: NotifyInput) {
    const [row] = await this.db.insert(notifications).values({ userId, ...this.values(input) }).returning();
    try {
      const tokens = await this.db
        .select({ token: devices.token })
        .from(devices)
        .innerJoin(profiles, eq(profiles.id, devices.userId))
        .where(and(eq(devices.userId, userId), eq(profiles.notificationsEnabled, true)));
      await this.pushTo(
        tokens.map((t) => t.token),
        row!,
      );
    } catch (err) {
      // The in-app notification is already saved; a push failure must not fail the user's action.
      this.log.warn({ err }, 'push failed');
    }
    return row!;
  }

  /** Withdraws personal notifications that no longer apply (e.g. a cancelled connection request). */
  async retract(userId: string, type: NotificationType, actorId: string) {
    await this.db
      .delete(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, type), eq(notifications.actorId, actorId)));
  }

  async broadcast(adminId: string, input: NotifyInput & { audienceTopicIds?: number[] | null; push: boolean }) {
    const topics = input.audienceTopicIds?.length ? input.audienceTopicIds : null;
    const [row] = await this.db
      .insert(notifications)
      .values({ userId: null, audienceTopicIds: topics, createdBy: adminId, ...this.values(input) })
      .returning();
    let pushed = { sent: 0, failed: 0, devices: 0 };
    if (input.push && this.push.enabled) {
      const tokens = await this.db
        .select({ token: devices.token })
        .from(devices)
        .innerJoin(profiles, eq(profiles.id, devices.userId))
        .where(
          and(
            eq(profiles.notificationsEnabled, true),
            eq(profiles.status, 'active'),
            topics
              ? sql`exists (select 1 from ${userInterests} ui where ui.user_id = ${devices.userId} and ui.topic_id = any(${sql.param(topics)}::smallint[]))`
              : undefined,
          ),
        )
        .limit(BROADCAST_PUSH_CAP);
      const r = await this.pushTo(
        tokens.map((t) => t.token),
        row!,
      );
      pushed = { ...r, devices: tokens.length };
    }
    return { id: row!.id, pushEnabled: this.push.enabled, push: pushed };
  }

  async listBroadcasts(limit: number) {
    const rows = await this.db
      .select({
        n: notifications,
        reads: sql<number>`(select count(*) from ${notificationReads} r where r.notification_id = ${nid})`.mapWith(Number),
      })
      .from(notifications)
      .where(isNull(notifications.userId))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);
    return {
      items: rows.map(({ n, reads }) => ({
        id: n.id,
        type: n.type,
        label: n.label,
        title: n.title,
        description: n.description,
        audienceTopicIds: n.audienceTopicIds,
        target: n.targetType && n.targetId ? { type: n.targetType, id: n.targetId } : null,
        reads,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  }

  async deleteBroadcast(id: string) {
    const [row] = await this.db
      .delete(notifications)
      .where(and(eq(notifications.id, id), isNull(notifications.userId)))
      .returning({ id: notifications.id });
    if (!row) throw new AppError('NOTIFICATION_NOT_FOUND', 'Notification not found');
  }
}
