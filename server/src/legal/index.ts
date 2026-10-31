import { z } from 'zod';
import type { Queryable } from '../db.js';

/**
 * Legal content (contract: "Legal content"). Stored as individual settings keys, edited through
 * PATCH /api/admin/settings, served by GET /api/public/legal. `complete` stays false until every required
 * field holds real (non-placeholder) content.
 */

/** Addresses that must never be shipped as real contacts. */
const PLACEHOLDER_DOMAIN = /@(example\.(com|org|net|in)|[a-z0-9-]+\.(invalid|test|example|localhost))$/i;
const PLACEHOLDER_TEXT = /\b(todo|tbd|lorem ipsum|placeholder|xxx+|draft|replace me|your company|coming soon)\b/i;

const realEmail = z
  .string()
  .trim()
  .max(254)
  .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Must be an email address')
  .refine((v) => !PLACEHOLDER_DOMAIN.test(v), 'Placeholder addresses are not allowed');
const shortText = z.string().trim().max(300);
const markdown = z.string().max(100_000);

export const LEGAL_SCHEMAS = {
  'legal.entity_name': shortText,
  'legal.address': z.string().trim().max(1000),
  'legal.grievance_officer_name': shortText,
  'legal.grievance_email': realEmail,
  'legal.grievance_phone': z
    .string()
    .trim()
    .max(40)
    .refine((v) => v === '' || /^\+?[0-9 ()-]{6,40}$/.test(v), 'Must be a phone number'),
  'legal.support_email': realEmail,
  'legal.incident_contact': shortText,
  'legal.privacy_policy_md': markdown,
  'legal.terms_md': markdown,
  'legal.deletion_policy_md': markdown,
  'legal.subprocessors': z
    .array(z.object({ name: z.string().trim().min(1).max(120), purpose: z.string().trim().min(1).max(300), region: z.string().trim().min(1).max(80) }).strict())
    .max(50),
  'legal.effective_date': z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/, 'Use YYYY-MM-DD')
    .nullable(),
} as const;

export type LegalKey = keyof typeof LEGAL_SCHEMAS;

export const LEGAL_DEFAULTS: { [K in LegalKey]: z.infer<(typeof LEGAL_SCHEMAS)[K]> } = {
  'legal.entity_name': '',
  'legal.address': '',
  'legal.grievance_officer_name': '',
  'legal.grievance_email': '',
  'legal.grievance_phone': '',
  'legal.support_email': '',
  'legal.incident_contact': '',
  'legal.privacy_policy_md': '',
  'legal.terms_md': '',
  'legal.deletion_policy_md': '',
  'legal.subprocessors': [],
  'legal.effective_date': null,
};

/** Fields that must be filled with real content before `complete` is true (the phone is optional). */
export const REQUIRED_LEGAL: LegalKey[] = [
  'legal.entity_name',
  'legal.address',
  'legal.grievance_officer_name',
  'legal.grievance_email',
  'legal.support_email',
  'legal.incident_contact',
  'legal.privacy_policy_md',
  'legal.terms_md',
  'legal.deletion_policy_md',
  'legal.subprocessors',
  'legal.effective_date',
];

export type LegalValues = typeof LEGAL_DEFAULTS;

export function missingLegal(v: LegalValues): string[] {
  const missing: string[] = [];
  for (const k of REQUIRED_LEGAL) {
    const val = v[k];
    if (val === null || val === undefined) missing.push(k);
    else if (typeof val === 'string' && (val.trim() === '' || PLACEHOLDER_TEXT.test(val.slice(0, 2000)))) missing.push(k);
    else if (Array.isArray(val) && val.length === 0) missing.push(k);
  }
  return missing;
}

export async function getLegal(q: Queryable): Promise<LegalValues> {
  const rows = (await q.query<{ key: string; value: unknown }>(`SELECT key, value FROM settings WHERE key LIKE 'legal.%'`)).rows;
  const out = structuredClone(LEGAL_DEFAULTS) as Record<string, unknown>;
  for (const r of rows) {
    if (!(r.key in LEGAL_SCHEMAS)) continue;
    const p = LEGAL_SCHEMAS[r.key as LegalKey].safeParse(r.value);
    if (p.success) out[r.key] = p.data;
  }
  return out as LegalValues;
}

/** Public shape (camelCase) for GET /api/public/legal. */
export function publicLegal(v: LegalValues) {
  const missing = missingLegal(v);
  return {
    entityName: v['legal.entity_name'],
    address: v['legal.address'],
    grievanceOfficerName: v['legal.grievance_officer_name'],
    grievanceEmail: v['legal.grievance_email'],
    grievancePhone: v['legal.grievance_phone'],
    supportEmail: v['legal.support_email'],
    incidentContact: v['legal.incident_contact'],
    privacyPolicyMd: v['legal.privacy_policy_md'],
    termsMd: v['legal.terms_md'],
    deletionPolicyMd: v['legal.deletion_policy_md'],
    subprocessors: v['legal.subprocessors'],
    effectiveDate: v['legal.effective_date'],
    complete: missing.length === 0,
    missing,
  };
}

/** GET /api/public/legal (no auth). Editing goes through PATCH /api/admin/settings with a legal.* key. */
export async function legalRoutes(app: import('fastify').FastifyInstance): Promise<void> {
  app.get('/api/public/legal', async (_req, reply) => {
    // Revalidated on every load: an edit (or a correction to a grievance contact) is visible immediately.
    reply.header('Cache-Control', 'no-cache');
    return publicLegal(await getLegal(app.deps.pool));
  });
}
