import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import {configFor} from '../config';
import {SETTINGS_ID, toApiEntity, unsavedSettingsEntity} from '../domain/model';
import {settingsEntitySchema, settingsPatchSchema} from '../domain/schemas';
import {
  applyMutation,
  database,
  parsePatchOrThrow,
  type AppEnv,
} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import {AppError} from '../lib/errors';
import {accountView} from '../store/accounts';
import {usageView} from '../store/quota';
import {accountSchema} from './auth';
import {readEntity} from './entities';

const quotaCountsSchema = z.object({
  requests: z.int().openapi({description: 'API 请求数'}),
  reads: z.int().openapi({description: '读取的数据条数'}),
  writes: z
    .int()
    .openapi({description: '写入的数据条数（删除清单时连带的任务也算）'}),
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

/** Registers the profile, usage, and settings routes. */
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
      const {userId, sessionId} = c.get('auth');
      const account = await accountView(
        await database(c),
        configFor(c.env),
        userId,
        sessionId,
      );
      return c.json(account, 200);
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
      const usage = await usageView(
        await database(c),
        configFor(c.env),
        c.get('auth').userId,
        Date.now(),
      );
      return c.json(usage, 200);
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
      // Never saved: the defaults, as revision 0.
      return c.json(unsavedSettingsEntity(c.get('auth').settings), 200);
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
