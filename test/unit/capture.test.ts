import {describe, expect, it} from 'vitest';
import {type CaptureContext, parseCapture} from '../../src/lib/capture';

const NOW = Date.parse('2026-11-19T10:00:00+08:00'); // 2026-11-19 is a Thursday

const ctx: CaptureContext = {now: NOW, timeZone: 'Asia/Taipei', weekStart: 1};
const sundayCtx: CaptureContext = {
  now: NOW,
  timeZone: 'Asia/Taipei',
  weekStart: 0,
};

describe('parseCapture — general', () => {
  it('parses a complete Chinese example', () => {
    const parsed = parseCapture(
      '明天下午3點 打電話給王先生確認報價 #電腦前 @工作 !高 ~15m',
      ctx,
    );
    expect(parsed.title).toBe('打電話給王先生確認報價');
    expect(parsed.dueDate).toBe('2026-11-20');
    expect(parsed.dueTime).toBe('15:00');
    expect(parsed.tags).toEqual(['電腦前']);
    expect(parsed.list).toBe('工作');
    expect(parsed.priority).toBe(3);
    expect(parsed.estimateMinutes).toBe(15);
    expect(parsed.warnings).toEqual([]);
  });

  it('deduplicates tags, keeping the first spelling', () => {
    const parsed = parseCapture('買牛奶 #外出辦事 #外出辦事', ctx);
    expect(parsed.tags).toEqual(['外出辦事']);
    expect(parsed.title).toBe('買牛奶');
    expect(parsed.warnings).toEqual([]);
  });

  it('weekly Friday with estimate and energy, no dueDate inferred', () => {
    const parsed = parseCapture('寫週報 *每週五 ~1h %低', ctx);
    expect(parsed.title).toBe('寫週報');
    expect(parsed.recurrence).toEqual({
      freq: 'weekly',
      interval: 1,
      byWeekday: [5],
      byMonthDay: null,
      byMonth: null,
      until: null,
      count: null,
      basis: 'due',
    });
    expect(parsed.energy).toBe('low');
    expect(parsed.estimateMinutes).toBe(60);
    expect(parsed.dueDate).toBeNull();
    expect(parsed.dueTime).toBeNull();
  });
});

describe('parseCapture — dates', () => {
  const cases: Array<[string, string | null]> = [
    ['下週一 開會', '2026-11-23'],
    ['週四 交報告', '2026-11-19'],
    ['週三 X', '2026-11-25'],
    ['11月30日 繳費', '2026-11-30'],
    ['3號 繳房租', '2026-12-03'],
    ['月底 結帳', '2026-11-30'],
    ['2026-12-25 聖誕節', '2026-12-25'],
    ['12/25 party', '2026-12-25'],
    ['3天後 回診', '2026-11-22'],
  ];

  it.each(cases)('%s → %s', (input, expected) => {
    expect(parseCapture(input, ctx).dueDate).toBe(expected);
  });

  it('next Sunday when weekStart is 0', () => {
    expect(parseCapture('下週日 聚會', ctx).dueDate).toBe('2026-11-29');
    expect(parseCapture('下週日 聚會', sundayCtx).dueDate).toBe('2026-11-22');
  });

  it('leaves dueDate null without a date, even with recurrence', () => {
    const parsed = parseCapture('喝水 *每天', ctx);
    expect(parsed.dueDate).toBeNull();
    expect(parsed.title).toBe('喝水');
  });

  it('keeps the second date in the title and warns', () => {
    const parsed = parseCapture('明天 開會 後天', ctx);
    expect(parsed.dueDate).toBe('2026-11-20');
    expect(parsed.title).toBe('開會 後天');
    expect(parsed.warnings).toContain('duplicate_date');
  });

  it('keeps an invalid date in the title and warns', () => {
    const parsed = parseCapture('2026-02-31 報帳', ctx);
    expect(parsed.dueDate).toBeNull();
    expect(parsed.title).toBe('2026-02-31 報帳');
    expect(parsed.warnings).toContain('invalid_date');
  });
});

