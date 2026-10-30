import { afterEach, describe, expect, it } from 'vitest';
import {
  drainTelemetryQueue,
  MAX_QUEUE,
  peekTelemetryQueue,
  setTelemetryEnabled,
  setTelemetrySink,
  TELEMETRY_EVENTS,
  track,
  type TelemetryEvent,
} from '../telemetry';

afterEach(() => {
  setTelemetrySink(null);
  setTelemetryEnabled(true);
  drainTelemetryQueue();
});

describe('telemetry', () => {
  it('lists the product events', () => {
    expect(TELEMETRY_EVENTS).toEqual([
      'first_obligation_completed',
      'import_approved',
      'import_ignored',
      'reminder_resolved',
      'correction_made',
      'missed_or_late',
      'trial_converted',
      'churn_reason',
      'notification_opt_out',
    ]);
  });
  it('queues locally by default (no network)', () => {
    track('import_ignored', { rawKind: 'csv_row' }, '2026-10-30T00:00:00.000Z');
    expect(peekTelemetryQueue()).toEqual([
      { name: 'import_ignored', props: { rawKind: 'csv_row' }, at: '2026-10-30T00:00:00.000Z' },
    ]);
  });
  it('a sink receives queued events, then live ones', () => {
    track('correction_made', { field: 'date', scope: 'next' });
    const got: TelemetryEvent[] = [];
    setTelemetrySink((evs) => got.push(...evs));
    expect(got.map((e) => e.name)).toEqual(['correction_made']);
    track('trial_converted', { kept: false });
    expect(got.map((e) => e.name)).toEqual(['correction_made', 'trial_converted']);
    expect(peekTelemetryQueue()).toEqual([]);
  });
  it('a failing sink keeps events queued', () => {
    setTelemetrySink(() => {
      throw new Error('offline');
    });
    track('missed_or_late', { daysLate: 2 });
    expect(peekTelemetryQueue()).toHaveLength(1);
  });
  it('the queue is bounded and opt-out clears it', () => {
    for (let i = 0; i < MAX_QUEUE + 10; i++) track('missed_or_late', { daysLate: i });
    expect(peekTelemetryQueue()).toHaveLength(MAX_QUEUE);
    setTelemetryEnabled(false);
    expect(peekTelemetryQueue()).toHaveLength(0);
    track('notification_opt_out', { channel: 'email' });
    expect(peekTelemetryQueue()).toHaveLength(0);
  });
});
