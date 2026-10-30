/**
 * Obligation mutations. Each returns `{ data, event, undo }` and appends an audit event.
 * Pure: pass the timestamp in `ctx.now`. Throws `MutationError` for unknown ids/invalid input.
 */
import { commit, type MutationContext, type MutationResult } from './audit';
import { formatDate, isValidISO } from './dates';
import { newId } from './ids';
import { canonicalMerchant } from './merchants';
import { formatINR } from './money';
import { effectiveNext, findObligation } from './obligations';
import { manualSource, reconcileObligation, tracked, withMirrors } from './provenance';
import { ruleAnchor, validateRule, describeRule, type RecurrenceRule } from './recurrence';
import { STATUS_LABELS } from './status';
import type {
  AppData,
  Commitment,
  ISODate,
  OccurrenceEvent,
  PendingChange,
  Provenance,
  Status,
  ValueConfidence,
} from './types';

export class MutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MutationError';
  }
}

export type { MutationContext, MutationResult };

function must(data: AppData, id: string): Commitment {
  const c = findObligation(data, id);
  if (!c) throw new MutationError(`No obligation with id ${id}`);
  return c;
}

function nameOf(c: Commitment): string {
  return c.nickname || c.provider || 'Item';
}

function put(data: AppData, c: Commitment, now: string): AppData {
  const next = withMirrors({ ...c, updatedAt: now });
  const exists = data.commitments.some((x) => x.id === c.id);
  return {
    ...data,
    commitments: exists
      ? data.commitments.map((x) => (x.id === c.id ? next : x))
      : [...data.commitments, next],
  };
}

function save(
  data: AppData,
  c: Commitment,
  ctx: MutationContext,
  action: Parameters<typeof commit>[3]['action'],
  summary: string,
): MutationResult {
  return commit(
    data,
    put(data, c, ctx.now),
    { commitments: [c.id] },
    {
      action,
      entity: 'obligation',
      entityId: c.id,
      summary,
    },
    ctx,
  );
}

/** Occurrence to act on: the given one, or the obligation's effective next occurrence. */
function targetOccurrence(
  c: Commitment,
  occurrenceDate: ISODate | undefined,
  today: ISODate,
): ISODate {
  if (occurrenceDate) return occurrenceDate;
  const n = effectiveNext(c, today);
  if (!n) throw new MutationError('This item has no upcoming date to act on.');
  return n.occurrenceDate;
}

function appendHistory(c: Commitment, e: Omit<OccurrenceEvent, 'id'>): Commitment {
  return { ...c, history: [...c.history, { id: newId('h'), ...e }] };
}

/* ---------- Create / edit ---------- */

export interface ObligationDraft {
  type: Commitment['type'];
  provider: string;
  nickname?: string;
  amountPaise: number | null;
  rule: RecurrenceRule;
  amountConfidence?: ValueConfidence;
  dateConfidence?: ValueConfidence;
  source?: Provenance;
  ownerLabel?: string;
  rail?: Commitment['rail'];
  importance?: Commitment['importance'];
  notes?: string;
  reminder?: Commitment['reminder'];
  status?: Status;
}

/** Builds a complete obligation record (not yet stored). */
export function buildObligation(draft: ObligationDraft, now: string): Commitment {
  const anchor = ruleAnchor(draft.rule) ?? now.slice(0, 10);
  const source = draft.source ?? manualSource();
  const c: Commitment = {
    id: newId('c'),
    type: draft.type,
    provider: draft.provider,
    nickname: draft.nickname ?? '',
    amountPaise: draft.amountPaise,
    currency: 'INR',
    frequency: 'monthly',
    intervalMonths: null,
    nextDue: anchor,
    dueConfidence: 'estimate',
    amountConfidence: 'estimate',
    remainingOccurrences: null,
    rail: draft.rail ?? 'unknown',
    accountNickname: '',
    ownerLabel: draft.ownerLabel ?? '',
    importance: draft.importance ?? (draft.type === 'subscription' ? 'optional' : 'essential'),
    notes: draft.notes ?? '',
    lastConfirmed: null,
    reminder: draft.reminder ?? { enabled: true, offsets: [7, 3, 1] },
    status: draft.status ?? (draft.rule.kind === 'trial_to_paid' ? 'trial' : 'active'),
    billingEmailLabelId: null,
    source: source.kind === 'csv' ? 'csv_import' : 'manual',
    createdAt: now,
    updatedAt: now,
    canonicalProvider: canonicalMerchant(draft.provider)?.key ?? null,
    amount: tracked(draft.amountPaise, draft.amountConfidence ?? 'user_entered', source, now),
    date: tracked(anchor, draft.dateConfidence ?? 'user_entered', source, now),
    rule: draft.rule,
    overrides: [],
    history: [],
    pendingChanges: [],
    deletedAt: null,
    mergedInto: null,
  };
  return withMirrors(c);
}

