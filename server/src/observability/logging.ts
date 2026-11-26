import type { LoggerOptions } from 'pino';
import { isSensitiveKey, LOG_REDACT_PATHS, redactObject, redactText } from './redact.js';

/**
 * Logger options shared by the web service and the worker (M1). Besides pino's path-based `redact`:
 *  - `err`/`error` serializer: keeps type, SQLSTATE/HTTP codes and stack frames, redacts the message (e-mail
 *    addresses, tokens, numbers, amounts) and drops every other property (SMTP `rejected`/`response`, pg
 *    `detail`/`where`/`parameters`, provider payloads), so no address, token or database value is logged;
 *  - log formatter: every other field (except well-known safe ones) goes through redactObject;
 *  - message hook: string messages are redacted too.
 */

/** Fields copied from an error as-is when they are short scalars (codes, not content). */
const ERR_SAFE_FIELDS = ['code', 'statusCode', 'status', 'errno', 'syscall', 'responseCode', 'command', 'constraint', 'routine'] as const;

export interface SerializedError {
  type: string;
  message: string;
  stack?: string;
  [k: string]: unknown;
}

export function serializeError(err: unknown, depth = 0): unknown {
  if (!(err instanceof Error)) {
    if (err && typeof err === 'object') return redactObject(err);
    return typeof err === 'string' ? redactText(err) : err;
  }
  const e = err as Error & Record<string, unknown>;
  const type = e.constructor?.name ?? 'Error';
  const message = redactText(String(e.message ?? ''), 300);
  const out: SerializedError = { type, message };
  for (const k of ERR_SAFE_FIELDS) {
    const v = e[k];
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else if (typeof v === 'string' && v.length <= 64) out[k] = redactText(v, 64);
  }
  if (typeof e.stack === 'string') {
    // Only stack frames ("    at fn (file:line)"); the first line repeats the (unredacted) message.
    const frames = e.stack
      .split('\n')
      .filter((l) => /^\s+at\s/.test(l))
      .slice(0, 15)
      .map((l) => redactText(l, 300));
    out.stack = [`${type}: ${message}`, ...frames.map((f) => `    ${f}`)].join('\n');
  }
  if (e.cause !== undefined && depth < 3) out.cause = serializeError(e.cause, depth + 1);
  return out;
}

/** Top-level log fields that never carry personal data and are kept verbatim (correlation, timing). */
const SAFE_FIELDS = new Set(['level', 'time', 'pid', 'hostname', 'service', 'reqId', 'requestId', 'req', 'res', 'responseTime', 'err', 'error', 'jobId', 'type', 'attempt', 'durationMs', 'msg']);

export function redactLogFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (SAFE_FIELDS.has(k)) out[k] = v;
    else if (isSensitiveKey(k)) out[k] = '[redacted]';
    else out[k] = redactObject(v);
  }
  return out;
}

export function baseLoggerOptions(isProduction: boolean): LoggerOptions {
  return {
    level: isProduction ? 'info' : 'debug',
    redact: LOG_REDACT_PATHS,
    serializers: { err: serializeError, error: serializeError },
    formatters: { log: redactLogFields },
    hooks: {
      logMethod(args, method) {
        const redacted = args.map((a) => (typeof a === 'string' ? redactText(a, 500) : a)) as Parameters<typeof method>;
        return method.apply(this, redacted);
      },
    },
  };
}
