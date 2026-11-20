import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import {
  accountAgeDays,
  exchangeCode,
  fetchProfile,
  type GithubProfile,
} from '../auth/github';
import {isAllowedRedirect} from '../auth/redirect';
import {configFor} from '../config';
import {settingsEntitySchema} from '../domain/schemas';
import {database, type AppContext, type AppEnv} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import {
  openJson,
  randomBase64Url,
  sealJson,
  sha256Base64Url,
  signToken,
  verifyToken,
} from '../lib/crypto';
import {AppError} from '../lib/errors';
import {
  activateSession,
  createPendingSession,
  createPersonalToken,
  deleteSession,
  listSessions,
} from '../store/accounts';

const STATE_TTL_MS = 10 * 60_000;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const GITHUB_VERIFIER_BYTES = 32;
const DEFAULT_TOKEN_DAYS = 90;
const USER_AGENT_MAX_LENGTH = 200;
const RATE_LIMIT_RETRY_SECONDS = 60;

/**
 * Login context sealed into GitHub's `state` parameter, so the server keeps
 * nothing between authorize and callback.
 */
interface OAuthState {
  redirectUri: string;
  /** Client's own `state`, echoed back unchanged. */
  clientState: string | null;
  /** Client's PKCE challenge, checked when the login code is redeemed. */
  codeChallenge: string;
  /** Server's PKCE verifier for the GitHub leg. */
  githubVerifier: string;
  expiresAt: number;
}

const githubUserSchema = z
  .object({
    id: z.int(),
    login: z.string(),
    name: z.string().nullable(),
    avatarUrl: z.string(),
    createdAt: z.string().openapi({description: 'GitHub 账号创建时间'}),
  })
  .openapi('GithubUser');
/** A login session: an OAuth login or a personal access token. */
export const sessionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['oauth', 'pat']).openapi({
      description: 'oauth = 登录生成；pat = 个人访问 token（给脚本/AI agent）',
    }),
    name: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.string(),
    lastUsedAt: z.string(),
    expiresAt: z
      .string()
      .openapi({description: 'oauth session 每次使用后滑动延长 30 天'}),
    current: z.boolean(),
  })
  .openapi('Session');
/** The caller's GitHub user, eligibility, session, and settings. */
export const accountSchema = z
  .object({
    user: githubUserSchema,
    eligibility: z.object({
      minAccountAgeDays: z
        .int()
        .openapi({description: '使用本 API 所需的最小 GitHub 账号年龄（天）'}),
      accountAgeDays: z.int().openapi({description: '当前账号年龄（天）'}),
      checkedAt: z.string().openapi({
        description: '上次向 GitHub 确认账号状态的时间（每 6 小时重验）',
      }),
    }),
    session: sessionSchema,
    settings: settingsEntitySchema,
  })
  .openapi('Me');

const tokenResponseSchema = accountSchema
  .extend({
    access_token: z.string().openapi({
      description: '之后所有请求需带 Authorization: Bearer <access_token>',
      example: 'ftk_123456.xxxxxxxx.yyyyyyyy',
    }),
    token_type: z.literal('Bearer'),
    expires_at: z.string(),
  })
  .openapi('TokenResponse');

function userAgentOf(c: AppContext): string | null {
  return c.req.header('user-agent')?.slice(0, USER_AGENT_MAX_LENGTH) ?? null;
}

/** Limits login endpoints per client IP (counted per Cloudflare location). */
async function enforceLoginRateLimit(c: AppContext): Promise<void> {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const {success} = await c.env.AUTH_LIMITER.limit({key: `auth:${ip}`});
  if (!success) {
    throw new AppError(
      429,
      'rate_limited',
      '登录请求太频繁，请稍后再试',
      undefined,
      RATE_LIMIT_RETRY_SECONDS,
    );
  }
}

