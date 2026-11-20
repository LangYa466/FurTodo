import type {Freq, Recurrence} from './recurrence';
import {
  addDays,
  addMonths,
  daysInMonth,
  formatDate,
  isValidDate,
  localDate,
  parseDate,
  weekdayOf,
  zonedToInstant,
} from './time';

/** The "now", zone and week-start inputs that anchor every relative phrase. */
export interface CaptureContext {
  /** Epoch milliseconds of "now". */
  now: number;
  /** IANA time zone used to resolve relative dates and times. */
  timeZone: string;
  /** 0 = weeks start Sunday, 1 = Monday. */
  weekStart: 0 | 1;
}

/** Everything the tokenizer can recognize and strip from the input text. */
export type CaptureTokenKind =
  | 'date'
  | 'time'
  | 'tag'
  | 'list'
  | 'priority'
  | 'quadrant'
  | 'estimate'
  | 'energy'
  | 'recurrence';

/** One recognized fragment, kept so clients can highlight what was consumed. */
export interface CaptureToken {
  kind: CaptureTokenKind;
  /** Exact substring of the input. */
  text: string;
  /** UTF-16 offsets into the input; text === input.slice(start, end). */
  start: number;
  end: number;
}

/**
 * Task fields parsed out of free-form text; `warnings` lists fragments that
 * looked meaningful but could not be applied.
 */
export interface ParsedCapture {
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  priority: 1 | 2 | 3 | null;
  quadrant: 1 | 2 | 3 | 4 | null;
  estimateMinutes: number | null;
  energy: 'low' | 'medium' | 'high' | null;
  tags: string[];
  list: string | null;
  recurrence: Recurrence | null;
  tokens: CaptureToken[];
  warnings: string[];
}

type Priority = 1 | 2 | 3;
type Quadrant = 1 | 2 | 3 | 4;
type Energy = 'low' | 'medium' | 'high';

const DAYS_PER_WEEK = 7;
const MINUTES_PER_HOUR = 60;
const MAX_ESTIMATE_MINUTES = 24 * MINUTES_PER_HOUR;
const MAX_TAG_LENGTH = 32;
const NIGHT_TIME = '20:00';
// Consumed ranges are masked with NUL so later scans cannot match them.
const MASK_CHAR = '\u0000';
const WHITESPACE_RE = /\s/;
const TITLE_EDGE_RE = /^[\s,，、;；:：]+|[\s,，、;；:：]+$/gu;
const NAME_CHAR_RE = /[\p{L}\p{N}\p{M}_\-/]+/uy;

const ZH_NUMERAL_CHARS = '[一二兩两三四五六七八九十]';
const NUM_SRC = `(\\d{1,3}|${ZH_NUMERAL_CHARS}{1,3})`;
const WEEKDAY_CHAR_SRC = '[一二三四五六日天]';

const FULLWIDTH_MARKERS: Readonly<Record<string, string>> = {
  '＃': '#',
  '＠': '@',
  '！': '!',
  '～': '~',
  '％': '%',
  '＊': '*',
};

const ZH_WEEKDAY: Readonly<Record<string, number>> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
};

const ZH_DIGITS: Readonly<Record<string, number>> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  兩: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};

const EN_WEEKDAY_SRC =
  '(?:sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?)';

const EN_WEEKDAY_INDEX: Readonly<Record<string, number>> = {
  sun: 0,
  sunday: 0,
  mon: 1,
  monday: 1,
  tue: 2,
  tues: 2,
  tuesday: 2,
  wed: 3,
  wednesday: 3,
  thu: 4,
  thur: 4,
  thurs: 4,
  thursday: 4,
  fri: 5,
  friday: 5,
  sat: 6,
  saturday: 6,
};

const PRIORITY_TOKENS: ReadonlyArray<{token: string; value: Priority}> = [
  {token: 'medium', value: 2},
  {token: 'high', value: 3},
  {token: 'low', value: 1},
  {token: '!!!', value: 3},
  {token: 'med', value: 2},
  {token: '!!', value: 2},
  {token: '1', value: 1},
  {token: '2', value: 2},
  {token: '3', value: 3},
  {token: '低', value: 1},
  {token: '中', value: 2},
  {token: '高', value: 3},
];

