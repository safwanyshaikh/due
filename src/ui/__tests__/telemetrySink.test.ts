// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { setTelemetrySink, track } from '../../lib/telemetry';
import { installTelemetry, toWire } from '../lib/telemetrySink';

// Mirrors server/src/consumer/telemetry.ts: prop names and per-request batch size.
const SERVER_PROP_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const SERVER_MAX_EVENTS = 25;

describe('telemetry sink wire format', () => {
  afterEach(() => setTelemetrySink(null));

  it('sends prop names the server accepts', () => {
    const w = toWire({
      name: 'import_approved',
      props: { rawKind: 'csv_row', matched: true, editedFields: 2 },
      at: '2026-10-30T00:00:00.000Z',
    });
    expect(w.props).toEqual({ raw_kind: 'csv_row', matched: true, edited_fields: 2 });
    for (const k of Object.keys(w.props ?? {})) expect(k).toMatch(SERVER_PROP_NAME);
  });

  it('never sends more events per request than the server accepts', () => {
    for (let i = 0; i < 60; i++) track('import_ignored', { rawKind: 'csv_row' });
    const send = vi.fn(() => Promise.resolve({ accepted: 0 }));
    const stop = installTelemetry({ sendTelemetry: send });
    stop();
    const sizes = send.mock.calls.map((c) => (c as unknown as [string, unknown[]])[1].length);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(60);
    for (const n of sizes) expect(n).toBeLessThanOrEqual(SERVER_MAX_EVENTS);
  });
});
