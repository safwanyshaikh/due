/**
 * Private intake: documents, forwarded emails and one shared SMS. Local, pure parsing only.
 *
 * Every input is redacted first (`redactSensitive`), and extraction runs on the redacted text,
 * so masked identifiers can never be returned. Only planning fields are extracted. A field that
 * cannot be found is absent; nothing is guessed. Nothing becomes an obligation until the user
 * confirms it in the import review queue (imports.ts).
 */
import { daysInMonth, isValidISO, toISO } from './dates';
import { findMerchantInText } from './merchants';
import { redactSensitive, type Redaction } from './sensitive';
import type { CommitmentType, ISODate } from './types';

export type IntakeType = 'manual' | 'document' | 'forwarded_email' | 'shared_sms';
export type ReviewStatus = 'needs_review' | 'confirmed' | 'ignored' | 'deleted' | 'unreadable';

/** Local mirror of the server's private UserEvent (no raw content). */
export interface UserEvent {
  id: string;
  intakeType: IntakeType;
  messageFingerprint?: string;
  sourceDomain?: string;
  /** Planning field values only (see DocumentFields). */
  extractedFields: Record<string, unknown>;
  /** Per-field confidence 0..1. */
  confidence: Record<string, number>;
  reviewStatus: ReviewStatus;
  /** Raw text/file must be purged after this instant. */
  rawRetentionUntil?: string;
  createdAt: string;
  fileName?: string;
  mimeType?: string;
}

export type DocumentKind =
  /** A payment confirmation (receipt, "payment received/successful"). Only these can mark a date paid. */
  | 'receipt'
  | 'bill'
  | 'loan_sanction'
  | 'emi_schedule'
  | 'card_statement'
  | 'school_fee'
  | 'recharge'
  | 'subscription_invoice'
  | 'sms'
  | 'email';

export type BillingCycle = 'monthly' | 'quarterly' | 'half_yearly' | 'annual';

export interface ExtractedField<T> {
  value: T;
  /** 0..1 */
  confidence: number;
  /** Position of the matched snippet in the redacted text. */
  start: number;
  end: number;
  snippet: string;
}

export interface DocumentFields {
  provider: ExtractedField<string>;
  commitmentType: ExtractedField<CommitmentType>;
  /** Paise. */
  amount: ExtractedField<number>;
  currency: ExtractedField<'INR'>;
  /** Paise. */
  emi: ExtractedField<number>;
  /** Percent per annum. */
  interestRate: ExtractedField<number>;
  tenureMonths: ExtractedField<number>;
  dueDate: ExtractedField<ISODate>;
  renewalDate: ExtractedField<ISODate>;
  trialEnd: ExtractedField<ISODate>;
  /** Date a payment/charge already happened (receipts). */
  paidDate: ExtractedField<ISODate>;
  billingCycle: ExtractedField<BillingCycle>;
  benefit: ExtractedField<string>;
  referenceLabel: ExtractedField<string>;
  link: ExtractedField<string>;
}

export type FieldName = keyof DocumentFields;

export interface DocumentExtraction {
  fields: Partial<DocumentFields>;
  documentKind: DocumentKind | null;
  redactedText: string;
  redactions: Redaction[];
}

export interface ExtractHint {
  kind?: DocumentKind;
  fileName?: string;
  mimeType?: string;
}

/* ---------- Amounts ---------- */

const MONEY_SRC =
  '(?:₹|\\bRs\\.?|\\bINR)\\s*([0-9][0-9,]*(?:\\.\\d{1,2})?)(?:\\s*(lakhs?|lacs?|crores?|cr)\\b)?|\\b([0-9]+(?:\\.\\d+)?)\\s*(lakhs?|lacs?|crores?)\\b';

/** Parses "5,00,000", "1,950.50", with optional "lakh"/"crore" multiplier → paise. */
export function parseIndianAmount(num: string, unit?: string): number | null {
  const n = Number(num.replace(/,/g, ''));
  if (!Number.isFinite(n)) return null;
  const u = (unit ?? '').toLowerCase();
  const mult = u.startsWith('la') ? 1e5 : u.startsWith('cr') ? 1e7 : 1;
  const paise = Math.round(n * mult * 100);
  return Number.isSafeInteger(paise) ? paise : null;
}

