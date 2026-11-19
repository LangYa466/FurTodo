import {
  addDays,
  addMonths,
  daysInMonth,
  diffDays,
  formatDate,
  parseDate,
  weekdayOf,
} from './time';

export type Freq = 'daily' | 'weekly' | 'monthly' | 'yearly';

export interface Recurrence {
  freq: Freq;
  /** >= 1 */
  interval: number;
  /** weekly only: 0=Sun … 6=Sat, unique & sorted after normalize */
  byWeekday?: number[] | null;
  /** monthly / yearly: 1..31, or -1 = last day of month */
  byMonthDay?: number | null;
  /** yearly only: 1..12 */
  byMonth?: number | null;
  /** inclusive end date YYYY-MM-DD */
  until?: string | null;
  /** remaining occurrences including the current one; null = endless */
  count?: number | null;
  /**
   * "due": next date follows the schedule; "completion": next = completion
   * date + interval
   */
  basis: 'due' | 'completion';
}

const DAYS_PER_WEEK = 7;
// Catch-up scans at most this many phase weeks; the arithmetic jump needs 1-2.
const MAX_CATCHUP_STEPS = 4;
const LAST_DAY_OF_MONTH = -1;

function monthIndex(year: number, month: number): number {
  return year * 12 + (month - 1);
}

/** Clamps the day into the month; -1 means the month's last day. */
function dateInMonth(year: number, month: number, day: number): string {
  const last = daysInMonth(year, month);
  const clamped = day === LAST_DAY_OF_MONTH ? last : Math.min(day, last);
  return formatDate(year, month, clamped);
}

function dateInMonthIndex(index: number, day: number): string {
  return dateInMonth(Math.floor(index / 12), (index % 12) + 1, day);
}

function effectiveInterval(rule: Recurrence): number {
  const n = Math.trunc(rule.interval);
  return n >= 1 ? n : 1;
}

/** Returns the first day of the week containing date. */
function weekStartOf(date: string, weekStart: 0 | 1): string {
  return addDays(
    date,
    -((weekdayOf(date) - weekStart + DAYS_PER_WEEK) % DAYS_PER_WEEK),
  );
}

/**
 * Fills byWeekday/byMonthDay/byMonth from the anchor so later computations
 * never drift.
 */
export function normalizeRecurrence(
  rule: Recurrence,
  anchorDate: string,
): Recurrence {
  const {month, day} = parseDate(anchorDate);
  const common = {
    freq: rule.freq,
    interval: rule.interval,
    until: rule.until ?? null,
    count: rule.count ?? null,
    basis: rule.basis,
  };

  switch (rule.freq) {
    case 'daily':
      return {...common, byWeekday: null, byMonthDay: null, byMonth: null};
    case 'weekly': {
      const weekdays = rule.byWeekday;
      const days =
        weekdays && weekdays.length > 0
          ? [...new Set(weekdays)].sort((a, b) => a - b)
          : [weekdayOf(anchorDate)];
      return {...common, byWeekday: days, byMonthDay: null, byMonth: null};
    }
    case 'monthly':
      return {
        ...common,
        byWeekday: null,
        byMonthDay: rule.byMonthDay ?? day,
        byMonth: null,
      };
    case 'yearly':
      return {
        ...common,
        byWeekday: null,
        byMonth: rule.byMonth ?? month,
        byMonthDay: rule.byMonthDay ?? day,
      };
    default:
      throw new RangeError(`unsupported frequency: ${String(rule.freq)}`);
  }
}

// First scheduled day >= from, aligned to the week containing seriesStart.
// Jumps whole weeks and probes at most MAX_CATCHUP_STEPS phase weeks.
function firstWeeklyOnOrAfter(
  seriesStart: string,
  weekStart: 0 | 1,
  weekdays: number[],
  step: number,
  from: string,
): string {
  const offsets = [
    ...new Set(
      weekdays.map(w => (w - weekStart + DAYS_PER_WEEK) % DAYS_PER_WEEK),
    ),
  ].sort((a, b) => a - b);
  const weeksFrom = Math.max(
    0,
    Math.floor(diffDays(seriesStart, from) / DAYS_PER_WEEK),
  );
  let alignedWeek = Math.floor(weeksFrom / step) * step;

  for (let i = 0; i < MAX_CATCHUP_STEPS; i++, alignedWeek += step) {
    for (const offset of offsets) {
      const candidate = addDays(
        seriesStart,
        alignedWeek * DAYS_PER_WEEK + offset,
      );
      if (candidate >= from) return candidate;
    }
  }
  throw new RangeError('weekly recurrence catch-up exceeded bounds');
}

/**
 * First date >= fromDate (inclusive) that matches the rule's schedule
 * (ignores basis/until/count).
 */
export function firstOccurrenceOnOrAfter(
  rule: Recurrence,
  fromDate: string,
  weekStart: 0 | 1,
): string {
  const normalized = normalizeRecurrence(rule, fromDate);
  const {year, month, day} = parseDate(fromDate);

  switch (normalized.freq) {
    case 'daily':
      return fromDate;
    case 'weekly': {
      const seriesStart = weekStartOf(fromDate, weekStart);
      return firstWeeklyOnOrAfter(
        seriesStart,
        weekStart,
        normalized.byWeekday ?? [weekdayOf(fromDate)],
        1,
        fromDate,
      );
    }
    case 'monthly': {
      const monthDay = normalized.byMonthDay ?? day;
      const index = monthIndex(year, month);
      const candidate = dateInMonthIndex(index, monthDay);
      return candidate >= fromDate
        ? candidate
        : dateInMonthIndex(index + 1, monthDay);
    }
    case 'yearly': {
      const targetMonth = normalized.byMonth ?? month;
      const monthDay = normalized.byMonthDay ?? day;
      const candidate = dateInMonth(year, targetMonth, monthDay);
      return candidate >= fromDate
        ? candidate
        : dateInMonth(year + 1, targetMonth, monthDay);
    }
    default:
      throw new RangeError('unsupported recurrence frequency');
  }
}

