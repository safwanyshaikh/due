/**
 * Audit log with generic undo.
 *
 * Every mutation captures a before/after `Patch` (collection → id → record | null). Undo
 * re-applies `before` and appends an 'undo' event. Obligation history (paid/reviewed/snoozed)
 * is append-only: when undo restores an older snapshot, any history events added since are kept
 * and cancelled with 'revoked' events instead.
 *
 * Undo is allowed only for events younger than `UNDO_WINDOW_MS` (24 hours); the UI offers it in
 * the 8-second toast. Because old events can no longer be undone, the log is compacted
 * (`compactAudit`): it keeps the most recent `AUDIT_KEEP_RECENT` events plus each obligation's
 * latest event; events older than `AUDIT_PAYLOAD_DAYS`, or beyond the newest
 * `AUDIT_PAYLOAD_KEEP`, keep only their summary.
 */
import { newId } from './ids';
import type { AppData, Commitment, CommitmentLink, OccurrenceEvent } from './types';
import type { ImportItem } from './imports';
import type { DuplicateDecision } from './duplicates';
import type { ReminderState } from './reminderPlan';
import type { UserEvent } from './intake';

export type Actor = 'user' | 'import' | 'system';

export type AuditEntity =
  'obligation' | 'import_item' | 'user_event' | 'duplicate' | 'reminder' | 'settings';

export type AuditAction =
  | 'create'
  | 'update'
  | 'mark_paid'
  | 'mark_reviewed'
  | 'snooze'
  | 'edit_next_date'
  | 'edit_amount'
  | 'edit_schedule'
  | 'status_changed'
  | 'delete'
  | 'restore'
  | 'acknowledge_change'
  | 'external_change'
  | 'import_received'
  | 'import_approved'
  | 'import_ignored'
  | 'import_edited'
  | 'intake_deleted'
  | 'duplicate_merged'
  | 'duplicate_dismissed'
  | 'reminder_acknowledged'
  | 'reminder_snoozed'
  | 'reminder_settings'
  | 'undo';

/** Undo is refused for events older than this. */
export const UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Compaction keeps at least this many of the most recent events. */
export const AUDIT_KEEP_RECENT = 1000;
/** Events older than this keep only their summary (before/after payloads are dropped). */
export const AUDIT_PAYLOAD_DAYS = 30;
/**
 * Only this many of the most recent events keep their before/after payloads, even inside 30 days.
 * A payload holds whole records (~2–3 KB), so this bounds the synced document (2 MB limit). Undo
 * needs the payload, but only the last few events are ever undone (24-hour window, 8-second toast).
 */
export const AUDIT_PAYLOAD_KEEP = 300;

/** Records keyed by id, per collection. `null` means "did not exist". */
export interface Patch {
  commitments?: Record<string, Commitment | null>;
  importQueue?: Record<string, ImportItem | null>;
  userEvents?: Record<string, UserEvent | null>;
  duplicateDecisions?: Record<string, DuplicateDecision | null>;
  reminderStates?: Record<string, ReminderState | null>;
  /** Card-statement links (moved when duplicates are merged). */
  links?: Record<string, CommitmentLink | null>;
}

export type PatchCollection = keyof Patch;

export interface AuditEvent {
  id: string;
  at: string;
  action: AuditAction;
  entity: AuditEntity;
  entityId: string;
  before: Patch;
  after: Patch;
  actor: Actor;
  /** Short plain-English summary for the audit list ("Next date moved to 14 Nov"). */
  summary: string;
  /** For 'undo' events: the event being undone. */
  undoOf?: string;
  /** Set by `compactAudit` when before/after were dropped (only the summary is kept). */
  compacted?: true;
}

export interface MutationContext {
  /** ISO timestamp of the action. */
  now: string;
  actor?: Actor;
}

export interface MutationResult {
  data: AppData;
  event: AuditEvent;
  /** Pure: returns `data` with this event undone (same as `applyUndo(data, event.id)`). */
  undo: () => AppData;
}

type Keyed = { id?: string; key?: string };
const keyOf = (r: Keyed): string => (r.id ?? r.key) as string;

function collection(data: AppData, c: PatchCollection): Keyed[] {
  return (data[c] ?? []) as Keyed[];
}

