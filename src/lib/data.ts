import { DEFAULT_BUDGET } from './budget';
import type { ImportCandidate } from './csv';
import { DEFAULT_OFFSETS } from './reminders';
import { emptyRelay } from './offers/relay';

/** Migrations a freshly created dataset never needs. Keep in sync with migrate.ts. */
export const CURRENT_MIGRATIONS = ['drop-bundled-examples-v1'] as const;
import { newId } from './ids';
import { canonicalMerchant } from './merchants';
import { todayInTz } from './dates';
import { effectiveNext } from './obligations';
import { reconcileObligation, withMirrors, manualV2Fields } from './provenance';
import type { AppData, Commitment, CommitmentLink, Season, BillingEmailLabel } from './types';

export { newId };

export function emptyData(): AppData {
  return {
    version: 2,
    commitments: [],
    links: [],
    budget: { ...DEFAULT_BUDGET },
    seasons: [],
    labels: [],
    settings: {
      timezone: 'Asia/Kolkata',
      channel: 'in_app',
      quietHours: { start: '22:00', end: '07:00' },
      defaultOffsets: [...DEFAULT_OFFSETS],
      consents: { storeLocally: true, acknowledgedEstimates: false },
    },
    actionLog: [],
    deliveryLog: [],
    services: [],
    offerReminders: [],
    relay: emptyRelay(),
    migrations: [...CURRENT_MIGRATIONS],
    audit: [],
    importQueue: [],
    userEvents: [],
    duplicateDecisions: [],
    reminderStates: [],
  };
}

export function blankCommitment(type: Commitment['type'], now: string): Commitment {
  const stamp = new Date().toISOString();
  const base: Commitment = {
    id: newId('c'),
    type,
    provider: '',
    nickname: '',
    amountPaise: null,
    currency: 'INR',
    frequency: type === 'credit_card' ? 'one_time' : 'monthly',
    intervalMonths: null,
    nextDue: now,
    dueConfidence: 'estimate',
    amountConfidence: 'estimate',
    remainingOccurrences: null,
    rail: 'unknown',
    accountNickname: '',
    ownerLabel: '',
    importance: type === 'subscription' ? 'optional' : 'essential',
    notes: '',
    lastConfirmed: null,
    reminder: { enabled: true, offsets: [...DEFAULT_OFFSETS] },
    status: 'active',
    billingEmailLabelId: null,
    subscription: type === 'subscription' ? {} : undefined,
    loan: type === 'emi' || type === 'other_loan' ? {} : undefined,
    statement:
      type === 'credit_card' ? { cardNickname: '', confirmedFromLatest: false } : undefined,
    source: 'manual',
    createdAt: stamp,
    updatedAt: stamp,
    canonicalProvider: null,
    ...manualV2Fields(now, null, stamp, 'estimated'),
  };
  if (type === 'credit_card') base.rule = { kind: 'one_time', start: now };
  return withMirrors(base);
}

/**
 * Legacy upsert (older screens). Edits to the v1 flat fields are reconciled into the v2
 * tracked fields. Not audited; new code should use mutations.ts.
 */
export function upsertCommitment(data: AppData, c: Commitment): AppData {
  const exists = data.commitments.some((x) => x.id === c.id);
  const rec = reconcileObligation(c);
  const next = withMirrors({
    ...rec,
    canonicalProvider: canonicalMerchant(rec.provider)?.key ?? null,
    updatedAt: new Date().toISOString(),
  });
  return {
    ...data,
    commitments: exists
      ? data.commitments.map((x) => (x.id === c.id ? next : x))
      : [...data.commitments, next],
  };
}

export function deleteCommitment(data: AppData, id: string): AppData {
  return {
    ...data,
    commitments: data.commitments.filter((c) => c.id !== id),
    links: data.links.filter((l) => l.parentId !== id && l.componentId !== id),
    seasons: data.seasons.map((s) => ({
      ...s,
      linkedCommitmentIds: s.linkedCommitmentIds.filter((x) => x !== id),
    })),
    actionLog: data.actionLog.filter((a) => a.commitmentId !== id),
    deliveryLog: data.deliveryLog.filter((d) => !d.key.startsWith(`${id}:`)),
  };
}

