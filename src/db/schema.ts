import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  inet,
  integer,
  pgSchema,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Supabase-managed table; referenced for foreign keys only, never migrated by us. */
export const authUsers = pgSchema('auth').table('users', { id: uuid('id').primaryKey() });

export type ProfileStatus = 'pending' | 'active';
export type OtpPurpose = 'signup' | 'login' | 'password_reset';
export type OtpChannel = 'email' | 'sms';
export type ThemePreference = 'light' | 'dark' | 'system';

export const profiles = pgTable('profiles', {
  id: uuid('id')
    .primaryKey()
    .references(() => authUsers.id, { onDelete: 'cascade' }),
  email: text('email').notNull().unique(),
  fullName: text('full_name').notNull(),
  countryName: text('country_name'),
  dialCode: text('dial_code'),
  mobile: text('mobile'),
  phoneE164: text('phone_e164'),
  avatarUrl: text('avatar_url'),
  /** Storage object path of the current avatar, so it can be removed when replaced. */
  avatarPath: text('avatar_path'),
  location: text('location'),
  company: text('company'),
  jobTitle: text('job_title'),
  linkedinUrl: text('linkedin_url'),
  facebookUrl: text('facebook_url'),
  instagramUrl: text('instagram_url'),
  websiteUrl: text('website_url'),
  expertiseAreas: text('expertise_areas').array().notNull().default(sql`'{}'::text[]`),
  notificationsEnabled: boolean('notifications_enabled').notNull().default(true),
  themePreference: text('theme_preference').$type<ThemePreference>().notNull().default('system'),
  shareContactEnabled: boolean('share_contact_enabled').notNull().default(false),
  shareEmail: boolean('share_email').notNull().default(false),
  sharePhone: boolean('share_phone').notNull().default(false),
  status: text('status').$type<ProfileStatus>().notNull(),
  termsAcceptedAt: timestamptz('terms_accepted_at'),
  termsVersion: text('terms_version'),
  createdAt: timestamptz('created_at').notNull().defaultNow(),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const otpChallenges = pgTable(
  'otp_challenges',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id').references(() => authUsers.id, { onDelete: 'cascade' }),
    purpose: text('purpose').$type<OtpPurpose>().notNull(),
    channel: text('channel').$type<OtpChannel>().notNull(),
    destination: text('destination').notNull(),
    codeHash: text('code_hash').notNull(),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    resendCount: integer('resend_count').notNull().default(0),
    expiresAt: timestamptz('expires_at').notNull(),
    resendAvailableAt: timestamptz('resend_available_at').notNull(),
    consumedAt: timestamptz('consumed_at'),
    createdIp: inet('created_ip'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [index('otp_challenges_destination_created_idx').on(t.destination, t.createdAt)],
);

export const interestTopics = pgTable('interest_topics', {
  id: smallint('id').primaryKey().generatedByDefaultAsIdentity(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull(),
  isActive: boolean('is_active').notNull().default(true),
});

export const userInterests = pgTable(
  'user_interests',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    topicId: smallint('topic_id')
      .notNull()
      .references(() => interestTopics.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.topicId] })],
);

export type CommentTargetType = 'article';
export type CommentStatus = 'visible' | 'hidden';

/**
 * Comments on content that lives in the client's API, so the target is a (type, id) pair, not a foreign key.
 * One level of replies: a reply's parent is always a top-level comment.
 */
export const comments = pgTable(
  'comments',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    targetType: text('target_type').$type<CommentTargetType>().notNull(),
    targetId: text('target_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    parentId: uuid('parent_id').references((): AnyPgColumn => comments.id, { onDelete: 'cascade' }),
    text: text('text').notNull(),
    /** `hidden` = removed by a moderator. */
    status: text('status').$type<CommentStatus>().notNull().default('visible'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    /** Set when the author deletes it; kept while it still has replies so the thread stays readable. */
    deletedAt: timestamptz('deleted_at'),
  },
  (t) => [
    index('comments_target_created_idx').on(t.targetType, t.targetId, t.createdAt, t.id),
    index('comments_parent_created_idx').on(t.parentId, t.createdAt, t.id),
    index('comments_user_created_idx').on(t.userId, t.createdAt),
  ],
);

export const commentLikes = pgTable(
  'comment_likes',
  {
    commentId: uuid('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.commentId, t.userId] })],
);