export function createObligation(
  data: AppData,
  draft: ObligationDraft,
  ctx: MutationContext,
): MutationResult {
  const errs = validateRule(draft.rule);
  if (errs.length) throw new MutationError(errs.join(' '));
  if (!draft.provider.trim()) throw new MutationError('Please enter who this is with.');
  const c = buildObligation(draft, ctx.now);
  return save(data, c, ctx, 'create', `Added ${nameOf(c)}`);
}

/** Generic field edit for descriptive fields (nickname, owner, rail, notes, reminder, importance…). */
export function updateObligation(
  data: AppData,
  id: string,
  patch: Partial<
    Pick<
      Commitment,
      | 'nickname'
      | 'provider'
      | 'ownerLabel'
      | 'rail'
      | 'notes'
      | 'importance'
      | 'reminder'
      | 'accountNickname'
      | 'type'
    >
  >,
  ctx: MutationContext,
): MutationResult {
  const c = must(data, id);
  const next = { ...c, ...patch };
  if (patch.provider !== undefined)
    next.canonicalProvider = canonicalMerchant(patch.provider)?.key ?? null;
  return save(data, next, ctx, 'update', `Edited ${nameOf(next)}`);
}

/** Replaces the schedule rule (changes all future occurrences; history is kept). */
export function editSchedule(
  data: AppData,
  id: string,
  rule: RecurrenceRule,
  ctx: MutationContext,
  confidence: ValueConfidence = 'user_entered',
): MutationResult {
  const errs = validateRule(rule);
  if (errs.length) throw new MutationError(errs.join(' '));
  const c = must(data, id);
  const anchor = ruleAnchor(rule) ?? c.date.value;
  const next: Commitment = {
    ...c,
    rule,
    date: tracked(anchor, confidence, manualSource(), ctx.now),
  };
  return save(data, next, ctx, 'edit_schedule', `Schedule set to: ${describeRule(rule)}`);
}

/* ---------- Occurrence actions (append-only history) ---------- */

export function markPaid(
  data: AppData,
  id: string,
  ctx: MutationContext & { today: ISODate },
  occurrenceDate?: ISODate,
  note?: string,
): MutationResult {
  const c = must(data, id);
  const occ = targetOccurrence(c, occurrenceDate, ctx.today);
  const n = effectiveNext(c, ctx.today);
  const amountPaise = n && n.occurrenceDate === occ ? n.amountPaise : c.amount.value;
  const next = appendHistory(c, {
    occurrenceDate: occ,
    kind: 'paid',
    at: ctx.now,
    actor: ctx.actor ?? 'user',
    amountPaise,
    note,
  });
  return save(data, next, ctx, 'mark_paid', `Marked ${nameOf(c)} paid for ${formatDate(occ)}`);
}

export function markReviewed(
  data: AppData,
  id: string,
  ctx: MutationContext & { today: ISODate },
  occurrenceDate?: ISODate,
): MutationResult {
  const c = must(data, id);
  const occ = targetOccurrence(c, occurrenceDate, ctx.today);
  let next = appendHistory(c, {
    occurrenceDate: occ,
    kind: 'reviewed',
    at: ctx.now,
    actor: ctx.actor ?? 'user',
  });
  // Reviewing acknowledges any pending import/sync changes.
  if (next.pendingChanges?.length) next = { ...next, pendingChanges: [] };
  if (next.overdueReview) next = { ...next, overdueReview: null };
  return save(data, next, ctx, 'mark_reviewed', `Reviewed ${nameOf(c)} for ${formatDate(occ)}`);
}

