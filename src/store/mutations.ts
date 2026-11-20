import {and, eq, inArray, isNull, or, sql, type SQL} from 'drizzle-orm';
import type {AnyPgColumn} from 'drizzle-orm/pg-core';
import type {ContentfulStatusCode} from 'hono/utils/http-status';
import type {AppConfig} from '../config';
import {inTransaction, type Database, type Executor} from '../db/client';
import {
  entities,
  reminders,
  usageDays,
  users,
  type ReminderPayload,
} from '../db/schema';
import {
  REQUIRED_ON_CREATE,
  SETTINGS_ID,
  mergePatch,
  newEntity,
  settingsFrom,
  taskDataOf,
  toApiEntity,
  type ApiEntity,
  type Kind,
  type Settings,
  type StoredEntity,
} from '../domain/model';
import {AppError, type ErrorCode} from '../lib/errors';
import {nameBasedUuid, uuidV7} from '../lib/ids';
import {
  firstOccurrenceOnOrAfter,
  nextOccurrence,
  normalizeRecurrence,
} from '../lib/recurrence';
import {
  addDays,
  diffDays,
  localDate,
  zonedParts,
  zonedToInstant,
} from '../lib/time';
import {entityRow, storedEntity} from './entities';
import {quotaDay, quotaExceeded, recordUsage} from './quota';

export type MutationOp = 'upsert' | 'delete' | 'restore';

export interface ValidatedMutation {
  op: MutationOp;
  type: Kind;
  id: string;
  /** Zod-validated, normalized patch; upserts only. */
  data?: Record<string, unknown>;
  /** Client edit time in epoch ms, used for last-writer-wins. */
  editedAt?: number;
  /** Set by REST PATCH: a missing entity is a 404 instead of a create. */
  mustExist?: boolean;
}

export interface MutationError {
  code: ErrorCode;
  message: string;
  status: ContentfulStatusCode;
  retryAfter?: number;
}

export interface MutationOutcome {
  index: number;
  type: Kind;
  id: string;
  op: MutationOp;
  status: 'applied' | 'noop' | 'rejected';
  entity: ApiEntity | null;
  /** Next occurrences created by completing a recurring task. */
  spawned: ApiEntity[];
  error: MutationError | null;
}

/** Rows per multi-row statement; Postgres binds at most 65535 parameters. */
const ROWS_PER_STATEMENT = 500;
/** Reminders up to this far in the past still fire (right away). */
const REMINDER_PAST_TOLERANCE_MS = 60_000;

interface Effect {
  status: 'applied' | 'noop';
  entity: StoredEntity | null;
  spawned: StoredEntity[];
}

interface Change {
  /** Entities to save; the mutation's own entity comes first. */
  writes: StoredEntity[];
  /** Change in the number of live entities. */
  liveDelta: number;
  /** Writes that must fit in today's quota for the mutation to apply. */
  requiredWrites: number;
}

function excluded(column: AnyPgColumn): SQL {
  return sql`excluded.${sql.identifier(column.name)}`;
}

/** Upsert assignments taking every non-key column from the proposed row. */
const ENTITY_UPSERT_SET = {
  data: excluded(entities.data),
  clock: excluded(entities.clock),
  rev: excluded(entities.rev),
  createdAt: excluded(entities.createdAt),
  updatedAt: excluded(entities.updatedAt),
  deletedAt: excluded(entities.deletedAt),
  deletedVia: excluded(entities.deletedVia),
  listId: excluded(entities.listId),
  dueDate: excluded(entities.dueDate),
  myDay: excluded(entities.myDay),
  completedAt: excluded(entities.completedAt),
  priority: excluded(entities.priority),
  quadrant: excluded(entities.quadrant),
};

function chunks<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += ROWS_PER_STATEMENT) {
    result.push(items.slice(i, i + ROWS_PER_STATEMENT));
  }
  return result;
}

function cacheKey(kind: Kind, id: string): string {
  return `${kind}:${id}`;
}

/** Returns the entity's next revision, written at `stamp`. */
function revise(entity: StoredEntity, stamp: number): StoredEntity {
  return {...entity, rev: entity.rev + 1, updatedAt: stamp};
}

/** Returns the entity moved to the trash; `deletedVia` marks cascades. */
function trash(
  entity: StoredEntity,
  deletedVia: string | null,
  stamp: number,
): StoredEntity {
  return {...revise(entity, stamp), deletedAt: stamp, deletedVia};
}

