/**
 * Product telemetry: event names and payload types only. No third-party analytics.
 * `track()` queues locally (bounded). The account/sync layer can install a sink with
 * `setTelemetrySink`; queued events are flushed to it. Payloads hold no names, amounts or text.
 */

export interface TelemetryEvents {
  first_obligation_completed: { ruleKind: string; source: 'manual' | 'import' };
  import_approved: { rawKind: string; matched: boolean; editedFields: number };
  import_ignored: { rawKind: string };
  reminder_resolved: {
    action: 'acknowledged' | 'snoozed' | 'paid' | 'reviewed';
    leadDays?: number;
  };
  correction_made: { field: 'amount' | 'date' | 'schedule'; scope: 'next' | 'all' };
  missed_or_late: { daysLate: number };
  trial_converted: { kept: boolean };
  churn_reason: { reason: 'too_expensive' | 'not_useful' | 'privacy' | 'switched' | 'other' };
  notification_opt_out: { channel: 'in_app' | 'email' | 'push' };
}

export type TelemetryName = keyof TelemetryEvents;

export const TELEMETRY_EVENTS: TelemetryName[] = [
  'first_obligation_completed',
  'import_approved',
  'import_ignored',
  'reminder_resolved',
  'correction_made',
  'missed_or_late',
  'trial_converted',
  'churn_reason',
  'notification_opt_out',
];

export interface TelemetryEvent<N extends TelemetryName = TelemetryName> {
  name: N;
  props: TelemetryEvents[N];
  at: string;
}

export type TelemetrySink = (events: TelemetryEvent[]) => void;

export const MAX_QUEUE = 200;

let queue: TelemetryEvent[] = [];
let sink: TelemetrySink | null = null;
let enabled = true;

/** Records an event. Queued locally unless a sink is installed. */
export function track<N extends TelemetryName>(
  name: N,
  props: TelemetryEvents[N],
  at: string = new Date().toISOString(),
): void {
  if (!enabled) return;
  const ev = { name, props, at } as TelemetryEvent;
  if (sink) {
    try {
      sink([ev]);
      return;
    } catch {
      /* fall through to queue */
    }
  }
  queue.push(ev);
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
}

/** Installs (or removes with null) the delivery sink and flushes queued events to it. */
export function setTelemetrySink(next: TelemetrySink | null): void {
  sink = next;
  if (sink && queue.length) {
    const pending = queue;
    queue = [];
    try {
      sink(pending);
    } catch {
      queue = [...pending, ...queue].slice(-MAX_QUEUE);
    }
  }
}

/** User opt-out: stops tracking and clears the local queue. */
export function setTelemetryEnabled(on: boolean): void {
  enabled = on;
  if (!on) queue = [];
}

export function peekTelemetryQueue(): readonly TelemetryEvent[] {
  return queue;
}

export function drainTelemetryQueue(): TelemetryEvent[] {
  const q = queue;
  queue = [];
  return q;
}
