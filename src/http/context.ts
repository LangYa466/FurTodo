import type {Context, MiddlewareHandler} from 'hono';
import {readConfig, type AppConfig} from '../config';
import {
  parseJournalEntry,
  type JournalEntry,
  type Kind,
  type Settings,
} from '../domain/model';
import {
  PATCH_SCHEMAS,
  taskPatchSchema,
  type TaskPatch,
} from '../domain/schemas';
import type {
  BeginReadOptions,
  MutationOutcome,
  PullPlan,
  ReadQuotaGrant,
  ValidatedMutation,
} from '../hub/types';
import type {UserHub} from '../hub/user-hub';
import {verifyToken} from '../lib/crypto';
import {AppError, unwrap} from '../lib/errors';
import {uuidV7} from '../lib/ids';
import type {QuotaCharger} from '../store/scan';

export interface AuthInfo {
  userId: string;
  sessionId: string;
  hub: DurableObjectStub<UserHub>;
}

export interface AppVariables {
  requestId: string;
  auth: AuthInfo;
  readMeter: ReadQuotaMeter | undefined;
}

export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}

export type AppContext = Context<AppEnv>;

const configCache = new WeakMap<Env, AppConfig>();

/** Returns the parsed config, once per `env` object. */
export function configFor(env: Env): AppConfig {
  let config = configCache.get(env);
  if (!config) {
    config = readConfig(env);
    configCache.set(env, config);
  }
  return config;
}

export function hubFor(env: Env, userId: string): DurableObjectStub<UserHub> {
  return env.USER_HUB.get(env.USER_HUB.idFromName(userId));
}

/**
 * Requires a Bearer access token. Only the HMAC is checked here, so forged
 * tokens never reach storage; the user's hub validates the session itself.
 */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim() ?? '';
  const claims = token
    ? await verifyToken(c.env.TOKEN_SECRET, 'ftk', token)
    : null;
  if (!claims) {
    throw new AppError(401, 'invalid_token', '缺少或無效的 Bearer token');
  }
  c.set('auth', {...claims, hub: hubFor(c.env, claims.userId)});
  await next();
  const refund = c.get('readMeter')?.release();
  if (refund) c.executionCtx.waitUntil(refund);
};

/** Minimum top-up so a long scan does not call the hub for every page. */
const TOP_UP_MINIMUM = {reads: 200, lists: 5} as const;

/**
 * Meters Worker-side KV reads: spends the quota reserved by `beginRead`, asks
 * the hub for more when it runs out, and refunds the rest when released.
 */
export class ReadQuotaMeter implements QuotaCharger {
  private remaining: ReadQuotaGrant;

  constructor(
    private readonly hub: DurableObjectStub<UserHub>,
    private readonly sessionId: string,
    private readonly day: string,
    grant: ReadQuotaGrant,
  ) {
    this.remaining = {...grant};
  }

  async charge(kind: 'reads' | 'lists', count: number): Promise<void> {
    if (count <= 0) return;
    if (this.remaining[kind] < count) {
      const {granted, retryAfter} = await this.hub.topUpReadQuota(
        this.sessionId,
        kind,
        Math.max(count - this.remaining[kind], TOP_UP_MINIMUM[kind]),
        this.day,
      );
      this.remaining[kind] += granted;
      if (this.remaining[kind] < count) {
        throw new AppError(
          429,
          'quota_exceeded',
          `今日 KV ${kind} 配額已用完`,
          {kind},
          retryAfter,
        );
      }
    }
    this.remaining[kind] -= count;
  }

  /** Refunds unused quota; returns the RPC to wait on, or null if none. */
  release(): Promise<void> | null {
    if (this.remaining.reads === 0 && this.remaining.lists === 0) return null;
    const leftover = this.remaining;
    this.remaining = {reads: 0, lists: 0};
    return this.hub.refundReadQuota(leftover, this.day);
  }
}

export interface ReadSession {
  userId: string;
  now: number;
  settings: Settings;
  committedStamp: number;
  pullPlan: PullPlan | null;
  overlay: Map<string, JournalEntry>;
  meter: ReadQuotaMeter;
}