/** Snoozes one occurrence until a date. Never moves the due date. */
export function snooze(
  data: AppData,
  id: string,
  until: ISODate,
  ctx: MutationContext & { today: ISODate },
  occurrenceDate?: ISODate,
): MutationResult {
  if (!isValidISO(until)) throw new MutationError('Choose a valid snooze date.');
  const c = must(data, id);
  const occ = targetOccurrence(c, occurrenceDate, ctx.today);
  const next = appendHistory(c, {
    occurrenceDate: occ,
    kind: 'snoozed',
    until,
    at: ctx.now,
    actor: ctx.actor ?? 'user',
  });
  return save(data, next, ctx, 'snooze', `Snoozed ${nameOf(c)} until ${formatDate(until)}`);
}

/**
 * Moves one occurrence (default: the effective next one) to a new date via an override.
 * The rule and all other occurrences are unchanged; past history is untouched.
 */
export function editNextDate(
  data: AppData,
  id: string,
  newDate: ISODate,
  ctx: MutationContext & { today: ISODate },
  opts: {
    occurrenceDate?: ISODate;
    reason?: string;
    confidence?: ValueConfidence;
    source?: Provenance;
  } = {},
): MutationResult {
  if (!isValidISO(newDate)) throw new MutationError('Choose a valid date.');
  const c = must(data, id);
  const occ = targetOccurrence(c, opts.occurrenceDate, ctx.today);
  const prev = c.overrides.filter((o) => o.occurrenceDate === occ).pop();
  const next: Commitment = {
    ...c,
    overrides: [
      ...c.overrides.filter((o) => o.occurrenceDate !== occ),
      {
        id: newId('o'),
        occurrenceDate: occ,
        newDate: newDate === occ ? undefined : newDate,
        ...(prev?.newAmountPaise !== undefined ? { newAmountPaise: prev.newAmountPaise } : {}),
        reason: opts.reason ?? 'Edited by you',
        at: ctx.now,
        confidence: opts.confidence ?? 'user_entered',
        source: opts.source ?? manualSource(),
      },
    ],
  };
  return save(
    data,
    next,
    ctx,
    'edit_next_date',
    `Moved ${nameOf(c)} from ${formatDate(occ)} to ${formatDate(newDate)}`,
  );
}

/**
 * Edits the amount. scope 'next' overrides only one occurrence; 'all' changes the amount for
 * future occurrences (paid history keeps the amounts recorded at the time).
 */
export function editAmount(
  data: AppData,
  id: string,
  amountPaise: number | null,
  ctx: MutationContext & { today: ISODate },
  opts: {
    scope?: 'next' | 'all';
    occurrenceDate?: ISODate;
    reason?: string;
    confidence?: ValueConfidence;
    source?: Provenance;
  } = {},
): MutationResult {
  if (amountPaise !== null && !(Number.isInteger(amountPaise) && amountPaise >= 0))
    throw new MutationError('Amount must be zero or more.');
  const c = must(data, id);
  const confidence = opts.confidence ?? 'user_entered';
  const source = opts.source ?? manualSource();
  const amt = amountPaise === null ? 'not set' : formatINR(amountPaise);
  if ((opts.scope ?? 'all') === 'all') {
    const next: Commitment = {
      ...c,
      amount: tracked(amountPaise, confidence, source, ctx.now),
      rule: c.rule.kind === 'trial_to_paid' ? { ...c.rule, paidAmountPaise: amountPaise } : c.rule,
    };
    return save(data, next, ctx, 'edit_amount', `Amount for ${nameOf(c)} set to ${amt}`);
  }
  const occ = targetOccurrence(c, opts.occurrenceDate, ctx.today);
  const prev = c.overrides.filter((o) => o.occurrenceDate === occ).pop();
  const next: Commitment = {
    ...c,
    overrides: [
      ...c.overrides.filter((o) => o.occurrenceDate !== occ),
      {
        id: newId('o'),
        occurrenceDate: occ,
        ...(prev?.newDate ? { newDate: prev.newDate } : {}),
        newAmountPaise: amountPaise,
        reason: opts.reason ?? 'Edited by you',
        at: ctx.now,
        confidence,
        source,
      },
    ],
  };
  return save(
    data,
    next,
    ctx,
    'edit_amount',
    `Amount for ${nameOf(c)} on ${formatDate(occ)} set to ${amt}`,
  );
}

