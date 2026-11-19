// Today, upcoming, and matrix views plus task queries. Pure functions: they
// take loaded entities and return them filtered and ordered.

import {addDays, diffDays, startOfDayInstant} from '../lib/time';
import {
  taskDataOf,
  type EntityMetadata,
  type Settings,
  type StoredEntity,
} from './model';

const SUGGESTION_LOOKAHEAD_DAYS = 3;
const SUGGESTION_LIMIT = 20;
const FOCUS_COUNT = 3;
const HIGH_PRIORITY = 3;
const QUICK_WIN_MINUTES = 15;
/** Sorts after every real "HH:mm", so untimed tasks come last. */
const NO_TIME = '99:99';

const QUADRANT_SCORE: Record<number, number> = {1: 400, 2: 200, 3: 100, 4: 0};
const PRIORITY_SCORE = 50;
const DUE_TODAY_SCORE = 60;
const OVERDUE_DAY_SCORE = 10;
const OVERDUE_MAX_SCORED_DAYS = 10;
const DUE_SOON_SCORE = 30;
const DUE_SOON_DAY_PENALTY = 10;
const MY_DAY_SCORE = 40;
const QUICK_WIN_SCORE = 5;

type TaskComparator = (a: StoredEntity, b: StoredEntity) => number;

function isImportantQuadrant(quadrant: number | null): boolean {
  return quadrant === 1 || quadrant === 2;
}

export function isOpenMetadata(metadata: EntityMetadata): boolean {
  return !metadata.deletedAt && !metadata.completedAt;
}

/**
 * Scores how critical a task is on `date`: quadrant, then priority, then
 * how overdue or close it is, then whether it is in My Day, then quick wins.
 */
export function focusScore(task: StoredEntity, date: string): number {
  const fields = taskDataOf(task);
  let score =
    (fields.quadrant ? (QUADRANT_SCORE[fields.quadrant] ?? 0) : 0) +
    fields.priority * PRIORITY_SCORE;
  if (fields.dueDate) {
    const daysUntilDue = diffDays(date, fields.dueDate);
    if (daysUntilDue < 0) {
      const overdueDays = Math.min(-daysUntilDue, OVERDUE_MAX_SCORED_DAYS);
      score += DUE_TODAY_SCORE + overdueDays * OVERDUE_DAY_SCORE;
    } else if (daysUntilDue === 0) {
      score += DUE_TODAY_SCORE;
    } else {
      score += Math.max(
        0,
        DUE_SOON_SCORE - daysUntilDue * DUE_SOON_DAY_PENALTY,
      );
    }
  }
  if (fields.myDay === date) score += MY_DAY_SCORE;
  if (
    fields.estimateMinutes !== null &&
    fields.estimateMinutes <= QUICK_WIN_MINUTES
  ) {
    score += QUICK_WIN_SCORE;
  }
  return score;
}

function bySortOrder(a: StoredEntity, b: StoredEntity): number {
  return (
    taskDataOf(a).sortOrder - taskDataOf(b).sortOrder ||
    a.createdAt - b.createdAt
  );
}

function byDueTime(a: StoredEntity, b: StoredEntity): number {
  return (taskDataOf(a).dueTime ?? NO_TIME).localeCompare(
    taskDataOf(b).dueTime ?? NO_TIME,
  );
}

function byDue(a: StoredEntity, b: StoredEntity): number {
  return (
    (taskDataOf(a).dueDate ?? '').localeCompare(taskDataOf(b).dueDate ?? '') ||
    byDueTime(a, b) ||
    bySortOrder(a, b)
  );
}

function byCompletedDesc(a: StoredEntity, b: StoredEntity): number {
  return (taskDataOf(b).completedAt ?? '').localeCompare(
    taskDataOf(a).completedAt ?? '',
  );
}

function byFocusScore(date: string): TaskComparator {
  return (a, b) =>
    focusScore(b, date) - focusScore(a, date) ||
    byDueTime(a, b) ||
    taskDataOf(a).sortOrder - taskDataOf(b).sortOrder;
}

/**
 * Returns a metadata filter for today-view candidates, so the view reads only
 * the task values it can show.
 */
