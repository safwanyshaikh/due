/**
 * Event-based retention items. Each returns null when there is nothing real to say, so the
 * app never sends a message just to increase opens. Summaries use only recorded user events;
 * "saved" counts only amounts of items the user confirmed as cancelled.
 */
import { addDays, monthPeriod, parseISO } from './dates';
import { needsAttention, upcomingOccurrences, type AttentionItem } from './home';
import { formatINR } from './money';
import { activeObligations, liveHistory } from './obligations';
import type { AppData, ISODate } from './types';

export interface WeeklyDigest {
  kind: 'weekly_digest';
  weekStart: ISODate;
  weekEnd: ISODate;
  items: { obligationId: string; name: string; date: ISODate; amountPaise: number | null }[];
  totalPaise: number;
  unknownAmountCount: number;
  attentionCount: number;
  text: string;
}

/** Next 7 days digest; null when nothing is due and nothing needs attention. */
export function weeklyDigest(data: AppData, today: ISODate): WeeklyDigest | null {
  const end = addDays(today, 6);
  const occ = upcomingOccurrences(data, today, end, today);
  const attention = needsAttention(data, today);
  if (!occ.length && !attention.length) return null;
  const items = occ.map(({ ob, occ: o }) => ({
    obligationId: ob.id,
    name: ob.nickname || ob.provider,
    date: o.date,
    amountPaise: o.amountPaise,
  }));
  const totalPaise = items.reduce((a, i) => a + (i.amountPaise ?? 0), 0);
  const unknownAmountCount = items.filter((i) => i.amountPaise === null).length;
  const parts: string[] = [];
  parts.push(
    items.length
      ? `${items.length} item${items.length === 1 ? '' : 's'} due this week, ${formatINR(totalPaise)}${unknownAmountCount ? ` plus ${unknownAmountCount} without an amount` : ''}.`
      : 'Nothing due this week.',
  );
  if (attention.length)
    parts.push(`${attention.length} thing${attention.length === 1 ? '' : 's'} to review.`);
  return {
    kind: 'weekly_digest',
    weekStart: today,
    weekEnd: end,
    items,
    totalPaise,
    unknownAmountCount,
    attentionCount: attention.length,
    text: parts.join(' '),
  };
}

export interface RetentionAlert {
  kind: 'trial_expiry' | 'amount_change' | 'date_change' | 'stale_source';
  key: string;
  obligationId?: string;
  title: string;
  detail: string;
}

/** Trial-expiry, amount/date-change and stale-source alerts derived from real state. */
export function retentionAlerts(data: AppData, today: ISODate): RetentionAlert[] {
  const map: Partial<Record<AttentionItem['kind'], RetentionAlert['kind']>> = {
    trial_ending: 'trial_expiry',
    amount_changed: 'amount_change',
    date_changed: 'date_change',
    stale_source: 'stale_source',
  };
  return needsAttention(data, today).flatMap((a) => {
    const kind = map[a.kind];
    return kind
      ? [{ kind, key: a.id, obligationId: a.obligationId, title: a.title, detail: a.detail }]
      : [];
  });
}

export interface MonthlySummary {
  kind: 'monthly_summary';
  month: string; // YYYY-MM
  /** Occurrences the user marked paid this month. */
  coveredCount: number;
  coveredPaise: number;
  /** Items the user reviewed this month. */
  reviewedCount: number;
  /** Changes caught before the date: approved import changes + acknowledged change alerts + trial decisions. */
  avoidedSurprises: number;
  /** Only from user-confirmed cancellations with a known amount. */
  savedPaise: number;
  savedItems: string[];
  text: string;
}

/** Monthly "covered / saved / avoided surprises"; null when the month has no recorded events. */
export function monthlySummary(data: AppData, year: number, month: number): MonthlySummary | null {
  const p = monthPeriod(year, month);
  const inMonth = (iso: string) => iso.slice(0, 10) >= p.start && iso.slice(0, 10) <= p.end;
  let coveredCount = 0;
  let coveredPaise = 0;
  let reviewedCount = 0;
  for (const ob of activeObligations(data)) {
    for (const e of liveHistory(ob)) {
      if (!inMonth(e.at)) continue;
      if (e.kind === 'paid') {
        coveredCount++;
        coveredPaise += e.amountPaise ?? 0;
      } else if (e.kind === 'reviewed') reviewedCount++;
    }
  }
  const audit = data.audit ?? [];
  const undone = new Set(audit.filter((e) => e.undoOf).map((e) => e.undoOf));
  const live = audit.filter((e) => !undone.has(e.id) && e.action !== 'undo' && inMonth(e.at));
  const avoidedSurprises = live.filter(
    (e) =>
      e.action === 'acknowledge_change' ||
      (e.action === 'import_approved' &&
        Object.values(e.before.commitments ?? {}).some((c) => c !== null)),
  ).length;
  const savedItems: string[] = [];
  let savedPaise = 0;
  const seen = new Set<string>();
  const cancelled = (id: string) => {
    const ob = data.commitments.find((c) => c.id === id);
    if (!ob || seen.has(id) || ob.status !== 'cancelled_confirmed_by_user') return;
    seen.add(id);
    const amt = ob.amount?.value ?? ob.amountPaise;
    if (amt === null || amt === undefined) return;
    savedPaise += amt;
    savedItems.push(ob.nickname || ob.provider);
  };
  for (const e of live)
    if (
      e.action === 'status_changed' &&
      // Compacted (old) events keep no payload; `cancelled` still checks the item's current status.
      (e.compacted || e.after.commitments?.[e.entityId]?.status === 'cancelled_confirmed_by_user')
    )
      cancelled(e.entityId);
  for (const a of data.actionLog)
    if (inMonth(a.at) && a.action === 'status set to cancelled_confirmed_by_user')
      cancelled(a.commitmentId);
  if (!coveredCount && !reviewedCount && !avoidedSurprises && !savedItems.length) return null;
  const parts: string[] = [];
  if (coveredCount)
    parts.push(
      `You covered ${coveredCount} payment${coveredCount === 1 ? '' : 's'} (${formatINR(coveredPaise)}).`,
    );
  if (avoidedSurprises)
    parts.push(
      `${avoidedSurprises} change${avoidedSurprises === 1 ? '' : 's'} caught before the date.`,
    );
  if (savedItems.length)
    parts.push(
      `${formatINR(savedPaise)} per charge no longer due after you cancelled ${savedItems.join(', ')}.`,
    );
  if (reviewedCount && !parts.length)
    parts.push(`You reviewed ${reviewedCount} item${reviewedCount === 1 ? '' : 's'}.`);
  const { y, m } = parseISO(p.start);
  return {
    kind: 'monthly_summary',
    month: `${y}-${String(m).padStart(2, '0')}`,
    coveredCount,
    coveredPaise,
    reviewedCount,
    avoidedSurprises,
    savedPaise,
    savedItems,
    text: parts.join(' '),
  };
}
