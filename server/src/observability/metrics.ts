/** In-process counters and timers. Exposed (admin only) through /api/admin/health/integrations. */

interface Timer {
  count: number;
  totalMs: number;
  maxMs: number;
  lastMs: number;
}

function key(name: string, labels?: Record<string, string | number>): string {
  if (!labels) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`);
  return `${name}{${parts.join(',')}}`;
}

export class Metrics {
  private counters = new Map<string, number>();
  private timers = new Map<string, Timer>();
  readonly startedAt = new Date();

  inc(name: string, labels?: Record<string, string | number>, by = 1): void {
    const k = key(name, labels);
    this.counters.set(k, (this.counters.get(k) ?? 0) + by);
  }

  timing(name: string, ms: number, labels?: Record<string, string | number>): void {
    const k = key(name, labels);
    const t = this.timers.get(k) ?? { count: 0, totalMs: 0, maxMs: 0, lastMs: 0 };
    t.count++;
    t.totalMs += ms;
    t.maxMs = Math.max(t.maxMs, ms);
    t.lastMs = ms;
    this.timers.set(k, t);
  }

  async time<T>(name: string, fn: () => Promise<T>, labels?: Record<string, string | number>): Promise<T> {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      this.timing(name, performance.now() - start, labels);
    }
  }

  counter(name: string, labels?: Record<string, string | number>): number {
    return this.counters.get(key(name, labels)) ?? 0;
  }

  snapshot() {
    const timers: Record<string, { count: number; avgMs: number; maxMs: number; lastMs: number }> = {};
    for (const [k, t] of this.timers) {
      timers[k] = { count: t.count, avgMs: Math.round((t.totalMs / t.count) * 10) / 10, maxMs: Math.round(t.maxMs), lastMs: Math.round(t.lastMs) };
    }
    return { since: this.startedAt.toISOString(), counters: Object.fromEntries(this.counters), timers };
  }

  reset(): void {
    this.counters.clear();
    this.timers.clear();
  }
}

/** Process-wide registry. */
export const metrics = new Metrics();
