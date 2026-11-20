import type {Recurrence} from '../lib/recurrence';
import {zonedToInstant} from '../lib/time';

/** The entity kinds the API stores and syncs. */
export const KINDS = ['task', 'list', 'folder', 'tag', 'settings'] as const;
/** One of the stored entity kinds. */
export type Kind = (typeof KINDS)[number];
/** First day of the week: 0 = Sunday, 1 = Monday. */
export type WeekStart = 0 | 1;

/** A synced entity: one row of the `entities` table. */
export interface StoredEntity {
  kind: Kind;
  id: string;
  data: Record<string, unknown>;
  /** Per-field last-writer-wins clock: client edit time (ms) of each field. */
  clock: Record<string, number>;
  createdAt: number;
  /**
   * Stamp (ms) of the transaction that last wrote the entity. Stamps grow
   * with every write transaction of a user; sync cursors order by them.
   */
  updatedAt: number;
  deletedAt: number | null;
  /**
   * "list:<id>" when a list deletion cascaded here; restoring it undoes
   * this.
   */
  deletedVia: string | null;
  rev: number;
}

/** Stored fields of a settings entity; unsaved settings use the defaults. */
export interface Settings {
  timezone: string;
  weekStart: WeekStart;
  defaultReminderTime: string;
  todayIncludesOverdue: boolean;
  locale: string;
}

/** A task reminder: an id and the instant it fires. */
export interface ReminderData {
  id: string;
  /** ISO 8601 instant. */
  at: string;
}

/** A checklist item of a task. */
export interface SubtaskData {
  id: string;
  title: string;
  completed: boolean;
}

/** A related link of a task; `title` is optional. */
export interface LinkData {
  id: string;
  url: string;
  title: string | null;
}

/**
 * Stored task fields: zod validates client input and the server sets the
 * rest.
 */
export interface TaskData {
  title: string;
  notes: string;
  listId: string | null;
  tagIds: string[];
  priority: number;
  quadrant: number | null;
  dueDate: string | null;
  dueTime: string | null;
  reminders: ReminderData[];
  estimateMinutes: number | null;
  energy: 'low' | 'medium' | 'high' | null;
  subtasks: SubtaskData[];
  links: LinkData[];
  recurrence: Recurrence | null;
  seriesId: string | null;
  myDay: string | null;
  myDayOrder: number | null;
  sortOrder: number;
  completedAt: string | null;
}

/** The settings entity id; there is one settings row per user. */
export const SETTINGS_ID = 'main';
/** Deleted entities stay in the trash this long before they are purged. */
export const TOMBSTONE_RETENTION_MS = 30 * 86_400_000;

/** Settings of a user who never saved any. */
export const DEFAULT_SETTINGS: Settings = {
  timezone: 'Asia/Shanghai',
  weekStart: 1,
  defaultReminderTime: '09:00',
  todayIncludesOverdue: true,
  locale: 'zh-CN',
};

/** Fields a create request must carry for each kind. */
export const REQUIRED_ON_CREATE: Record<Kind, readonly string[]> = {
  task: ['title'],
  list: ['name'],
  folder: ['name'],
  tag: ['name'],
  settings: [],
};

const DEFAULT_FIELDS: Record<
  Kind,
  (createdAt: number) => Record<string, unknown>
> = {
  task: createdAt => ({
    title: '',
    notes: '',
    listId: null,
    tagIds: [],
    priority: 0,
    quadrant: null,
    dueDate: null,
    dueTime: null,
    reminders: [],
    estimateMinutes: null,
    energy: null,
    subtasks: [],
    links: [],
    recurrence: null,
    seriesId: null,
    myDay: null,
    myDayOrder: null,
    sortOrder: createdAt,
    completedAt: null,
  }),
  list: createdAt => ({
    name: '',
    color: null,
    icon: null,
    folderId: null,
    sortOrder: createdAt,
    archived: false,
  }),
  folder: createdAt => ({name: '', sortOrder: createdAt}),
  tag: () => ({name: '', color: null}),
  settings: () => ({...DEFAULT_SETTINGS}),
};

