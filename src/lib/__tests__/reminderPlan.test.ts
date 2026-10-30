import { describe, expect, it } from 'vitest';
import { emptyData } from '../data';
import { createObligation, markPaid, snooze, updateObligation } from '../mutations';
import {
  acknowledgeReminder,
  deliveryStatus,
  dueReminders,
  markReminderShown,
  planReminders,
  recordDeliveryResult,
  reminderStateText,
  snoozeReminder,
} from '../reminderPlan';
import { rules } from '../recurrence';
import { inQuietHours, shiftOutOfQuietHours, toZoned, zonedToUtc } from '../tz';
import type { AppData } from '../types';
import { ctx, NOW } from './helpers';

describe('timezone helpers', () => {
  it('Asia/Kolkata (+05:30), Asia/Kathmandu (+05:45), UTC', () => {
    expect(zonedToUtc('2026-11-05', '09:00', 'Asia/Kolkata').toISOString()).toBe(
      '2026-11-05T03:30:00.000Z',
    );
    expect(zonedToUtc('2026-11-05', '09:00', 'Asia/Kathmandu').toISOString()).toBe(
      '2026-11-05T03:15:00.000Z',
    );
    expect(zonedToUtc('2026-11-05', '00:10', 'UTC').toISOString()).toBe('2026-11-05T00:10:00.000Z');
    expect(toZoned('2026-11-04T20:00:00.000Z', 'Asia/Kolkata')).toEqual({
      date: '2026-11-05',
      time: '01:30',
    });
  });
  it('handles DST in New York (gap moves forward, both offsets)', () => {
    expect(zonedToUtc('2026-07-01', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-07-01T13:00:00.000Z',
    );
    expect(zonedToUtc('2026-12-01', '09:00', 'America/New_York').toISOString()).toBe(
      '2026-12-01T14:00:00.000Z',
    );
    // 2026-03-08 02:30 does not exist in New York
    expect(
      toZoned(zonedToUtc('2026-03-08', '02:30', 'America/New_York'), 'America/New_York').time,
    ).toBe('03:30');
  });
  it('quiet hours across midnight', () => {
    const q = { start: '22:00', end: '07:00' };
    expect(inQuietHours('23:30', q)).toBe(true);
    expect(inQuietHours('06:59', q)).toBe(true);
    expect(inQuietHours('07:00', q)).toBe(false);
    expect(inQuietHours('12:00', q)).toBe(false);
    expect(shiftOutOfQuietHours('2026-11-04', '23:30', q)).toEqual({
      date: '2026-11-05',
      time: '07:00',
      shifted: true,
    });
    expect(shiftOutOfQuietHours('2026-11-04', '05:00', q)).toEqual({
      date: '2026-11-04',
      time: '07:00',
      shifted: true,
    });
    expect(shiftOutOfQuietHours('2026-11-04', '09:00', q)).toEqual({
      date: '2026-11-04',
      time: '09:00',
      shifted: false,
    });
    expect(shiftOutOfQuietHours('2026-11-04', '13:30', { start: '13:00', end: '14:00' })).toEqual({
      date: '2026-11-04',
      time: '14:00',
      shifted: true,
    });
    expect(inQuietHours('10:00', { start: '08:00', end: '08:00' })).toBe(false);
  });
});

function seed(over: Partial<Parameters<typeof createObligation>[1]> = {}): {
  data: AppData;
  id: string;
} {
  const r = createObligation(
    emptyData(),
    {
      type: 'emi',
      provider: 'Home loan',
      amountPaise: 2209300,
      rule: rules.monthly('2026-11-05'),
      reminder: { enabled: true, offsets: [3, 1] },
      ...over,
    },
    ctx(),
  );
  return { data: r.data, id: r.data.commitments[0].id };
}

describe('planReminders', () => {
  it('per-obligation lead times at 09:00 IST, essential → important, in-app scheduled', () => {
    const { data, id } = seed();
    const plan = planReminders(data, NOW, { horizonDays: 10 });
    expect(plan.map((p) => [p.key, p.localDate, p.localTime, p.scheduledFor])).toEqual([
      [`${id}:due:2026-11-05:3`, '2026-11-02', '09:00', '2026-11-02T03:30:00.000Z'],
      [`${id}:due:2026-11-05:1`, '2026-11-04', '09:00', '2026-11-04T03:30:00.000Z'],
    ]);
    expect(plan[0]).toMatchObject({
      severity: 'important',
      channel: 'in_app',
      status: 'scheduled',
      timezone: 'Asia/Kolkata',
      title: 'Home loan ₹22,093 due 5 Nov 2026',
    });
  });
  it('a reminder time inside quiet hours shifts across midnight', () => {
    const { data, id } = seed({ reminder: { enabled: true, offsets: [1], time: '23:00' } });
    const [r] = planReminders(data, NOW, { horizonDays: 10 });
    expect(r).toMatchObject({
      key: `${id}:due:2026-11-05:1`,
      localDate: '2026-11-05',
      localTime: '07:00',
      shiftedForQuietHours: true,
      scheduledFor: '2026-11-05T01:30:00.000Z',
    });
  });
  it('respects the user timezone setting', () => {
    const { data } = seed({ reminder: { enabled: true, offsets: [1] } });
    const ny: AppData = { ...data, settings: { ...data.settings, timezone: 'America/New_York' } };
    expect(planReminders(ny, NOW, { horizonDays: 10 })[0].scheduledFor).toBe(
      '2026-11-04T14:00:00.000Z',
    );
  });
  it('unavailable channels are reported as unavailable, never sent', () => {
    const { data, id } = seed({ reminder: { enabled: true, offsets: [1], channel: 'email' } });
    const plan = planReminders(data, NOW, { horizonDays: 10 });
    expect(plan[0].status).toBe('unavailable');
    expect(
      planReminders(data, NOW, { horizonDays: 10, available: { email: true } })[0].status,
    ).toBe('scheduled');
    const failed = recordDeliveryResult(data, `${id}:due:2026-11-05:1`, {
      channel: 'email',
      ok: false,
      at: NOW,
      detail: 'bounce',
    });
    expect(
      planReminders(failed, NOW, { horizonDays: 10, available: { email: true } })[0].status,
    ).toBe('failed');
    const sent = recordDeliveryResult(failed, `${id}:due:2026-11-05:1`, {
      channel: 'email',
      ok: true,
      at: NOW,
      detail: 'msg-1',
    });
    expect(
      planReminders(sent, NOW, { horizonDays: 10, available: { email: true } })[0].status,
    ).toBe('sent');
    expect(deliveryStatus(undefined, 'push', false)).toBe('unavailable');
  });
  it('in-app shown is recorded once', () => {
    const { data, id } = seed({ reminder: { enabled: true, offsets: [1] } });
    const key = `${id}:due:2026-11-05:1`;
    const shown = markReminderShown(data, key, NOW);
    expect(markReminderShown(shown, key, NOW)).toBe(shown);
    expect(planReminders(shown, NOW, { horizonDays: 10 })[0].status).toBe('shown');
  });
  it('acknowledge removes a reminder; snooze re-times it; both undoable', () => {
    const { data, id } = seed({ reminder: { enabled: true, offsets: [1] } });
    const key = `${id}:due:2026-11-05:1`;
    const ack = acknowledgeReminder(data, key, { now: NOW });
    expect(planReminders(ack.data, NOW, { horizonDays: 10 })).toEqual([]);
    expect(planReminders(ack.undo(), NOW, { horizonDays: 10 })).toHaveLength(1);
    const sn = snoozeReminder(data, key, '2026-11-04T12:30:00.000Z', { now: NOW });
    expect(planReminders(sn.data, NOW, { horizonDays: 10 })[0]).toMatchObject({
      localDate: '2026-11-04',
      localTime: '18:00',
    });
    expect(sn.event.action).toBe('reminder_snoozed');
  });
  it('paid occurrences and disabled reminders produce nothing; occurrence snooze delays', () => {
    const { data, id } = seed({ reminder: { enabled: true, offsets: [3] } });
    expect(planReminders(markPaid(data, id, ctx()).data, NOW, { horizonDays: 10 })).toEqual([]);
    const off = updateObligation(
      data,
      id,
      { reminder: { enabled: false, offsets: [3] } },
      { now: NOW },
    );
    expect(planReminders(off.data, NOW)).toEqual([]);
    const sn = snooze(data, id, '2026-11-04', ctx());
    expect(planReminders(sn.data, NOW, { horizonDays: 10 })[0].localDate).toBe('2026-11-04');
  });
  it('trial ending reminders before the first paid charge', () => {
    const { data, id } = seed({
      type: 'subscription',
      provider: 'Spotify',
      amountPaise: null,
      rule: rules.trialToPaid('2026-11-12', 11900),
      reminder: { enabled: true, offsets: [1] },
    });
    const trial = planReminders(data, NOW, { horizonDays: 14 }).filter(
      (p) => p.kind === 'trial_ending',
    );
    expect(trial.map((t) => t.key)).toEqual([
      `${id}:trial_ending:2026-11-12:3`,
      `${id}:trial_ending:2026-11-12:1`,
    ]);
    expect(trial[0]).toMatchObject({
      severity: 'important',
      title: 'Spotify trial ends 12 Nov 2026',
    });
  });
  it('dueReminders surfaces one per occurrence (most imminent lead)', () => {
    const { data } = seed();
    const plan = planReminders(data, NOW, { horizonDays: 10 });
    expect(dueReminders(plan, '2026-11-01T00:00:00.000Z')).toEqual([]);
    expect(dueReminders(plan, '2026-11-02T04:00:00.000Z').map((r) => r.leadDays)).toEqual([3]);
    expect(dueReminders(plan, '2026-11-04T04:00:00.000Z').map((r) => r.leadDays)).toEqual([1]);
  });
  it('reminder state text', () => {
    const { data } = seed();
    const c = data.commitments[0];
    expect(reminderStateText(c)).toBe('Reminds 3, 1 days before · in app');
    expect(
      reminderStateText({ ...c, reminder: { enabled: true, offsets: [1, 0], channel: 'email' } }),
    ).toBe('Reminds 1 day before and on the day · by email');
    expect(reminderStateText({ ...c, reminder: { enabled: false, offsets: [] } })).toBe(
      'Reminders off',
    );
  });
});
