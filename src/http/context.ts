import type {Context, MiddlewareHandler} from 'hono';
import {configFor} from '../config';
import {DatabaseConnection, type Database} from '../db/client';
import type {Kind, StoredEntity} from '../domain/model';
import {
  PATCH_SCHEMAS,
  taskPatchSchema,
  type TaskPatch,
} from '../domain/schemas';
import {verifyToken, type TokenClaims} from '../lib/crypto';
import {AppError} from '../lib/errors';
import {uuidV7} from '../lib/ids';
import {authorize, type AuthInfo} from '../store/accounts';
import {
  applyMutations,
  type MutationOutcome,
  type ValidatedMutation,
} from '../store/mutations';
import {quotaExceeded, recordUsage} from '../store/quota';

/** Per-request values the handlers read back out of the context. */
export interface AppVariables {
  requestId: string;
  database: DatabaseConnection;
  /** Bearer token claims, set on every authenticated `/v1` path. */
  claims: TokenClaims;
  /** The authorized session, set on every authenticated path but logout. */
  auth: AuthInfo;
}

/** The Hono environment: Worker bindings and per-request variables. */
export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}

/** The request context of a route under this environment. */
export type AppContext = Context<AppEnv>;

/** `/v1` paths that skip Bearer auth. */
const PUBLIC_V1_PATHS: Record<string, true> = {
  '/v1/auth/github/authorize': true,
  '/v1/auth/github/callback': true,
  '/v1/auth/token': true,
  '/v1/push/vapid-public-key': true,
};

/** Paths that need only a valid token, so expired sessions can log out. */
const TOKEN_ONLY_PATHS: Record<string, true> = {'/v1/auth/logout': true};

/** Gives the request a lazily opened database and closes it afterwards. */
export const withDatabase: MiddlewareHandler<AppEnv> = async (c, next) => {
  const connection = new DatabaseConnection(c.env.HYPERDRIVE.connectionString);
  c.set('database', connection);
  try {
    await next();
  } finally {
    c.executionCtx.waitUntil(connection.close());
  }
};

/**
 * Requires a Bearer access token on `/v1`. The HMAC is checked first, so
 * forged tokens never reach the database; then the session is authorized.
 */
export const authenticate: MiddlewareHandler<AppEnv> = async (c, next) => {
  const path = c.req.path;
  if (PUBLIC_V1_PATHS[path]) return next();
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim() ?? '';
  const claims = token
    ? await verifyToken(c.env.TOKEN_SECRET, 'ftk', token)
    : null;
  if (!claims) {
    throw new AppError(401, 'invalid_token', '缺少或无效的 Bearer token');
  }
  c.set('claims', claims);
  if (!TOKEN_ONLY_PATHS[path]) {
    c.set(
      'auth',
      await authorize(
        c.get('database'),
        c.env,
        configFor(c.env),
        claims,
        Date.now(),
      ),
    );
  }
  return next();
};

/** Returns the request's database, opening the connection on first use. */
export function database(c: AppContext): Promise<Database> {
  return c.get('database').get();
}

/** Refuses a read once today's read quota is used up. */
export function requireReadQuota(c: AppContext): void {
  const config = configFor(c.env);
  if (c.get('auth').usage.reads >= config.dailyQuota.reads) {
    throw quotaExceeded(config, 'reads', Date.now());
  }
}

/** Charges `rows` entity reads once the response is sent. */
export function chargeReads(c: AppContext, rows: number): void {
  if (rows <= 0) return;
  const config = configFor(c.env);
  const {userId} = c.get('auth');
  c.get('database').defer(db =>
    recordUsage(db, config, userId, 'reads', rows, Date.now()),
  );
}

/** Loads entities for the authorized user and charges them as reads. */
export async function readEntities(
  c: AppContext,
  load: (db: Database, userId: number) => Promise<StoredEntity[]>,
): Promise<StoredEntity[]> {
  requireReadQuota(c);
  const loaded = await load(await database(c), c.get('auth').userId);
  chargeReads(c, loaded.length);
  return loaded;
}

/** One field that failed validation, addressed by its dotted path. */
export interface ValidationIssue {
  path: string;
  message: string;
}

/** Whether a patch validated, and either the patch or why it did not. */
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
    message: `${kind} 字段验证失败`,
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

/** Validates and normalizes a patch, throwing `validation_error` on failure. */
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

/** Applies mutations as the authorized user; see `applyMutations`. */
export async function applyMutationBatch(
  c: AppContext,
  mutations: ValidatedMutation[],
): Promise<MutationOutcome[]> {
  return applyMutations(
    await database(c),
    configFor(c.env),
    c.get('auth').userId,
    mutations,
  );
}

/** Applies one mutation and throws its rejection as an `AppError`. */
export async function applyMutation(
  c: AppContext,
  mutation: ValidatedMutation,
): Promise<MutationOutcome> {
  const [outcome] = await applyMutationBatch(c, [mutation]);
  if (!outcome) throw new AppError(500, 'internal_error', 'mutation 没有结果');
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
