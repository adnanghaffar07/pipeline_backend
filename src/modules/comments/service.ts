import { and, asc, desc, eq, gt, isNull, sql, type SQL } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../../db/client.js';
import { commentLikes, comments, profiles } from '../../db/schema.js';
import type { AttemptLimiter } from '../../lib/attempt-limiter.js';
import { AppError } from '../../lib/errors.js';
import { decodeCursor, encodeCursor, listEnvelope } from '../../lib/pagination.js';
import type { commentView } from './schemas.js';
import { XpEngine } from '../xp/engine.js';
import { getXpConfig } from '../xp/config.js';

type CommentView = z.infer<typeof commentView>;

const DUPLICATE_WINDOW_SEC = 5 * 60;
const LIMITS = {
  perMinute: { max: 10, windowSec: 60 },
  perDay: { max: 200, windowSec: 24 * 60 * 60 },
};

const notFound = () => new AppError('COMMENT_NOT_FOUND', 'This comment no longer exists');

/**
 * The outer row's id, always table-qualified: Drizzle drops the table name in single-table queries, and a bare
 * "id" inside these subqueries would bind to the subquery's own table.
 */
const outerId = sql.raw('"comments"."id"');

/** Replies that still show: not deleted, not hidden. */
const liveReplyCount = sql<number>`(select count(*) from ${comments} r where r.parent_id = ${outerId} and r.deleted_at is null and r.status = 'visible')`.mapWith(Number);
const likeCount = sql<number>`(select count(*) from ${commentLikes} l where l.comment_id = ${outerId})`.mapWith(Number);

/** Keyset cursor: Postgres keeps microseconds, so the timestamp travels as text, never through a JS Date. */
interface Cursor extends Record<string, unknown> {
  t: string;
  id: string;
}

function readCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  const c = decodeCursor<Cursor>(raw);
  if (typeof c.t !== 'string' || typeof c.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(c.id)) {
    throw new AppError('VALIDATION_FAILED', 'Invalid cursor', { fields: { cursor: 'Invalid cursor' } });
  }
  return c;
}

export class CommentsService {
  private readonly xp: XpEngine;

  constructor(
    private readonly db: Db,
    private readonly limiter: AttemptLimiter,
  ) {
    this.xp = new XpEngine(db);
  }

  private select(me: string) {
    return this.db
      .select({
        id: comments.id,
        targetId: comments.targetId,
        parentId: comments.parentId,
        userId: comments.userId,
        text: comments.text,
        deletedAt: comments.deletedAt,
        createdAt: comments.createdAt,
        cursorTs: sql<string>`${comments.createdAt}::text`,
        fullName: profiles.fullName,
        avatarUrl: profiles.avatarUrl,
        likeCount,
        likedByMe: sql<boolean>`exists(select 1 from ${commentLikes} l where l.comment_id = ${outerId} and l.user_id = ${me})`,
        replyCount: liveReplyCount,
      })
      .from(comments)
      .leftJoin(profiles, eq(profiles.id, comments.userId));
  }

  private toView(row: Awaited<ReturnType<CommentsService['select']>>[number], me: string): CommentView {
    const deleted = row.deletedAt !== null;
    return {
      id: row.id,
      articleId: row.targetId,
      parentId: row.parentId,
      text: deleted ? null : row.text,
      isDeleted: deleted,
      isMine: !deleted && row.userId === me,
      author: deleted ? null : { id: row.userId, fullName: row.fullName ?? 'Pipeline member', avatarUrl: row.avatarUrl ?? null },
      likeCount: row.likeCount,
      likedByMe: Boolean(row.likedByMe),
      replyCount: row.replyCount,
      createdAt: row.createdAt.toISOString(),
    };
  }

  private async page(me: string, where: SQL, newestFirst: boolean, cursor: Cursor | null, limit: number) {
    const after = cursor
      ? newestFirst
        ? sql`(${comments.createdAt}, ${comments.id}) < (${cursor.t}::timestamptz, ${cursor.id}::uuid)`
        : sql`(${comments.createdAt}, ${comments.id}) > (${cursor.t}::timestamptz, ${cursor.id}::uuid)`
      : undefined;
    const order = newestFirst ? [desc(comments.createdAt), desc(comments.id)] : [asc(comments.createdAt), asc(comments.id)];

    const [rows, [count]] = await Promise.all([
      this.select(me)
        .where(and(where, after))
        .orderBy(...order)
        .limit(limit + 1),
      this.db.select({ n: sql<number>`count(*)`.mapWith(Number) }).from(comments).where(where),
    ]);
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor = hasMore && last ? encodeCursor({ t: last.cursorTs, id: last.id }) : null;
    return listEnvelope(
      items.map((r) => this.toView(r, me)),
      nextCursor,
      count?.n ?? 0,
    );
  }

  /** Top-level comments, newest first. A deleted comment stays (as a placeholder) only while it has replies. */
  listForArticle(me: string, articleId: string, cursor: string | undefined, limit: number) {
    const where = and(
      eq(comments.targetType, 'article'),
      eq(comments.targetId, articleId),
      isNull(comments.parentId),
      eq(comments.status, 'visible'),
      sql`(${comments.deletedAt} is null or ${liveReplyCount} > 0)`,
    )!;
    return this.page(me, where, true, readCursor(cursor), limit);
  }

  /** Replies under one comment, oldest first (reads as a conversation). */
  async listReplies(me: string, commentId: string, cursor: string | undefined, limit: number) {
    const parent = await this.findLive(commentId, { allowDeletedWithReplies: true });
    const where = and(eq(comments.parentId, parent.id), eq(comments.status, 'visible'), isNull(comments.deletedAt))!;
    return this.page(me, where, false, readCursor(cursor), limit);
  }

