import { Writable } from 'node:stream';
import { metrics } from './metrics.js';

/**
 * Optional log shipping (H4, CERT-In 28 Apr 2022 directions: logs kept in India for 180 days; Due keeps 1 year).
 * LOG_SINK_URL is an HTTPS ingestion endpoint in an India region, e.g. an API Gateway / Lambda (or Firehose)
 * in AWS ap-south-1 (Mumbai) that writes to an S3 bucket with Object Lock (compliance mode, 365 days).
 * See docs/production/INCIDENT_RESPONSE.md.
 *
 * Only already-redacted log lines (the pino formatter/serializers run first) and audit rows are sent. Delivery
 * is best effort: batches are POSTed as NDJSON with a bearer token; failures are counted and dropped so logging
 * never blocks or crashes the service.
 */
export interface LogSinkOptions {
  url: string;
  token: string | null;
  service: string;
  fetchImpl?: typeof fetch;
  maxBatch?: number;
  flushMs?: number;
}

export class LogSink extends Writable {
  private buf: string[] = [];
  private timer: NodeJS.Timeout | null = null;
  private inflight: Promise<void> = Promise.resolve();
  constructor(private readonly o: LogSinkOptions) {
    super();
  }

  override _write(chunk: Buffer | string, _enc: BufferEncoding, cb: (err?: Error | null) => void): void {
    for (const line of chunk.toString().split('\n')) if (line.trim()) this.buf.push(line);
    if (this.buf.length >= (this.o.maxBatch ?? 200)) void this.flush();
    else if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.o.flushMs ?? 5000).unref();
    cb();
  }

  /** Sends everything buffered; resolves when the POST finished (or failed). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const lines = this.buf.splice(0);
    if (!lines.length) return this.inflight;
    this.inflight = this.inflight.then(async () => {
      await postNdjson(this.o, 'log', lines);
    });
    return this.inflight;
  }

  override _final(cb: (err?: Error | null) => void): void {
    void this.flush().then(() => cb());
  }
}

export async function postNdjson(o: LogSinkOptions, kind: 'log' | 'audit', lines: string[]): Promise<boolean> {
  const f = o.fetchImpl ?? fetch;
  try {
    const res = await f(o.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-ndjson',
        'x-due-service': o.service,
        'x-due-kind': kind,
        ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      },
      body: lines.join('\n') + '\n',
      signal: AbortSignal.timeout(10_000),
    });
    metrics.inc('log_sink.batches', { kind, status: res.ok ? 'ok' : 'error' });
    return res.ok;
  } catch {
    metrics.inc('log_sink.batches', { kind, status: 'error' });
    return false;
  }
}
