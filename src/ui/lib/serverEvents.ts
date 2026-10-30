import type { UserEvent as ServerUserEvent } from '../../lib/account/types';
import { matchObligation, type ImportItem } from '../../lib/imports';
import type { BillingCycle, UserEvent as LocalUserEvent } from '../../lib/intake';
import { canonicalMerchant } from '../../lib/merchants';
import type { AppData, CommitmentType } from '../../lib/types';

const TYPES: CommitmentType[] = [
  'subscription',
  'emi',
  'other_loan',
  'credit_card',
  'school_fee',
  'bill',
  'other',
];

function cadence(c: string | undefined): BillingCycle | null {
  switch (c) {
    case 'monthly':
    case 'quarterly':
    case 'half_yearly':
      return c;
    case 'yearly':
      return 'annual';
    default:
      return null;
  }
}

export const serverRef = (id: string) => `server:${id}`;

/**
 * Converts one forwarded-email event from the server into a pending local review item.
 * The values are exactly what the server extracted; nothing is filled in.
 */
export function importItemFromServerEvent(
  data: AppData,
  ev: ServerUserEvent,
): { item: ImportItem; userEvent: LocalUserEvent } {
  const f = ev.extractedFields;
  const merchant = f.provider ?? f.service ?? null;
  const date = f.renewalDate ?? f.dueDate ?? f.trialEndDate ?? null;
  const dateKind = f.renewalDate
    ? 'renewal'
    : f.dueDate
      ? 'due'
      : f.trialEndDate
        ? 'trial_end'
        : null;
  const amountPaise =
    typeof f.amountInr === 'number' && Number.isFinite(f.amountInr)
      ? Math.round(f.amountInr * 100)
      : null;
  const conf = ev.confidence ?? {};
  const pick = (...keys: string[]) => keys.map((k) => conf[k]).find((v) => typeof v === 'number');
  const confidencePerField: ImportItem['extracted']['confidencePerField'] = {};
  const cm = pick('provider', 'service');
  if (merchant && cm !== undefined) confidencePerField.merchant = cm;
  const ca = pick('amountInr', 'amount');
  if (amountPaise !== null && ca !== undefined) confidencePerField.amount = ca;
  const cd = pick('renewalDate', 'dueDate', 'trialEndDate');
  if (date && cd !== undefined) confidencePerField.date = cd;
  const link = f.links?.[0] ?? null;
  if (link && conf.links !== undefined) confidencePerField.link = conf.links;
  const type = TYPES.includes(f.commitmentType as CommitmentType)
    ? (f.commitmentType as CommitmentType)
    : null;
  const extracted: ImportItem['extracted'] = {
    merchant,
    canonicalProvider: canonicalMerchant(merchant)?.key ?? null,
    amountPaise,
    date,
    dateKind,
    link,
    commitmentType: type,
    cadence: cadence(f.billingCycle),
    confidencePerField,
  };
  const match = matchObligation(data, extracted);
  const localId = `ue_srv_${ev.id}`;
  const userEvent: LocalUserEvent = {
    id: localId,
    intakeType: 'forwarded_email',
    ...(ev.messageFingerprint ? { messageFingerprint: ev.messageFingerprint } : {}),
    ...(ev.sourceDomain ? { sourceDomain: ev.sourceDomain } : {}),
    extractedFields: { ...f },
    confidence: { ...conf },
    reviewStatus: 'needs_review',
    ...(ev.rawRetentionUntil ? { rawRetentionUntil: ev.rawRetentionUntil } : {}),
    createdAt: ev.createdAt,
  };
  const item: ImportItem = {
    id: `imp_srv_${ev.id}`,
    raw: {
      kind: 'forwarded_email',
      text: ev.rawText ?? null,
      receivedAt: ev.createdAt,
      ref: serverRef(ev.id),
    },
    extracted,
    matchedObligationId: match?.id ?? null,
    matchReason: match?.reason ?? null,
    status: 'pending',
    userEventId: localId,
  };
  return { item, userEvent };
}

/** Server event id behind a local import item, if it came from the server. */
export function serverEventId(item: ImportItem): string | null {
  return item.raw.ref.startsWith('server:') ? item.raw.ref.slice('server:'.length) : null;
}
