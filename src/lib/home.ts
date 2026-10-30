/**
 * Home selectors: the "what is due next, when, how much, how certain, what to do" answer.
 * Pure. Dates in the user's timezone; `today` is an ISODate already in that zone.
 */
import { cadenceMonths, describeRule } from './recurrence';
import { addDays, daysBetween, formatDate } from './dates';
import { findDuplicateSuggestions, type DuplicateSuggestion } from './duplicates';
import { pendingImports } from './imports';
import { canonicalMerchant } from './merchants';
import { formatINR } from './money';
import {
  effectiveNext,
  forecastObligations,
  lastOccurrence,
  liveHistory,
  obligationOccurrences,
  type ObligationOccurrence,
  type OccurrenceStatus,
} from './obligations';
import { CONFIDENCE_LABELS, reconcileObligation } from './provenance';
import { reminderStateText } from './reminderPlan';
import { linkedParentMap } from './totals';
import { DEFAULT_TZ, toZoned } from './tz';
import type { AppData, Commitment, ISODate, Provenance, Rail, ValueConfidence } from './types';

export interface WhyThis {
  /** How this item/date was matched or produced. */
  matchLogic: string;
  /** Where the values came from. */
  source: string;
  /** Local date-time of the latest import/sync behind this item, or null for manual items. */
  lastSyncOrImport: string | null;
  /** Plain-English explanation of amount and date confidence. */
  confidence: string;
}

export interface ObligationView {
  id: string;
  type: Commitment['type'];
  /** Merchant nickname (falls back to provider). */
  nickname: string;
  /** Canonical provider key (e.g. 'netflix') or null. */
  canonicalProvider: string | null;
  /** Display name of the provider ("Netflix", or what the user typed). */
  providerName: string;
  amountPaise: number | null;
  currency: 'INR';
  /** "₹649" or "Amount not set". */
  amountText: string;
  /** Original occurrence date (identity for actions), null if nothing pending. */
  occurrenceDate: ISODate | null;
  /** Effective next date, null if none. */
  date: ISODate | null;
  /** "12 Nov 2026" or "No date yet". */
  dateText: string;
  daysUntil: number | null;
  ruleText: string;
  amountConfidence: ValueConfidence;
  dateConfidence: ValueConfidence;
  amountConfidenceText: string;
  dateConfidenceText: string;
  /** Source badge, e.g. "Entered by you", "CSV import", "Forwarded email". */
  sourceBadge: string;
  owner: string;
  rail: Rail;
  railText: string;
  reminderText: string;
  status: OccurrenceStatus;
  statusText: string;
  /** True when this occurrence has a one-off date/amount change. */
  overridden: boolean;
  why: WhyThis;
}

export type AttentionKind =
  | 'amount_changed'
  | 'date_changed'
  | 'stale_source'
  | 'unknown_merchant'
  | 'trial_ending'
  | 'overdue_user_entered'
  | 'overdue_review'
  | 'duplicate_suggestion'
  | 'import_pending';

export interface AttentionItem {
  /** Stable key for lists. */
  id: string;
  kind: AttentionKind;
  title: string;
  detail: string;
  severity: 'info' | 'normal' | 'important';
  obligationId?: string;
  importItemIds?: string[];
  suggestion?: DuplicateSuggestion;
}

export interface TotalDetail {
  totalPaise: number;
  /** Occurrences counted (including ones with no amount). */
  count: number;
  /** Occurrences with no amount entered (not counted as zero). */
  unknownAmountCount: number;
  /** Counted occurrences whose amount is an estimate. */
  estimatedCount: number;
}

export interface HomeSummary {
  next: ObligationView | null;
  next7Total: number;
  next30Total: number;
  next7: TotalDetail;
  next30: TotalDetail;
  needsAttention: AttentionItem[];
  /** The three dated occurrences after `next`, by date (not category). */
  timeline: ObligationView[];
  /** "You’re covered…" only when the data supports it, else null. */
  coveredMessage: string | null;
  /** Always-present calm header line. */
  headline: string;
}

export const RAIL_LABELS: Record<Rail, string> = {
  upi_autopay: 'UPI AutoPay',
  credit_card: 'Credit card',
  debit_card: 'Debit card',
  bank_mandate: 'Bank mandate',
  manual: 'Paid manually',
  other: 'Other',
  unknown: 'Payment method not set',
};

const CONF_EXPLAIN: Record<ValueConfidence, string> = {
  confirmed: 'confirmed from a bill or statement',
  estimated: 'an estimate; check it against your next bill',
  user_entered: 'entered by you',
  imported: 'imported and approved by you',
};

