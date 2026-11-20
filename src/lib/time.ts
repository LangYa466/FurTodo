// Calendar dates are "YYYY-MM-DD" with no zone and times are 24-hour "HH:mm".
// They become epoch milliseconds only when an absolute instant is needed
// (reminders, ordering, quota resets), via an IANA time zone.

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const MS_PER_DAY = 86_400_000;
const MS_PER_SECOND = 1000;
const MAX_TIME_ZONE_LENGTH = 64;
/** 1970-01-01 was a Thursday. */
const EPOCH_WEEKDAY = 4;

/** Calendar date split into its Gregorian fields, month and day 1-based. */
export interface DateParts {
  year: number;
  /** 1-12 */
  month: number;
  /** 1-31 */
  day: number;
}

/**
 * Parses a strict `YYYY-MM-DD` string, rejecting impossible days such as
 * `2026-02-30`.
 */
export function parseDate(date: string): DateParts {
  const match = DATE_RE.exec(date);
  if (!match) throw new RangeError(`Invalid date: ${date}`);
  const parts: DateParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  if (
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.day > daysInMonth(parts.year, parts.month)
  ) {
    throw new RangeError(`Invalid date: ${date}`);
  }
  return parts;
}

/** Reports whether `date` is a real calendar date in `YYYY-MM-DD` form. */
export function isValidDate(date: string): boolean {
  try {
    parseDate(date);
  } catch {
    return false;
  }
  return true;
}

/** Reports whether `time` is 24-hour `HH:mm` with an in-range hour/minute. */
export function isValidTime(time: string): boolean {
  return TIME_RE.test(time);
}

/** Zero-pads the fields into a `YYYY-MM-DD` string; no range checks. */
export function formatDate(year: number, month: number, day: number): string {
  const yyyy = String(year).padStart(4, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/** Returns 28-31 for the given Gregorian month; `month` is 1-based. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Returns days since 1970-01-01; pure calendar math, independent of zones. */
export function toDayNumber(date: string): number {
  const {year, month, day} = parseDate(date);
  return Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY);
}

/** Formats a day count from `toDayNumber` back into `YYYY-MM-DD`. */
export function fromDayNumber(dayNumber: number): string {
  const utc = new Date(dayNumber * MS_PER_DAY);
  return formatDate(
    utc.getUTCFullYear(),
    utc.getUTCMonth() + 1,
    utc.getUTCDate(),
  );
}

/** Shifts a calendar date by `days`, which may be negative. */
export function addDays(date: string, days: number): string {
  return fromDayNumber(toDayNumber(date) + days);
}

/** Returns `to - from` in days. */
export function diffDays(from: string, to: string): number {
  return toDayNumber(to) - toDayNumber(from);
}

/** Returns 0 for Sunday through 6 for Saturday. */
export function weekdayOf(date: string): number {
  return ((toDayNumber(date) % 7) + 7 + EPOCH_WEEKDAY) % 7;
}

/**
 * Adds calendar months, clamping to the month's last day (Jan 31 + 1 month is
 * Feb 28 or 29). `dayOfMonth` overrides the day taken from `date`.
 */
export function addMonths(
  date: string,
  months: number,
  dayOfMonth?: number,
): string {
  const {year, month, day} = parseDate(date);
  const monthIndex = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth = (monthIndex % 12) + 1;
  const targetDay = Math.min(
    dayOfMonth ?? day,
    daysInMonth(targetYear, targetMonth),
  );
  return formatDate(targetYear, targetMonth, targetDay);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Reports whether the runtime accepts `timeZone` as an IANA zone name. */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > MAX_TIME_ZONE_LENGTH) return false;
  try {
    formatterFor(timeZone);
  } catch {
    return false;
  }
  return true;
}

/** An instant rendered in a time zone: calendar date plus wall-clock fields. */
export interface ZonedParts {
  date: string;
  /** "HH:mm" */
  time: string;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

/** Splits an epoch-ms instant into its fields in `timeZone`. */
export function zonedParts(ms: number, timeZone: string): ZonedParts {
  const values: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') values[part.type] = Number(part.value);
  }
  const hour = (values.hour ?? 0) % 24;
  const minute = values.minute ?? 0;
  const date = formatDate(
    values.year ?? 1970,
    values.month ?? 1,
    values.day ?? 1,
  );
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return {
    date,
    time: `${hh}:${mm}`,
    hour,
    minute,
    second: values.second ?? 0,
    weekday: weekdayOf(date),
  };
}

/** Returns the calendar date that `ms` falls on in `timeZone`. */
export function localDate(ms: number, timeZone: string): string {
  return zonedParts(ms, timeZone).date;
}

/** Returns local wall-clock time minus UTC at `ms`, e.g. +8h for Taipei. */
export function tzOffsetMs(ms: number, timeZone: string): number {
  const local = zonedParts(ms, timeZone);
  const {year, month, day} = parseDate(local.date);
  const wall = Date.UTC(
    year,
    month - 1,
    day,
    local.hour,
    local.minute,
    local.second,
  );
  // formatToParts has second precision; floor ms to whole seconds (negative ms
  // included) before comparing.
  const flooredToSecond =
    ms - (((ms % MS_PER_SECOND) + MS_PER_SECOND) % MS_PER_SECOND);
  return wall - flooredToSecond;
}

/**
 * Converts a wall-clock time in `timeZone` to epoch ms. Times skipped by a DST
 * jump resolve to the later instant; repeated times resolve to the earlier one.
 */
export function zonedToInstant(
  date: string,
  time: string | null,
  timeZone: string,
): number {
  const wallTime = time ?? '00:00';
  const {year, month, day} = parseDate(date);
  const [hour = 0, minute = 0] = wallTime.split(':').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - tzOffsetMs(wall, timeZone);
  const second = wall - tzOffsetMs(first, timeZone);
  if (first === second) return first;
  // The offset changes nearby: prefer the candidate that maps back to the same
  // wall time; inside a DST gap neither does, so take the later one.
  const roundTrips = (instant: number) =>
    zonedParts(instant, timeZone).time === wallTime &&
    localDate(instant, timeZone) === date;
  const earlier = Math.min(first, second);
  const later = Math.max(first, second);
  if (roundTrips(earlier)) return earlier;
  return later;
}

/** Returns the epoch ms of local midnight starting `date` in `timeZone`. */
export function startOfDayInstant(date: string, timeZone: string): number {
  return zonedToInstant(date, '00:00', timeZone);
}

/** Returns the first local midnight after `ms`. */
export function nextMidnightInstant(ms: number, timeZone: string): number {
  return startOfDayInstant(addDays(localDate(ms, timeZone), 1), timeZone);
}
