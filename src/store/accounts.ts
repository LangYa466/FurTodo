import {and, asc, count, desc, eq, inArray} from 'drizzle-orm';
import {accountAgeDays, fetchProfile, type GithubProfile} from '../auth/github';
import type {AppConfig, QuotaCounts} from '../config';
import {
  inTransaction,
  type Database,
  type DatabaseConnection,
  type Executor,
} from '../db/client';
import {
  entities,
  sessions,
  usageDays,
  users,
  type SessionKind,
  type SessionRow,
} from '../db/schema';
import {
  DEFAULT_SETTINGS,
  SETTINGS_ID,
  toApiEntity,
  unsavedSettingsEntity,
  type ApiEntity,
  type Settings,
} from '../domain/model';
import {
  openJson,
  randomBase64Url,
  sealJson,
  sha256Base64Url,
  type TokenClaims,
} from '../lib/crypto';
import {AppError} from '../lib/errors';
import {storedEntity} from './entities';
import {consumeQuota, countsOf, quotaDay} from './quota';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SESSION_TTL_MS = 30 * DAY_MS;
/** Sessions record their last use at most once per hour. */
const SESSION_TOUCH_MS = HOUR_MS;
const LOGIN_CODE_TTL_MS = 5 * MINUTE_MS;
const ELIGIBILITY_RECHECK_MS = 6 * HOUR_MS;
/** After GitHub could not be reached, the next recheck waits this long. */
const ELIGIBILITY_RETRY_MS = 5 * MINUTE_MS;
/** How long requests continue while GitHub cannot be reached. */
const ELIGIBILITY_GRACE_MS = 72 * HOUR_MS;
const MAX_SESSIONS = 50;
const SESSION_ID_BYTES = 16;

export interface SessionView {
  id: string;
  kind: SessionKind;
  name: string | null;
  userAgent: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  /** Whether this is the session making the request. */
  current: boolean;
}

export interface EligibilityView {
  /** Minimum account age in days the API requires. */
  minAccountAgeDays: number;
  /** Age of the signed-in GitHub account in whole days. */
  accountAgeDays: number;
  /** When GitHub last confirmed the account. */
  checkedAt: string;
}

export interface AccountView {
  user: GithubProfile;
  eligibility: EligibilityView;
  session: SessionView;
  settings: ApiEntity;
}

/** The authorized session behind a request. */
export interface AuthInfo {
  userId: number;
  sessionId: string;
  settings: Settings;
  /** Today's quota usage, including this request. */
  usage: QuotaCounts;
}

export interface PendingSessionInput {
  userId: number;
  profile: GithubProfile;
  githubToken: string;
  codeChallenge: string;
  redirectUri: string;
  userAgent: string | null;
}

export interface ActivationInput {
  userId: number;
  sessionId: string;
  codeVerifier: string;
  redirectUri: string;
  userAgent: string | null;
}

type EligibilityCheck = 'ok' | 'revoked' | 'unavailable';

interface EligibilityState {
  eligibilityCheckedAt: Date;
  eligibilityFailedAt: Date | null;
  sealedGithubToken: string;
}

function toSessionView(row: SessionRow, currentSessionId: string): SessionView {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    userAgent: row.userAgent,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    current: row.id === currentSessionId,
  };
}

/** Makes room for one more session by dropping least recently used logins. */
async function evictOldestSessions(
  db: Executor,
  userId: number,
): Promise<void> {
  const [row] = await db
    .select({total: count()})
    .from(sessions)
    .where(eq(sessions.userId, userId));
  const total = row?.total ?? 0;
  if (total < MAX_SESSIONS) return;
  const oldest = await db
    .select({id: sessions.id})
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.kind, 'oauth')))
    .orderBy(asc(sessions.lastUsedAt))
    .limit(total - MAX_SESSIONS + 1);
  if (oldest.length === 0) return;
  await db.delete(sessions).where(
    inArray(
      sessions.id,
      oldest.map(session => session.id),
    ),
  );
}

/** Deletes every session and the stored GitHub token of a user. */
async function revokeAllSessions(db: Database, userId: number): Promise<void> {
  await inTransaction(db, async tx => {
    await tx
      .update(users)
      .set({sealedGithubToken: ''})
      .where(eq(users.id, userId));
    await tx.delete(sessions).where(eq(sessions.userId, userId));
  });
}

/**
 * Records a GitHub login and opens a pending session, which the client
 * redeems once with its PKCE verifier (see `activateSession`).
 */
