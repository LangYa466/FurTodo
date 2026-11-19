import {describe, expect, it} from 'vitest';
import {
  firstOccurrenceOnOrAfter,
  nextOccurrence,
  normalizeRecurrence,
  type Recurrence,
} from '../../src/lib/recurrence';
import {diffDays} from '../../src/lib/time';

function makeRule(
  freq: Recurrence['freq'],
  overrides: Partial<Recurrence> = {},
): Recurrence {
  return {freq, interval: 1, basis: 'due', ...overrides};
}

describe('normalizeRecurrence', () => {
  it('weekly without byWeekday takes the weekday of the anchor', () => {
    // 2026-11-19 is a Thursday.
    const out = normalizeRecurrence(makeRule('weekly'), '2026-11-19');
    expect(out.byWeekday).toEqual([4]);
    expect(out.byMonthDay).toBeNull();
    expect(out.byMonth).toBeNull();
  });

  it('weekly byWeekday is deduplicated and sorted ascending without mutating the input', () => {
    const days = [5, 1, 5, 3];
    const out = normalizeRecurrence(
      makeRule('weekly', {byWeekday: days}),
      '2026-11-19',
    );
    expect(out.byWeekday).toEqual([1, 3, 5]);
    expect(out.byWeekday).not.toBe(days);
    expect(days).toEqual([5, 1, 5, 3]);
  });

  it('monthly without byMonthDay takes the anchor day of month', () => {
    const out = normalizeRecurrence(makeRule('monthly'), '2027-01-31');
    expect(out.byMonthDay).toBe(31);
  });

  it('yearly without byMonth/byMonthDay takes the anchor month and day', () => {
    const out = normalizeRecurrence(makeRule('yearly'), '2028-02-29');
    expect(out.byMonth).toBe(2);
    expect(out.byMonthDay).toBe(29);
    expect(out.byWeekday).toBeNull();
  });

  it('daily clears by* fields and defaults until/count to null', () => {
    const out = normalizeRecurrence(
      {
        freq: 'daily',
        interval: 2,
        byWeekday: [1],
        byMonthDay: 5,
        byMonth: 3,
        basis: 'due',
      },
      '2026-11-19',
    );
    expect(out).toEqual({
      freq: 'daily',
      interval: 2,
      until: null,
      count: null,
      basis: 'due',
      byWeekday: null,
      byMonthDay: null,
      byMonth: null,
    });
  });

  it('keeps until and count', () => {
    const out = normalizeRecurrence(
      makeRule('daily', {until: '2026-12-31', count: 3}),
      '2026-11-19',
    );
    expect(out.until).toBe('2026-12-31');
    expect(out.count).toBe(3);
  });

  it('returns a new object without mutating the input', () => {
    const input: Recurrence = {
      freq: 'weekly',
      interval: 1,
      byWeekday: [3, 1],
      basis: 'due',
    };
    const snapshot = structuredClone(input);
    const out = normalizeRecurrence(input, '2026-11-19');
    expect(out).not.toBe(input);
    expect(input).toEqual(snapshot);
    expect(out.byWeekday).not.toBe(input.byWeekday);
  });
});

describe('nextOccurrence: daily', () => {
  it('interval 1, due today becomes tomorrow', () => {
    const out = nextOccurrence({
      rule: makeRule('daily'),
      currentDue: '2026-11-19',
      completedOn: '2026-11-19',
      today: '2026-11-19',
      weekStart: 1,
    });
    expect(out).toEqual({dueDate: '2026-11-20', count: null});
  });

  it('interval 3, 5 days overdue lands on the first phase day >= today', () => {
    // Due 11-14; phase days are 11-17 and 11-20; today is 11-19.
    const out = nextOccurrence({
      rule: makeRule('daily', {interval: 3}),
      currentDue: '2026-11-14',
      completedOn: '2026-11-19',
      today: '2026-11-19',
      weekStart: 1,
    });
    expect(out?.dueDate).toBe('2026-11-20');
  });

  it('20 years overdue still lands on a phase day >= today via arithmetic jump', () => {
    const out = nextOccurrence({
      rule: makeRule('daily', {interval: 7}),
      currentDue: '2006-11-19',
      completedOn: '2026-11-19',
      today: '2026-11-19',
      weekStart: 1,
    });
    expect(out?.dueDate).toBe('2026-11-22');
    expect(diffDays('2006-11-19', out!.dueDate) % 7).toBe(0);
  });
});

