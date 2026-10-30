/**
 * Import review queue. Pasted receipts, forwarded emails, documents, shared SMS and CSV rows
 * become ImportItems with extracted fields + per-field confidence. Nothing changes an obligation
 * until the user approves. Raw text is stored redacted and only until its retention date.
 */
import { applyUndo, commit, type MutationContext, type MutationResult } from './audit';
import { previewCSV } from './csv';
import { addDays, addMonthsClamped, formatDate } from './dates';
import { newId } from './ids';
import {
  buildUserEvent,
  extractFromDocumentText,
  type BillingCycle,
  type DocumentExtraction,
  type DocumentKind,
  type IntakeType,
  type UserEvent,
} from './intake';
import { canonicalMerchant, merchantKey } from './merchants';
import { buildObligation } from './mutations';
import { activeObligations, effectiveNext, obligationOccurrences } from './obligations';
import { tracked, withMirrors } from './provenance';
import { rules, type RecurrenceRule } from './recurrence';
import type { Redaction } from './sensitive';
import type { AppData, Commitment, CommitmentType, ISODate, Provenance, SourceKind } from './types';

export type ImportRawKind =
  'receipt_text' | 'csv_row' | 'document' | 'forwarded_email' | 'shared_sms';
export type ImportStatus = 'pending' | 'approved' | 'ignored' | 'edited';
export type ImportField = 'merchant' | 'amount' | 'date' | 'link';

export interface ImportRaw {
  kind: ImportRawKind;
  /** Redacted text. Cleared by `purgeExpiredRaw` after retention. */
  text?: string | null;
  /** CSV row (known columns only). */
  row?: Record<string, string>;
  receivedAt: string;
  /** Stable reference, e.g. "csv:line 3", "paste:…", a file name or message fingerprint. */
  ref: string;
  fileName?: string;
  mimeType?: string;
}

export interface ImportExtracted {
  merchant: string | null;
  canonicalProvider: string | null;
  amountPaise: number | null;
  date: ISODate | null;
  /** What the date means. 'paid' = a past charge (evidence), others are upcoming. */
  dateKind: 'due' | 'renewal' | 'trial_end' | 'paid' | null;
  link: string | null;
  commitmentType: CommitmentType | null;
  cadence: BillingCycle | null;
  /** 0..1; absent = not found. */
  confidencePerField: Partial<Record<ImportField, number>>;
  /** Document classification; 'receipt' marks a payment confirmation. Absent for CSV rows and older items. */
  documentKind?: DocumentKind | null;
}

export interface ImportItem {
  id: string;
  raw: ImportRaw;
  extracted: ImportExtracted;
  /** User edits overlay (applied on approve, marked user-entered). */
  edits?: Partial<
    Pick<
      ImportExtracted,
      'merchant' | 'amountPaise' | 'date' | 'link' | 'commitmentType' | 'cadence'
    >
  >;
  matchedObligationId?: string | null;
  /** Plain-English match logic for "Why this?". */
  matchReason?: string | null;
  status: ImportStatus;
  /** Backing private UserEvent (documents, forwarded email, shared SMS). */
  userEventId?: string | null;
  redactions?: Redaction[];
  resolvedAt?: string | null;
  /** Obligation created/updated on approve. */
  resultObligationId?: string | null;
}

const RAW_TO_INTAKE: Record<ImportRawKind, IntakeType> = {
  receipt_text: 'document',
  csv_row: 'manual',
  document: 'document',
  forwarded_email: 'forwarded_email',
  shared_sms: 'shared_sms',
};

const RAW_TO_SOURCE: Record<ImportRawKind, SourceKind> = {
  receipt_text: 'email_forward',
  csv_row: 'csv',
  document: 'statement',
  forwarded_email: 'email_forward',
  shared_sms: 'email_forward',
};

const RAW_LABEL: Record<ImportRawKind, string> = {
  receipt_text: 'Pasted receipt',
  csv_row: 'CSV import',
  document: 'Uploaded document',
  forwarded_email: 'Forwarded email',
  shared_sms: 'Shared SMS',
};

