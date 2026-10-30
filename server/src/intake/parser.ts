import { z } from 'zod';
import { sha256 } from '../util.js';

export const GENERIC_PARSER_VERSION = 'generic-1';
const MAX_TEXT = 20_000;

/** Fields the parser may extract (planning fields only). Users may edit exactly these. */
export const EXTRACTED_FIELD_KEYS = [
  'provider',
  'service',
  'commitmentType',
  'amountInr',
  'billingCycle',
  'renewalDate',
  'dueDate',
  'trialEndDate',
  'benefit',
  'offerExpiryDate',
  'senderDomain',
  'links',
  'referenceLabel',
] as const;
export type ExtractedFieldKey = (typeof EXTRACTED_FIELD_KEYS)[number];
export type ExtractedFields = Partial<Record<ExtractedFieldKey, unknown>>;

const BILLING_CYCLES = ['weekly', 'monthly', 'quarterly', 'half_yearly', 'yearly'] as const;

/** Admin-editable template rules: fixed values plus optional regexes with one capture group. */
export const TemplateRules = z
  .object({
    provider: z.string().trim().min(1).max(80).optional(),
    service: z.string().trim().min(1).max(120).optional(),
    commitmentType: z.string().trim().min(1).max(40).optional(),
    billingCycle: z.enum(BILLING_CYCLES).optional(),
    subjectPattern: z.string().max(300).optional(),
    amountPattern: z.string().max(300).optional(),
    renewalDatePattern: z.string().max(300).optional(),
    trialEndPattern: z.string().max(300).optional(),
    offerExpiryPattern: z.string().max(300).optional(),
  })
  .strict();
export type TemplateRules = z.infer<typeof TemplateRules>;

export interface ParserTemplate {
  id: string;
  sender_domain: string;
  message_class: string;
  version: number;
  rules: TemplateRules;
}

export interface ParseInput {
  text: string;
  subject?: string | null;
  /** Domain of the envelope sender (for a forward this is usually the user's own mail provider). */
  envelopeSenderDomain?: string | null;
}

export interface ParseResult {
  fields: ExtractedFields;
  confidence: Record<string, number>;
  sourceDomain: string | null;
  unreadable: boolean;
  fingerprint: string;
  redactedText: string;
}

const FREEMAIL = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'yahoo.co.in',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'icloud.com',
  'me.com',
  'proton.me',
  'protonmail.com',
  'rediffmail.com',
  'zoho.com',
]);

/**
 * Masks identifiers Due must never keep: card numbers (keeps last 4), Aadhaar, PAN, CVV, OTP/UPI PIN values.
 * Applied before any text is stored or parsed.
 */
export function redactSensitive(text: string): string {
  return text
    .replace(/\b(?:\d[ -]?){12,18}(\d{4})\b/g, (m, last4: string) => (m.replace(/\D/g, '').length >= 13 ? `[card ending ${last4}]` : m))
    .replace(/\b\d{4}[ -]?\d{4}[ -]?\d{4}\b/g, '[redacted 12-digit id]')
    .replace(/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[redacted PAN]')
    .replace(/\b(cvv|cvc|otp|upi pin|mpin|pin)\b(\s*(?:is|:|-)?\s*)(\d{3,8})\b/gi, (_m, k: string, sep: string) => `${k}${sep}[redacted]`);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function iso(y: number, m: number, d: number): string | null {
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1) return null;
  return dt.toISOString().slice(0, 10);
}

const DATE_RE =
  /(\d{4})-(\d{2})-(\d{2})|(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})|(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})|([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})/;

/** Parses the first date in `s`. Numeric dates are read day-first (India). */
export function parseDate(s: string): string | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  if (m[1]) return iso(+m[1], +m[2]!, +m[3]!);
  if (m[4]) return iso(+m[6]!, +m[5]!, +m[4]);
  if (m[7]) {
    const mon = MONTHS[m[8]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[8]!.slice(0, 3).toLowerCase()];
    return mon ? iso(+m[9]!, mon, +m[7]) : null;
  }
  const mon = MONTHS[m[10]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[10]!.slice(0, 3).toLowerCase()];
  return mon ? iso(+m[12]!, mon, +m[11]!) : null;
}

/** Finds a date within ~80 characters after any of the keyword patterns. */
function dateAfter(text: string, keyword: RegExp): string | null {
  const re = new RegExp(keyword.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const d = parseDate(text.slice(m.index + m[0].length, m.index + m[0].length + 80));
    if (d) return d;
  }
  return null;
}