export const STALE_MIN_DAYS = 45;
export const TRIAL_WARNING_DAYS = 7;

function providerName(c: Commitment): string {
  return canonicalMerchant(c.provider)?.displayName ?? (c.provider || c.nickname || 'Unnamed');
}

function formatLocal(iso: string, tz: string): string {
  const z = toZoned(iso, tz);
  return `${formatDate(z.date)}, ${z.time}`;
}

function latestImport(sources: Provenance[]): Provenance | null {
  return (
    sources
      .filter((s) => s.kind !== 'manual' && s.importedAt)
      .sort((a, b) => (a.importedAt! < b.importedAt! ? 1 : -1))[0] ?? null
  );
}

function statusText(o: ObligationOccurrence | null, today: ISODate, c: Commitment): string {
  if (!o) return 'Nothing pending';
  switch (o.status) {
    case 'paid':
      return 'Marked paid';
    case 'snoozed':
      return `Snoozed until ${formatDate(o.snoozedUntil!)}`;
    case 'reviewed':
      return 'Reviewed';
    case 'due_today':
      return 'Due today';
    case 'overdue':
      return c.status === 'overdue_user_entered' ? 'Marked overdue by you' : 'Date passed';
    default: {
      const n = daysBetween(today, o.date);
      return n === 1 ? 'Tomorrow' : `In ${n} days`;
    }
  }
}

/** Builds the view for an obligation at a given occurrence (default: effective next). */
export function obligationView(
  data: AppData,
  input: Commitment,
  today: ISODate,
  tz = DEFAULT_TZ,
  occurrence?: ObligationOccurrence | null,
): ObligationView {
  const c = reconcileObligation(input);
  const occ =
    occurrence !== undefined ? occurrence : (effectiveNext(c, today) ?? lastOccurrence(c, today));
  const amountPaise = occ ? occ.amountPaise : c.amount.value;
  const amountConfidence = occ?.amountConfidence ?? c.amount.confidence;
  const dateConfidence = occ?.dateConfidence ?? c.date.confidence;
  const amountSource = occ?.amountSource ?? c.amount.source;
  const dateSource = occ?.dateSource ?? c.date.source;
  const imp = (data.importQueue ?? []).find(
    (i) => i.resultObligationId === c.id && i.status === 'approved',
  );
  const latest = latestImport([
    c.amount.source,
    c.date.source,
    ...c.overrides.map((o) => o.source),
  ]);
  const ruleText = describeRule(c.rule);
  const matchParts: string[] = [];
  if (imp?.matchReason) matchParts.push(imp.matchReason + '.');
  else if (imp)
    matchParts.push(
      `Created from ${imp.raw.kind === 'csv_row' ? 'a CSV row' : 'an item you approved'} (${imp.raw.ref}).`,
    );
  else if (c.amount.source.kind === 'manual' && c.date.source.kind === 'manual')
    matchParts.push('You added this item yourself.');
  else matchParts.push(`Values came from ${amountSource.label}.`);
  if (c.canonicalProvider) matchParts.push(`Recognised as ${providerName(c)}.`);
  if (occ?.override)
    matchParts.push(
      `This date was changed for this occurrence only (${occ.override.reason}); the schedule "${ruleText}" is unchanged.`,
    );
  else matchParts.push(`The date follows the schedule: ${ruleText}.`);
  if (linkedParentMap(data).has(c.id))
    matchParts.push('Included in a card statement, so it is not added to totals twice.');
  const sourceLabels = [...new Set([amountSource.label, dateSource.label])];
  return {
    id: c.id,
    type: c.type,
    nickname: c.nickname || c.provider,
    canonicalProvider: c.canonicalProvider ?? null,
    providerName: providerName(c),
    amountPaise,
    currency: 'INR',
    amountText: amountPaise === null ? 'Amount not set' : formatINR(amountPaise),
    occurrenceDate: occ?.occurrenceDate ?? null,
    date: occ?.date ?? null,
    dateText: occ ? formatDate(occ.date) : 'No date yet',
    daysUntil: occ ? daysBetween(today, occ.date) : null,
    ruleText,
    amountConfidence,
    dateConfidence,
    amountConfidenceText:
      amountPaise === null
        ? 'Amount not set'
        : `Amount ${CONFIDENCE_LABELS[amountConfidence].toLowerCase()}`,
    dateConfidenceText: `Date ${CONFIDENCE_LABELS[dateConfidence].toLowerCase()}`,
    sourceBadge: sourceLabels.join(' + '),
    owner: c.ownerLabel || 'You',
    rail: c.rail,
    railText: RAIL_LABELS[c.rail],
    reminderText: reminderStateText(c, data),
    status: occ?.status ?? 'upcoming',
    statusText: statusText(occ, today, c),
    overridden: !!occ?.override,
    why: {
      matchLogic: matchParts.join(' '),
      source: sourceLabels.join('; '),
      lastSyncOrImport: latest?.importedAt ? formatLocal(latest.importedAt, tz) : null,
      confidence: `Amount: ${amountPaise === null ? 'not entered yet' : CONF_EXPLAIN[amountConfidence]}. Date: ${CONF_EXPLAIN[dateConfidence]}.`,
    },
  };
}

