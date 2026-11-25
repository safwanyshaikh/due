import { useEffect } from 'react';
import { getPlatform, isNative } from '../../lib/platform';
import { planLocalNotifications } from '../../lib/platform/localReminders';
import { useApp } from '../store';
import { readPref, writePref } from './prefs';

const PREF = 'device-notifications';
const CHANGED = 'due:device-notifications-changed';

export function deviceNotificationsOn(): boolean {
  return readPref(PREF) === '1';
}

export function setDeviceNotifications(on: boolean): void {
  writePref(PREF, on ? '1' : null);
  window.dispatchEvent(new Event(CHANGED));
}

/**
 * Keeps the device's local notifications in step with the reminder plan, but only after the person turned
 * them on (and the OS allowed it). Reschedules whenever the data changes; turning off cancels everything.
 * Does nothing in the browser.
 */
export function useLocalReminders(): void {
  const { data } = useApp();
  useEffect(() => {
    if (!isNative()) return;
    let cancelled = false;
    const sync = async () => {
      const p = getPlatform();
      if (!deviceNotificationsOn()) {
        await p.notifications.cancelAll();
        return;
      }
      if ((await p.notifications.permission()) !== 'granted') return;
      if (cancelled) return;
      await p.notifications.replaceAll(planLocalNotifications(data, new Date()));
    };
    void sync().catch(() => undefined);
    const on = () => void sync().catch(() => undefined);
    window.addEventListener(CHANGED, on);
    return () => {
      cancelled = true;
      window.removeEventListener(CHANGED, on);
    };
  }, [data]);
}
