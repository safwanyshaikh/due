import { z } from 'zod';
import { canonicalJson, sha256 } from '../util.js';
import { PAGE_STATUSES, TERMS_STATUSES } from './status.js';

/**
 * Versioned, declarative offer parsers. A parser version holds regex rules that read normalised page text
 * (never HTML, never content behind a login). A field the rules do not find is recorded as null, which means
 * "not observed" and never proposes a change. Rules run with a length cap to keep regexes cheap.
 */

const pattern = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => {
    try {
      new RegExp(p, 'iu');
      return true;
    } catch {
      return false;
    }
  }, 'Invalid regular expression');

const capture = z.object({ pattern, group: z.number().int().min(0).max(9).default(1) }).strict();

export const FieldRules = z
  .object({
    /** Captures a rupee amount such as "1,029" or "1029.00". */
    price: capture.optional(),
    /** Captures text mapped through `map` (lower-case keys) to monthly | quarterly | annual | one_time | none. */
    billingPeriod: capture.extend({ map: z.record(z.string(), z.enum(['monthly', 'quarterly', 'annual', 'one_time', 'none'])) }).strict().optional(),
    /** Each entry captures one benefit value: { key: 'primeDays', pattern, type: 'number' | 'text' }. */
    benefitValue: z
      .array(capture.extend({ key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/), type: z.enum(['number', 'text']).default('text') }).strict())
      .max(10)
      .optional(),
    /** Capture a date written as YYYY-MM-DD, DD/MM/YYYY or "31 May 2026". */
    officialStart: capture.optional(),
    officialEnd: capture.optional(),
    /** If this matches, terms are reported expired (e.g. "offer has ended"). */
    expiredPattern: pattern.optional(),
    /** If set and it does not match on a terms page, terms are reported unknown instead of active. */
    activePattern: pattern.optional(),
  })
  .strict();
export type FieldRules = z.infer<typeof FieldRules>;

export const ParserRules = FieldRules.extend({
  /** Per-offer overrides keyed by offer id (merged over the shared rules). */
  offers: z.record(z.string().max(100), FieldRules).optional(),
}).strict();
export type ParserRules = z.infer<typeof ParserRules>;

export const BUILTIN_PARSER_VERSION = 'builtin-1';

export interface ObservationFields {
  price: number | null;
  billing_period: string | null;
  benefit_value: Record<string, unknown> | null;
  official_start: string | null;
  official_end: string | null;
  page_status: (typeof PAGE_STATUSES)[number] | null;
  terms_status: (typeof TERMS_STATUSES)[number] | null;
}

const MAX_SCAN = 200_000;
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/** Normalises a captured date to YYYY-MM-DD, or null when it is not a real calendar date. */
export function normaliseDate(raw: string): string | null {
  const s = raw.trim();
  let y: string | undefined;
  let m: string | undefined;
  let d: string | undefined;
  let r = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (r) [, y, m, d] = r;
  else if ((r = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) [, d, m, y] = r;
  else if ((r = /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s))) {
    d = r[1];
    m = MONTHS[r[2]!.slice(0, 3).toLowerCase()];
    y = r[3];
  } else if ((r = /^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/.exec(s))) {
    m = MONTHS[r[1]!.slice(0, 3).toLowerCase()];
    d = r[2];
    y = r[3];
  }
  if (!y || !m || !d) return null;
  const iso = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== iso ? null : iso;
}

function grab(text: string, rule: { pattern: string; group: number } | undefined): string | null {
  if (!rule) return null;
  const m = new RegExp(rule.pattern, 'iu').exec(text);
  const v = m?.[rule.group];
  return v === undefined ? null : v.trim();
}

function rulesFor(rules: ParserRules, offerId: string): FieldRules {
  const { offers, ...shared } = rules;
  return { ...shared, ...(offers?.[offerId] ?? {}) };
}

export interface ParseInput {
  offerId: string;
  /** Source category: 'terms' pages report terms_status; others report page_status. */
  sourceCategory: string;
  httpStatus: number | null;
  text: string | null;
  rules: ParserRules;
}

/** Applies a parser version's rules to one source's normalised text for one offer. */
export function parseObservation(input: ParseInput): ObservationFields {
  const fields: ObservationFields = {
    price: null,
    billing_period: null,
    benefit_value: null,
    official_start: null,
    official_end: null,
    page_status: null,
    terms_status: null,
  };
  const isTerms = input.sourceCategory === 'terms';
  const gone = input.httpStatus === 404 || input.httpStatus === 410;
  if (gone || !input.text) {
    if (isTerms) fields.terms_status = gone ? 'unavailable' : null;
    else fields.page_status = gone ? 'unavailable' : null;
    return fields;
  }
  const text = input.text.slice(0, MAX_SCAN);
  const r = rulesFor(input.rules, input.offerId);
  const price = grab(text, r.price);
  if (price) {
    const n = Number(price.replace(/[,\s]/g, ''));
    if (Number.isFinite(n) && n >= 0 && n <= 10_000_000) fields.price = Math.round(n * 100) / 100;
  }
  const bp = grab(text, r.billingPeriod);
  if (bp && r.billingPeriod) fields.billing_period = r.billingPeriod.map[bp.toLowerCase()] ?? null;
  if (r.benefitValue?.length) {
    const bv: Record<string, unknown> = {};
    for (const rule of r.benefitValue) {
      const v = grab(text, rule);
      if (v === null) continue;
      if (rule.type === 'number') {
        const n = Number(v.replace(/[,\s]/g, ''));
        if (Number.isFinite(n)) bv[rule.key] = n;
      } else bv[rule.key] = v.slice(0, 200);
    }
    if (Object.keys(bv).length) fields.benefit_value = bv;
  }
  const start = grab(text, r.officialStart);
  if (start) fields.official_start = normaliseDate(start);
  const end = grab(text, r.officialEnd);
  if (end) fields.official_end = normaliseDate(end);
  const expired = r.expiredPattern ? new RegExp(r.expiredPattern, 'iu').test(text) : false;
  if (isTerms) {
    if (expired) fields.terms_status = 'expired';
    else if (r.activePattern) fields.terms_status = new RegExp(r.activePattern, 'iu').test(text) ? 'active' : 'unknown';
    else fields.terms_status = 'active';
  } else {
    // A landing page that says the offer has ended is reported unavailable (terms come from terms pages).
    fields.page_status = expired ? 'unavailable' : 'visible';
  }
  return fields;
}

/** Normalised fingerprint of an observation's fields (dedupes unchanged observations). */
export function observationFingerprint(fields: ObservationFields): string {
  return sha256(canonicalJson(fields));
}