export function provenanceFor(item: ImportItem): Provenance {
  return {
    kind: RAW_TO_SOURCE[item.raw.kind],
    label: item.raw.fileName
      ? `${RAW_LABEL[item.raw.kind]}: ${item.raw.fileName}`
      : RAW_LABEL[item.raw.kind],
    importedAt: item.raw.receivedAt,
    rawRef: item.id,
  };
}

/** Effective values (edits over extracted). */
export function effectiveFields(item: ImportItem): ImportExtracted {
  const e = item.edits ?? {};
  const merchant = e.merchant !== undefined ? e.merchant : item.extracted.merchant;
  return {
    ...item.extracted,
    ...e,
    merchant,
    canonicalProvider: canonicalMerchant(merchant)?.key ?? null,
  };
}

function extractedFrom(x: DocumentExtraction): ImportExtracted {
  const f = x.fields;
  const dateField = f.renewalDate ?? f.dueDate ?? f.trialEnd ?? f.paidDate;
  const dateKind = f.renewalDate
    ? 'renewal'
    : f.dueDate
      ? 'due'
      : f.trialEnd
        ? 'trial_end'
        : f.paidDate
          ? 'paid'
          : null;
  const amount = f.amount ?? f.emi;
  // For loans the recurring payment is the EMI, not the principal.
  const recurring = f.commitmentType?.value === 'emi' && f.emi ? f.emi : amount;
  const conf: Partial<Record<ImportField, number>> = {};
  if (f.provider) conf.merchant = f.provider.confidence;
  if (recurring) conf.amount = recurring.confidence;
  if (dateField) conf.date = dateField.confidence;
  if (f.link) conf.link = f.link.confidence;
  return {
    merchant: f.provider?.value ?? null,
    canonicalProvider: canonicalMerchant(f.provider?.value)?.key ?? null,
    amountPaise: recurring?.value ?? null,
    date: dateField?.value ?? null,
    dateKind,
    link: f.link?.value ?? null,
    commitmentType: f.commitmentType?.value ?? null,
    cadence: f.billingCycle?.value ?? (f.commitmentType?.value === 'emi' ? 'monthly' : null),
    confidencePerField: conf,
    documentKind: x.documentKind,
  };
}

/**
 * True only for a payment confirmation: a document classified as a receipt, or a date labelled as
 * a payment ("paid on", "payment date"). Only these may mark an occurrence paid.
 */
export function isPaymentConfirmation(item: ImportItem): boolean {
  return item.extracted.documentKind === 'receipt' || effectiveFields(item).dateKind === 'paid';
}

/** Best matching active obligation for an extraction (same canonical merchant). */
export function matchObligation(
  data: AppData,
  ex: Pick<ImportExtracted, 'merchant' | 'amountPaise'>,
): { id: string; reason: string } | null {
  const key = merchantKey(ex.merchant);
  if (!key) return null;
  const cands = activeObligations(data).filter(
    (c) =>
      (c.canonicalProvider ?? merchantKey(c.provider)) === key || merchantKey(c.provider) === key,
  );
  if (!cands.length) return null;
  const exact = cands.find((c) => ex.amountPaise !== null && c.amount.value === ex.amountPaise);
  const pick = exact ?? cands[0];
  const name = canonicalMerchant(ex.merchant)?.displayName ?? ex.merchant;
  return {
    id: pick.id,
    reason: exact
      ? `Same provider (${name}) and same amount as "${pick.nickname || pick.provider}"`
      : `Same provider (${name}) as "${pick.nickname || pick.provider}"; amount differs or is missing`,
  };
}

export interface IntakeInput {
  kind: Exclude<ImportRawKind, 'csv_row'>;
  text: string;
  receivedAt: string;
  ref?: string;
  fileName?: string;
  mimeType?: string;
  sourceDomain?: string;
  retentionDays?: number;
}

