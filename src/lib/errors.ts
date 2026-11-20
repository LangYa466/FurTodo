import type {ContentfulStatusCode} from 'hono/utils/http-status';

export type ErrorCode =
  | 'bad_request'
  | 'validation_error'
  | 'invalid_token'
  | 'session_expired'
  | 'account_too_new'
  | 'not_found'
  | 'deleted'
  | 'quota_exceeded'
  | 'limit_exceeded'
  | 'payload_too_large'
  | 'rate_limited'
  | 'github_unavailable'
  | 'storage_busy'
  | 'storage_unavailable'
  | 'internal_error';

/** An error that the HTTP layer renders as `{error: {code, message, details}}`. */
export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
    /** Seconds until the quota or rate limit resets; sent as Retry-After. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
