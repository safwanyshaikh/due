import { z } from 'zod';
import { COMMUNITY_THRESHOLD, type ModuleCategory, type TransportMode, type ValueKind } from './types.js';

export const MODULE_STATUSES = ['research', 'verified', 'retired'] as const;
export const CATEGORIES = ['mobility', 'food', 'telecom', 'ott', 'music', 'cloud', 'shopping', 'card', 'loan', 'utility', 'other'] as const satisfies readonly ModuleCategory[];
export const VALUE_KINDS = [
  'membership_breakeven', 'period_switch', 'overlap', 'commute_pass', 'debt_rate', 'loan_switch', 'price_change', 'trial_end', 'fee_leak',
] as const satisfies readonly ValueKind[];
export const TRANSPORT_MODES = ['cab', 'auto', 'bike_taxi', 'local_train', 'metro', 'bus', 'shuttle', 'own_vehicle'] as const satisfies readonly TransportMode[];
export const RESEARCH_STATUSES = ['open', 'researching', 'done', 'rejected'] as const;

export const slug = z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'Use lowercase letters, digits and hyphens');
const httpUrl = z.string().trim().max(2048).url().refine((u) => /^https?:\/\//i.test(u), 'Must be an http(s) URL');
const isoDate = z.string().datetime({ offset: true });
const money = z.number().finite().nonnegative().max(100_000_000).nullable();
const optMoney = money.optional();
const short = z.string().trim().min(1).max(200);

export const sourceRefSchema = z.object({
  url: httpUrl,
  label: short,
  kind: z.enum(['official', 'press', 'aggregator', 'regulator', 'user_shared']),
  lastVerifiedAt: isoDate.nullable(),
});

export const rulesSchema = z.object({
  prices: z.array(z.object({ label: short, priceInr: money, periodDays: z.number().int().min(1).max(3660) })).max(30).optional(),
  includes: z.array(z.object({ key: short, label: short, months: z.number().int().min(0).max(240).nullable() })).max(50).optional(),
  creditPct: optMoney,
  creditCapPerUnitInr: optMoney,
  creditExpiryDays: optMoney,
  freeDeliveryMinOrderInr: optMoney,
  deliveryFeeSavedPerOrderInr: optMoney,
  ratePctLow: optMoney,
  ratePctHigh: optMoney,
  processingFeePct: optMoney,
  conditions: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
});

const strList = (max = 60) => z.array(z.string().trim().min(1).max(200)).max(max);

/** Fields an admin supplies. version/updatedAt are server-controlled. */
const moduleBody = {
  id: slug,
  status: z.enum(MODULE_STATUSES),
  detect: z.object({ merchantAliases: strList(), senderDomains: strList(), keywords: strList() }),
  provider: short,
  product: short,
  category: z.enum(CATEGORIES),
  country: z.string().trim().length(2).toUpperCase(),
  cityPack: slug.nullable(),
  rules: rulesSchema,
  valueKind: z.enum(VALUE_KINDS),
  proof: z.object({
    signal: z.enum(['amount_drop', 'charge_stopped', 'new_plan_charge', 'fewer_charges', 'user_confirmed']),
    description: z.string().trim().max(500),
  }),
  nudge: z.object({
    trigger: z.enum(['before_renewal', 'before_expiry', 'usage_drop', 'on_detect']),
    leadDays: z.number().int().min(0).max(365),
  }),
  legalRole: z.enum(['information', 'sponsored_disclosed', 'regulated_partner']),
  sources: z.array(sourceRefSchema).min(1, 'A module needs at least one source').max(30),
  actionUrl: httpUrl.nullable(),
  actionLabel: z.string().trim().max(80).nullable(),
};

/** Admin create/replace body (status defaults to research; `verified` is only reachable through POST :id/verify). */
export const moduleInputSchema = z.object({ ...moduleBody, status: moduleBody.status.default('research') }).strict();
export const modulePatchSchema = z.object(moduleBody).partial().strict();

/** Seed entries: lenient on version/updatedAt (strip unknown keys, skip entries that fail). */
export const moduleSeedSchema = z.object({
  ...moduleBody,
  status: moduleBody.status.default('research'),
  version: z.number().int().min(1).optional(),
  updatedAt: z.string().optional(),
});

export const passSchema = z.object({
  id: slug,
  operator: short,
  mode: z.enum(TRANSPORT_MODES),
  name: short,
  priceInr: money,
  periodDays: z.number().int().min(1).max(3660).nullable(),
  trips: z.number().int().min(1).max(10_000).nullable(),
  coverage: strList(200),
  status: z.enum(MODULE_STATUSES),
  sources: z.array(sourceRefSchema).max(30),
  actionUrl: httpUrl.nullable(),
});

const packBody = {
  name: short,
  country: z.string().trim().length(2).toUpperCase(),
  localities: strList(500),
  passes: z.array(passSchema).max(200),
  typicalFareInr: z.partialRecord(z.enum(TRANSPORT_MODES), z.number().finite().nonnegative().max(100_000)),
  status: z.enum(MODULE_STATUSES),
};
export const cityPackInputSchema = z.object({ ...packBody, status: packBody.status.default('research') }).strict();
export const cityPackSeedSchema = z.object({ id: slug, ...packBody, status: packBody.status.default('research'), updatedAt: z.string().optional() });

/* ---------- public ---------- */

/** Provider labels are free text a person typed or a statement line; they must carry no personal data. */
export function labelProblem(raw: string): string | null {
  const label = raw.trim();
  if (label.length === 0) return 'Label is empty';
  if (label.length > 60) return 'Label is longer than 60 characters';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(label)) return 'Label has control characters';
  if (label.includes('@')) return 'Label looks like an email address or handle';
  if (/(https?:|www\.|:\/\/)/i.test(label) || /\b[a-z0-9-]+\.(com|in|net|org|io|co|app|me|ai|dev|xyz)\b/i.test(label)) return 'Label looks like a web address';
  if (/\d{5,}/.test(label.replace(/[\s.-]/g, ''))) return 'Label has a long number in it';
  return null;
}

export const researchBody = z
  .object({
    providerLabel: z.string().max(200).superRefine((v, ctx) => {
      const p = labelProblem(v);
      if (p) ctx.addIssue({ code: 'custom', message: p });
    }),
    category: z.enum([...CATEGORIES, 'unknown']),
    cityPack: slug.optional(),
  })
  .strict();

export const reportBody = z
  .object({
    moveKind: z.enum(VALUE_KINDS),
    moduleId: slug.optional(),
    cityPack: slug.optional(),
    savedMonthlyInr: z.number().finite().min(1).max(100_000),
  })
  .strict();

/** Reports are stored rounded to the nearest 10 rupees (never below 10). */
export function roundSaved(n: number): number {
  return Math.min(100_000, Math.max(10, Math.round(n / 10) * 10));
}

export const communityQuery = z.object({ cityPack: slug.optional() });
export const COMMUNITY_MIN = COMMUNITY_THRESHOLD;

export const researchPatch = z
  .object({ status: z.enum(RESEARCH_STATUSES), moduleId: slug.nullable() })
  .partial()
  .strict()
  .refine((v) => v.status !== undefined || v.moduleId !== undefined, 'Nothing to update');