export function todayFilter(
  date: string,
  timeZone: string,
): (metadata: EntityMetadata) => boolean {
  const dayStart = startOfDayInstant(date, timeZone);
  const dayEnd = startOfDayInstant(addDays(date, 1), timeZone);
  const horizon = addDays(date, SUGGESTION_LOOKAHEAD_DAYS);
  return metadata => {
    if (metadata.deletedAt) return false;
    if (metadata.completedAt) {
      return metadata.completedAt >= dayStart && metadata.completedAt < dayEnd;
    }
    return Boolean(
      (metadata.myDay && metadata.myDay <= date) ||
      (metadata.dueDate && metadata.dueDate <= horizon) ||
      metadata.priority === HIGH_PRIORITY ||
      isImportantQuadrant(metadata.quadrant ?? null),
    );
  };
}

export interface TodayStats {
  open: number;
  completed: number;
  plannedMinutes: number;
}

export interface TodayResult {
  date: string;
  myDay: StoredEntity[];
  overdue: StoredEntity[];
  dueToday: StoredEntity[];
  completed: StoredEntity[];
  suggestions: StoredEntity[];
  focus: StoredEntity[];
  stats: TodayStats;
}

export function buildToday(
  tasks: StoredEntity[],
  date: string,
  settings: Settings,
): TodayResult {
  const dayStart = startOfDayInstant(date, settings.timezone);
  const dayEnd = startOfDayInstant(addDays(date, 1), settings.timezone);
  const live = tasks.filter(task => !task.deletedAt);
  const open = live.filter(task => !taskDataOf(task).completedAt);
  const myDay = open
    .filter(task => taskDataOf(task).myDay === date)
    .sort(
      (a, b) =>
        (taskDataOf(a).myDayOrder ?? Infinity) -
          (taskDataOf(b).myDayOrder ?? Infinity) || bySortOrder(a, b),
    );
  const notMyDay = open.filter(task => taskDataOf(task).myDay !== date);
  const overdue = settings.todayIncludesOverdue
    ? notMyDay
        .filter(task => {
          const dueDate = taskDataOf(task).dueDate;
          return dueDate !== null && dueDate < date;
        })
        .sort(byDue)
    : [];
  const dueToday = notMyDay
    .filter(task => taskDataOf(task).dueDate === date)
    .sort(byDue);
  const listed = new Set([...overdue, ...dueToday].map(task => task.id));
  const horizon = addDays(date, SUGGESTION_LOOKAHEAD_DAYS);
  const suggestions = notMyDay
    .filter(task => !listed.has(task.id))
    .filter(task => {
      const fields = taskDataOf(task);
      const leftFromEarlierDay = fields.myDay !== null && fields.myDay < date;
      const dueSoon =
        fields.dueDate !== null &&
        fields.dueDate > date &&
        fields.dueDate <= horizon;
      return (
        leftFromEarlierDay ||
        dueSoon ||
        fields.priority === HIGH_PRIORITY ||
        isImportantQuadrant(fields.quadrant)
      );
    })
    .sort(byFocusScore(date))
    .slice(0, SUGGESTION_LIMIT);
  const completed = live
    .filter(task => {
      const completedAt = taskDataOf(task).completedAt;
      if (!completedAt) return false;
      const completedMs = Date.parse(completedAt);
      return completedMs >= dayStart && completedMs < dayEnd;
    })
    .sort(byCompletedDesc);
  const active = [...myDay, ...overdue, ...dueToday];
  return {
    date,
    myDay,
    overdue,
    dueToday,
    completed,
    suggestions,
    focus: [...active].sort(byFocusScore(date)).slice(0, FOCUS_COUNT),
    stats: {
      open: active.length,
      completed: completed.length,
      plannedMinutes: active.reduce(
        (sum, task) => sum + (taskDataOf(task).estimateMinutes ?? 0),
        0,
      ),
    },
  };
}

export interface DateGroup {
  date: string;
  tasks: StoredEntity[];
}

export interface UpcomingResult {
  from: string;
  days: number;
  overdue: StoredEntity[];
  dates: DateGroup[];
}

