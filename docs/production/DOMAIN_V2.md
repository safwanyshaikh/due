# Due domain layer v2 (`src/lib`)

This is the API the UI builds on. Everything here is a pure TypeScript function: no React, no network, no globals except the local telemetry queue. Dates are `ISODate` strings (`YYYY-MM-DD`) read in the user's timezone (default `Asia/Kolkata`). Amounts are integer **paise**.

`src/lib/account/` belongs to the server/auth agent. It is not part of this document.

## Contents

1. [Data model and migration](#1-data-model-and-migration)
2. [Recurrence engine](#2-recurrence-engine-recurrencets)
3. [Obligations: occurrences, overrides, history](#3-obligations-occurrences-overrides-history-obligationsts)
4. [Mutations, audit and undo](#4-mutations-audit-and-undo-mutationsts-auditts)
5. [Home selectors](#5-home-selectors-homets)
6. [Merchants and duplicates](#6-merchant-aliases-and-duplicate-suggestions)
7. [Intake and the import review queue](#7-intake-and-the-import-review-queue)
8. [Reminders v2 and retention](#8-reminders-v2-and-retention)
9. [Plans and entitlements](#9-plans-and-entitlements-plansts)
10. [Telemetry](#10-telemetry-telemetryts)
11. [Compatibility notes for the current UI](#11-compatibility-notes)

Conventions:

- Every mutation takes `ctx: MutationContext = { now: ISO timestamp, actor?: 'user'|'import'|'system' }`. Occurrence actions also need `today: ISODate`. Each returns `MutationResult = { data, event, undo }`.
- `undo()` is pure. It returns new data with the change reversed and an `'undo'` audit event added. Use it for the 6-second Undo toast.
- Mutations throw `MutationError` (or `Error` in the import and duplicate modules) when an id is unknown or input is invalid. Show the message to the user as it is.

---

## 1. Data model and migration

`types.ts`

```ts
type ValueConfidence = 'confirmed' | 'estimated' | 'user_entered' | 'imported';
type SourceKind = 'manual' | 'csv' | 'email_forward' | 'statement' | 'calendar';
interface Provenance { kind: SourceKind; label: string; importedAt?: string; rawRef?: string }
interface Tracked<T> { value: T; confidence: ValueConfidence; source: Provenance; updatedAt: string }

interface Commitment /* alias: Obligation */ {
  // v1 fields are unchanged and kept as mirrors (see §11):
  id, type, provider, nickname /* merchant nickname */, ownerLabel, rail, reminder, status, ...
  // v2 (authoritative)
  canonicalProvider?: string | null;      // alias key, e.g. 'netflix'
  amount: Tracked<number | null>;
  date: Tracked<ISODate>;                 // schedule anchor + its provenance
  rule: RecurrenceRule;
  overrides: OccurrenceOverride[];        // one-off date/amount changes
  history: OccurrenceEvent[];             // append-only paid/reviewed/snoozed/revoked
  pendingChanges?: PendingChange[];       // import/sync changes the user hasn't reviewed
  deletedAt?: string | null;              // soft delete
  mergedInto?: string | null;
}
interface ReminderPrefs { enabled; offsets /* lead days */; severity?; channel?; time? /* HH:MM */ }

interface AppData {           // version: 2
  ...v1 collections,
  audit: AuditEvent[]; importQueue: ImportItem[]; userEvents: UserEvent[];
  duplicateDecisions: DuplicateDecision[]; reminderStates: ReminderState[];
}
```

**Migration (`migrate.ts`, `storage.ts`).** `loadData()` accepts version 1 or 2 under the same storage key (`payables-planner:v1`) and always returns version 2. `loadDataResult()` tells `empty` from `corrupt`: unreadable saved data is copied unchanged to `due:corrupt-backup:<ISO time>` (`backupCorrupt`, once per blob) before anything else is saved; the app shows a banner to export or remove the copy, and automatic sync stays paused until it is removed. If the copy cannot be written, the app does not save at all (so the original is never overwritten).

- `migrateV1toV2(v1): AppData` is lossless. Every v1 field is kept exactly as it was, and v2 fields are added alongside:
  - confidence: `'confirmed'` → `'confirmed'`. `'estimate'` and `'unknown'` → `'estimated'`, or `'imported'` for CSV rows.
  - source: `'manual'` → `{kind:'manual'}`, `'csv_import'` → `{kind:'csv', importedAt: createdAt}`.
  - frequency → `rule` (`remainingOccurrences` → `rule.count`).
- `downgradeToV1(v2): AppDataV1` removes the v2 fields again. `downgradeToV1(migrateV1toV2(x))` deep-equals `x`; there is a test for this.
- `migrateData(parsed)` fills defaults, runs the one-time demo cleanup, then upgrades to v2. It is idempotent.

`provenance.ts`: `tracked(value, confidence, source, at)`, `manualSource()`, `SOURCE_LABELS`, `CONFIDENCE_LABELS`, `reconcileObligation(c)`, `withMirrors(c)`, `upgradeCommitment(c)`, `ruleFromLegacy(c)`.

## 2. Recurrence engine (`recurrence.ts`)

```ts
type RecurrenceRule =
  | { kind: 'one_time'; start }
  | { kind: 'monthly'; start; dayOfMonth; count?; until? }
  | { kind: 'quarterly' | 'half_yearly'; start; dayOfMonth? ; count?; until? }
  | { kind: 'annual'; start; month; day; count?; until? }
  | { kind: 'end_of_month'; start; intervalMonths? }
  | { kind: 'weekday'; start; weekday: 0..6; nth?: 1|2|3|4|-1; intervalMonths?; everyWeeks? }
  | { kind: 'custom_months'; start; intervalMonths; dayOfMonth? }
  | { kind: 'trial_to_paid'; trialEnd; paid: PaidRule; paidAmountPaise: number | null }
  | { kind: 'irregular'; nextDate: ISODate | null };   // never generates a date by itself

nextOccurrences(rule, from: ISODate, count: number): RuleOccurrence[]   // date >= from
occurrencesBetween(rule, start, end): RuleOccurrence[]                  // inclusive
previousOccurrence(rule, before): RuleOccurrence | null
describeRule(rule): string
ruleAnchor(rule), cadenceMonths(rule), isAdvancedRule(rule), validateRule(rule): string[]
rules.{oneTime, monthly, quarterly, halfYearly, annual, endOfMonth, nthWeekday, everyWeeks, customMonths, trialToPaid, irregular}
```

`RuleOccurrence = { date, seq, amountPaise?, phase? }`. Only `trial_to_paid` sets `amountPaise`.

How dates are generated:

- The k-th date is always computed from the anchor, never from the previous date. So 31 Jan → 28/29 Feb → **31 Mar**; the day does not drift down to the 28th.
- 29 Feb in an annual rule falls on 28 Feb in non-leap years.
- A trial produces no charge before `trialEnd`.

```ts
describeRule(rules.monthly('2026-01-31'))         // "Every month on the 31st (last day in shorter months)"
describeRule(rules.nthWeekday('2026-10-01', -1, 5)) // "Last Friday of every month"
describeRule(rules.trialToPaid('2026-11-12', 195000)) // "Trial ends 12 Nov, then ₹1,950 every month"
describeRule(rules.everyWeeks('2026-10-30', 2))   // "Every 2 weeks on Friday"
describeRule(rules.irregular())                   // "No fixed schedule. Add the next date when you know it"
nextOccurrences(rules.monthly('2027-01-31'), '2027-01-01', 3).map(o => o.date)
// ['2027-01-31', '2027-02-28', '2027-03-31']
```

## 3. Obligations: occurrences, overrides, history (`obligations.ts`)

```ts
activeObligations(data): Commitment[]        // not soft-deleted, reconciled
forecastObligations(data): Commitment[]      // also excludes confirmed cancelled/paused
findObligation(data, id): Commitment | null
obligationOccurrences(ob, start, end, today?): ObligationOccurrence[]
effectiveNext(ob, today): ObligationOccurrence | null
lastOccurrence(ob, today), liveHistory(ob), overrideFor(ob, occurrenceDate)

interface ObligationOccurrence {
  obligationId; occurrenceDate /* original = identity */; date /* effective */;
  amountPaise; amountConfidence; dateConfidence; amountSource; dateSource;
  override: OccurrenceOverride | null;
  status: 'upcoming' | 'due_today' | 'overdue' | 'paid' | 'snoozed' | 'reviewed';
  snoozedUntil; paidEvent; reviewedEvent;
}
```

`effectiveNext` returns:

1. the first unpaid occurrence dated today or later; otherwise
2. for one-time or irregular items, and for items the user marked overdue, the latest unpaid past occurrence (status `'overdue'`).

Past dates of auto-renewing items are **not** called overdue.

An override applies to one occurrence, identified by its original date. The rule and the other occurrences stay the same. History is never deleted: undoing a paid mark appends a `'revoked'` event instead.

## 4. Mutations, audit and undo (`mutations.ts`, `audit.ts`)

```ts
createObligation(data, draft: ObligationDraft, ctx)
updateObligation(data, id, patch /* nickname, provider, ownerLabel, rail, notes, importance, reminder, ... */, ctx)
editSchedule(data, id, rule, ctx, confidence?)
markPaid(data, id, ctx & {today}, occurrenceDate?, note?)
markReviewed(data, id, ctx & {today}, occurrenceDate?)      // also clears pendingChanges
snooze(data, id, until: ISODate, ctx & {today}, occurrenceDate?)
editNextDate(data, id, newDate, ctx & {today}, { occurrenceDate?, reason?, confidence?, source? })
editAmount(data, id, amountPaise | null, ctx & {today}, { scope: 'next' | 'all', ... })
setObligationStatus(data, id, status, ctx)
deleteObligation(data, id, ctx) / restoreObligation(data, id, ctx)   // soft delete
recordExternalChange(data, id, {field:'amount',to} | {field:'date',to}, source, ctx & {today})
acknowledgeChanges(data, id, ctx)
buildObligation(draft, now)   // record only, not stored

// audit.ts
interface AuditEvent { id, at, action, entity, entityId, before: Patch, after: Patch, actor, summary, undoOf? }
applyUndo(data, eventId, ctx): { ok: true, data, event } | { ok: false, reason: 'not_found'|'already_undone'|'is_undo'|'changed_since'|'expired' }
canUndo(data, eventId, now?), auditFor(data, entityId) /* newest first */, undoneEventIds(data)
compactAudit(data, now)   // bounds the log; runs inside every commit/undo and on load
UNDO_WINDOW_MS (24 h), AUDIT_KEEP_RECENT (1,000), AUDIT_PAYLOAD_DAYS (30), AUDIT_PAYLOAD_KEEP (300)
```

Example:

```ts
const ctx = { now: new Date().toISOString(), today: todayInTz(tz) };
const r = editNextDate(data, id, '2026-12-08', ctx, { reason: 'Bank holiday' });
setData(r.data);
showToast(r.event.summary, { undo: () => setData(r.undo()) });   // "Moved Netflix from 5 Dec 2026 to 8 Dec 2026"
```

Undo refuses with `changed_since` if the same record changed after the event; the later change has to be undone first. `auditFor(data, id)` feeds the per-item "corrections" list.

**Undo window and compaction.** Undo is allowed only for events younger than 24 hours (`expired` otherwise). The UI offers it only in the 8-second toast; the corrections list is read-only. Because old events can no longer be undone, `compactAudit` keeps the most recent 1,000 events plus each obligation's latest event and drops the rest. Kept events older than 30 days, and events beyond the newest 300, keep only their summary: `before`/`after` become `{}` and `compacted: true` (never undoable). Payloads hold whole records (~2–3 KB each), so this keeps the synced document under the 2 MB server limit (tested with 5,000 events). The monthly summary treats a compacted `status_changed` event by the item's current status.

## 5. Home selectors (`home.ts`)

```ts
homeSummary(data, today, tz?): {
  next: ObligationView | null;
  next7Total: number; next30Total: number;          // paise; unpaid; card components excluded
  next7: TotalDetail; next30: TotalDetail;          // { totalPaise, count, unknownAmountCount, estimatedCount }
  needsAttention: AttentionItem[];                  // important first
  timeline: ObligationView[];                       // the 3 occurrences after `next`, by date
  coveredMessage: string | null; headline: string;
}
obligationView(data, ob, today, tz?, occurrence?): ObligationView
obligationViews(data, today, tz?): ObligationView[]  // All page, ordered by date
needsAttention(data, today): AttentionItem[]
upcomingOccurrences(data, start, end, today)
RAIL_LABELS
```

The windows are 7 and 30 days, today inclusive: `[today, today+6]` and `[today, today+29]`. Items the user confirmed as included in a card statement are not counted twice; this is the same rule `totals.ts` uses.

`coveredMessage` appears only when every item in the next 7 days is marked paid ("You’re covered for the next 7 days: ₹X already marked paid.") or when nothing is due ("Nothing due in the next 7 days."). Otherwise `headline` is "Your next commitment is clear.".

`ObligationView` fields: `id, type, nickname, canonicalProvider, providerName, amountPaise, currency, amountText, occurrenceDate, date, dateText, daysUntil, ruleText, amountConfidence, dateConfidence, amountConfidenceText, dateConfidenceText, sourceBadge, owner, rail, railText, reminderText, status, statusText, overridden, why: { matchLogic, source, lastSyncOrImport, confidence }`.

`AttentionItem.kind` is one of `amount_changed | date_changed | stale_source | unknown_merchant | trial_ending (≤7 days) | overdue_user_entered | overdue_review | duplicate_suggestion | import_pending`. `overdue_review` ("was this paid?") comes from an obligation's `overdueReview` (set when an imported bill or notice, not a receipt, carried a past date); it disappears once that occurrence is marked paid, reviewed, or the changes are acknowledged. Each item has `{ id, title, detail, severity, obligationId?, importItemIds?, suggestion? }`.

## 6. Merchant aliases and duplicate suggestions

`merchants.ts`: `canonicalMerchant(raw)` returns `{ key, displayName, aliases } | null`. Also `merchantKey(raw)`, `normaliseMerchant(raw)`, `findMerchantInText(text)` and `MERCHANT_ALIASES` (brand spellings only).

- Matching uses whole tokens, so "JioHotstar" is not "Jio".
- "Netflix.com", "NETFLIX INDIA" → `netflix`. "Prime Video" → `amazon_prime`. "Bharti Airtel" → `airtel`.

`duplicates.ts`:

```ts
findDuplicateSuggestions(data): DuplicateSuggestion[]   // { key, ids, reason, confidence: 'high'|'medium'|'low' }
mergeDuplicates(data, suggestion, keepId, ctx): MutationResult   // others soft-deleted with mergedInto; their statement links move to keepId
dismissDuplicate(data, suggestion, ctx): MutationResult
findDuplicates(candidate, existing), suggestStatementLinks(...)   // v1 helpers, now alias-aware
```

Nothing merges by itself. Dismissed and merged pairs are not suggested again unless the decision is undone.

Merging moves card-statement links (`CommitmentLink`, as statement parent or as component) from the merged-away items to the kept one, folds links that become identical into one (confirmed if either was) and drops a link from the kept item to itself, so a charge already included in a statement is never counted twice. The links are part of the audit patch (`Patch.links`), so undo restores them exactly.

## 7. Intake and the import review queue

**Redaction (`sensitive.ts`).** `redactSensitive(text) → { text, redactions: [{kind, count}] }`. It masks Aadhaar, PAN, Luhn-valid card numbers, CVV, UPI PIN, OTP, password lines, IFSC codes and labelled account numbers. All extraction runs on the redacted text. `luhnValid`, `looksSensitive` and `blockedHeader` are kept.

**Extraction (`intake.ts`).**

```ts
extractFromDocumentText(text, hint?: { kind?, fileName?, mimeType? }): {
  fields: Partial<{ provider, commitmentType, amount, currency, emi, interestRate, tenureMonths,
                    dueDate, renewalDate, trialEnd, paidDate, billingCycle, benefit, referenceLabel, link }>,
  documentKind, redactedText, redactions }
// each field: { value, confidence 0..1, start, end, snippet }  (positions in redactedText)
organiseSharedSms(text): { provider?, amount?, dueDate?, reference?, extraction }
buildUserEvent(extraction, meta): UserEvent
fingerprintText(text), confidenceBand(n), parseIndianAmount(num, unit?), dateHits(text)
exportStructuredRecord(userEvent, { exportedAt, obligationId? }): string   // JSON with fields + confidence, no raw text
type IntakeType = 'manual' | 'document' | 'forwarded_email' | 'shared_sms'
type ReviewStatus = 'needs_review' | 'confirmed' | 'ignored' | 'deleted' | 'unreadable'
```

- Formats understood: ₹, Rs. and INR; Indian grouping (`5,00,000`); "lakh" and "crore"; dates as dd/mm/yyyy, dd-MMM-yy(yy), "d Month yyyy", "MMM d, yyyy" and ISO; phrases such as "EMI of", "Rate of interest 10.5% p.a." and "Tenure 60 months".
- Dates are assigned to a field only when a label sits next to them.
- A field that cannot be found is left out. Nothing is guessed.

**Queue (`imports.ts`).**

```ts
interface ImportItem {
  id; raw: { kind: 'receipt_text'|'csv_row'|'document'|'forwarded_email'|'shared_sms', text? /* redacted */, row?, receivedAt, ref, fileName?, mimeType? };
  extracted: { merchant, canonicalProvider, amountPaise, date, dateKind, link, commitmentType, cadence, confidencePerField };
  edits?; matchedObligationId?; matchReason?; status: 'pending'|'approved'|'ignored'|'edited';
  userEventId?; redactions?; resolvedAt?; resultObligationId?;
}
importItemFromText(data, { kind, text, receivedAt, ref?, fileName?, mimeType?, sourceDomain?, retentionDays? }) → { item, userEvent }
importItemFromReceipt(data, text, receivedAt, ref?)
importItemsFromCsv(data, csvText, receivedAt) → { items, errors }     // uses csv.ts guards
addImportItems(data, [{item, userEvent?}], ctx) → MutationResult & { skipped }   // skips a repeated message fingerprint
editImportItem(data, id, edits, ctx) / ignoreImportItem(data, id, ctx) / deleteImportRaw(data, id, ctx)
approveImportItem(data, id, ctx & {today}, { targetId?, createNew?, type? })
pendingImports(data), purgeExpiredRaw(data, now), effectiveFields(item), describeImportItem(item), provenanceFor(item)
```

What **approve** does:

- **The item matches an existing obligation:** the amount becomes `'imported'`, with provenance pointing back to this item. If the user edited the amount, it becomes `'user_entered'` instead.
  - A future date within ±7 days of a scheduled occurrence moves only that occurrence.
  - A past date records a paid event (with the item kept as evidence) **only for a payment confirmation**: `isPaymentConfirmation(item)` is true when the document is classified `'receipt'` (text says "payment received", "payment successful", "paid on", "amount paid", "thank you for your payment", …; `isPaymentConfirmationText`) or the date is labelled as a payment (`dateKind: 'paid'`). Card statements and loan schedules that list earlier payments stay what they are.
  - A bill or notice with a past due date is **never** marked paid. It sets `overdueReview` on the obligation and Home shows an `overdue_review` attention item ("was this paid?"). A new obligation created from such an item gets the same flag.
  - The rule itself is never rewritten.
- **No match:** a new obligation is created.
  - A trial email becomes `trial_to_paid`.
  - If the cadence is unknown, the rule is `irregular(date)`. No schedule is invented.

```ts
const { item, userEvent } = importItemFromText(data, { kind: 'forwarded_email', text, receivedAt: now });
let r = addImportItems(data, [{ item, userEvent }], { now });
r = approveImportItem(r.data, item.id, { now, today });   // r.undo() puts it back in the queue
```

## 8. Reminders v2 and retention

`tz.ts`: `zonedToUtc(date, 'HH:MM', tz)` (in a DST gap the time moves forward), `toZoned(instant, tz)`, `inQuietHours`, `shiftOutOfQuietHours(date, time, quiet)` (windows that cross midnight roll to the next day), `DEFAULT_TZ`.

`reminderPlan.ts`:

```ts
planReminders(data, now, { horizonDays?, available?: { email?, push? }, includePast? }): PlannedReminder[]
// { key, obligationId, occurrenceDate, dueDate, kind: 'due'|'trial_ending', leadDays, title, body,
//   severity: 'info'|'normal'|'important', channel: 'in_app'|'email'|'push', scheduledFor (UTC),
//   localDate, localTime, timezone, shiftedForQuietHours, status, acknowledged, snoozedUntil }
dueReminders(plan, now)                        // one per occurrence, the closest lead time
acknowledgeReminder(data, key, ctx) / snoozeReminder(data, key, untilISO, ctx)   // audited, undoable
markReminderShown(data, key, at)               // the only status the client sets itself
recordDeliveryResult(data, key, { channel, ok, at, detail? })   // the ONLY path to 'sent'
deliveryStatus(state, channel, available), reminderStateText(ob, data?)
```

Delivery status is one of `'scheduled' | 'shown' | 'sent' | 'failed' | 'unavailable'`. A channel the server has not reported as available is shown as `unavailable`.

Defaults:

- time: 09:00 local
- quiet hours: `settings.quietHours` (22:00–07:00)
- timezone: `settings.timezone`
- severity: from importance unless set on the obligation (essential → important, optional → info)

`retention.ts` (each function returns `null` or `[]` when there is nothing real to say):

```ts
weeklyDigest(data, today)
retentionAlerts(data, today)      // trial_expiry, amount_change, date_change, stale_source
monthlySummary(data, year, month) // { coveredCount, coveredPaise, reviewedCount, avoidedSurprises, savedPaise, savedItems, text }
```

`savedPaise` counts only items the user confirmed as cancelled (v2 audit or legacy action log) and that have a known amount. Undone actions are ignored.

## 9. Plans and entitlements (`plans.ts`)

```ts
PLANS: Record<'free'|'plus'|'household', Plan>   // prices in paise, priceIsHypothesis: true for paid plans
FEATURES: Record<Feature, { label, plans }>; FREE_FEATURES; PREMIUM_FEATURES
can(entitlement, feature, now?): boolean
canUseRule(entitlement, rule, now?): boolean     // weekday / trial_to_paid / custom_months need premium
effectivePlan(entitlement, now?), priceFor(plan, cadence), priceDisclosure(plan, cadence, startDate)
FREE_ENTITLEMENT
```

The current price hypotheses are Plus ₹149/month or ₹1,299/year, and Household ₹249/month or ₹2,199/year. The server is the source of truth. An entitlement that has expired, lapsed or is missing counts as Free.

```ts
can(ent, 'email_receipt_extraction');                       // gate the Import tab
priceDisclosure('plus', 'yearly', today)?.renewalText;    // "Renews on 30 Oct 2027 unless you cancel before then."
```

## 10. Telemetry (`telemetry.ts`)

```ts
track(name, props, at?)       // queued locally; no network
setTelemetrySink(fn | null)   // server agent installs the sender; the queue is flushed to it
setTelemetryEnabled(on)       // opt-out also clears the queue
peekTelemetryQueue(), drainTelemetryQueue(), TELEMETRY_EVENTS
```

Event names: `first_obligation_completed, import_approved, import_ignored, reminder_resolved, correction_made, missed_or_late, trial_converted, churn_reason, notification_opt_out`. Payload types are fixed per event and carry no names, amounts or free text. The UI calls `track` next to the matching mutation.

## 11. Compatibility notes

- `Commitment` keeps every v1 field. These seven are now **mirrors** of the v2 fields: `amountPaise`, `amountConfidence`, `nextDue`, `dueConfidence`, `frequency`, `intervalMonths`, `remainingOccurrences`.
  - Old screens that edit them through `upsertCommitment` still work, because `reconcileObligation` rebuilds the v2 fields from the edited mirrors.
  - New code should read `amount`, `date` and `rule`, and write through `mutations.ts`.
- `schedule.occurrences` and `totals.*` now use the v2 engine, including overrides, and skip soft-deleted records. The card-statement no-double-count rule is unchanged.
- `newId` now lives in `ids.ts` and is re-exported from `data.ts`.
- `deleteCommitment` (hard delete) still exists for the old UI. New UI uses `deleteObligation`, which is a soft delete.
- Test helpers: `mk()` builds a record from v1 fields, `ob()` from v2 fields, and `ctx()` gives fixed `now`/`today`.

## Sync reconciliation (`account/sync.ts`)

The device keeps, per account, `{ on, version /* last synced server version */, lastSyncedAt, dirty }` (`due:sync:<accountId>`); `dirty` is set on any local change after the last push or adopt. On app start and on sign-in the app reads `GET /api/account/data` and applies `reconcileAction`:

| Server vs last synced | Local unchanged | Local changed |
| --- | --- | --- |
| same version | nothing | push |
| newer | adopt server copy | conflict sheet |
| older, server empty | push | push |
| older, server has data | conflict sheet | conflict sheet |

A server copy that cannot be read is never adopted. Sync stops when the `sync_backup` consent is withdrawn (the server also answers `403 consent_required`); turning sync on records that consent first.