/** Builds an ImportItem (+ backing UserEvent) from text. Not stored yet; see `addImportItems`. */
export function importItemFromText(
  data: AppData,
  input: IntakeInput,
): { item: ImportItem; userEvent: UserEvent } {
  const x = extractFromDocumentText(input.text, {
    kind:
      input.kind === 'shared_sms' ? 'sms' : input.kind === 'forwarded_email' ? 'email' : undefined,
    fileName: input.fileName,
    mimeType: input.mimeType,
  });
  const userEvent = buildUserEvent(x, {
    id: newId('ue'),
    intakeType: RAW_TO_INTAKE[input.kind],
    createdAt: input.receivedAt,
    sourceDomain: input.sourceDomain,
    fileName: input.fileName,
    mimeType: input.mimeType,
    retentionDays: input.retentionDays,
  });
  const extracted = extractedFrom(x);
  const match = matchObligation(data, extracted);
  const item: ImportItem = {
    id: newId('imp'),
    raw: {
      kind: input.kind,
      text: x.redactedText,
      receivedAt: input.receivedAt,
      ref: input.ref ?? input.fileName ?? `fp:${userEvent.messageFingerprint}`,
      ...(input.fileName ? { fileName: input.fileName } : {}),
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
    },
    extracted,
    matchedObligationId: match?.id ?? null,
    matchReason: match?.reason ?? null,
    status: 'pending',
    userEventId: userEvent.id,
    redactions: x.redactions,
  };
  return { item, userEvent };
}

/** Pasted receipt text → ImportItem. */
export function importItemFromReceipt(
  data: AppData,
  text: string,
  receivedAt: string,
  ref?: string,
) {
  return importItemFromText(data, { kind: 'receipt_text', text, receivedAt, ref });
}

/** CSV rows → ImportItems (rows with errors are reported, not queued). Reuses csv.ts guards. */
export function importItemsFromCsv(
  data: AppData,
  csvText: string,
  receivedAt: string,
): { items: ImportItem[]; errors: string[] } {
  const p = previewCSV(csvText, activeObligations(data));
  const errors = [...p.fileErrors];
  const items: ImportItem[] = [];
  for (const r of p.rows) {
    if (!r.candidate) {
      errors.push(`Line ${r.line}: ${r.errors.join(' ')}`);
      continue;
    }
    const c = r.candidate;
    const extracted: ImportExtracted = {
      merchant: c.provider,
      canonicalProvider: canonicalMerchant(c.provider)?.key ?? null,
      amountPaise: c.amountPaise,
      date: c.nextDue,
      dateKind: 'due',
      link: null,
      commitmentType: c.type,
      cadence: c.frequency === 'one_time' || c.frequency === 'custom_months' ? null : c.frequency,
      confidencePerField: {
        merchant: 1,
        ...(c.amountPaise !== null ? { amount: 1 } : {}),
        date: 1,
      },
    };
    const match = matchObligation(data, extracted);
    items.push({
      id: newId('imp'),
      raw: {
        kind: 'csv_row',
        row: {
          type: c.type,
          provider: c.provider,
          nickname: c.nickname,
          amount: c.amountPaise === null ? '' : String(c.amountPaise / 100),
          frequency: c.frequency,
          next_due: c.nextDue,
          importance: c.importance,
          notes: c.notes,
        },
        receivedAt,
        ref: `csv:line ${r.line}`,
      },
      extracted,
      matchedObligationId: match?.id ?? null,
      matchReason:
        match?.reason ?? (r.duplicateOf.length ? `Looks like: ${r.duplicateOf.join(', ')}` : null),
      status: 'pending',
      userEventId: null,
    });
  }
  return { items, errors };
}

function isDuplicateFingerprint(data: AppData, ev: UserEvent | undefined): boolean {
  if (!ev?.messageFingerprint) return false;
  return (data.userEvents ?? []).some(
    (u) => u.messageFingerprint === ev.messageFingerprint && u.reviewStatus !== 'deleted',
  );
}

/**
 * Queues items (actor 'import'). Items whose message fingerprint was already received are
 * skipped and reported in `skipped`.
 */
