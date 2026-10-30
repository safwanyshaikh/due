import { describe, expect, it } from 'vitest';
import {
  addDays,
  addMonthsClamped,
  daysBetween,
  daysInMonth,
  isLeapYear,
  isValidISO,
  monthPeriod,
  todayInTz,
  yearPeriod,
} from '../dates';

describe('dates', () => {
  it('handles leap years', () => {
    expect(isLeapYear(2028)).toBe(true);
    expect(isLeapYear(2100)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(daysInMonth(2028, 2)).toBe(29);
    expect(daysInMonth(2027, 2)).toBe(28);
    expect(isValidISO('2028-02-29')).toBe(true);
    expect(isValidISO('2027-02-29')).toBe(false);
  });
  it('clamps month-end without drifting', () => {
    expect(addMonthsClamped('2027-01-31', 1)).toBe('2027-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsClamped('2027-01-31', 2)).toBe('2027-03-31');
    expect(addMonthsClamped('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonthsClamped('2026-12-15', 1)).toBe('2027-01-15');
  });
  it('adds days across boundaries', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30);
  });
  it('computes IST today independent of server timezone', () => {
    // 20:00 UTC on 30 Oct = 01:30 IST on 31 Oct
    expect(todayInTz('Asia/Kolkata', new Date('2026-10-30T20:00:00Z'))).toBe('2026-10-31');
    expect(todayInTz('Asia/Kolkata', new Date('2026-10-30T18:29:00Z'))).toBe('2026-10-30');
    expect(todayInTz('UTC', new Date('2026-10-30T20:00:00Z'))).toBe('2026-10-30');
  });
  it('builds periods', () => {
    expect(monthPeriod(2028, 2)).toEqual({ start: '2028-02-01', end: '2028-02-29' });
    expect(yearPeriod(2026)).toEqual({ start: '2026-01-01', end: '2026-12-31' });
  });
});
