import { describe, expect, it } from 'vitest';
import { applyUndo, auditFor, canUndo } from '../audit';
import { emptyData } from '../data';
import {
  acknowledgeChanges,
  createObligation,
  deleteObligation,
  editAmount,
  editNextDate,
  editSchedule,
  markPaid,
  markReviewed,
  MutationError,
  recordExternalChange,
  restoreObligation,
  setObligationStatus,
  snooze,
} from '../mutations';
import {
  activeObligations,
  effectiveNext,
  liveHistory,
  obligationOccurrences,
} from '../obligations';
import { rules } from '../recurrence';
import type { AppData } from '../types';
import { ctx, NOW, TODAY } from './helpers';

function seed(): { data: AppData; id: string } {
  const r = createObligation(
    emptyData(),
    {
      type: 'subscription',
      provider: 'Netflix',
      nickname: 'Movies',
      amountPaise: 64900,
      rule: rules.monthly('2026-11-05'),
    },
    ctx(),
  );
  return { data: r.data, id: r.data.commitments[0].id };
}

describe('create + audit', () => {
  it('creates a user-entered obligation with mirrors and an audit event', () => {
    const { data, id } = seed();
    const c = data.commitments[0];
    expect(c.amount).toMatchObject({
      value: 64900,
      confidence: 'user_entered',
      source: { kind: 'manual' },
    });
    expect(c.canonicalProvider).toBe('netflix');
    expect(c.amountPaise).toBe(64900);
    expect(c.nextDue).toBe('2026-11-05');
    expect(data.audit).toHaveLength(1);
    expect(data.audit[0]).toMatchObject({
      action: 'create',
      entity: 'obligation',
      entityId: id,
      actor: 'user',
      at: NOW,
    });
    expect(data.audit[0].before.commitments![id]).toBeNull();
  });
  it('rejects invalid input', () => {
    expect(() =>
      createObligation(
        emptyData(),
        { type: 'bill', provider: ' ', amountPaise: 1, rule: rules.monthly('2026-11-05') },
        ctx(),
      ),
    ).toThrow(MutationError);
    expect(() =>
      createObligation(
        emptyData(),
        {
          type: 'bill',
          provider: 'x',
          amountPaise: 1,
          rule: { kind: 'monthly', start: '2026-11-05', dayOfMonth: 40 },
        },
        ctx(),
      ),
    ).toThrow(MutationError);
  });
  it('undo of create removes the record but keeps both audit events', () => {
    const { data } = seed();
    const r = applyUndo(data, data.audit[0].id, { now: NOW });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.commitments).toEqual([]);
    expect(r.data.audit.map((e) => e.action)).toEqual(['create', 'undo']);
    expect(r.data.audit[1].undoOf).toBe(data.audit[0].id);
  });
});

describe('occurrence actions are append-only', () => {
  it('markPaid records the occurrence; next moves on; undo appends a revoke', () => {
    const { data, id } = seed();
    const paid = markPaid(data, id, ctx());
    const c = paid.data.commitments[0];
    expect(c.history).toHaveLength(1);
    expect(c.history[0]).toMatchObject({
      kind: 'paid',
      occurrenceDate: '2026-11-05',
      amountPaise: 64900,
    });
    expect(effectiveNext(c, TODAY)?.date).toBe('2026-12-05');
    const undone = paid.undo();
    const u = undone.commitments[0];
    expect(u.history.map((e) => e.kind)).toEqual(['paid', 'revoked']);
    expect(liveHistory(u)).toEqual([]);
    expect(effectiveNext(u, TODAY)?.date).toBe('2026-11-05');
    expect(undone.audit.map((e) => e.action)).toEqual(['create', 'mark_paid', 'undo']);
  });
  it('cannot undo twice, or undo an undo', () => {
    const { data, id } = seed();
    const paid = markPaid(data, id, ctx());
    const once = applyUndo(paid.data, paid.event.id, { now: NOW });
    if (!once.ok) throw new Error('expected ok');
    expect(applyUndo(once.data, paid.event.id, { now: NOW })).toEqual({
      ok: false,
      reason: 'already_undone',
    });
    expect(applyUndo(once.data, once.event.id, { now: NOW })).toEqual({
      ok: false,
      reason: 'is_undo',
    });
    expect(applyUndo(once.data, 'nope', { now: NOW })).toEqual({ ok: false, reason: 'not_found' });
  });
  it('refuses to undo when the record changed since (undo the later change first)', () => {
    const { data, id } = seed();
    const a = markReviewed(data, id, ctx());
    const b = editAmount(a.data, id, 79900, ctx());
    expect(canUndo(b.data, a.event.id, NOW)).toBe(false);
    expect(applyUndo(b.data, a.event.id, { now: NOW })).toEqual({
      ok: false,
      reason: 'changed_since',
    });
    const back = b.undo();
    expect(canUndo(back, a.event.id, NOW)).toBe(true);
  });
  it('markReviewed sets status reviewed and clears pending changes', () => {
    const { data, id } = seed();
    const ext = recordExternalChange(
      data,
      id,
      { field: 'amount', to: 79900 },
      { kind: 'email_forward', label: 'Forwarded email', importedAt: NOW },
      ctx(),
    );
    expect(ext.data.commitments[0].pendingChanges).toHaveLength(1);
    const r = markReviewed(ext.data, id, ctx());
    expect(r.data.commitments[0].pendingChanges).toEqual([]);
    expect(effectiveNext(r.data.commitments[0], TODAY)?.status).toBe('reviewed');
  });
  it('snooze marks the occurrence snoozed until a date without moving it', () => {
    const { data, id } = seed();
    const r = snooze(data, id, '2026-11-03', ctx());
    const n = effectiveNext(r.data.commitments[0], TODAY)!;
    expect(n.status).toBe('snoozed');
    expect(n.snoozedUntil).toBe('2026-11-03');
    expect(n.date).toBe('2026-11-05');
    expect(effectiveNext(r.data.commitments[0], '2026-11-04')!.status).toBe('upcoming');
    expect(() => snooze(data, id, 'bad', ctx())).toThrow(MutationError);
  });
});

