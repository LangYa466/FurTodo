import {DurableObject} from 'cloudflare:workers';
import {and, count, eq, gt, inArray, lt, lte, min, sql} from 'drizzle-orm';
import {
  drizzle,
  type DrizzleSqliteDODatabase,
} from 'drizzle-orm/durable-sqlite';
import {migrate} from 'drizzle-orm/durable-sqlite/migrator';
import type {SQLiteTable} from 'drizzle-orm/sqlite-core';
import migrations from '../../drizzle/migrations';
import {
  checkMembership,
  type GithubProfile,
  type OrgSummary,
} from '../auth/github';
import {
  readConfig,
  type AppConfig,
  type QuotaCounts,
  type QuotaKind,
} from '../config';
import {
  REQUIRED_ON_CREATE,
  SETTINGS_ID,
  TOMBSTONE_TTL_SECONDS,
  entityKey,
  mergePatch,
  metadataFor,
  newEntity,
  parseJournalEntry,
  settingsFrom,
  taskDataOf,
  toApiEntity,
  type ApiEntity,
  type JournalEntry,
  type RawJournalEntry,
  type Settings,
  type StoredEntity,
} from '../domain/model';
import {
  openJson,
  randomBase64Url,
  sealJson,
  sha256Base64Url,
} from '../lib/crypto';
import type {
  DetailValue,
  ErrorCode,
  ErrorPayload,
  HubResult,
} from '../lib/errors';
import {nameBasedUuid, uuidV7} from '../lib/ids';
import {
  firstOccurrenceOnOrAfter,
  nextOccurrence,
  normalizeRecurrence,
} from '../lib/recurrence';
import {
  addDays,
  diffDays,
  localDate,
  nextMidnightInstant,
  zonedParts,
  zonedToInstant,
} from '../lib/time';
import {sendWebPush, type SendResult, type VapidConfig} from '../lib/webpush';
import {
  BULK_GET_MAX_KEYS,
  loadEntities,
  scanMetadata,
  type QuotaCharger,
} from '../store/scan';
import {
  account,
  journalEntries,
  jobs,
  pushSubscriptions,
  reminders,
  sessions,
  usageDays,
  type JobRow,
  type PushSubscriptionRow,
  type ReminderPayload,
  type SessionRow,
  type StoredMembership,
} from './schema';
import type {
  AccountView,
  BeginReadOptions,
  BeginReadResult,
  JournalRequest,
  MutationOutcome,
  PendingSessionInput,
  PullPlan,
  PushDelivery,
  PushSubscriptionInput,
  ReadQuotaGrant,
  SessionView,
  TestPushResult,
  TopUpResult,
  UsageView,
  ValidatedMutation,
} from './types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Row key of the single account row. */
const ACCOUNT_ID = 'main';
/** How long writes stay in the journal; KV converges within about 60s. */
const JOURNAL_WINDOW_MS = 10 * MINUTE_MS;
/** Journal age overlaid on KV scans. */
const SCAN_OVERLAY_MS = 3 * MINUTE_MS;
/** Pulls whose cursor is this far inside the journal window skip KV. */
const PULL_FAST_PATH_MARGIN_MS = 30_000;
const SESSION_TTL_MS = 30 * DAY_MS;
/** Sessions record their last use at most once per hour. */
const SESSION_TOUCH_MS = HOUR_MS;
const LOGIN_CODE_TTL_MS = 5 * MINUTE_MS;
const MEMBERSHIP_RECHECK_MS = 6 * HOUR_MS;
/** How long requests continue while GitHub cannot confirm membership. */
const MEMBERSHIP_GRACE_MS = 72 * HOUR_MS;
const PRUNE_INTERVAL_MS = HOUR_MS;
const USAGE_HISTORY_DAYS = 14;
const MAX_SESSIONS = 50;
const MAX_PUSH_SUBSCRIPTIONS = 10;
const ENTITY_CACHE_MAX = 2000;
const CASCADE_BATCH_SIZE = 200;
const JOBS_PER_ALARM = 5;
const JOB_RETRY_DELAY_MS = MINUTE_MS;
const REMINDERS_PER_ALARM = 50;
/** Reminders up to this far in the past still fire (right away). */
const REMINDER_PAST_TOLERANCE_MS = MINUTE_MS;
/** Alarms can fire slightly early; reminders due this soon fire with them. */
const ALARM_EARLY_TOLERANCE_MS = 1000;
/** KV accepts one write per second per key. */
const KV_RETRY_DELAY_MS = 1100;
const PUSH_TTL_SECONDS = 3600;
/** Web Push topics are at most 32 base64url characters. */
const PUSH_TOPIC_LENGTH = 32;
const SESSION_ID_BYTES = 16;
/** Durable Object SQLite binds at most 100 parameters per query. */
const SQL_MAX_PARAMS = 100;

type Database = DrizzleSqliteDODatabase;

interface AccountState {
  userId: string;
  profile: GithubProfile;
  orgs: OrgSummary[];
  membership: StoredMembership;
  membershipVerifiedAt: number;
  sealedGithubToken: string;
  settings: Settings;
  /** Highest stamp persisted to KV and the journal; readers stop here. */
  committedStamp: number;
  liveEntityCount: number;
  prunedAt: number;
}

type MembershipCheck = 'ok' | 'revoked' | 'restricted' | 'unavailable';

interface JournalSelection {
  journal: RawJournalEntry[];
  pullPlan: PullPlan | null;
}

interface MutationEffect {
  status: MutationOutcome['status'];
  entity: StoredEntity | null;
  spawned: StoredEntity[];
}

type JobType = 'cascade_list';
/** `more` reruns the job right away; `retryAt` reschedules it. */
type JobOutcome = 'done' | 'more' | {retryAt: number};

interface CascadeListJob {
  listId: string;
  op: 'delete' | 'restore';
}

const ZERO_COUNTS: QuotaCounts = {
  requests: 0,
  reads: 0,
  writes: 0,
  lists: 0,
  logins: 0,
  pushes: 0,
};

/** Thrown inside the hub and returned as a failed HubResult at the RPC edge. */
class HubError extends Error {
  constructor(readonly payload: ErrorPayload) {
    super(payload.message);
    this.name = 'HubError';
  }
}

function fail(
  status: ErrorPayload['status'],
  code: ErrorCode,
  message: string,
  details?: Record<string, DetailValue>,
): never {
  throw new HubError({status, code, message, details});
}

function toSessionView(row: SessionRow, currentSessionId: string): SessionView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    userAgent: row.userAgent,
    createdAt: new Date(row.createdAt).toISOString(),
    lastUsedAt: new Date(row.lastUsedAt).toISOString(),
    expiresAt: new Date(row.expiresAt).toISOString(),
    current: row.id === currentSessionId,
  };
}

/** Returns the API shape of settings that were never saved (rev 0). */
function unsavedSettingsEntity(settings: Settings): ApiEntity {
  const epoch = new Date(0).toISOString();
  return {
    id: SETTINGS_ID,
    ...settings,
    rev: 0,
    createdAt: epoch,
    updatedAt: epoch,
    deletedAt: null,
  };
}