const ENERGY_TOKENS: ReadonlyArray<{token: string; value: Energy}> = [
  {token: 'medium', value: 'medium'},
  {token: 'high', value: 'high'},
  {token: 'low', value: 'low'},
  {token: 'med', value: 'medium'},
  {token: 'm', value: 'medium'},
  {token: 'h', value: 'high'},
  {token: 'l', value: 'low'},
  {token: '中', value: 'medium'},
  {token: '高', value: 'high'},
  {token: '低', value: 'low'},
];

interface Span {
  start: number;
  end: number;
}

interface DateMatch extends Span {
  date: string;
  night: boolean;
}

interface TimeMatch extends Span {
  time: string;
}

interface WeekdayRun {
  days: number[];
  length: number;
}

interface RecurrenceMatch {
  rule: Recurrence;
  length: number;
}

/** Parses an Arabic or Chinese numeral (1..99). */
function parseNumeric(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  const tenIndex = raw.indexOf('十');
  if (tenIndex === -1) {
    const digit = ZH_DIGITS[raw];
    return digit === undefined ? null : digit;
  }
  const head = raw.slice(0, tenIndex);
  const tail = raw.slice(tenIndex + 1);
  if ([...head].length > 1 || [...tail].length > 1) return null;
  const tens = head === '' ? 1 : ZH_DIGITS[head];
  const ones = tail === '' ? 0 : ZH_DIGITS[tail];
  if (tens === undefined || ones === undefined) return null;
  return tens * 10 + ones;
}

