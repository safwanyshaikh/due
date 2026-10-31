import { randomUUID } from 'node:crypto';
import { redactObject, redactText } from './redact.js';

/**
 * Minimal, privacy-safe error tracking for a Sentry-compatible endpoint (SENTRY_DSN). It sends only the error
 * type, a redacted message, stack frame locations (file, function, line) and non-personal tags. Request bodies,
 * headers, cookies, user identity, mail/document content and amounts are never sent.
 */
export interface ErrorReport {
  event_id: string;
  timestamp: string;
  level: 'error' | 'warning';
  platform: 'node';
  logger: string;
  environment: string;
  server_name?: string;
  message: { formatted: string };
  exception: { values: { type: string; value: string; stacktrace?: { frames: { filename: string; function: string; lineno?: number }[] } }[] };
  tags: Record<string, string>;
  extra: Record<string, unknown>;
}

export interface ParsedDsn {
  endpoint: string;
  publicKey: string;
}

export function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn);
    const projectId = u.pathname.replace(/^\/+|\/+$/g, '');
    if (!u.username || !/^\d+$/.test(projectId.split('/').pop() ?? '')) return null;
    const prefix = projectId.includes('/') ? `/${projectId.slice(0, projectId.lastIndexOf('/'))}` : '';
    const id = projectId.split('/').pop()!;
    return { endpoint: `${u.protocol}//${u.host}${prefix}/api/${id}/store/`, publicKey: u.username };
  } catch {
    return null;
  }
}

function frames(stack: string | undefined) {
  if (!stack) return undefined;
  const out: { filename: string; function: string; lineno?: number }[] = [];
  for (const line of stack.split('\n').slice(1, 30)) {
    const m = /at (?:(.+?) \()?(?:file:\/\/)?(.+?):(\d+):\d+\)?$/.exec(line.trim());
    if (!m) continue;
    // Keep paths relative to the app; never include absolute home directories.
    const file = m[2]!.replace(/^.*?\/(server|src|node_modules)\//, '$1/');
    out.push({ filename: file, function: m[1] ?? '<anonymous>', lineno: Number(m[3]) });
  }
  return { frames: out.reverse() };
}

/** Scrubs a report before it leaves the process (the equivalent of Sentry's beforeSend). */
export function beforeSend(report: ErrorReport): ErrorReport {
  return {
    ...report,
    message: { formatted: redactText(report.message.formatted) },
    exception: {
      values: report.exception.values.map((v) => ({ ...v, value: redactText(v.value) })),
    },
    tags: Object.fromEntries(Object.entries(report.tags).map(([k, v]) => [k, redactText(String(v), 100)])),
    extra: redactObject(report.extra) as Record<string, unknown>,
  };
}

export function buildReport(err: unknown, ctx: { environment: string; tags?: Record<string, string>; extra?: Record<string, unknown> }): ErrorReport {
  const e = err instanceof Error ? err : new Error(String(err));
  return beforeSend({
    event_id: randomUUID().replace(/-/g, ''),
    timestamp: new Date().toISOString(),
    level: 'error',
    platform: 'node',
    logger: 'due',
    environment: ctx.environment,
    message: { formatted: e.message },
    exception: { values: [{ type: e.name || 'Error', value: e.message, stacktrace: frames(e.stack) }] },
    tags: ctx.tags ?? {},
    extra: ctx.extra ?? {},
  });
}

export class ErrorReporter {
  private readonly dsn: ParsedDsn | null;
  sent = 0;
  failed = 0;
  constructor(
    dsn: string | null,
    private readonly environment: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.dsn = dsn ? parseDsn(dsn) : null;
  }

  get configured(): boolean {
    return this.dsn !== null;
  }

  /** Fire-and-forget; never throws and never blocks a request for more than 3 s. */
  async capture(err: unknown, tags: Record<string, string> = {}, extra: Record<string, unknown> = {}): Promise<void> {
    if (!this.dsn) return;
    const report = buildReport(err, { environment: this.environment, tags, extra });
    try {
      const res = await this.fetchImpl(this.dsn.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_client=due-reporter/1.0, sentry_key=${this.dsn.publicKey}`,
        },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(3_000),
      });
      if (res.ok) this.sent++;
      else this.failed++;
    } catch {
      this.failed++;
    }
  }
}

let shared: ErrorReporter = new ErrorReporter(null, 'development');

export function configureErrorReporter(dsn: string | null, environment: string): ErrorReporter {
  shared = new ErrorReporter(dsn, environment);
  return shared;
}

export function errorReporter(): ErrorReporter {
  return shared;
}
