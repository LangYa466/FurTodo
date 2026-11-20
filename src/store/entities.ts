import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
} from 'drizzle-orm';
import type {Executor} from '../db/client';
import {entities, users, type EntityRow} from '../db/schema';
import {taskDataOf, type Kind, type StoredEntity} from '../domain/model';
import {
  HIGH_PRIORITY,
  IMPORTANT_QUADRANTS,
  SUGGESTION_LOOKAHEAD_DAYS,
  type TaskQuery,
} from '../domain/views';
import {addDays, startOfDayInstant} from '../lib/time';

/** Filter conditions; undefined ones are skipped by `and`. */
export type Conditions = Array<SQL | undefined>;

/** Column values of an entity, including the task fields queries filter on. */
export function entityRow(
  userId: number,
  entity: StoredEntity,
): typeof entities.$inferInsert {
  const task = entity.kind === 'task' ? taskDataOf(entity) : null;
  return {
    userId,
    kind: entity.kind,
    id: entity.id,
    data: entity.data,
    clock: entity.clock,
    rev: entity.rev,
    createdAt: new Date(entity.createdAt),
    updatedAt: new Date(entity.updatedAt),
    deletedAt: entity.deletedAt === null ? null : new Date(entity.deletedAt),
    deletedVia: entity.deletedVia,
    listId: task?.listId ?? null,
    dueDate: task?.dueDate ?? null,
    myDay: task?.myDay ?? null,
    completedAt: task?.completedAt ? new Date(task.completedAt) : null,
    priority: task?.priority ?? null,
    quadrant: task?.quadrant ?? null,
  };
}

/** Returns the domain entity a stored row carries. */
export function storedEntity(row: EntityRow): StoredEntity {
  return {
    kind: row.kind,
    id: row.id,
    data: row.data,
    clock: row.clock,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    deletedAt: row.deletedAt?.getTime() ?? null,
    deletedVia: row.deletedVia,
    rev: row.rev,
  };
}

/** Returns one entity of `kind`, or null when the user has no such entity. */
export async function findEntity(
  db: Executor,
  userId: number,
  kind: Kind,
  id: string,
): Promise<StoredEntity | null> {
  const [row] = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.kind, kind),
        eq(entities.id, id),
      ),
    );
  return row ? storedEntity(row) : null;
}

/** Returns the entities of one kind that are not in the trash. */
export async function findLiveEntities(
  db: Executor,
  userId: number,
  kind: Kind,
): Promise<StoredEntity[]> {
  const rows = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.kind, kind),
        isNull(entities.deletedAt),
      ),
    );
  return rows.map(storedEntity);
}

/** Returns every task of the user matching `conditions`. */
export async function findTasks(
  db: Executor,
  userId: number,
  conditions: Conditions,
): Promise<StoredEntity[]> {
  const rows = await db
    .select()
    .from(entities)
    .where(
      and(
        eq(entities.userId, userId),
        eq(entities.kind, 'task'),
        ...conditions,
      ),
    );
  return rows.map(storedEntity);
}

/** Returns everything in the trash, most recently deleted first. */
export async function findTrash(
  db: Executor,
  userId: number,
): Promise<StoredEntity[]> {
  const rows = await db
    .select()
    .from(entities)
    .where(and(eq(entities.userId, userId), isNotNull(entities.deletedAt)))
    .orderBy(desc(entities.deletedAt));
  return rows.map(storedEntity);
}

/** Returns the conditions that select tasks neither deleted nor completed. */
export function openTasks(): Conditions {
  return [isNull(entities.deletedAt), isNull(entities.completedAt)];
}

/** Tasks the today view of `date` may show; the view filters them further. */
export function todayCandidates(date: string, timeZone: string): Conditions {
  const dayStart = new Date(startOfDayInstant(date, timeZone));
  const dayEnd = new Date(startOfDayInstant(addDays(date, 1), timeZone));
  const horizon = addDays(date, SUGGESTION_LOOKAHEAD_DAYS);
  return [
    isNull(entities.deletedAt),
    or(
      and(
        gte(entities.completedAt, dayStart),
        lt(entities.completedAt, dayEnd),
      ),
      and(
        isNull(entities.completedAt),
        or(
          lte(entities.myDay, date),
          lte(entities.dueDate, horizon),
          eq(entities.priority, HIGH_PRIORITY),
          inArray(entities.quadrant, IMPORTANT_QUADRANTS),
        ),
      ),
    ),
  ];
}