describe('editing the next occurrence without rewriting history', () => {
  it('editNextDate overrides only that occurrence; rule and other dates unchanged', () => {
    const { data, id } = seed();
    const paid = markPaid(data, id, ctx('2026-11-05T10:00:00.000Z', '2026-11-05'));
    const r = editNextDate(
      paid.data,
      id,
      '2026-12-08',
      ctx('2026-11-06T00:00:00.000Z', '2026-11-06'),
    );
    const c = r.data.commitments[0];
    expect(c.rule).toEqual(rules.monthly('2026-11-05'));
    expect(c.history).toEqual(paid.data.commitments[0].history);
    const occ = obligationOccurrences(c, '2026-11-01', '2027-01-31', '2026-11-06');
    expect(occ.map((o) => [o.occurrenceDate, o.date, o.status])).toEqual([
      ['2026-11-05', '2026-11-05', 'paid'],
      ['2026-12-05', '2026-12-08', 'upcoming'],
      ['2027-01-05', '2027-01-05', 'upcoming'],
    ]);
    expect(occ[1].dateConfidence).toBe('user_entered');
    expect(occ[1].override?.reason).toBe('Edited by you');
    expect(r.event.summary).toContain('5 Dec 2026');
    expect(auditFor(r.data, id).map((e) => e.action)).toEqual([
      'edit_next_date',
      'mark_paid',
      'create',
    ]);
  });
  it('an override can move a date across a month boundary and is still found', () => {
    const { data, id } = seed();
    const r = editNextDate(data, id, '2026-10-31', ctx());
    expect(effectiveNext(r.data.commitments[0], TODAY)?.date).toBe('2026-10-31');
  });
  it('editAmount next-only vs all; paid history keeps its recorded amount', () => {
    const { data, id } = seed();
    const paid = markPaid(data, id, ctx());
    const next = editAmount(paid.data, id, 70000, ctx(), { scope: 'next' });
    const n1 = effectiveNext(next.data.commitments[0], TODAY)!;
    expect(n1.amountPaise).toBe(70000);
    expect(
      obligationOccurrences(next.data.commitments[0], '2027-01-01', '2027-01-31')[0].amountPaise,
    ).toBe(64900);
    const all = editAmount(next.data, id, 79900, ctx(), { scope: 'all' });
    const c = all.data.commitments[0];
    expect(c.amount.value).toBe(79900);
    expect(c.amountPaise).toBe(79900);
    expect(c.history[0].amountPaise).toBe(64900);
    expect(() => editAmount(data, id, -1, ctx())).toThrow(MutationError);
  });
  it('editSchedule replaces the rule and re-anchors the tracked date', () => {
    const { data, id } = seed();
    const r = editSchedule(data, id, rules.nthWeekday('2026-11-01', -1, 5), ctx());
    const c = r.data.commitments[0];
    expect(c.date.value).toBe('2026-11-01');
    expect(effectiveNext(c, TODAY)?.date).toBe('2026-11-27');
    expect(c.frequency).toBe('monthly');
  });
});

