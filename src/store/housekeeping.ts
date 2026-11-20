import {and, eq, isNull, lt, or} from 'drizzle-orm';
import type {AppConfig} from '../config';
import {inTransaction, type Database} from '../db/client';
import {entities, sessions, usageDays, users} from '../db/schema';
import {TOMBSTONE_RETENTION_MS} from '../domain/model';
import {addDays} from '../lib/time';
import {quotaDay} from './quota';

const USAGE_HISTORY_DAYS = 14;
/** Users whose trash is purged per run; the next run continues. */
const PURGE_USERS_PER_RUN = 200;

/**
 * Deletes trash older than the retention period, one user per transaction,
 * and records the newest purged stamp so older sync cursors resync.
 */
async function purgeTrash(db: Database, now: number): Promise<void> {
  const cutoff = new Date(now - TOMBSTONE_RETENTION_MS);
  const owners = await db
    .selectDistinct({userId: entities.userId})
    .from(entities)
    .where(lt(entities.deletedAt, cutoff))
    .limit(PURGE_USERS_PER_RUN);
  for (const {userId} of owners) {
    await inTransaction(db, async tx => {
      // Writers lock the user's row before its entities; so does the purge.
      await tx
        .select({id: users.id})
        .from(users)
        .where(eq(users.id, userId))
        .for('update');
      const purged = await tx
        .delete(entities)
        .where(and(eq(entities.userId, userId), lt(entities.deletedAt, cutoff)))
        .returning({updatedAt: entities.updatedAt});
      const newest = purged.reduce(
        (max, row) => Math.max(max, row.updatedAt.getTime()),
        0,
      );
      if (newest === 0) return;
      const purgedThrough = new Date(newest);
      await tx
        .update(users)
        .set({purgedThrough})
        .where(
          and(
            eq(users.id, userId),
            or(
              isNull(users.purgedThrough),
              lt(users.purgedThrough, purgedThrough),
            ),
          ),
        );
    });
  }
}

/** Purges expired sessions, old quota days, and trash past retention. */
export async function purgeExpiredData(
  db: Database,
  config: AppConfig,
  now: number,
): Promise<void> {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date(now)));
  const oldestKeptDay = addDays(quotaDay(config, now), -USAGE_HISTORY_DAYS);
  await db.delete(usageDays).where(lt(usageDays.day, oldestKeptDay));
  await purgeTrash(db, now);
}