const AMOUNT_RE = /(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d{1,2})?)/gi;
const AMOUNT_KEYWORDS = /(total|amount|charged|charge|renew|price|pay|due|debited|bill)/i;

function amounts(text: string): { value: number; nearKeyword: boolean }[] {
  const out: { value: number; nearKeyword: boolean }[] = [];
  let m: RegExpExecArray | null;
  AMOUNT_RE.lastIndex = 0;
  while ((m = AMOUNT_RE.exec(text))) {
    const value = Number(m[1]!.replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0 || value > 10_000_000) continue;
    out.push({ value, nearKeyword: AMOUNT_KEYWORDS.test(text.slice(Math.max(0, m.index - 50), m.index)) });
  }
  return out;
}

function billingCycle(text: string): (typeof BILLING_CYCLES)[number] | null {
  const t = text.toLowerCase();
  if (/\b(half[- ]yearly|semi[- ]annual|every 6 months)\b/.test(t)) return 'half_yearly';
  if (/\b(quarterly|every 3 months|per quarter)\b/.test(t)) return 'quarterly';
  if (/\b(yearly|annual(ly)?|per year|\/\s?year|\/\s?yr|12 months)\b/.test(t)) return 'yearly';
  if (/\b(monthly|per month|\/\s?month|\/\s?mo|every month)\b/.test(t)) return 'monthly';
  if (/\b(weekly|per week|every week)\b/.test(t)) return 'weekly';
  return null;
}

/** Original sender domain from a forwarded-message header block, else the envelope sender (unless freemail). */
function sourceDomainOf(text: string, envelope: string | null | undefined): { domain: string | null; fromForward: boolean } {
  const fwd = /^\s*(?:>\s*)?from:\s*[^\n]*?@([a-z0-9.-]+\.[a-z]{2,})/im.exec(text);
  if (fwd) return { domain: fwd[1]!.toLowerCase(), fromForward: true };
  const env = envelope?.toLowerCase() ?? null;
  return { domain: env && !FREEMAIL.has(env) ? env : null, fromForward: false };
}

