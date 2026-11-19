import type {AppConfig} from '../config';

export interface GithubProfile {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

export interface OrgSummary {
  login: string;
  avatarUrl: string;
}

export type OrgRole = 'admin' | 'member';
/** Which token proved the membership. */
export type MembershipSource = 'user_token' | 'org_token';

export type MembershipResult =
  | {status: 'active'; role: OrgRole; via: MembershipSource}
  | {status: 'pending'}
  | {status: 'not_member'}
  | {status: 'restricted'}
  | {status: 'token_invalid'}
  | {status: 'unavailable'; detail: string};

export type CodeExchangeResult =
  | {ok: true; accessToken: string; scopes: string[]}
  | {ok: false; error: string};

// Field names below follow the GitHub REST API.
interface TokenResponseJson {
  access_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface UserJson {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
}

interface OrgJson {
  login: string;
  avatar_url: string;
}

interface MembershipJson {
  state?: string;
  role?: string;
}

const API_VERSION = '2022-11-28';
const USER_AGENT = 'furtodo-server';
const TIMEOUT_MS = 10_000;
const ORGS_PAGE_SIZE = 100;

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
  return {
    ok: true,
    accessToken: body.access_token,
    scopes: (body.scope ?? '').split(/[,\s]+/).filter(Boolean),
  };
}

export async function fetchProfile(
  config: AppConfig,
  token: string,
): Promise<GithubProfile> {
  const response = await fetch(`${config.githubApiBase}/user`, {
    headers: apiHeaders(token),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`GET /user HTTP ${response.status}`);
  const user = await response.json<UserJson>();
  return {
    id: user.id,
    login: user.login,
    name: user.name,
    avatarUrl: user.avatar_url,
  };
}

/**
 * Returns the user's organizations, private memberships included (needs
 * read:org). Display-only, so failures yield an empty list.
 */
export async function fetchOrgs(
  config: AppConfig,
  token: string,
): Promise<OrgSummary[]> {
  let orgs: OrgJson[];
  try {
    const response = await fetch(
      `${config.githubApiBase}/user/orgs?per_page=${ORGS_PAGE_SIZE}`,
      {headers: apiHeaders(token), signal: AbortSignal.timeout(TIMEOUT_MS)},
    );
    if (!response.ok) return [];
    orgs = await response.json<OrgJson[]>();
  } catch {
    return [];
  }
  return orgs.map(org => ({login: org.login, avatarUrl: org.avatar_url}));
}

/**
 * Checks org membership with the user's own token via
 * `GET /user/memberships/orgs/{org}`, which also sees private memberships.
 * When the org's OAuth app restrictions hide it (403/404) and an org token is
 * configured, falls back to `GET /orgs/{org}/members/{login}`.
 */
export async function checkMembership(
  config: AppConfig,
  userToken: string,
  login: string,
  orgToken?: string,
): Promise<MembershipResult> {
  const org = encodeURIComponent(config.githubOrg);
  let response: Response;
  try {
    response = await fetch(
      `${config.githubApiBase}/user/memberships/orgs/${org}`,
      {headers: apiHeaders(userToken), signal: AbortSignal.timeout(TIMEOUT_MS)},
    );
  } catch (error: unknown) {
    return {status: 'unavailable', detail: String(error)};
  }
  if (response.status === 200) {
    const membership = await response.json<MembershipJson>();
    if (membership.state === 'active') {
      return {
        status: 'active',
        role: membership.role === 'admin' ? 'admin' : 'member',
        via: 'user_token',
      };
    }
    return membership.state === 'pending'
      ? {status: 'pending'}
      : {status: 'not_member'};
  }
  if (response.status === 401) return {status: 'token_invalid'};
  if (response.status === 403 || response.status === 404) {
    if (orgToken) return checkWithOrgToken(config, orgToken, login);
    return response.status === 403
      ? {status: 'restricted'}
      : {status: 'not_member'};
  }
  return {status: 'unavailable', detail: `membership HTTP ${response.status}`};
}

async function checkWithOrgToken(
  config: AppConfig,
  orgToken: string,
  login: string,
): Promise<MembershipResult> {
  const org = encodeURIComponent(config.githubOrg);
  let response: Response;
  try {
    response = await fetch(
      `${config.githubApiBase}/orgs/${org}/members/${encodeURIComponent(login)}`,
      {
        headers: apiHeaders(orgToken),
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
  } catch (error: unknown) {
    return {status: 'unavailable', detail: String(error)};
  }
  if (response.status === 204) {
    return {status: 'active', role: 'member', via: 'org_token'};
  }
  if (response.status === 404) return {status: 'not_member'};
  return {
    status: 'unavailable',
    detail: `org-token membership HTTP ${response.status}`,
  };
}
