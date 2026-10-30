import { many } from '../db.js';
import type { MonitorContext } from '../monitor/engine.js';
import { startJob, type JobId, type JobRunRow } from './runner.js';

/** Polls the jobs table (default every 60 s) and runs due jobs. Weekends are not skipped. */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private current: Promise<unknown> | null = null;
  private stopped = false;

  private readonly ctx: MonitorContext;

  constructor(
    ctx: MonitorContext,
    private readonly tickMs = 60_000,
  ) {
    this.ctx = { ...ctx, stopping: () => this.stopped };
  }

  start(): void {
    this.stopped = false;
    const loop = () => {
      if (this.stopped) return;
      this.current = this.tick()
        .catch((err) => this.ctx.log.error({ err }, 'scheduler tick failed'))
        .finally(() => {
          this.current = null;
          if (!this.stopped) this.timer = setTimeout(loop, this.tickMs);
        });
    };
    this.timer = setTimeout(loop, 1_000);
    this.ctx.log.info({ tickMs: this.tickMs }, 'scheduler started');
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.current) await this.current;
  }

  /** Runs every due, enabled job once. Exposed for tests (with an injected clock). */
  async tick(): Promise<JobRunRow[]> {
    const due = await many<{ id: JobId }>(
      this.ctx.pool,
      `SELECT id FROM jobs WHERE enabled AND (next_run_at IS NULL OR next_run_at <= $1) ORDER BY id`,
      [this.ctx.clock()],
    );
    const runs: JobRunRow[] = [];
    for (const { id } of due) {
      if (this.stopped) break;
      const started = await startJob(this.ctx, id, 'schedule');
      if (started) runs.push(await started.done);
    }
    return runs;
  }
}