export function addImportItems(
  data: AppData,
  batch: { item: ImportItem; userEvent?: UserEvent }[],
  ctx: MutationContext,
): MutationResult & { skipped: string[] } {
  const skipped: string[] = [];
  const items: ImportItem[] = [];
  const events: UserEvent[] = [];
  let probe = data;
  for (const b of batch) {
    if (isDuplicateFingerprint(probe, b.userEvent)) {
      skipped.push(b.item.raw.ref);
      continue;
    }
    items.push(b.item);
    if (b.userEvent) {
      events.push(b.userEvent);
      probe = { ...probe, userEvents: [...(probe.userEvents ?? []), b.userEvent] };
    }
  }
  const next: AppData = {
    ...data,
    importQueue: [...(data.importQueue ?? []), ...items],
    userEvents: [...(data.userEvents ?? []), ...events],
  };
  const r = commit(
    data,
    next,
    { importQueue: items.map((i) => i.id), userEvents: events.map((e) => e.id) },
    {
      action: 'import_received',
      entity: 'import_item',
      entityId: items[0]?.id ?? 'none',
      summary: `${items.length} item${items.length === 1 ? '' : 's'} added for review`,
    },
    { ...ctx, actor: ctx.actor ?? 'import' },
  );
  return { ...r, skipped };
}

function mustItem(data: AppData, id: string): ImportItem {
  const it = (data.importQueue ?? []).find((i) => i.id === id);
  if (!it) throw new Error(`No import item ${id}`);
  return it;
}

function setUserEventStatus(
  data: AppData,
  id: string | null | undefined,
  status: UserEvent['reviewStatus'],
  extra?: Partial<UserEvent>,
): AppData {
  if (!id) return data;
  return {
    ...data,
    userEvents: (data.userEvents ?? []).map((u) =>
      u.id === id ? { ...u, ...extra, reviewStatus: status } : u,
    ),
  };
}

function putItem(data: AppData, item: ImportItem): AppData {
  return {
    ...data,
    importQueue: (data.importQueue ?? []).map((i) => (i.id === item.id ? item : i)),
  };
}

function refs(item: ImportItem, obligationIds: string[] = []) {
  return {
    importQueue: [item.id],
    ...(item.userEventId ? { userEvents: [item.userEventId] } : {}),
    ...(obligationIds.length ? { commitments: obligationIds } : {}),
  };
}

/** User edits extracted fields. Edited fields become user-entered on approve. */
export function editImportItem(
  data: AppData,
  id: string,
  edits: NonNullable<ImportItem['edits']>,
  ctx: MutationContext,
): MutationResult {
  const item = mustItem(data, id);
  const merged: ImportItem = {
    ...item,
    edits: { ...(item.edits ?? {}), ...edits },
    status: 'edited',
  };
  const eff = effectiveFields(merged);
  const match = matchObligation(data, eff);
  merged.matchedObligationId = match?.id ?? null;
  merged.matchReason = match?.reason ?? null;
  let next = putItem(data, merged);
  next = setUserEventStatus(next, item.userEventId, 'needs_review', {
    extractedFields: {
      ...(data.userEvents ?? []).find((u) => u.id === item.userEventId)?.extractedFields,
      ...editsAsFields(edits),
    },
  });
  return commit(
    data,
    next,
    refs(item),
    {
      action: 'import_edited',
      entity: 'import_item',
      entityId: id,
      summary: 'Edited an imported item',
    },
    ctx,
  );
}

function editsAsFields(e: NonNullable<ImportItem['edits']>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (e.merchant !== undefined) out.provider = e.merchant;
  if (e.amountPaise !== undefined) out.amount = e.amountPaise;
  if (e.date !== undefined) out.dueDate = e.date;
  if (e.link !== undefined) out.link = e.link;
  if (e.commitmentType !== undefined) out.commitmentType = e.commitmentType;
  if (e.cadence !== undefined) out.billingCycle = e.cadence;
  return out;
}

