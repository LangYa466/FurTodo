import type {Recurrence} from '../lib/recurrence';
import {zonedToInstant} from '../lib/time';

export const KINDS = ['task', 'list', 'folder', 'tag', 'settings'] as const;
export type Kind = (typeof KINDS)[number];
export type WeekStart = 0 | 1;

/** An entity as stored in KV, one key per entity. */
export interface StoredEntity {
  schemaVersion: 1;
  kind: Kind;
  id: string;
  data: Record<string, unknown>;
  /** Per-field last-writer-wins clock: client edit time (ms) of each field. */
  clock: Record<string, number>;
  createdAt: number;
  /** Server stamp, strictly increasing per user; sync cursors compare it. */
  updatedAt: number;
  deletedAt: number | null;
  /** "list:<id>" when a list deletion cascaded here; restoring it undoes this. */
  deletedVia: string | null;
  rev: number;
}

/**
 * KV metadata (max 1024 bytes) returned by `list()`, so views can filter
 * without reading every value.
 */
export interface EntityMetadata {
  rev: number;
  updatedAt: number;
  deletedAt?: number;
  /** Task completion time in ms. */
  completedAt?: number;
  dueDate?: string;
  myDay?: string;
  listId?: string;
  /** Only set when greater than 0. */
  priority?: number;
  quadrant?: number;
  /** List, folder, or tag name, truncated. */
  name?: string;
}

export interface Settings {
  timezone: string;
  weekStart: WeekStart;
  defaultReminderTime: string;
  todayIncludesOverdue: boolean;
  locale: string;
}

export interface ReminderData {
  id: string;
  /** ISO 8601 instant. */
  at: string;
}

export interface SubtaskData {
  id: string;
  title: string;
  completed: boolean;
}

export interface LinkData {
  id: string;
  url: string;
  title: string | null;
}

export interface AttachmentInfo {
  id: string;
  name: string;
  size: number;
  contentType: string;
  createdAt: string;
}

/** KV metadata of an attachment blob; `name` is URI-encoded to stay ASCII. */
export interface BlobMetadata {
  taskId: string;
  name: string;
  contentType: string;
  size: number;
}

/** Stored task fields: zod validates client input and the server sets the rest. */
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
  attachments: AttachmentInfo[];
  recurrence: Recurrence | null;
  seriesId: string | null;
  myDay: string | null;
  myDayOrder: number | null;
  sortOrder: number;
  completedAt: string | null;
}

export const SETTINGS_ID = 'main';
export const TOMBSTONE_TTL_SECONDS = 30 * 86_400;
export const TOMBSTONE_RETENTION_MS = TOMBSTONE_TTL_SECONDS * 1000;
const METADATA_NAME_MAX_LENGTH = 100;

export const DEFAULT_SETTINGS: Settings = {
  timezone: 'Asia/Shanghai',
  weekStart: 1,
  defaultReminderTime: '09:00',
  todayIncludesOverdue: true,
  locale: 'zh-CN',
};

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
    attachments: [],
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

export function isKind(value: string): value is Kind {
  return (KINDS as readonly string[]).includes(value);
}

/** Returns the typed fields of a task entity (`kind === 'task'`). */
export function taskDataOf(task: StoredEntity): TaskData {
  // Task data starts from DEFAULT_FIELDS.task and only takes validated patches.
  return task.data as unknown as TaskData;
}

export function entityKeyPrefix(userId: string, kind?: Kind): string {
  return kind ? `e:${userId}:${kind}:` : `e:${userId}:`;
}

export function entityKey(userId: string, kind: Kind, id: string): string {
  return `e:${userId}:${kind}:${id}`;
}

export function blobKey(userId: string, attachmentId: string): string {
  return `b:${userId}:${attachmentId}`;
}

export function parseEntityKey(key: string): {kind: Kind; id: string} | null {
  const [prefix, , kind = '', ...idParts] = key.split(':');
  const id = idParts.join(':');
  if (prefix !== 'e' || !id || !isKind(kind)) return null;
  return {kind, id};
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
    schemaVersion: 1,
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

export function metadataFor(entity: StoredEntity): EntityMetadata {
  const metadata: EntityMetadata = {
    rev: entity.rev,
    updatedAt: entity.updatedAt,
  };
  if (entity.deletedAt) metadata.deletedAt = entity.deletedAt;
  const data = entity.data;
  if (entity.kind === 'task') {
    if (typeof data.completedAt === 'string') {
      metadata.completedAt = Date.parse(data.completedAt);
    }
    if (typeof data.dueDate === 'string') metadata.dueDate = data.dueDate;
    if (typeof data.myDay === 'string') metadata.myDay = data.myDay;
    if (typeof data.listId === 'string') metadata.listId = data.listId;
    if (typeof data.priority === 'number' && data.priority > 0) {
      metadata.priority = data.priority;
    }
    if (typeof data.quadrant === 'number') metadata.quadrant = data.quadrant;
  } else if (entity.kind !== 'settings' && typeof data.name === 'string') {
    metadata.name = data.name.slice(0, METADATA_NAME_MAX_LENGTH);
  }
  return metadata;
}

/**
 * Value of an API entity field. Deliberately not a recursive JSON type:
 * recursion exceeds the type-instantiation depth of Durable Object RPC stubs.
 */
export type ApiField = string | number | boolean | null | object;

/** An entity as returned by the HTTP API. */
export interface ApiEntity {
  [field: string]: ApiField;
  id: string;
  rev: number;
  updatedAt: string;
  deletedAt: string | null;
}

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

export function settingsFrom(entity: StoredEntity | null): Settings {
  if (!entity) return {...DEFAULT_SETTINGS};
  // Settings data is written only through the zod-validated settings patch.
  return {...DEFAULT_SETTINGS, ...(entity.data as Partial<Settings>)};
}

/** An entity the user's Durable Object wrote recently (the read overlay). */
export interface JournalEntry {
  key: string;
  metadata: EntityMetadata;
  body: StoredEntity;
}

/** A journal entry as sent over RPC; `body` stays the stored JSON string. */
export interface RawJournalEntry {
  key: string;
  metadata: EntityMetadata;
  body: string;
}

export function parseJournalEntry(entry: RawJournalEntry): JournalEntry {
  // Journal bodies are JSON.stringify(StoredEntity) written by UserHub.
  return {...entry, body: JSON.parse(entry.body) as StoredEntity};
}
