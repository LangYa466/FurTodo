import {createRoute, z, type OpenAPIHono} from '@hono/zod-openapi';
import {
  checkMembership,
  exchangeCode,
  fetchOrgs,
  fetchProfile,
  type GithubProfile,
} from '../auth/github';
import {isAllowedRedirect} from '../auth/redirect';
import {settingsEntitySchema} from '../domain/schemas';
import {configFor, hubFor, type AppContext, type AppEnv} from '../http/context';
import {BEARER_SECURITY, errorResponses, jsonContent} from '../http/openapi';
import {
  openJson,
  randomBase64Url,
  sealJson,
  sha256Base64Url,
  signToken,
  verifyToken,
} from '../lib/crypto';
import {AppError, unwrap} from '../lib/errors';

const STATE_TTL_MS = 10 * 60_000;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const GITHUB_VERIFIER_BYTES = 32;
const DEFAULT_TOKEN_DAYS = 90;
const USER_AGENT_MAX_LENGTH = 200;
const RATE_LIMIT_RETRY_SECONDS = 60;
const ORG_READ_SCOPES = ['read:org', 'write:org', 'admin:org'];

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
  })
  .openapi('GithubUser');
const githubOrgSchema = z
  .object({login: z.string(), avatarUrl: z.string()})
  .openapi('GithubOrg');
export const sessionSchema = z
  .object({
    id: z.string(),
    kind: z.enum(['oauth', 'pat']).openapi({
      description: 'oauth = 登入產生；pat = 個人存取 token（給腳本/AI agent）',
    }),
    name: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.string(),
    lastUsedAt: z.string(),
    expiresAt: z
      .string()
      .openapi({description: 'oauth session 每次使用後滑動延長 30 天'}),
    current: z.boolean(),
  })
  .openapi('Session');
export const accountSchema = z
  .object({
    user: githubUserSchema,
    membership: z.object({
      org: z.string().openapi({example: 'FurDevsCN'}),
      role: z.enum(['admin', 'member']),
      via: z.enum(['user_token', 'org_token']),
      verifiedAt: z.string().openapi({
        description: '上次向 GitHub 確認成員身分的時間（每 6 小時重驗）',
      }),
    }),
    orgs: z
      .array(githubOrgSchema)
      .openapi({description: '使用者所屬的 GitHub 組織（含私人成員身分）'}),
    session: sessionSchema,
    settings: settingsEntitySchema,
  })
  .openapi('Me');

