import type { MonitorOptions } from '../config.js';
import { FetchError, httpGet, type HttpResponse } from './net.js';
import { RobotsCache } from './robots.js';
import { HostThrottle } from './throttle.js';

export type FetchOutcome =
  | { kind: 'robots'; url: string; robotsUrl: string }
  | { kind: 'response'; res: HttpResponse };

/** Shared per-process monitoring state: robots cache and per-host throttle. */
export class MonitorRuntime {
  readonly throttle: HostThrottle;
  readonly robots: RobotsCache;

  constructor(readonly opts: MonitorOptions) {
    this.throttle = new HostThrottle(opts.hostGapMs);
    this.robots = new RobotsCache(
      {
        userAgent: opts.userAgent,
        timeoutMs: opts.timeoutMs,
        maxBytes: opts.maxBytes,
        allowPrivateHosts: opts.allowPrivateHosts,
      },
      opts.robotsTtlMs,
      this.throttle,
    );
  }

  /** Robots-checked, throttled GET that follows redirects (each hop is robots-checked too). */
  async fetch(url: string, conditional: { etag?: string | null; lastModified?: string | null } = {}): Promise<FetchOutcome> {
    let current = url;
    for (let hop = 0; hop <= this.opts.maxRedirects; hop++) {
      const decision = await this.robots.check(current);
      if (!decision.allowed) return { kind: 'robots', url: current, robotsUrl: decision.robotsUrl };
      await this.throttle.wait(new URL(current).host);
      const headers: Record<string, string> = {};
      if (hop === 0 && conditional.etag) headers['if-none-match'] = conditional.etag;
      if (hop === 0 && conditional.lastModified) headers['if-modified-since'] = conditional.lastModified;
      const res = await httpGet(current, {
        userAgent: this.opts.userAgent,
        timeoutMs: this.opts.timeoutMs,
        maxBytes: this.opts.maxBytes,
        allowPrivateHosts: this.opts.allowPrivateHosts,
        headers,
      });
      if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        current = new URL(res.headers.location, current).toString();
        continue;
      }
      return { kind: 'response', res };
    }
    throw new FetchError(`Too many redirects (>${this.opts.maxRedirects})`, 'redirect');
  }
}
