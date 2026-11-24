# Savings engine: build spec (phase 1, launch target this weekend)

Source of truth for the four build agents. Contract types: `src/lib/savings/types.ts` (do not change shapes without updating this file; additive fields only).
Research behind it: `docs/research/value-graph.html`, `docs/research/value-graph-v2.html`.

## Product rules (non-negotiable)

- Information only. Due never pays, switches, cancels, recharges, applies for loans, or shares user data with providers or lenders.
- User data stays where it is today (on the device / the user's synced data blob). The engine runs on the client. The server only serves public rules (the catalog) and receives anonymous, number-free research requests and opt-in anonymous savings reports.
- No invented numbers. Unknown prices are `null` and produce no money claim. Assumptions are allowed only when labelled (`source: 'typical'`) and editable.
- Prices from `research` modules are shown with "Reported price, check before switching" (`unverifiedPrice: true`).
- No guarantee wording anywhere in the product or marketing. No "minimum saving" claims. The 2× return ratio is an internal KPI only.
- Community "people saved by switching" shows only real aggregated reports with at least `COMMUNITY_THRESHOLD` (20) per item. Below that it is hidden, never padded.
- Ads/sponsored: off at launch (`sponsored: false`). The slot and rules are documented in the research page for later.
- Credentials: development uses dummy values only. Never commit real secrets.

## Ownership

| Agent | Owns |
| --- | --- |
| S Server + admin | `server/migrations/009_savings.sql`, `server/src/savings/**`, `server/src/routes/savings.ts`, `server/src/routes/admin/savings.ts`, `server/test/savings*.test.ts`, `admin/src/pages/Savings.tsx` (+ admin nav entry, admin tests). Small additive edits to `server/src/app.ts`, `server/src/routes/admin/index.ts`. |
| R Research data | `server/src/seed/savings-data.json` only (+ `docs/research/sources-savings.md`). |
| E Engine | `src/lib/savings/**` except `types.ts` shapes (additive only), `src/lib/types.ts` (AppData.savings), `src/lib/migrate.ts`/`storage.ts` default for the new field, tests in `src/lib/savings/__tests__/`. |
| U UI | `src/ui/savings/**`, Home entry point, routing in `src/ui/App.tsx`, landing copy, `e2e/savings*.spec.ts`. Uses engine functions only through `src/lib/savings/index.ts`. |

## Server API (S)

Migration `009_savings.sql` (additive):

- `savings_modules` (id text pk, version int, status, data jsonb = full `SavingsModule`, updated_at). Index on status.
- `city_packs` (id text pk, status, data jsonb = full `CityPack`, updated_at).
- `research_requests` (id bigserial, provider_label text, category text, city_pack text null, request_count int, first_seen, last_seen, status `open|researching|done|rejected`, module_id text null, unique(provider_label, category)). No account id, no amounts.
- `savings_reports` (id bigserial, move_kind, module_id null, city_pack null, saved_monthly_inr int (rounded to nearest 10, 1..100000), created_at). No account id.

Public endpoints (rate-limited, JSON, zod-validated):

- `GET /api/public/savings/catalog` → `SavingsCatalog` (status `verified` and `research`; never `retired`). `Cache-Control: public, max-age=300`. `version` = hash of content.
- `POST /api/public/savings/research` body `{ providerLabel, category, cityPack? }` → `{ status: 'queued' | 'known', moduleId? }`. Reject labels > 60 chars, containing `@`, URLs, or 5+ consecutive digits (PII guard). Upsert increments `request_count`.
- `POST /api/public/savings/report` body `{ moveKind, moduleId?, cityPack?, savedMonthlyInr }` → 204. Rate limit 10/hour/IP.
- `GET /api/public/savings/community?cityPack=` → `{ threshold: 20, items: [{ moveKind, moduleId, label, reports, medianSavedMonthlyInr }] }` only items with `reports >= 20`.

Admin (`/api/admin/savings/...`, admin auth, audit-logged):

- modules: list, get, create, update (bumps version), `POST :id/verify` (requires an `official` source with `lastVerifiedAt` within 30 days, else 422), `POST :id/retire`.
- city packs: list, get, upsert.
- research queue: list (sorted by request_count), update status / link module.
- Seeding: on startup (idempotent) load `server/src/seed/savings-data.json` into empty tables only; never overwrite admin edits. Validate with zod; bad entries are skipped and logged.

Admin UI page "Savings" with tabs: Modules (the 8-field plug-in form, grouped as Detect / Identify / Rules / Value / Proof / Nudge / Legal / Sources), City packs, Research queue.

## Engine (E) — pure functions, exported from `src/lib/savings/index.ts`

- `parseStatementText(text, source): StatementLine[]` — pasted or extracted bank/card statement text and CSV (date, narration, debit/credit columns; Indian formats like `05/11/2026`, `05-Nov-26`, `₹1,299.00`, `Dr/Cr`).
- `parseCardStatementSummary(text)` → `CardStatementSummary` (due date, total/minimum due, limits, payments, purchases, fees+taxes+interest, finance charge incl. GST, late fee, forex markup, annual fee, printed monthly rate; masked card digits only). `parseLoanStatement(text)` → `LoanStatementSummary` (SOA or welcome letter: rate, rate type, EMI, EMI day, balance tenure, future principal, overdue, late charges, bounce rows/months/charges, processing fee, dates). `addCardBill` / `addLoanEmi` create or update the obligation and save the summary.
- Statement lines (additive fields): `foreignAmount`/`foreignCurrency`, `taxInr` (the "(EXCL TAX …)" GST note), `lineKind` (only `purchase` lines can recur), `statementPeriod`. Card rows: the amount is the last money value before the trailing C/D marker; undated fee rows take the previous row's date.
- `detectRecurring(lines): RecurringCandidate[]` — group by `merchantKey`; monthly (26–35 days), quarterly, yearly; amount stability ±15%; rails: `UPI-AUTOPAY`, `UPI MANDATE`, `AUTOPAY` → `upi_autopay`; `NACH`, `ACH D`, `ECS`, `SI-` → `bank_mandate`; card source → `credit_card`. Two occurrences = medium confidence, three+ = high. Foreign-currency or known subscription merchants (statement aliases: Anthropic/Claude, Lovable, Google Cloud/Workspace, Meta Verified, Facebook ads, Jio, Airtel) recur when seen in ≥ 2 statement months with ±40% tolerance; additive `kind: 'subscription' | 'usage_topup' | 'unknown'`.
- `computeMoves(data: AppData, catalog: SavingsCatalog, now: string): { moves: Move[]; research: ResearchNeed[] }` — generators per `ValueKind`:
  - overlap: an obligation's module `includes` a key that matches another paid obligation (telecom plan with JioHotstar while paying JioHotstar; Uber One's Zomato Gold while paying Zomato Gold).
  - period_switch: monthly obligation whose module has a cheaper yearly price → (monthly × 12 − yearly) / 12.
  - membership_breakeven: membership fee vs value from usage (assumptions: rides/orders a month, average fare/order; `typical` defaults, overridable). Negative value → "pause before renewal" move with the saving = fee.
  - commute_pass: `profile.commute` legs × city pack passes covering both localities with a known price → (current monthly spend − pass) if positive.
  - debt_rate: credit-card obligation with a revolving balance/interest note → monthly interest at the stated rate vs module `ratePctHigh`. Legal note: "Information only. Check your bank's own offer."
  - loan_switch: loan with `rateType: 'variable'` and rate above module `ratePctLow` + 0.5 → EMI difference; legal note includes the RBI floating-rate prepayment rule source.
  - price_change: last two recorded amounts differ upward by ≥ 5%.
  - trial_end: `subscription.trialEnd` within 7 days.
  - fee_leak (additive): from saved statement summaries (`SavingsState.statements` / `loans`, latest per card/loan): card interest paid ("You paid ₹X interest this month", linked to the balance-transfer module, debt legal note), late fee ("Set an autopay for at least the minimum due"), forex markup + GST ("a zero-forex card or paying in INR avoids it", no card named), annual fee charged (waiver condition shown only when the statement prints exactly one); loan EMI bounces in the last 12 months (bounce charges + late interest). Loan summaries also feed loan_switch (future principal, balance tenure, current rate); ≥ 2 bounces in 12 months → low confidence and the "6–12 months without bounces" note.
  - Unknown providers (no module matches) → `ResearchNeed`.
  - Ranking: monthlySavingInr × confidence weight (high 1, medium 0.7, low 0.4), effort as tie-break (tap > habit > paperwork). Sponsored never affects rank.
