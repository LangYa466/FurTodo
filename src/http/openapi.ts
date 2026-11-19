import type {z} from '@hono/zod-openapi';
import {errorSchema} from '../domain/schemas';

export const BEARER_SECURITY = [{bearerAuth: []}];

export interface JsonResponseConfig<T extends z.ZodType> {
  content: {'application/json': {schema: T}};
  description: string;
}

export function jsonContent<T extends z.ZodType>(
  schema: T,
  description: string,
): JsonResponseConfig<T> {
  return {content: {'application/json': {schema}}, description};
}

const ERROR_DESCRIPTIONS = {
  400: '請求格式錯誤（validation_error / bad_request）',
  401: '未登入或 token 無效（invalid_token / session_expired）',
  403: '不是組織成員或超過總量上限（not_org_member / org_access_restricted / limit_exceeded）',
  404: '找不到（not_found）',
  409: '狀態衝突（deleted / limit_exceeded）',
  413: '檔案太大（payload_too_large）',
  429: '超過每日配額或限流（quota_exceeded / rate_limited），看 Retry-After',
} as const;

export type ErrorStatus = keyof typeof ERROR_DESCRIPTIONS;

/** Returns OpenAPI error responses for the given status codes. */
export function errorResponses<K extends ErrorStatus>(
  ...statuses: K[]
): Record<K, JsonResponseConfig<typeof errorSchema>> {
  const entries = statuses.map(status => [
    status,
    jsonContent(errorSchema, ERROR_DESCRIPTIONS[status]),
  ]);
  // fromEntries widens keys to string, but every requested status is present.
  return Object.fromEntries(entries) as Record<
    K,
    JsonResponseConfig<typeof errorSchema>
  >;
}
