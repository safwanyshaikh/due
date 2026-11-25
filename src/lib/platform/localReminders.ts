import { planReminders, type PlannedReminder } from '../reminderPlan';
import type { AppData } from '../types';
import type { LocalNotification } from './types';

/** iOS keeps at most 64 pending local notifications; stay below it. */
export const MAX_LOCAL_NOTIFICATIONS = 60;

/** Deterministic positive 31-bit id (FNV-1a) so the same reminder always maps to the same notification. */
export function notificationId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) & 0x7fffffff || 1;
}

export function toLocalNotification(r: PlannedReminder): LocalNotification {
  return { id: notificationId(r.key), title: r.title, body: r.body, at: new Date(r.scheduledFor) };
}

/**
 * Future, unresolved reminders from the existing reminder plan (same lead times, quiet hours and snooze
 * rules as the in-app and e-mail reminders), soonest first, capped for the platform limit.
 */
export function planLocalNotifications(
  data: AppData,
  now: Date,
  limit = MAX_LOCAL_NOTIFICATIONS,
): LocalNotification[] {
  return planReminders(data, now, { includePast: false })
    .filter((r) => !r.acknowledged && new Date(r.scheduledFor).getTime() > now.getTime())
    .map(toLocalNotification)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, limit);
}