export function ignoreImportItem(data: AppData, id: string, ctx: MutationContext): MutationResult {
  const item = mustItem(data, id);
  let next = putItem(data, { ...item, status: 'ignored', resolvedAt: ctx.now });
  next = setUserEventStatus(next, item.userEventId, 'ignored');
  return commit(
    data,
    next,
    refs(item),
    {
      action: 'import_ignored',
      entity: 'import_item',
      entityId: id,
      summary: 'Ignored an imported item',
    },
    ctx,
  );
}

/**
 * Removes raw text/rows of the given import items from every audit snapshot. Audit events keep
 * full before/after copies of records, so without this a deleted or expired document would
 * survive in the audit log (and in sync uploads and exports).
 */
export function scrubRawFromAudit(data: AppData, itemIds: Iterable<string>): AppData {
  const ids = new Set(itemIds);
  if (!ids.size || !(data.audit ?? []).length) return data;
  let changed = false;
  const scrub = (rec: Record<string, ImportItem | null> | undefined) => {
    if (!rec) return rec;
    let out = rec;
    for (const id of Object.keys(rec)) {
      const it = rec[id];
      if (!ids.has(id) || !it || (it.raw.text == null && it.raw.row === undefined)) continue;
      if (out === rec) out = { ...rec };
      out[id] = { ...it, raw: { ...it.raw, text: null, row: undefined } };
      changed = true;
    }
    return out;
  };
  const audit = (data.audit ?? []).map((e) => {
    const before = scrub(e.before.importQueue);
    const after = scrub(e.after.importQueue);
    if (before === e.before.importQueue && after === e.after.importQueue) return e;
    return {
      ...e,
      before: { ...e.before, importQueue: before },
      after: { ...e.after, importQueue: after },
    };
  });
  return changed ? { ...data, audit } : data;
}

/** Deletes the raw content now (keeps the reviewed fields and the audit trail). */
export function deleteImportRaw(data: AppData, id: string, ctx: MutationContext): MutationResult {
  const r = deleteImportRawUnscrubbed(data, id, ctx);
  const scrubbed = scrubRawFromAudit(r.data, [id]);
  return {
    ...r,
    data: scrubbed,
    undo: () => {
      const u = applyUndo(scrubbed, r.event.id, ctx);
      return u.ok ? u.data : scrubbed;
    },
  };
}

function deleteImportRawUnscrubbed(
  data: AppData,
  id: string,
  ctx: MutationContext,
): MutationResult {
  const item = mustItem(data, id);
  let next = putItem(data, { ...item, raw: { ...item.raw, text: null, row: undefined } });
  if (item.status === 'pending' || item.status === 'edited') {
    next = putItem(next, {
      ...item,
      raw: { ...item.raw, text: null, row: undefined },
      status: 'ignored',
      resolvedAt: ctx.now,
    });
    next = setUserEventStatus(next, item.userEventId, 'deleted');
  }
  return commit(
    data,
    next,
    refs(item),
    {
      action: 'intake_deleted',
      entity: 'import_item',
      entityId: id,
      summary: 'Deleted the imported document',
    },
    ctx,
  );
}

/** Only http(s) links become provider help links (user-edited text could be anything). */
function isWebLink(link: string | null): link is string {
  return !!link && /^https?:\/\/[^\s]+$/i.test(link.trim());
}

function ruleFor(
  date: ISODate,
  cadence: BillingCycle | null,
  dateKind: ImportExtracted['dateKind'],
  amountPaise: number | null,
): RecurrenceRule {
  if (dateKind === 'trial_end')
    return rules.trialToPaid(
      date,
      amountPaise,
      cadence === 'annual' ? rules.annual(date) : rules.monthly(date),
    );
  switch (cadence) {
    case 'monthly':
      return rules.monthly(date);
    case 'quarterly':
      return rules.quarterly(date);
    case 'half_yearly':
      return rules.halfYearly(date);
    case 'annual':
      return rules.annual(date);
    default:
      // Unknown cadence: never invent a schedule.
      return rules.irregular(date);
  }
}