describe('parseCapture — English', () => {
  it('tomorrow at 3pm with priority', () => {
    const parsed = parseCapture('call mom tomorrow at 3pm !2', ctx);
    expect(parsed.title).toBe('call mom');
    expect(parsed.dueDate).toBe('2026-11-20');
    expect(parsed.dueTime).toBe('15:00');
    expect(parsed.priority).toBe(2);
    expect(parsed.tokens.map(token => token.text)).toContain('at 3pm');
  });

  it('next mon', () => {
    expect(parseCapture('pay rent next mon', ctx).dueDate).toBe('2026-11-23');
  });

  it('every-mon,wed,fri with 1.5h', () => {
    const parsed = parseCapture('gym *every-mon,wed,fri ~1.5h', ctx);
    expect(parsed.title).toBe('gym');
    expect(parsed.recurrence?.freq).toBe('weekly');
    expect(parsed.recurrence?.byWeekday).toEqual([1, 3, 5]);
    expect(parsed.estimateMinutes).toBe(90);
  });

  it('time only: rolls an elapsed time to the next day', () => {
    const parsed = parseCapture('standup *weekdays 9:30', ctx);
    expect(parsed.recurrence).toMatchObject({
      freq: 'weekly',
      interval: 1,
      byWeekday: [1, 2, 3, 4, 5],
    });
    expect(parsed.dueDate).toBe('2026-11-20');
    expect(parsed.dueTime).toBe('09:30');
  });

  it('eom', () => {
    expect(parseCapture('report eom', ctx).dueDate).toBe('2026-11-30');
  });

  it('after-N-days uses the completion basis', () => {
    const parsed = parseCapture('water plants *after-3-days', ctx);
    expect(parsed.title).toBe('water plants');
    expect(parsed.recurrence).toEqual({
      freq: 'daily',
      interval: 3,
      byWeekday: null,
      byMonthDay: null,
      byMonth: null,
      until: null,
      count: null,
      basis: 'completion',
    });
  });
});

describe('parseCapture — recurrence rules', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['*每天', {freq: 'daily', interval: 1, byWeekday: null, basis: 'due'}],
    ['*每3天', {freq: 'daily', interval: 3, byWeekday: null, basis: 'due'}],
    [
      '*工作日',
      {freq: 'weekly', interval: 1, byWeekday: [1, 2, 3, 4, 5], basis: 'due'},
    ],
    [
      '*每2週一三',
      {freq: 'weekly', interval: 2, byWeekday: [1, 3], basis: 'due'},
    ],
    ['*每月15號', {freq: 'monthly', interval: 1, byMonthDay: 15, basis: 'due'}],
    [
      '*每月最後一天',
      {freq: 'monthly', interval: 1, byMonthDay: -1, basis: 'due'},
    ],
    ['*每年', {freq: 'yearly', interval: 1, basis: 'due'}],
    ['*完成後2週', {freq: 'weekly', interval: 2, basis: 'completion'}],
    ['*每十二個月', {freq: 'monthly', interval: 12, basis: 'due'}],
    [
      '*每周二、四',
      {freq: 'weekly', interval: 1, byWeekday: [2, 4], basis: 'due'},
    ],
    [
      '*weekends',
      {freq: 'weekly', interval: 1, byWeekday: [0, 6], basis: 'due'},
    ],
    [
      '*every-2-weeks',
      {freq: 'weekly', interval: 2, byWeekday: null, basis: 'due'},
    ],
    ['*annually', {freq: 'yearly', interval: 1, basis: 'due'}],
    ['*每月底', {freq: 'monthly', interval: 1, byMonthDay: -1, basis: 'due'}],
  ];

  it.each(cases)('%s', (input, expected) => {
    const parsed = parseCapture(`事情 ${input}`, ctx);
    expect(parsed.recurrence).toMatchObject(expected);
    expect(parsed.title).toBe('事情');
    expect(parsed.warnings).toEqual([]);
  });

  it('keeps an unknown rule in the title and warns', () => {
    const parsed = parseCapture('亂寫 *whenever', ctx);
    expect(parsed.recurrence).toBeNull();
    expect(parsed.title).toBe('亂寫 *whenever');
    expect(parsed.warnings).toContain('unknown_recurrence');
  });
});

describe('parseCapture — times', () => {
  const cases: Array<[string, string]> = [
    ['晚上8點15分 煮飯', '20:15'],
    ['下午三點半 開會', '15:30'],
    ['中午12點 吃飯', '12:00'],
    ['凌晨12點 睡覺', '00:00'],
    ['12am 睡覺', '00:00'],
    ['noon 吃飯', '12:00'],
  ];

  it.each(cases)('%s', (input, time) => {
    expect(parseCapture(input, ctx).dueTime).toBe(time);
  });

  it('tonight defaults to 20:00 today', () => {
    const parsed = parseCapture('今晚 吃藥', ctx);
    expect(parsed.title).toBe('吃藥');
    expect(parsed.dueDate).toBe('2026-11-19');
    expect(parsed.dueTime).toBe('20:00');
  });

  it('an explicit time overrides tonight', () => {
    const parsed = parseCapture('tonight 9pm', ctx);
    expect(parsed.dueDate).toBe('2026-11-19');
    expect(parsed.dueTime).toBe('21:00');
    expect(parsed.title).toBe('');
  });

  it('rolls a time equal to now to the next day', () => {
    expect(parseCapture('10:00 站會', ctx).dueDate).toBe('2026-11-20');
    expect(parseCapture('10:01 站會', ctx).dueDate).toBe('2026-11-19');
  });

  it('duplicate times: the second stays in the title', () => {
    const parsed = parseCapture('9點 先做 15:00 再檢查', ctx);
    expect(parsed.dueTime).toBe('09:00');
    expect(parsed.title).toContain('15:00');
    expect(parsed.warnings).toContain('duplicate_time');
  });
});

