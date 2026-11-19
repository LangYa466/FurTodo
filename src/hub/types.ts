// Inputs and outputs of UserHub RPC methods. Everything here crosses the
// Durable Object boundary, so it must stay structured-clone friendly.

import type {ContentfulStatusCode} from 'hono/utils/http-status';
import type {GithubProfile} from '../auth/github';
import type {QuotaCounts} from '../config';
import type {ApiEntity, Kind, RawJournalEntry, Settings} from '../domain/model';
import type {ErrorCode} from '../lib/errors';

/** `oauth` sessions come from login; `pat` ones are personal tokens. */
export type SessionKind = 'oauth' | 'pat';

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
  /** When the hub last confirmed the age with GitHub. */
  checkedAt: string;
}

export interface AccountView {
  user: GithubProfile;
  eligibility: EligibilityView;
  session: SessionView;
  settings: ApiEntity;
}

export interface EntityTotals {
  entities: number;
}

export interface UsageView {
  day: string;
  timeZone: string;
  resetAt: string;
  used: QuotaCounts;
  limits: QuotaCounts;
  totals: EntityTotals;
  totalLimits: EntityTotals;
}

export interface PendingSessionInput {
  userId: string;
  profile: GithubProfile;
  githubToken: string;
  codeChallenge: string;
  redirectUri: string;
  userAgent: string | null;
}

/** Which recently written entities the hub returns as the read overlay. */
export type JournalRequest =
  | {mode: 'none'}
  | {mode: 'scan'}
  | {mode: 'keys'; keys: string[]}
  | {mode: 'pull'; since: number};

export interface BeginReadOptions {
  journal: JournalRequest;
  /** KV reads to reserve up front; the Worker tops up when it needs more. */
  reserveReads?: number;
  /** KV list pages to reserve up front. */
  reserveLists?: number;
}

export interface ReadQuotaGrant {
  reads: number;
  lists: number;
}

/**
 * How a pull is served: nothing changed, from the journal alone, or by
 * scanning KV.
 */
export type PullPlan = 'upToDate' | 'journal' | 'scan';

export interface BeginReadResult {
  userId: string;
  /** Quota day the grant was taken from. */
  day: string;
  grant: ReadQuotaGrant;
  journal: RawJournalEntry[];
  /** Highest updatedAt already persisted; pull cursors never pass it. */
  committedStamp: number;
  settings: Settings;
  /** Set only for `mode: 'pull'`. */
  pullPlan: PullPlan | null;
  now: number;
}

export interface TopUpResult {
  granted: number;
  /** Seconds until the quota resets. */
  retryAfter: number;
}

export type MutationOp = 'upsert' | 'delete' | 'restore';

export interface ValidatedMutation {
  op: MutationOp;
  type: Kind;
  id: string;
  /** Zod-validated, normalized patch; upserts only. */
  data?: Record<string, unknown>;
  /** Client edit time in epoch ms, used for last-writer-wins. */
  editedAt?: number;
  /** Set by REST PATCH: a missing entity is a 404 instead of a create. */
  mustExist?: boolean;
}

export interface MutationError {
  code: ErrorCode;
  message: string;
  status: ContentfulStatusCode;
  retryAfter?: number;
}

export interface MutationOutcome {
  index: number;
  type: Kind;
  id: string;
  op: MutationOp;
  status: 'applied' | 'noop' | 'rejected';
  entity: ApiEntity | null;
  /** Next occurrences created by completing a recurring task. */
  spawned: ApiEntity[];
  error: MutationError | null;
}

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {p256dh: string; auth: string};
  device: string | null;
}

export interface PushDelivery {
  /** Origin of the push service endpoint. */
  endpoint: string;
  status: number;
  ok: boolean;
}

export interface TestPushResult {
  sent: number;
  results: PushDelivery[];
}