function restored(entity: StoredEntity, stamp: number): StoredEntity {
  return revise({...entity, deletedAt: null, deletedVia: null}, stamp);
}

/**
 * Applies `mutations` in order in one transaction holding the user's row
 * lock, so one user's writers are serialized. A rejected mutation changes
 * nothing and does not stop the rest.
 */
export async function applyMutations(
  db: Database,
  config: AppConfig,
  userId: number,
  mutations: ValidatedMutation[],
  now = Date.now(),
): Promise<MutationOutcome[]> {
  return inTransaction(db, async tx => {
    const writer = await MutationWriter.open(tx, config, userId, now);
    await writer.prefetch(mutations);
    const outcomes: MutationOutcome[] = [];
    for (const [index, mutation] of mutations.entries()) {
      outcomes.push(await writer.apply(index, mutation));
    }
    await writer.save();
    return outcomes;
  });
}

/**
 * Applies mutations in memory and saves them at the end. Every write takes a
 * stamp above the user's `last_stamp`: one per mutation, shared by the
 * entities that mutation changes.
 */
class MutationWriter {
  /** Entities read or written in this transaction; null when missing. */
  private readonly cache = new Map<string, StoredEntity | null>();
  private readonly unsaved = new Map<string, StoredEntity>();
  /** Tasks written in this transaction, whose reminders are rebuilt. */
  private readonly changedTaskIds = new Set<string>();
  private nextStampValue: number;
  private writesCharged = 0;

  private constructor(
    private readonly tx: Executor,
    private readonly config: AppConfig,
    private readonly userId: number,
    private readonly now: number,
    private settings: Settings,
    private liveEntityCount: number,
    private writesUsed: number,
    lastStamp: number,
  ) {
    this.nextStampValue = Math.max(now, lastStamp + 1);
  }

  static async open(
    tx: Executor,
    config: AppConfig,
    userId: number,
    now: number,
  ): Promise<MutationWriter> {
    const [row] = await tx
      .select({
        settings: users.settings,
        lastStamp: users.lastStamp,
        liveEntityCount: users.liveEntityCount,
        writes: usageDays.writes,
      })
      .from(users)
      .leftJoin(
        usageDays,
        and(
          eq(usageDays.userId, users.id),
          eq(usageDays.day, quotaDay(config, now)),
        ),
      )
      .where(eq(users.id, userId))
      .for('update', {of: users});
    if (!row) throw new Error(`User ${userId} has no row`);
    return new MutationWriter(
      tx,
      config,
      userId,
      now,
      row.settings,
      row.liveEntityCount,
      row.writes ?? 0,
      row.lastStamp.getTime(),
    );
  }