function isBoundary(text: string, index: number): boolean {
  return index >= text.length || WHITESPACE_RE.test(text.charAt(index));
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Keeps the earliest-starting, longest candidate when spans overlap. */
function firstDisjoint<T extends Span>(candidates: readonly T[]): T[] {
  const sorted = [...candidates].sort(
    (a, b) => a.start - b.start || b.end - a.end,
  );
  const kept: T[] = [];
  let lastEnd = -1;
  for (const candidate of sorted) {
    if (candidate.start < lastEnd) continue;
    kept.push(candidate);
    lastEnd = candidate.end;
  }
  return kept;
}

function readName(text: string, from: number): string | null {
  NAME_CHAR_RE.lastIndex = from;
  const match = NAME_CHAR_RE.exec(text);
  if (!match) return null;
  if ([...match[0]].length > MAX_TAG_LENGTH) return null;
  return match[0];
}

interface EstimateMatch {
  minutes: number;
  length: number;
}

function parseEstimate(rest: string): EstimateMatch | null {
  if (rest.startsWith('半小時') || rest.startsWith('半小时')) {
    return {minutes: 30, length: 3};
  }
  const hours = /^(\d+(?:\.\d+)?)(?:hours?|hrs?|小時|小时|h)(?:(\d+)m?)?/.exec(
    rest,
  );
  if (hours) {
    const value = Number(hours[1]) * MINUTES_PER_HOUR + Number(hours[2] ?? 0);
    return {minutes: Math.round(value), length: hours[0].length};
  }
  const minutes = /^(\d+(?:\.\d+)?)(?:minutes?|mins?|m|分鐘|分钟|分)/.exec(
    rest,
  );
  if (minutes) {
    return {minutes: Math.round(Number(minutes[1])), length: minutes[0].length};
  }
  const bare = /^(\d+(?:\.\d+)?)/.exec(rest);
  if (bare) {
    return {minutes: Math.round(Number(bare[1])), length: bare[0].length};
  }
  return null;
}

function makeRule(
  freq: Freq,
  interval: number,
  extras?: Partial<Recurrence>,
): Recurrence {
  return {
    freq,
    interval,
    byWeekday: null,
    byMonthDay: null,
    byMonth: null,
    until: null,
    count: null,
    basis: 'due',
    ...extras,
  };
}

function freqOfZhUnit(unit: string): Freq {
  switch (unit) {
    case '天':
      return 'daily';
    case '週':
    case '周':
      return 'weekly';
    case '年':
      return 'yearly';
    default:
      return 'monthly';
  }
}

function freqOfEnUnit(unit: string): Freq {
  switch (unit.toLowerCase()) {
    case 'day':
    case 'days':
      return 'daily';
    case 'week':
    case 'weeks':
      return 'weekly';
    case 'year':
    case 'years':
      return 'yearly';
    default:
      return 'monthly';
  }
}

/** Reads weekday characters after a weekly prefix, allowing separators. */
function readZhWeekdays(text: string, from: number): WeekdayRun | null {
  const days: number[] = [];
  let index = from;
  while (index < text.length) {
    const character = text.charAt(index);
    const weekday = ZH_WEEKDAY[character];
    if (weekday !== undefined) {
      days.push(weekday);
      index += 1;
      continue;
    }
    if (character === '、' || character === ',' || character === '，') {
      if (ZH_WEEKDAY[text.charAt(index + 1)] === undefined) break;
      index += 1;
      continue;
    }
    break;
  }
  if (days.length === 0) return null;
  return {days, length: index - from};
}

function parseRecurrenceRule(rest: string): RecurrenceMatch | null {
  // Completion-based interval: after N units.
  let match = new RegExp(
    `^(?:完成後|完成后)(?:每)?${NUM_SRC}(天|週|周|個月|个月|月|年)`,
  ).exec(rest);
  if (match) {
    // A successful exec() always fills the groups used below.
    const interval = parseNumeric(match[1]!);
    if (interval !== null && interval >= 1) {
      return {
        rule: makeRule(freqOfZhUnit(match[2]!), interval, {
          basis: 'completion',
        }),
        length: match[0].length,
      };
    }
  }

  match = /^(daily|weekly|monthly|yearly|annually)(?![a-z])/i.exec(rest);
  if (match) {
    const freq = match[1]!.toLowerCase();
    return {
      rule: makeRule(freq === 'annually' ? 'yearly' : (freq as Freq), 1),
      length: match[0].length,
    };
  }

  match = /^(weekdays|weekends)(?![a-z])/i.exec(rest);
  if (match) {
    const days =
      match[1]!.toLowerCase() === 'weekdays' ? [1, 2, 3, 4, 5] : [0, 6];
    return {
      rule: makeRule('weekly', 1, {byWeekday: days}),
      length: match[0].length,
    };
  }

  match = /^every-(\d+)-(days|weeks|months|years)(?![a-z])/i.exec(rest);
  if (match) {
    const interval = Number(match[1]);
    if (interval >= 1) {
      return {
        rule: makeRule(freqOfEnUnit(match[2]!), interval),
        length: match[0].length,
      };
    }
  }

  match = /^every-(day|week|month|year)(?![a-z])/i.exec(rest);
  if (match) {
    return {
      rule: makeRule(freqOfEnUnit(match[1]!), 1),
      length: match[0].length,
    };
  }

  match = /^every-([a-z]+(?:,[a-z]+)*)(?![a-z])/i.exec(rest);
  if (match) {
    const days: number[] = [];
    let valid = true;
    for (const part of match[1]!.split(',')) {
      const day = EN_WEEKDAY_INDEX[part.toLowerCase()];
      if (day === undefined) {
        valid = false;
        break;
      }
      days.push(day);
    }
    if (valid) {
      return {
        rule: makeRule('weekly', 1, {byWeekday: days}),
        length: match[0].length,
      };
    }
  }

  match = /^after-(\d+)-(days|weeks|months|years)(?![a-z])/i.exec(rest);
  if (match) {
    const interval = Number(match[1]);
    if (interval >= 1) {
      return {
        rule: makeRule(freqOfEnUnit(match[2]!), interval, {
          basis: 'completion',
        }),
        length: match[0].length,
      };
    }
  }

  // Fixed phrases.
  match = /^(?:每個工作日|每个工作日|工作日|平日)/.exec(rest);
  if (match) {
    return {
      rule: makeRule('weekly', 1, {byWeekday: [1, 2, 3, 4, 5]}),
      length: match[0].length,
    };
  }

  match = /^(?:每週末|每周末|週末|周末)/.exec(rest);
  if (match) {
    return {
      rule: makeRule('weekly', 1, {byWeekday: [0, 6]}),
      length: match[0].length,
    };
  }

  match = /^(?:每天|每日)/.exec(rest);
  if (match) {
    return {rule: makeRule('daily', 1), length: match[0].length};
  }

  match = new RegExp(`^每${NUM_SRC}天`).exec(rest);
  if (match) {
    const interval = parseNumeric(match[1]!);
    if (interval !== null && interval >= 1) {
      return {rule: makeRule('daily', interval), length: match[0].length};
    }
  }

  match = /^(?:每月最後一天|每月最后一天|每月底)/.exec(rest);
  if (match) {
    return {
      rule: makeRule('monthly', 1, {byMonthDay: -1}),
      length: match[0].length,
    };
  }

  match = new RegExp(`^每月${NUM_SRC}[號号日]`).exec(rest);
  if (match) {
    const day = parseNumeric(match[1]!);
    if (day !== null && day >= 1 && day <= 31) {
      return {
        rule: makeRule('monthly', 1, {byMonthDay: day}),
        length: match[0].length,
      };
    }
  }

  match = /^每月/.exec(rest);
  if (match) {
    return {rule: makeRule('monthly', 1), length: match[0].length};
  }

  match = new RegExp(`^每${NUM_SRC}(?:個月|个月|月)`).exec(rest);
  if (match) {
    const interval = parseNumeric(match[1]!);
    if (interval !== null && interval >= 1) {
      return {rule: makeRule('monthly', interval), length: match[0].length};
    }
  }

  match = /^每年/.exec(rest);
  if (match) {
    return {rule: makeRule('yearly', 1), length: match[0].length};
  }

  match = new RegExp(`^每${NUM_SRC}年`).exec(rest);
  if (match) {
    const interval = parseNumeric(match[1]!);
    if (interval !== null && interval >= 1) {
      return {rule: makeRule('yearly', interval), length: match[0].length};
    }
  }

  match = new RegExp(
    `^每(?:(\\d{1,2}|${ZH_NUMERAL_CHARS}{1,3}))?(?:週|周|星期|禮拜|礼拜)`,
  ).exec(rest);
  if (match) {
    const interval = match[1] === undefined ? 1 : parseNumeric(match[1]);
    if (interval !== null && interval >= 1) {
      const weekdays = readZhWeekdays(rest, match[0].length);
      return {
        rule: makeRule('weekly', interval, {byWeekday: weekdays?.days ?? null}),
        length: match[0].length + (weekdays?.length ?? 0),
      };
    }
  }

  return null;
}

function applyPeriod(period: string | undefined, hour: number): number {
  if (period === undefined) return hour;
  switch (period) {
    case '下午':
    case '傍晚':
    case '晚上':
      return hour < 12 ? hour + 12 : hour;
    case '中午':
      if (hour === 12) return 12;
      if (hour === 1 || hour === 2) return hour + 12;
      return hour;
    case '凌晨':
      return hour === 12 ? 0 : hour;
    default:
      return hour;
  }
}

const ZH_PERIOD_SRC = '(早上|上午|中午|下午|傍晚|晚上|凌晨)';
const ZH_HOUR_SRC = `(\\d{1,2}|${ZH_NUMERAL_CHARS}{1,3})`;
const ZH_MINUTE_SRC = `(半|一刻|三刻|(?:\\d{1,2}|${ZH_NUMERAL_CHARS}{1,3})分|\\d{1,2}(?!\\d))`;

function parseZhMinutes(raw: string): number | null {
  if (raw === '半') return 30;
  if (raw === '一刻') return 15;
  if (raw === '三刻') return 45;
  const value = parseNumeric(raw.endsWith('分') ? raw.slice(0, -1) : raw);
  return value !== null && value >= 0 && value <= 59 ? value : null;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/** Extracts task fields from text; unconsumed text becomes the title. */
export function parseCapture(text: string, ctx: CaptureContext): ParsedCapture {
  const {now, timeZone, weekStart} = ctx;
  const today = localDate(now, timeZone);
  const todayParts = parseDate(today);
  const weekdayToday = weekdayOf(today);
  const offsetFromWeekStart =
    (((weekdayToday - weekStart) % DAYS_PER_WEEK) + DAYS_PER_WEEK) %
    DAYS_PER_WEEK;
  const thisWeekStart = addDays(today, -offsetFromWeekStart);
  const nextWeekStart = addDays(thisWeekStart, DAYS_PER_WEEK);

  const weekdayInNextWeek = (weekday: number): string =>
    addDays(
      nextWeekStart,
      (((weekday - weekStart) % DAYS_PER_WEEK) + DAYS_PER_WEEK) % DAYS_PER_WEEK,
    );
  const upcomingWeekday = (weekday: number): string =>
    addDays(
      today,
      (((weekday - weekdayToday) % DAYS_PER_WEEK) + DAYS_PER_WEEK) %
        DAYS_PER_WEEK,
    );
  const lastDayOfThisMonth = formatDate(
    todayParts.year,
    todayParts.month,
    daysInMonth(todayParts.year, todayParts.month),
  );

  const consumed: boolean[] = new Array<boolean>(text.length).fill(false);
  const tokens: CaptureToken[] = [];
  const warnings: string[] = [];
  const tags: string[] = [];
  const seenTags = new Set<string>();
  let list: string | null = null;
  let priority: Priority | null = null;
  let quadrant: Quadrant | null = null;
  let estimateMinutes: number | null = null;
  let energy: Energy | null = null;
  let recurrence: Recurrence | null = null;

  const consume = (
    kind: CaptureTokenKind,
    start: number,
    end: number,
  ): void => {
    consumed.fill(true, start, end);
    tokens.push({kind, text: text.slice(start, end), start, end});
  };

  for (let index = 0; index < text.length; index++) {
    if (consumed[index]) continue;
    const rawChar = text.charAt(index);
    const marker = FULLWIDTH_MARKERS[rawChar] ?? rawChar;
    if (
      marker !== '#' &&
      marker !== '@' &&
      marker !== '!' &&
      marker !== '~' &&
      marker !== '%' &&
      marker !== '*'
    ) {
      continue;
    }
    if (index > 0 && !WHITESPACE_RE.test(text.charAt(index - 1))) continue;

    if (marker === '#' || marker === '@') {
      const name = readName(text, index + 1);
      if (!name) continue;
      const end = index + 1 + name.length;
      if (marker === '#') {
        consume('tag', index, end);
        const key = name.toLowerCase();
        if (!seenTags.has(key)) {
          seenTags.add(key);
          tags.push(name);
        }
      } else if (list === null) {
        list = name;
        consume('list', index, end);
      } else {
        consume('list', index, end);
        warnings.push(`duplicate_list:${marker}${name}`);
      }
      continue;
    }

    if (marker === '!') {
      const rest = text.slice(index + 1);
      const quadrantMatch = /^[qQ]([1-4])/.exec(rest);
      if (
        quadrantMatch &&
        isBoundary(text, index + 1 + quadrantMatch[0].length)
      ) {
        const value = Number(quadrantMatch[1]) as Quadrant;
        const end = index + 1 + quadrantMatch[0].length;
        consume('quadrant', index, end);
        if (quadrant === null) quadrant = value;
        continue;
      }
      const lowered = rest.toLowerCase();
      for (const candidate of PRIORITY_TOKENS) {
        if (!lowered.startsWith(candidate.token)) continue;
        const end = index + 1 + candidate.token.length;
        if (!isBoundary(text, end)) continue;
        consume('priority', index, end);
        if (priority === null) priority = candidate.value;
        else warnings.push('duplicate_priority');
        break;
      }
      continue;
    }

    if (marker === '~') {
      const parsed = parseEstimate(text.slice(index + 1));
      if (!parsed) {
        const chunk = /^\S+/.exec(text.slice(index + 1));
        if (chunk && isBoundary(text, index + 1 + chunk[0].length)) {
          warnings.push('invalid_estimate');
        }
        continue;
      }
      const end = index + 1 + parsed.length;
      if (!isBoundary(text, end)) continue;
      if (parsed.minutes < 1 || parsed.minutes > MAX_ESTIMATE_MINUTES) {
        warnings.push('invalid_estimate');
        continue;
      }
      consume('estimate', index, end);
      if (estimateMinutes === null) estimateMinutes = parsed.minutes;
      continue;
    }

    if (marker === '%') {
      const lowered = text.slice(index + 1).toLowerCase();
      for (const candidate of ENERGY_TOKENS) {
        if (!lowered.startsWith(candidate.token)) continue;
        const end = index + 1 + candidate.token.length;
        if (!isBoundary(text, end)) continue;
        consume('energy', index, end);
        if (energy === null) energy = candidate.value;
        break;
      }
      continue;
    }

    // marker === "*"
    const parsed = parseRecurrenceRule(text.slice(index + 1));
    if (!parsed) {
      const chunk = /^\S+/.exec(text.slice(index + 1));
      if (chunk) warnings.push('unknown_recurrence');
      continue;
    }
    const end = index + 1 + parsed.length;
    if (!isBoundary(text, end)) continue;
    consume('recurrence', index, end);
    if (recurrence === null) recurrence = parsed.rule;
  }

  let masked = '';
  for (let index = 0; index < text.length; index++) {
    masked += consumed[index] ? MASK_CHAR : text.charAt(index);
  }

  const blocked: Span[] = [];
  const dateCandidates: DateMatch[] = [];
  const addDate = (
    start: number,
    end: number,
    date: string,
    night = false,
  ): void => {
    dateCandidates.push({start, end, date, night});
  };
  const addInvalidDate = (start: number, end: number): void => {
    blocked.push({start, end});
    warnings.push('invalid_date');
  };

  // Relative days.
  for (const match of masked.matchAll(/大後天|大后天/g)) {
    addDate(match.index, match.index + match[0].length, addDays(today, 3));
  }
  for (const match of masked.matchAll(/後天|后天/g)) {
    addDate(match.index, match.index + match[0].length, addDays(today, 2));
  }
  for (const match of masked.matchAll(/明天|明日/g)) {
    addDate(match.index, match.index + match[0].length, addDays(today, 1));
  }
  for (const match of masked.matchAll(/今天|今日/g)) {
    addDate(match.index, match.index + match[0].length, today);
  }
  for (const match of masked.matchAll(/今晚/g)) {
    addDate(match.index, match.index + match[0].length, today, true);
  }
  for (const match of masked.matchAll(
    new RegExp(`${NUM_SRC}天(?:後|后)`, 'g'),
  )) {
    // Every matchAll() step is a match, so its capture groups are present.
    const days = parseNumeric(match[1]!);
    if (days !== null && days >= 1) {
      addDate(match.index, match.index + match[0].length, addDays(today, days));
    } else {
      addInvalidDate(match.index, match.index + match[0].length);
    }
  }
  for (const match of masked.matchAll(
    new RegExp(`下(?:週|周|星期|禮拜|礼拜)(${WEEKDAY_CHAR_SRC})`, 'g'),
  )) {
    addDate(
      match.index,
      match.index + match[0].length,
      weekdayInNextWeek(ZH_WEEKDAY[match[1]!] as number),
    );
  }
  for (const match of masked.matchAll(/下(?:週|周)/g)) {
    addDate(match.index, match.index + match[0].length, nextWeekStart);
  }
  for (const match of masked.matchAll(
    new RegExp(
      `(?:這週|这周|本週|本周|週|周|星期|禮拜|礼拜)(${WEEKDAY_CHAR_SRC})`,
      'g',
    ),
  )) {
    addDate(
      match.index,
      match.index + match[0].length,
      upcomingWeekday(ZH_WEEKDAY[match[1]!] as number),
    );
  }
  for (const match of masked.matchAll(
    new RegExp(`${NUM_SRC}月${NUM_SRC}[日號号]`, 'g'),
  )) {
    const month = parseNumeric(match[1]!);
    const day = parseNumeric(match[2]!);
    const start = match.index;
    const end = match.index + match[0].length;
    if (month === null || day === null || month < 1 || month > 12) {
      addInvalidDate(start, end);
      continue;
    }
    const thisYear = formatDate(todayParts.year, month, day);
    if (!isValidDate(thisYear)) {
      addInvalidDate(start, end);
      continue;
    }
    if (thisYear >= today) {
      addDate(start, end, thisYear);
    } else {
      const clamped = Math.min(day, daysInMonth(todayParts.year + 1, month));
      addDate(start, end, formatDate(todayParts.year + 1, month, clamped));
    }
  }
  for (const match of masked.matchAll(
    new RegExp(`(?<!月)${NUM_SRC}[號号]`, 'g'),
  )) {
    const day = parseNumeric(match[1]!);
    const start = match.index;
    const end = match.index + match[0].length;
    if (
      day === null ||
      day < 1 ||
      day > daysInMonth(todayParts.year, todayParts.month)
    ) {
      addInvalidDate(start, end);
      continue;
    }
    const thisMonth = formatDate(todayParts.year, todayParts.month, day);
    addDate(
      start,
      end,
      thisMonth >= today ? thisMonth : addMonths(today, 1, day),
    );
  }
  for (const match of masked.matchAll(/月底/g)) {
    addDate(match.index, match.index + match[0].length, lastDayOfThisMonth);
  }

  // Numeric dates.
  for (const match of masked.matchAll(
    /(?<!\d)(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?!\d)/g,
  )) {
    const date = formatDate(
      Number(match[1]),
      Number(match[3]),
      Number(match[4]),
    );
    const start = match.index;
    const end = match.index + match[0].length;
    if (isValidDate(date)) addDate(start, end, date);
    else addInvalidDate(start, end);
  }
  for (const match of masked.matchAll(
    /(?<![\d/])(\d{1,2})\/(\d{1,2})(?![\d/])/g,
  )) {
    const month = Number(match[1]);
    const day = Number(match[2]);
    const start = match.index;
    const end = match.index + match[0].length;
    const thisYear = formatDate(todayParts.year, month, day);
    if (!isValidDate(thisYear)) {
      addInvalidDate(start, end);
      continue;
    }
    if (thisYear >= today) {
      addDate(start, end, thisYear);
    } else {
      const clamped = Math.min(day, daysInMonth(todayParts.year + 1, month));
      addDate(start, end, formatDate(todayParts.year + 1, month, clamped));
    }
  }

  // English dates.
  for (const match of masked.matchAll(/\btonight\b/gi)) {
    addDate(match.index, match.index + match[0].length, today, true);
  }
  for (const match of masked.matchAll(/\bnext\s+week\b/gi)) {
    addDate(match.index, match.index + match[0].length, nextWeekStart);
  }
  for (const match of masked.matchAll(
    new RegExp(`\\bnext\\s+(${EN_WEEKDAY_SRC})\\b`, 'gi'),
  )) {
    addDate(
      match.index,
      match.index + match[0].length,
      weekdayInNextWeek(EN_WEEKDAY_INDEX[match[1]!.toLowerCase()] as number),
    );
  }
  for (const match of masked.matchAll(/\bin\s+(\d+)\s+days?\b/gi)) {
    addDate(
      match.index,
      match.index + match[0].length,
      addDays(today, Number(match[1])),
    );
  }
  for (const match of masked.matchAll(/\bin\s+(\d+)\s+weeks?\b/gi)) {
    addDate(
      match.index,
      match.index + match[0].length,
      addDays(today, Number(match[1]) * DAYS_PER_WEEK),
    );
  }
  for (const match of masked.matchAll(/\b(?:end\s+of\s+month|eom)\b/gi)) {
    addDate(match.index, match.index + match[0].length, lastDayOfThisMonth);
  }
  for (const match of masked.matchAll(/\b(?:tomorrow|tmrw|tmr|tom)\b/gi)) {
    addDate(match.index, match.index + match[0].length, addDays(today, 1));
  }
  for (const match of masked.matchAll(/\b(?:today|tod)\b/gi)) {
    addDate(match.index, match.index + match[0].length, today);
  }
  for (const match of masked.matchAll(
    new RegExp(`\\b(${EN_WEEKDAY_SRC})\\b`, 'gi'),
  )) {
    addDate(
      match.index,
      match.index + match[0].length,
      upcomingWeekday(EN_WEEKDAY_INDEX[match[1]!.toLowerCase()] as number),
    );
  }

  const freeDates = dateCandidates.filter(
    candidate => !blocked.some(range => overlaps(candidate, range)),
  );
  const dates = firstDisjoint(freeDates);

  // Times.
  const timeCandidates: TimeMatch[] = [];
  const addTime = (start: number, end: number, time: string): void => {
    timeCandidates.push({start, end, time});
  };

  for (const match of masked.matchAll(
    new RegExp(
      `(?:${ZH_PERIOD_SRC})?${ZH_HOUR_SRC}[點点時时](${ZH_MINUTE_SRC})?`,
      'g',
    ),
  )) {
    let hour = parseNumeric(match[2]!);
    const rawMinutes = match[3];
    const minutes = rawMinutes === undefined ? 0 : parseZhMinutes(rawMinutes);
    if (hour === null || minutes === null || hour > 24) continue;
    hour = hour === 24 ? 0 : applyPeriod(match[1], hour);
    if (hour > 23) continue;
    addTime(
      match.index,
      match.index + match[0].length,
      `${twoDigits(hour)}:${twoDigits(minutes)}`,
    );
  }
  for (const match of masked.matchAll(
    /(?<![\d:])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])/g,
  )) {
    addTime(
      match.index,
      match.index + match[0].length,
      `${twoDigits(Number(match[1]))}:${match[2]!}`,
    );
  }
  for (const match of masked.matchAll(
    /(?:\bat\b\s+)?\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/gi,
  )) {
    const hour12 = Number(match[1]);
    const minutes = Number(match[2] ?? 0);
    if (hour12 < 1 || hour12 > 12 || minutes > 59) continue;
    const isPm = match[3]!.toLowerCase() === 'p';
    const hour = hour12 === 12 ? (isPm ? 12 : 0) : isPm ? hour12 + 12 : hour12;
    addTime(
      match.index,
      match.index + match[0].length,
      `${twoDigits(hour)}:${twoDigits(minutes)}`,
    );
  }
  for (const match of masked.matchAll(/(?:\bat\b\s+)?\b(noon|midnight)\b/gi)) {
    const time = match[1]!.toLowerCase() === 'noon' ? '12:00' : '00:00';
    addTime(match.index, match.index + match[0].length, time);
  }

  const occupied = [...blocked, ...dates];
  const freeTimes = timeCandidates.filter(
    candidate => !occupied.some(range => overlaps(candidate, range)),
  );
  const times = firstDisjoint(freeTimes);

  let dueDate: string | null = null;
  let dueTime: string | null = null;
  let night = false;

  const firstDate = dates[0];
  if (firstDate) {
    dueDate = firstDate.date;
    night = firstDate.night;
    consume('date', firstDate.start, firstDate.end);
    for (let index = 1; index < dates.length; index++) {
      warnings.push('duplicate_date');
    }
  }

  const firstTime = times[0];
  if (firstTime) {
    dueTime = firstTime.time;
    consume('time', firstTime.start, firstTime.end);
    for (let index = 1; index < times.length; index++) {
      warnings.push('duplicate_time');
    }
  } else if (night) {
    dueTime = NIGHT_TIME;
  }

  if (dueTime !== null && dueDate === null) {
    const todayInstant = zonedToInstant(today, dueTime, timeZone);
    dueDate = todayInstant > now ? today : addDays(today, 1);
  }

  let rawTitle = '';
  for (let index = 0; index < text.length; index++) {
    if (!consumed[index]) rawTitle += text.charAt(index);
  }
  const title = rawTitle.replace(/\s+/gu, ' ').replace(TITLE_EDGE_RE, '');
  if (title.length === 0) warnings.push('empty_title');

  tokens.sort((a, b) => a.start - b.start);

  return {
    title,
    dueDate,
    dueTime,
    priority,
    quadrant,
    estimateMinutes,
    energy,
    tags,
    list,
    recurrence,
    tokens,
    warnings,
  };
}
