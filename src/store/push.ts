import {and, asc, eq, inArray, lte} from 'drizzle-orm';
import type {AppConfig} from '../config';
import {inTransaction, type Database, type Executor} from '../db/client';
import {
  pushSubscriptions,
  reminders,
  users,
  type PushSubscriptionRow,
} from '../db/schema';
import {sha256Base64Url} from '../lib/crypto';
import {AppError} from '../lib/errors';
import {sendWebPush, type SendResult, type VapidConfig} from '../lib/webpush';
import {consumeQuota, tryConsumeQuota} from './quota';

const MAX_PUSH_SUBSCRIPTIONS = 10;
const PUSH_TTL_SECONDS = 3600;
/** Web Push topics are at most 32 base64url characters. */
const PUSH_TOPIC_LENGTH = 32;
const REMINDERS_PER_ROUND = 100;
/** Caps one cron run; later rounds pick up the rest a minute later. */
const MAX_REMINDER_ROUNDS = 10;

export interface PushSubscriptionInput {
  endpoint: string;
  keys: {p256dh: string; auth: string};
  device: string | null;
}

export interface PushDelivery {
  /** Origin of the push service endpoint. */
  endpoint: string;
  status: number;
  ok: boolean;
}

export interface TestPushResult {
  sent: number;
  results: PushDelivery[];
}

interface DeliveryReport {
  results: PushDelivery[];
  /** Endpoints the push service reported gone; they were deleted. */
  gone: Set<string>;
}

export async function addPushSubscription(
  db: Database,
  userId: number,
  subscription: PushSubscriptionInput,
  now: number,
): Promise<{subscriptions: number}> {
  return inTransaction(db, async tx => {
    // The user's row lock keeps concurrent registrations under the cap.
    await tx
      .select({id: users.id})
      .from(users)
      .where(eq(users.id, userId))
      .for('update');
    const existing = await tx
      .select({endpoint: pushSubscriptions.endpoint})
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    const exists = existing.some(row => row.endpoint === subscription.endpoint);
    if (!exists && existing.length >= MAX_PUSH_SUBSCRIPTIONS) {
      throw new AppError(
        409,
        'limit_exceeded',
        `最多 ${MAX_PUSH_SUBSCRIPTIONS} 个推送订阅`,
      );
    }
    const {p256dh, auth} = subscription.keys;
    await tx
      .insert(pushSubscriptions)
      .values({
        userId,
        endpoint: subscription.endpoint,
        p256dh,
        auth,
        device: subscription.device,
        createdAt: new Date(now),
      })
      .onConflictDoUpdate({
        target: [pushSubscriptions.userId, pushSubscriptions.endpoint],
        set: {p256dh, auth, device: subscription.device},
      });
    return {subscriptions: exists ? existing.length : existing.length + 1};
  });
}

export async function removePushSubscription(
  db: Executor,
  userId: number,
  endpoint: string,
): Promise<{removed: boolean}> {
  const deleted = await db
    .delete(pushSubscriptions)
    .where(
      and(
        eq(pushSubscriptions.userId, userId),
        eq(pushSubscriptions.endpoint, endpoint),
      ),
    )
    .returning({endpoint: pushSubscriptions.endpoint});
  return {removed: deleted.length > 0};
}

async function pushTo(
  subscription: PushSubscriptionRow,
  message: string,
  vapid: VapidConfig,
  topic: string,
): Promise<SendResult> {
  try {
    return await sendWebPush(
      {
        endpoint: subscription.endpoint,
        keys: {p256dh: subscription.p256dh, auth: subscription.auth},
      },
      message,
      vapid,
      {ttl: PUSH_TTL_SECONDS, urgency: 'high', topic},
    );
  } catch (error: unknown) {
    console.warn(
      JSON.stringify({
        msg: 'web push failed',
        userId: subscription.userId,
        error: String(error),
      }),
    );
    return {ok: false, status: 0, gone: false};
  }
}

