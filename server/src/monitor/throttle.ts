import { sleep } from '../util.js';

/** Serialises requests per host and keeps at least `gapMs` between them (per process). */
export class HostThrottle {
  private readonly nextAt = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly gapMs: number) {}

  async wait(host: string): Promise<void> {
    const prev = this.chains.get(host) ?? Promise.resolve();
    const turn = prev.then(async () => {
      const wait = (this.nextAt.get(host) ?? 0) - Date.now();
      if (wait > 0) await sleep(wait);
      this.nextAt.set(host, Date.now() + this.gapMs);
    });
    this.chains.set(
      host,
      turn.catch(() => undefined),
    );
    await turn;
  }
}
