import robotsParserModule from 'robots-parser';

type RobotsParserFn = (url: string, txt: string) => { isAllowed(url: string, ua?: string): boolean | undefined };
// CJS module: at runtime the default import is the function itself.
const robotsParser = ((robotsParserModule as unknown as { default?: RobotsParserFn }).default ??
  robotsParserModule) as unknown as RobotsParserFn;
import { decodeBody, FetchError, httpGet, type HttpOptions } from './net.js';
import type { HostThrottle } from './throttle.js';

export const ROBOTS_AGENT_TOKEN = 'DueSourceMonitor';

interface Entry {
  fetchedAt: number;
  robots: { isAllowed(url: string, ua?: string): boolean | undefined } | null; // null = allow all
}

export interface RobotsDecision {
  allowed: boolean;
  robotsUrl: string;
  cached: boolean;
}

/**
 * robots.txt cache keyed by origin (24h TTL). 4xx → allow all (RFC 9309);
 * 5xx/network errors are thrown so the fetch counts as a failure and is retried, never treated as permission.
 */
export class RobotsCache {
  private readonly cache = new Map<string, Entry>();

  constructor(
    private readonly http: Omit<HttpOptions, 'headers'>,
    private readonly ttlMs: number,
    private readonly throttle: HostThrottle,
  ) {}

  clear(): void {
    this.cache.clear();
  }

  async check(rawUrl: string): Promise<RobotsDecision> {
    const u = new URL(rawUrl);
    const origin = u.origin;
    const robotsUrl = `${origin}/robots.txt`;
    let entry = this.cache.get(origin);
    let cached = true;
    if (!entry || Date.now() - entry.fetchedAt > this.ttlMs) {
      entry = await this.load(robotsUrl);
      this.cache.set(origin, entry);
      cached = false;
    }
    const allowed = entry.robots ? entry.robots.isAllowed(rawUrl, this.http.userAgent) !== false : true;
    return { allowed, robotsUrl, cached };
  }

  private async load(robotsUrl: string, depth = 0): Promise<Entry> {
    await this.throttle.wait(new URL(robotsUrl).host);
    const res = await httpGet(robotsUrl, { ...this.http, maxBytes: Math.min(this.http.maxBytes, 512 * 1024) });
    if (res.status >= 300 && res.status < 400 && res.headers.location && depth < 5) {
      return this.load(new URL(res.headers.location, robotsUrl).toString(), depth + 1);
    }
    if (res.status >= 200 && res.status < 300) {
      const text = decodeBody(res.body, res.headers['content-type']);
      return { fetchedAt: Date.now(), robots: robotsParser(robotsUrl, text) };
    }
    if (res.status >= 400 && res.status < 500) return { fetchedAt: Date.now(), robots: null };
    throw new FetchError(`robots.txt unavailable (HTTP ${res.status})`, 'network');
  }
}
