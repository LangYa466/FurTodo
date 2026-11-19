import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import type {AppEnv} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import {unwrap} from '../lib/errors';

const MAX_ENDPOINT_LENGTH = 1024;

export function registerPushRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/push/vapid-public-key',
      tags: ['Push'],
      summary:
        'Web Push VAPID 公鑰（PushManager.subscribe 的 applicationServerKey）',
      responses: {
        200: jsonContent(
          z.object({
            publicKey: z
              .string()
              .openapi({description: 'base64url，65 bytes 未壓縮 P-256 公鑰'}),
          }),
          '公鑰',
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
      summary: '登記 Web Push 訂閱（PushSubscription.toJSON() 的內容）',
      description:
        '提醒時間到時，伺服器會推送 JSON：{ type: "reminder", taskId, reminderId, title, dueDate, dueTime, at }。同一 endpoint 重送會覆蓋。',
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
                  .openapi({description: '裝置名稱，方便辨識'}),
                expirationTime: z
                  .number()
                  .nullable()
                  .optional()
                  .openapi({description: '瀏覽器給的欄位，會被忽略'}),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: jsonContent(z.object({subscriptions: z.int()}), '目前訂閱數'),
        ...errorResponses(400, 401, 403, 409, 429),
      },
    }),
    async c => {
      const {endpoint, keys, device} = c.req.valid('json');
      const {hub, sessionId} = c.get('auth');
      const result = await hub.addPushSubscription(sessionId, {
        endpoint,
        keys,
        device: device ?? null,
      });
      return c.json(unwrap(result), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/push/subscriptions',
      tags: ['Push'],
      summary: '取消 Web Push 訂閱',
      security: BEARER_SECURITY,
      request: {
        query: z.object({endpoint: z.string().max(MAX_ENDPOINT_LENGTH)}),
      },
      responses: {
        200: jsonContent(z.object({removed: z.boolean()}), '結果'),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const {hub, sessionId} = c.get('auth');
      const {endpoint} = c.req.valid('query');
      return c.json(
        unwrap(await hub.removePushSubscription(sessionId, endpoint)),
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/push/test',
      tags: ['Push'],
      summary: '送一則測試推播到所有已訂閱裝置',
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
          '各推播服務的回應',
        ),
        ...errorResponses(401, 403, 404, 429),
      },
    }),
    async c => {
      const {hub, sessionId} = c.get('auth');
      return c.json(unwrap(await hub.sendTestPush(sessionId)), 200);
    },
  );
}