/** Records a user-stated status (e.g. cancelled confirmed by you). Audited, undoable. */
export function setObligationStatus(
  data: AppData,
  id: string,
  status: Status,
  ctx: MutationContext,
): MutationResult {
  const c = must(data, id);
  return save(
    data,
    { ...c, status },
    ctx,
    'status_changed',
    `${nameOf(c)}: ${STATUS_LABELS[status]}`,
  );
}

/** Soft delete (restorable, and undoable). Links and logs are kept. */
export function deleteObligation(data: AppData, id: string, ctx: MutationContext): MutationResult {
  const c = must(data, id);
  return save(data, { ...c, deletedAt: ctx.now }, ctx, 'delete', `Deleted ${nameOf(c)}`);
}

export function restoreObligation(data: AppData, id: string, ctx: MutationContext): MutationResult {
  const c = must(data, id);
  return save(
    data,
    { ...c, deletedAt: null, mergedInto: null },
    ctx,
    'restore',
    `Restored ${nameOf(c)}`,
  );
}

/* ---------- External changes (import/sync) ---------- */

/**
 * Applies a change that came from an import or sync (not the user). The value is updated with
 * its provenance AND a PendingChange is recorded so Home shows "amount/date changed" until the
 * user reviews it.
 */
export function recordExternalChange(
  data: AppData,
  id: string,
  change: { field: 'amount'; to: number | null } | { field: 'date'; to: ISODate },
  source: Provenance,
  ctx: MutationContext & { today: ISODate },
): MutationResult {
  const c = must(data, id);
  const actorCtx = { ...ctx, actor: ctx.actor ?? ('system' as const) };
  let next: Commitment;
  let from: number | string | null;
  if (change.field === 'amount') {
    from = c.amount.value;
    next = { ...c, amount: tracked(change.to, 'imported', source, ctx.now) };
  } else {
    const n = effectiveNext(c, ctx.today);
    if (!n) throw new MutationError('This item has no upcoming date to change.');
    from = n.date;
    const prev = c.overrides.filter((o) => o.occurrenceDate === n.occurrenceDate).pop();
    next = {
      ...c,
      overrides: [
        ...c.overrides.filter((o) => o.occurrenceDate !== n.occurrenceDate),
        {
          id: newId('o'),
          occurrenceDate: n.occurrenceDate,
          newDate: change.to,
          // Keep a one-off amount the user set for this occurrence.
          ...(prev?.newAmountPaise !== undefined ? { newAmountPaise: prev.newAmountPaise } : {}),
          reason: `Updated from ${source.label}`,
          at: ctx.now,
          confidence: 'imported',
          source,
        },
      ],
    };
  }
  if (from === change.to) {
    return save(
      data,
      next,
      actorCtx,
      'external_change',
      `${nameOf(c)} confirmed by ${source.label}`,
    );
  }
  const pc: PendingChange = {
    id: newId('pc'),
    field: change.field,
    from,
    to: change.to,
    at: ctx.now,
    sourceLabel: source.label,
  };
  next = { ...next, pendingChanges: [...(next.pendingChanges ?? []), pc] };
  return save(
    data,
    next,
    actorCtx,
    'external_change',
    `${nameOf(c)}: ${change.field} changed by ${source.label}`,
  );
}

/** Clears pending change flags after the user has seen them. */
export function acknowledgeChanges(
  data: AppData,
  id: string,
  ctx: MutationContext,
): MutationResult {
  const c = must(data, id);
  return save(
    data,
    { ...c, pendingChanges: [], ...(c.overdueReview ? { overdueReview: null } : {}) },
    ctx,
    'acknowledge_change',
    `Reviewed changes to ${nameOf(c)}`,
  );
}

/** Re-export for convenience. */
export { reconcileObligation };
