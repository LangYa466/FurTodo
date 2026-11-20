import {isNotNull} from 'drizzle-orm';
import {
  bigint,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import type {GithubProfile} from '../auth/github';
import type {Kind, Settings} from '../domain/model';

/** A point in time; JS sees it as a `Date`. */
function instant(name: string) {
  return timestamp(name, {withTimezone: true, mode: 'date'});
}

/** A calendar date; JS sees it as "YYYY-MM-DD". */
function calendarDate(name: string) {
  return date(name, {mode: 'string'});
}

/** GitHub user id, which is also the user's id here. */
function userId() {
  return bigint('user_id', {mode: 'number'})
    .notNull()
    .references(() => users.id, {onDelete: 'cascade'});
}

/** How a session authenticates: GitHub OAuth login or personal token. */
export type SessionKind = 'oauth' | 'pat';

/** Accounts, their GitHub profile, sealed token, and settings copy. */
export const users = pgTable('users', {
  id: bigint('id', {mode: 'number'}).primaryKey(),
  profile: jsonb('profile').$type<GithubProfile>().notNull(),
  /** GitHub OAuth token sealed with AES-GCM; empty once revoked. */
  sealedGithubToken: text('sealed_github_token').notNull(),
  /** Copy of the settings entity, read on every request. */
  settings: jsonb('settings').$type<Settings>().notNull(),
  /** Last time GitHub accepted the stored token. */
  eligibilityCheckedAt: instant('eligibility_checked_at').notNull(),
  /**
   * Last time GitHub could not be reached, so outages are not retried per
   * request.
   */
  eligibilityFailedAt: instant('eligibility_failed_at'),
  /**
   * Highest entity stamp handed out; each write transaction takes a newer
   * one.
   */
  lastStamp: instant('last_stamp').notNull(),
  /** Newest stamp among purged deletions; older sync cursors must resync. */
  purgedThrough: instant('purged_through'),
  liveEntityCount: integer('live_entity_count').notNull(),
  createdAt: instant('created_at').notNull(),
});

/** Login sessions, pending login codes, and personal access tokens. */
export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: userId(),
    kind: text('kind').$type<SessionKind>().notNull(),
    name: text('name'),
    status: text('status').$type<'pending' | 'active'>().notNull(),
    /** PKCE challenge of the client redeeming a pending login code. */
    codeChallenge: text('code_challenge'),
    redirectUri: text('redirect_uri'),
    userAgent: text('user_agent'),
    createdAt: instant('created_at').notNull(),
    lastUsedAt: instant('last_used_at').notNull(),
    expiresAt: instant('expires_at').notNull(),
  },
  table => [
    index('sessions_user_idx').on(table.userId, table.lastUsedAt),
    index('sessions_expires_idx').on(table.expiresAt),
  ],
);

/** Per-user daily quota counters; `day` is the date in QUOTA_TIMEZONE. */
export const usageDays = pgTable(
  'usage_days',
  {
    userId: userId(),
    day: calendarDate('day').notNull(),
    requests: integer('requests').notNull().default(0),
    reads: integer('reads').notNull().default(0),
    writes: integer('writes').notNull().default(0),
    logins: integer('logins').notNull().default(0),
    pushes: integer('pushes').notNull().default(0),
  },
  table => [
    primaryKey({columns: [table.userId, table.day]}),
    index('usage_days_day_idx').on(table.day),
  ],
);

/**
 * Tasks, lists, folders, tags, and settings. `data` and `clock` hold the
 * synced fields; the columns after `deletedVia` copy the task fields that
 * queries filter on and are rewritten with every save.
 */
export const entities = pgTable(
  'entities',
  {
    userId: userId(),
    kind: text('kind').$type<Kind>().notNull(),
    id: text('id').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull(),
    /**
     * Per-field last-writer-wins clock: client edit time (ms) of each
     * field.
     */
    clock: jsonb('clock').$type<Record<string, number>>().notNull(),
    rev: integer('rev').notNull(),
    createdAt: instant('created_at').notNull(),
    /** Stamp of the write transaction; sync cursors order by it. */
    updatedAt: instant('updated_at').notNull(),
    deletedAt: instant('deleted_at'),
    /**
     * "list:<id>" when a list deletion cascaded here; restoring it undoes
     * this.
     */
    deletedVia: text('deleted_via'),
    listId: text('list_id'),
    dueDate: calendarDate('due_date'),
    myDay: calendarDate('my_day'),
    completedAt: instant('completed_at'),
    priority: integer('priority'),
    quadrant: integer('quadrant'),
  },
  table => [
    primaryKey({columns: [table.userId, table.kind, table.id]}),
    index('entities_sync_idx').on(
      table.userId,
      table.updatedAt,
      table.kind,
      table.id,
    ),
    index('entities_list_idx').on(table.userId, table.listId),
    index('entities_trash_idx')
      .on(table.deletedAt)
      .where(isNotNull(table.deletedAt)),
  ],
);

/** Upcoming task reminders, fired by the every-minute cron trigger. */
export const reminders = pgTable(
  'reminders',
  {
    id: bigint('id', {mode: 'number'}).primaryKey().generatedAlwaysAsIdentity(),
    userId: userId(),
    taskId: text('task_id').notNull(),
    reminderId: text('reminder_id').notNull(),
    fireAt: instant('fire_at').notNull(),
    payload: jsonb('payload').$type<ReminderPayload>().notNull(),
  },
  table => [
    index('reminders_fire_at_idx').on(table.fireAt),
    index('reminders_task_idx').on(table.userId, table.taskId),
  ],
);

/** Web Push endpoints registered by the user's browsers. */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    userId: userId(),
    endpoint: text('endpoint').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    device: text('device'),
    createdAt: instant('created_at').notNull(),
  },
  table => [primaryKey({columns: [table.userId, table.endpoint]})],
);

/** A selected `users` row: profile, sealed token, and settings. */
export type UserRow = typeof users.$inferSelect;
/** A selected `sessions` row: login session or personal token. */
export type SessionRow = typeof sessions.$inferSelect;
/** A selected `usage_days` row: one user's counters for one day. */
export type UsageDayRow = typeof usageDays.$inferSelect;
/** A selected `entities` row, task columns included. */
export type EntityRow = typeof entities.$inferSelect;
/** A selected `push_subscriptions` row: endpoint and keys. */
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/** Payload of a reminder notification. */
export interface ReminderPayload {
  title: string;
  dueDate: string | null;
  dueTime: string | null;
}
