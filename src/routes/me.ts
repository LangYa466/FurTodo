import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import {SETTINGS_ID, toApiEntity} from '../domain/model';
import {settingsEntitySchema, settingsPatchSchema} from '../domain/schemas';
import {applyMutation, parsePatchOrThrow, type AppEnv} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import {AppError, unwrap} from '../lib/errors';
import {accountSchema} from './auth';
import {readEntity} from './entities';

const quotaCountsSchema = z.object({
  requests: z.int().openapi({description: 'API 請求數'}),
  reads: z.int().openapi({description: 'KV 讀取（每個 key 算 1）'}),
  writes: z.int().openapi({description: 'KV 寫入/刪除'}),
  lists: z.int().openapi({description: 'KV 列舉（每頁 1000 key 算 1）'}),
  uploadBytes: z.int(),
  logins: z.int(),
  pushes: z.int().openapi({description: 'Web Push 送出數'}),
});

const usageSchema = z
  .object({
    day: z.string(),
    timeZone: z.string(),
    resetAt: z.string().openapi({description: '下次每日配額重置時間'}),
    used: quotaCountsSchema,
    limits: quotaCountsSchema,
    totals: z.object({entities: z.int(), storageBytes: z.int()}),
    totalLimits: z.object({
      entities: z.int(),
      storageBytes: z.int(),
      fileBytes: z.int(),
    }),
  })
  .openapi('Usage');

export function registerMeRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/me',
      tags: ['Account'],
      summary: '目前使用者、組織成員身分、GitHub 組織清單、設定',
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(accountSchema, '使用者資訊'),
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
      summary: '今日配額用量與總量上限',
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
      summary: '使用者設定（時區、週起始日等，跨裝置同步）',
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(settingsEntitySchema, '設定'),
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
      summary: '更新設定',
      security: BEARER_SECURITY,
      request: {
        body: {
          content: {'application/json': {schema: settingsPatchSchema}},
          required: true,
        },
      },
      responses: {
        200: jsonContent(settingsEntitySchema, '更新後的設定'),
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
        throw new AppError(500, 'internal_error', '設定沒有寫入');
      }
      return c.json(outcome.entity, 200);
    },
  );
}
