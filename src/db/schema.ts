import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgSchema,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/** Supabase-managed table; referenced for foreign keys only, never migrated by us. */
export const authUsers = pgSchema('auth').table('users', { id: uuid('id').primaryKey() });

export type ProfileStatus = 'pending' | 'active';
export type OtpPurpose = 'signup' | 'login' | 'password_reset';
export type OtpChannel = 'email' | 'sms';
export type ThemePreference = 'light' | 'dark' | 'system';
export type ProfileRole = 'member' | 'admin';

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
  /** "About" on the member profile. */
  bio: text('bio'),
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
  /** IANA time zone (e.g. Asia/Karachi) for streak days and daily tasks; null = UTC. */
  timezone: text('timezone'),
  showOnLeaderboard: boolean('show_on_leaderboard').notNull().default(true),
  /** "Mark all as read": every notification created before this counts as read. */
  notificationsReadAt: timestamptz('notifications_read_at'),
  /** `admin` unlocks /admin endpoints. Set by hand in the database. */
  role: text('role').$type<ProfileRole>().notNull().default('member'),
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

/**
 * Append-only XP ledger: totals, levels, streaks, badges and leaderboards are all derived from it.
 * A row with amount 0 is activity that earned nothing (already rewarded, or over a daily cap) but still counts
 * for tasks, streaks and badges. `idempotency_key` is set only on rows that earned XP, so a retry never pays twice.
 */
export const xpEvents = pgTable(
  'xp_events',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    amount: integer('amount').notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    idempotencyKey: text('idempotency_key'),
    metadata: jsonb('metadata'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('xp_events_user_key_uidx').on(t.userId, t.idempotencyKey),
    index('xp_events_user_created_idx').on(t.userId, t.createdAt),
    index('xp_events_created_idx').on(t.createdAt),
  ],
);

export const userBadges = pgTable(
  'user_badges',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    badgeId: text('badge_id').notNull(),
    earnedAt: timestamptz('earned_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.badgeId] })],
);

/** Runtime settings an admin can change without a release (e.g. key "xp" = XP rule overrides). */
export const appSettings = pgTable('app_settings', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull(),
  updatedBy: uuid('updated_by').references(() => authUsers.id, { onDelete: 'set null' }),
  updatedAt: timestamptz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export type ConnectionStatus = 'pending' | 'accepted';

/**
 * One row per pair of members, whichever of them asked first. `pending` = requester is waiting for the addressee;
 * a declined or cancelled request is deleted, so the pair can start over.
 */
export const connections = pgTable(
  'connections',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    requesterId: uuid('requester_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    addresseeId: uuid('addressee_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    status: text('status').$type<ConnectionStatus>().notNull().default('pending'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    respondedAt: timestamptz('responded_at'),
  },
  (t) => [
    // At most one row per pair, in either direction.
    uniqueIndex('connections_pair_uidx').on(
      sql`least(${t.requesterId}, ${t.addresseeId})`,
      sql`greatest(${t.requesterId}, ${t.addresseeId})`,
    ),
    index('connections_requester_idx').on(t.requesterId, t.status),
    index('connections_addressee_idx').on(t.addresseeId, t.status),
  ],
);

export const blocks = pgTable(
  'blocks',
  {
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index('blocks_blocked_idx').on(t.blockedId)],
);

export type ReportReason = 'spam' | 'harassment' | 'fake_profile' | 'inappropriate' | 'other';
export type ReportStatus = 'open' | 'reviewed' | 'dismissed';

export const memberReports = pgTable(
  'member_reports',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    reporterId: uuid('reporter_id').references(() => authUsers.id, { onDelete: 'set null' }),
    reportedId: uuid('reported_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    reason: text('reason').$type<ReportReason>().notNull(),
    details: text('details'),
    status: text('status').$type<ReportStatus>().notNull().default('open'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    reviewedAt: timestamptz('reviewed_at'),
  },
  (t) => [index('member_reports_status_created_idx').on(t.status, t.createdAt)],
);

export type NotificationType =
  | 'latest_issue'
  | 'breaking_news'
  | 'news'
  | 'research'
  | 'video'
  | 'webinar'
  | 'podcast'
  | 'connection_request'
  | 'connection_accepted'
  | 'system';

/**
 * A personal notification (user_id set) or a broadcast (user_id null) shown to everyone, or only to members with
 * one of `audience_topic_ids` among their interests.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
    userId: uuid('user_id').references(() => authUsers.id, { onDelete: 'cascade' }),
    audienceTopicIds: smallint('audience_topic_ids').array(),
    type: text('type').$type<NotificationType>().notNull(),
    label: text('label').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    coverUrl: text('cover_url'),
    xpValue: integer('xp_value'),
    isPremium: boolean('is_premium').notNull().default(false),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** The member the notification is about (e.g. who sent a connection request). */
    actorId: uuid('actor_id').references(() => authUsers.id, { onDelete: 'cascade' }),
    createdBy: uuid('created_by').references(() => authUsers.id, { onDelete: 'set null' }),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
  },
  (t) => [
    index('notifications_user_created_idx').on(t.userId, t.createdAt),
    index('notifications_broadcast_created_idx').on(t.createdAt).where(sql`${t.userId} is null`),
  ],
);

export const notificationReads = pgTable(
  'notification_reads',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    readAt: timestamptz('read_at').notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.notificationId] })],
);

export type DevicePlatform = 'ios' | 'android' | 'web';

/** Push tokens (FCM registration tokens). A token belongs to whoever registered it last. */
export const devices = pgTable(
  'devices',
  {
    token: text('token').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    platform: text('platform').$type<DevicePlatform>().notNull(),
    appVersion: text('app_version'),
    createdAt: timestamptz('created_at').notNull().defaultNow(),
    lastSeenAt: timestamptz('last_seen_at').notNull().defaultNow(),
  },
  (t) => [index('devices_user_idx').on(t.userId)],
);