/** Snapshot of the given records (null for missing). */
export function capture(data: AppData, refs: Partial<Record<PatchCollection, string[]>>): Patch {
  const patch: Patch = {};
  for (const [c, ids] of Object.entries(refs) as [PatchCollection, string[]][]) {
    const list = collection(data, c);
    const rec: Record<string, unknown> = {};
    for (const id of ids) rec[id] = list.find((r) => keyOf(r) === id) ?? null;
    (patch as Record<string, unknown>)[c] = rec;
  }
  return patch;
}

function refsOf(p: Patch): Partial<Record<PatchCollection, string[]>> {
  const refs: Partial<Record<PatchCollection, string[]>> = {};
  for (const [c, rec] of Object.entries(p) as [PatchCollection, Record<string, unknown>][])
    refs[c] = Object.keys(rec ?? {});
  return refs;
}

/** Writes records from a patch (null removes). Order of existing records is preserved. */
export function applyPatch(data: AppData, patch: Patch): AppData {
  let next: AppData = data;
  for (const [c, rec] of Object.entries(patch) as [
    PatchCollection,
    Record<string, Keyed | null>,
  ][]) {
    if (!rec) continue;
    let list = [...collection(next, c)];
    for (const [id, value] of Object.entries(rec)) {
      const i = list.findIndex((r) => keyOf(r) === id);
      if (value === null) {
        if (i >= 0) list = list.filter((_, j) => j !== i);
      } else if (i >= 0) list[i] = value;
      else list.push(value);
    }
    next = { ...next, [c]: list } as AppData;
  }
  return next;
}

/**
 * Applies `after` to `data`, appends an audit event, and returns an undo thunk.
 * `refs` lists which records `before`/`after` snapshot; `after` is read from `nextData`.
 */
export function commit(
  data: AppData,
  nextData: AppData,
  refs: Partial<Record<PatchCollection, string[]>>,
  meta: { action: AuditAction; entity: AuditEntity; entityId: string; summary: string },
  ctx: MutationContext,
): MutationResult {
  const event: AuditEvent = {
    id: newId('ev'),
    at: ctx.now,
    actor: ctx.actor ?? 'user',
    before: capture(data, refs),
    after: capture(nextData, refs),
    ...meta,
  };
  const out: AppData = compactAudit(
    { ...nextData, audit: [...(nextData.audit ?? []), event] },
    ctx.now,
  );
  return { data: out, event, undo: () => undoOrSame(out, event.id, ctx.now) };
}

function undoOrSame(data: AppData, eventId: string, now: string): AppData {
  const r = applyUndo(data, eventId, { now });
  return r.ok ? r.data : data;
}

export type UndoRefusal = 'not_found' | 'already_undone' | 'is_undo' | 'changed_since' | 'expired';

export type UndoResult =
  { ok: true; data: AppData; event: AuditEvent } | { ok: false; reason: UndoRefusal };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Ids of events that have been undone. */
export function undoneEventIds(data: Pick<AppData, 'audit'>): Set<string> {
  return new Set((data.audit ?? []).filter((e) => e.undoOf).map((e) => e.undoOf as string));
}

/** True when an event is past the undo window (or its payload was compacted away). */
export function undoExpired(ev: Pick<AuditEvent, 'at' | 'compacted'>, now: string): boolean {
  if (ev.compacted) return true;
  const age = Date.parse(now) - Date.parse(ev.at);
  return !Number.isFinite(age) || age >= UNDO_WINDOW_MS;
}

/**
 * True while the event can still be undone (younger than 24 hours, not undone, records unchanged
 * since). `now` defaults to the current time.
 */
export function canUndo(
  data: AppData,
  eventId: string,
  now: string = new Date().toISOString(),
): boolean {
  return checkUndo(data, eventId, now) === null;
}

function checkUndo(data: AppData, eventId: string, now: string): UndoRefusal | null {
  const ev = (data.audit ?? []).find((e) => e.id === eventId);
  if (!ev) return 'not_found';
  if (ev.action === 'undo') return 'is_undo';
  if (undoneEventIds(data).has(eventId)) return 'already_undone';
  if (undoExpired(ev, now)) return 'expired';
  if (!same(capture(data, refsOf(ev.after)), ev.after)) return 'changed_since';
  return null;
}

