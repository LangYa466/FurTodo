import {OpenAPIHono} from '@hono/zod-openapi';
import {Scalar} from '@scalar/hono-api-reference';
import {cors} from 'hono/cors';
import {HTTPException} from 'hono/http-exception';
import {configFor, requireAuth, type AppEnv} from './http/context';
import {randomBase64Url} from './lib/crypto';
import {AppError} from './lib/errors';
import {registerAttachmentRoutes} from './routes/attachments';
import {registerAuthRoutes} from './routes/auth';
import {registerCaptureRoutes} from './routes/capture';
import {registerEntityRoutes} from './routes/entities';
import {registerMeRoutes} from './routes/me';
import {registerMetaRoutes} from './routes/meta';
import {registerPushRoutes} from './routes/push';
import {registerSyncRoutes} from './routes/sync';
import {registerViewRoutes} from './routes/views';

export {UserHub} from './hub/user-hub';

const REQUEST_ID_BYTES = 8;

/** `/v1` paths that skip Bearer auth; `/v1/files/*` is checked by signature. */
const PUBLIC_V1_PATHS: Record<string, true> = {
  '/v1/auth/github/authorize': true,
  '/v1/auth/github/callback': true,
  '/v1/auth/token': true,
  '/v1/push/vapid-public-key': true,
};

const app = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json(
        {
          error: {
            code: 'validation_error',
            message: '請求格式錯誤',
            details: {
              issues: result.error.issues.map(issue => ({
                path: issue.path.map(String).join('.'),
                message: issue.message,
                code: issue.code,
              })),
            },
          },
        },
        400,
      );
    }
  },
});

app.use('*', async (c, next) => {
  const startedAt = Date.now();
  const requestId = c.req.header('cf-ray') ?? randomBase64Url(REQUEST_ID_BYTES);
  c.set('requestId', requestId);
  await next();
  c.header('X-Request-Id', requestId);
  c.header('X-Content-Type-Options', 'nosniff');
  // `auth` is unset on public routes.
  const auth = c.get('auth') as AppEnv['Variables']['auth'] | undefined;
  console.log(
    JSON.stringify({
      msg: 'request',
      requestId,
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      ms: Date.now() - startedAt,
      userId: auth?.userId,
    }),
  );
});

app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Authorization', 'Content-Type'],
    exposeHeaders: ['Retry-After', 'X-Request-Id', 'Content-Disposition'],
    maxAge: 86400,
  }),
);

app.use('/v1/*', async (c, next) => {
  if (PUBLIC_V1_PATHS[c.req.path] || c.req.path.startsWith('/v1/files/')) {
    return next();
  }
  return requireAuth(c, next);
});

registerMetaRoutes(app);
registerAuthRoutes(app);
registerMeRoutes(app);
registerEntityRoutes(app);
registerSyncRoutes(app);
registerViewRoutes(app);
registerCaptureRoutes(app);
registerAttachmentRoutes(app);
registerPushRoutes(app);

app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description:
    'GitHub 登入後由 POST /v1/auth/token 取得（ftk_ 開頭）。也可在 /dev/login 取得或建立個人 token。',
});

app.doc31('/openapi.json', c => ({
  openapi: '3.1.0',
  info: {
    title: 'FurTodo API',
    version: '1.0.0',
    description:
      'FurDevsCN 組織成員專用的待辦事項後端（Cloudflare Workers + KV + Durable Objects）。完整對接說明：/integration.md。所有時間回應皆為 UTC ISO 8601；日期為 YYYY-MM-DD。',
  },
  servers: [{url: configFor(c.env).publicBaseUrl}],
  tags: [
    {
      name: 'Auth',
      description: 'GitHub OAuth（PKCE）登入、session 與個人 token',
    },
    {name: 'Account', description: '使用者、設定、配額'},
    {name: 'Tasks', description: '任務 CRUD、完成、垃圾桶'},
    {name: 'Lists', description: '清單（專案/領域）'},
    {name: 'Folders', description: '清單分組'},
    {name: 'Tags', description: '情境標籤'},
    {name: 'Views', description: '今日 / 即將到來 / 四象限'},
    {name: 'Capture', description: '一行文字快速建立任務'},
    {name: 'Sync', description: '離線同步：push 變更、pull 增量'},
    {name: 'Attachments', description: '檔案附件'},
    {name: 'Push', description: 'Web Push 提醒'},
  ],
}));

app.get('/docs', Scalar({url: '/openapi.json', pageTitle: 'FurTodo API'}));

app.onError((error, c) => {
  if (error instanceof AppError) {
    const {status, code, message, details, retryAfter} = error;
    if (retryAfter) c.header('Retry-After', String(retryAfter));
    return c.json(
      {error: {code, message, ...(details ? {details} : {})}},
      status,
    );
  }
  if (error instanceof HTTPException) {
    return c.json(
      {
        error: {
          code: error.status === 413 ? 'payload_too_large' : 'bad_request',
          message: error.message || '請求錯誤',
        },
      },
      error.status,
    );
  }
  console.error(
    JSON.stringify({
      msg: 'unhandled error',
      requestId: c.get('requestId'),
      path: c.req.path,
      error: String(error),
      stack: error.stack,
    }),
  );
  return c.json(
    {
      error: {
        code: 'internal_error',
        message: '伺服器錯誤',
        details: {requestId: c.get('requestId')},
      },
    },
    500,
  );
});

app.notFound(c =>
  c.json(
    {
      error: {
        code: 'not_found',
        message: `找不到 ${c.req.method} ${c.req.path}`,
      },
    },
    404,
  ),
);

// The Workers runtime loads the default export as the fetch handler.
export default app satisfies ExportedHandler<Env>;
