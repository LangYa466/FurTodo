import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import {configFor} from '../config';
import {database, type AppEnv} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import {
  addPushSubscription,
  removePushSubscription,
  sendTestPush,
} from '../store/push';

const MAX_ENDPOINT_LENGTH = 1024;

export function registerPushRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/push/vapid-public-key',
      tags: ['Push'],
      summary:
        'Web Push VAPID 公钥（PushManager.subscribe 的 applicationServerKey）',
      responses: {
        200: jsonContent(
          z.object({
            publicKey: z
              .string()
              .openapi({description: 'base64url，65 bytes 未压缩 P-256 公钥'}),
          }),
          '公钥',
        ),
      },
    }),
    c => c.json({publicKey: c.env.VAPID_PUBLIC_KEY}, 200),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/push/subscriptions',
      tags: ['Push'],
      summary: '登记 Web Push 订阅（PushSubscription.toJSON() 的内容）',
      description:
        '提醒时间到达后（1 分钟内），服务器会推送 JSON：{ type: "reminder", taskId, reminderId, title, dueDate, dueTime, at }。同一 endpoint 重发会覆盖。',
      security: BEARER_SECURITY,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                endpoint: z.url({protocol: /^https$/}).max(MAX_ENDPOINT_LENGTH),
                keys: z.object({
                  p256dh: z.string().max(200),
                  auth: z.string().max(100),
                }),
                device: z
                  .string()
                  .max(64)
                  .nullable()
                  .optional()
                  .openapi({description: '设备名称，方便识别'}),
                expirationTime: z
                  .number()
                  .nullable()
                  .optional()
                  .openapi({description: '浏览器提供的字段，会被忽略'}),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: jsonContent(z.object({subscriptions: z.int()}), '当前订阅数'),
        ...errorResponses(400, 401, 403, 409, 429),
      },
    }),
    async c => {
      const {endpoint, keys, device} = c.req.valid('json');
      const result = await addPushSubscription(
        await database(c),
        c.get('auth').userId,
        {endpoint, keys, device: device ?? null},
        Date.now(),
      );
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/push/subscriptions',
      tags: ['Push'],
      summary: '取消 Web Push 订阅',
      security: BEARER_SECURITY,
      request: {
        query: z.object({endpoint: z.string().max(MAX_ENDPOINT_LENGTH)}),
      },
      responses: {
        200: jsonContent(z.object({removed: z.boolean()}), '结果'),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const {endpoint} = c.req.valid('query');
      const result = await removePushSubscription(
        await database(c),
        c.get('auth').userId,
        endpoint,
      );
      return c.json(result, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/push/test',
      tags: ['Push'],
      summary: '向所有已订阅设备发送一条测试推送',
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(
          z.object({
            sent: z.int(),
            results: z.array(
              z.object({
                endpoint: z.string(),
                status: z.int(),
                ok: z.boolean(),
              }),
            ),
          }),
          '各推送服务的响应',
        ),
        ...errorResponses(401, 403, 404, 429),
      },
    }),
    async c => {
      const result = await sendTestPush(
        await database(c),
        c.env,
        configFor(c.env),
        c.get('auth').userId,
        Date.now(),
      );
      return c.json(result, 200);
    },
  );
}