export function buildUpcoming(
  tasks: StoredEntity[],
  from: string,
  days: number,
  today: string,
): UpcomingResult {
  const until = addDays(from, days);
  const scheduled = tasks.flatMap(task => {
    const dueDate = taskDataOf(task).dueDate;
    const isOpen = !task.deletedAt && !taskDataOf(task).completedAt;
    return isOpen && dueDate !== null ? [{task, dueDate}] : [];
  });
  const groups = new Map<string, StoredEntity[]>();
  for (let offset = 0; offset < days; offset++) {
    groups.set(addDays(from, offset), []);
  }
  for (const {task, dueDate} of scheduled) {
    if (dueDate >= from && dueDate < until) groups.get(dueDate)?.push(task);
  }
  const overdue =
    from <= today
      ? scheduled
          .filter(({dueDate}) => dueDate < today)
          .map(({task}) => task)
          .sort(byDue)
      : [];
  return {
    from,
    days,
    overdue,
    dates: [...groups.entries()].map(([date, dayTasks]) => ({
      date,
      tasks: dayTasks.sort(byDue),
    })),
  };
}

export interface MatrixResult {
  q1: StoredEntity[];
  q2: StoredEntity[];
  q3: StoredEntity[];
  q4: StoredEntity[];
  unclassified: StoredEntity[];
}

export function buildMatrix(
  tasks: StoredEntity[],
  today: string,
  unclassifiedLimit: number,
): MatrixResult {
  const open = tasks.filter(
    task => !task.deletedAt && !taskDataOf(task).completedAt,
  );
  const inQuadrant = (quadrant: number | null) =>
    open
      .filter(task => taskDataOf(task).quadrant === quadrant)
      .sort(byFocusScore(today));
  return {
    q1: inQuadrant(1),
    q2: inQuadrant(2),
    q3: inQuadrant(3),
    q4: inQuadrant(4),
    unclassified: inQuadrant(null).slice(0, unclassifiedLimit),
  };
}

export interface TaskQuery {
  status: 'open' | 'completed' | 'all';
  listId?: string;
  inboxOnly: boolean;
  tagId?: string;
  searchText?: string;
  dueFrom?: string;
  dueTo?: string;
  priority?: number;
  quadrant?: number;
  energy?: string;
  maxEstimate?: number;
  myDay?: string;
  includeDeleted: boolean;
}

/** Applies the query conditions that metadata can answer without a read. */
export function metadataMatchesQuery(
  metadata: EntityMetadata,
  query: TaskQuery,
): boolean {
  if (metadata.deletedAt && !query.includeDeleted) return false;
  if (query.status === 'open' && metadata.completedAt) return false;
  if (query.status === 'completed' && !metadata.completedAt) return false;
  if (query.listId !== undefined && metadata.listId !== query.listId) {
    return false;
  }
  if (query.inboxOnly && metadata.listId) return false;
  if (
    query.dueFrom &&
    (!metadata.dueDate || metadata.dueDate < query.dueFrom)
  ) {
    return false;
  }
  if (query.dueTo && (!metadata.dueDate || metadata.dueDate > query.dueTo)) {
    return false;
  }
  if (
    query.priority !== undefined &&
    (metadata.priority ?? 0) !== query.priority
  ) {
    return false;
  }
  if (query.quadrant !== undefined && metadata.quadrant !== query.quadrant) {
    return false;
  }
  if (query.myDay !== undefined && metadata.myDay !== query.myDay) return false;
  return true;
}

/** Applies the remaining query conditions; open tasks sort before completed. */
export function filterAndSortTasks(
  tasks: StoredEntity[],
  query: TaskQuery,
): StoredEntity[] {
  const needle = query.searchText?.toLowerCase();
  const matches = tasks.filter(task => {
    const fields = taskDataOf(task);
    if (query.tagId && !fields.tagIds.includes(query.tagId)) return false;
    if (query.energy && fields.energy !== query.energy) return false;
    if (
      query.maxEstimate !== undefined &&
      (fields.estimateMinutes === null ||
        fields.estimateMinutes > query.maxEstimate)
    ) {
      return false;
    }
    if (
      needle &&
      !fields.title.toLowerCase().includes(needle) &&
      !fields.notes.toLowerCase().includes(needle)
    ) {
      return false;
    }
    return true;
  });
  return matches.sort((a, b) => {
    const aCompleted = taskDataOf(a).completedAt !== null;
    const bCompleted = taskDataOf(b).completedAt !== null;
    if (aCompleted !== bCompleted) return aCompleted ? 1 : -1;
    return aCompleted ? byCompletedDesc(a, b) : bySortOrder(a, b);
  });
}