function stepFor(cadence: BillingCycle): number {
  return { monthly: 1, quarterly: 3, half_yearly: 6, annual: 12 }[cadence];
}

/**
 * Approves an item.
 * - Matched (or `targetId` given): updates that obligation. Amount → 'imported' with this
 *   provenance (or 'user_entered' if the user edited it). An upcoming date that lands within
 *   7 days of a scheduled occurrence moves only that occurrence (override). A past date marks the
 *   occurrence paid only when the item is a payment confirmation (`isPaymentConfirmation`); a bill
 *   or notice with a past date sets `overdueReview` instead (Home: 'overdue_review'). The rule is
 *   never rewritten.
 * - Otherwise creates a new obligation with provenance 'imported'.
 * The item keeps its raw provenance; the UserEvent becomes 'confirmed'.
 */
export function approveImportItem(
  data: AppData,
  id: string,
  ctx: MutationContext & { today: ISODate },
  opts: { targetId?: string | null; createNew?: boolean; type?: CommitmentType } = {},
): MutationResult {
  const item = mustItem(data, id);
  if (item.status === 'approved' || item.status === 'ignored')
    throw new Error('This item has already been handled.');
  const f = effectiveFields(item);
  const edited = item.edits ?? {};
  const source = provenanceFor(item);
  const conf = (field: keyof typeof edited) =>
    edited[field] !== undefined ? ('user_entered' as const) : ('imported' as const);
  const targetId = opts.createNew ? null : (opts.targetId ?? item.matchedObligationId ?? null);
  const target = targetId ? activeObligations(data).find((c) => c.id === targetId) : undefined;
  let next = data;
  let obligationId: string;
  let summary: string;

  if (target) {
    let ob: Commitment = { ...target };
    if (f.amountPaise !== null)
      ob.amount = tracked(f.amountPaise, conf('amountPaise'), source, ctx.now);
    if (f.amountPaise !== null && ob.rule.kind === 'trial_to_paid')
      ob.rule = { ...ob.rule, paidAmountPaise: f.amountPaise };
    if (isWebLink(f.link) && !ob.subscription?.helpUrl && ob.type === 'subscription')
      ob.subscription = { ...ob.subscription, helpUrl: f.link };
    if (f.date) {
      if (f.dateKind === 'paid' || f.date < ctx.today) {
        const occ = obligationOccurrences(
          ob,
          addDays(f.date, -7),
          addDays(f.date, 7),
          ctx.today,
        )[0];
        if (!isPaymentConfirmation(item)) {
          // A bill or notice with a past date is not proof of payment: ask the person instead.
          ob.overdueReview = {
            occurrenceDate: occ?.occurrenceDate ?? f.date,
            date: f.date,
            sourceLabel: source.label,
            importItemId: item.id,
            at: ctx.now,
          };
        } else if (occ) {
          ob.history = [
            ...ob.history,
            {
              id: newId('h'),
              occurrenceDate: occ.occurrenceDate,
              kind: 'paid',
              at: ctx.now,
              actor: 'import',
              amountPaise: f.amountPaise ?? occ.amountPaise,
              evidenceRef: item.id,
            },
          ];
        }
      } else {
        const near =
          obligationOccurrences(ob, addDays(f.date, -7), addDays(f.date, 7), ctx.today)[0] ??
          effectiveNext(ob, ctx.today);
        if (
          near &&
          near.date !== f.date &&
          Math.abs(Date.parse(near.occurrenceDate) - Date.parse(f.date)) <= 7 * 86_400_000
        ) {
          ob.overrides = [
            ...ob.overrides.filter((o) => o.occurrenceDate !== near.occurrenceDate),
            {
              id: newId('o'),
              occurrenceDate: near.occurrenceDate,
              newDate: f.date,
              reason: `From ${source.label}`,
              at: ctx.now,
              confidence: conf('date'),
              source,
            },
          ];
        } else if (ob.rule.kind === 'irregular') {
          ob.rule = rules.irregular(f.date);
          ob.date = tracked(f.date, conf('date'), source, ctx.now);
        }
      }
    }
    ob = { ...ob, updatedAt: ctx.now };
    next = {
      ...next,
      commitments: next.commitments.map((c) => (c.id === ob.id ? withMirrors(ob) : c)),
    };
    obligationId = ob.id;
    summary = `Updated ${ob.nickname || ob.provider} from ${source.label}`;
  } else {
    if (!f.merchant) throw new Error('Add who this is with before approving.');
    const date = f.date && !(f.dateKind === 'paid' && !f.cadence) ? f.date : null;
    let rule: RecurrenceRule;
    if (!date) rule = rules.irregular(null);
    else if (f.dateKind === 'paid' && f.cadence) {
      // A past charge with a known cadence: the next one follows it.
      let d = date;
      const step = stepFor(f.cadence);
      for (let i = 0; i < 400 && d < ctx.today; i++) d = addMonthsClamped(date, step * (i + 1));
      rule = ruleFor(d, f.cadence, 'renewal', f.amountPaise);
    } else rule = ruleFor(date, f.cadence, f.dateKind, f.amountPaise);
    const ob = buildObligation(
      {
        type:
          opts.type ?? f.commitmentType ?? (f.dateKind === 'trial_end' ? 'subscription' : 'other'),
        provider: canonicalMerchant(f.merchant)?.displayName ?? f.merchant,
        nickname: item.raw.row?.nickname || f.merchant,
        amountPaise: f.amountPaise,
        rule,
        amountConfidence: conf('amountPaise'),
        dateConfidence: conf('date'),
        source,
      },
      ctx.now,
    );
    if (isWebLink(f.link) && ob.type === 'subscription') ob.subscription = { helpUrl: f.link };
    if (date && date < ctx.today && !isPaymentConfirmation(item))
      ob.overdueReview = {
        occurrenceDate: date,
        date,
        sourceLabel: source.label,
        importItemId: item.id,
        at: ctx.now,
      };
    next = { ...next, commitments: [...next.commitments, ob] };
    obligationId = ob.id;
    summary = `Added ${ob.nickname || ob.provider} from ${source.label}`;
  }
  next = putItem(next, {
    ...item,
    status: 'approved',
    resolvedAt: ctx.now,
    resultObligationId: obligationId,
  });
  next = setUserEventStatus(next, item.userEventId, 'confirmed');
  return commit(
    data,
    next,
    refs(item, [obligationId]),
    { action: 'import_approved', entity: 'import_item', entityId: id, summary },
    ctx,
  );
}