export interface NextOccurrenceInput {
  rule: Recurrence;
  /**
   * due date of the instance being completed (null if the task had no due
   * date)
   */
  currentDue: string | null;
  /** local date (user tz) on which the instance was completed */
  completedOn: string;
  /** local date (user tz) "now" */
  today: string;
  weekStart: 0 | 1;
}

export interface NextOccurrence {
  dueDate: string;
  /**
   * count to store on the spawned instance (rule.count - 1), or null when
   * endless
   */
  count: number | null;
}

function nextDailyDue(anchor: string, step: number, today: string): string {
  const due = addDays(anchor, step);
  if (due >= today) return due;

  // Jump straight to the phase day >= today instead of looping day by day.
  const periods = Math.ceil(diffDays(anchor, today) / step);
  return addDays(anchor, Math.max(1, periods) * step);
}

function nextWeeklyDue(
  anchor: string,
  weekStart: 0 | 1,
  weekdays: number[],
  step: number,
  today: string,
): string {
  const seriesStart = weekStartOf(anchor, weekStart);
  const afterAnchor = firstWeeklyOnOrAfter(
    seriesStart,
    weekStart,
    weekdays,
    step,
    addDays(anchor, 1),
  );
  if (afterAnchor >= today) return afterAnchor;
  return firstWeeklyOnOrAfter(seriesStart, weekStart, weekdays, step, today);
}

function nextMonthlyDue(
  anchor: string,
  day: number,
  step: number,
  today: string,
): string {
  const {year, month} = parseDate(anchor);
  const anchorIndex = monthIndex(year, month);
  let index = anchorIndex;
  let due = dateInMonthIndex(index, day);
  if (due <= anchor) {
    index += step;
    due = dateInMonthIndex(index, day);
  }
  if (due >= today) return due;

  const {year: todayYear, month: todayMonth} = parseDate(today);
  const monthsAhead = Math.max(
    0,
    monthIndex(todayYear, todayMonth) - anchorIndex,
  );
  index = anchorIndex + Math.floor(monthsAhead / step) * step;
  for (let i = 0; i < MAX_CATCHUP_STEPS; i++, index += step) {
    due = dateInMonthIndex(index, day);
    if (due >= today) return due;
  }
  throw new RangeError('monthly recurrence catch-up exceeded bounds');
}

function nextYearlyDue(
  anchor: string,
  month: number,
  day: number,
  step: number,
  today: string,
): string {
  const {year: anchorYear} = parseDate(anchor);
  let year = anchorYear;
  let due = dateInMonth(year, month, day);
  if (due <= anchor) {
    year += step;
    due = dateInMonth(year, month, day);
  }
  if (due >= today) return due;

  const yearsAhead = Math.max(0, parseDate(today).year - anchorYear);
  year = anchorYear + Math.floor(yearsAhead / step) * step;
  for (let i = 0; i < MAX_CATCHUP_STEPS; i++, year += step) {
    due = dateInMonth(year, month, day);
    if (due >= today) return due;
  }
  throw new RangeError('yearly recurrence catch-up exceeded bounds');
}

function nextDateBySchedule(
  rule: Recurrence,
  anchor: string,
  weekStart: 0 | 1,
  today: string,
): string {
  const step = effectiveInterval(rule);
  const {month, day} = parseDate(anchor);

  switch (rule.freq) {
    case 'daily':
      return nextDailyDue(anchor, step, today);
    case 'weekly':
      return nextWeeklyDue(
        anchor,
        weekStart,
        rule.byWeekday ?? [weekdayOf(anchor)],
        step,
        today,
      );
    case 'monthly':
      return nextMonthlyDue(anchor, rule.byMonthDay ?? day, step, today);
    case 'yearly':
      return nextYearlyDue(
        anchor,
        rule.byMonth ?? month,
        rule.byMonthDay ?? day,
        step,
        today,
      );
    default:
      throw new RangeError('unsupported recurrence frequency');
  }
}

function nextDateFromCompletion(rule: Recurrence, completedOn: string): string {
  const step = effectiveInterval(rule);
  switch (rule.freq) {
    case 'daily':
      return addDays(completedOn, step);
    case 'weekly':
      return addDays(completedOn, DAYS_PER_WEEK * step);
    case 'monthly':
      // Completion basis adds months to the completion date, ignoring
      // byMonthDay.
      return addMonths(completedOn, step);
    case 'yearly':
      return addMonths(completedOn, 12 * step);
    default:
      throw new RangeError('unsupported recurrence frequency');
  }
}

/**
 * Next instance's due date, or null when the series has ended (until/count).
 */
export function nextOccurrence(
  input: NextOccurrenceInput,
): NextOccurrence | null {
  const {currentDue, completedOn, today, weekStart} = input;
  const anchor = currentDue ?? completedOn;
  const rule = normalizeRecurrence(input.rule, anchor);

  const dueDate =
    rule.basis === 'completion'
      ? nextDateFromCompletion(rule, completedOn)
      : nextDateBySchedule(rule, anchor, weekStart, today);

  // until is a non-empty date string when present.
  if (rule.until && dueDate > rule.until) return null;

  let count: number | null = null;
  if (typeof rule.count === 'number') {
    if (rule.count <= 1) return null;
    count = rule.count - 1;
  }
  return {dueDate, count};
}
