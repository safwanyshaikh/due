import { describe, expect, it } from 'vitest';
import {
  applyUndo,
  AUDIT_KEEP_RECENT,
  AUDIT_PAYLOAD_KEEP,
  auditFor,
  canUndo,
  compactAudit,
  type AuditEvent,
} from '../audit';
import { emptyData } from '../data';
import { addDays } from '../dates';
import { createObligation, editAmount, markPaid } from '../mutations';
import { rules } from '../recurrence';
import type { AppData } from '../types';
import { NOW } from './helpers';

const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(Date.parse(NOW) - msAgo).toISOString();

function seed(): { data: AppData; id: string } {
  const r = createObligation(
    emptyData(),
    {
      type: 'subscription',
      provider: 'Netflix',
      amountPaise: 64900,
      rule: rules.monthly('2026-11-05'),
    },
    { now: NOW },
  );
  return { data: r.data, id: r.data.commitments[0].id };
}

describe('undo window', () => {
  it('allows undo for events younger than 24 hours only', () => {
    const { data, id } = seed();
    const paid = markPaid(data, id, { now: NOW, today: '2026-10-30' });
    const later = (h: number) => iso(-h * HOUR);
    expect(canUndo(paid.data, paid.event.id, later(23.9))).toBe(true);
    expect(canUndo(paid.data, paid.event.id, later(24))).toBe(false);
    expect(applyUndo(paid.data, paid.event.id, { now: later(25) })).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(applyUndo(paid.data, paid.event.id, { now: later(1) }).ok).toBe(true);
  });
});

/** A dataset with `n` obligation edits spread over the last `days` days (oldest first). */
function busyData(n: number, days: number): { data: AppData; ids: string[] } {
  let data = emptyData();
  const ids: string[] = [];
  const start = Date.parse(NOW) - days * 86_400_000;
  for (let i = 0; i < 20; i++) {
    const r = createObligation(
      data,
      {
        type: 'subscription',
        provider: `Service ${i}`,
        nickname: `Service ${i} with a reasonably long nickname for realism`,
        amountPaise: 10_000 + i,
        rule: rules.monthly(addDays('2026-11-01', i)),
      },
      { now: new Date(start).toISOString() },
    );
    data = r.data;
    ids.push(r.data.commitments.at(-1)!.id);
  }
  // Raw events (no compaction in between) to model an old, uncompacted log.
  const events: AuditEvent[] = [];
  let d = data;
  for (let i = 0; i < n; i++) {
    const at = new Date(start + Math.floor(((i + 1) * days * 86_400_000) / (n + 1))).toISOString();
    const id = ids[i % ids.length];
    const r = editAmount(d, id, 10_000 + i, { now: at, today: at.slice(0, 10) }, { scope: 'all' });
    events.push(r.event);
    d = { ...r.data, audit: data.audit };
  }
  return { data: { ...d, audit: [...data.audit, ...events] }, ids };
}

describe('audit compaction', () => {
  it('keeps the latest 1,000 events plus each obligation’s latest, and strips payloads older than 30 days', () => {
    const { data, ids } = busyData(5000, 120);
    expect(data.audit.length).toBe(5020);
    const out = compactAudit(data, NOW);
    expect(out.audit.length).toBeLessThanOrEqual(AUDIT_KEEP_RECENT + ids.length);
    expect(out.audit.at(-1)).toEqual(data.audit.at(-1));
    // Every obligation still has its latest event.
    for (const id of ids) expect(auditFor(out, id)[0]).toEqual(auditFor(data, id)[0]);
    const cutoff = Date.parse(NOW) - 30 * 86_400_000;
    out.audit.forEach((e, i) => {
      if (Date.parse(e.at) < cutoff || i < out.audit.length - AUDIT_PAYLOAD_KEEP) {
        expect(e).toMatchObject({ before: {}, after: {}, compacted: true });
        expect(e.summary).toBeTruthy();
      } else expect(e.compacted).toBeUndefined();
    });
    // Compacted events can never be undone.
    const old = out.audit.find((e) => e.compacted)!;
    expect(applyUndo(out, old.id, { now: old.at }).ok).toBe(false);
    // Idempotent.
    expect(compactAudit(out, NOW)).toBe(out);
  });

  it('keeps the sync payload under 2 MB with 5,000 events', () => {
    const { data } = busyData(5000, 120);
    const raw = new TextEncoder().encode(JSON.stringify(data)).length;
    const compacted = new TextEncoder().encode(JSON.stringify(compactAudit(data, NOW))).length;
    expect(raw).toBeGreaterThan(2 * 1024 * 1024);
    expect(compacted).toBeLessThan(2 * 1024 * 1024);
  });

  it('is applied on every mutation, so the stored log stays bounded', () => {
    const { data, ids } = busyData(1500, 10);
    const r = editAmount(data, ids[0], 1, { now: NOW, today: '2026-10-30' }, { scope: 'all' });
    expect(r.data.audit.length).toBeLessThanOrEqual(AUDIT_KEEP_RECENT + ids.length);
    expect(r.data.audit.at(-1)).toEqual(r.event);
    // The new event is still undoable.
    expect(r.undo().commitments.find((c) => c.id === ids[0])?.amount.value).not.toBe(1);
  });

  it('leaves small, recent logs untouched and strips events older than 30 days to their summary', () => {
    const { data } = seed();
    expect(compactAudit(data, NOW)).toBe(data);
    const old = { ...data, audit: data.audit.map((e) => ({ ...e, at: iso(31 * 24 * HOUR) })) };
    const out = compactAudit(old, NOW);
    expect(out.audit).toEqual([{ ...old.audit[0], before: {}, after: {}, compacted: true }]);
    expect(out.audit[0].summary).toBe(data.audit[0].summary);
  });
});