/** Returns whether `value` names a stored entity kind. */
export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

/** Returns the typed fields of a task entity (`kind === 'task'`). */
export function taskDataOf(task: StoredEntity): TaskData {
  // Task data starts from DEFAULT_FIELDS.task and only takes validated patches.
  return task.data as unknown as TaskData;
}

/**
 * Creates an entity from defaults plus `patch`.
 * @param editedAt Client edit time recorded in the field clock.
 * @param stamp Server stamp used for createdAt and updatedAt.
 */
export function newEntity(
  kind: Kind,
  id: string,
  patch: Record<string, unknown>,
  editedAt: number,
  stamp: number,
): StoredEntity {
  const clock: Record<string, number> = {};
  for (const field of Object.keys(patch)) {
    clock[field] = editedAt;
  }
  return {
    kind,
    id,
    data: {...DEFAULT_FIELDS[kind](stamp), ...patch},
    clock,
    createdAt: stamp,
    updatedAt: stamp,
    deletedAt: null,
    deletedVia: null,
    rev: 1,
  };
}

/** A merged entity and the fields the patch actually changed. */
export interface MergeResult {
  next: StoredEntity;
  changedFields: string[];
}

/**
 * Applies `patch` field by field with last-writer-wins: a field is
 * overwritten only if `editedAt` is not older than its clock, and unchanged
 * values do not count as changes.
 */
export function mergePatch(
  current: StoredEntity,
  patch: Record<string, unknown>,
  editedAt: number,
): MergeResult {
  const data = {...current.data};
  const clock = {...current.clock};
  const changedFields: string[] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (editedAt < (clock[field] ?? 0)) continue;
    if (JSON.stringify(data[field]) === JSON.stringify(value)) continue;
    data[field] = value;
    clock[field] = editedAt;
    changedFields.push(field);
  }
  return {next: {...current, data, clock}, changedFields};
}

/** Value of an API entity field; entity data only holds zod-validated JSON. */
export type ApiField = string | number | boolean | null | object;

/** An entity as returned by the HTTP API. */
export interface ApiEntity {
  [field: string]: ApiField;
  id: string;
  rev: number;
  updatedAt: string;
  deletedAt: string | null;
}

/** Returns `entity` in the JSON shape the HTTP API serves. */
export function toApiEntity(entity: StoredEntity, timeZone: string): ApiEntity {
  const fields: Record<string, unknown> = {
    id: entity.id,
    ...entity.data,
    rev: entity.rev,
    createdAt: new Date(entity.createdAt).toISOString(),
    updatedAt: new Date(entity.updatedAt).toISOString(),
    deletedAt: entity.deletedAt
      ? new Date(entity.deletedAt).toISOString()
      : null,
  };
  if (entity.kind === 'task') {
    const {dueDate, dueTime} = entity.data;
    fields.dueAt =
      typeof dueDate === 'string' && typeof dueTime === 'string'
        ? new Date(zonedToInstant(dueDate, dueTime, timeZone)).toISOString()
        : null;
  }
  // Entity data only ever holds zod-validated JSON values.
  return fields as ApiEntity;
}

/** Returns the settings of `entity`, or the defaults when it is missing. */
export function settingsFrom(entity: StoredEntity | null): Settings {
  if (!entity) return {...DEFAULT_SETTINGS};
  // Settings data is written only through the zod-validated settings patch.
  return {...DEFAULT_SETTINGS, ...(entity.data as Partial<Settings>)};
}

/** Returns the API shape of settings that were never saved (rev 0). */
export function unsavedSettingsEntity(settings: Settings): ApiEntity {
  const epoch = new Date(0).toISOString();
  return {
    id: SETTINGS_ID,
    ...settings,
    rev: 0,
    createdAt: epoch,
    updatedAt: epoch,
    deletedAt: null,
  };
}