/** Keep history appended since `before`, cancelling it with 'revoked' events. */
function preserveHistory(
  before: Commitment | null,
  current: Commitment | null,
  now: string,
): Commitment | null {
  if (!before || !current) return before;
  const known = new Set(before.history.map((e) => e.id));
  const added = current.history.filter((e) => !known.has(e.id));
  if (!added.length) return before;
  const revokes: OccurrenceEvent[] = added
    .filter((e) => e.kind !== 'revoked')
    .map((e) => ({
      id: newId('h'),
      occurrenceDate: e.occurrenceDate,
      kind: 'revoked',
      at: now,
      actor: 'user',
      revokes: e.id,
    }));
  return { ...before, history: [...before.history, ...added, ...revokes] };
}

/**
 * Restores the records an event changed to their `before` state and appends an 'undo' event.
 * Refuses if those records changed since (undo the later event first).
 */
export function applyUndo(data: AppData, eventId: string, ctx: MutationContext): UndoResult {
  const problem = checkUndo(data, eventId, ctx.now);
  if (problem) return { ok: false, reason: problem };
  const ev = (data.audit ?? []).find((e) => e.id === eventId)!;
  const restore: Patch = { ...ev.before };
  if (ev.before.commitments) {
    const rec: Record<string, Commitment | null> = {};
    for (const [id, before] of Object.entries(ev.before.commitments)) {
      const current = data.commitments.find((c) => c.id === id) ?? null;
      rec[id] = preserveHistory(before, current, ctx.now);
    }
    restore.commitments = rec;
  }
  const refs = refsOf(ev.after);
  const nextData = applyPatch(data, restore);
  const undoEvent: AuditEvent = {
    id: newId('ev'),
    at: ctx.now,
    actor: ctx.actor ?? 'user',
    action: 'undo',
    entity: ev.entity,
    entityId: ev.entityId,
    before: capture(data, refs),
    after: capture(nextData, refs),
    summary: `Undid: ${ev.summary}`,
    undoOf: ev.id,
  };
  return {
    ok: true,
    data: compactAudit({ ...nextData, audit: [...(nextData.audit ?? []), undoEvent] }, ctx.now),
    event: undoEvent,
  };
}

/** Audit events for one entity, newest first. */
export function auditFor(data: Pick<AppData, 'audit'>, entityId: string): AuditEvent[] {
  return (data.audit ?? []).filter((e) => e.entityId === entityId).reverse();
}

const DAY_MS = 86_400_000;

/** Commitment ids an event concerns (its obligation entity and any commitments it changed). */
function obligationKeys(e: AuditEvent): string[] {
  const keys = new Set<string>(Object.keys(e.after?.commitments ?? {}));
  for (const k of Object.keys(e.before?.commitments ?? {})) keys.add(k);
  if (e.entity === 'obligation') keys.add(e.entityId);
  return [...keys];
}

/**
 * Bounds the audit log. Keeps the most recent `AUDIT_KEEP_RECENT` events plus, for every
 * obligation, its latest event (so each item keeps a "last changed" entry); older events are
 * dropped. Kept events older than `AUDIT_PAYLOAD_DAYS` (or older than the newest
 * `AUDIT_PAYLOAD_KEEP` events) lose their before/after payloads and keep only the summary
 * (`compacted: true`); such events can no longer be undone. Returns `data` unchanged when there is nothing to do.
 */
export function compactAudit(data: AppData, now: string): AppData {
  const audit = data.audit ?? [];
  if (!audit.length) return data;
  const cutoff = Date.parse(now) - AUDIT_PAYLOAD_DAYS * DAY_MS;
  const keep = new Set<number>();
  for (let i = Math.max(0, audit.length - AUDIT_KEEP_RECENT); i < audit.length; i++) keep.add(i);
  if (audit.length > AUDIT_KEEP_RECENT) {
    const latest = new Map<string, number>();
    audit.forEach((e, i) => {
      for (const k of obligationKeys(e)) latest.set(k, i);
    });
    for (const i of latest.values()) keep.add(i);
  }
  let changed = keep.size !== audit.length;
  const payloadFrom = audit.length - AUDIT_PAYLOAD_KEEP;
  const next: AuditEvent[] = [];
  audit.forEach((e, i) => {
    if (!keep.has(i)) return;
    const at = Date.parse(e.at);
    const old = !Number.isFinite(at) || at < cutoff;
    if (!e.compacted && (old || i < payloadFrom)) {
      changed = true;
      next.push({ ...e, before: {}, after: {}, compacted: true });
    } else next.push(e);
  });
  return changed ? { ...data, audit: next } : data;
}
