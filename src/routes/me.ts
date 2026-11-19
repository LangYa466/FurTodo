import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import {SETTINGS_ID, toApiEntity} from '../domain/model';
import {settingsEntitySchema, settingsPatchSchema} from '../domain/schemas';
import {applyMutation, parsePatchOrThrow, type AppEnv} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import {AppError, unwrap} from '../lib/errors';
import {accountSchema} from './auth';
import {readEntity} from './entities';

const quotaCountsSchema = z.object({
  requests: z.int().openapi({description: 'API 请求数'}),
  reads: z.int().openapi({description: 'KV 读取（每个 key 算 1 次）'}),
  writes: z.int().openapi({description: 'KV 写入/删除'}),
  lists: z.int().openapi({description: 'KV 列举（每页 1000 个 key 算 1 次）'}),
  logins: z.int(),
  pushes: z.int().openapi({description: 'Web Push 发送数'}),
});

const usageSchema = z
  .object({
    day: z.string(),
    timeZone: z.string(),
    resetAt: z.string().openapi({description: '下次每日配额重置时间'}),
    used: quotaCountsSchema,
    limits: quotaCountsSchema,
    totals: z.object({entities: z.int()}),
    totalLimits: z.object({entities: z.int()}),
  })
  .openapi('Usage');

export function registerMeRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/me',
      tags: ['Account'],
      summary: '当前用户、GitHub 账号状态、设置',
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(accountSchema, '用户信息'),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const {hub, sessionId} = c.get('auth');
      return c.json(unwrap(await hub.getAccount(sessionId)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/usage',
      tags: ['Account'],
      summary: '今日配额用量与总量上限',
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(usageSchema, '用量'),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const {hub, sessionId} = c.get('auth');
      return c.json(unwrap(await hub.getUsage(sessionId)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/settings',
      tags: ['Account'],
      summary: '用户设置（时区、周起始日等，跨设备同步）',
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(settingsEntitySchema, '设置'),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const {entity, timeZone} = await readEntity(c, 'settings', SETTINGS_ID);
      if (entity) return c.json(toApiEntity(entity, timeZone), 200);
      // Never saved: the account view carries the defaults.
      const {hub, sessionId} = c.get('auth');
      return c.json(unwrap(await hub.getAccount(sessionId)).settings, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/v1/settings',
      tags: ['Account'],
      summary: '更新设置',
      security: BEARER_SECURITY,
      request: {
        body: {
          content: {'application/json': {schema: settingsPatchSchema}},
          required: true,
        },
      },
      responses: {
        200: jsonContent(settingsEntitySchema, '更新后的设置'),
        ...errorResponses(400, 401, 403, 429),
      },
    }),
    async c => {
      const outcome = await applyMutation(c, {
        op: 'upsert',
        type: 'settings',
        id: SETTINGS_ID,
        data: parsePatchOrThrow('settings', await c.req.json()),
      });
      if (!outcome.entity) {
        throw new AppError(500, 'internal_error', '设置没有写入');
      }
      return c.json(outcome.entity, 200);
    },
  );
}