/** Registers the GitHub OAuth, token, logout, and session routes. */
export function registerAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/auth/github/authorize',
      tags: ['Auth'],
      summary: '开始 GitHub 登录（浏览器跳转）',
      description:
        '客户端先生成 PKCE code_verifier（43-128 字符）与 state，把用户引导到这里。服务器验证 redirect_uri 白名单后 302 到 GitHub。登录完成后会 302 回 redirect_uri?code=<一次性登录码>&state=<原 state>，失败则带 error / error_description。',
      request: {
        query: z.object({
          redirect_uri: z.string().openapi({
            description:
              '客户端回调网址（需在白名单内），例如 http://localhost:5173/auth/callback 或 furtodo://auth/callback',
          }),
          code_challenge: z
            .string()
            .regex(PKCE_VERIFIER_RE)
            .openapi({description: 'BASE64URL(SHA256(code_verifier))'}),
          code_challenge_method: z.literal('S256'),
          state: z
            .string()
            .max(512)
            .optional()
            .openapi({description: '客户端随机值，回调时原样返回；务必比对'}),
        }),
      },
      responses: {
        302: {description: '跳转到 GitHub 授权页'},
        ...errorResponses(400, 429),
      },
    }),
    async c => {
      await enforceLoginRateLimit(c);
      const config = configFor(c.env);
      const query = c.req.valid('query');
      const allowed = [
        ...config.allowedRedirects,
        `${config.publicBaseUrl}/dev/login`,
      ];
      if (!isAllowedRedirect(query.redirect_uri, allowed)) {
        throw new AppError(400, 'bad_request', 'redirect_uri 不在白名单内', {
          allowed: config.allowedRedirects,
        });
      }
      const githubVerifier = randomBase64Url(GITHUB_VERIFIER_BYTES);
      const state: OAuthState = {
        redirectUri: query.redirect_uri,
        clientState: query.state ?? null,
        codeChallenge: query.code_challenge,
        githubVerifier,
        expiresAt: Date.now() + STATE_TTL_MS,
      };
      const url = new URL(`${config.githubOAuthBase}/login/oauth/authorize`);
      url.searchParams.set('client_id', c.env.GITHUB_CLIENT_ID);
      url.searchParams.set(
        'redirect_uri',
        `${config.publicBaseUrl}/v1/auth/github/callback`,
      );
      url.searchParams.set('scope', 'read:user');
      url.searchParams.set(
        'state',
        await sealJson(c.env.TOKEN_SECRET, 'state-aes', state),
      );
      url.searchParams.set(
        'code_challenge',
        await sha256Base64Url(githubVerifier),
      );
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('allow_signup', 'false');
      return c.redirect(url.toString(), 302);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/auth/github/callback',
      tags: ['Auth'],
      summary: 'GitHub OAuth 回调（由 GitHub 调用，客户端不要直接用）',
      request: {
        query: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        }),
      },
      responses: {
        302: {description: '跳回客户端 redirect_uri'},
        ...errorResponses(400, 429),
      },
    }),
    async c => {
      await enforceLoginRateLimit(c);
      const config = configFor(c.env);
      const query = c.req.valid('query');
      const state = query.state
        ? await openJson<OAuthState>(
            c.env.TOKEN_SECRET,
            'state-aes',
            query.state,
          )
        : null;
      if (!state || state.expiresAt < Date.now()) {
        throw new AppError(
          400,
          'bad_request',
          '登录流程已失效，请回到 App 重新登录',
        );
      }

      const redirectToClient = (params: Record<string, string>) => {
        const url = new URL(state.redirectUri);
        for (const [name, value] of Object.entries(params)) {
          url.searchParams.set(name, value);
        }
        if (state.clientState) {
          url.searchParams.set('state', state.clientState);
        }
        return c.redirect(url.toString(), 302);
      };
      if (query.error) {
        return redirectToClient({
          error: 'access_denied',
          error_description: query.error_description ?? '用户取消授权',
        });
      }
      if (!query.code) {
        return redirectToClient({
          error: 'invalid_request',
          error_description: 'GitHub 没有返回 code',
        });
      }

      const exchange = await exchangeCode(
        config,
        c.env.GITHUB_CLIENT_ID,
        c.env.GITHUB_CLIENT_SECRET,
        query.code,
        state.githubVerifier,
      );
      if (!exchange.ok) {
        return redirectToClient({
          error: 'github_error',
          error_description: exchange.error,
        });
      }
      const profileResult = await fetchProfile(config, exchange.accessToken);
      if (profileResult.status !== 'ok') {
        return redirectToClient({
          error: 'github_error',
          error_description:
            profileResult.status === 'token_invalid'
              ? 'GitHub 拒绝了刚签发的 token，请重新登录'
              : `无法读取 GitHub 账号：${profileResult.detail}`,
        });
      }
      const profile: GithubProfile = profileResult.profile;
      const ageDays = accountAgeDays(profile.createdAt);
      if (ageDays < config.minAccountAgeDays) {
        return redirectToClient({
          error: 'account_too_new',
          error_description: `GitHub 账号创建需满 ${config.minAccountAgeDays} 天（当前 ${ageDays} 天，创建于 ${profile.createdAt.slice(0, 10)}）`,
        });
      }
      let sessionId: string;
      try {
        sessionId = await createPendingSession(
          await database(c),
          c.env,
          config,
          {
            userId: profile.id,
            profile,
            githubToken: exchange.accessToken,
            codeChallenge: state.codeChallenge,
            redirectUri: state.redirectUri,
            userAgent: userAgentOf(c),
          },
          Date.now(),
        );
      } catch (error: unknown) {
        if (!(error instanceof AppError)) throw error;
        return redirectToClient({
          error: error.code,
          error_description: error.message,
        });
      }
      const code = await signToken(c.env.TOKEN_SECRET, 'ftc', {
        userId: String(profile.id),
        sessionId,
      });
      return redirectToClient({code});
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/token',
      tags: ['Auth'],
      summary: '用一次性登录码 + code_verifier 换取 access token',
      description:
        '登录码 5 分钟内有效且只能使用一次。access token 为 30 天滑动有效期（有使用就延长）。',
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                grant_type: z.literal('authorization_code'),
                code: z.string().max(300),
                code_verifier: z.string().regex(PKCE_VERIFIER_RE),
                redirect_uri: z
                  .string()
                  .max(2048)
                  .openapi({description: '必须与 authorize 时相同'}),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: jsonContent(tokenResponseSchema, '登录成功'),
        ...errorResponses(400, 403, 429),
      },
    }),
    async c => {
      await enforceLoginRateLimit(c);
      const body = c.req.valid('json');
      const claims = await verifyToken(c.env.TOKEN_SECRET, 'ftc', body.code);
      if (!claims) {
        throw new AppError(400, 'bad_request', '登录码无效', {
          oauthError: 'invalid_grant',
        });
      }
      const account = await activateSession(
        await database(c),
        configFor(c.env),
        {
          userId: Number(claims.userId),
          sessionId: claims.sessionId,
          codeVerifier: body.code_verifier,
          redirectUri: body.redirect_uri,
          userAgent: userAgentOf(c),
        },
        Date.now(),
      );
      const accessToken = await signToken(c.env.TOKEN_SECRET, 'ftk', claims);
      return c.json(
        {
          access_token: accessToken,
          token_type: 'Bearer' as const,
          expires_at: account.session.expiresAt,
          ...account,
        },
        200,
      );
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/logout',
      tags: ['Auth'],
      summary: '注销当前 session',
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(z.object({revoked: z.boolean()}), '已注销'),
        ...errorResponses(401),
      },
    }),
    async c => {
      const {userId, sessionId} = c.get('claims');
      const revoked = await deleteSession(
        await database(c),
        Number(userId),
        sessionId,
      );
      return c.json({revoked}, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/auth/sessions',
      tags: ['Auth'],
      summary: '列出所有已登录的设备与个人 token',
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(
          z.object({sessions: z.array(sessionSchema)}),
          'session 清单',
        ),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const {userId, sessionId} = c.get('auth');
      const sessions = await listSessions(await database(c), userId, sessionId);
      return c.json({sessions}, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/auth/sessions/{id}',
      tags: ['Auth'],
      summary: '撤销某个 session（注销其他设备或删除个人 token）',
      security: BEARER_SECURITY,
      request: {params: z.object({id: z.string().max(64)})},
      responses: {
        200: jsonContent(z.object({revoked: z.boolean()}), '结果'),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const {userId} = c.get('auth');
      const target = c.req.valid('param').id;
      const revoked = await deleteSession(await database(c), userId, target);
      return c.json({revoked}, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/tokens',
      tags: ['Auth'],
      summary: '创建个人访问 token（供 CLI、脚本、AI agent 测试用）',
      description:
        'token 只在创建时返回一次。同样受 GitHub 账号状态重验与每日配额限制。',
      security: BEARER_SECURITY,
      request: {
        body: {
          content: {
            'application/json': {
              schema: z.object({
                name: z.string().trim().min(1).max(64),
                expiresInDays: z
                  .int()
                  .min(1)
                  .max(365)
                  .default(DEFAULT_TOKEN_DAYS),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        201: jsonContent(
          z.object({token: z.string(), session: sessionSchema}),
          '已创建',
        ),
        ...errorResponses(400, 401, 403, 429),
      },
    }),
    async c => {
      const {userId, sessionId} = c.get('auth');
      const body = c.req.valid('json');
      const session = await createPersonalToken(
        await database(c),
        userId,
        sessionId,
        body.name,
        body.expiresInDays,
        Date.now(),
      );
      const token = await signToken(c.env.TOKEN_SECRET, 'ftk', {
        userId: String(userId),
        sessionId: session.id,
      });
      return c.json({token, session}, 201);
    },
  );
}
