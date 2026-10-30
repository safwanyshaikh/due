import { describe, expect, it } from 'vitest';
import {
  activeReminders,
  allReminders,
  isQuietTime,
  normalizeOffsets,
  remindersForCommitment,
  remindersForSeason,
  reminderLocalTime,
} from '../reminders';
import { buildICS } from '../ics';
import { emptyData } from '../data';
import { mk } from './helpers';
import type { Season } from '../types';

describe('reminders', () => {
  const sub = mk({ id: 's', type: 'subscription', nextDue: '2026-11-10', nickname: 'Stream' });
  it('defaults to 7/3/1 days before', () => {
    const r = remindersForCommitment(sub).filter((x) => x.type === 'renewal');
    expect(r.map((x) => x.remindOn)).toEqual(['2026-11-03', '2026-11-07', '2026-11-09']);
  });
  it('keys are idempotent and offsets are de-duplicated', () => {
    const a = remindersForCommitment({
      ...sub,
      reminder: { enabled: true, offsets: [3, 3, 1, 1] },
    });
    const b = remindersForCommitment({ ...sub, reminder: { enabled: true, offsets: [1, 3] } });
    expect(a.map((x) => x.key)).toEqual(b.map((x) => x.key));
    expect(normalizeOffsets([3, 3, -1, 99, 1.5, 7])).toEqual([7, 3]);
    const both = allReminders([sub, sub], []);
    expect(new Set(both.map((x) => x.key)).size).toBe(both.length);
  });
  it('with today, targets the effective next occurrence instead of the stale anchor date', () => {
    // Monthly from 10 Nov; on 5 Dec the next renewal is 10 Dec, not the anchor.
    const items = allReminders([sub], [], '2026-12-05');
    const targets = new Set(items.filter((x) => x.type === 'renewal').map((x) => x.targetDate));
    expect(targets).toEqual(new Set(['2026-12-10']));
    expect(activeReminders(items, '2026-12-07').map((x) => x.offset)).toEqual([3]);
  });
  it('shows only one reminder per target date', () => {
    const items = allReminders([sub], []);
    expect(activeReminders(items, '2026-11-08').map((x) => x.offset)).toEqual([3]);
    expect(activeReminders(items, '2026-11-09').map((x) => x.offset)).toEqual([1]);
    expect(activeReminders(items, '2026-11-02')).toEqual([]);
    expect(activeReminders(items, '2026-11-11')).toEqual([]);
  });
  it('includes trial end and cancellation-by dates; none when disabled or cancelled', () => {
    const c = { ...sub, subscription: { trialEnd: '2026-11-05', cancellationBy: '2026-11-08' } };
    const types = new Set(remindersForCommitment(c).map((x) => x.type));
    expect(types).toEqual(new Set(['renewal', 'trial_end', 'cancellation_by']));
    expect(remindersForCommitment({ ...c, reminder: { enabled: false, offsets: [1] } })).toEqual(
      [],
    );
    expect(remindersForCommitment({ ...c, status: 'cancelled_confirmed_by_user' })).toEqual([]);
  });
  it('quiet hours wrap past midnight', () => {
    const q = { start: '22:00', end: '07:00' };
    expect(isQuietTime('23:30', q)).toBe(true);
    expect(isQuietTime('03:00', q)).toBe(true);
    expect(isQuietTime('09:00', q)).toBe(false);
    const s = { ...emptyData().settings, quietHours: { start: '08:00', end: '10:00' } };
    expect(reminderLocalTime(s)).toBe('10:00');
  });
});

describe('seasonal plans', () => {
  const stream = mk({
    id: 'st',
    type: 'subscription',
    nickname: 'Sports',
    nextDue: '2026-12-05',
    frequency: 'monthly',
  });
  const season: Season = {
    id: 'se',
    name: 'Tournament',
    start: '2027-02-10',
    end: '2027-03-20',
    linkedCommitmentIds: ['st'],
    considerLeadDays: 7,
    reviewLeadDays: 3,
    restartDate: '2027-09-01',
  };
  it('computes consider, review-before-renewal and restart dates', () => {
    const r = remindersForSeason(season, [stream]);
    const by = (t: string) => r.find((x) => x.type === t)!;
    expect(by('season_consider').remindOn).toBe('2027-02-03');
    expect(by('season_review').targetDate).toBe('2027-04-05'); // first renewal on/after season end
    expect(by('season_review').remindOn).toBe('2027-04-02');
    expect(by('season_restart').remindOn).toBe('2027-08-31');
  });
  it('season with a missing link does not crash', () => {
    expect(() =>
      remindersForSeason({ ...season, linkedCommitmentIds: ['nope'] }, [stream]),
    ).not.toThrow();
  });
});

describe('ics export', () => {
  it('is well-formed, escapes text and uses all-day events', () => {
    const ics = buildICS(
      [{ uid: 'a1', date: '2026-12-31', summary: 'Rent, due; soon', description: 'Line1\nLine2' }],
      new Date('2026-10-30T00:00:00Z'),
    );
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261231');
    expect(ics).toContain('DTEND;VALUE=DATE:20270101');
    expect(ics).toContain('SUMMARY:Rent\\, due\\; soon');
    expect(ics).toContain('DESCRIPTION:Line1\\nLine2');
    expect(ics.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    for (const line of ics.split('\r\n')) expect(line.length).toBeLessThanOrEqual(75);
  });
});
