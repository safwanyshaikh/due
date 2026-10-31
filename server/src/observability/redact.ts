/**
 * Redaction for logs, job error messages and error reports. Financial content, contact details, tokens and
 * secrets never leave the process in clear text.
 */

const PATTERNS: [RegExp, string][] = [
  // Bearer/basic credentials and key=value secrets.
  [/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\b(token|secret|password|passwd|api[_-]?key|access_token|refresh_token|signature|authorization|code_verifier)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi, '$1$2[redacted]'],
  // URLs: keep scheme + host, drop path/query (paths and queries can carry tokens or personal data).
  [/\b(https?:\/\/[A-Za-z0-9.-]+(?::\d+)?)(\/[^\s"'<>]*)?/gi, '$1/[path]'],
  [/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgres://[redacted]'],
  // E-mail addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
  // Amounts in rupees (₹, Rs, INR) and other currency amounts.
  [/(₹|\bRs\.?|\bINR)\s?[\d,]+(\.\d+)?/gi, '[amount]'],
  // Card-like and other long digit runs (account numbers, phone numbers, Aadhaar).
  [/\b(?:\d[ -]?){9,19}\b/g, '[number]'],
  // PAN.
  [/\b[A-Z]{5}\d{4}[A-Z]\b/g, '[id]'],
  // Long opaque strings (JWTs, hex keys, base64 secrets).
  [/\b[A-Za-z0-9_-]{32,}(\.[A-Za-z0-9_-]{8,}){0,2}\b/g, '[opaque]'],
];

export function redactText(input: string, max = 300): string {
  let s = input;
  for (const [re, rep] of PATTERNS) s = s.replace(re, rep);
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Keys whose values are always removed from structured log/report objects. */
const SENSITIVE_KEY = /^(password|passwd|token|secret|authorization|cookie|set-cookie|text|body|html|raw|raw_text|rawtext|content|subject|amount|amount_inr|amountinr|email|phone|access_token|refresh_token|id_token|signature|card|pan|aadhaar|dsn)$/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

/** Deep copy with sensitive keys replaced and strings redacted. */
export function redactObject(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth]';
  if (typeof value === 'string') return redactText(value, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactObject(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? '[redacted]' : redactObject(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** pino redact paths used by every process. */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-razorpay-signature"]',
  'req.headers["x-due-signature"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.text',
  '*.body',
  '*.html',
  '*.rawText',
  '*.raw_text',
  '*.subject',
  '*.accessToken',
  '*.refreshToken',
  '*.access_token',
  '*.refresh_token',
  'payload.*',
];
