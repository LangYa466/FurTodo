import {DurableObject} from 'cloudflare:workers';
import {
  checkMembership,
  type GithubProfile,
  type MembershipSource,
  type OrgRole,
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
  TOMBSTONE_RETENTION_MS,
  TOMBSTONE_TTL_SECONDS,
  blobKey,
  entityKey,
  mergePatch,
  metadataFor,
  newEntity,
  parseJournalEntry,
  settingsFrom,
  taskDataOf,
  toApiEntity,
  type ApiEntity,
  type AttachmentInfo,
  type BlobMetadata,
  type EntityMetadata,
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
import type {
  AccountView,
  AttachmentInput,
  AttachmentResult,
  BeginReadOptions,
  BeginReadResult,
  JournalRequest,
  MutationOutcome,
  PendingSessionInput,
  PullPlan,
  PushDelivery,
  PushSubscriptionInput,
  ReadQuotaGrant,
  SessionKind,
  SessionView,
  TestPushResult,
  TopUpResult,
  UsageView,
  ValidatedMutation,
} from './types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

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
const MAX_ATTACHMENTS_PER_TASK = 20;
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

// JSON columns and state values are written only by this class, so reads cast
// them back to their known types.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT, status TEXT NOT NULL,
  code_challenge TEXT, redirect_uri TEXT, user_agent TEXT,
  created_at INTEGER NOT NULL, last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, counts TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS journal (
  key TEXT PRIMARY KEY, updated_at INTEGER NOT NULL, metadata TEXT NOT NULL,
  body TEXT NOT NULL, written_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS journal_updated_at ON journal(updated_at);
CREATE INDEX IF NOT EXISTS journal_written_at ON journal(written_at);
CREATE TABLE IF NOT EXISTS reminders (
  task_id TEXT NOT NULL, reminder_id TEXT NOT NULL, fire_at INTEGER NOT NULL,
  payload TEXT NOT NULL, PRIMARY KEY (task_id, reminder_id));
CREATE INDEX IF NOT EXISTS reminders_fire_at ON reminders(fire_at);
CREATE TABLE IF NOT EXISTS push_subscriptions (
  endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL,
  device TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, ref TEXT NOT NULL,
  payload TEXT NOT NULL, run_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS jobs_run_at ON jobs(run_at);
`;

// Row types are aliases rather than interfaces: sql.exec<T> requires index
// signatures, which interfaces lack.
type SessionRow = {
  id: string;
  kind: SessionKind;
  name: string | null;
  status: 'pending' | 'active';
  code_challenge: string | null;
  redirect_uri: string | null;
  user_agent: string | null;
  created_at: number;
  last_used_at: number;
  expires_at: number;
};
type JournalRow = {key: string; metadata: string; body: string};
type ReminderRow = {
  task_id: string;
  reminder_id: string;
  fire_at: number;
  payload: string;
};
type PushSubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
  device: string | null;
  created_at: number;
};
type JobRow = {
  id: number;
  type: string;
  ref: string;
  payload: string;
  run_at: number;
};

type StringStateKey =
  | 'user_id'
  | 'github_token'
  | 'membership_verified_at'
  | 'committed_stamp'
  | 'live_entity_count'
  | 'used_storage_bytes'
  | 'pruned_at';

interface StoredMembership {
  role: OrgRole;
  via: MembershipSource;
}

interface JsonState {
  profile: GithubProfile;
  orgs: OrgSummary[];
  membership: StoredMembership;
  settings: Settings;
}

interface UsageDay {
  day: string;
  counts: QuotaCounts;
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

interface ReminderPayload {
  title: string;
  dueDate: string | null;
  dueTime: string | null;
}

type JobType = 'cascade_list' | 'purge_blobs';
/** `more` reruns the job right away; `retryAt` reschedules it. */
type JobOutcome = 'done' | 'more' | {retryAt: number};

interface CascadeListJob {
  listId: string;
  op: 'delete' | 'restore';
}

interface PurgeBlobsJob {
  taskId: string;
  blobs: Array<{id: string; size: number}>;
}

const ZERO_COUNTS: QuotaCounts = {
  requests: 0,
  reads: 0,
  writes: 0,
  lists: 0,
  uploadBytes: 0,
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
    userAgent: row.user_agent,
    createdAt: new Date(row.created_at).toISOString(),
    lastUsedAt: new Date(row.last_used_at).toISOString(),
    expiresAt: new Date(row.expires_at).toISOString(),
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
 */
export class UserHub extends DurableObject<Env> {
  private readonly sql: SqlStorage;
  private readonly config: AppConfig;
  private storedUserId: string | null;
  /** Highest stamp handed out; its write may still be in flight. */
  private issuedStamp: number;
  /** Highest stamp persisted to KV and the journal; readers stop here. */
  private committedStamp: number;
  private liveEntityCount: number;
  private usedStorageBytes: number;
  private settings: Settings;
  private usageCache: UsageDay | null = null;
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
    this.sql = ctx.storage.sql;
    this.config = readConfig(env);
    this.sql.exec(SCHEMA);
    this.storedUserId = this.getState('user_id');
    this.committedStamp = Number(this.getState('committed_stamp') ?? 0);
    this.issuedStamp = this.committedStamp;
    this.liveEntityCount = Number(this.getState('live_entity_count') ?? 0);
    this.usedStorageBytes = Number(this.getState('used_storage_bytes') ?? 0);
    this.settings = this.getJsonState('settings') ?? settingsFrom(null);
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
      if (this.storedUserId && this.storedUserId !== input.userId) {
        fail(500, 'internal_error', 'Durable Object 與使用者不符');
      }
      this.consumeQuota('logins', 1, now);
      this.storedUserId = input.userId;
      this.setState('user_id', input.userId);
      this.setJsonState('profile', input.profile);
      this.setJsonState('orgs', input.orgs);
      this.setJsonState('membership', input.membership);
      this.setState('membership_verified_at', String(now));
      this.setState(
        'github_token',
        await sealJson(this.env.TOKEN_SECRET, 'ghtoken-aes', input.githubToken),
      );
      this.pruneExpiredState(now, /* force= */ true);
      this.evictOldestSessions();
      const sessionId = randomBase64Url(SESSION_ID_BYTES);
      this.sql.exec(
        "INSERT INTO sessions (id, kind, name, status, code_challenge, redirect_uri, user_agent, created_at, last_used_at, expires_at) VALUES (?, 'oauth', NULL, 'pending', ?, ?, ?, ?, ?, ?)",
        sessionId,
        input.codeChallenge,
        input.redirectUri,
        input.userAgent,
        now,
        now,
        now + LOGIN_CODE_TTL_MS,
      );
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
        fail(400, 'bad_request', '登入碼無效或已使用', invalidGrant);
      }
      if (session.expires_at <= now) {
        this.deleteSession(sessionId);
        fail(400, 'bad_request', '登入碼已過期，請重新登入', invalidGrant);
      }
      if (session.redirect_uri !== redirectUri) {
        fail(400, 'bad_request', 'redirect_uri 與授權時不同', invalidGrant);
      }
      if ((await sha256Base64Url(codeVerifier)) !== session.code_challenge) {
        fail(400, 'bad_request', 'code_verifier 不符', invalidGrant);
      }
      this.sql.exec(
        "UPDATE sessions SET status = 'active', code_challenge = NULL, last_used_at = ?, expires_at = ?, user_agent = COALESCE(?, user_agent) WHERE id = ?",
        now,
        now + SESSION_TTL_MS,
        userAgent,
        sessionId,
      );
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
        code_challenge: null,
        redirect_uri: null,
        user_agent: null,
        created_at: now,
        last_used_at: now,
        expires_at: now + expiresInDays * DAY_MS,
      };
      this.sql.exec(
        "INSERT INTO sessions (id, kind, name, status, code_challenge, redirect_uri, user_agent, created_at, last_used_at, expires_at) VALUES (?, 'pat', ?, 'active', NULL, NULL, NULL, ?, ?, ?)",
        token.id,
        token.name,
        token.created_at,
        token.last_used_at,
        token.expires_at,
      );
      return toSessionView(token, sessionId);
    });
  }

  async listSessions(sessionId: string): Promise<HubResult<SessionView[]>> {
    return this.asResult(async () => {
      await this.authorize(sessionId, Date.now());
      return this.sql
        .exec<SessionRow>(
          "SELECT * FROM sessions WHERE status = 'active' ORDER BY last_used_at DESC",
        )
        .toArray()
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
        totals: {
          entities: this.liveEntityCount,
          storageBytes: this.usedStorageBytes,
        },
        totalLimits: {
          entities: maxEntities,
          storageBytes: this.config.maxStorageBytes,
          fileBytes: this.config.maxFileBytes,
        },
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
      const usage = this.usageOn(now);
      const grant: ReadQuotaGrant = {
        reads: this.reserveQuota('reads', options.reserveReads ?? 0, now),
        lists: this.reserveQuota('lists', options.reserveLists ?? 0, now),
      };
      const {journal, pullPlan} = this.selectJournal(options.journal, now);
      return {
        userId: this.requireUserId(),
        day: usage.day,
        grant,
        journal,
        committedStamp: this.committedStamp,
        settings: this.settings,
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
      session.expires_at > now &&
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

  /** Charges a signed attachment download, which carries no session. */
  async chargeSignedFileRead(): Promise<HubResult<null>> {
    return this.asResult(async () => {
      const now = Date.now();
      if (!this.storedUserId) fail(404, 'not_found', '找不到附件');
      this.consumeQuota('requests', 1, now);
      this.consumeQuota('reads', 1, now);
      return null;
    });
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

  async addAttachment(
    sessionId: string,
    taskId: string,
    file: AttachmentInput,
  ): Promise<HubResult<AttachmentResult>> {
    return this.asResult(async () => {
      const now = Date.now();
      await this.authorize(sessionId, now);
      return this.serialized(async () => {
        const size = file.bytes.byteLength;
        const {maxFileBytes, maxStorageBytes} = this.config;
        if (size === 0) fail(400, 'bad_request', '檔案是空的');
        if (size > maxFileBytes) {
          fail(413, 'payload_too_large', `單檔上限 ${maxFileBytes} bytes`, {
            limit: maxFileBytes,
          });
        }
        if (this.usedStorageBytes + size > maxStorageBytes) {
          fail(403, 'limit_exceeded', '附件總容量已滿', {
            limit: maxStorageBytes,
            used: this.usedStorageBytes,
          });
        }
        const userId = this.requireUserId();
        const task = await this.loadEntity(entityKey(userId, 'task', taskId));
        if (!task || task.deletedAt) fail(404, 'not_found', '任務不存在');
        const attachments = taskDataOf(task).attachments;
        if (attachments.length >= MAX_ATTACHMENTS_PER_TASK) {
          fail(
            409,
            'limit_exceeded',
            `每個任務最多 ${MAX_ATTACHMENTS_PER_TASK} 個附件`,
          );
        }
        this.consumeQuota('uploadBytes', size, now);
        this.consumeQuota('writes', 1, now);
        const attachment: AttachmentInfo = {
          id: uuidV7(now),
          name: file.name,
          size,
          contentType: file.contentType,
          createdAt: new Date(now).toISOString(),
        };
        const metadata: BlobMetadata = {
          taskId,
          name: encodeURIComponent(file.name),
          contentType: file.contentType,
          size,
        };
        await this.putWithRetry(blobKey(userId, attachment.id), file.bytes, {
          metadata,
        });
        this.setUsedStorageBytes(this.usedStorageBytes + size);
        const updated = this.withNewRevision({
          ...task,
          data: {...task.data, attachments: [...attachments, attachment]},
          clock: {...task.clock, attachments: now},
        });
        await this.persistEntity(updated);
        return {attachment, task: this.toApi(updated)};
      });
    });
  }

  async removeAttachment(
    sessionId: string,
    taskId: string,
    attachmentId: string,
  ): Promise<HubResult<{task: ApiEntity}>> {
    return this.asResult(async () => {
      const now = Date.now();
      await this.authorize(sessionId, now);
      return this.serialized(async () => {
        const task = await this.loadEntity(
          entityKey(this.requireUserId(), 'task', taskId),
        );
        if (!task) fail(404, 'not_found', '任務不存在');
        const attachments = taskDataOf(task).attachments;
        const target = attachments.find(({id}) => id === attachmentId);
        if (!target) fail(404, 'not_found', '附件不存在');
        const updated = this.withNewRevision({
          ...task,
          data: {
            ...task.data,
            attachments: attachments.filter(({id}) => id !== attachmentId),
          },
          clock: {...task.clock, attachments: now},
        });
        await this.persistEntity(updated);
        await this.deleteBlob(target.id, target.size);
        return {task: this.toApi(updated)};
      });
    });
  }

  async addPushSubscription(
    sessionId: string,
    subscription: PushSubscriptionInput,
  ): Promise<HubResult<{subscriptions: number}>> {
    return this.asResult(async () => {
      await this.authorize(sessionId, Date.now());
      const exists =
        this.sql
          .exec(
            'SELECT 1 FROM push_subscriptions WHERE endpoint = ?',
            subscription.endpoint,
          )
          .toArray().length > 0;
      const count = this.sql
        .exec<{count: number}>(
          'SELECT COUNT(*) AS count FROM push_subscriptions',
        )
        .one().count;
      if (!exists && count >= MAX_PUSH_SUBSCRIPTIONS) {
        fail(
          409,
          'limit_exceeded',
          `最多 ${MAX_PUSH_SUBSCRIPTIONS} 個推播訂閱`,
        );
      }
      this.sql.exec(
        'INSERT INTO push_subscriptions (endpoint, p256dh, auth, device, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, device = excluded.device',
        subscription.endpoint,
        subscription.keys.p256dh,
        subscription.keys.auth,
        subscription.device,
        Date.now(),
      );
      return {subscriptions: exists ? count : count + 1};
    });
  }

  async removePushSubscription(
    sessionId: string,
    endpoint: string,
  ): Promise<HubResult<{removed: boolean}>> {
    return this.asResult(async () => {
      await this.authorize(sessionId, Date.now());
      const deleted = this.sql.exec(
        'DELETE FROM push_subscriptions WHERE endpoint = ?',
        endpoint,
      );
      return {removed: deleted.rowsWritten > 0};
    });
  }

  async sendTestPush(sessionId: string): Promise<HubResult<TestPushResult>> {
    return this.asResult(async () => {
      const now = Date.now();
      await this.authorize(sessionId, now);
      const subscriptions = this.sql
        .exec<PushSubscriptionRow>('SELECT * FROM push_subscriptions')
        .toArray();
      if (subscriptions.length === 0) fail(404, 'not_found', '沒有推播訂閱');
      this.consumeQuota('pushes', subscriptions.length, now);
      const message = JSON.stringify({
        type: 'test',
        title: 'FurTodo',
        body: '推播測試成功 🎉',
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

  private requireUserId(): string {
    if (this.storedUserId === null) {
      throw new Error('UserHub used before its first login');
    }
    return this.storedUserId;
  }

  /**
   * Checks that the session is active, rechecks org membership when due,
   * charges one request, and slides the session expiry at most hourly.
   */
  private async authorize(sessionId: string, now: number): Promise<void> {
    const session = this.findSession(sessionId);
    if (!session || session.status !== 'active') {
      fail(401, 'invalid_token', 'Session 不存在或已登出');
    }
    if (session.expires_at <= now) {
      this.deleteSession(sessionId);
      fail(401, 'session_expired', 'Session 已過期，請重新登入');
    }
    await this.ensureMembership(now);
    this.consumeQuota('requests', 1, now);
    if (now - session.last_used_at > SESSION_TOUCH_MS) {
      // Personal tokens keep their fixed expiry; login sessions slide.
      const expiresAt =
        session.kind === 'oauth' ? now + SESSION_TTL_MS : session.expires_at;
      this.sql.exec(
        'UPDATE sessions SET last_used_at = ?, expires_at = ? WHERE id = ?',
        now,
        expiresAt,
        sessionId,
      );
    }
  }

  /**
   * Rechecks org membership every 6 hours. Revoked members lose every
   * session; while GitHub is unreachable, requests continue for a grace period.
   */
  private async ensureMembership(now: number): Promise<void> {
    const verifiedAt = Number(this.getState('membership_verified_at') ?? 0);
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
          `你已不是 ${org} 組織成員，或已撤銷 GitHub 授權；請重新登入`,
        );
      case 'restricted':
        return fail(
          403,
          'org_access_restricted',
          `${org} 啟用了 OAuth App 存取限制，請組織 owner 核准本應用`,
        );
      default:
        if (now - verifiedAt > MEMBERSHIP_GRACE_MS) {
          fail(503, 'github_unavailable', '暫時無法向 GitHub 驗證組織成員身分');
        }
    }
  }

  private async recheckMembership(): Promise<MembershipCheck> {
    const sealedToken = this.getState('github_token');
    const profile = this.getJsonState('profile');
    const token = sealedToken
      ? await openJson<string>(
          this.env.TOKEN_SECRET,
          'ghtoken-aes',
          sealedToken,
        )
      : null;
    if (!token || !profile) {
      this.revokeAllSessions();
      return 'revoked';
    }
    const result = await checkMembership(
      this.config,
      token,
      profile.login,
      this.env.GITHUB_ORG_TOKEN,
    );
    switch (result.status) {
      case 'active':
        this.setState('membership_verified_at', String(Date.now()));
        this.setJsonState('membership', {role: result.role, via: result.via});
        return 'ok';
      case 'restricted':
        return 'restricted';
      case 'unavailable':
        console.warn(
          JSON.stringify({
            msg: 'membership recheck unavailable',
            userId: this.storedUserId,
            detail: result.detail,
          }),
        );
        return 'unavailable';
      default:
        console.log(
          JSON.stringify({
            msg: 'membership revoked',
            userId: this.storedUserId,
            status: result.status,
          }),
        );
        this.revokeAllSessions();
        return 'revoked';
    }
  }

  private revokeAllSessions(): void {
    this.sql.exec('DELETE FROM sessions');
    this.sql.exec("DELETE FROM state WHERE key = 'github_token'");
  }

  private usageOn(now: number): UsageDay {
    const day = localDate(now, this.config.quotaTimeZone);
    if (this.usageCache?.day !== day) {
      const [row] = this.sql
        .exec<{counts: string}>('SELECT counts FROM usage WHERE day = ?', day)
        .toArray();
      const stored = row
        ? (JSON.parse(row.counts) as Partial<QuotaCounts>)
        : {};
      this.usageCache = {day, counts: {...ZERO_COUNTS, ...stored}};
    }
    return this.usageCache;
  }

  private persistUsage(): void {
    if (!this.usageCache) return;
    this.sql.exec(
      'INSERT INTO usage (day, counts) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET counts = excluded.counts',
      this.usageCache.day,
      JSON.stringify(this.usageCache.counts),
    );
  }

  private quotaExceeded(kind: QuotaKind, now: number): ErrorPayload {
    const limit = this.config.dailyQuota[kind];
    const resetAt = nextMidnightInstant(now, this.config.quotaTimeZone);
    return {
      status: 429,
      code: 'quota_exceeded',
      message: `今日 ${kind} 配額已用完（每日上限 ${limit}）`,
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

  private getState(key: StringStateKey | keyof JsonState): string | null {
    const [row] = this.sql
      .exec<{value: string}>('SELECT value FROM state WHERE key = ?', key)
      .toArray();
    return row?.value ?? null;
  }

  private setState(key: StringStateKey, value: string): void {
    this.sql.exec(
      'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      value,
    );
  }

  private getJsonState<K extends keyof JsonState>(key: K): JsonState[K] | null {
    const value = this.getState(key);
    return value ? (JSON.parse(value) as JsonState[K]) : null;
  }

  private setJsonState<K extends keyof JsonState>(
    key: K,
    value: JsonState[K],
  ): void {
    this.sql.exec(
      'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      key,
      JSON.stringify(value),
    );
  }

  private findSession(sessionId: string): SessionRow | null {
    const [row] = this.sql
      .exec<SessionRow>('SELECT * FROM sessions WHERE id = ?', sessionId)
      .toArray();
    return row ?? null;
  }

  /** Deletes a session; returns whether it existed. */
  private deleteSession(sessionId: string): boolean {
    return (
      this.sql.exec('DELETE FROM sessions WHERE id = ?', sessionId)
        .rowsWritten > 0
    );
  }

  private accountView(sessionId: string): AccountView {
    const profile = this.getJsonState('profile');
    const session = this.findSession(sessionId);
    if (!profile || !session) throw new Error('Account state is incomplete');
    const membership = this.getJsonState('membership') ?? {
      role: 'member',
      via: 'user_token',
    };
    const verifiedAt = Number(this.getState('membership_verified_at') ?? 0);
    const settingsEntity = this.entityCache.get(
      entityKey(this.requireUserId(), 'settings', SETTINGS_ID),
    );
    return {
      user: profile,
      membership: {
        org: this.config.githubOrg,
        ...membership,
        verifiedAt: new Date(verifiedAt).toISOString(),
      },
      orgs: this.getJsonState('orgs') ?? [],
      session: toSessionView(session, sessionId),
      settings: settingsEntity
        ? this.toApi(settingsEntity)
        : unsavedSettingsEntity(this.settings),
    };
  }

  /** Makes room for one more session by dropping least recently used logins. */
  private evictOldestSessions(): void {
    const count = this.sql
      .exec<{count: number}>('SELECT COUNT(*) AS count FROM sessions')
      .one().count;
    if (count < MAX_SESSIONS) return;
    this.sql.exec(
      "DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE kind = 'oauth' ORDER BY last_used_at ASC LIMIT ?)",
      count - MAX_SESSIONS + 1,
    );
  }

  private setUsedStorageBytes(bytes: number): void {
    this.usedStorageBytes = Math.max(0, bytes);
    this.setState('used_storage_bytes', String(this.usedStorageBytes));
  }

  private setLiveEntityCount(count: number): void {
    this.liveEntityCount = Math.max(0, count);
    this.setState('live_entity_count', String(this.liveEntityCount));
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
    return toApiEntity(entity, this.settings.timezone);
  }

  private selectJournal(
    request: JournalRequest,
    now: number,
  ): JournalSelection {
    const recent = () =>
      this.queryRawJournal(
        'SELECT key, metadata, body FROM journal WHERE written_at > ?',
        now - SCAN_OVERLAY_MS,
      );
    switch (request.mode) {
      case 'scan':
        return {journal: recent(), pullPlan: null};
      case 'keys':
        return {journal: this.rawJournalForKeys(request.keys), pullPlan: null};
      case 'pull':
        if (request.since >= this.committedStamp) {
          return {journal: [], pullPlan: 'upToDate'};
        }
        if (
          request.since > 0 &&
          request.since >= now - JOURNAL_WINDOW_MS + PULL_FAST_PATH_MARGIN_MS
        ) {
          const changed = this.queryRawJournal(
            'SELECT key, metadata, body FROM journal WHERE updated_at > ? ORDER BY updated_at',
            request.since,
          );
          return {journal: changed, pullPlan: 'journal'};
        }
        return {journal: recent(), pullPlan: 'scan'};
      default:
        return {journal: [], pullPlan: null};
    }
  }

  private queryRawJournal(
    query: string,
    ...bindings: Array<string | number>
  ): RawJournalEntry[] {
    return this.sql
      .exec<JournalRow>(query, ...bindings)
      .toArray()
      .map(row => ({
        key: row.key,
        metadata: JSON.parse(row.metadata) as EntityMetadata,
        body: row.body,
      }));
  }

  private rawJournalForKeys(keys: string[]): RawJournalEntry[] {
    const entries: RawJournalEntry[] = [];
    for (let i = 0; i < keys.length; i += SQL_MAX_PARAMS) {
      const chunk = keys.slice(i, i + SQL_MAX_PARAMS);
      const placeholders = chunk.map(() => '?').join(',');
      entries.push(
        ...this.queryRawJournal(
          `SELECT key, metadata, body FROM journal WHERE key IN (${placeholders})`,
          ...chunk,
        ),
      );
    }
    return entries;
  }

  private journalForKeys(keys: string[]): JournalEntry[] {
    return this.rawJournalForKeys(keys).map(entry => parseJournalEntry(entry));
  }

  private fullJournalOverlay(): Map<string, JournalEntry> {
    const entries = this.queryRawJournal(
      'SELECT key, metadata, body FROM journal',
    ).map(entry => parseJournalEntry(entry));
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
        '同一筆資料寫入太頻繁，請稍後重試（客戶端請對編輯做 debounce）',
      );
    }
  }

  /** Writes an entity to KV and the journal, then updates derived state. */
  private async persistEntity(entity: StoredEntity): Promise<void> {
    const now = Date.now();
    this.consumeQuota('writes', 1, now);
    const key = entityKey(this.requireUserId(), entity.kind, entity.id);
    const metadata = metadataFor(entity);
    const body = JSON.stringify(entity);
    await this.putWithRetry(
      key,
      body,
      entity.deletedAt
        ? {metadata, expirationTtl: TOMBSTONE_TTL_SECONDS}
        : {metadata},
    );
    this.sql.exec(
      'INSERT INTO journal (key, updated_at, metadata, body, written_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET updated_at = excluded.updated_at, metadata = excluded.metadata, body = excluded.body, written_at = excluded.written_at',
      key,
      entity.updatedAt,
      JSON.stringify(metadata),
      body,
      now,
    );
    if (entity.updatedAt > this.committedStamp) {
      this.committedStamp = entity.updatedAt;
      this.setState('committed_stamp', String(entity.updatedAt));
    }
    this.cacheEntity(key, entity);
    if (entity.kind === 'settings') {
      this.settings = settingsFrom(entity);
      this.setJsonState('settings', this.settings);
    }
    if (entity.kind === 'task') this.scheduleTaskReminders(entity, now);
  }

  private async deleteBlob(attachmentId: string, size: number): Promise<void> {
    this.consumeQuota('writes', 1, Date.now());
    await this.env.DATA.delete(blobKey(this.requireUserId(), attachmentId));
    this.setUsedStorageBytes(this.usedStorageBytes - size);
  }

  /** Applies mutations in order; one rejection does not stop the rest. */
  private async applyMutationBatch(
    mutations: ValidatedMutation[],
  ): Promise<MutationOutcome[]> {
    const userId = this.requireUserId();
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
      fail(400, 'validation_error', `settings 的 id 固定為 "${SETTINGS_ID}"`);
    }
    const now = Date.now();
    const current = await this.loadEntity(
      entityKey(this.requireUserId(), mutation.type, mutation.id),
    );
    switch (mutation.op) {
      case 'upsert':
        return this.applyUpsert(mutation, current, now);
      case 'delete':
        return this.applyDelete(mutation, current);
      case 'restore':
        return this.applyRestore(current, now);
      default:
        return fail(400, 'validation_error', '不支援的 op');
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
      if (mutation.mustExist) fail(404, 'not_found', '實體不存在');
      const missing = REQUIRED_ON_CREATE[mutation.type].filter(
        field => patch[field] === undefined,
      );
      if (missing.length > 0) {
        fail(
          404,
          'not_found',
          `實體不存在；建立時必須提供 ${missing.join(', ')}`,
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
      this.setLiveEntityCount(this.liveEntityCount + 1);
      return {status: 'applied', entity: created, spawned: []};
    }
    if (current.deletedAt) {
      fail(409, 'deleted', '實體已在垃圾桶；請先 restore 再修改');
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
      fail(400, 'validation_error', 'settings 不能刪除');
    }
    if (!current || current.deletedAt) {
      return {status: 'noop', entity: current, spawned: []};
    }
    const deleted = this.withDeletion(current, null);
    await this.persistEntity(deleted);
    this.setLiveEntityCount(this.liveEntityCount - 1);
    this.onDeleted(deleted);
    return {status: 'applied', entity: deleted, spawned: []};
  }

  private async applyRestore(
    current: StoredEntity | null,
    now: number,
  ): Promise<MutationEffect> {
    if (!current) {
      fail(404, 'not_found', '實體不存在（可能已超過 30 天被永久刪除）');
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
    this.setLiveEntityCount(this.liveEntityCount + 1);
    this.onRestored(restored);
    return {status: 'applied', entity: restored, spawned: []};
  }

  private async ensureEntityCapacity(adding: number): Promise<void> {
    const {maxEntities} = this.config;
    if (this.liveEntityCount + adding <= maxEntities) return;
    // The counter drifts upward when a write fails midway; recount first.
    const rows = await scanMetadata(
      this.env.DATA,
      this.requireUserId(),
      null,
      this.quotaCharger,
      this.fullJournalOverlay(),
    );
    const live = [...rows.values()].filter(row => !row.metadata.deletedAt);
    this.setLiveEntityCount(live.length);
    if (this.liveEntityCount + adding > maxEntities) {
      fail(
        403,
        'limit_exceeded',
        `資料筆數已達上限 ${maxEntities}（含任務、清單、資料夾、標籤）`,
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
    const {timezone, weekStart} = this.settings;
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
    const {timezone, weekStart} = this.settings;
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
    if (await this.loadEntity(entityKey(this.requireUserId(), 'task', id))) {
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
    this.setLiveEntityCount(this.liveEntityCount + 1);
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
      entityKey(this.requireUserId(), 'list', listId),
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
    if (entity.kind === 'task') {
      const blobs = taskDataOf(entity).attachments.map(({id, size}) => ({
        id,
        size,
      }));
      if (blobs.length > 0) {
        const job: PurgeBlobsJob = {taskId: entity.id, blobs};
        // Blobs outlive the task for the trash period so restores keep them.
        this.enqueueJob(
          'purge_blobs',
          entity.id,
          job,
          now + TOMBSTONE_RETENTION_MS,
        );
      }
    }
  }

  private onRestored(entity: StoredEntity): void {
    if (entity.kind === 'list') {
      const job: CascadeListJob = {listId: entity.id, op: 'restore'};
      this.enqueueJob('cascade_list', entity.id, job, Date.now());
    }
    if (entity.kind === 'task') {
      this.sql.exec(
        "DELETE FROM jobs WHERE type = 'purge_blobs' AND ref = ?",
        entity.id,
      );
    }
  }

  /** Mirrors a task's upcoming reminders into the alarm-driven table. */
  private scheduleTaskReminders(task: StoredEntity, now: number): void {
    this.sql.exec('DELETE FROM reminders WHERE task_id = ?', task.id);
    const fields = taskDataOf(task);
    if (task.deletedAt || fields.completedAt) return;
    const reminderPayload: ReminderPayload = {
      title: fields.title,
      dueDate: fields.dueDate,
      dueTime: fields.dueTime,
    };
    const payload = JSON.stringify(reminderPayload);
    for (const reminder of fields.reminders) {
      const fireAt = Date.parse(reminder.at);
      if (fireAt > now - REMINDER_PAST_TOLERANCE_MS) {
        this.sql.exec(
          'INSERT OR REPLACE INTO reminders (task_id, reminder_id, fire_at, payload) VALUES (?, ?, ?, ?)',
          task.id,
          reminder.id,
          fireAt,
          payload,
        );
      }
    }
  }

  private enqueueJob(
    type: JobType,
    ref: string,
    payload: CascadeListJob | PurgeBlobsJob,
    runAt: number,
  ): void {
    this.sql.exec(
      'INSERT INTO jobs (type, ref, payload, run_at) VALUES (?, ?, ?, ?)',
      type,
      ref,
      JSON.stringify(payload),
      runAt,
    );
  }

  private async rescheduleAlarm(): Promise<void> {
    const nextReminderAt = this.sql
      .exec<{at: number | null}>('SELECT MIN(fire_at) AS at FROM reminders')
      .one().at;
    const nextJobAt = this.sql
      .exec<{at: number | null}>('SELECT MIN(run_at) AS at FROM jobs')
      .one().at;
    const candidates = [nextReminderAt, nextJobAt].filter(
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
    const due = this.sql
      .exec<ReminderRow>(
        'SELECT * FROM reminders WHERE fire_at <= ? ORDER BY fire_at LIMIT ?',
        now + ALARM_EARLY_TOLERANCE_MS,
        REMINDERS_PER_ALARM,
      )
      .toArray();
    if (due.length === 0) return;
    const subscriptions = this.sql
      .exec<PushSubscriptionRow>('SELECT * FROM push_subscriptions')
      .toArray();
    for (const reminder of due) {
      this.sql.exec(
        'DELETE FROM reminders WHERE task_id = ? AND reminder_id = ?',
        reminder.task_id,
        reminder.reminder_id,
      );
      if (subscriptions.length === 0) continue;
      if (!this.tryConsumeQuota('pushes', subscriptions.length, now)) {
        console.warn(
          JSON.stringify({
            msg: 'push quota exhausted; reminder dropped',
            userId: this.storedUserId,
            taskId: reminder.task_id,
          }),
        );
        continue;
      }
      const details = JSON.parse(reminder.payload) as ReminderPayload;
      const message = JSON.stringify({
        type: 'reminder',
        taskId: reminder.task_id,
        reminderId: reminder.reminder_id,
        ...details,
        at: new Date(reminder.fire_at).toISOString(),
      });
      await this.pushToSubscriptions(subscriptions, message, reminder.task_id);
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
          userId: this.storedUserId,
          error: String(error),
        }),
      );
      result = {ok: false, status: 0, gone: false};
    }
    if (result.gone) {
      this.sql.exec(
        'DELETE FROM push_subscriptions WHERE endpoint = ?',
        subscription.endpoint,
      );
    }
    return {
      endpoint: new URL(subscription.endpoint).origin,
      status: result.status,
      ok: result.ok,
    };
  }

  private async runDueJobs(now: number): Promise<void> {
    const jobs = this.sql
      .exec<JobRow>(
        'SELECT * FROM jobs WHERE run_at <= ? ORDER BY id LIMIT ?',
        now,
        JOBS_PER_ALARM,
      )
      .toArray();
    for (const job of jobs) {
      const outcome = await this.runJobSafely(job, now);
      if (outcome === 'done') {
        this.sql.exec('DELETE FROM jobs WHERE id = ?', job.id);
      } else {
        const runAt = outcome === 'more' ? Date.now() : outcome.retryAt;
        this.sql.exec('UPDATE jobs SET run_at = ? WHERE id = ?', runAt, job.id);
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
          userId: this.storedUserId,
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
        const {listId, op} = JSON.parse(job.payload) as CascadeListJob;
        return this.cascadeListChange(listId, op);
      }
      case 'purge_blobs': {
        const {taskId, blobs} = JSON.parse(job.payload) as PurgeBlobsJob;
        const task = await this.loadEntity(
          entityKey(this.requireUserId(), 'task', taskId),
        );
        if (task && !task.deletedAt) return 'done';
        for (const blob of blobs) {
          await this.deleteBlob(blob.id, blob.size);
        }
        return 'done';
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
    const userId = this.requireUserId();
    const list = await this.loadEntity(entityKey(userId, 'list', listId));
    const listDeleted = !list || Boolean(list.deletedAt);
    // The list changed state again since this job was queued; the newer job wins.
    if ((op === 'delete') !== listDeleted) return 'done';
    const overlay = this.fullJournalOverlay();
    const rows = await scanMetadata(
      this.env.DATA,
      userId,
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
        this.setLiveEntityCount(this.liveEntityCount - 1);
        this.onDeleted(deleted);
      } else {
        if (!task.deletedAt || task.deletedVia !== deletedVia) continue;
        const restored = this.withNewRevision({
          ...task,
          deletedAt: null,
          deletedVia: null,
        });
        await this.persistEntity(restored);
        this.setLiveEntityCount(this.liveEntityCount + 1);
        this.onRestored(restored);
      }
    }
    return candidates.length > CASCADE_BATCH_SIZE ? 'more' : 'done';
  }

  /** Drops expired journal rows, sessions, and old usage days, hourly. */
  private pruneExpiredState(now: number, force: boolean): void {
    const prunedAt = Number(this.getState('pruned_at') ?? 0);
    if (!force && now - prunedAt < PRUNE_INTERVAL_MS) return;
    this.setState('pruned_at', String(now));
    this.sql.exec(
      'DELETE FROM journal WHERE written_at < ?',
      now - JOURNAL_WINDOW_MS,
    );
    this.sql.exec('DELETE FROM sessions WHERE expires_at < ?', now);
    const oldestKeptDay = addDays(
      localDate(now, this.config.quotaTimeZone),
      -USAGE_HISTORY_DAYS,
    );
    this.sql.exec('DELETE FROM usage WHERE day < ?', oldestKeptDay);
  }
}
