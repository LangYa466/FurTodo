import {createScheduledController} from 'cloudflare:test';
import {env, exports} from 'cloudflare:workers';
import {drizzle, type NodePgDatabase} from 'drizzle-orm/node-postgres';
import {Client} from 'pg';
import {vi} from 'vitest';
import worker from '../../src/index';

export const BASE = 'https://todo.example.com';
export const CLIENT_REDIRECT = 'http://localhost:5173/auth/callback';

/** Days since the mocked GitHub account was created. */
export type AccountAgeMock = number;

export const OLD_ENOUGH_DAYS = 1000;
export const TOO_NEW_DAYS = 30;

const MS_PER_DAY = 86_400_000;
const UNIQUE_ID_BASE = 1_000_000_000;

interface GithubUserMock {
  id: number;
  login: string;
  accountAgeDays: AccountAgeMock;
}

/** ISO timestamp for an account created `days` ago. */
function createdAtFor(days: number): string {
  return new Date(Date.now() - days * MS_PER_DAY).toISOString();
}

const usersByCode = new Map<string, GithubUserMock>();
const usersByToken = new Map<string, GithubUserMock>();
/** While true, the GitHub API answers 503. */
let githubDown = false;
/** Requests the mocked push service has received. */
export const pushCalls: Array<{
  url: string;
  headers: Headers;
  bodyLength: number;
}> = [];
/** Push service response status per endpoint URL. */
export const pushStatus = new Map<string, number>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  });
}

const realFetch = globalThis.fetch;

/**
 * Intercepts outbound requests to GitHub (gh.test, gh-api.test) and the push
 * service (push.test).
 */
export function installFetchMock(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (
        url.host === 'gh.test' &&
        url.pathname === '/login/oauth/access_token'
      ) {
        const body: {
          code: string;
          code_verifier?: string;
        } = await request.json();
        const user = usersByCode.get(body.code);
        if (!user || !body.code_verifier) {
          return json({error: 'bad_verification_code'});
        }
        const token = `gho_${user.id}`;
        usersByToken.set(token, user);
        return json({access_token: token, scope: 'read:user'});
      }
      if (url.host === 'gh-api.test') {
        if (githubDown) return json({message: 'Service Unavailable'}, 503);
        const user = usersByToken.get(
          (request.headers.get('authorization') ?? '').replace('Bearer ', ''),
        );
        if (!user) return json({message: 'Bad credentials'}, 401);
        if (url.pathname === '/user') {
          return json({
            id: user.id,
            login: user.login,
            name: user.login.toUpperCase(),
            avatar_url: `https://avatars.githubusercontent.com/u/${user.id}`,
            created_at: createdAtFor(user.accountAgeDays),
          });
        }
        return json({message: 'Not Found'}, 404);
      }
      if (url.host === 'push.test') {
        pushCalls.push({
          url: request.url,
          headers: request.headers,
          bodyLength: (await request.arrayBuffer()).byteLength,
        });
        return new Response(null, {status: pushStatus.get(request.url) ?? 201});
      }
      return realFetch(input, init);
    },
  );
}

/** Calls the Worker's default export with an optional bearer token. */
export function api(
  path: string,
  init: RequestInit & {token?: string} = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (
    init.body &&
    typeof init.body === 'string' &&
    !headers.has('content-type')
  ) {
    headers.set('content-type', 'application/json');
  }
  return exports.default.fetch(
    new Request(`${BASE}${path}`, {...init, headers, redirect: 'manual'}),
  );
}

export async function apiJson<T = Record<string, unknown>>(
  path: string,
  init: RequestInit & {token?: string} = {},
): Promise<{status: number; body: T; headers: Headers}> {
  const res = await api(path, init);
  const text = await res.text();
  return {
    status: res.status,
    // JSON.parse yields any, so the caller's generic is asserted here.
    body: (text ? JSON.parse(text) : null) as T,
    headers: res.headers,
  };
}

function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...arr))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

export async function pkcePair(): Promise<{
  verifier: string;
  challenge: string;
}> {
  const verifier = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64UrlEncode(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)),
  );
  return {verifier, challenge};
}

/** Runs authorize through callback and returns the client redirect URL. */
export async function authorizeAndCallback(
  user: GithubUserMock,
  challenge: string,
  clientState = 'client-state',
): Promise<URL> {
  const code = `code-${user.id}-${crypto.randomUUID()}`;
  usersByCode.set(code, user);
  const q = new URLSearchParams({
    redirect_uri: CLIENT_REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: clientState,
  });
  const authorize = await api(`/v1/auth/github/authorize?${q}`);
  if (authorize.status !== 302) {
    throw new Error(`authorize ${authorize.status}: ${await authorize.text()}`);
  }
  const githubLocation = authorize.headers.get('location');
  if (!githubLocation) throw new Error('authorize redirect has no location');
  const github = new URL(githubLocation);
  const state = github.searchParams.get('state');
  if (!state) throw new Error('authorize redirect has no state');
  const callback = await api(
    `/v1/auth/github/callback?${new URLSearchParams({code, state})}`,
  );
  if (callback.status !== 302) {
    throw new Error(`callback ${callback.status}: ${await callback.text()}`);
  }
  const callbackLocation = callback.headers.get('location');
  if (!callbackLocation) throw new Error('callback redirect has no location');
  return new URL(callbackLocation);
}

/** Runs the full OAuth + PKCE flow and returns a bearer token. */
export async function login(
  id: number,
  login = `user${id}`,
  accountAgeDays: AccountAgeMock = OLD_ENOUGH_DAYS,
): Promise<string> {
  const {verifier, challenge} = await pkcePair();
  const back = await authorizeAndCallback(
    {id, login, accountAgeDays},
    challenge,
  );
  const code = back.searchParams.get('code');
  if (!code) throw new Error(`login failed: ${back}`);
  const {status, body} = await apiJson<{access_token: string}>(
    '/v1/auth/token',
    {
      method: 'POST',
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: CLIENT_REDIRECT,
      }),
    },
  );
  if (status !== 200) {
    throw new Error(`token ${status}: ${JSON.stringify(body)}`);
  }
  return body.access_token;
}

/**
 * Returns a GitHub user id for one test. Ids are random so tests never share
 * users, even against a database reused through TEST_DATABASE_URL.
 */
export function uniqueUserId(): number {
  return UNIQUE_ID_BASE + Math.floor(Math.random() * UNIQUE_ID_BASE);
}

/** Makes GitHub reject every OAuth token issued to the user. */
export function revokeGithubTokens(userId: number): void {
  for (const [token, user] of usersByToken) {
    if (user.id === userId) usersByToken.delete(token);
  }
}

export function setGithubDown(down: boolean): void {
  githubDown = down;
}

/** Runs the Worker's cron handler as if `cron` had fired. */
export async function runCron(cron: string): Promise<void> {
  await worker.scheduled(createScheduledController({cron}), env);
}

/** Runs `work` on a direct database connection, to arrange test state. */
export async function withTestDatabase<T>(
  work: (db: NodePgDatabase) => Promise<T>,
): Promise<T> {
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
  });
  // pg-cloudflare reports its own socket closing as an error after end().
  client.on('error', () => undefined);
  await client.connect();
  try {
    return await work(drizzle({client}));
  } finally {
    await client.end();
  }
}