/** Authorizes the request, reserves read quota, and fetches the overlay. */
export async function openReadSession(
  c: AppContext,
  options: BeginReadOptions,
): Promise<ReadSession> {
  const {hub, sessionId} = c.get('auth');
  const begun = unwrap(await hub.beginRead(sessionId, options));
  const meter = new ReadQuotaMeter(hub, sessionId, begun.day, begun.grant);
  c.set('readMeter', meter);
  const overlay = new Map<string, JournalEntry>();
  for (const raw of begun.journal) {
    overlay.set(raw.key, parseJournalEntry(raw));
  }
  return {
    userId: begun.userId,
    now: begun.now,
    settings: begun.settings,
    committedStamp: begun.committedStamp,
    pullPlan: begun.pullPlan,
    overlay,
    meter,
  };
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export type PatchValidation =
  | {ok: true; patch: Record<string, unknown>}
  | {ok: false; message: string; issues: ValidationIssue[]};

function withGeneratedIds<T extends {id?: string}>(
  items: T[],
): Array<T & {id: string}> {
  return items.map(item => ({...item, id: item.id ?? uuidV7()}));
}

/**
 * Normalizes a task patch: fills missing sub-item ids, rewrites instants as
 * UTC ISO strings, and dedupes tag ids and recurrence weekdays.
 */
function normalizeTaskPatch(task: TaskPatch): Record<string, unknown> {
  const patch: Record<string, unknown> = {...task};
  if (task.subtasks) patch.subtasks = withGeneratedIds(task.subtasks);
  if (task.links) patch.links = withGeneratedIds(task.links);
  if (task.reminders) {
    patch.reminders = withGeneratedIds(
      task.reminders.map(reminder => ({
        ...reminder,
        at: new Date(reminder.at).toISOString(),
      })),
    );
  }
  if (task.completedAt) {
    patch.completedAt = new Date(task.completedAt).toISOString();
  }
  if (task.tagIds) patch.tagIds = [...new Set(task.tagIds)];
  if (task.recurrence?.byWeekday) {
    patch.recurrence = {
      ...task.recurrence,
      byWeekday: [...new Set(task.recurrence.byWeekday)].sort(),
    };
  }
  return patch;
}

function invalidPatch(
  kind: Kind,
  issues: ReadonlyArray<{path: PropertyKey[]; message: string}>,
): PatchValidation {
  return {
    ok: false,
    message: `${kind} 欄位驗證失敗`,
    issues: issues.map(issue => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
    })),
  };
}

/** Validates a patch for `kind` and normalizes it for storage. */
export function validatePatch(kind: Kind, data: unknown): PatchValidation {
  if (kind === 'task') {
    const result = taskPatchSchema.safeParse(data);
    return result.success
      ? {ok: true, patch: normalizeTaskPatch(result.data)}
      : invalidPatch(kind, result.error.issues);
  }
  const result = PATCH_SCHEMAS[kind].safeParse(data);
  return result.success
    ? {ok: true, patch: {...result.data}}
    : invalidPatch(kind, result.error.issues);
}

export function parsePatchOrThrow(
  kind: Kind,
  data: unknown,
): Record<string, unknown> {
  const validation = validatePatch(kind, data);
  if (!validation.ok) {
    throw new AppError(400, 'validation_error', validation.message, {
      issues: validation.issues,
    });
  }
  return validation.patch;
}

/** Applies one mutation and throws its rejection as an `AppError`. */
export async function applyMutation(
  c: AppContext,
  mutation: ValidatedMutation,
): Promise<MutationOutcome> {
  const {hub, sessionId} = c.get('auth');
  const [outcome] = unwrap(await hub.applyMutations(sessionId, [mutation]));
  if (!outcome) throw new AppError(500, 'internal_error', 'mutation 沒有結果');
  if (outcome.status === 'rejected' && outcome.error) {
    const {status, code, message, retryAfter} = outcome.error;
    throw new AppError(
      status,
      code,
      message,
      outcome.entity ? {entity: outcome.entity} : undefined,
      retryAfter,
    );
  }
  return outcome;
}
