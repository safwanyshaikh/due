import type { AppData } from '../types';
import type { OfferReminder, UserServiceRecord } from './types';

export function blankService(
  provider: UserServiceRecord['provider'],
  now: string,
): UserServiceRecord {
  return {
    id: `svc_${Math.random().toString(36).slice(2, 9)}`,
    provider,
    serviceType: 'other',
    label: '',
    notes: '',
    createdAt: now,
  };
}

export function upsertService(data: AppData, s: UserServiceRecord): AppData {
  const exists = data.services.some((x) => x.id === s.id);
  return {
    ...data,
    services: exists ? data.services.map((x) => (x.id === s.id ? s : x)) : [...data.services, s],
  };
}

export function deleteService(data: AppData, id: string): AppData {
  return {
    ...data,
    services: data.services.filter((s) => s.id !== id),
    offerReminders: data.offerReminders.filter((r) => r.refId !== id),
  };
}

/** Stores a date and label only. It never contacts a provider. */
export function addOfferReminder(
  data: AppData,
  refId: string,
  label: string,
  date: string,
): AppData {
  const r: OfferReminder = { id: `or_${refId}_${date}`, refId, label: label.slice(0, 120), date };
  if (data.offerReminders.some((x) => x.id === r.id)) return data;
  return { ...data, offerReminders: [...data.offerReminders, r] };
}

export function removeOfferReminder(data: AppData, id: string): AppData {
  return { ...data, offerReminders: data.offerReminders.filter((r) => r.id !== id) };
}

/** Next relevant date the user entered for a service. */
export function nextServiceDate(
  s: UserServiceRecord,
  today: string,
): { date: string; label: string } | null {
  const opts: [string | null | undefined, string][] = [
    [s.trialEnd, 'Trial ends'],
    [s.claimDeadline, 'Claim by'],
    [s.benefitExpiry, 'Benefit expires'],
    [s.renewalDate, 'Renews'],
  ];
  const upcoming = opts.filter(([d]) => d && d >= today).sort((a, b) => a[0]!.localeCompare(b[0]!));
  return upcoming.length ? { date: upcoming[0][0]!, label: upcoming[0][1] } : null;
}
