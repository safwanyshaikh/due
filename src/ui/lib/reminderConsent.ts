/**
 * Reminder channel consent, per device. No reminder is shown or sent until the person has chosen a channel
 * and agreed to it. Email consent is also recorded on the server (purpose 'reminders_email').
 */
import { readJsonPref, writeJsonPref } from './prefs';

export type ReminderChannelChoice = 'in_app' | 'email' | 'calendar';

export interface ReminderConsent {
  channel: ReminderChannelChoice;
  version: string;
  at: string;
}

export const REMINDER_CONSENT_KEY = 'reminder-consent';

export function readReminderConsent(): ReminderConsent | null {
  const c = readJsonPref<ReminderConsent | null>(REMINDER_CONSENT_KEY, null);
  return c && typeof c.channel === 'string' && typeof c.at === 'string' ? c : null;
}

export function writeReminderConsent(c: ReminderConsent | null): void {
  writeJsonPref(REMINDER_CONSENT_KEY, c);
}

export function hasReminderConsent(channel: ReminderChannelChoice): boolean {
  return readReminderConsent()?.channel === channel;
}