/** Sends `message` to one user's subscriptions and deletes the gone ones. */
async function deliver(
  db: Executor,
  env: Env,
  userId: number,
  subscriptions: PushSubscriptionRow[],
  message: string,
  topicSeed: string,
): Promise<DeliveryReport> {
  const vapid: VapidConfig = {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
  // A newer message with the same topic replaces an undelivered older one.
  const topic = (await sha256Base64Url(topicSeed)).slice(0, PUSH_TOPIC_LENGTH);
  const sent = await Promise.all(
    subscriptions.map(subscription =>
      pushTo(subscription, message, vapid, topic),
    ),
  );
  const gone = new Set(
    subscriptions
      .filter((_, index) => sent[index]?.gone)
      .map(subscription => subscription.endpoint),
  );
  if (gone.size > 0) {
    await db
      .delete(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.userId, userId),
          inArray(pushSubscriptions.endpoint, [...gone]),
        ),
      );
  }
  return {
    results: subscriptions.map((subscription, index) => ({
      endpoint: new URL(subscription.endpoint).origin,
      status: sent[index]?.status ?? 0,
      ok: sent[index]?.ok ?? false,
    })),
    gone,
  };
}

export async function sendTestPush(
  db: Executor,
  env: Env,
  config: AppConfig,
  userId: number,
  now: number,
): Promise<TestPushResult> {
  const subscriptions = await db
    .select()
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId));
  if (subscriptions.length === 0) {
    throw new AppError(404, 'not_found', '没有推送订阅');
  }
  await consumeQuota(db, config, userId, 'pushes', subscriptions.length, now);
  const message = JSON.stringify({
    type: 'test',
    title: 'FurTodo',
    body: '推送测试成功 🎉',
    at: new Date(now).toISOString(),
  });
  const {results} = await deliver(
    db,
    env,
    userId,
    subscriptions,
    message,
    'test',
  );
  return {sent: subscriptions.length, results};
}

/**
 * Sends every reminder due by `now`. Each round claims a batch with
 * `SKIP LOCKED` and deletes it before sending, so overlapping cron runs never
 * send a reminder twice; a reminder whose push fails is not retried.
 */
export async function sendDueReminders(
  db: Database,
  env: Env,
  config: AppConfig,
  now: number,
): Promise<number> {
  let sent = 0;
  for (let round = 0; round < MAX_REMINDER_ROUNDS; round++) {
    const due = await inTransaction(db, async tx => {
      const claimed = await tx
        .select()
        .from(reminders)
        .where(lte(reminders.fireAt, new Date(now)))
        .orderBy(asc(reminders.fireAt))
        .limit(REMINDERS_PER_ROUND)
        .for('update', {skipLocked: true});
      if (claimed.length > 0) {
        await tx.delete(reminders).where(
          inArray(
            reminders.id,
            claimed.map(reminder => reminder.id),
          ),
        );
      }
      return claimed;
    });
    if (due.length === 0) break;
    const subscriptionsByUser = new Map<number, PushSubscriptionRow[]>();
    const rows = await db
      .select()
      .from(pushSubscriptions)
      .where(
        inArray(pushSubscriptions.userId, [
          ...new Set(due.map(reminder => reminder.userId)),
        ]),
      );
    for (const row of rows) {
      subscriptionsByUser.set(row.userId, [
        ...(subscriptionsByUser.get(row.userId) ?? []),
        row,
      ]);
    }
    for (const reminder of due) {
      const {userId} = reminder;
      const subscriptions = subscriptionsByUser.get(userId) ?? [];
      if (subscriptions.length === 0) continue;
      const allowed = await tryConsumeQuota(
        db,
        config,
        userId,
        'pushes',
        subscriptions.length,
        now,
      );
      if (!allowed) {
        console.warn(
          JSON.stringify({
            msg: 'push quota exhausted; reminder dropped',
            userId,
            taskId: reminder.taskId,
          }),
        );
        continue;
      }
      const message = JSON.stringify({
        type: 'reminder',
        taskId: reminder.taskId,
        reminderId: reminder.reminderId,
        ...reminder.payload,
        at: reminder.fireAt.toISOString(),
      });
      const {gone} = await deliver(
        db,
        env,
        userId,
        subscriptions,
        message,
        reminder.taskId,
      );
      subscriptionsByUser.set(
        userId,
        subscriptions.filter(subscription => !gone.has(subscription.endpoint)),
      );
      sent++;
    }
    if (due.length < REMINDERS_PER_ROUND) break;
  }
  return sent;
}