/** Pending/edited items, oldest first. */
export function pendingImports(data: Pick<AppData, 'importQueue'>): ImportItem[] {
  return (data.importQueue ?? []).filter((i) => i.status === 'pending' || i.status === 'edited');
}

/** Clears raw text of items whose backing UserEvent retention has passed (not audited: housekeeping). */
export function purgeExpiredRaw(data: AppData, now: string): AppData {
  const expired = new Set(
    (data.userEvents ?? [])
      .filter((u) => u.rawRetentionUntil && u.rawRetentionUntil <= now)
      .map((u) => u.id),
  );
  if (!expired.size) return data;
  let changed = false;
  const importQueue = (data.importQueue ?? []).map((i) => {
    if (i.userEventId && expired.has(i.userEventId) && i.raw.text) {
      changed = true;
      return { ...i, raw: { ...i.raw, text: null } };
    }
    return i;
  });
  const purged = importQueue
    .filter((i) => i.userEventId && expired.has(i.userEventId))
    .map((i) => i.id);
  return scrubRawFromAudit(changed ? { ...data, importQueue } : data, purged);
}

/** Plain-English summary of an item's fields, for lists. */
export function describeImportItem(item: ImportItem): string {
  const f = effectiveFields(item);
  const parts = [f.merchant ?? 'Unknown merchant'];
  if (f.amountPaise !== null) parts.push(`₹${(f.amountPaise / 100).toLocaleString('en-IN')}`);
  if (f.date) parts.push(formatDate(f.date));
  return parts.join(' · ');
}