describe('nextOccurrence: weekly', () => {
  it('Mon/Wed/Fri: Monday becomes Wednesday', () => {
    const out = nextOccurrence({
      rule: makeRule('weekly', {byWeekday: [1, 3, 5]}),
      currentDue: '2026-11-16',
      completedOn: '2026-11-16',
      today: '2026-11-16',
      weekStart: 1,
    });
    expect(out?.dueDate).toBe('2026-11-18');
  });

  it('Mon/Wed/Fri: Friday becomes next Monday', () => {
    const out = nextOccurrence({
      rule: makeRule('weekly', {byWeekday: [1, 3, 5]}),
      currentDue: '2026-11-20',
      completedOn: '2026-11-20',
      today: '2026-11-20',
      weekStart: 1,
    });
    expect(out?.dueDate).toBe('2026-11-23');
  });

  it('interval 2, [1,4], weekStart 1: Thursday becomes Monday 11 days later', () => {
    const out = nextOccurrence({
      rule: makeRule('weekly', {interval: 2, byWeekday: [1, 4]}),
      currentDue: '2026-11-19',
      completedOn: '2026-11-19',
      today: '2026-11-19',
      weekStart: 1,
    });
    expect(out?.dueDate).toBe('2026-11-30');
  });

  it('the phase of the same rule shifts with weekStart', () => {
    const rule = makeRule('weekly', {interval: 2, byWeekday: [1, 4]});
    const sunday = {
      currentDue: '2026-11-22',
      completedOn: '2026-11-22',
      today: '2026-11-22',
    };
    expect(nextOccurrence({rule, ...sunday, weekStart: 1})?.dueDate).toBe(
      '2026-11-30',
    );
    expect(nextOccurrence({rule, ...sunday, weekStart: 0})?.dueDate).toBe(
      '2026-11-23',
    );
  });

  it('catches up to the next occurrence after today when overdue', () => {
    const out = nextOccurrence({
      rule: makeRule('weekly', {byWeekday: [1, 4]}),
      currentDue: '2026-01-05',
      completedOn: '2026-11-18',
      today: '2026-11-18',
      weekStart: 1,
    });
    expect(out?.dueDate).toBe('2026-11-19'); // Thursday
  });
});

describe('nextOccurrence: monthly', () => {
  it('byMonthDay 31 does not drift: 1/31 -> 2/28 -> 3/31', () => {
    const rule = makeRule('monthly', {byMonthDay: 31});
    const first = nextOccurrence({
      rule,
      currentDue: '2027-01-31',
      completedOn: '2027-01-31',
      today: '2027-01-31',
      weekStart: 1,
    });
    expect(first?.dueDate).toBe('2027-02-28');

    const second = nextOccurrence({
      rule,
      currentDue: first!.dueDate,
      completedOn: '2027-02-28',
      today: '2027-02-28',
      weekStart: 1,
    });
    expect(second?.dueDate).toBe('2027-03-31');
  });

  it('byMonthDay -1: 2/28 becomes 3/31', () => {
    const out = nextOccurrence({
      rule: makeRule('monthly', {byMonthDay: -1}),
      currentDue: '2026-02-28',
      completedOn: '2026-02-28',
      today: '2026-02-28',
      weekStart: 1,
    });
    expect(out?.dueDate).toBe('2026-03-31');
  });

  it('interval 3 advances by phase months', () => {
    const rule = makeRule('monthly', {interval: 3, byMonthDay: 15});
    expect(
      nextOccurrence({
        rule,
        currentDue: '2026-01-15',
        completedOn: '2026-01-15',
        today: '2026-01-15',
        weekStart: 1,
      })?.dueDate,
    ).toBe('2026-04-15');
    expect(
      nextOccurrence({
        rule,
        currentDue: '2026-01-15',
        completedOn: '2026-11-19',
        today: '2026-11-19',
        weekStart: 1,
      })?.dueDate,
    ).toBe('2027-01-15');
  });

  it('catch-up: day already passed moves to the next phase month', () => {
    const out = nextOccurrence({
      rule: makeRule('monthly', {byMonthDay: 5}),
      currentDue: '2026-01-05',
      completedOn: '2026-11-19',
      today: '2026-11-19',
      weekStart: 1,
    });
    expect(out?.dueDate).toBe('2026-12-05');
  });
});

describe('nextOccurrence: yearly', () => {
  it('Feb 29 series: 2028-02-29 -> 2029/2030/2031-02-28 -> 2032-02-29', () => {
    const rule = makeRule('yearly', {byMonth: 2, byMonthDay: 29});
    const expected = ['2029-02-28', '2030-02-28', '2031-02-28', '2032-02-29'];
    let due = '2028-02-29';
    for (const want of expected) {
      const out = nextOccurrence({
        rule,
        currentDue: due,
        completedOn: due,
        today: due,
        weekStart: 1,
      });
      expect(out?.dueDate).toBe(want);
      due = out!.dueDate;
    }
  });

  it('years overdue still catch up by arithmetic jump', () => {
    const out = nextOccurrence({
      rule: makeRule('yearly', {byMonth: 3, byMonthDay: 10}),
      currentDue: '2020-03-10',
      completedOn: '2026-11-19',
      today: '2026-11-19',
      weekStart: 1,
    });
    expect(out?.dueDate).toBe('2027-03-10');
  });
});

