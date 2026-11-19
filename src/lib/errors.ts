import type {ContentfulStatusCode} from 'hono/utils/http-status';

export type ErrorCode =
  | 'bad_request'
  | 'validation_error'
  | 'invalid_token'
  | 'session_expired'
  | 'not_org_member'
  | 'org_membership_pending'
  | 'org_access_restricted'
  | 'forbidden'
  | 'not_found'
  | 'deleted'
  | 'quota_exceeded'
  | 'limit_exceeded'
  | 'payload_too_large'
  | 'rate_limited'
  | 'github_unavailable'
  | 'storage_busy'
  | 'internal_error';

/**
 * Error detail values that cross Durable Object RPC. They stay flat because
 * `unknown` or recursive types break RPC type inference.
 */
export type DetailValue = string | number | boolean | null | string[];

export interface ErrorPayload {
  status: ContentfulStatusCode;
  code: ErrorCode;
  message: string;
  details?: Record<string, DetailValue>;
  /** Seconds until the quota or rate limit resets; sent as Retry-After. */
  retryAfter?: number;
}

/** An error that the HTTP layer renders as `{error: {code, message, details}}`. */
export class AppError extends Error {
  /**
   * @param details Extra response fields; Worker-side only, never sent over
   *     Durable Object RPC.
   */
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static from(payload: ErrorPayload): AppError {
    return new AppError(
      payload.status,
      payload.code,
      payload.message,
      payload.details,
      payload.retryAfter,
    );
  }
}

/**
 * Result of a Durable Object RPC method. RPC drops custom error properties,
 * so hub methods return failures as data and the Worker rethrows them.
 */
export type HubResult<T> =
  {ok: true; value: T} | {ok: false; error: ErrorPayload};

/** Returns the value of a successful hub call or throws its `AppError`. */
export function unwrap<T>(result: HubResult<T>): T {
  if (!result.ok) throw AppError.from(result.error);
  return result.value;
}