  private async findLive(commentId: string, opts: { allowDeletedWithReplies?: boolean } = {}) {
    const [row] = await this.db
      .select({
        id: comments.id,
        parentId: comments.parentId,
        userId: comments.userId,
        targetType: comments.targetType,
        targetId: comments.targetId,
        status: comments.status,
        deletedAt: comments.deletedAt,
        replyCount: liveReplyCount,
      })
      .from(comments)
      .where(eq(comments.id, commentId));
    if (!row || row.status !== 'visible') throw notFound();
    if (row.deletedAt && !(opts.allowDeletedWithReplies && row.replyCount > 0)) throw notFound();
    return row;
  }

  private async view(me: string, id: string): Promise<CommentView> {
    const [row] = await this.select(me).where(eq(comments.id, id));
    if (!row) throw notFound();
    return this.toView(row, me);
  }

  private async checkPosting(me: string, text: string, scope: SQL) {
    for (const [name, limit] of Object.entries(LIMITS)) {
      const r = await this.limiter.hit(`comment:${name}:${me}`, limit);
      if (!r.allowed) {
        throw new AppError('RATE_LIMITED', 'You are commenting too fast. Please try again later.', {
          retryAfterSec: r.retryAfterSec,
        });
      }
    }
    const [dup] = await this.db
      .select({ id: comments.id })
      .from(comments)
      .where(
        and(
          scope,
          eq(comments.userId, me),
          eq(comments.text, text),
          isNull(comments.deletedAt),
          gt(comments.createdAt, sql`now() - make_interval(secs => ${DUPLICATE_WINDOW_SEC})`),
        ),
      )
      .limit(1);
    if (dup) throw new AppError('DUPLICATE_COMMENT', 'You already posted this comment');
  }

  async create(me: string, articleId: string, text: string) {
    const scope = and(eq(comments.targetType, 'article'), eq(comments.targetId, articleId), isNull(comments.parentId))!;
    await this.checkPosting(me, text, scope);
    const [row] = await this.db
      .insert(comments)
      .values({ targetType: 'article', targetId: articleId, userId: me, text })
      .returning({ id: comments.id });
    const { xpAwarded } = await this.xp.award(me, [
      { type: 'comment', refType: 'article', refId: articleId, key: `comment:${row!.id}`, zeroXp: await this.tooShortForXp(text) },
    ]);
    return { comment: await this.view(me, row!.id), xpAwarded };
  }

  async reply(me: string, commentId: string, text: string) {
    const target = await this.findLive(commentId);
    // One level deep: replying to a reply joins the same thread.
    const parentId = target.parentId ?? target.id;
    if (target.parentId) await this.findLive(parentId, { allowDeletedWithReplies: true });
    await this.checkPosting(me, text, eq(comments.parentId, parentId));
    const [row] = await this.db
      .insert(comments)
      .values({ targetType: target.targetType, targetId: target.targetId, parentId, userId: me, text })
      .returning({ id: comments.id });
    const { xpAwarded } = await this.xp.award(me, [
      { type: 'reply', refType: target.targetType, refId: target.targetId, key: `reply:${row!.id}`, zeroXp: await this.tooShortForXp(text) },
    ]);
    return { comment: await this.view(me, row!.id), xpAwarded };
  }

  /** Short comments still post, but earn no XP (requirements 8.7: minimum length). */
  private async tooShortForXp(text: string) {
    return text.length < (await getXpConfig(this.db)).community.minCommentLengthForXp;
  }

  /** One person liking many of the same author's comments within an hour pays the author nothing more. */
  private async isLikeBurst(liker: string, author: string) {
    const max = (await getXpConfig(this.db)).community.maxLikeXpPerLikerPerAuthorPerHour;
    const [r] = await this.db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(commentLikes)
      .innerJoin(comments, eq(comments.id, commentLikes.commentId))
      .where(and(eq(commentLikes.userId, liker), eq(comments.userId, author), sql`${commentLikes.createdAt} > now() - interval '1 hour'`));
    // The like just inserted is included in the count.
    return (r?.n ?? 0) > max;
  }

  async remove(me: string, commentId: string) {
    const row = await this.findLive(commentId);
    if (row.userId !== me) throw new AppError('FORBIDDEN', 'You can only delete your own comments');
    // Soft delete: replies under it keep their context, and the row disappears from lists once it has none.
    await this.db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, row.id));
  }

  private async likeState(me: string, commentId: string) {
    const [row] = await this.db
      .select({
        likeCount,
        likedByMe: sql<boolean>`exists(select 1 from ${commentLikes} l where l.comment_id = ${outerId} and l.user_id = ${me})`,
      })
      .from(comments)
      .where(eq(comments.id, commentId));
    return { likeCount: row?.likeCount ?? 0, likedByMe: Boolean(row?.likedByMe) };
  }

  async like(me: string, commentId: string) {
    const row = await this.findLive(commentId);
    const added = await this.db
      .insert(commentLikes)
      .values({ commentId: row.id, userId: me })
      .onConflictDoNothing()
      .returning({ userId: commentLikes.userId });
    // The author earns +1 per distinct liker (never for self-likes, capped daily); unlike + like again pays nothing more.
    if (added.length > 0 && row.userId !== me && !(await this.isLikeBurst(me, row.userId))) {
      await this.xp.award(row.userId, [
        { type: 'like_received', refType: 'comment', refId: row.id, key: `like:${row.id}:${me}`, silentIfPaid: true },
      ]);
    }
    return this.likeState(me, row.id);
  }

  async unlike(me: string, commentId: string) {
    const row = await this.findLive(commentId);
    await this.db.delete(commentLikes).where(and(eq(commentLikes.commentId, row.id), eq(commentLikes.userId, me)));
    return this.likeState(me, row.id);
  }
}