/**
 * Open tasks due before `until`, which covers the upcoming view and
 * overdue.
 */
export function dueBefore(until: string): Conditions {
  return [...openTasks(), lt(entities.dueDate, until)];
}

function completionCondition(status: TaskQuery['status']): SQL | undefined {
  switch (status) {
    case 'open':
      return isNull(entities.completedAt);
    case 'completed':
      return isNotNull(entities.completedAt);
    default:
      return undefined;
  }
}

/** The task query conditions the columns can answer; the rest run in memory. */
export function taskQueryConditions(query: TaskQuery): Conditions {
  return [
    query.includeDeleted ? undefined : isNull(entities.deletedAt),
    completionCondition(query.status),
    query.listId === undefined ? undefined : eq(entities.listId, query.listId),
    query.inboxOnly ? isNull(entities.listId) : undefined,
    query.dueFrom ? gte(entities.dueDate, query.dueFrom) : undefined,
    query.dueTo ? lte(entities.dueDate, query.dueTo) : undefined,
    query.priority === undefined
      ? undefined
      : eq(entities.priority, query.priority),
    query.quadrant === undefined
      ? undefined
      : eq(entities.quadrant, query.quadrant),
    query.myDay === undefined ? undefined : eq(entities.myDay, query.myDay),
  ];
}

/**
 * Position in a user's change feed, which is ordered by (stamp, kind, id).
 * `last` is the last change sent at `stamp`, or null once every change up to
 * and including `stamp` was sent.
 */
export interface SyncCursor {
  stamp: number;
  last: {kind: Kind; id: string} | null;
}

/** One page of a sync pull: changes, the next cursor, and expiry. */
export interface PullPage {
  changes: StoredEntity[];
  hasMore: boolean;
  next: SyncCursor;
  /** Deletions the client never saw were purged; it must resync. */
  expired: boolean;
}

function changedAfter(cursor: SyncCursor): SQL | undefined {
  const at = new Date(cursor.stamp);
  if (!cursor.last) return gt(entities.updatedAt, at);
  const {kind, id} = cursor.last;
  return or(
    gt(entities.updatedAt, at),
    and(
      eq(entities.updatedAt, at),
      or(
        gt(entities.kind, kind),
        and(eq(entities.kind, kind), gt(entities.id, id)),
      ),
    ),
  );
}

function isExpired(cursor: SyncCursor, purgedThrough: Date | null): boolean {
  if (!purgedThrough) return false;
  const purged = purgedThrough.getTime();
  return cursor.last ? purged >= cursor.stamp : purged > cursor.stamp;
}

/**
 * Reads the changes after `cursor`, or every live entity without one.
 *
 * Write transactions lock the user's row and take stamps above its
 * `last_stamp`, so stamps commit in order. The user's row is joined into the
 * same statement: a page that reaches the end advances the cursor to the
 * `last_stamp` of that snapshot, and later commits all sort after it.
 */
export async function pullChanges(
  db: Executor,
  userId: number,
  cursor: SyncCursor | null,
  limit: number,
): Promise<PullPage> {
  const rows = await db
    .select({
      lastStamp: users.lastStamp,
      purgedThrough: users.purgedThrough,
      entity: entities,
    })
    .from(users)
    .leftJoin(
      entities,
      and(
        eq(entities.userId, users.id),
        cursor ? changedAfter(cursor) : isNull(entities.deletedAt),
      ),
    )
    .where(eq(users.id, userId))
    .orderBy(asc(entities.updatedAt), asc(entities.kind), asc(entities.id))
    .limit(limit + 1);
  const head = rows[0];
  if (!head) throw new Error(`User ${userId} has no row`);
  if (cursor && isExpired(cursor, head.purgedThrough)) {
    return {changes: [], hasMore: false, next: cursor, expired: true};
  }
  const changed = rows.flatMap(row =>
    row.entity ? [storedEntity(row.entity)] : [],
  );
  const hasMore = changed.length > limit;
  const changes = changed.slice(0, limit);
  const last = changes.at(-1);
  const next: SyncCursor =
    hasMore && last
      ? {stamp: last.updatedAt, last: {kind: last.kind, id: last.id}}
      : {stamp: head.lastStamp.getTime(), last: null};
  return {changes, hasMore, next, expired: false};
}