- `ledgerFromMoves`, `markMove(state, moveId, status)`, `proveSavings(data, ledger)` — a `done` move becomes `saved` only when evidence appears (the obligation's amount drops, it is cancelled/paused by the user, or a new import shows the new plan).
- `returnRatio(ledger, planFeeMonthlyInr)` → found and saved ratios.
- Additive contract fields (engine): `LedgerEntry.moduleId?`, `obligationIds?`, `targetObligationId?`, `baseline?: LedgerBaseline` (snapshot of the target obligation used as proof evidence).
- `AppData.savings: SavingsState` with defaults; migration fills it for existing data.
- Test coverage: each generator, recurring detection on realistic Indian statement text, PII-free research labels, ranking.

## UI (U)

- Home: one "Savings" entry in the summary area ("₹X/month found") that does not displace the eight tiles from the first viewport.
- Savings screen: totals (Found / Saved), ranked moves, research-pending list ("We're studying these bills: …"), commute setup, statement import entry, community block (renders only when the API returns items).
- Move sheet: title, why, saving and range, assumptions as editable chips ("We assumed 8 rides a month · Change"), sources with last-checked dates, "Reported price, check before switching" when unverified, action button to the official page, "I did this" / "Not for me".
- Statement import: paste text or upload PDF/CSV (reuse on-device pdf.js and the existing CSV path) → recurring candidates → review → add as obligations with the detected rail.
- Copy: no guarantee, no minimum-saving claims. Landing hero uses the chosen tagline.
- Tests: unit + e2e for the main flow at 360 px and 1280 px, axe clean.

## Done when

All existing suites still pass, new suites pass, `npm run build` passes in all packages, and the Sameer-style flow works end to end on a local server with dummy credentials.
