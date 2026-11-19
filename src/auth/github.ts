import type {AppConfig} from '../config';

export interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
  /** ISO 8601 timestamp of account creation. */
  createdAt: string;
}

export type CodeExchangeResult =
  {ok: true; accessToken: string} | {ok: false; error: string};

/** Result of reading the profile behind an OAuth token. */
export type ProfileResult =
  | {status: 'ok'; profile: GithubProfile}
  | {status: 'token_invalid'}
  | {status: 'unavailable'; detail: string};

// Field names below follow the GitHub REST API.
interface TokenResponseJson {
  access_token?: string;
  error?: string;
  error_description?: string;
}

interface UserJson {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  created_at: string;
}

const API_VERSION = '2022-11-28';
const USER_AGENT = 'furtodo-server';
const TIMEOUT_MS = 10_000;
const MS_PER_DAY = 86_400_000;

function apiHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
  };
}

export async function exchangeCode(
  config: AppConfig,
  clientId: string,
  clientSecret: string,
  code: string,
  codeVerifier: string,
): Promise<CodeExchangeResult> {
  const response = await fetch(
    `${config.githubOAuthBase}/login/oauth/access_token`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: `${config.publicBaseUrl}/v1/auth/github/callback`,
        code_verifier: codeVerifier,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  if (!response.ok) {
    return {ok: false, error: `token endpoint HTTP ${response.status}`};
  }
  const body = await response.json<TokenResponseJson>();
  if (!body.access_token) {
    return {
      ok: false,
      error: body.error_description ?? body.error ?? 'no access_token',
    };
  }
  return {ok: true, accessToken: body.access_token};
}

/**
 * Reads the authenticated user. `GET /user` needs no scope, and `created_at`
 * is public, so the OAuth app never asks for organization access.
 */
export async function fetchProfile(
  config: AppConfig,
  token: string,
): Promise<ProfileResult> {
  let response: Response;
  try {
    response = await fetch(`${config.githubApiBase}/user`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error: unknown) {
    return {status: 'unavailable', detail: String(error)};
  }
  if (response.status === 401) return {status: 'token_invalid'};
  if (!response.ok) {
    return {status: 'unavailable', detail: `GET /user HTTP ${response.status}`};
  }
  const user = await response.json<UserJson>();
  return {
    status: 'ok',
    profile: {
      id: user.id,
      login: user.login,
      name: user.name,
      avatarUrl: user.avatar_url,
      createdAt: user.created_at,
    },
  };
}

/** Returns whole days since the account was created; negative on skew. */
export function accountAgeDays(createdAt: string, now = Date.now()): number {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, Math.floor((now - created) / MS_PER_DAY));
}