export async function createPendingSession(
  db: Database,
  env: Env,
  config: AppConfig,
  input: PendingSessionInput,
  now: number,
): Promise<string> {
  const sealedGithubToken = await sealJson(
    env.TOKEN_SECRET,
    'ghtoken-aes',
    input.githubToken,
  );
  const at = new Date(now);
  return inTransaction(db, async tx => {
    await tx
      .insert(users)
      .values({
        id: input.userId,
        profile: input.profile,
        sealedGithubToken,
        settings: {...DEFAULT_SETTINGS},
        eligibilityCheckedAt: at,
        eligibilityFailedAt: null,
        lastStamp: new Date(0),
        purgedThrough: null,
        liveEntityCount: 0,
        createdAt: at,
      })
      .onConflictDoUpdate({
        target: users.id,
        set: {
          profile: input.profile,
          sealedGithubToken,
          eligibilityCheckedAt: at,
          eligibilityFailedAt: null,
        },
      });
    await consumeQuota(tx, config, input.userId, 'logins', 1, now);
    await evictOldestSessions(tx, input.userId);
    const sessionId = randomBase64Url(SESSION_ID_BYTES);
    await tx.insert(sessions).values({
      id: sessionId,
      userId: input.userId,
      kind: 'oauth',
      name: null,
      status: 'pending',
      codeChallenge: input.codeChallenge,
      redirectUri: input.redirectUri,
      userAgent: input.userAgent,
      createdAt: at,
      lastUsedAt: at,
      expiresAt: new Date(now + LOGIN_CODE_TTL_MS),
    });
    return sessionId;
  });
}

/** Redeems a login code after checking its PKCE verifier and redirect URI. */
export async function activateSession(
  db: Database,
  config: AppConfig,
  input: ActivationInput,
  now: number,
): Promise<AccountView> {
  const invalidGrant = {oauthError: 'invalid_grant'};
  const [session] = await db
    .select()
    .from(sessions)
    .where(
      and(eq(sessions.id, input.sessionId), eq(sessions.userId, input.userId)),
    );
  if (!session || session.status !== 'pending') {
    throw new AppError(400, 'bad_request', '登录码无效或已使用', invalidGrant);
  }
  if (session.expiresAt.getTime() <= now) {
    await deleteSession(db, input.userId, input.sessionId);
    throw new AppError(
      400,
      'bad_request',
      '登录码已过期，请重新登录',
      invalidGrant,
    );
  }
  if (session.redirectUri !== input.redirectUri) {
    throw new AppError(
      400,
      'bad_request',
      'redirect_uri 与授权时不同',
      invalidGrant,
    );
  }
  if ((await sha256Base64Url(input.codeVerifier)) !== session.codeChallenge) {
    throw new AppError(400, 'bad_request', 'code_verifier 不符', invalidGrant);
  }
  // Only one redemption can move the session out of `pending`.
  const activated = await db
    .update(sessions)
    .set({
      status: 'active',
      codeChallenge: null,
      lastUsedAt: new Date(now),
      expiresAt: new Date(now + SESSION_TTL_MS),
      userAgent: input.userAgent ?? session.userAgent,
    })
    .where(
      and(eq(sessions.id, input.sessionId), eq(sessions.status, 'pending')),
    )
    .returning({id: sessions.id});
  if (activated.length === 0) {
    throw new AppError(400, 'bad_request', '登录码无效或已使用', invalidGrant);
  }
  return accountView(db, config, input.userId, input.sessionId);
}

/**
 * Re-verifies the GitHub token every 6 hours. Account age only grows, so the
 * gate itself never reopens; this catches tokens the user revoked. While
 * GitHub is unreachable, requests continue for a grace period.
 */
async function ensureEligibility(
  db: Database,
  env: Env,
  config: AppConfig,
  userId: number,
  state: EligibilityState,
  now: number,
): Promise<void> {
  const checkedAt = state.eligibilityCheckedAt.getTime();
  if (now - checkedAt < ELIGIBILITY_RECHECK_MS) return;
  const failedAt = state.eligibilityFailedAt?.getTime() ?? 0;
  const outcome =
    now - failedAt < ELIGIBILITY_RETRY_MS
      ? 'unavailable'
      : await recheckEligibility(db, env, config, userId, state, now);
  if (outcome === 'ok') return;
  if (outcome === 'revoked') {
    throw new AppError(401, 'invalid_token', 'GitHub 授权已失效，请重新登录');
  }
  if (now - checkedAt > ELIGIBILITY_GRACE_MS) {
    throw new AppError(
      503,
      'github_unavailable',
      '暂时无法向 GitHub 验证账号状态',
    );
  }
}

async function recheckEligibility(
  db: Database,
  env: Env,
  config: AppConfig,
  userId: number,
  state: EligibilityState,
  now: number,
): Promise<EligibilityCheck> {
  const token = state.sealedGithubToken
    ? await openJson<string>(
        env.TOKEN_SECRET,
        'ghtoken-aes',
        state.sealedGithubToken,
      )
    : null;
  if (!token) {
    await revokeAllSessions(db, userId);
    return 'revoked';
  }
  const result = await fetchProfile(config, token);
  switch (result.status) {
    case 'ok':
      await db
        .update(users)
        .set({eligibilityCheckedAt: new Date(now), eligibilityFailedAt: null})
        .where(eq(users.id, userId));
      return 'ok';
    case 'unavailable':
      console.warn(
        JSON.stringify({
          msg: 'eligibility recheck unavailable',
          userId,
          detail: result.detail,
        }),
      );
      await db
        .update(users)
        .set({eligibilityFailedAt: new Date(now)})
        .where(eq(users.id, userId));
      return 'unavailable';
    default:
      console.log(JSON.stringify({msg: 'github token revoked', userId}));
      await revokeAllSessions(db, userId);
      return 'revoked';
  }
}

