import { z } from 'zod';
import type { Queryable } from './db.js';

export const SETTING_SCHEMAS = {
  frequency_defaults: z
    .object({
      critical: z.number().int().min(15).max(525600),
      regular: z.number().int().min(15).max(525600),
      secondary: z.number().int().min(15).max(525600),
    })
    .strict(),
  retry: z
    .object({
      base_minutes: z.number().int().min(1).max(10080),
      max_minutes: z.number().int().min(1).max(43200),
      max_attempts_before_inaccessible: z.number().int().min(1).max(100),
    })
    .strict()
    .refine((v) => v.max_minutes >= v.base_minutes, 'max_minutes must be >= base_minutes'),
  retention: z
    .object({
      snapshots_days: z.number().int().min(7).max(3650),
      login_events_days: z.number().int().min(7).max(3650),
    })
    .strict(),
  notifications: z
    .object({
      email_enabled: z.boolean(),
      recipients: z.array(z.string().email()).max(20),
    })
    .strict(),
  business: z
    .object({
      app_name: z.string().min(1).max(80),
      support_email: z.string().email().nullable(),
    })
    .strict(),
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]> };

export const DEFAULT_SETTINGS: Settings = {
  frequency_defaults: { critical: 1440, regular: 10080, secondary: 10080 },
  retry: { base_minutes: 30, max_minutes: 1440, max_attempts_before_inaccessible: 8 },
  retention: { snapshots_days: 365, login_events_days: 180 },
  notifications: { email_enabled: false, recipients: [] },
  business: { app_name: 'Due', support_email: null },
};

export const SETTING_KEYS = Object.keys(SETTING_SCHEMAS) as SettingKey[];

/** Stored values override defaults; unknown/invalid stored values fall back to defaults. */
export async function getSettings(q: Queryable): Promise<Settings> {
  const rows = (await q.query<{ key: string; value: unknown }>('SELECT key, value FROM settings')).rows;
  const out: Settings = structuredClone(DEFAULT_SETTINGS);
  for (const row of rows) {
    if (!(row.key in SETTING_SCHEMAS)) continue;
    const key = row.key as SettingKey;
    const r = SETTING_SCHEMAS[key].safeParse(row.value);
    if (r.success) (out as Record<string, unknown>)[key] = r.data;
  }
  return out;
}