/**
 * Per-user Durable Object, addressed by `idFromName(githubUserId)`.
 *
 * - Control plane: sessions, the daily quota ledger, org membership rechecks,
 *   Web Push subscriptions, reminder alarms, and background jobs.
 * - Serializes every entity write to KV and keeps a short journal that readers
 *   overlay on KV to hide its eventual consistency.
 *
 * Storage is SQLite through Drizzle; the schema lives in `schema.ts` and
 * drizzle-kit generates the migrations applied in the constructor.
 */
export class UserHub extends DurableObject<Env> {
  private readonly db: Database;
  private readonly config: AppConfig;
  private accountState: AccountState | null;
  /** Highest stamp handed out; its write may still be in flight. */
  private issuedStamp: number;
  private usageCache: {day: string; counts: QuotaCounts} | null = null;
  private readonly entityCache = new Map<string, StoredEntity>();
  /** Tail of the write queue; see `serialized`. */
  private writeQueue: Promise<unknown> = Promise.resolve();
  /** In-flight GitHub membership check shared by concurrent requests. */
  private membershipCheck: Promise<MembershipCheck> | null = null;
  private readonly quotaCharger: QuotaCharger = {
    charge: (kind, count) => {
      this.consumeQuota(kind, count, Date.now());
    },
  };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = readConfig(env);
    this.db = drizzle(ctx.storage);
    // Durable Object SQLite migrations are synchronous, so they finish here
    // and every RPC method sees the current schema.
    const migrationFailure = migrate(this.db, migrations);
    if (migrationFailure) {
      throw new Error(`UserHub migration failed: ${migrationFailure.exitCode}`);
    }
    this.accountState = this.loadAccount();
    this.issuedStamp = this.accountState?.committedStamp ?? 0;
  }

  /**
   * Records a GitHub login and opens a pending session that the client
   * redeems once with its PKCE verifier (see `activateSession`).
   */
  async createPendingSession(
    input: PendingSessionInput,
  ): Promise<HubResult<{sessionId: string}>> {
    return this.asResult(async () => {
      const now = Date.now();
      if (this.accountState && this.accountState.userId !== input.userId) {
        fail(500, 'internal_error', 'Durable Object 与用户不符');
      }
      this.consumeQuota('logins', 1, now);
      this.accountState = {
        userId: input.userId,
        profile: input.profile,
        orgs: input.orgs,
        membership: input.membership,
        membershipVerifiedAt: now,
        sealedGithubToken: await sealJson(
          this.env.TOKEN_SECRET,
          'ghtoken-aes',
          input.githubToken,
        ),
        settings: this.accountState?.settings ?? settingsFrom(null),
        committedStamp: this.accountState?.committedStamp ?? 0,
        liveEntityCount: this.accountState?.liveEntityCount ?? 0,
        prunedAt: now,
      };
      this.saveAccount();
      this.pruneExpiredState(now, /* force= */ true);
      this.evictOldestSessions();
      const sessionId = randomBase64Url(SESSION_ID_BYTES);
      this.db
        .insert(sessions)
        .values({
          id: sessionId,
          kind: 'oauth',
          name: null,
          status: 'pending',
          codeChallenge: input.codeChallenge,
          redirectUri: input.redirectUri,
          userAgent: input.userAgent,
          createdAt: now,
          lastUsedAt: now,
          expiresAt: now + LOGIN_CODE_TTL_MS,
        })
        .run();
      return {sessionId};
    });
  }

  /** Redeems a login code after checking its PKCE verifier and redirect URI. */
  async activateSession(
    sessionId: string,
    codeVerifier: string,
    redirectUri: string,
    userAgent: string | null,
  ): Promise<HubResult<AccountView>> {
    return this.asResult(async () => {
      const now = Date.now();
      const session = this.findSession(sessionId);
      const invalidGrant = {oauthError: 'invalid_grant'};
      if (!session || session.status !== 'pending') {
        fail(400, 'bad_request', '登录码无效或已使用', invalidGrant);
      }
      if (session.expiresAt <= now) {
        this.deleteSession(sessionId);
        fail(400, 'bad_request', '登录码已过期，请重新登录', invalidGrant);
      }
      if (session.redirectUri !== redirectUri) {
        fail(400, 'bad_request', 'redirect_uri 与授权时不同', invalidGrant);
      }
      if ((await sha256Base64Url(codeVerifier)) !== session.codeChallenge) {
        fail(400, 'bad_request', 'code_verifier 不符', invalidGrant);
      }
      this.db
        .update(sessions)
        .set({
          status: 'active',
          codeChallenge: null,
          lastUsedAt: now,
          expiresAt: now + SESSION_TTL_MS,
          userAgent: userAgent ?? session.userAgent,
        })
        .where(eq(sessions.id, sessionId))
        .run();
      return this.accountView(sessionId);
    });
  }

  async createPersonalToken(
    sessionId: string,
    name: string,
    expiresInDays: number,
  ): Promise<HubResult<SessionView>> {
    return this.asResult(async () => {
      const now = Date.now();
      await this.authorize(sessionId, now);
      this.evictOldestSessions();
      const token: SessionRow = {
        id: randomBase64Url(SESSION_ID_BYTES),
        kind: 'pat',
        name,
        status: 'active',
        codeChallenge: null,
        redirectUri: null,
        userAgent: null,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: now + expiresInDays * DAY_MS,
      };
      this.db.insert(sessions).values(token).run();
      return toSessionView(token, sessionId);
    });
  }

  async listSessions(sessionId: string): Promise<HubResult<SessionView[]>> {
    return this.asResult(async () => {
      await this.authorize(sessionId, Date.now());
      return this.db
        .select()
        .from(sessions)
        .where(eq(sessions.status, 'active'))
        .orderBy(sql`${sessions.lastUsedAt} DESC`)
        .all()
        .map(row => toSessionView(row, sessionId));
    });
  }

  async revokeSession(
    sessionId: string,
    targetSessionId: string,
  ): Promise<HubResult<{revoked: boolean}>> {
    return this.asResult(async () => {
      await this.authorize(sessionId, Date.now());
      return {revoked: this.deleteSession(targetSessionId)};
    });
  }

  /** Ends a session without authorizing it, so expired members can log out. */
  async logout(sessionId: string): Promise<HubResult<{revoked: boolean}>> {
    return this.asResult(async () => ({
      revoked: this.deleteSession(sessionId),
    }));
  }

  async getAccount(sessionId: string): Promise<HubResult<AccountView>> {
    return this.asResult(async () => {
      await this.authorize(sessionId, Date.now());
      return this.accountView(sessionId);
    });
  }

  async getUsage(sessionId: string): Promise<HubResult<UsageView>> {
    return this.asResult(async () => {
      const now = Date.now();
      await this.authorize(sessionId, now);
      const account = this.requireAccount();
      const usage = this.usageOn(now);
      const {quotaTimeZone, dailyQuota, maxEntities} = this.config;
      return {
        day: usage.day,
        timeZone: quotaTimeZone,
        resetAt: new Date(
          nextMidnightInstant(now, quotaTimeZone),
        ).toISOString(),
        used: {...usage.counts},
        limits: {...dailyQuota},
        totals: {entities: account.liveEntityCount},
        totalLimits: {entities: maxEntities},
      };
    });
  }

  /**
   * Starts a Worker-side read: authorizes the session, reserves KV quota, and
   * returns the journal overlay the read asked for.
   */
  async beginRead(
    sessionId: string,
    options: BeginReadOptions,
  ): Promise<HubResult<BeginReadResult>> {
    return this.asResult(async () => {
      const now = Date.now();
      await this.authorize(sessionId, now);
      const account = this.requireAccount();
      const usage = this.usageOn(now);
      const grant: ReadQuotaGrant = {
        reads: this.reserveQuota('reads', options.reserveReads ?? 0, now),
        lists: this.reserveQuota('lists', options.reserveLists ?? 0, now),
      };
      const {journal, pullPlan} = this.selectJournal(options.journal, now);
      return {
        userId: account.userId,
        day: usage.day,
        grant,
        journal,
        committedStamp: this.requireAccount().committedStamp,
        settings: this.requireAccount().settings,
        pullPlan,
        now,
      };
    });
  }

  /** Grants more read quota to a running read; 0 once the session or day ended. */
  async topUpReadQuota(
    sessionId: string,
    kind: 'reads' | 'lists',
    amount: number,
    day: string,
  ): Promise<TopUpResult> {
    const now = Date.now();
    const session = this.findSession(sessionId);
    const valid =
      session?.status === 'active' &&
      session.expiresAt > now &&
      this.usageOn(now).day === day;
    const resetAt = nextMidnightInstant(now, this.config.quotaTimeZone);
    return {
      granted: valid ? this.reserveQuota(kind, amount, now) : 0,
      retryAfter: Math.ceil((resetAt - now) / 1000),
    };
  }

  /** Returns quota a read reserved but did not use, if the day has not rolled. */
  async refundReadQuota(leftover: ReadQuotaGrant, day: string): Promise<void> {
    const usage = this.usageOn(Date.now());
    if (usage.day !== day) return;
    usage.counts.reads = Math.max(0, usage.counts.reads - leftover.reads);
    usage.counts.lists = Math.max(0, usage.counts.lists - leftover.lists);
    this.persistUsage();
  }

  async applyMutations(
    sessionId: string,
    mutations: ValidatedMutation[],
  ): Promise<HubResult<MutationOutcome[]>> {
    return this.asResult(async () => {
      await this.authorize(sessionId, Date.now());
      return this.serialized(async () => {
        const outcomes = await this.applyMutationBatch(mutations);
        await this.rescheduleAlarm();
        return outcomes;
      });
    });
  }

  async addPushSubscription(
    sessionId: string,
    subscription: PushSubscriptionInput,
  ): Promise<HubResult<{subscriptions: number}>> {
    return this.asResult(async () => {
      await this.authorize(sessionId, Date.now());
      const exists = Boolean(
        this.db
          .select({endpoint: pushSubscriptions.endpoint})
          .from(pushSubscriptions)
          .where(eq(pushSubscriptions.endpoint, subscription.endpoint))
          .get(),
      );
      const subscriptionCount = this.countRows(pushSubscriptions);
      if (!exists && subscriptionCount >= MAX_PUSH_SUBSCRIPTIONS) {
        fail(
          409,
          'limit_exceeded',
          `最多 ${MAX_PUSH_SUBSCRIPTIONS} 个推送订阅`,
        );
      }
      this.db
        .insert(pushSubscriptions)
        .values({
          endpoint: subscription.endpoint,
          p256dh: subscription.keys.p256dh,
          auth: subscription.keys.auth,
          device: subscription.device,
          createdAt: Date.now(),
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            p256dh: subscription.keys.p256dh,
            auth: subscription.keys.auth,
            device: subscription.device,
          },
        })
        .run();
      return {
        subscriptions: exists ? subscriptionCount : subscriptionCount + 1,
      };
    });
  }

  async removePushSubscription(
    sessionId: string,
    endpoint: string,
  ): Promise<HubResult<{removed: boolean}>> {
    return this.asResult(async () => {
      await this.authorize(sessionId, Date.now());
      const deleted = this.db
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, endpoint))
        .run();
      return {removed: deleted.rowsWritten > 0};
    });
  }

  async sendTestPush(sessionId: string): Promise<HubResult<TestPushResult>> {
    return this.asResult(async () => {
      const now = Date.now();
      await this.authorize(sessionId, now);
      const subscriptions = this.db.select().from(pushSubscriptions).all();
      if (subscriptions.length === 0) fail(404, 'not_found', '没有推送订阅');
      this.consumeQuota('pushes', subscriptions.length, now);
      const message = JSON.stringify({
        type: 'test',
        title: 'FurTodo',
        body: '推送测试成功 🎉',
        at: new Date(now).toISOString(),
      });
      const results = await this.pushToSubscriptions(
        subscriptions,
        message,
        'test',
      );
      return {sent: subscriptions.length, results};
    });
  }

  /** Fires due reminders, runs due background jobs, then re-arms itself. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    await this.fireDueReminders(now);
    await this.serialized(() => this.runDueJobs(now));
    this.pruneExpiredState(now, /* force= */ false);
    await this.rescheduleAlarm();
  }

  /** Runs `body`, returning HubErrors as data because RPC drops error fields. */
  private async asResult<T>(body: () => Promise<T>): Promise<HubResult<T>> {
    try {
      return {ok: true, value: await body()};
    } catch (error: unknown) {
      if (error instanceof HubError) return {ok: false, error: error.payload};
      throw error;
    }
  }

  /**
   * Runs `task` after every task queued before it. Awaiting KV lets other RPC
   * calls interleave, so writes go through this queue to stay ordered.
   */
  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.writeQueue.then(
      () => task(),
      () => task(),
    );
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  private requireAccount(): AccountState {
    const state = this.accountState;
    if (!state) throw new Error('UserHub used before its first login');
    return state;
  }

  /** Returns the number of rows in `table`. */
  private countRows(table: SQLiteTable): number {
    return this.db.select({value: count()}).from(table).get()?.value ?? 0;
  }

  private loadAccount(): AccountState | null {
    const row = this.db
      .select()
      .from(account)
      .where(eq(account.id, ACCOUNT_ID))
      .get();
    if (!row) return null;
    return {
      userId: row.userId,
      profile: row.profile,
      orgs: row.orgs,
      membership: row.membership,
      membershipVerifiedAt: row.membershipVerifiedAt,
      sealedGithubToken: row.sealedGithubToken,
      settings: row.settings,
      committedStamp: row.committedStamp,
      liveEntityCount: row.liveEntityCount,
      prunedAt: row.prunedAt,
    };
  }

  /** Writes the in-memory account state back to its single row. */
  private saveAccount(): void {
    const state = this.requireAccount();
    this.db
      .insert(account)
      .values({id: ACCOUNT_ID, ...state})
      .onConflictDoUpdate({target: account.id, set: {...state}})
      .run();
  }

  /**
   * Checks that the session is active, rechecks org membership when due,
   * charges one request, and slides the session expiry at most hourly.
   */
  private async authorize(sessionId: string, now: number): Promise<void> {
    const session = this.findSession(sessionId);
    if (!session || session.status !== 'active') {
      fail(401, 'invalid_token', 'Session 不存在或已注销');
    }
    if (session.expiresAt <= now) {
      this.deleteSession(sessionId);
      fail(401, 'session_expired', 'Session 已过期，请重新登录');
    }
    await this.ensureMembership(now);
    this.consumeQuota('requests', 1, now);
    if (now - session.lastUsedAt > SESSION_TOUCH_MS) {
      // Personal tokens keep their fixed expiry; login sessions slide.
      const expiresAt =
        session.kind === 'oauth' ? now + SESSION_TTL_MS : session.expiresAt;
      this.db
        .update(sessions)
        .set({lastUsedAt: now, expiresAt})
        .where(eq(sessions.id, sessionId))
        .run();
    }
  }

  /**
   * Rechecks org membership every 6 hours. Revoked members lose every
   * session; while GitHub is unreachable, requests continue for a grace period.
   */
  private async ensureMembership(now: number): Promise<void> {
    const verifiedAt = this.accountState?.membershipVerifiedAt ?? 0;
    if (now - verifiedAt < MEMBERSHIP_RECHECK_MS) return;
    this.membershipCheck ??= this.recheckMembership().finally(() => {
      this.membershipCheck = null;
    });
    const outcome = await this.membershipCheck;
    const org = this.config.githubOrg;
    switch (outcome) {
      case 'ok':
        return;
      case 'revoked':
        return fail(
          403,
          'not_org_member',
          `你已不是 ${org} 组织成员，或已撤销 GitHub 授权；请重新登录`,
        );
      case 'restricted':
        return fail(
          403,
          'org_access_restricted',
          `${org} 启用了 OAuth App 访问限制，请组织 owner 批准本应用`,
        );
      default:
        if (now - verifiedAt > MEMBERSHIP_GRACE_MS) {
          fail(503, 'github_unavailable', '暂时无法向 GitHub 验证组织成员身份');
        }
    }
  }

  private async recheckMembership(): Promise<MembershipCheck> {
    const state = this.accountState;
    const token = state
      ? await openJson<string>(
          this.env.TOKEN_SECRET,
          'ghtoken-aes',
          state.sealedGithubToken,
        )
      : null;
    if (!state || !token) {
      this.revokeAllSessions();
      return 'revoked';
    }
    const result = await checkMembership(
      this.config,
      token,
      state.profile.login,
      this.env.GITHUB_ORG_TOKEN,
    );
    switch (result.status) {
      case 'active':
        state.membershipVerifiedAt = Date.now();
        state.membership = {role: result.role, via: result.via};
        this.saveAccount();
        return 'ok';
      case 'restricted':
        return 'restricted';
      case 'unavailable':
        console.warn(
          JSON.stringify({
            msg: 'membership recheck unavailable',
            userId: state.userId,
            detail: result.detail,
          }),
        );
        return 'unavailable';
      default:
        console.log(
          JSON.stringify({
            msg: 'membership revoked',
            userId: state.userId,
            status: result.status,
          }),
        );
        this.revokeAllSessions();
        return 'revoked';
    }
  }

  private revokeAllSessions(): void {
    this.db.delete(sessions).run();
    if (this.accountState) {
      // Drop the stored token so a revoked member cannot re-verify with it.
      this.accountState.sealedGithubToken = '';
      this.saveAccount();
    }
  }

  private usageOn(now: number): {day: string; counts: QuotaCounts} {
    const day = localDate(now, this.config.quotaTimeZone);
    if (this.usageCache?.day !== day) {
      const row = this.db
        .select()
        .from(usageDays)
        .where(eq(usageDays.day, day))
        .get();
      this.usageCache = {day, counts: {...ZERO_COUNTS, ...(row?.counts ?? {})}};
    }
    return this.usageCache;
  }

  private persistUsage(): void {
    if (!this.usageCache) return;
    const {day, counts} = this.usageCache;
    this.db
      .insert(usageDays)
      .values({day, counts})
      .onConflictDoUpdate({target: usageDays.day, set: {counts}})
      .run();
  }

  private quotaExceeded(kind: QuotaKind, now: number): ErrorPayload {
    const limit = this.config.dailyQuota[kind];
    const resetAt = nextMidnightInstant(now, this.config.quotaTimeZone);
    return {
      status: 429,
      code: 'quota_exceeded',
      message: `今日 ${kind} 配额已用完（每日上限 ${limit}）`,
      details: {kind, limit, resetAt: new Date(resetAt).toISOString()},
      retryAfter: Math.ceil((resetAt - now) / 1000),
    };
  }

  /** Consumes quota if the daily limit allows; returns whether it did. */
  private tryConsumeQuota(
    kind: QuotaKind,
    amount: number,
    now: number,
  ): boolean {
    const usage = this.usageOn(now);
    if (usage.counts[kind] + amount > this.config.dailyQuota[kind]) {
      return false;
    }
    usage.counts[kind] += amount;
    this.persistUsage();
    return true;
  }

  private consumeQuota(kind: QuotaKind, amount: number, now: number): void {
    if (!this.tryConsumeQuota(kind, amount, now)) {
      throw new HubError(this.quotaExceeded(kind, now));
    }
  }

  /** Reserves up to `amount`, capped by what is left today. */
  private reserveQuota(kind: QuotaKind, amount: number, now: number): number {
    if (amount <= 0) return 0;
    const usage = this.usageOn(now);
    const left = this.config.dailyQuota[kind] - usage.counts[kind];
    const granted = Math.max(0, Math.min(amount, left));
    usage.counts[kind] += granted;
    this.persistUsage();
    return granted;
  }

  private findSession(sessionId: string): SessionRow | null {
    const row = this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    return row ?? null;
  }

  /** Deletes a session; returns whether it existed. */
  private deleteSession(sessionId: string): boolean {
    const result = this.db
      .delete(sessions)
      .where(eq(sessions.id, sessionId))
      .run();
    return result.rowsWritten > 0;
  }

  private accountView(sessionId: string): AccountView {
    const state = this.requireAccount();
    const session = this.findSession(sessionId);
    if (!session) throw new Error('Account state is incomplete');
    const settingsEntity = this.entityCache.get(
      entityKey(state.userId, 'settings', SETTINGS_ID),
    );
    return {
      user: state.profile,
      membership: {
        org: this.config.githubOrg,
        ...state.membership,
        verifiedAt: new Date(state.membershipVerifiedAt).toISOString(),
      },
      orgs: state.orgs,
      session: toSessionView(session, sessionId),
      settings: settingsEntity
        ? this.toApi(settingsEntity)
        : unsavedSettingsEntity(state.settings),
    };
  }

  /** Makes room for one more session by dropping least recently used logins. */
  private evictOldestSessions(): void {
    const sessionCount = this.countRows(sessions);
    if (sessionCount < MAX_SESSIONS) return;
    const oldest = this.db
      .select({id: sessions.id})
      .from(sessions)
      .where(eq(sessions.kind, 'oauth'))
      .orderBy(sql`${sessions.lastUsedAt} ASC`)
      .limit(sessionCount - MAX_SESSIONS + 1)
      .all()
      .map(row => row.id);
    if (oldest.length === 0) return;
    this.db.delete(sessions).where(inArray(sessions.id, oldest)).run();
  }

  private setLiveEntityCount(count: number): void {
    this.requireAccount().liveEntityCount = Math.max(0, count);
    this.saveAccount();
  }

  /**
   * Returns a server stamp, strictly increasing per user. Reads may interleave
   * while a write awaits KV, so readers only see `committedStamp`.
   */
  private nextStamp(): number {
    this.issuedStamp = Math.max(Date.now(), this.issuedStamp + 1);
    return this.issuedStamp;
  }

  private withNewRevision(entity: StoredEntity): StoredEntity {
    return {...entity, rev: entity.rev + 1, updatedAt: this.nextStamp()};
  }

  /** Returns the entity moved to the trash; `deletedVia` marks cascades. */
  private withDeletion(
    entity: StoredEntity,
    deletedVia: string | null,
  ): StoredEntity {
    const revised = this.withNewRevision({...entity, deletedVia});
    return {...revised, deletedAt: revised.updatedAt};
  }

  private toApi(entity: StoredEntity): ApiEntity {
    return toApiEntity(entity, this.requireAccount().settings.timezone);
  }

  private selectJournal(
    request: JournalRequest,
    now: number,
  ): JournalSelection {
    const recent = () =>
      this.db
        .select()
        .from(journalEntries)
        .where(gt(journalEntries.writtenAt, now - SCAN_OVERLAY_MS))
        .all();
    switch (request.mode) {
      case 'scan':
        return {journal: recent(), pullPlan: null};
      case 'keys':
        return {journal: this.rawJournalForKeys(request.keys), pullPlan: null};
      case 'pull': {
        const committedStamp = this.requireAccount().committedStamp;
        if (request.since >= committedStamp) {
          return {journal: [], pullPlan: 'upToDate'};
        }
        if (
          request.since > 0 &&
          request.since >= now - JOURNAL_WINDOW_MS + PULL_FAST_PATH_MARGIN_MS
        ) {
          const changed = this.db
            .select()
            .from(journalEntries)
            .where(gt(journalEntries.updatedAt, request.since))
            .orderBy(sql`${journalEntries.updatedAt} ASC`)
            .all();
          return {journal: changed, pullPlan: 'journal'};
        }
        return {journal: recent(), pullPlan: 'scan'};
      }
      default:
        return {journal: [], pullPlan: null};
    }
  }

  private rawJournalForKeys(keys: string[]): RawJournalEntry[] {
    const entries: RawJournalEntry[] = [];
    for (let i = 0; i < keys.length; i += SQL_MAX_PARAMS) {
      const chunk = keys.slice(i, i + SQL_MAX_PARAMS);
      entries.push(
        ...this.db
          .select()
          .from(journalEntries)
          .where(inArray(journalEntries.key, chunk))
          .all(),
      );
    }
    return entries;
  }

  private journalForKeys(keys: string[]): JournalEntry[] {
    return this.rawJournalForKeys(keys).map(entry => parseJournalEntry(entry));
  }

  private fullJournalOverlay(): Map<string, JournalEntry> {
    const entries = this.db
      .select()
      .from(journalEntries)
      .all()
      .map(entry => parseJournalEntry(entry));
    return new Map(entries.map(entry => [entry.key, entry]));
  }

  /** Caches an entity, evicting the least recently cached beyond the cap. */
  private cacheEntity(key: string, entity: StoredEntity): void {
    this.entityCache.delete(key);
    this.entityCache.set(key, entity);
    if (this.entityCache.size > ENTITY_CACHE_MAX) {
      const oldest = this.entityCache.keys().next().value;
      if (oldest !== undefined) this.entityCache.delete(oldest);
    }
  }

  private async loadEntity(key: string): Promise<StoredEntity | null> {
    const cached = this.entityCache.get(key);
    if (cached) return cached;
    const [journal] = this.journalForKeys([key]);
    if (journal) {
      this.cacheEntity(key, journal.body);
      return journal.body;
    }
    this.consumeQuota('reads', 1, Date.now());
    const entity = await this.env.DATA.get<StoredEntity>(key, 'json');
    if (entity) this.cacheEntity(key, entity);
    return entity;
  }

  /**
   * Bulk-loads entities that are neither cached nor journaled. Skips KV when
   * the read quota cannot cover the batch; single reads then report it.
   */
  private async prefetchEntities(keys: string[]): Promise<void> {
    const missing = [...new Set(keys)].filter(
      key => !this.entityCache.has(key),
    );
    if (missing.length === 0) return;
    const journaled = this.journalForKeys(missing);
    for (const entry of journaled) {
      this.cacheEntity(entry.key, entry.body);
    }
    const journaledKeys = new Set(journaled.map(entry => entry.key));
    const toFetch = missing.filter(key => !journaledKeys.has(key));
    if (toFetch.length === 0) return;
    if (!this.tryConsumeQuota('reads', toFetch.length, Date.now())) return;
    for (let i = 0; i < toFetch.length; i += BULK_GET_MAX_KEYS) {
      const values = await this.env.DATA.get<StoredEntity>(
        toFetch.slice(i, i + BULK_GET_MAX_KEYS),
        'json',
      );
      for (const [key, entity] of values) {
        if (entity) this.cacheEntity(key, entity);
      }
    }
  }

  /** Writes to KV, retrying once if the per-key write rate limit hits. */
  private async putWithRetry(
    key: string,
    value: string | ArrayBuffer,
    options: KVNamespacePutOptions,
  ): Promise<void> {
    try {
      await this.env.DATA.put(key, value, options);
      return;
    } catch (error: unknown) {
      if (!/429|too many/i.test(String(error))) throw error;
    }
    await scheduler.wait(KV_RETRY_DELAY_MS);
    try {
      await this.env.DATA.put(key, value, options);
    } catch {
      fail(
        503,
        'storage_busy',
        '同一份数据写入过于频繁，请稍后重试（客户端请对编辑做 debounce）',
      );
    }
  }

  /** Writes an entity to KV and the journal, then updates derived state. */
  private async persistEntity(entity: StoredEntity): Promise<void> {
    const now = Date.now();
    const state = this.requireAccount();
    this.consumeQuota('writes', 1, now);
    const key = entityKey(state.userId, entity.kind, entity.id);
    const metadata = metadataFor(entity);
    const body = JSON.stringify(entity);
    await this.putWithRetry(
      key,
      body,
      entity.deletedAt
        ? {metadata, expirationTtl: TOMBSTONE_TTL_SECONDS}
        : {metadata},
    );
    this.db
      .insert(journalEntries)
      .values({
        key,
        updatedAt: entity.updatedAt,
        metadata,
        body,
        writtenAt: now,
      })
      .onConflictDoUpdate({
        target: journalEntries.key,
        set: {
          updatedAt: entity.updatedAt,
          metadata,
          body,
          writtenAt: now,
        },
      })
      .run();
    if (entity.updatedAt > state.committedStamp) {
      state.committedStamp = entity.updatedAt;
      this.saveAccount();
    }
    this.cacheEntity(key, entity);
    if (entity.kind === 'settings') {
      state.settings = settingsFrom(entity);
      this.saveAccount();
    }
    if (entity.kind === 'task') this.scheduleTaskReminders(entity, now);
  }

  /** Applies mutations in order; one rejection does not stop the rest. */
  private async applyMutationBatch(
    mutations: ValidatedMutation[],
  ): Promise<MutationOutcome[]> {
    const userId = this.requireAccount().userId;
    this.pruneExpiredState(Date.now(), /* force= */ false);
    await this.prefetchEntities(
      mutations.map(mutation => entityKey(userId, mutation.type, mutation.id)),
    );
    const outcomes: MutationOutcome[] = [];
    for (const [index, mutation] of mutations.entries()) {
      const base = {
        index,
        type: mutation.type,
        id: mutation.id,
        op: mutation.op,
      };
      let effect: MutationEffect;
      try {
        effect = await this.applyMutation(mutation);
      } catch (error: unknown) {
        if (!(error instanceof HubError)) throw error;
        const current = this.entityCache.get(
          entityKey(userId, mutation.type, mutation.id),
        );
        const {code, message, status, retryAfter} = error.payload;
        outcomes.push({
          ...base,
          status: 'rejected',
          entity: current ? this.toApi(current) : null,
          spawned: [],
          error: {code, message, status, retryAfter},
        });
        continue;
      }
      outcomes.push({
        ...base,
        status: effect.status,
        entity: effect.entity ? this.toApi(effect.entity) : null,
        spawned: effect.spawned.map(spawned => this.toApi(spawned)),
        error: null,
      });
    }
    return outcomes;
  }

  private async applyMutation(
    mutation: ValidatedMutation,
  ): Promise<MutationEffect> {
    if (mutation.type === 'settings' && mutation.id !== SETTINGS_ID) {
      fail(400, 'validation_error', `settings 的 id 固定为 "${SETTINGS_ID}"`);
    }
    const now = Date.now();
    const current = await this.loadEntity(
      entityKey(this.requireAccount().userId, mutation.type, mutation.id),
    );
    switch (mutation.op) {
      case 'upsert':
        return this.applyUpsert(mutation, current, now);
      case 'delete':
        return this.applyDelete(mutation, current);
      case 'restore':
        return this.applyRestore(current, now);
      default:
        return fail(400, 'validation_error', '不支持的 op');
    }
  }

  private async applyUpsert(
    mutation: ValidatedMutation,
    current: StoredEntity | null,
    now: number,
  ): Promise<MutationEffect> {
    const patch = mutation.data ?? {};
    // Edit times from the future are clamped to now.
    const editedAt = Math.min(mutation.editedAt ?? now, now);
    if (!current) {
      if (mutation.mustExist) fail(404, 'not_found', '实体不存在');
      const missing = REQUIRED_ON_CREATE[mutation.type].filter(
        field => patch[field] === undefined,
      );
      if (missing.length > 0) {
        fail(
          404,
          'not_found',
          `实体不存在；创建时必须提供 ${missing.join(', ')}`,
          {missing},
        );
      }
      await this.ensureEntityCapacity(1);
      let created = newEntity(
        mutation.type,
        mutation.id,
        patch,
        editedAt,
        this.nextStamp(),
      );
      if (created.kind === 'task') {
        created = this.applyTaskRules(
          created,
          null,
          Object.keys(patch),
          editedAt,
          now,
        );
      }
      await this.persistEntity(created);
      this.setLiveEntityCount(this.requireAccount().liveEntityCount + 1);
      return {status: 'applied', entity: created, spawned: []};
    }
    if (current.deletedAt) {
      fail(409, 'deleted', '实体在回收站中；请先 restore 再修改');
    }
    const {next, changedFields} = mergePatch(current, patch, editedAt);
    if (changedFields.length === 0) {
      return {status: 'noop', entity: current, spawned: []};
    }
    let updated = this.withNewRevision(next);
    if (updated.kind === 'task') {
      updated = this.applyTaskRules(
        updated,
        current,
        changedFields,
        editedAt,
        now,
      );
    }
    await this.persistEntity(updated);
    const spawned =
      updated.kind === 'task'
        ? await this.spawnNextOccurrence(updated, current, now)
        : [];
    return {status: 'applied', entity: updated, spawned};
  }

  private async applyDelete(
    mutation: ValidatedMutation,
    current: StoredEntity | null,
  ): Promise<MutationEffect> {
    if (mutation.type === 'settings') {
      fail(400, 'validation_error', 'settings 不能删除');
    }
    if (!current || current.deletedAt) {
      return {status: 'noop', entity: current, spawned: []};
    }
    const deleted = this.withDeletion(current, null);
    await this.persistEntity(deleted);
    this.setLiveEntityCount(this.requireAccount().liveEntityCount - 1);
    this.onDeleted(deleted);
    return {status: 'applied', entity: deleted, spawned: []};
  }

  private async applyRestore(
    current: StoredEntity | null,
    now: number,
  ): Promise<MutationEffect> {
    if (!current) {
      fail(404, 'not_found', '实体不存在（可能已超过 30 天被永久删除）');
    }
    if (!current.deletedAt) {
      return {status: 'noop', entity: current, spawned: []};
    }
    await this.ensureEntityCapacity(1);
    let restored = this.withNewRevision({
      ...current,
      deletedAt: null,
      deletedVia: null,
    });
    if (restored.kind === 'task') {
      restored = await this.detachFromDeletedList(restored, now);
    }
    await this.persistEntity(restored);
    this.setLiveEntityCount(this.requireAccount().liveEntityCount + 1);
    this.onRestored(restored);
    return {status: 'applied', entity: restored, spawned: []};
  }

  private async ensureEntityCapacity(adding: number): Promise<void> {
    const state = this.requireAccount();
    const {maxEntities} = this.config;
    if (state.liveEntityCount + adding <= maxEntities) return;
    // The counter drifts upward when a write fails midway; recount first.
    const rows = await scanMetadata(
      this.env.DATA,
      state.userId,
      null,
      this.quotaCharger,
      this.fullJournalOverlay(),
    );
    const live = [...rows.values()].filter(row => !row.metadata.deletedAt);
    this.setLiveEntityCount(live.length);
    if (this.requireAccount().liveEntityCount + adding > maxEntities) {
      fail(
        403,
        'limit_exceeded',
        `数据条数已达上限 ${maxEntities}（含任务、清单、文件夹、标签）`,
        {limit: maxEntities},
      );
    }
  }

  /**
   * Applies server-side task rules: a time needs a date, recurrence rules are
   * normalized (and seed a missing due date), recurring tasks get a series id.
   */
  private applyTaskRules(
    task: StoredEntity,
    previous: StoredEntity | null,
    changedFields: string[],
    editedAt: number,
    now: number,
  ): StoredEntity {
    const fields = taskDataOf(task);
    const data: Record<string, unknown> = {...task.data};
    const clock = {...task.clock};
    const {timezone, weekStart} = this.requireAccount().settings;
    if (!fields.dueDate && fields.dueTime) {
      data.dueTime = null;
      clock.dueTime = editedAt;
    }
    if (changedFields.includes('recurrence') && fields.recurrence) {
      const today = localDate(now, timezone);
      const rule = normalizeRecurrence(
        fields.recurrence,
        fields.dueDate ?? today,
      );
      data.recurrence = rule;
      if (!fields.dueDate) {
        data.dueDate = firstOccurrenceOnOrAfter(rule, today, weekStart);
        clock.dueDate = editedAt;
      }
    }
    if (fields.recurrence && !fields.seriesId) {
      data.seriesId = previous
        ? (taskDataOf(previous).seriesId ?? task.id)
        : task.id;
    }
    return {...task, data, clock};
  }

  /**
   * Creates the next instance when a recurring task becomes completed. Its id
   * derives from the series and due date, so retries and concurrent devices
   * cannot create duplicates.
   */
  private async spawnNextOccurrence(
    task: StoredEntity,
    previous: StoredEntity,
    now: number,
  ): Promise<StoredEntity[]> {
    const fields = taskDataOf(task);
    const rule = fields.recurrence;
    const wasCompleted = taskDataOf(previous).completedAt !== null;
    if (!rule || wasCompleted || !fields.completedAt) return [];
    const {timezone, weekStart} = this.requireAccount().settings;
    const occurrence = nextOccurrence({
      rule,
      currentDue: fields.dueDate,
      completedOn: localDate(Date.parse(fields.completedAt), timezone),
      today: localDate(now, timezone),
      weekStart,
    });
    if (!occurrence) return [];
    const seriesId = fields.seriesId ?? task.id;
    const id = await nameBasedUuid(`${seriesId}|${occurrence.dueDate}`);
    if (
      await this.loadEntity(entityKey(this.requireAccount().userId, 'task', id))
    ) {
      return [];
    }
    await this.ensureEntityCapacity(1);
    const shiftDays = fields.dueDate
      ? diffDays(fields.dueDate, occurrence.dueDate)
      : 0;
    const reminders = fields.reminders.map(reminder => {
      const local = zonedParts(Date.parse(reminder.at), timezone);
      const shiftedDate = addDays(local.date, shiftDays);
      const at = zonedToInstant(shiftedDate, local.time, timezone);
      return {id: uuidV7(now), at: new Date(at).toISOString()};
    });
    const patch = {
      title: fields.title,
      notes: fields.notes,
      listId: fields.listId,
      tagIds: fields.tagIds,
      priority: fields.priority,
      quadrant: fields.quadrant,
      dueDate: occurrence.dueDate,
      dueTime: fields.dueTime,
      reminders,
      estimateMinutes: fields.estimateMinutes,
      energy: fields.energy,
      subtasks: fields.subtasks.map(subtask => ({
        ...subtask,
        completed: false,
      })),
      links: fields.links,
      recurrence: {...rule, count: occurrence.count},
      seriesId,
      sortOrder: fields.sortOrder,
    };
    const spawned = newEntity('task', id, patch, now, this.nextStamp());
    await this.persistEntity(spawned);
    this.setLiveEntityCount(this.requireAccount().liveEntityCount + 1);
    return [spawned];
  }

  /** Moves a restored task to the inbox if its list is gone. */
  private async detachFromDeletedList(
    task: StoredEntity,
    now: number,
  ): Promise<StoredEntity> {
    const listId = taskDataOf(task).listId;
    if (!listId) return task;
    const list = await this.loadEntity(
      entityKey(this.requireAccount().userId, 'list', listId),
    );
    if (list && !list.deletedAt) return task;
    return {
      ...task,
      data: {...task.data, listId: null},
      clock: {...task.clock, listId: now},
    };
  }

  private onDeleted(entity: StoredEntity): void {
    const now = Date.now();
    if (entity.kind === 'list') {
      const job: CascadeListJob = {listId: entity.id, op: 'delete'};
      this.enqueueJob('cascade_list', entity.id, job, now);
    }
  }

  private onRestored(entity: StoredEntity): void {
    if (entity.kind === 'list') {
      const job: CascadeListJob = {listId: entity.id, op: 'restore'};
      this.enqueueJob('cascade_list', entity.id, job, Date.now());
    }
  }

  /** Mirrors a task's upcoming reminders into the alarm-driven table. */
  private scheduleTaskReminders(task: StoredEntity, now: number): void {
    this.db.delete(reminders).where(eq(reminders.taskId, task.id)).run();
    const fields = taskDataOf(task);
    if (task.deletedAt || fields.completedAt) return;
    const payload: ReminderPayload = {
      title: fields.title,
      dueDate: fields.dueDate,
      dueTime: fields.dueTime,
    };
    for (const reminder of fields.reminders) {
      const fireAt = Date.parse(reminder.at);
      if (fireAt > now - REMINDER_PAST_TOLERANCE_MS) {
        this.db
          .insert(reminders)
          .values({
            taskId: task.id,
            reminderId: reminder.id,
            fireAt,
            payload,
          })
          .onConflictDoUpdate({
            target: [reminders.taskId, reminders.reminderId],
            set: {fireAt, payload},
          })
          .run();
      }
    }
  }

  private enqueueJob(
    type: JobType,
    ref: string,
    payload: CascadeListJob,
    runAt: number,
  ): void {
    this.db.insert(jobs).values({type, ref, payload, runAt}).run();
  }

  private cancelJob(type: JobType, ref: string): void {
    this.db
      .delete(jobs)
      .where(and(eq(jobs.type, type), eq(jobs.ref, ref)))
      .run();
  }

  private async rescheduleAlarm(): Promise<void> {
    const nextReminder = this.db
      .select({at: min(reminders.fireAt)})
      .from(reminders)
      .get()?.at;
    const nextJob = this.db
      .select({at: min(jobs.runAt)})
      .from(jobs)
      .get()?.at;
    const candidates = [nextReminder, nextJob].filter(
      (at): at is number => typeof at === 'number',
    );
    if (candidates.length === 0) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.min(...candidates);
    if ((await this.ctx.storage.getAlarm()) !== next) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  private async fireDueReminders(now: number): Promise<void> {
    const due = this.db
      .select()
      .from(reminders)
      .where(lte(reminders.fireAt, now + ALARM_EARLY_TOLERANCE_MS))
      .orderBy(sql`${reminders.fireAt} ASC`)
      .limit(REMINDERS_PER_ALARM)
      .all();
    if (due.length === 0) return;
    const subscriptions = this.db.select().from(pushSubscriptions).all();
    for (const reminder of due) {
      this.db
        .delete(reminders)
        .where(
          and(
            eq(reminders.taskId, reminder.taskId),
            eq(reminders.reminderId, reminder.reminderId),
          ),
        )
        .run();
      if (subscriptions.length === 0) continue;
      if (!this.tryConsumeQuota('pushes', subscriptions.length, now)) {
        console.warn(
          JSON.stringify({
            msg: 'push quota exhausted; reminder dropped',
            userId: this.accountState?.userId,
            taskId: reminder.taskId,
          }),
        );
        continue;
      }
      const message = JSON.stringify({
        type: 'reminder',
        taskId: reminder.taskId,
        reminderId: reminder.reminderId,
        ...reminder.payload,
        at: new Date(reminder.fireAt).toISOString(),
      });
      await this.pushToSubscriptions(subscriptions, message, reminder.taskId);
    }
  }

  private async pushToSubscriptions(
    subscriptions: PushSubscriptionRow[],
    message: string,
    topicSeed: string,
  ): Promise<PushDelivery[]> {
    const vapid: VapidConfig = {
      publicKey: this.env.VAPID_PUBLIC_KEY,
      privateKey: this.env.VAPID_PRIVATE_KEY,
      subject: this.env.VAPID_SUBJECT,
    };
    // A newer message with the same topic replaces an undelivered older one.
    const topic = (await sha256Base64Url(topicSeed)).slice(
      0,
      PUSH_TOPIC_LENGTH,
    );
    return Promise.all(
      subscriptions.map(subscription =>
        this.pushTo(subscription, message, vapid, topic),
      ),
    );
  }

  private async pushTo(
    subscription: PushSubscriptionRow,
    message: string,
    vapid: VapidConfig,
    topic: string,
  ): Promise<PushDelivery> {
    let result: SendResult;
    try {
      result = await sendWebPush(
        {
          endpoint: subscription.endpoint,
          keys: {p256dh: subscription.p256dh, auth: subscription.auth},
        },
        message,
        vapid,
        {ttl: PUSH_TTL_SECONDS, urgency: 'high', topic},
      );
    } catch (error: unknown) {
      console.warn(
        JSON.stringify({
          msg: 'web push failed',
          userId: this.accountState?.userId,
          error: String(error),
        }),
      );
      result = {ok: false, status: 0, gone: false};
    }
    if (result.gone) {
      this.db
        .delete(pushSubscriptions)
        .where(eq(pushSubscriptions.endpoint, subscription.endpoint))
        .run();
    }
    return {
      endpoint: new URL(subscription.endpoint).origin,
      status: result.status,
      ok: result.ok,
    };
  }

  private async runDueJobs(now: number): Promise<void> {
    const due = this.db
      .select()
      .from(jobs)
      .where(lte(jobs.runAt, now))
      .orderBy(sql`${jobs.id} ASC`)
      .limit(JOBS_PER_ALARM)
      .all();
    for (const job of due) {
      const outcome = await this.runJobSafely(job, now);
      if (outcome === 'done') {
        this.db.delete(jobs).where(eq(jobs.id, job.id)).run();
      } else {
        const runAt = outcome === 'more' ? Date.now() : outcome.retryAt;
        this.db.update(jobs).set({runAt}).where(eq(jobs.id, job.id)).run();
      }
    }
  }

  /** Runs a job; quota exhaustion waits for the reset, other errors a minute. */
  private async runJobSafely(job: JobRow, now: number): Promise<JobOutcome> {
    try {
      return await this.runJob(job);
    } catch (error: unknown) {
      if (
        error instanceof HubError &&
        error.payload.code === 'quota_exceeded'
      ) {
        return {retryAt: nextMidnightInstant(now, this.config.quotaTimeZone)};
      }
      console.error(
        JSON.stringify({
          msg: 'job failed',
          userId: this.accountState?.userId,
          job: job.type,
          error: String(error),
        }),
      );
      return {retryAt: now + JOB_RETRY_DELAY_MS};
    }
  }

  private async runJob(job: JobRow): Promise<JobOutcome> {
    switch (job.type) {
      case 'cascade_list': {
        const {listId, op} = job.payload as CascadeListJob;
        return this.cascadeListChange(listId, op);
      }
      default:
        return 'done';
    }
  }

  /** Moves a list's tasks into or out of the trash, one batch per alarm. */
  private async cascadeListChange(
    listId: string,
    op: 'delete' | 'restore',
  ): Promise<JobOutcome> {
    const state = this.requireAccount();
    const list = await this.loadEntity(entityKey(state.userId, 'list', listId));
    const listDeleted = !list || Boolean(list.deletedAt);
    // The list changed state again since this job was queued; the newer job wins.
    if ((op === 'delete') !== listDeleted) return 'done';
    const overlay = this.fullJournalOverlay();
    const rows = await scanMetadata(
      this.env.DATA,
      state.userId,
      'task',
      this.quotaCharger,
      overlay,
    );
    const candidates = [...rows.values()].filter(row => {
      const inTrash = Boolean(row.metadata.deletedAt);
      return (
        row.metadata.listId === listId && (op === 'delete' ? !inTrash : inTrash)
      );
    });
    const {entities} = await loadEntities(
      this.env.DATA,
      candidates.slice(0, CASCADE_BATCH_SIZE),
      this.quotaCharger,
      overlay,
    );
    const deletedVia = `list:${listId}`;
    for (const task of entities.values()) {
      if (op === 'delete') {
        if (task.deletedAt) continue;
        const deleted = this.withDeletion(task, deletedVia);
        await this.persistEntity(deleted);
        this.setLiveEntityCount(this.requireAccount().liveEntityCount - 1);
        this.onDeleted(deleted);
      } else {
        if (!task.deletedAt || task.deletedVia !== deletedVia) continue;
        const restored = this.withNewRevision({
          ...task,
          deletedAt: null,
          deletedVia: null,
        });
        await this.persistEntity(restored);
        this.setLiveEntityCount(this.requireAccount().liveEntityCount + 1);
        this.onRestored(restored);
      }
    }
    return candidates.length > CASCADE_BATCH_SIZE ? 'more' : 'done';
  }

  /** Drops expired journal rows, sessions, and old usage days, hourly. */
  private pruneExpiredState(now: number, force: boolean): void {
    const state = this.accountState;
    if (!state) return;
    if (!force && now - state.prunedAt < PRUNE_INTERVAL_MS) return;
    state.prunedAt = now;
    this.saveAccount();
    this.db
      .delete(journalEntries)
      .where(lt(journalEntries.writtenAt, now - JOURNAL_WINDOW_MS))
      .run();
    this.db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
    const oldestKeptDay = addDays(
      localDate(now, this.config.quotaTimeZone),
      -USAGE_HISTORY_DAYS,
    );
    this.db.delete(usageDays).where(lt(usageDays.day, oldestKeptDay)).run();
  }
}
