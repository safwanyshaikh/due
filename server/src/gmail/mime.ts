import type { GmailMessage, GmailPart } from './google.js';

/** Upper bound on decoded body text read from one message. */
export const MAX_BODY_CHARS = 100_000;
/** Attachments larger than this are never fetched, even with attachment processing enabled. */
export const MAX_ATTACHMENT_BYTES = 256 * 1024;
/** Attachment types Due can read as text (no OCR in this build). */
const TEXT_ATTACHMENT_TYPES = new Set(['text/plain', 'text/csv']);

function decodeB64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8');
}

function header(part: GmailPart | undefined, name: string): string | null {
  const h = part?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h ? h.value : null;
}

const NAMED: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rupee: '₹' };

/**
 * Converts untrusted HTML to plain text for parsing only. Nothing is rendered: tags, scripts, styles,
 * comments and attributes (including links' href values) are dropped; entities are decoded once.
 */
export function htmlToPlainText(html: string): string {
  return html
    .slice(0, MAX_BODY_CHARS * 2)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|head|title|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|section)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,8});/gi, (m, ent: string) => {
      if (ent[0] === '#') {
        const cp = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : ' ';
      }
      return NAMED[ent.toLowerCase()] ?? m;
    })
    // Strip control characters except newline/tab.
    // eslint-disable-next-line no-control-regex -- deliberately matching control characters to remove them
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

export interface TextAttachmentRef {
  attachmentId: string | null;
  inlineData: string | null;
  mimeType: string;
  size: number;
}

export interface ExtractedMessage {
  from: string | null;
  fromDomain: string | null;
  subject: string | null;
  date: string | null;
  rfcMessageId: string | null;
  text: string;
  textSource: 'plain' | 'html' | 'none';
  /** Attachment parts in the message (never fetched unless enabled; only small text ones are readable). */
  attachmentCount: number;
  readableAttachments: TextAttachmentRef[];
}

function walk(part: GmailPart | undefined, visit: (p: GmailPart) => void, depth = 0): void {
  if (!part || depth > 20) return;
  visit(part);
  for (const child of part.parts ?? []) walk(child, visit, depth + 1);
}

function isAttachment(p: GmailPart): boolean {
  return Boolean(p.filename) || Boolean(p.body?.attachmentId) || /attachment/i.test(header(p, 'Content-Disposition') ?? '');
}

export function domainOf(fromHeader: string | null): string | null {
  if (!fromHeader) return null;
  const m = /@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\s*>?\s*$/.exec(fromHeader.trim()) ?? /@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/.exec(fromHeader);
  return m ? m[1]!.toLowerCase() : null;
}

/** Reads headers and body text from a users.messages.get (format=full) response. Prefers text/plain. */
export function extractMessage(msg: GmailMessage): ExtractedMessage {
  const plain: string[] = [];
  const html: string[] = [];
  let attachmentCount = 0;
  const readableAttachments: TextAttachmentRef[] = [];
  walk(msg.payload, (p) => {
    const type = (p.mimeType ?? '').toLowerCase();
    if (type.startsWith('multipart/')) return;
    if (isAttachment(p)) {
      attachmentCount++;
      const size = p.body?.size ?? 0;
      if (TEXT_ATTACHMENT_TYPES.has(type) && size <= MAX_ATTACHMENT_BYTES) {
        readableAttachments.push({ attachmentId: p.body?.attachmentId ?? null, inlineData: p.body?.data ?? null, mimeType: type, size });
      }
      return;
    }
    const data = p.body?.data;
    if (!data) return;
    if (type === 'text/plain') plain.push(decodeB64Url(data));
    else if (type === 'text/html') html.push(decodeB64Url(data));
  });
  let text = '';
  let textSource: ExtractedMessage['textSource'] = 'none';
  if (plain.length) {
    text = plain.join('\n');
    textSource = 'plain';
  } else if (html.length) {
    text = htmlToPlainText(html.join('\n'));
    textSource = 'html';
  }
  text = text.replace(/\r\n?/g, '\n').slice(0, MAX_BODY_CHARS);
  const from = header(msg.payload, 'From');
  return {
    from,
    fromDomain: domainOf(from),
    subject: header(msg.payload, 'Subject')?.slice(0, 500) ?? null,
    date: header(msg.payload, 'Date'),
    rfcMessageId: header(msg.payload, 'Message-ID') ?? header(msg.payload, 'Message-Id'),
    text,
    textSource,
    attachmentCount,
    readableAttachments,
  };
}

export const MESSAGE_CLASSES = [
  'receipt',
  'renewal',
  'trial',
  'offer',
  'recharge',
  'card',
  'emi',
  'loan',
  'school_fee',
  'utility',
  'irrelevant',
] as const;
export type MessageClass = (typeof MESSAGE_CLASSES)[number];

/** Keyword classifier over subject + body. Order matters: the most specific class wins. */
export function classifyMessage(subject: string | null, text: string, hasFinancialFields: boolean): MessageClass {
  const h = `${subject ?? ''}\n${text.slice(0, 20_000)}`.toLowerCase();
  const rules: [MessageClass, RegExp][] = [
    ['trial', /\b(free trial|trial (ends?|expires?|period)|your trial)\b/],
    ['school_fee', /\b(school fees?|tuition fees?|term fees?)\b/],
    ['emi', /\bemi\b|\b(instal?ments?) (due|of)\b/],
    ['loan', /\b(loan (account|statement|repayment)|home loan|personal loan)\b/],
    ['card', /\b(credit card (statement|bill)|card statement|minimum amount due|total amount due)\b/],
    ['recharge', /\b(recharge|prepaid pack|validity (ends?|expires?))\b/],
    ['utility', /\b(electricity|water bill|gas bill|broadband bill|postpaid bill|utility bill)\b/],
    ['renewal', /\b(renew(s|al|ed)?|auto[- ]?renew|auto[- ]?debit|mandate|next billing date|subscription)\b/],
    ['receipt', /\b(receipt|invoice|payment (received|successful)|order confirmation|tax invoice)\b/],
    ['offer', /\b(offer|cashback|discount|coupon|% off)\b/],
  ];
  for (const [cls, re] of rules) if (re.test(h)) return cls;
  return hasFinancialFields ? 'receipt' : 'irrelevant';
}