describe('nextOccurrence: completion basis', () => {
  it('weekly interval 2: completion date + 14 days', () => {
    const out = nextOccurrence({
      rule: makeRule('weekly', {interval: 2, basis: 'completion'}),
      currentDue: '2026-11-19',
      completedOn: '2026-11-19',
      today: '2026-11-19',
      weekStart: 1,
    });
    expect(out?.dueDate).toBe('2026-12-03');
  });

  it('monthly: completion date plus one month, clamped to month end, ignoring byMonthDay', () => {
    const out = nextOccurrence({
      rule: makeRule('monthly', {basis: 'completion'}),
      currentDue: '2026-01-31',
      completedOn: '2026-01-31',
      today: '2026-01-31',
      weekStart: 1,
    });
    expect(out?.dueDate).toBe('2026-02-28');
  });
});

describe('nextOccurrence: until / count', () => {
  it('until is inclusive; past it the series ends', () => {
    const rule = makeRule('daily', {until: '2026-11-20'});
    expect(
      nextOccurrence({
        rule,
        currentDue: '2026-11-19',
        completedOn: '2026-11-19',
        today: '2026-11-19',
        weekStart: 1,
      })?.dueDate,
    ).toBe('2026-11-20');
    expect(
      nextOccurrence({
        rule,
        currentDue: '2026-11-20',
        completedOn: '2026-11-20',
        today: '2026-11-20',
        weekStart: 1,
      }),
    ).toBeNull();
  });

  it('count 3 returns count 2', () => {
    const out = nextOccurrence({
      rule: makeRule('daily', {count: 3}),
      currentDue: '2026-11-19',
      completedOn: '2026-11-19',
      today: '2026-11-19',
      weekStart: 1,
    });
    expect(out).toEqual({dueDate: '2026-11-20', count: 2});
  });

  it('count 1 ends the series', () => {
    expect(
      nextOccurrence({
        rule: makeRule('daily', {count: 1}),
        currentDue: '2026-11-19',
        completedOn: '2026-11-19',
        today: '2026-11-19',
        weekStart: 1,
      }),
    ).toBeNull();
  });

  it('null currentDue with due basis uses completedOn as the anchor', () => {
    const out = nextOccurrence({
      rule: makeRule('daily'),
      currentDue: null,
      completedOn: '2026-11-19',
      today: '2026-11-19',
      weekStart: 1,
    });
    expect(out).toEqual({dueDate: '2026-11-20', count: null});
  });
});

describe('firstOccurrenceOnOrAfter', () => {
  it('daily returns fromDate', () => {
    expect(firstOccurrenceOnOrAfter(makeRule('daily'), '2026-11-19', 1)).toBe(
      '2026-11-19',
    );
  });

  it('weekly [1]: Thursday becomes next Monday', () => {
    expect(
      firstOccurrenceOnOrAfter(
        makeRule('weekly', {byWeekday: [1]}),
        '2026-11-19',
        1,
      ),
    ).toBe('2026-11-23');
  });

  it('weekly [1]: Monday stays the same day', () => {
    expect(
      firstOccurrenceOnOrAfter(
        makeRule('weekly', {byWeekday: [1]}),
        '2026-11-16',
        1,
      ),
    ).toBe('2026-11-16');
  });

  it('weekly without byWeekday takes the weekday of fromDate', () => {
    expect(firstOccurrenceOnOrAfter(makeRule('weekly'), '2026-11-19', 1)).toBe(
      '2026-11-19',
    );
  });

  it('monthly 15: from the 16th moves to the 15th of next month', () => {
    expect(
      firstOccurrenceOnOrAfter(
        makeRule('monthly', {byMonthDay: 15}),
        '2026-11-16',
        1,
      ),
    ).toBe('2026-12-15');
  });

  it('monthly -1: mid-month moves to the end of the current month', () => {
    expect(
      firstOccurrenceOnOrAfter(
        makeRule('monthly', {byMonthDay: -1}),
        '2026-02-10',
        1,
      ),
    ).toBe('2026-02-28');
  });

  it('yearly Feb 29: clamps to 2/28 in common years, 2/29 in leap years', () => {
    const rule = makeRule('yearly', {byMonth: 2, byMonthDay: 29});
    expect(firstOccurrenceOnOrAfter(rule, '2027-02-01', 1)).toBe('2027-02-28');
    expect(firstOccurrenceOnOrAfter(rule, '2027-03-01', 1)).toBe('2028-02-29');
  });
});