/** "mailer.netflix.com" -> "Netflix"; "alerts.hdfcbank.co.in" -> "Hdfcbank". */
export function providerFromDomain(domain: string): string | null {
  const parts = domain.split('.').filter(Boolean);
  if (parts.length < 2) return null;
  let label = parts[parts.length - 2]!;
  if (['co', 'com', 'net', 'org', 'gov', 'ac'].includes(label) && parts.length >= 3) label = parts[parts.length - 3]!;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function cleanSubject(s: string | null | undefined): string | null {
  if (!s) return null;
  const c = s.replace(/^\s*((fwd?|fw|re)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim();
  return c ? c.slice(0, 120) : null;
}

/** Normalised content fingerprint: independent of forward headers, whitespace and case. */
export function fingerprintOf(sourceDomain: string | null, subject: string | null, text: string): string {
  const body = text
    .toLowerCase()
    .split('\n')
    .filter((l) => !/^\s*(>\s*)?(from|to|cc|date|sent|subject):/.test(l) && !/forwarded message|original message/.test(l))
    .join(' ')
    .replace(/https?:\/\/\S+/g, (u) => u.split('?')[0]!)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TEXT);
  return sha256(`${sourceDomain ?? ''}\n${(cleanSubject(subject) ?? '').toLowerCase()}\n${body}`);
}

function safeRegex(pattern: string | undefined, text: string): string | null {
  if (!pattern) return null;
  try {
    const m = new RegExp(pattern, 'i').exec(text);
    return m?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

export function pickTemplate(templates: ParserTemplate[], sourceDomain: string | null, subject: string | null): ParserTemplate | null {
  if (!sourceDomain) return null;
  const candidates = templates
    .filter((t) => sourceDomain === t.sender_domain || sourceDomain.endsWith(`.${t.sender_domain}`))
    .sort((a, b) => b.version - a.version);
  const bySubject = candidates.find((t) => t.rules.subjectPattern && safeRegex(`(${t.rules.subjectPattern})`, subject ?? ''));
  return bySubject ?? candidates.find((t) => !t.rules.subjectPattern) ?? null;
}

/**
 * Generic, deterministic extractor for receipts/renewal/trial/offer messages. Never fetches links.
 * Every field carries a confidence in [0,1]; a template (by sender domain) raises confidence and fills gaps.
 */
export function parseMessage(input: ParseInput, templates: ParserTemplate[] = []): ParseResult & { parserVersion: string } {
  const redactedText = redactSensitive(input.text.slice(0, MAX_TEXT * 5)).slice(0, MAX_TEXT * 5);
  const text = redactedText.slice(0, MAX_TEXT);
  const subject = cleanSubject(input.subject ? redactSensitive(input.subject) : null);
  const haystack = `${subject ?? ''}\n${text}`;
  const fields: ExtractedFields = {};
  const confidence: Record<string, number> = {};
  const set = (k: ExtractedFieldKey, v: unknown, c: number) => {
    if (v === null || v === undefined || v === '') return;
    fields[k] = v;
    confidence[k] = Math.round(c * 100) / 100;
  };

  const src = sourceDomainOf(text, input.envelopeSenderDomain);
  if (src.domain) set('senderDomain', src.domain, src.fromForward ? 0.8 : 0.6);
  const template = pickTemplate(templates, src.domain, subject);

  const found = amounts(haystack);
  if (found.length) {
    const near = found.find((a) => a.nearKeyword);
    const distinct = new Set(found.map((a) => a.value));
    set('amountInr', (near ?? found[0]!).value, near ? 0.8 : distinct.size === 1 ? 0.6 : 0.35);
  }
  const cycle = billingCycle(haystack);
  if (cycle) set('billingCycle', cycle, 0.7);
  set('renewalDate', dateAfter(haystack, /(renew(?:s|al)?(?:\s+date)?|next (?:billing|payment|charge)(?:\s+date)?|auto[- ]?debit(?:\s+on)?)\s*(?:on|is|date)?\s*:?/), 0.7);
  set('dueDate', dateAfter(haystack, /(due date|payment due|due on|pay by)\s*:?/), 0.7);
  set('trialEndDate', dateAfter(haystack, /(trial\s+(?:ends?|expires?|will end|period ends?)|free trial until)\s*(?:on)?\s*:?/), 0.7);
  set('offerExpiryDate', dateAfter(haystack, /(offer\s+(?:valid|ends?|expires?)|valid\s+(?:till|until|up ?to)|expires? on)\s*(?:till|until|on)?\s*:?/), 0.6);
  const benefitLine = text.split('\n').map((l) => l.trim()).find((l) => l.length >= 8 && l.length <= 200 && /\b(free|complimentary|included|cashback|benefit|bonus|subscription included)\b/i.test(l));
  if (benefitLine) set('benefit', benefitLine.slice(0, 160), 0.4);
  if (src.domain) set('provider', providerFromDomain(src.domain), src.fromForward ? 0.5 : 0.4);
  if (subject) set('service', subject, 0.3);
  if (/\btrial\b/i.test(haystack)) set('commitmentType', 'trial', 0.5);
  else if (/\b(emi|loan)\b/i.test(haystack)) set('commitmentType', 'emi', 0.5);
  else if (/\b(subscription|membership|plan)\b/i.test(haystack)) set('commitmentType', 'subscription', 0.5);
  const links = [...new Set(text.match(/https?:\/\/[^\s<>"')]+/g) ?? [])].slice(0, 10).map((u) => u.slice(0, 500));
  if (links.length) set('links', links, 1);

  let parserVersion = GENERIC_PARSER_VERSION;
  if (template) {
    const r = template.rules;
    parserVersion = `template:${template.id}@${template.version}`;
    if (r.provider) set('provider', r.provider, 0.95);
    if (r.service) set('service', r.service, 0.9);
    if (r.commitmentType) set('commitmentType', r.commitmentType, 0.9);
    if (r.billingCycle) set('billingCycle', r.billingCycle, 0.9);
    const amt = safeRegex(r.amountPattern, haystack);
    if (amt && Number.isFinite(Number(amt.replace(/,/g, '')))) set('amountInr', Number(amt.replace(/,/g, '')), 0.9);
    for (const [k, p] of [
      ['renewalDate', r.renewalDatePattern],
      ['trialEndDate', r.trialEndPattern],
      ['offerExpiryDate', r.offerExpiryPattern],
    ] as const) {
      const raw = safeRegex(p, haystack);
      const d = raw ? parseDate(raw) : null;
      if (d) set(k, d, 0.9);
    }
  }

  const meaningful = ['amountInr', 'renewalDate', 'dueDate', 'trialEndDate', 'offerExpiryDate', 'billingCycle'].some((k) => k in fields);
  return {
    fields,
    confidence,
    sourceDomain: src.domain,
    unreadable: !meaningful && !template,
    fingerprint: fingerprintOf(src.domain, input.subject ?? null, text),
    redactedText,
    parserVersion,
  };
}
