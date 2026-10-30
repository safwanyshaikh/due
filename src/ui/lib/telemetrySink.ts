import type { AccountClient } from '../../lib/account/client';
import type { TelemetryEvent as WireEvent } from '../../lib/account/types';
import { setTelemetryEnabled, setTelemetrySink, type TelemetryEvent } from '../../lib/telemetry';
import { anonymousId, readPref, writePref } from './prefs';

const BATCH_MS = 10_000;
const BATCH_MAX = 20;
/** Server limit per request (POST /api/telemetry accepts at most 25 events). */
const SEND_MAX = 25;

/** The server only accepts snake_case prop names (`^[a-z][a-z0-9_]{0,31}$`). */
export function wirePropName(k: string): string {
  return k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
}

export function telemetryOptedOut(): boolean {
  return readPref('telemetry-optout') === '1';
}

export function toWire(e: TelemetryEvent): WireEvent {
  const props: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(e.props as Record<string, unknown>)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
      props[wirePropName(k)] = v;
  }
  return { name: e.name, props, at: e.at };
}

/**
 * Installs a batched sink that posts anonymous events to Due's /api/telemetry. Returns a stop
 * function. Events never carry names, amounts or free text (enforced by the domain payload types).
 */
export function installTelemetry(client: Pick<AccountClient, 'sendTelemetry'>): () => void {
  if (telemetryOptedOut()) {
    setTelemetryEnabled(false);
    setTelemetrySink(null);
    return () => undefined;
  }
  setTelemetryEnabled(true);
  let buffer: WireEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const flush = () => {
    timer = null;
    while (buffer.length) {
      const batch = buffer.slice(0, SEND_MAX);
      buffer = buffer.slice(SEND_MAX);
      client.sendTelemetry(anonymousId(), batch).catch(() => {
        /* telemetry is best-effort and never retried with personal data */
      });
    }
  };
  setTelemetrySink((events) => {
    buffer.push(...events.map(toWire));
    if (buffer.length >= BATCH_MAX) flush();
    else if (!timer) timer = setTimeout(flush, BATCH_MS);
  });
  const onHide = () => {
    if (document.visibilityState === 'hidden') flush();
  };
  document.addEventListener('visibilitychange', onHide);
  return () => {
    document.removeEventListener('visibilitychange', onHide);
    if (timer) clearTimeout(timer);
    flush();
    setTelemetrySink(null);
  };
}

export function setTelemetryOptOut(optOut: boolean): void {
  writePref('telemetry-optout', optOut ? '1' : null);
  setTelemetryEnabled(!optOut);
  if (optOut) setTelemetrySink(null);
}
