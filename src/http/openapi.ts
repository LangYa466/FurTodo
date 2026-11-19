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
  400: '请求格式错误（validation_error / bad_request）',
  401: '未登录或 token 无效（invalid_token / session_expired）',
  403: 'GitHub 账号未满一年或超过总量上限（account_too_new / limit_exceeded）',
  404: '未找到（not_found）',
  409: '状态冲突（deleted / limit_exceeded）',
  413: '文件太大（payload_too_large）',
  429: '超过每日配额或限流（quota_exceeded / rate_limited），见 Retry-After',
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
