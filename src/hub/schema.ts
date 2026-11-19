import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import type {GithubProfile, OrgSummary} from '../auth/github';
import type {QuotaCounts} from '../config';
import type {EntityMetadata, Settings} from '../domain/model';
import type {SessionKind} from './types';

/** Roles and provenance of a verified org membership. */
export interface StoredMembership {
  role: 'admin' | 'member';
  via: 'user_token' | 'org_token';
}

/**
 * Single row (`id = 'main'`) holding the account state, replacing one key-value
 * entry per setting. It is written on first login.
 */
export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  profile: text('profile', {mode: 'json'}).$type<GithubProfile>().notNull(),
  orgs: text('orgs', {mode: 'json'}).$type<OrgSummary[]>().notNull(),
  membership: text('membership', {mode: 'json'})
    .$type<StoredMembership>()
    .notNull(),
  membershipVerifiedAt: integer('membership_verified_at').notNull(),
  /** GitHub OAuth token, sealed with AES-GCM. */
  sealedGithubToken: text('sealed_github_token').notNull(),
  settings: text('settings', {mode: 'json'}).$type<Settings>().notNull(),
  /** Highest entity stamp persisted to KV and the journal. */
  committedStamp: integer('committed_stamp').notNull(),
  liveEntityCount: integer('live_entity_count').notNull(),
  prunedAt: integer('pruned_at').notNull(),
});

/** Login sessions and personal access tokens. */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  kind: text('kind').$type<SessionKind>().notNull(),
  name: text('name'),
  status: text('status').$type<'pending' | 'active'>().notNull(),
  /** PKCE challenge of the client redeeming a pending login code. */
  codeChallenge: text('code_challenge'),
  redirectUri: text('redirect_uri'),
  userAgent: text('user_agent'),
  createdAt: integer('created_at').notNull(),
  lastUsedAt: integer('last_used_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

/** One row per quota day, keyed by the user's local date. */
export const usageDays = sqliteTable('usage_days', {
  day: text('day').primaryKey(),
  counts: text('counts', {mode: 'json'}).$type<QuotaCounts>().notNull(),
});

/**
 * Entities written recently, replayed by readers on top of KV because KV reads
 * and lists are eventually consistent.
 */
export const journalEntries = sqliteTable(
  'journal_entries',
  {
    key: text('key').primaryKey(),
    updatedAt: integer('updated_at').notNull(),
    metadata: text('metadata', {mode: 'json'})
      .$type<EntityMetadata>()
      .notNull(),
    body: text('body').notNull(),
    writtenAt: integer('written_at').notNull(),
  },
  table => [
    index('journal_entries_updated_at').on(table.updatedAt),
    index('journal_entries_written_at').on(table.writtenAt),
  ],
);

/** Upcoming task reminders; the Durable Object alarm fires them. */
export const reminders = sqliteTable(
  'reminders',
  {
    taskId: text('task_id').notNull(),
    reminderId: text('reminder_id').notNull(),
    fireAt: integer('fire_at').notNull(),
    payload: text('payload', {mode: 'json'}).$type<ReminderPayload>(),
  },
  table => [
    primaryKey({columns: [table.taskId, table.reminderId]}),
    index('reminders_fire_at').on(table.fireAt),
  ],
);

/** Web Push endpoints registered by the user's browsers. */
export const pushSubscriptions = sqliteTable('push_subscriptions', {
  endpoint: text('endpoint').primaryKey(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  device: text('device'),
  createdAt: integer('created_at').notNull(),
});

/** Background work (trash cascades, blob purges) run by the alarm. */
export const jobs = sqliteTable(
  'jobs',
  {
    id: integer('id').primaryKey({autoIncrement: true}),
    type: text('type').notNull(),
    ref: text('ref').notNull(),
    payload: text('payload', {mode: 'json'}).$type<unknown>().notNull(),
    runAt: integer('run_at').notNull(),
  },
  table => [index('jobs_run_at').on(table.runAt)],
);

/** Body of a journal row, kept as text so readers parse it only when used. */
export type JournalRow = typeof journalEntries.$inferSelect;

export type SessionRow = typeof sessions.$inferSelect;

export type JobRow = typeof jobs.$inferSelect;

export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

export type ReminderRow = typeof reminders.$inferSelect;

/** Payload of a reminder notification. */
export interface ReminderPayload {
  title: string;
  dueDate: string | null;
  dueTime: string | null;
}
