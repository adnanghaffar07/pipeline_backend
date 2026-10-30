import { and, asc, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../../db/client.js';
import { blocks, connections, interestTopics, memberReports, profiles, userInterests, type ReportReason } from '../../db/schema.js';
import type { AttemptLimiter } from '../../lib/attempt-limiter.js';
import { AppError } from '../../lib/errors.js';
import { decodeCursor, encodeCursor } from '../../lib/pagination.js';
import type { memberProfile, personCard } from './schemas.js';
import type { NotificationsService } from '../notifications/service.js';

type PersonCard = z.infer<typeof personCard>;
type Status = 'connected' | 'received' | 'sent';

const LIMITS = {
  requestsPerDay: { max: 30, windowSec: 24 * 60 * 60 },
  // The same person can't be asked again and again after declining.
  requestsPerPair: { max: 3, windowSec: 30 * 24 * 60 * 60 },
  reportsPerDay: { max: 10, windowSec: 24 * 60 * 60 },
};

/** Outer profile id, table-qualified so it can't bind to a subquery's own `id`. */
const pid = sql.raw('"profiles"."id"');

const notFound = () => new AppError('PERSON_NOT_FOUND', 'This member could not be found');
const connNotFound = () => new AppError('CONNECTION_NOT_FOUND', 'This request no longer exists');

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '')).toUpperCase() || '?';
}

function readOffset(cursor: string | undefined): number {
  if (!cursor) return 0;
  const c = decodeCursor<{ o?: unknown }>(cursor);
  if (typeof c.o !== 'number' || !Number.isInteger(c.o) || c.o < 0) {
    throw new AppError('VALIDATION_FAILED', 'Invalid cursor', { fields: { cursor: 'Invalid cursor' } });
  }
  return c.o;
}

