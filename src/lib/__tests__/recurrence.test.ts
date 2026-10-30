import { describe, expect, it } from 'vitest';
import {
  describeRule,
  nextOccurrences,
  nthWeekdayOfMonth,
  occurrencesBetween,
  ordinal,
  previousOccurrence,
  rules,
  validateRule,
  weekdayOf,
  cadenceMonths,
  isAdvancedRule,
  type RecurrenceRule,
} from '../recurrence';

const dates = (r: RecurrenceRule, from: string, n: number) =>
  nextOccurrences(r, from, n).map((o) => o.date);

describe('monthly and end-of-month transitions', () => {
  it('31st clamps to 28 Feb (non-leap) and returns to 31 without drift', () => {
    expect(dates(rules.monthly('2027-01-31'), '2027-01-01', 5)).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-31',
      '2027-04-30',
      '2027-05-31',
    ]);
  });
  it('31st clamps to 29 Feb in a leap year', () => {
    expect(dates(rules.monthly('2028-01-31'), '2028-02-01', 2)).toEqual([
      '2028-02-29',
      '2028-03-31',
    ]);
  });
  it('30th: 28/29 Feb then 30 Mar; 29th in leap and non-leap Feb', () => {
    expect(dates(rules.monthly('2027-01-30'), '2027-02-01', 2)).toEqual([
      '2027-02-28',
      '2027-03-30',
    ]);
    expect(dates(rules.monthly('2028-01-29'), '2028-02-01', 1)).toEqual(['2028-02-29']);
    expect(dates(rules.monthly('2027-01-29'), '2027-02-01', 2)).toEqual([
      '2027-02-28',
      '2027-03-29',
    ]);
  });
  it('anchor stored as 28 Feb with dayOfMonth 31 keeps the intended day (drift prevention)', () => {
    const r = rules.monthly('2027-02-28', 31);
    expect(dates(r, '2027-02-01', 3)).toEqual(['2027-02-28', '2027-03-31', '2027-04-30']);
  });
  it('dayOfMonth earlier than the start day begins the next month', () => {
    expect(dates(rules.monthly('2026-11-20', 5), '2026-01-01', 2)).toEqual([
      '2026-12-05',
      '2027-01-05',
    ]);
  });
  it('100 months of a 31st rule never drift', () => {
    const all = dates(rules.monthly('2026-01-31'), '2026-01-01', 100);
    expect(all.every((d) => ['31', '30', '29', '28'].includes(d.slice(8)))).toBe(true);
    expect(all.filter((d) => d.slice(5, 7) === '03').every((d) => d.endsWith('31'))).toBe(true);
  });
  it('end of month: always the last day, including leap Feb', () => {
    expect(dates(rules.endOfMonth('2027-12-15'), '2027-12-01', 4)).toEqual([
      '2027-12-31',
      '2028-01-31',
      '2028-02-29',
      '2028-03-31',
    ]);
    expect(dates(rules.endOfMonth('2027-01-01', 2), '2027-01-01', 3)).toEqual([
      '2027-01-31',
      '2027-03-31',
      '2027-05-31',
    ]);
  });
});

describe('quarterly, half-yearly, custom months, annual', () => {
  it('quarterly from 31 Jan: Apr 30, Jul 31, Oct 31', () => {
    expect(dates(rules.quarterly('2027-01-31'), '2027-01-01', 4)).toEqual([
      '2027-01-31',
      '2027-04-30',
      '2027-07-31',
      '2027-10-31',
    ]);
  });
  it('half-yearly from 31 Aug: 28/29 Feb then 31 Aug', () => {
    expect(dates(rules.halfYearly('2027-08-31'), '2027-08-01', 3)).toEqual([
      '2027-08-31',
      '2028-02-29',
      '2028-08-31',
    ]);
  });
  it('custom 4 months', () => {
    expect(dates(rules.customMonths('2026-10-30', 4), '2026-10-01', 3)).toEqual([
      '2026-10-30',
      '2027-02-28',
      '2027-06-30',
    ]);
  });
  it('annual 29 Feb falls on 28 Feb in non-leap years', () => {
    expect(dates(rules.annual('2028-02-29'), '2028-01-01', 5)).toEqual([
      '2028-02-29',
      '2029-02-28',
      '2030-02-28',
      '2031-02-28',
      '2032-02-29',
    ]);
  });
  it('annual(month, day) with a later start', () => {
    expect(
      dates({ kind: 'annual', start: '2026-06-01', month: 3, day: 14 }, '2026-01-01', 2),
    ).toEqual(['2027-03-14', '2028-03-14']);
  });
  it('count and until bound the sequence', () => {
    expect(dates({ ...rules.monthly('2026-11-05'), count: 3 }, '2026-01-01', 10)).toEqual([
      '2026-11-05',
      '2026-12-05',
      '2027-01-05',
    ]);
    // count is from the anchor: asking from later returns only what remains
    expect(dates({ ...rules.monthly('2026-11-05'), count: 3 }, '2026-12-06', 10)).toEqual([
      '2027-01-05',
    ]);
    expect(
      dates({ ...rules.monthly('2026-11-05'), until: '2026-12-31' }, '2026-01-01', 10),
    ).toEqual(['2026-11-05', '2026-12-05']);
  });
});