interface Dated {
  ob: Commitment;
  occ: ObligationOccurrence;
}

/** Unpaid occurrences of forecast obligations in [start, end], excluding card-statement components. */
export function upcomingOccurrences(
  data: AppData,
  start: ISODate,
  end: ISODate,
  today: ISODate,
): Dated[] {
  const linked = linkedParentMap(data);
  const out: Dated[] = [];
  for (const ob of forecastObligations(data)) {
    if (linked.has(ob.id)) continue;
    for (const occ of obligationOccurrences(ob, start, end, today)) {
      if (occ.status !== 'paid') out.push({ ob, occ });
    }
  }
  return out.sort((a, b) => a.occ.date.localeCompare(b.occ.date) || a.ob.id.localeCompare(b.ob.id));
}

function total(items: Dated[]): TotalDetail {
  const t: TotalDetail = {
    totalPaise: 0,
    count: items.length,
    unknownAmountCount: 0,
    estimatedCount: 0,
  };
  for (const { occ } of items) {
    if (occ.amountPaise === null) t.unknownAmountCount++;
    else {
      t.totalPaise += occ.amountPaise;
      if (occ.amountConfidence === 'estimated') t.estimatedCount++;
    }
  }
  return t;
}

/** Needs-attention items, most important first. */
export function needsAttention(data: AppData, today: ISODate): AttentionItem[] {
  const out: AttentionItem[] = [];
  for (const ob of forecastObligations(data)) {
    const name = ob.nickname || ob.provider;
    for (const pc of ob.pendingChanges ?? []) {
      const isAmount = pc.field === 'amount';
      const fmt = (v: number | string | null) =>
        v === null ? 'not set' : isAmount ? formatINR(Number(v)) : formatDate(String(v));
      out.push({
        id: `${pc.field}_changed:${ob.id}:${pc.id}`,
        kind: isAmount ? 'amount_changed' : 'date_changed',
        title: `${name}: ${isAmount ? 'amount' : 'date'} changed`,
        detail: `${fmt(pc.from)} → ${fmt(pc.to)} (from ${pc.sourceLabel}). Want to review?`,
        severity: 'normal',
        obligationId: ob.id,
      });
    }
    const trialEnd =
      ob.rule.kind === 'trial_to_paid' ? ob.rule.trialEnd : ob.subscription?.trialEnd;
    if (trialEnd && trialEnd >= today && daysBetween(today, trialEnd) <= TRIAL_WARNING_DAYS) {
      const paid = ob.rule.kind === 'trial_to_paid' ? ob.rule.paidAmountPaise : ob.amount.value;
      const n = daysBetween(today, trialEnd);
      out.push({
        id: `trial_ending:${ob.id}:${trialEnd}`,
        kind: 'trial_ending',
        title: `${name} trial ends ${n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`}`,
        detail: `${formatDate(trialEnd)}${paid !== null ? `, then ${formatINR(paid)}` : ''}. Decide whether to keep it.`,
        severity: 'important',
        obligationId: ob.id,
      });
    }
    const next = effectiveNext(ob, today);
    if (next?.status === 'overdue') {
      out.push({
        id: `overdue:${ob.id}:${next.occurrenceDate}`,
        kind: 'overdue_user_entered',
        title: `${name}: date passed`,
        detail: `${formatDate(next.date)} has passed and it isn't marked paid. Mark it paid or edit the date.`,
        severity: 'important',
        obligationId: ob.id,
      });
    }
    const review = ob.overdueReview;
    if (
      review &&
      !liveHistory(ob).some((e) => e.kind === 'paid' && e.occurrenceDate === review.occurrenceDate)
    ) {
      out.push({
        id: `overdue_review:${ob.id}:${review.occurrenceDate}`,
        kind: 'overdue_review',
        title: `${name}: was this paid?`,
        detail: `${review.sourceLabel} shows ${formatDate(review.date)}, which has passed. It is not a payment receipt, so Due hasn't marked it paid. Mark it paid or review it.`,
        severity: 'important',
        obligationId: ob.id,
      });
    }
    const imported = latestImport([ob.amount.source, ob.date.source]);
    if (imported?.importedAt) {
      const months = cadenceMonths(ob.rule);
      const limit = Math.max(STALE_MIN_DAYS, months ? Math.round(months * 30 * 1.5) : 0);
      const age = daysBetween(imported.importedAt.slice(0, 10), today);
      if (age > limit) {
        out.push({
          id: `stale_source:${ob.id}`,
          kind: 'stale_source',
          title: `${name}: details may be out of date`,
          detail: `Last updated from ${imported.label} ${age} days ago. Import a newer bill or confirm the details.`,
          severity: 'info',
          obligationId: ob.id,
        });
      }
    }
    if (
      !ob.canonicalProvider &&
      ob.amount.source.kind !== 'manual' &&
      ob.date.source.kind !== 'manual'
    ) {
      out.push({
        id: `unknown_merchant:${ob.id}`,
        kind: 'unknown_merchant',
        title: `Who is "${ob.provider || ob.nickname}"?`,
        detail:
          'We could not recognise this merchant from the import. Add a nickname so it is easy to spot.',
        severity: 'info',
        obligationId: ob.id,
      });
    }
  }
  for (const s of findDuplicateSuggestions(data)) {
    out.push({
      id: `duplicate:${s.key}`,
      kind: 'duplicate_suggestion',
      title: 'Possible duplicate',
      detail: `${s.reason}. Merge them or keep both.`,
      severity: 'normal',
      suggestion: s,
    });
  }
  const pending = pendingImports(data);
  if (pending.length) {
    out.push({
      id: 'import_pending',
      kind: 'import_pending',
      title: `${pending.length} import${pending.length === 1 ? '' : 's'} to review`,
      detail: 'Nothing is saved until you approve it.',
      severity: 'normal',
      importItemIds: pending.map((i) => i.id),
    });
  }
  const rank = { important: 0, normal: 1, info: 2 } as const;
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/** Home screen summary. */
export function homeSummary(
  data: AppData,
  today: ISODate,
  tz: string = data.settings?.timezone || DEFAULT_TZ,
): HomeSummary {
  const linked = linkedParentMap(data);
  // Overdue items come first; past occurrences of auto-renewing items are skipped.
  const overdue = forecastObligations(data)
    .map((ob) => ({ ob, occ: effectiveNext(ob, today) }))
    .filter((x): x is Dated => !!x.occ && x.occ.status === 'overdue' && !linked.has(x.ob.id));
  const future = upcomingOccurrences(data, today, addDays(today, 400), today);
  const ordered = [...overdue, ...future];
  const view = (x: Dated) => obligationView(data, x.ob, today, tz, x.occ);
  const in7 = future.filter((x) => x.occ.date <= addDays(today, 6));
  const in30 = future.filter((x) => x.occ.date <= addDays(today, 29));
  const next7 = total(in7);
  const next30 = total(in30);

  // "Covered" only when every item in the next 7 days is marked paid by the user.
  const paid7: number[] = [];
  for (const ob of forecastObligations(data)) {
    if (linked.has(ob.id)) continue;
    for (const o of obligationOccurrences(ob, today, addDays(today, 6), today))
      if (o.status === 'paid') paid7.push(o.amountPaise ?? 0);
  }
  let coveredMessage: string | null = null;
  if (!in7.length && !overdue.length) {
    coveredMessage = paid7.length
      ? `You’re covered for the next 7 days: ${formatINR(paid7.reduce((a, b) => a + b, 0))} already marked paid.`
      : forecastObligations(data).length
        ? 'Nothing due in the next 7 days.'
        : null;
  }
  const headline =
    coveredMessage ??
    (ordered.length
      ? 'Your next commitment is clear.'
      : 'Add your first due item to see what’s next.');
  return {
    next: ordered[0] ? view(ordered[0]) : null,
    next7Total: next7.totalPaise,
    next30Total: next30.totalPaise,
    next7,
    next30,
    needsAttention: needsAttention(data, today),
    timeline: ordered.slice(1, 4).map(view),
    coveredMessage,
    headline,
  };
}

/** Every active obligation as a view, ordered by next date (items without a date last). */
export function obligationViews(data: AppData, today: ISODate, tz = DEFAULT_TZ): ObligationView[] {
  return forecastObligations(data)
    .map((ob) => obligationView(data, ob, today, tz))
    .sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999') || a.id.localeCompare(b.id));
}
