import { z } from 'zod';

export const articleParams = z.object({
  // Ids come from the client's content API, so only the format is checked here.
  articleId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'Invalid article id'),
});

export const commentParams = z.object({ commentId: z.uuid({ message: 'Invalid comment id' }) });

export const listQuery = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

export const commentBody = z.object({
  text: z
    .string()
    .trim()
    .min(1, 'Write something first')
    .max(500, 'Comments can be at most 500 characters'),
});

export const commentView = z.object({
  id: z.string(),
  articleId: z.string(),
  parentId: z.string().nullable(),
  /** null when the author deleted it (kept only so its replies still make sense). */
  text: z.string().nullable(),
  isDeleted: z.boolean(),
  isMine: z.boolean(),
  author: z.object({ id: z.string(), fullName: z.string(), avatarUrl: z.string().nullable() }).nullable(),
  likeCount: z.number().int(),
  likedByMe: z.boolean(),
  replyCount: z.number().int(),
  createdAt: z.string(),
});

export const commentList = z.object({
  items: z.array(commentView),
  nextCursor: z.string().nullable(),
  total: z.number().int(),
});

export const createdComment = z.object({
  comment: commentView,
  /** XP earned by this post: +3 for a comment, +2 for a reply, 0 once today's cap (5 each) is reached. */
  xpAwarded: z.number().int(),
});

export const likeState = z.object({ likeCount: z.number().int(), likedByMe: z.boolean() });