/** Replace the link for a component (a component belongs to at most one statement). */
export function setStatementLink(
  data: AppData,
  componentId: string,
  parentId: string | null,
): AppData {
  const rest = data.links.filter((l) => l.componentId !== componentId);
  if (!parentId) return { ...data, links: rest };
  const link: CommitmentLink = {
    id: newId('l'),
    parentId,
    componentId,
    relation: 'included_in_statement',
    confirmedByUser: true,
  };
  return { ...data, links: [...rest, link] };
}

export function setStatus(data: AppData, id: string, status: Commitment['status']): AppData {
  const c = data.commitments.find((x) => x.id === id);
  if (!c) return data;
  const withStatus = upsertCommitment(data, { ...c, status });
  return {
    ...withStatus,
    actionLog: [
      ...withStatus.actionLog,
      {
        id: newId('a'),
        commitmentId: id,
        action: `status set to ${status}`,
        confirmationSource: 'user_entered',
        at: new Date().toISOString(),
      },
    ],
  };
}

export function upsertSeason(data: AppData, s: Season): AppData {
  const exists = data.seasons.some((x) => x.id === s.id);
  return {
    ...data,
    seasons: exists ? data.seasons.map((x) => (x.id === s.id ? s : x)) : [...data.seasons, s],
  };
}

export function deleteSeason(data: AppData, id: string): AppData {
  return { ...data, seasons: data.seasons.filter((s) => s.id !== id) };
}

export function upsertLabel(data: AppData, l: BillingEmailLabel): AppData {
  const exists = data.labels.some((x) => x.id === l.id);
  return {
    ...data,
    labels: exists ? data.labels.map((x) => (x.id === l.id ? l : x)) : [...data.labels, l],
  };
}

export function deleteLabel(data: AppData, id: string): AppData {
  return {
    ...data,
    labels: data.labels.filter((l) => l.id !== id),
    commitments: data.commitments.map((c) =>
      c.billingEmailLabelId === id ? { ...c, billingEmailLabelId: null } : c,
    ),
  };
}

/** Confirmed CSV rows become manual-style commitments. Only rows the user ticked are added. */
export function importCandidates(
  data: AppData,
  candidates: ImportCandidate[],
  today: string,
): AppData {
  let next = data;
  for (const cand of candidates) {
    const base = blankCommitment(cand.type, today);
    next = upsertCommitment(next, {
      ...base,
      provider: cand.provider,
      nickname: cand.nickname,
      amountPaise: cand.amountPaise,
      frequency: cand.type === 'credit_card' ? 'one_time' : cand.frequency,
      nextDue: cand.nextDue,
      importance: cand.importance,
      notes: cand.notes,
      amountConfidence: cand.amountPaise === null ? 'unknown' : 'estimate',
      source: 'csv_import',
    });
  }
  return next;
}

export function exportJSON(data: AppData): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      note: 'All amounts are in paise. Statuses are user-entered.',
      data,
    },
    null,
    2,
  );
}

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v);
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s; // avoid spreadsheet formula injection
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/**
 * CSV of the user's live items. Soft-deleted items are left out, and next_due is the item's
 * effective next occurrence on `today` (the stored `nextDue` is only the schedule's anchor).
 */
export function exportCSV(
  data: AppData,
  today: string = todayInTz(data.settings?.timezone || undefined),
): string {
  const head = [
    'type',
    'provider',
    'nickname',
    'amount_rupees',
    'frequency',
    'next_due',
    'importance',
    'status',
    'notes',
  ];
  const lines = [head.join(',')];
  for (const c of data.commitments) {
    if (c.deletedAt) continue;
    lines.push(
      [
        c.type,
        c.provider,
        c.nickname,
        c.amountPaise === null ? '' : (c.amountPaise / 100).toFixed(2),
        c.frequency,
        effectiveNext(c, today)?.date ?? c.nextDue,
        c.importance,
        c.status,
        c.notes,
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** Account deletion: returns a fresh empty dataset. The caller also clears local storage. */
export function deleteAllData(): AppData {
  return emptyData();
}

export type IntegrationId = 'email_forward' | 'whatsapp_business' | 'sms' | 'account_aggregator';

/** Withdrawing consent for a (future) integration never touches manual entries. */
export function withdrawIntegration(data: AppData, _id: IntegrationId): AppData {
  void _id;
  return { ...data };
}