  /** Loads every mutation target with one query. */
  async prefetch(mutations: ValidatedMutation[]): Promise<void> {
    const idsByKind = new Map<Kind, Set<string>>();
    for (const {type, id} of mutations) {
      if (this.cache.has(cacheKey(type, id))) continue;
      const ids = idsByKind.get(type) ?? new Set<string>();
      ids.add(id);
      idsByKind.set(type, ids);
      this.cache.set(cacheKey(type, id), null);
    }
    if (idsByKind.size === 0) return;
    const rows = await this.tx
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.userId, this.userId),
          or(
            ...[...idsByKind].map(([kind, ids]) =>
              and(eq(entities.kind, kind), inArray(entities.id, [...ids])),
            ),
          ),
        ),
      );
    for (const row of rows) this.remember(storedEntity(row));
  }

  async apply(
    index: number,
    mutation: ValidatedMutation,
  ): Promise<MutationOutcome> {
    const base = {
      index,
      type: mutation.type,
      id: mutation.id,
      op: mutation.op,
    };
    let effect: Effect;
    try {
      effect = await this.applyMutation(mutation);
    } catch (error: unknown) {
      if (!(error instanceof AppError)) throw error;
      const current = this.cache.get(cacheKey(mutation.type, mutation.id));
      const {code, message, status, retryAfter} = error;
      return {
        ...base,
        status: 'rejected',
        entity: current ? this.toApi(current) : null,
        spawned: [],
        error: {code, message, status, retryAfter},
      };
    }
    return {
      ...base,
      status: effect.status,
      entity: effect.entity ? this.toApi(effect.entity) : null,
      spawned: effect.spawned.map(spawned => this.toApi(spawned)),
      error: null,
    };
  }

  /** Saves the entities, reminders, account counters, and write usage. */
  async save(): Promise<void> {
    await this.saveEntities();
    await this.saveReminders();
    if (this.writesCharged === 0) return;
    await this.tx
      .update(users)
      .set({
        lastStamp: new Date(this.nextStampValue - 1),
        liveEntityCount: this.liveEntityCount,
        settings: this.settings,
      })
      .where(eq(users.id, this.userId));
    await recordUsage(
      this.tx,
      this.config,
      this.userId,
      'writes',
      this.writesCharged,
      this.now,
    );
  }

  private toApi(entity: StoredEntity): ApiEntity {
    return toApiEntity(entity, this.settings.timezone);
  }

  private nextStamp(): number {
    const stamp = this.nextStampValue;
    this.nextStampValue += 1;
    return stamp;
  }

  private remember(entity: StoredEntity): StoredEntity {
    this.cache.set(cacheKey(entity.kind, entity.id), entity);
    return entity;
  }

  private async load(kind: Kind, id: string): Promise<StoredEntity | null> {
    const cached = this.cache.get(cacheKey(kind, id));
    if (cached !== undefined) return cached;
    const [row] = await this.tx
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.userId, this.userId),
          eq(entities.kind, kind),
          eq(entities.id, id),
        ),
      );
    if (row) return this.remember(storedEntity(row));
    this.cache.set(cacheKey(kind, id), null);
    return null;
  }

  /** Loads tasks matching `condition` after saving pending writes. */
  private async loadTasks(condition: SQL | undefined): Promise<StoredEntity[]> {
    await this.saveEntities();
    const rows = await this.tx
      .select()
      .from(entities)
      .where(
        and(
          eq(entities.userId, this.userId),
          eq(entities.kind, 'task'),
          condition,
        ),
      );
    return rows.map(row => this.remember(storedEntity(row)));
  }

  private async applyMutation(mutation: ValidatedMutation): Promise<Effect> {
    if (mutation.type === 'settings' && mutation.id !== SETTINGS_ID) {
      throw new AppError(
        400,
        'validation_error',
        `settings 的 id 固定为 "${SETTINGS_ID}"`,
      );
    }
    const current = await this.load(mutation.type, mutation.id);
    switch (mutation.op) {
      case 'upsert':
        return this.applyUpsert(mutation, current);
      case 'delete':
        return this.applyDelete(mutation, current);
      case 'restore':
        return this.applyRestore(current);
      default:
        throw new AppError(400, 'validation_error', '不支持的 op');
    }
  }

  private async applyUpsert(
    mutation: ValidatedMutation,
    current: StoredEntity | null,
  ): Promise<Effect> {
    const patch = mutation.data ?? {};
    // Edit times from the future are clamped to now.
    const editedAt = Math.min(mutation.editedAt ?? this.now, this.now);
    if (!current) {
      if (mutation.mustExist) {
        throw new AppError(404, 'not_found', '实体不存在');
      }
      const missing = REQUIRED_ON_CREATE[mutation.type].filter(
        field => patch[field] === undefined,
      );
      if (missing.length > 0) {
        throw new AppError(
          404,
          'not_found',
          `实体不存在；创建时必须提供 ${missing.join(', ')}`,
          {missing},
        );
      }
      this.requireCapacity(1);
      let created = newEntity(
        mutation.type,
        mutation.id,
        patch,
        editedAt,
        this.nextStamp(),
      );
      if (created.kind === 'task') {
        created = this.applyTaskRules(
          created,
          null,
          Object.keys(patch),
          editedAt,
        );
      }
      this.commit({writes: [created], liveDelta: 1, requiredWrites: 1});
      return {status: 'applied', entity: created, spawned: []};
    }
    if (current.deletedAt) {
      throw new AppError(409, 'deleted', '实体在回收站中；请先 restore 再修改');
    }
    const {next, changedFields} = mergePatch(current, patch, editedAt);
    if (changedFields.length === 0) {
      return {status: 'noop', entity: current, spawned: []};
    }
    const stamp = this.nextStamp();
    let updated = revise(next, stamp);
    if (updated.kind === 'task') {
      updated = this.applyTaskRules(updated, current, changedFields, editedAt);
    }
    const spawned =
      updated.kind === 'task'
        ? await this.spawnNextOccurrence(updated, current, stamp)
        : [];
    this.requireCapacity(spawned.length);
    this.commit({
      writes: [updated, ...spawned],
      liveDelta: spawned.length,
      requiredWrites: 1 + spawned.length,
    });
    return {status: 'applied', entity: updated, spawned};
  }

  private async applyDelete(
    mutation: ValidatedMutation,
    current: StoredEntity | null,
  ): Promise<Effect> {
    if (mutation.type === 'settings') {
      throw new AppError(400, 'validation_error', 'settings 不能删除');
    }
    if (!current || current.deletedAt) {
      return {status: 'noop', entity: current, spawned: []};
    }
    const stamp = this.nextStamp();
    const deleted = trash(current, null, stamp);
    // A list takes its tasks to the trash; restoring the list brings back
    // exactly these (see `deletedVia`).
    const cascaded =
      deleted.kind === 'list'
        ? (
            await this.loadTasks(
              and(eq(entities.listId, deleted.id), isNull(entities.deletedAt)),
            )
          ).map(task => trash(task, `list:${deleted.id}`, stamp))
        : [];
    this.commit({
      writes: [deleted, ...cascaded],
      liveDelta: -1 - cascaded.length,
      requiredWrites: 1,
    });
    return {status: 'applied', entity: deleted, spawned: []};
  }

  private async applyRestore(current: StoredEntity | null): Promise<Effect> {
    if (!current) {
      throw new AppError(
        404,
        'not_found',
        '实体不存在（可能已超过 30 天被永久删除）',
      );
    }
    if (!current.deletedAt) {
      return {status: 'noop', entity: current, spawned: []};
    }
    this.requireCapacity(1);
    const stamp = this.nextStamp();
    let entity = restored(current, stamp);
    if (entity.kind === 'task') {
      entity = await this.detachFromDeletedList(entity);
    }
    const cascaded =
      entity.kind === 'list'
        ? (
            await this.loadTasks(eq(entities.deletedVia, `list:${entity.id}`))
          ).map(task => restored(task, stamp))
        : [];
    this.commit({
      writes: [entity, ...cascaded],
      liveDelta: 1 + cascaded.length,
      requiredWrites: 1,
    });
    return {status: 'applied', entity, spawned: []};
  }

  private requireCapacity(adding: number): void {
    const {maxEntities} = this.config;
    if (adding === 0 || this.liveEntityCount + adding <= maxEntities) return;
    throw new AppError(
      403,
      'limit_exceeded',
      `数据条数已达上限 ${maxEntities}（含任务、清单、文件夹、标签）`,
      {limit: maxEntities},
    );
  }

  /**
   * Records a mutation's writes. Only `requiredWrites` must fit in today's
   * quota; tasks cascading from a list still count but never block it.
   */
  private commit(change: Change): void {
    if (
      this.writesUsed + change.requiredWrites >
      this.config.dailyQuota.writes
    ) {
      throw quotaExceeded(this.config, 'writes', this.now);
    }
    this.writesUsed += change.writes.length;
    this.writesCharged += change.writes.length;
    this.liveEntityCount = Math.max(0, this.liveEntityCount + change.liveDelta);
    for (const entity of change.writes) {
      this.remember(entity);
      this.unsaved.set(cacheKey(entity.kind, entity.id), entity);
      if (entity.kind === 'task') this.changedTaskIds.add(entity.id);
      if (entity.kind === 'settings') this.settings = settingsFrom(entity);
    }
  }

  /**
   * Applies server-side task rules: a time needs a date, recurrence rules are
   * normalized (and seed a missing due date), recurring tasks get a series id.
   */
  private applyTaskRules(
    task: StoredEntity,
    previous: StoredEntity | null,
    changedFields: string[],
    editedAt: number,
  ): StoredEntity {
    const fields = taskDataOf(task);
    const data: Record<string, unknown> = {...task.data};
    const clock = {...task.clock};
    const {timezone, weekStart} = this.settings;
    if (!fields.dueDate && fields.dueTime) {
      data.dueTime = null;
      clock.dueTime = editedAt;
    }
    if (changedFields.includes('recurrence') && fields.recurrence) {
      const today = localDate(this.now, timezone);
      const rule = normalizeRecurrence(
        fields.recurrence,
        fields.dueDate ?? today,
      );
      data.recurrence = rule;
      if (!fields.dueDate) {
        data.dueDate = firstOccurrenceOnOrAfter(rule, today, weekStart);
        clock.dueDate = editedAt;
      }
    }
    if (fields.recurrence && !fields.seriesId) {
      data.seriesId = previous
        ? (taskDataOf(previous).seriesId ?? task.id)
        : task.id;
    }
    return {...task, data, clock};
  }

  /**
   * Creates the next instance when a recurring task becomes completed. Its id
   * derives from the series and due date, so retries and concurrent devices
   * cannot create duplicates.
   */
  private async spawnNextOccurrence(
    task: StoredEntity,
    previous: StoredEntity,
    stamp: number,
  ): Promise<StoredEntity[]> {
    const fields = taskDataOf(task);
    const rule = fields.recurrence;
    const wasCompleted = taskDataOf(previous).completedAt !== null;
    if (!rule || wasCompleted || !fields.completedAt) return [];
    const {timezone, weekStart} = this.settings;
    const occurrence = nextOccurrence({
      rule,
      currentDue: fields.dueDate,
      completedOn: localDate(Date.parse(fields.completedAt), timezone),
      today: localDate(this.now, timezone),
      weekStart,
    });
    if (!occurrence) return [];
    const seriesId = fields.seriesId ?? task.id;
    const id = await nameBasedUuid(`${seriesId}|${occurrence.dueDate}`);
    if (await this.load('task', id)) return [];
    const shiftDays = fields.dueDate
      ? diffDays(fields.dueDate, occurrence.dueDate)
      : 0;
    const shiftedReminders = fields.reminders.map(reminder => {
      const local = zonedParts(Date.parse(reminder.at), timezone);
      const shiftedDate = addDays(local.date, shiftDays);
      const at = zonedToInstant(shiftedDate, local.time, timezone);
      return {id: uuidV7(this.now), at: new Date(at).toISOString()};
    });
    const patch = {
      title: fields.title,
      notes: fields.notes,
      listId: fields.listId,
      tagIds: fields.tagIds,
      priority: fields.priority,
      quadrant: fields.quadrant,
      dueDate: occurrence.dueDate,
      dueTime: fields.dueTime,
      reminders: shiftedReminders,
      estimateMinutes: fields.estimateMinutes,
      energy: fields.energy,
      subtasks: fields.subtasks.map(subtask => ({
        ...subtask,
        completed: false,
      })),
      links: fields.links,
      recurrence: {...rule, count: occurrence.count},
      seriesId,
      sortOrder: fields.sortOrder,
    };
    return [newEntity('task', id, patch, this.now, stamp)];
  }

  /** Moves a restored task to the inbox if its list is gone. */
  private async detachFromDeletedList(
    task: StoredEntity,
  ): Promise<StoredEntity> {
    const listId = taskDataOf(task).listId;
    if (!listId) return task;
    const list = await this.load('list', listId);
    if (list && !list.deletedAt) return task;
    return {
      ...task,
      data: {...task.data, listId: null},
      clock: {...task.clock, listId: this.now},
    };
  }

  private async saveEntities(): Promise<void> {
    if (this.unsaved.size === 0) return;
    const rows = [...this.unsaved.values()].map(entity =>
      entityRow(this.userId, entity),
    );
    this.unsaved.clear();
    for (const chunk of chunks(rows)) {
      await this.tx
        .insert(entities)
        .values(chunk)
        .onConflictDoUpdate({
          target: [entities.userId, entities.kind, entities.id],
          set: ENTITY_UPSERT_SET,
        });
    }
  }

  /** Replaces the scheduled reminders of every task this transaction wrote. */
  private async saveReminders(): Promise<void> {
    if (this.changedTaskIds.size === 0) return;
    const taskIds = [...this.changedTaskIds];
    this.changedTaskIds.clear();
    for (const chunk of chunks(taskIds)) {
      await this.tx
        .delete(reminders)
        .where(
          and(
            eq(reminders.userId, this.userId),
            inArray(reminders.taskId, chunk),
          ),
        );
    }
    const upcoming = taskIds.flatMap(taskId => this.upcomingReminders(taskId));
    for (const chunk of chunks(upcoming)) {
      await this.tx.insert(reminders).values(chunk);
    }
  }

  private upcomingReminders(
    taskId: string,
  ): Array<typeof reminders.$inferInsert> {
    const task = this.cache.get(cacheKey('task', taskId));
    if (!task || task.deletedAt) return [];
    const fields = taskDataOf(task);
    if (fields.completedAt) return [];
    const payload: ReminderPayload = {
      title: fields.title,
      dueDate: fields.dueDate,
      dueTime: fields.dueTime,
    };
    return fields.reminders.flatMap(reminder => {
      const fireAt = Date.parse(reminder.at);
      if (fireAt <= this.now - REMINDER_PAST_TOLERANCE_MS) return [];
      return [
        {
          userId: this.userId,
          taskId,
          reminderId: reminder.id,
          fireAt: new Date(fireAt),
          payload,
        },
      ];
    });
  }
}