describe('parseCapture — edge cases', () => {
  it('a mid-word exclamation mark is not a token', () => {
    const parsed = parseCapture('買牛奶!', ctx);
    expect(parsed.priority).toBeNull();
    expect(parsed.title).toBe('買牛奶!');
  });

  it('a mid-word hash is not a tag', () => {
    const parsed = parseCapture('C#語言 練習', ctx);
    expect(parsed.tags).toEqual([]);
    expect(parsed.title).toBe('C#語言 練習');
  });

  it('keeps an invalid estimate in the title', () => {
    const parsed = parseCapture('伸展 ~0m', ctx);
    expect(parsed.estimateMinutes).toBeNull();
    expect(parsed.title).toBe('伸展 ~0m');
    expect(parsed.warnings).toContain('invalid_estimate');
  });

  it('empty title', () => {
    const parsed = parseCapture('#工作', ctx);
    expect(parsed.title).toBe('');
    expect(parsed.warnings).toContain('empty_title');
  });

  it('full-width markers', () => {
    const parsed = parseCapture('＃標籤 買東西 ！高', ctx);
    expect(parsed.tags).toEqual(['標籤']);
    expect(parsed.priority).toBe(3);
    expect(parsed.title).toBe('買東西');
  });

  it('tokens are position-sorted input slices', () => {
    const input = '明天 #工作 !2 下午3點 ~30m @家';
    const parsed = parseCapture(input, ctx);
    const starts = parsed.tokens.map(token => token.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    for (const token of parsed.tokens) {
      expect(token.text).toBe(input.slice(token.start, token.end));
    }
    expect(parsed.tokens.map(token => token.kind)).toEqual([
      'date',
      'tag',
      'priority',
      'time',
      'estimate',
      'list',
    ]);
  });

  it('duplicate list and duplicate priority', () => {
    const parsed = parseCapture('@家 掃地 @公司 !高 !low', ctx);
    expect(parsed.list).toBe('家');
    expect(parsed.priority).toBe(3);
    expect(parsed.title).toBe('掃地');
    expect(parsed.warnings).toContain('duplicate_list:@公司');
    expect(parsed.warnings).toContain('duplicate_priority');
  });

  it('quadrant is independent of priority', () => {
    const parsed = parseCapture('整理 !q2 桌面', ctx);
    expect(parsed.quadrant).toBe(2);
    expect(parsed.priority).toBeNull();
    expect(parsed.title).toBe('整理 桌面');
  });

  it('collapses whitespace and trims separators', () => {
    const parsed = parseCapture('  ，  買  牛奶  #家 ，', ctx);
    expect(parsed.title).toBe('買 牛奶');
  });
});

describe('parseCapture — spec details', () => {
  it('every Saturday and every-monday', () => {
    expect(parseCapture('值班 *每星期六', ctx).recurrence).toMatchObject({
      freq: 'weekly',
      byWeekday: [6],
    });
    expect(parseCapture('值班 *every-monday', ctx).recurrence).toMatchObject({
      freq: 'weekly',
      byWeekday: [1],
    });
    expect(parseCapture('值班 *every-day', ctx).recurrence).toMatchObject({
      freq: 'daily',
      interval: 1,
    });
  });

  it('next Wednesday, and unrelated words are not dates', () => {
    expect(parseCapture('下星期三 出差', ctx).dueDate).toBe('2026-11-25');
    expect(parseCapture('天黑 收衣服', ctx).dueDate).toBeNull();
  });

  it('half an hour and %medium', () => {
    const parsed = parseCapture('泡茶 ~半小時 %medium', ctx);
    expect(parsed.estimateMinutes).toBe(30);
    expect(parsed.energy).toBe('medium');
    expect(parsed.title).toBe('泡茶');
  });

  it('November 31 stays an invalid date', () => {
    const parsed = parseCapture('11月31日 對帳', ctx);
    expect(parsed.dueDate).toBeNull();
    expect(parsed.title).toBe('11月31日 對帳');
    expect(parsed.warnings).toContain('invalid_date');
  });

  it('1h30 and 1h30m', () => {
    expect(parseCapture('整理 ~1h30', ctx).estimateMinutes).toBe(90);
    expect(parseCapture('整理 ~1h30m', ctx).estimateMinutes).toBe(90);
    expect(parseCapture('整理 ~25h', ctx).warnings).toContain(
      'invalid_estimate',
    );
  });
});
