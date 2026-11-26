import { z } from 'zod';
import type { Queryable } from './db.js';
import { isValidGstin } from './consumer/gstin.js';
import { LEGAL_DEFAULTS, LEGAL_SCHEMAS } from './legal/index.js';

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
      // At least a year (CERT-In: 180 days; Due keeps 365 for admin sign-in history).
      login_events_days: z.number().int().min(365).max(3650),
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
  /** Shown before checkout (GET /api/public/plans). Admin-editable; must be legally reviewed before launch. */
  billing_terms: z
    .object({
      renewal: z.string().trim().min(1).max(2000),
      cancellation: z.string().trim().min(1).max(2000),
      refund: z.string().trim().min(1).max(2000),
      legal_review_status: z.enum(['pending', 'reviewed']),
    })
    .strict(),
  /** Tax wording shown next to prices (GET /api/public/plans), e.g. "Prices include 18% GST". */
  'billing.tax_note': z.string().trim().max(300).nullable(),
  'billing.prices_include_tax': z.boolean(),
  /** Whether the company is registered under GST. When false no GST is charged or shown and invoices say so. */
  'billing.gst_registered': z.boolean(),
  /** 15-character GSTIN printed on invoices and receipts; only used when registered. */
  'billing.gstin': z
    .string()
    .trim()
    .toUpperCase()
    .refine(isValidGstin, 'Not a valid GSTIN: 15 characters, state code, PAN pattern and check character')
    .nullable(),
  /** Free public beta: while true (and not past `beta.ends_on`), every signed-in account gets Plus features and checkout is refused. */
  'beta.plus_free': z.boolean(),
  /** Optional last day (inclusive, IST) of the free beta, as YYYY-MM-DD. Null means no end date announced. */
  'beta.ends_on': z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-12-31')
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Not a real calendar date')
    .nullable(),
  /** Store links shown on the landing page only when set (https URLs). */
  'app.android_url': z.string().trim().url().max(500).regex(/^https:\/\//, 'Use an https:// link').nullable(),
  'app.ios_url': z.string().trim().url().max(500).regex(/^https:\/\//, 'Use an https:// link').nullable(),
  /** Company research mailboxes subscribed to provider newsletters. Mail to these is not user data: it goes to the offer inbox. */
  'offers.research_addresses': z.array(z.string().trim().toLowerCase().email().max(200)).max(50),
  ...LEGAL_SCHEMAS,
} as const;

export type SettingKey = keyof typeof SETTING_SCHEMAS;
export type Settings = { [K in SettingKey]: z.infer<(typeof SETTING_SCHEMAS)[K]> };

export const DEFAULT_SETTINGS: Settings = {
  frequency_defaults: { critical: 1440, regular: 10080, secondary: 10080 },
  retry: { base_minutes: 30, max_minutes: 1440, max_attempts_before_inaccessible: 8 },
  retention: { snapshots_days: 365, login_events_days: 365 },
  notifications: { email_enabled: false, recipients: [] },
  business: { app_name: 'Due', support_email: null },
  billing_terms: {
    renewal:
      'Subscriptions renew automatically at the end of each billing period you choose (monthly or yearly) until you cancel. Yearly billing is only used if you explicitly choose it. These terms are pending legal review.',
    cancellation:
      'Cancel anytime from Account > Plan in the app. Cancellation takes effect at the end of the current paid period; you keep premium features until then. These terms are pending legal review.',
    refund:
      'Refund terms are pending legal review and have not been finalised. Contact support before purchasing if you need a refund commitment.',
    legal_review_status: 'pending',
  },
  'billing.tax_note': null,
  'billing.prices_include_tax': true,
  'billing.gst_registered': false,
  'billing.gstin': null,
  'beta.plus_free': false,
  'beta.ends_on': null,
  'app.android_url': null,
  'app.ios_url': null,
  'offers.research_addresses': [],
  ...LEGAL_DEFAULTS,
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