describe('weekday rules', () => {
  it('weekdayOf and nth weekday helpers', () => {
    expect(weekdayOf('2026-10-30')).toBe(5); // Friday
    expect(nthWeekdayOfMonth(2026, 11, 1, 1)).toBe('2026-11-02'); // first Monday
    expect(nthWeekdayOfMonth(2026, 10, 5, -1)).toBe('2026-10-30'); // last Friday
    expect(nthWeekdayOfMonth(2027, 2, 0, -1)).toBe('2027-02-28'); // last Sunday on month end
    expect(nthWeekdayOfMonth(2026, 9, 2, 1)).toBe('2026-09-01'); // first Tuesday on the 1st
  });
  it('last Friday of every month', () => {
    expect(dates(rules.nthWeekday('2026-10-01', -1, 5), '2026-10-01', 4)).toEqual([
      '2026-10-30',
      '2026-11-27',
      '2026-12-25',
      '2027-01-29',
    ]);
  });
  it("first Monday; a start after this month's first Monday skips to next month", () => {
    expect(dates(rules.nthWeekday('2026-11-03', 1, 1), '2026-01-01', 2)).toEqual([
      '2026-12-07',
      '2027-01-04',
    ]);
  });
  it('fourth Thursday in leap February; second Tuesday every 3 months', () => {
    expect(dates(rules.nthWeekday('2028-02-01', 4, 4), '2028-02-01', 1)).toEqual(['2028-02-24']);
    expect(dates(rules.nthWeekday('2026-11-01', 2, 2, 3), '2026-11-01', 3)).toEqual([
      '2026-11-10',
      '2027-02-09',
      '2027-05-11',
    ]);
  });
  it('every 2 weeks on Friday from a Wednesday start', () => {
    expect(dates(rules.everyWeeks('2026-10-28', 2, 5), '2026-10-01', 3)).toEqual([
      '2026-10-30',
      '2026-11-13',
      '2026-11-27',
    ]);
  });
  it('weekly across a year boundary', () => {
    expect(dates(rules.everyWeeks('2026-12-25', 1), '2026-12-25', 3)).toEqual([
      '2026-12-25',
      '2027-01-01',
      '2027-01-08',
    ]);
  });
});

describe('trial to paid', () => {
  it('no charge during the trial; paid amount from the trial end', () => {
    const r = rules.trialToPaid('2026-11-12', 195000);
    const occ = nextOccurrences(r, '2026-10-30', 3);
    expect(occ.map((o) => o.date)).toEqual(['2026-11-12', '2026-12-12', '2027-01-12']);
    expect(occ.every((o) => o.amountPaise === 195000 && o.phase === 'paid')).toBe(true);
  });
  it('paid rule anchored before the trial end is filtered to on/after the trial end', () => {
    const r = rules.trialToPaid('2026-11-12', 50000, rules.monthly('2026-10-01', 1));
    expect(dates(r, '2026-10-01', 2)).toEqual(['2026-12-01', '2027-01-01']);
  });
  it('annual paid rule', () => {
    expect(
      dates(rules.trialToPaid('2026-11-12', 129900, rules.annual('2026-11-12')), '2026-01-01', 2),
    ).toEqual(['2026-11-12', '2027-11-12']);
  });
});

describe('one-time and irregular', () => {
  it('one-time yields a single date', () => {
    expect(dates(rules.oneTime('2026-12-01'), '2026-01-01', 5)).toEqual(['2026-12-01']);
    expect(dates(rules.oneTime('2026-12-01'), '2026-12-02', 5)).toEqual([]);
  });
  it('irregular returns none without a user date, and only the user date with one', () => {
    expect(nextOccurrences(rules.irregular(), '2026-01-01', 5)).toEqual([]);
    expect(occurrencesBetween(rules.irregular(), '2000-01-01', '2100-01-01')).toEqual([]);
    expect(dates(rules.irregular('2026-11-20'), '2026-01-01', 5)).toEqual(['2026-11-20']);
    expect(cadenceMonths(rules.irregular('2026-11-20'))).toBeNull();
  });
});

