/** Light guard so users don't paste things this app must never hold. */
export function looksSensitive(text: string): string | null {
  if (!text) return null;
  const digitsOnly = text.replace(/[\s-]/g, '');
  if (/\d{13,19}/.test(digitsOnly))
    return 'This looks like a card or account number. Please remove it.';
  if (/\b[A-Za-z]{5}\d{4}[A-Za-z]\b/.test(text)) return 'This looks like a PAN. Please remove it.';
  if (/\b\d{4}\s\d{4}\s\d{4}\b/.test(text))
    return 'This looks like an Aadhaar number. Please remove it.';
  return null;
}

const BLOCKED_HEADERS = [
  'card_number',
  'cardnumber',
  'cvv',
  'pan',
  'aadhaar',
  'aadhar',
  'password',
  'pin',
  'upi_pin',
  'account_number',
  'otp',
];

export function blockedHeader(h: string): boolean {
  return BLOCKED_HEADERS.includes(
    h
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, '_'),
  );
}

/* ---------- Redaction (runs before any extraction or storage) ---------- */

export type RedactionKind =
  | 'card_number'
  | 'aadhaar'
  | 'pan'
  | 'cvv'
  | 'upi_pin'
  | 'otp'
  | 'password'
  | 'ifsc'
  | 'bank_account';

export interface Redaction {
  kind: RedactionKind;
  count: number;
}

export interface RedactedText {
  text: string;
  redactions: Redaction[];
}

/** Luhn checksum for card numbers. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const MARK: Record<RedactionKind, string> = {
  card_number: '[card number removed]',
  aadhaar: '[Aadhaar removed]',
  pan: '[PAN removed]',
  cvv: '[CVV removed]',
  upi_pin: '[UPI PIN removed]',
  otp: '[OTP removed]',
  password: '[password removed]',
  ifsc: '[IFSC removed]',
  bank_account: '[account number removed]',
};

/**
 * Masks identifiers Due must never hold: Aadhaar (12 digits, spaced or not), PAN, Luhn-valid
 * 13–19 digit card numbers, CVV/OTP/UPI PIN values, password lines, IFSC codes and labelled
 * bank account numbers. Extraction always runs on the redacted text.
 */
export function redactSensitive(input: string): RedactedText {
  const counts = new Map<RedactionKind, number>();
  let text = input ?? '';
  const sub = (kind: RedactionKind, re: RegExp, keep?: (m: string, ...g: string[]) => boolean) => {
    text = text.replace(re, (m: string, ...g: string[]) => {
      if (keep && keep(m, ...g)) return m;
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
      return MARK[kind];
    });
  };
  // Order matters: labelled secrets first, then number shapes.
  sub('upi_pin', /\b(?:upi[\s_-]?pin|m-?pin)\b(?:\s*(?:is|:|-|=|no\.?))?\s*\d{0,6}/gi);
  sub(
    'cvv',
    /\b(?:cvv2?|cvc|card verification (?:value|code))\b(?:\s*(?:is|:|-|=|no\.?))?\s*\d{0,4}/gi,
  );
  sub('otp', /\b(?:otp|one[\s-]time[\s-]password)\b(?:\s*(?:is|:|-|=))?\s*\d{0,8}/gi);
  sub('password', /^.*\b(?:password|passcode|passwd)\b.*$/gim);
  sub(
    'bank_account',
    /\b(?:a\/c|acct|account)(?:\s*(?:no\.?|number|#))?\s*[:-]?\s*[xX*\d][\dxX* -]{4,}\d\b/gi,
  );
  sub('card_number', /(?<![\d])(?:\d[ -]?){12,18}\d(?![\d])/g, (m) => {
    const d = m.replace(/[ -]/g, '');
    return !(d.length >= 13 && d.length <= 19 && luhnValid(d));
  });
  sub('aadhaar', /(?<![\d])[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}(?![\d])/g);
  sub('pan', /\b[A-Za-z]{5}\d{4}[A-Za-z]\b/g);
  sub('ifsc', /\b[A-Z]{4}0[A-Z0-9]{6}\b/g);
  return {
    text,
    redactions: [...counts.entries()].map(([kind, count]) => ({ kind, count })),
  };
}