const tokenResponseSchema = accountSchema
  .extend({
    access_token: z.string().openapi({
      description: '之後所有請求帶 Authorization: Bearer <access_token>',
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
      '登入請求太頻繁，請稍後再試',
      undefined,
      RATE_LIMIT_RETRY_SECONDS,
    );
  }
}

export function registerAuthRoutes(app: OpenAPIHono<AppEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/auth/github/authorize',
      tags: ['Auth'],
      summary: '開始 GitHub 登入（瀏覽器導向）',
      description:
        '客戶端先產生 PKCE code_verifier（43-128 字元）與 state，把使用者導到這裡。伺服器驗證 redirect_uri 白名單後 302 到 GitHub。登入完成後會 302 回 redirect_uri?code=<一次性登入碼>&state=<原 state>，失敗則帶 error / error_description。',
      request: {
        query: z.object({
          redirect_uri: z.string().openapi({
            description:
              '客戶端回呼網址（需在白名單內），例如 http://localhost:5173/auth/callback 或 furtodo://auth/callback',
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
            .openapi({description: '客戶端隨機值，回呼時原樣帶回；務必比對'}),
        }),
      },
      responses: {
        302: {description: '導向 GitHub 授權頁'},
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
        throw new AppError(400, 'bad_request', 'redirect_uri 不在白名單內', {
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
      url.searchParams.set('scope', 'read:org');
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
      summary: 'GitHub OAuth 回呼（由 GitHub 呼叫，客戶端不要直接用）',
      request: {
        query: z.object({
          code: z.string().optional(),
          state: z.string().optional(),
          error: z.string().optional(),
          error_description: z.string().optional(),
        }),
      },
      responses: {
        302: {description: '導回客戶端 redirect_uri'},
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
          '登入流程已失效，請回到 App 重新登入',
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
          error_description: query.error_description ?? '使用者取消授權',
        });
      }
      if (!query.code) {
        return redirectToClient({
          error: 'invalid_request',
          error_description: 'GitHub 沒有回傳 code',
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
      if (!exchange.scopes.some(scope => ORG_READ_SCOPES.includes(scope))) {
        return redirectToClient({
          error: 'insufficient_scope',
          error_description: '需要 read:org 權限才能確認組織成員身分',
        });
      }
      let profile: GithubProfile;
      try {
        profile = await fetchProfile(config, exchange.accessToken);
      } catch (error: unknown) {
        return redirectToClient({
          error: 'github_error',
          error_description: String(error),
        });
      }
      const membership = await checkMembership(
        config,
        exchange.accessToken,
        profile.login,
        c.env.GITHUB_ORG_TOKEN,
      );
      const org = config.githubOrg;
      switch (membership.status) {
        case 'active':
          break;
        case 'pending':
          return redirectToClient({
            error: 'org_membership_pending',
            error_description: `請先到 GitHub 接受 ${org} 的組織邀請`,
          });
        case 'not_member':
          return redirectToClient({
            error: 'not_org_member',
            error_description: `${profile.login} 不是 ${org} 成員。若你確定是成員，可能是組織啟用了 OAuth App 存取限制：請在 GitHub 授權頁對 ${org} 按 Request/Grant，或請 owner 核准本應用`,
          });
        case 'restricted':
          return redirectToClient({
            error: 'org_access_restricted',
            error_description: `${org} 啟用了 OAuth App 存取限制，請組織 owner 核准本應用後再登入`,
          });
        default:
          return redirectToClient({
            error: 'github_error',
            error_description: '無法向 GitHub 確認組織成員身分，請稍後再試',
          });
      }
      const userId = String(profile.id);
      const created = await hubFor(c.env, userId).createPendingSession({
        userId,
        profile,
        orgs: await fetchOrgs(config, exchange.accessToken),
        membership: {role: membership.role, via: membership.via},
        githubToken: exchange.accessToken,
        codeChallenge: state.codeChallenge,
        redirectUri: state.redirectUri,
        userAgent: userAgentOf(c),
      });
      if (!created.ok) {
        return redirectToClient({
          error: created.error.code,
          error_description: created.error.message,
        });
      }
      const code = await signToken(c.env.TOKEN_SECRET, 'ftc', {
        userId,
        sessionId: created.value.sessionId,
      });
      return redirectToClient({code});
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/token',
      tags: ['Auth'],
      summary: '用一次性登入碼 + code_verifier 換 access token',
      description:
        '登入碼 5 分鐘內有效且只能用一次。access token 為 30 天滑動有效期（有使用就延長）。',
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
                  .openapi({description: '必須與 authorize 時相同'}),
              }),
            },
          },
          required: true,
        },
      },
      responses: {
        200: jsonContent(tokenResponseSchema, '登入成功'),
        ...errorResponses(400, 403, 429),
      },
    }),
    async c => {
      await enforceLoginRateLimit(c);
      const body = c.req.valid('json');
      const claims = await verifyToken(c.env.TOKEN_SECRET, 'ftc', body.code);
      if (!claims) {
        throw new AppError(400, 'bad_request', '登入碼無效', {
          oauthError: 'invalid_grant',
        });
      }
      const account = unwrap(
        await hubFor(c.env, claims.userId).activateSession(
          claims.sessionId,
          body.code_verifier,
          body.redirect_uri,
          userAgentOf(c),
        ),
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
      summary: '登出目前 session',
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(z.object({revoked: z.boolean()}), '已登出'),
        ...errorResponses(401),
      },
    }),
    async c => {
      const {hub, sessionId} = c.get('auth');
      return c.json(unwrap(await hub.logout(sessionId)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/v1/auth/sessions',
      tags: ['Auth'],
      summary: '列出所有登入中的裝置與個人 token',
      security: BEARER_SECURITY,
      responses: {
        200: jsonContent(
          z.object({sessions: z.array(sessionSchema)}),
          'session 清單',
        ),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const {hub, sessionId} = c.get('auth');
      return c.json({sessions: unwrap(await hub.listSessions(sessionId))}, 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/v1/auth/sessions/{id}',
      tags: ['Auth'],
      summary: '撤銷某個 session（登出其他裝置或刪除個人 token）',
      security: BEARER_SECURITY,
      request: {params: z.object({id: z.string().max(64)})},
      responses: {
        200: jsonContent(z.object({revoked: z.boolean()}), '結果'),
        ...errorResponses(401, 403, 429),
      },
    }),
    async c => {
      const {hub, sessionId} = c.get('auth');
      const target = c.req.valid('param').id;
      return c.json(unwrap(await hub.revokeSession(sessionId, target)), 200);
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/v1/auth/tokens',
      tags: ['Auth'],
      summary: '建立個人存取 token（給 CLI、腳本、AI agent 測試用）',
      description:
        'token 只在建立時回傳一次。同樣受組織成員重驗與每日配額限制。',
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
          '已建立',
        ),
        ...errorResponses(400, 401, 403, 429),
      },
    }),
    async c => {
      const {hub, sessionId, userId} = c.get('auth');
      const body = c.req.valid('json');
      const session = unwrap(
        await hub.createPersonalToken(sessionId, body.name, body.expiresInDays),
      );
      const token = await signToken(c.env.TOKEN_SECRET, 'ftk', {
        userId,
        sessionId: session.id,
      });
      return c.json({token, session}, 201);
    },
  );
}
