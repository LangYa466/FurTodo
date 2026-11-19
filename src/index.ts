import {OpenAPIHono} from '@hono/zod-openapi';
import {Scalar} from '@scalar/hono-api-reference';
import {cors} from 'hono/cors';
import {HTTPException} from 'hono/http-exception';
import {configFor, requireAuth, type AppEnv} from './http/context';
import {randomBase64Url} from './lib/crypto';
import {AppError} from './lib/errors';
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

/** `/v1` paths that skip Bearer auth. */
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
            message: '请求格式错误',
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
  if (PUBLIC_V1_PATHS[c.req.path]) return next();
  return requireAuth(c, next);
});

registerMetaRoutes(app);
registerAuthRoutes(app);
registerMeRoutes(app);
registerEntityRoutes(app);
registerSyncRoutes(app);
registerViewRoutes(app);
registerCaptureRoutes(app);
registerPushRoutes(app);

app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  description:
    'GitHub 登录后由 POST /v1/auth/token 获取（ftk_ 开头）。也可在 /dev/login 获取或创建个人 token。',
});

app.doc31('/openapi.json', c => ({
  openapi: '3.1.0',
  info: {
    title: 'FurTodo API',
    version: '1.0.0',
    description:
      'GitHub 账号创建满一年即可使用的待办事项后端（Cloudflare Workers + KV + Durable Objects + Drizzle ORM）。完整对接说明：/integration.md。所有时间响应均为 UTC ISO 8601；日期为 YYYY-MM-DD。',
  },
  servers: [{url: configFor(c.env).publicBaseUrl}],
  tags: [
    {
      name: 'Auth',
      description: 'GitHub OAuth（PKCE）登录、session 与个人 token',
    },
    {name: 'Account', description: '用户、设置、配额'},
    {name: 'Tasks', description: '任务 CRUD、完成、回收站'},
    {name: 'Lists', description: '清单（项目/领域）'},
    {name: 'Folders', description: '清单分组'},
    {name: 'Tags', description: '情境标签'},
    {name: 'Views', description: '今日 / 即将到来 / 四象限'},
    {name: 'Capture', description: '一行文字快速创建任务'},
    {name: 'Sync', description: '离线同步：push 变更、pull 增量'},
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
          message: error.message || '请求错误',
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
        message: '服务器错误',
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
        message: `未找到 ${c.req.method} ${c.req.path}`,
      },
    },
    404,
  ),
);

// The Workers runtime loads the default export as the fetch handler.
export default app satisfies ExportedHandler<Env>;