/** Every word must match the start of a word in the name, job title or company. */
function searchFilter(q: string | undefined): SQL | undefined {
  const words = (q ?? '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
  if (words.length === 0) return undefined;
  const haystack = sql`(' ' || lower(coalesce(${profiles.fullName}, '') || ' ' || coalesce(${profiles.jobTitle}, '') || ' ' || coalesce(${profiles.company}, '')))`;
  return and(...words.map((w) => sql`${haystack} like ${`% ${w.replace(/[\\%_]/g, (m) => `\\${m}`)}%`} escape '\\'`));
}

const blockedBetween = (me: string, other: SQL | string) =>
  sql`exists (select 1 from ${blocks} b where (b.blocker_id = ${me} and b.blocked_id = ${other}) or (b.blocker_id = ${other} and b.blocked_id = ${me}))`;

export class NetworkingService {
  constructor(
    private readonly db: Db,
    private readonly limiter: AttemptLimiter,
    private readonly notifications: NotificationsService,
  ) {}

  /** "Ayesha Munir wants to connect" / "... accepted your connection request", sent to `to` about `about`. */
  private async alert(to: string, about: string, type: 'connection_request' | 'connection_accepted') {
    const [p] = await this.db
      .select({ fullName: profiles.fullName, jobTitle: profiles.jobTitle, company: profiles.company })
      .from(profiles)
      .where(eq(profiles.id, about));
    if (!p) return;
    const role = [p.jobTitle, p.company].filter(Boolean).join(' at ') || null;
    await this.notifications.notifyUser(to, {
      type,
      title: type === 'connection_request' ? `${p.fullName} wants to connect` : `${p.fullName} accepted your connection request`,
      description: role,
      target: { type: 'person', id: about },
      actorId: about,
    });
  }

  private cardFields(me: string) {
    return {
      id: profiles.id,
      fullName: profiles.fullName,
      avatarUrl: profiles.avatarUrl,
      jobTitle: profiles.jobTitle,
      company: profiles.company,
      location: profiles.location,
      sharedInterests: sql<number>`(select count(*) from ${userInterests} a join ${userInterests} b on a.topic_id = b.topic_id where a.user_id = ${pid} and b.user_id = ${me})`.mapWith(Number),
    };
  }

  /** Adds connection state and mutual-connection counts to profile rows, keeping their order. */
  private async toCards(
    me: string,
    rows: Array<{ id: string; fullName: string; avatarUrl: string | null; jobTitle: string | null; company: string | null; location: string | null; sharedInterests: number }>,
  ): Promise<PersonCard[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [mine, myConnected] = await Promise.all([
      this.db
        .select()
        .from(connections)
        .where(
          or(
            and(eq(connections.requesterId, me), inArray(connections.addresseeId, ids)),
            and(eq(connections.addresseeId, me), inArray(connections.requesterId, ids)),
          ),
        ),
      this.connectedIds(me),
    ]);
    const mutual = new Map<string, number>();
    if (myConnected.length > 0) {
      const theirs = await this.db
        .select({ a: connections.requesterId, b: connections.addresseeId })
        .from(connections)
        .where(
          and(
            eq(connections.status, 'accepted'),
            or(
              and(inArray(connections.requesterId, ids), inArray(connections.addresseeId, myConnected)),
              and(inArray(connections.addresseeId, ids), inArray(connections.requesterId, myConnected)),
            ),
          ),
        );
      for (const t of theirs) {
        const person = ids.includes(t.a) && myConnected.includes(t.b) ? t.a : t.b;
        mutual.set(person, (mutual.get(person) ?? 0) + 1);
      }
    }
    return rows.map((r) => {
      const c = mine.find((x) => x.requesterId === r.id || x.addresseeId === r.id);
      const state: PersonCard['connectionState'] =
        r.id === me ? 'self' : !c ? 'none' : c.status === 'accepted' ? 'connected' : c.requesterId === me ? 'sent' : 'received';
      return {
        id: r.id,
        fullName: r.fullName,
        initials: initials(r.fullName),
        avatarUrl: r.avatarUrl,
        jobTitle: r.jobTitle,
        company: r.company,
        location: r.location,
        connectionState: state,
        connectionId: c && r.id !== me ? c.id : null,
        mutualConnections: mutual.get(r.id) ?? 0,
        sharedInterests: r.sharedInterests,
      };
    });
  }

  private async connectedIds(me: string): Promise<string[]> {
    const rows = await this.db
      .select({ a: connections.requesterId, b: connections.addresseeId })
      .from(connections)
      .where(and(eq(connections.status, 'accepted'), or(eq(connections.requesterId, me), eq(connections.addresseeId, me))));
    return rows.map((r) => (r.a === me ? r.b : r.a));
  }

  private async card(me: string, personId: string): Promise<PersonCard> {
    const [row] = await this.db.select(this.cardFields(me)).from(profiles).where(eq(profiles.id, personId));
    if (!row) throw notFound();
    return (await this.toCards(me, [row]))[0]!;
  }

  /** Active member, not blocked in either direction. */
  private async findVisible(me: string, personId: string) {
    const [p] = await this.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.id, personId), eq(profiles.status, 'active'), sql`not ${blockedBetween(me, pid)}`));
    if (!p) throw notFound();
    return p;
  }

  // ---- Discover and member profile ----------------------------------------------------------------------------

  /** Discover: everyone not yet connected (pending requests included), people with shared interests first. */
  async discover(me: string, q: string | undefined, cursor: string | undefined, limit: number) {
    const offset = readOffset(cursor);
    const where = and(
      eq(profiles.status, 'active'),
      ne(profiles.id, me),
      sql`not ${blockedBetween(me, pid)}`,
      sql`not exists (select 1 from ${connections} c where c.status = 'accepted' and ((c.requester_id = ${me} and c.addressee_id = ${pid}) or (c.addressee_id = ${me} and c.requester_id = ${pid})))`,
      searchFilter(q),
    );
    const fields = this.cardFields(me);
    const [rows, [count]] = await Promise.all([
      this.db
        .select(fields)
        .from(profiles)
        .where(where)
        .orderBy(desc(fields.sharedInterests), asc(profiles.fullName), asc(profiles.id))
        .limit(limit + 1)
        .offset(offset),
      this.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(profiles).where(where),
    ]);
    const items = await this.toCards(me, rows.slice(0, limit));
    return { items, nextCursor: rows.length > limit ? encodeCursor({ o: offset + limit }) : null, total: count?.n ?? 0 };
  }

  async profile(me: string, personId: string): Promise<z.infer<typeof memberProfile>> {
    const p = personId === me ? (await this.db.select().from(profiles).where(eq(profiles.id, me)))[0] : await this.findVisible(me, personId);
    if (!p) throw notFound();
    const [card, interests] = await Promise.all([
      this.card(me, p.id),
      this.db
        .select({ id: interestTopics.id, name: interestTopics.name })
        .from(userInterests)
        .innerJoin(interestTopics, eq(interestTopics.id, userInterests.topicId))
        .where(eq(userInterests.userId, p.id))
        .orderBy(asc(interestTopics.sortOrder)),
    ]);
    // Contact rule (requirements 9.2): connected AND the owner shares contact details AND that field is switched on.
    const self = p.id === me;
    const connected = card.connectionState === 'connected';
    const email = self || (connected && p.shareContactEnabled && p.shareEmail) ? p.email : null;
    const phone = self || (connected && p.shareContactEnabled && p.sharePhone) ? (p.phoneE164 ?? null) : null;
    return {
      ...card,
      bio: p.bio,
      expertiseAreas: p.expertiseAreas,
      interests,
      contact: { email, phone, locked: !email && !phone },
    };
  }

  // ---- Connections ----------------------------------------------------------------------------------------------

  async list(me: string, status: Status, q: string | undefined, cursor: string | undefined, limit: number) {
    const offset = readOffset(cursor);
    const other = sql`case when ${connections.requesterId} = ${me} then ${connections.addresseeId} else ${connections.requesterId} end`;
    const scope = (s: Status) =>
      s === 'connected'
        ? and(eq(connections.status, 'accepted'), or(eq(connections.requesterId, me), eq(connections.addresseeId, me)))
        : s === 'received'
          ? and(eq(connections.status, 'pending'), eq(connections.addresseeId, me))
          : and(eq(connections.status, 'pending'), eq(connections.requesterId, me));
    const where = and(scope(status), searchFilter(q), eq(profiles.status, 'active'));
    const fields = this.cardFields(me);
    const countOf = async (s: Status) =>
      (
        await this.db
          .select({ n: sql<number>`count(*)`.mapWith(Number) })
          .from(connections)
          .innerJoin(profiles, eq(profiles.id, other))
          .where(and(scope(s), eq(profiles.status, 'active')))
      )[0]?.n ?? 0;

    const [rows, [filtered], connected, received, sent] = await Promise.all([
      this.db
        .select(fields)
        .from(connections)
        .innerJoin(profiles, eq(profiles.id, other))
        .where(where)
        .orderBy(desc(sql`coalesce(${connections.respondedAt}, ${connections.createdAt})`), asc(profiles.id))
        .limit(limit + 1)
        .offset(offset),
      this.db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(connections)
        .innerJoin(profiles, eq(profiles.id, other))
        .where(where),
      countOf('connected'),
      countOf('received'),
      countOf('sent'),
    ]);
    const items = await this.toCards(me, rows.slice(0, limit));
    return {
      items,
      nextCursor: rows.length > limit ? encodeCursor({ o: offset + limit }) : null,
      total: filtered?.n ?? 0,
      counts: { connected, received, sent },
    };
  }

  private async between(me: string, other: string) {
    const [c] = await this.db
      .select()
      .from(connections)
      .where(
        or(
          and(eq(connections.requesterId, me), eq(connections.addresseeId, other)),
          and(eq(connections.requesterId, other), eq(connections.addresseeId, me)),
        ),
      );
    return c;
  }

  async send(me: string, toUserId: string): Promise<{ created: boolean; person: PersonCard }> {
    if (toUserId === me) {
      throw new AppError('VALIDATION_FAILED', 'Request validation failed', { fields: { toUserId: 'You cannot connect with yourself' } });
    }
    await this.findVisible(me, toUserId);
    const existing = await this.between(me, toUserId);
    if (existing?.status === 'accepted') throw new AppError('ALREADY_CONNECTED', 'You are already connected');
    if (existing && existing.requesterId === me) return { created: false, person: await this.card(me, toUserId) };
    if (existing) {
      // They already asked me: sending back counts as accepting.
      await this.db.update(connections).set({ status: 'accepted', respondedAt: new Date() }).where(eq(connections.id, existing.id));
      await this.notifications.retract(me, 'connection_request', toUserId);
      await this.alert(toUserId, me, 'connection_accepted');
      return { created: false, person: await this.card(me, toUserId) };
    }
    for (const [name, limit] of Object.entries(LIMITS).filter(([n]) => n.startsWith('requests'))) {
      const key = name === 'requestsPerPair' ? `conn:${name}:${me}:${toUserId}` : `conn:${name}:${me}`;
      const r = await this.limiter.hit(key, limit);
      if (!r.allowed) {
        throw new AppError('RATE_LIMITED', 'Too many connection requests. Please try again later.', { retryAfterSec: r.retryAfterSec });
      }
    }
    // The pair index makes a simultaneous request from the other side fail here instead of creating a second row.
    const inserted = await this.db
      .insert(connections)
      .values({ requesterId: me, addresseeId: toUserId })
      .onConflictDoNothing()
      .returning({ id: connections.id });
    if (inserted.length > 0) await this.alert(toUserId, me, 'connection_request');
    return { created: true, person: await this.card(me, toUserId) };
  }

  private async pendingFor(me: string, connectionId: string) {
    const [c] = await this.db.select().from(connections).where(eq(connections.id, connectionId));
    if (!c || c.status !== 'pending' || c.addresseeId !== me) throw connNotFound();
    return c;
  }

  async accept(me: string, connectionId: string) {
    const c = await this.pendingFor(me, connectionId);
    await this.db.update(connections).set({ status: 'accepted', respondedAt: new Date() }).where(eq(connections.id, c.id));
    // The request alert has done its job; the requester hears it was accepted.
    await this.notifications.retract(me, 'connection_request', c.requesterId);
    await this.alert(c.requesterId, me, 'connection_accepted');
    return this.card(me, c.requesterId);
  }

  async decline(me: string, connectionId: string) {
    const c = await this.pendingFor(me, connectionId);
    await this.db.delete(connections).where(eq(connections.id, c.id));
    await this.notifications.retract(me, 'connection_request', c.requesterId);
  }

  /** Cancel a request I sent, decline one I received, or remove a connection. */
  async remove(me: string, connectionId: string) {
    const [c] = await this.db.select().from(connections).where(eq(connections.id, connectionId));
    if (!c || (c.requesterId !== me && c.addresseeId !== me)) throw connNotFound();
    await this.db.delete(connections).where(eq(connections.id, c.id));
    // A cancelled request shouldn't linger in the other person's feed.
    if (c.status === 'pending') await this.notifications.retract(c.addresseeId, 'connection_request', c.requesterId);
  }

  // ---- Block and report -----------------------------------------------------------------------------------------

  async block(me: string, personId: string) {
    if (personId === me) {
      throw new AppError('VALIDATION_FAILED', 'Request validation failed', { fields: { personId: 'You cannot block yourself' } });
    }
    const [exists] = await this.db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, personId));
    if (!exists) throw notFound();
    await this.db.transaction(async (tx) => {
      await tx.insert(blocks).values({ blockerId: me, blockedId: personId }).onConflictDoNothing();
      await tx
        .delete(connections)
        .where(
          or(
            and(eq(connections.requesterId, me), eq(connections.addresseeId, personId)),
            and(eq(connections.requesterId, personId), eq(connections.addresseeId, me)),
          ),
        );
    });
    await this.notifications.retract(personId, 'connection_request', me);
    await this.notifications.retract(me, 'connection_request', personId);
  }

  async unblock(me: string, personId: string) {
    await this.db.delete(blocks).where(and(eq(blocks.blockerId, me), eq(blocks.blockedId, personId)));
  }

  async blocked(me: string) {
    const rows = await this.db
      .select({ id: profiles.id, fullName: profiles.fullName, avatarUrl: profiles.avatarUrl, blockedAt: blocks.createdAt })
      .from(blocks)
      .innerJoin(profiles, eq(profiles.id, blocks.blockedId))
      .where(eq(blocks.blockerId, me))
      .orderBy(desc(blocks.createdAt));
    return {
      items: rows.map((r) => ({ id: r.id, fullName: r.fullName, initials: initials(r.fullName), avatarUrl: r.avatarUrl, blockedAt: r.blockedAt.toISOString() })),
    };
  }

  async report(me: string, personId: string, reason: ReportReason, details: string | undefined, alsoBlock: boolean) {
    if (personId === me) {
      throw new AppError('VALIDATION_FAILED', 'Request validation failed', { fields: { personId: 'You cannot report yourself' } });
    }
    const [exists] = await this.db.select({ id: profiles.id }).from(profiles).where(eq(profiles.id, personId));
    if (!exists) throw notFound();
    const r = await this.limiter.hit(`report:${me}`, LIMITS.reportsPerDay);
    if (!r.allowed) throw new AppError('RATE_LIMITED', 'Too many reports today. Please try again later.', { retryAfterSec: r.retryAfterSec });
    const [row] = await this.db
      .insert(memberReports)
      .values({ reporterId: me, reportedId: personId, reason, details: details || null })
      .returning({ id: memberReports.id });
    if (alsoBlock) await this.block(me, personId);
    return { reportId: row!.id, blocked: alsoBlock };
  }

  // ---- Admin ----------------------------------------------------------------------------------------------------

  async adminReports(status: 'open' | 'reviewed' | 'dismissed', cursor: string | undefined, limit: number) {
    const offset = readOffset(cursor);
    const reporter = sql`(select json_build_object('id', p.id, 'fullName', p.full_name, 'email', p.email) from ${profiles} p where p.id = ${memberReports.reporterId})`;
    const rows = await this.db
      .select({
        id: memberReports.id,
        reason: memberReports.reason,
        details: memberReports.details,
        status: memberReports.status,
        createdAt: memberReports.createdAt,
        reviewedAt: memberReports.reviewedAt,
        reporter: sql<{ id: string; fullName: string; email: string } | null>`${reporter}`,
        reportedId: profiles.id,
        reportedName: profiles.fullName,
        reportedEmail: profiles.email,
        against: sql<number>`(select count(*) from ${memberReports} r2 where r2.reported_id = ${memberReports.reportedId})`.mapWith(Number),
      })
      .from(memberReports)
      .innerJoin(profiles, eq(profiles.id, memberReports.reportedId))
      .where(eq(memberReports.status, status))
      .orderBy(desc(memberReports.createdAt), desc(memberReports.id))
      .limit(limit + 1)
      .offset(offset);
    const [count] = await this.db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(memberReports)
      .where(eq(memberReports.status, status));
    return {
      items: rows.slice(0, limit).map((r) => ({
        id: r.id,
        reason: r.reason,
        details: r.details,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        reviewedAt: r.reviewedAt ? r.reviewedAt.toISOString() : null,
        reporter: r.reporter,
        reported: { id: r.reportedId, fullName: r.reportedName, email: r.reportedEmail },
        reportsAgainstMember: r.against,
      })),
      nextCursor: rows.length > limit ? encodeCursor({ o: offset + limit }) : null,
      total: count?.n ?? 0,
    };
  }

  async reviewReport(reportId: string, status: 'reviewed' | 'dismissed') {
    const [row] = await this.db
      .update(memberReports)
      .set({ status, reviewedAt: new Date() })
      .where(eq(memberReports.id, reportId))
      .returning({ id: memberReports.id });
    if (!row) throw new AppError('REPORT_NOT_FOUND', 'Report not found');
  }
}