interface Hit<T> {
  value: T;
  start: number;
  end: number;
}

function moneyHits(text: string): Hit<number>[] {
  const out: Hit<number>[] = [];
  const re = new RegExp(MONEY_SRC, 'gi');
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const v = m[1] !== undefined ? parseIndianAmount(m[1], m[2]) : parseIndianAmount(m[3], m[4]);
    if (v !== null && v > 0) out.push({ value: v, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/* ---------- Dates ---------- */

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mar: 3,
  apr: 4,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  sept: 9,
  oct: 10,
  nov: 11,
  dec: 12,
};
const MON =
  '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

function year(y: string): number {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

function mk(y: number, m: number, d: number): ISODate | null {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  const iso = toISO(y, m, d);
  return isValidISO(iso) ? iso : null;
}

/** All dates in text. Numeric dates are read as dd/mm/yyyy (India). */
export function dateHits(text: string): Hit<ISODate>[] {
  const out: Hit<ISODate>[] = [];
  const push = (re: RegExp, f: (m: RegExpExecArray) => ISODate | null) => {
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const v = f(m);
      if (v && !out.some((h) => m!.index < h.end && m!.index + m![0].length > h.start))
        out.push({ value: v, start: m.index, end: m.index + m[0].length });
    }
  };
  push(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => mk(+m[1], +m[2], +m[3]));
  push(
    new RegExp(
      `\\b(\\d{1,2})(?:st|nd|rd|th)?[\\s\\-/.]+${MON}[\\s\\-/.,]+(\\d{4}|\\d{2})\\b`,
      'gi',
    ),
    (m) => mk(year(m[3]), MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1]),
  );
  push(new RegExp(`\\b${MON}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'gi'), (m) =>
    mk(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2]),
  );
  push(/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/g, (m) => mk(year(m[3]), +m[2], +m[1]));
  return out.sort((a, b) => a.start - b.start);
}

/* ---------- Labels ---------- */

const LABELS = {
  trialEnd:
    /(free\s+)?trial(\s+period)?\s+(ends?|ending|expires?|until|till|valid till)|trial\s+end\s+date/i,
  renewalDate:
    /renew(s|al|ing)?|next\s+(billing|charge|payment|debit)|auto[\s-]?renew|valid\s+(till|until|upto)|validity|expir(es|y)(\s+on)?|plan\s+ends/i,
  dueDate:
    /due\s+(date|on|by)?|pay(ment)?\s+(by|due)|last\s+date|payable\s+(by|on)|emi\s+date|before/i,
  paidDate:
    /paid\s+on|charged\s+on|payment\s+date|transaction\s+date|date\s+of\s+payment|debited\s+on|received\s+on/i,
};

/** The label text immediately before a position (same line, up to 48 chars). */
function before(text: string, pos: number, span = 48): string {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1;
  return text.slice(Math.max(lineStart, pos - span), pos);
}

function field<T>(
  text: string,
  h: Hit<T>,
  confidence: number,
  snipStart = h.start,
): ExtractedField<T> {
  const s = Math.max(0, Math.min(snipStart, h.start));
  return {
    value: h.value,
    confidence,
    start: s,
    end: h.end,
    snippet: text.slice(s, h.end).replace(/\s+/g, ' ').trim(),
  };
}

function labelledMoney(
  text: string,
  money: Hit<number>[],
  label: RegExp,
  span = 48,
): { hit: Hit<number>; labelStart: number } | null {
  for (const h of money) {
    const pre = before(text, h.start, span);
    const m = label.exec(pre);
    if (m) return { hit: h, labelStart: h.start - pre.length + m.index };
  }
  return null;
}

const AMOUNT_LABELS: RegExp[] = [
  /total\s+amount\s+due|total\s+due|amount\s+due|amount\s+payable|net\s+payable|total\s+payable|bill\s+amount|invoice\s+total/i,
  /loan\s+amount|sanctioned\s+amount|amount\s+sanctioned|principal/i,
  /total\s+fee|fee\s+(amount|payable)|tuition\s+fee|term\s+fee/i,
  /(amount|total)\s*(charged|paid|debited)?|charged|paid|debited|recharge\s+(of|for)|price|plan\s+price/i,
];

/* ---------- Classification ---------- */

function classify(
  text: string,
  hint?: ExtractHint,
): { kind: DocumentKind | null; type: CommitmentType | null; conf: number } {
  const t = text.toLowerCase();
  const kinds: [DocumentKind, CommitmentType, RegExp][] = [
    [
      'loan_sanction',
      'emi',
      /sanction(ed)?\s+letter|loan\s+sanction|sanctioned\s+amount|loan\s+amount/,
    ],
    ['emi_schedule', 'emi', /emi\s+schedule|repayment\s+schedule|amorti[sz]ation/],
    [
      'card_statement',
      'credit_card',
      /credit\s+card\s+statement|minimum\s+amount\s+due|statement\s+date.*credit\s+card|card\s+statement/s,
    ],
    ['school_fee', 'school_fee', /school|tuition|term\s+fee|admission\s+fee|academic\s+year/],
    ['recharge', 'bill', /recharge|prepaid\s+plan|data\s+pack/],
    [
      'subscription_invoice',
      'subscription',
      /subscription|membership|your\s+plan|auto[\s-]?renew|free\s+trial|next\s+billing|billed\s+(monthly|annually|yearly)/,
    ],
    [
      'bill',
      'bill',
      /electricity|broadband|water\s+bill|gas\s+bill|postpaid|bill\s+(amount|date)|utility/,
    ],
  ];
  const base = ((): { kind: DocumentKind | null; type: CommitmentType | null; conf: number } => {
    if (hint?.kind && hint.kind !== 'sms' && hint.kind !== 'email') {
      const k = kinds.find(([kind]) => kind === hint.kind);
      if (k) return { kind: k[0], type: k[1], conf: 0.9 };
    }
    for (const [kind, type, re] of kinds) if (re.test(t)) return { kind, type, conf: 0.75 };
    if (/\bemi\b/.test(t) && /\bloan\b/.test(t))
      return { kind: 'emi_schedule', type: 'emi', conf: 0.6 };
    return { kind: hint?.kind ?? null, type: null, conf: 0 };
  })();
  // A payment confirmation is a receipt whatever it is for; the commitment type is kept. Statements
  // and loan schedules often list earlier payments ("payment received") and stay what they are.
  const listsPastPayments = ['card_statement', 'loan_sanction', 'emi_schedule'].includes(
    base.kind ?? '',
  );
  if (hint?.kind === 'receipt' || (!listsPastPayments && isPaymentConfirmationText(text)))
    return { kind: 'receipt', type: base.type, conf: Math.max(base.conf, 0.75) };
  return base;
}

/**
 * True when text says a payment already happened ("payment received", "payment successful",
 * "paid on", "amount paid", "thank you for your payment"). Phrases such as "to be paid",
 * "unpaid" or "amount payable" are not confirmations.
 */
export function isPaymentConfirmationText(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(payment\s+(?:of\s+[^\n]{0,40}?\s+)?(?:has\s+been\s+|was\s+|is\s+)?(?:received|successful|successfully\s+(?:processed|completed|made)|confirmed|completed)|(?:successfully|already)\s+paid|paid\s+successfully|has\s+been\s+paid|(?<!to\s+be\s+|un)paid\s+on|amount\s+paid|transaction\s+(?:successful|completed)|thank\s+you\s+for\s+(?:your\s+)?payment|payment\s+receipt)\b/.test(
    t,
  );
}

/* ---------- Main extractor ---------- */

/**
 * Extracts planning fields from document/email/SMS text. Runs on redacted text. Unknown fields
 * are absent. Positions refer to `redactedText`.
 */
export function extractFromDocumentText(input: string, hint?: ExtractHint): DocumentExtraction {
  const { text, redactions } = redactSensitive(input ?? '');
  const fields: Partial<DocumentFields> = {};
  const money = moneyHits(text);
  const dates = dateHits(text);
  const cls = classify(text, hint);

  // Provider
  const known = findMerchantInText(text);
  if (known) {
    fields.provider = {
      value: known.alias.displayName,
      confidence: 0.9,
      start: known.index,
      end: known.index + known.alias.displayName.length,
      snippet: text
        .slice(known.index, known.index + 40)
        .split('\n')[0]
        .trim(),
    };
  } else {
    const re =
      /\b(?:biller|provider|merchant|lender|bank\s+name|school\s+name|operator|from|billed\s+by)\s*[:-]\s*([A-Za-z][A-Za-z0-9 &.'-]{1,40}?)\s*(?:\n|$|,|\|)/gim;
    const m = re.exec(text);
    const org =
      m ??
      /\b((?:[A-Z][A-Za-z&.]+\s){0,3}(?:Bank|Finance|Financial Services|Housing Finance|Capital|Electricity|Power|Distribution|School|Academy|Vidyalaya|Broadband|Telecom)(?:\s+(?:Ltd|Limited))?)\b/.exec(
        text,
      );
    if (org) {
      const value = (org[1] ?? '').replace(/\s+/g, ' ').trim();
      const start = org.index + org[0].indexOf(org[1]);
      if (value && !value.includes('['))
        fields.provider = {
          value,
          confidence: m ? 0.6 : 0.5,
          start,
          end: start + org[1].length,
          snippet: org[0].trim(),
        };
    }
  }

  if (cls.type)
    fields.commitmentType = {
      value: cls.type,
      confidence: cls.conf,
      start: 0,
      end: 0,
      snippet: cls.kind ?? '',
    };

  if (money.length) {
    const first = money[0];
    fields.currency = {
      value: 'INR',
      confidence: 0.95,
      start: first.start,
      end: first.end,
      snippet: text.slice(first.start, first.end),
    };
  }

  // EMI
  const emi = labelledMoney(
    text,
    money,
    /\b(emi|equated\s+monthly\s+instal?lment|monthly\s+instal?lment)\b[^₹\n]{0,20}$/i,
  );
  if (emi) fields.emi = field(text, emi.hit, 0.9, emi.labelStart);

  // Amount: by label priority, excluding the EMI hit (unless the doc is only about the EMI).
  const pool = money.filter((h) => h !== emi?.hit);
  for (const label of AMOUNT_LABELS) {
    const found = labelledMoney(text, pool, label);
    if (found) {
      fields.amount = field(text, found.hit, 0.85, found.labelStart);
      break;
    }
  }
  if (!fields.amount) {
    if (emi) fields.amount = { ...field(text, emi.hit, 0.7, emi.labelStart) };
    else {
      const distinct = [...new Set(pool.map((h) => h.value))];
      if (distinct.length === 1) fields.amount = field(text, pool[0], 0.55);
    }
  }

  // Interest rate
  const rate =
    /(?:rate\s+of\s+interest|interest\s+rate|\broi\b|interest)\s*(?:is|:|-|@|of|at)?\s*(\d{1,2}(?:\.\d{1,2})?)\s*%\s*(?:p\.?\s*a\.?|per\s+annum|annual(?:ly)?)?/i.exec(
      text,
    );
  if (rate) {
    const v = Number(rate[1]);
    if (v > 0 && v < 60)
      fields.interestRate = {
        value: v,
        confidence: 0.9,
        start: rate.index,
        end: rate.index + rate[0].length,
        snippet: rate[0].trim(),
      };
  }

  // Tenure
  const ten =
    /(?:tenure|loan\s+term|repayment\s+period|loan\s+period|term)\s*(?:of|is|:|-)?\s*(\d{1,3})\s*(months?|mths?|years?|yrs?)\b/i.exec(
      text,
    ) ?? /\b(\d{1,3})\s*(emis|monthly\s+instal?lments)\b/i.exec(text);
  if (ten) {
    const n = Number(ten[1]);
    const months = /^y/i.test(ten[2]) ? n * 12 : n;
    if (months > 0 && months <= 480)
      fields.tenureMonths = {
        value: months,
        confidence: /tenure|term|period/i.test(ten[0]) ? 0.9 : 0.7,
        start: ten.index,
        end: ten.index + ten[0].length,
        snippet: ten[0].trim(),
      };
  }

  // Dates by label (unlabelled dates are not assigned)
  for (const h of dates) {
    const pre = before(text, h.start);
    for (const name of ['trialEnd', 'paidDate', 'renewalDate', 'dueDate'] as const) {
      if (fields[name]) continue;
      const m = LABELS[name].exec(pre);
      if (m) {
        fields[name] = field(text, h, 0.85, h.start - pre.length + m.index);
        break;
      }
    }
  }

  // Billing cycle
  const cyc =
    /\b(per\s+month|monthly|\/\s?(?:month|mo)\b|every\s+month|quarterly|every\s+3\s+months|half[\s-]yearly|every\s+6\s+months|annual(?:ly)?|yearly|per\s+year|\/\s?(?:year|yr)\b|every\s+year)/i.exec(
      text,
    );
  if (cyc) {
    const s = cyc[1].toLowerCase();
    const value: BillingCycle = /quarter|3\s+months/.test(s)
      ? 'quarterly'
      : /half|6\s+months/.test(s)
        ? 'half_yearly'
        : /annual|year|yr/.test(s)
          ? 'annual'
          : 'monthly';
    fields.billingCycle = {
      value,
      confidence: 0.8,
      start: cyc.index,
      end: cyc.index + cyc[0].length,
      snippet: cyc[0],
    };
  }

  // Benefit
  const ben =
    /\b(?:benefits?|includes|included|complimentary|free\s+access\s+to)\s*[:-]?\s*([^\n]{3,80})/i.exec(
      text,
    );
  if (ben && !ben[1].includes('[')) {
    const start = ben.index + ben[0].indexOf(ben[1]);
    fields.benefit = {
      value: ben[1].trim().replace(/[.;]$/, ''),
      confidence: 0.6,
      start,
      end: start + ben[1].length,
      snippet: ben[0].trim(),
    };
  }

  // Reference label (invoice/bill/order numbers; account numbers are already redacted)
  const ref =
    /\b(invoice\s+(?:no\.?|number|#)|bill\s+(?:no\.?|number)|order\s+(?:id|no\.?)|reference\s+(?:no\.?|number|id)|ref\.?\s*(?:no\.?)?|receipt\s+(?:no\.?|number)|loan\s+ref(?:erence)?)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\-/]{2,30})/i.exec(
      text,
    );
  if (ref && !/removed/.test(ref[2])) {
    const label = ref[1]
      .replace(/\s+/g, ' ')
      .replace(/[.:#]+$/, '')
      .trim();
    fields.referenceLabel = {
      value: `${label} ${ref[2]}`,
      confidence: 0.75,
      start: ref.index,
      end: ref.index + ref[0].length,
      snippet: ref[0].trim(),
    };
  }

  // Link (provider help/manage page) – stored as text, never opened.
  const link = /https:\/\/[^\s<>"')\]]+/i.exec(text);
  if (link) {
    const value = link[0].replace(/[.,;:]+$/, '');
    fields.link = {
      value,
      confidence: 0.7,
      start: link.index,
      end: link.index + value.length,
      snippet: value,
    };
  }

  return { fields, documentKind: cls.kind, redactedText: text, redactions };
}

/** One SMS the user chose to share: amount, due date, provider, reference (same extractor). */
export function organiseSharedSms(text: string): {
  provider?: ExtractedField<string>;
  amount?: ExtractedField<number>;
  dueDate?: ExtractedField<ISODate>;
  reference?: ExtractedField<string>;
  extraction: DocumentExtraction;
} {
  const extraction = extractFromDocumentText(text, { kind: 'sms' });
  const f = extraction.fields;
  return {
    provider: f.provider,
    amount: f.amount ?? f.emi,
    dueDate: f.dueDate ?? f.renewalDate,
    reference: f.referenceLabel,
    extraction,
  };
}

/* ---------- UserEvent ---------- */

/** FNV-1a 32-bit over normalised text: a stable, non-reversible duplicate fingerprint. */
export function fingerprintText(text: string): string {
  const s = text.toLowerCase().replace(/\s+/g, ' ').trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export const DEFAULT_RAW_RETENTION_DAYS = 7;

export function fieldValues(fields: Partial<DocumentFields>): {
  values: Record<string, unknown>;
  confidence: Record<string, number>;
} {
  const values: Record<string, unknown> = {};
  const confidence: Record<string, number> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!v) continue;
    values[k] = v.value;
    confidence[k] = v.confidence;
  }
  return { values, confidence };
}

/** Builds a private UserEvent from an extraction (raw text is not part of it). */
export function buildUserEvent(
  extraction: DocumentExtraction,
  meta: {
    id: string;
    intakeType: IntakeType;
    createdAt: string;
    sourceDomain?: string;
    fileName?: string;
    mimeType?: string;
    retentionDays?: number;
  },
): UserEvent {
  const { values, confidence } = fieldValues(extraction.fields);
  const usable =
    values.amount !== undefined ||
    values.emi !== undefined ||
    values.dueDate !== undefined ||
    values.renewalDate !== undefined ||
    values.trialEnd !== undefined ||
    values.provider !== undefined;
  const until = new Date(
    Date.parse(meta.createdAt) + (meta.retentionDays ?? DEFAULT_RAW_RETENTION_DAYS) * 86_400_000,
  );
  return {
    id: meta.id,
    intakeType: meta.intakeType,
    messageFingerprint: fingerprintText(extraction.redactedText),
    ...(meta.sourceDomain ? { sourceDomain: meta.sourceDomain.toLowerCase() } : {}),
    extractedFields: values,
    confidence,
    reviewStatus: usable ? 'needs_review' : 'unreadable',
    rawRetentionUntil: until.toISOString(),
    createdAt: meta.createdAt,
    ...(meta.fileName ? { fileName: meta.fileName } : {}),
    ...(meta.mimeType ? { mimeType: meta.mimeType } : {}),
  };
}

/** Confidence band for UI badges. */
export function confidenceBand(n: number | undefined): 'high' | 'medium' | 'low' | 'missing' {
  if (n === undefined) return 'missing';
  return n >= 0.8 ? 'high' : n >= 0.55 ? 'medium' : 'low';
}

/**
 * Structured JSON export of one reviewed item: planning fields with confidence, no raw text,
 * no identifiers.
 */
export function exportStructuredRecord(
  ev: UserEvent,
  extra: { exportedAt: string; obligationId?: string | null } = {
    exportedAt: new Date(0).toISOString(),
  },
): string {
  const fields: Record<string, { value: unknown; confidence: number | null }> = {};
  for (const [k, v] of Object.entries(ev.extractedFields))
    fields[k] = { value: v, confidence: ev.confidence[k] ?? null };
  return JSON.stringify(
    {
      format: 'due.structured-record/v1',
      exportedAt: extra.exportedAt,
      intakeType: ev.intakeType,
      reviewStatus: ev.reviewStatus,
      createdAt: ev.createdAt,
      ...(ev.sourceDomain ? { sourceDomain: ev.sourceDomain } : {}),
      ...(ev.fileName ? { fileName: ev.fileName } : {}),
      ...(extra.obligationId ? { obligationId: extra.obligationId } : {}),
      fields,
      note: 'Amounts are in paise. Values were extracted locally and shown for review; Due did not contact the provider.',
    },
    null,
    2,
  );
}