describe('occurrencesBetween / previousOccurrence', () => {
  it('is inclusive and keeps stable sequence numbers', () => {
    const r = rules.monthly('2026-01-15');
    const o = occurrencesBetween(r, '2026-03-15', '2026-05-15');
    expect(o.map((x) => [x.date, x.seq])).toEqual([
      ['2026-03-15', 2],
      ['2026-04-15', 3],
      ['2026-05-15', 4],
    ]);
    expect(occurrencesBetween(r, '2026-05-16', '2026-05-01')).toEqual([]);
    expect(previousOccurrence(r, '2026-03-15')?.date).toBe('2026-02-15');
    expect(previousOccurrence(r, '2026-01-15')).toBeNull();
  });
});

describe('describeRule', () => {
  it('plain English for every rule', () => {
    expect(describeRule(rules.monthly('2026-01-31'))).toBe(
      'Every month on the 31st (last day in shorter months)',
    );
    expect(describeRule(rules.monthly('2026-01-05'))).toBe('Every month on the 5th');
    expect(describeRule(rules.nthWeekday('2026-10-01', -1, 5))).toBe('Last Friday of every month');
    expect(describeRule(rules.nthWeekday('2026-10-01', 1, 1))).toBe('First Monday of every month');
    expect(describeRule(rules.nthWeekday('2026-10-01', 2, 2, 3))).toBe(
      'Second Tuesday of every 3 months',
    );
    expect(describeRule(rules.everyWeeks('2026-10-30', 1))).toBe('Every Friday');
    expect(describeRule(rules.everyWeeks('2026-10-30', 2))).toBe('Every 2 weeks on Friday');
    expect(describeRule(rules.trialToPaid('2026-11-12', 195000))).toBe(
      'Trial ends 12 Nov, then ₹1,950 every month',
    );
    expect(describeRule(rules.trialToPaid('2026-11-12', null))).toBe(
      'Trial ends 12 Nov, then paid every month',
    );
    expect(describeRule(rules.endOfMonth('2026-01-01'))).toBe('Last day of every month');
    expect(describeRule(rules.quarterly('2026-01-22'))).toBe('Every 3 months on the 22nd');
    expect(describeRule(rules.halfYearly('2026-01-03'))).toBe('Every 6 months on the 3rd');
    expect(describeRule(rules.customMonths('2026-01-11', 4))).toBe('Every 4 months on the 11th');
    expect(describeRule(rules.annual('2028-02-29'))).toBe(
      'Every year on 29 Feb (28 Feb in non-leap years)',
    );
    expect(describeRule(rules.annual('2026-03-14'))).toBe('Every year on 14 Mar');
    expect(describeRule(rules.oneTime('2026-12-01'))).toBe('Once, on 1 Dec 2026');
    expect(describeRule(rules.irregular())).toBe(
      'No fixed schedule. Add the next date when you know it',
    );
    expect(describeRule(rules.irregular('2026-11-20'))).toBe(
      'No fixed schedule. Next date set by you: 20 Nov 2026',
    );
    expect(describeRule({ ...rules.monthly('2026-01-05'), count: 12 })).toBe(
      'Every month on the 5th, 12 times in total',
    );
  });
  it('ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 31].map(ordinal)).toEqual([
      '1st',
      '2nd',
      '3rd',
      '4th',
      '11th',
      '12th',
      '13th',
      '21st',
      '22nd',
      '23rd',
      '31st',
    ]);
  });
});

describe('validation and classification', () => {
  it('flags invalid rules', () => {
    expect(validateRule(rules.monthly('2026-01-05'))).toEqual([]);
    expect(validateRule({ kind: 'monthly', start: '2026-01-05', dayOfMonth: 32 })).not.toEqual([]);
    expect(
      validateRule({ kind: 'custom_months', start: '2026-01-05', intervalMonths: 0 }),
    ).not.toEqual([]);
    expect(validateRule({ kind: 'weekday', start: '2026-01-05', weekday: 1 })).not.toEqual([]);
    expect(
      validateRule({ kind: 'weekday', start: '2026-01-05', weekday: 1, nth: 1, everyWeeks: 2 }),
    ).not.toEqual([]);
  });
  it('advanced rules are weekday, trial_to_paid and custom months', () => {
    expect(isAdvancedRule(rules.monthly('2026-01-05'))).toBe(false);
    expect(isAdvancedRule(rules.endOfMonth('2026-01-05'))).toBe(false);
    expect(isAdvancedRule(rules.everyWeeks('2026-01-05', 2))).toBe(true);
    expect(isAdvancedRule(rules.trialToPaid('2026-01-05', 1))).toBe(true);
    expect(isAdvancedRule(rules.customMonths('2026-01-05', 2))).toBe(true);
  });
});
