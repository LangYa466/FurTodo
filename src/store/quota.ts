import {and, eq, lte, sql, type SQL} from 'drizzle-orm';
import type {AppConfig, QuotaCounts, QuotaKind} from '../config';
import type {Executor} from '../db/client';
import {usageDays, users, type UsageDayRow} from '../db/schema';
import {AppError} from '../lib/errors';
import {localDate, nextMidnightInstant} from '../lib/time';

/** Live entity count, reported against its limit. */
export interface EntityTotals {
  entities: number;
}

/** Today's usage, its limits, and when the counters reset. */
export interface UsageView {
  day: string;
  timeZone: string;
  resetAt: string;
  used: QuotaCounts;
  limits: QuotaCounts;
  totals: EntityTotals;
  totalLimits: EntityTotals;
}

const COUNTERS = {
  requests: usageDays.requests,
  reads: usageDays.reads,
  writes: usageDays.writes,
  logins: usageDays.logins,
  pushes: usageDays.pushes,
} as const;

/** Returns the quota day of `now`: the date in QUOTA_TIMEZONE. */
export function quotaDay(config: AppConfig, now: number): string {
  return localDate(now, config.quotaTimeZone);
}

/** Returns a day's counts; days without a row used nothing. */
export function countsOf(row: UsageDayRow | null | undefined): QuotaCounts {
  return {
    requests: row?.requests ?? 0,
    reads: row?.reads ?? 0,
    writes: row?.writes ?? 0,
    logins: row?.logins ?? 0,
    pushes: row?.pushes ?? 0,
  };
}

/** Builds the 429 for an exhausted quota, with seconds until it resets. */
export function quotaExceeded(
  config: AppConfig,
  kind: QuotaKind,
  now: number,
): AppError {
  const limit = config.dailyQuota[kind];
  const resetAt = nextMidnightInstant(now, config.quotaTimeZone);
  return new AppError(
    429,
    'quota_exceeded',
    `今日 ${kind} 配额已用完（每日上限 ${limit}）`,
    {kind, limit, resetAt: new Date(resetAt).toISOString()},
    Math.ceil((resetAt - now) / 1000),
  );
}

/**
 * Adds `amount` to today's counter. With `limit`, the row only changes while
 * the total stays within it; returns the new total, or null if it would not.
 */
async function addToCounter(
  db: Executor,
  config: AppConfig,
  userId: number,
  kind: QuotaKind,
  amount: number,
  now: number,
  limit: number | null,
): Promise<number | null> {
  const counter = COUNTERS[kind];
  const initial: Partial<QuotaCounts> = {[kind]: amount};
  const increment: Partial<Record<QuotaKind, SQL>> = {
    [kind]: sql`${counter} + ${amount}`,
  };
  const [row] = await db
    .insert(usageDays)
    .values({userId, day: quotaDay(config, now), ...initial})
    .onConflictDoUpdate({
      target: [usageDays.userId, usageDays.day],
      set: increment,
      setWhere: limit === null ? undefined : lte(counter, limit - amount),
    })
    .returning({used: counter});
  return row?.used ?? null;
}

/**
 * Charges `amount` against today's limit; throws `quota_exceeded` if it
 * does not fit.
 */
export async function consumeQuota(
  db: Executor,
  config: AppConfig,
  userId: number,
  kind: QuotaKind,
  amount: number,
  now: number,
): Promise<number> {
  const limit = config.dailyQuota[kind];
  const used =
    amount > limit
      ? null
      : await addToCounter(db, config, userId, kind, amount, now, limit);
  if (used === null) throw quotaExceeded(config, kind, now);
  return used;
}

/** Charges `amount` if it fits in today's limit; returns whether it did. */
export async function tryConsumeQuota(
  db: Executor,
  config: AppConfig,
  userId: number,
  kind: QuotaKind,
  amount: number,
  now: number,
): Promise<boolean> {
  const limit = config.dailyQuota[kind];
  if (amount > limit) return false;
  const used = await addToCounter(db, config, userId, kind, amount, now, limit);
  return used !== null;
}

/** Records work that already happened, even past the limit. */
export async function recordUsage(
  db: Executor,
  config: AppConfig,
  userId: number,
  kind: QuotaKind,
  amount: number,
  now: number,
): Promise<void> {
  if (amount <= 0) return;
  await addToCounter(db, config, userId, kind, amount, now, null);
}

/** Returns today's usage and the entity totals shown to the user. */
export async function usageView(
  db: Executor,
  config: AppConfig,
  userId: number,
  now: number,
): Promise<UsageView> {
  const day = quotaDay(config, now);
  const [row] = await db
    .select({liveEntityCount: users.liveEntityCount, usage: usageDays})
    .from(users)
    .leftJoin(
      usageDays,
      and(eq(usageDays.userId, users.id), eq(usageDays.day, day)),
    )
    .where(eq(users.id, userId));
  return {
    day,
    timeZone: config.quotaTimeZone,
    resetAt: new Date(
      nextMidnightInstant(now, config.quotaTimeZone),
    ).toISOString(),
    used: countsOf(row?.usage),
    limits: {...config.dailyQuota},
    totals: {entities: row?.liveEntityCount ?? 0},
    totalLimits: {entities: config.maxEntities},
  };
}
