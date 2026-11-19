import {isValidTimeZone} from './lib/time';

export type QuotaKind =
  'requests' | 'reads' | 'writes' | 'lists' | 'logins' | 'pushes';
export type QuotaCounts = Record<QuotaKind, number>;

export interface AppConfig {
  publicBaseUrl: string;
  minAccountAgeDays: number;
  githubApiBase: string;
  githubOAuthBase: string;
  allowedRedirects: string[];
  /** Zone whose midnight resets the daily quotas. */
  quotaTimeZone: string;
  dailyQuota: QuotaCounts;
  maxEntities: number;
}

const MIN_TOKEN_SECRET_LENGTH = 32;

function parsePositiveInt(name: string, raw: string): number {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Config ${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function trimTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, '');
}

/** Validates the Worker vars eagerly; a bad value fails instead of defaulting. */
export function readConfig(env: Env): AppConfig {
  if (!isValidTimeZone(env.QUOTA_TIMEZONE)) {
    throw new Error(
      `Config QUOTA_TIMEZONE is not an IANA zone: ${env.QUOTA_TIMEZONE}`,
    );
  }
  if (!env.TOKEN_SECRET || env.TOKEN_SECRET.length < MIN_TOKEN_SECRET_LENGTH) {
    throw new Error(
      `Secret TOKEN_SECRET must be at least ${MIN_TOKEN_SECRET_LENGTH} chars`,
    );
  }
  return {
    publicBaseUrl: trimTrailingSlashes(env.PUBLIC_BASE_URL),
    minAccountAgeDays: parsePositiveInt(
      'MIN_ACCOUNT_AGE_DAYS',
      env.MIN_ACCOUNT_AGE_DAYS,
    ),
    githubApiBase: trimTrailingSlashes(env.GITHUB_API_BASE),
    githubOAuthBase: trimTrailingSlashes(env.GITHUB_OAUTH_BASE),
    allowedRedirects: env.ALLOWED_REDIRECT_URIS.split(',')
      .map(pattern => pattern.trim())
      .filter(Boolean),
    quotaTimeZone: env.QUOTA_TIMEZONE,
    dailyQuota: {
      requests: parsePositiveInt(
        'QUOTA_REQUESTS_PER_DAY',
        env.QUOTA_REQUESTS_PER_DAY,
      ),
      reads: parsePositiveInt(
        'QUOTA_KV_READS_PER_DAY',
        env.QUOTA_KV_READS_PER_DAY,
      ),
      writes: parsePositiveInt(
        'QUOTA_KV_WRITES_PER_DAY',
        env.QUOTA_KV_WRITES_PER_DAY,
      ),
      lists: parsePositiveInt(
        'QUOTA_KV_LISTS_PER_DAY',
        env.QUOTA_KV_LISTS_PER_DAY,
      ),
      logins: parsePositiveInt(
        'QUOTA_LOGINS_PER_DAY',
        env.QUOTA_LOGINS_PER_DAY,
      ),
      pushes: parsePositiveInt('QUOTA_PUSH_PER_DAY', env.QUOTA_PUSH_PER_DAY),
    },
    maxEntities: parsePositiveInt('LIMIT_MAX_ENTITIES', env.LIMIT_MAX_ENTITIES),
  };
}