/**
 * Checks that the session is active, re-verifies the GitHub token when due,
 * and charges one request. The session's expiry slides at most hourly, after
 * the response.
 */
export async function authorize(
  database: DatabaseConnection,
  env: Env,
  config: AppConfig,
  claims: TokenClaims,
  now: number,
): Promise<AuthInfo> {
  const db = await database.get();
  const userId = Number(claims.userId);
  const {sessionId} = claims;
  const [row] = await db
    .select({
      session: sessions,
      settings: users.settings,
      eligibilityCheckedAt: users.eligibilityCheckedAt,
      eligibilityFailedAt: users.eligibilityFailedAt,
      sealedGithubToken: users.sealedGithubToken,
      usage: usageDays,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(
      usageDays,
      and(
        eq(usageDays.userId, sessions.userId),
        eq(usageDays.day, quotaDay(config, now)),
      ),
    )
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  if (!row || row.session.status !== 'active') {
    throw new AppError(401, 'invalid_token', 'Session 不存在或已注销');
  }
  const {session} = row;
  if (session.expiresAt.getTime() <= now) {
    await deleteSession(db, userId, sessionId);
    throw new AppError(401, 'session_expired', 'Session 已过期，请重新登录');
  }
  await ensureEligibility(db, env, config, userId, row, now);
  const requests = await consumeQuota(db, config, userId, 'requests', 1, now);
  if (now - session.lastUsedAt.getTime() > SESSION_TOUCH_MS) {
    // Personal tokens keep their fixed expiry; login sessions slide.
    const expiresAt =
      session.kind === 'oauth' ? new Date(now + SESSION_TTL_MS) : undefined;
    database.defer(deferred =>
      deferred
        .update(sessions)
        .set({lastUsedAt: new Date(now), expiresAt})
        .where(eq(sessions.id, sessionId)),
    );
  }
  return {
    userId,
    sessionId,
    settings: row.settings,
    usage: {...countsOf(row.usage), requests},
  };
}

export async function accountView(
  db: Executor,
  config: AppConfig,
  userId: number,
  sessionId: string,
): Promise<AccountView> {
  const [row] = await db
    .select({
      session: sessions,
      profile: users.profile,
      settings: users.settings,
      eligibilityCheckedAt: users.eligibilityCheckedAt,
      settingsEntity: entities,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(
      entities,
      and(
        eq(entities.userId, sessions.userId),
        eq(entities.kind, 'settings'),
        eq(entities.id, SETTINGS_ID),
      ),
    )
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)));
  if (!row) {
    throw new AppError(401, 'invalid_token', 'Session 不存在或已注销');
  }
  return {
    user: row.profile,
    eligibility: {
      minAccountAgeDays: config.minAccountAgeDays,
      accountAgeDays: accountAgeDays(row.profile.createdAt),
      checkedAt: row.eligibilityCheckedAt.toISOString(),
    },
    session: toSessionView(row.session, sessionId),
    settings: row.settingsEntity
      ? toApiEntity(storedEntity(row.settingsEntity), row.settings.timezone)
      : unsavedSettingsEntity(row.settings),
  };
}

export async function createPersonalToken(
  db: Database,
  userId: number,
  currentSessionId: string,
  name: string,
  expiresInDays: number,
  now: number,
): Promise<SessionView> {
  const at = new Date(now);
  const token: SessionRow = {
    id: randomBase64Url(SESSION_ID_BYTES),
    userId,
    kind: 'pat',
    name,
    status: 'active',
    codeChallenge: null,
    redirectUri: null,
    userAgent: null,
    createdAt: at,
    lastUsedAt: at,
    expiresAt: new Date(now + expiresInDays * DAY_MS),
  };
  await inTransaction(db, async tx => {
    await evictOldestSessions(tx, userId);
    await tx.insert(sessions).values(token);
  });
  return toSessionView(token, currentSessionId);
}

export async function listSessions(
  db: Executor,
  userId: number,
  currentSessionId: string,
): Promise<SessionView[]> {
  const rows = await db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), eq(sessions.status, 'active')))
    .orderBy(desc(sessions.lastUsedAt));
  return rows.map(row => toSessionView(row, currentSessionId));
}

/** Deletes one of the user's sessions; returns whether it existed. */
export async function deleteSession(
  db: Executor,
  userId: number,
  sessionId: string,
): Promise<boolean> {
  const deleted = await db
    .delete(sessions)
    .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
    .returning({id: sessions.id});
  return deleted.length > 0;
}