describe('soft delete, restore, status', () => {
  it('delete hides the obligation; restore and undo bring it back', () => {
    const { data, id } = seed();
    const del = deleteObligation(data, id, { now: NOW });
    expect(activeObligations(del.data)).toEqual([]);
    expect(del.data.commitments).toHaveLength(1);
    expect(activeObligations(del.undo())).toHaveLength(1);
    expect(activeObligations(restoreObligation(del.data, id, { now: NOW }).data)).toHaveLength(1);
  });
  it('setObligationStatus is audited', () => {
    const { data, id } = seed();
    const r = setObligationStatus(data, id, 'cancelled_confirmed_by_user', { now: NOW });
    expect(r.event.action).toBe('status_changed');
    expect(r.data.commitments[0].status).toBe('cancelled_confirmed_by_user');
  });
  it('unknown ids throw', () => {
    expect(() => markPaid(emptyData(), 'x', ctx())).toThrow(MutationError);
  });
});

describe('external changes', () => {
  const src = { kind: 'statement' as const, label: 'Statement import', importedAt: NOW };
  it('an imported date change keeps a one-off amount the user set for that occurrence', () => {
    const { data, id } = seed();
    const a = editAmount(data, id, 49900, ctx(), { scope: 'next' });
    const r = recordExternalChange(a.data, id, { field: 'date', to: '2026-11-07' }, src, ctx());
    expect(effectiveNext(r.data.commitments[0], TODAY)).toMatchObject({
      date: '2026-11-07',
      amountPaise: 49900,
    });
  });
  it('date change from import overrides the next occurrence and is flagged, acknowledge clears', () => {
    const { data, id } = seed();
    const r = recordExternalChange(data, id, { field: 'date', to: '2026-11-07' }, src, ctx());
    const c = r.data.commitments[0];
    expect(r.event.actor).toBe('system');
    expect(effectiveNext(c, TODAY)).toMatchObject({
      date: '2026-11-07',
      dateConfidence: 'imported',
    });
    expect(c.pendingChanges).toMatchObject([
      { field: 'date', from: '2026-11-05', to: '2026-11-07' },
    ]);
    expect(acknowledgeChanges(r.data, id, { now: NOW }).data.commitments[0].pendingChanges).toEqual(
      [],
    );
  });
  it('a matching value is not flagged as a change', () => {
    const { data, id } = seed();
    const r = recordExternalChange(data, id, { field: 'amount', to: 64900 }, src, ctx());
    expect(r.data.commitments[0].pendingChanges).toEqual([]);
    expect(r.data.commitments[0].amount.confidence).toBe('imported');
  });
});

describe('effectiveNext edge cases', () => {
  it('past occurrences of a recurring auto-renewal are not overdue', () => {
    const { data, id } = seed();
    const n = effectiveNext(
      data.commitments.find((c) => c.id === id)!,
      '2027-03-10',
    )!;
    expect(n.date).toBe('2027-04-05');
    expect(n.status).toBe('upcoming');
  });
  it('a one-time item whose date passed unpaid is overdue; paid one-time has no next', () => {
    const r = createObligation(
      emptyData(),
      { type: 'bill', provider: 'Plumber', amountPaise: 150000, rule: rules.oneTime('2026-10-20') },
      ctx(),
    );
    const c = r.data.commitments[0];
    expect(effectiveNext(c, TODAY)?.status).toBe('overdue');
    const p = markPaid(r.data, c.id, ctx());
    expect(effectiveNext(p.data.commitments[0], TODAY)).toBeNull();
  });
  it('user-marked overdue surfaces the latest unpaid past occurrence', () => {
    const { data, id } = seed();
    const s = setObligationStatus(data, id, 'overdue_user_entered', { now: NOW });
    expect(effectiveNext(s.data.commitments[0], '2026-11-10')).toMatchObject({
      date: '2026-11-05',
      status: 'overdue',
    });
  });
  it('due today and irregular without a date', () => {
    const { data, id } = seed();
    expect(
      effectiveNext(
        data.commitments.find((c) => c.id === id)!,
        '2026-11-05',
      )?.status,
    ).toBe('due_today');
    const irr = createObligation(
      emptyData(),
      { type: 'other', provider: 'Repairs', amountPaise: null, rule: rules.irregular() },
      ctx(),
    );
    expect(effectiveNext(irr.data.commitments[0], TODAY)).toBeNull();
  });
});
