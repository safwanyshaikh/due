# Due (India, invite-only beta)

A **planning-only** app. It helps an adult household see what is due, when, and how much, this month and this year. It **never** pays, borrows, cancels, pauses, or changes a mandate for you. There is no "pay" button, no checkout, no lender marketplace.

Strategy and draft legal text live in [`docs/`](docs/): `product-strategy.md`, `privacy-and-terms-draft.md`.

## Run it (step by step)

You need Node.js 20 or newer.

```bash
npm install
```

```bash
npm run dev
```

Open the address it prints (usually http://localhost:5173). The first launch starts **empty** with an "Add your first commitment" prompt. No example or pre-filled records are shipped.

Due & Offers reads its data from the backend API at `${VITE_API_BASE}/api/public/catalog` (see `.env.example`; leave `VITE_API_BASE` empty when the app and API share an origin). Without a reachable API the Offers screens show "Data unavailable" instead of any bundled data.

Other commands:

```bash
npm test          # unit tests (calculations, guardrails)
npm run lint      # ESLint
npm run format:check
npm run build     # type-check + production build into dist/
npm run preview   # serve the production build (installable PWA)
```

## What is in the MVP

- Home: This month / This year toggle, **Cash due** (actual dates) kept separate from **Monthly run-rate** (planning estimate), category tiles, coming-up list, optional limits.
- Categories: Subscriptions, EMIs, Other Loans, Credit Cards, School Fees, Bills, Other. Each has search, status/owner filters, due calendar, and add/edit.
- Limits: one cap for all commitments, a separate cap for optional subscriptions, alerts at 80% / 100% / above (editable, can be turned off).
- Seasonal plans: consider-before-start, review-before-renewal and restart reminders. Local states only.
- Reminders: 7/3/1 days by default, quiet hours, in-app list, `.ics` calendar export, delivery log. Email and WhatsApp are shown as **unavailable**; nothing is ever marked "sent".
- Data: JSON/CSV export, CSV import with row-by-row preview, delete one item or everything, billing-email labels.

## Due & Offers (read-only Offer Intelligence)

A tile on the home screen opens **Due & Offers**: documented benefits, renewals, trials and expiry for services like Jio, Airtel, Vi, Amazon Prime, Google AI and Cards/UPI.

- **Catalog from the API** (`src/lib/offers/api.ts`, `src/ui/offers/catalogStore.tsx`): offers come only from `GET ${VITE_API_BASE}/api/public/catalog` (10 s timeout, GET, no credentials). The last good response is cached in local storage with its `generatedAt`. The screen says "Last updated <time> IST from Due’s monitoring service", or, if the service cannot be reached, "Data unavailable — the monitoring service could not be reached. Last successful update: <time or never>". **Refresh** calls the API again. Zero offers shows an honest empty state. Records with `verification_status` `research_snapshot` or `pending` are labelled **Verification pending**; `rejected` records are never shown.
- **Status rules** (`status.ts`): `expired` when the official end date has passed or terms say unavailable; `conflicting` when a visible landing page disagrees with the terms (for example the Jio Gemini offer); `unknown` when no authoritative source or only a press release exists; `active_verify` when current but account details are unresolved. Expired and conflicting records never appear in the default list.
- **Eligibility** (`eligibility.ts`): each condition is "confirmed by you", "missing" or "only the provider can confirm". A match is at most "may qualify — verify".
- **Monitoring** runs on the server (scheduled polling of public pages, not real-time). The browser never contacts provider sites.
- **Scenario calculator** (`calculator.ts`): Airtel recharge + Prime, Airtel monthly cashback (wallet and UPI not combinable), JioAICloud, Google AI trial. Documented prices and trial terms are taken from the API record when it has one; otherwise the line says "Not available from Due’s monitoring service". Every result is labelled as an estimate.
- **Due Relay** (`relay.ts`): email forwarding is **not available yet — it needs an inbound email service**, so no forwarding address is issued. The review inbox keeps a clearly labelled local organiser: paste one message and it is processed in this browser only, then shown under Needs your confirmation / Saved / Ignored / Could not identify.
- **Never**: purchase, recharge, pay, activate, redeem, cancel, pause, port, OTP capture, KYC, mandate changes, inbox or SMS reading. A guardrail test scans shipped code for these.

## How the numbers work

| Figure                        | Definition                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Cash due (month/year)         | Top-level obligations scheduled in that calendar period, on their actual dates. An annual charge counts in the month it is due. |
| Monthly run-rate              | Monthly = amount, quarterly ÷ 3, half-yearly ÷ 6, annual ÷ 12, custom ÷ N months. Planning only. One-time items are excluded.   |
| School terms / one-time bills | Shown at their real amount and due date, never silently turned into a monthly bill.                                             |
| Missing amount                | Shown as "amount not entered", never as zero and never invented.                                                                |

**No double counting.** A card statement is one cash obligation. If you link a subscription (or any item) to a statement, it stays in your breakdown, in the optional-spend limit and in reminders, but is **not** added to cash due again. Example: a ₹15,000 statement that includes a ₹2,000 streaming charge forecasts ₹15,000, not ₹17,000. Links are only made by you, never guessed.

Statuses are your own notes. `pause_planned` is not `pause_confirmed_by_user`; `cancel_pending` is not `cancelled_confirmed_by_user`. Only the confirmed ones drop out of forecasts, and none are verified with a provider.

## Safety guardrails (enforced in code and tests)

- Manual entry and user-chosen CSV only. No bank, Account Aggregator, payment-app, Gmail/Outlook, WhatsApp or SMS access.
- Never stored: card numbers/CVV, UPI PINs, passwords, PAN, Aadhaar, raw inbox/chat content, bank statements. Text that looks like these is refused in forms and CSV files, and CSV files with such columns are rejected.
- Future connections (`src/lib/adapters.ts`) are **disabled interfaces** that throw if called.
- A test scans shipped code for payment wording, broad SMS permissions, mailbox tokens, credential fields, scraping tools and network calls (the only allowed call is the public catalog GET in `src/lib/offers/api.ts`).
- A test fails if any file under `src/` (outside tests) imports a sample/demo/mock module or contains demo/sample-data wording or a bundled offer catalog.
- School-fee records use generic labels. No child names, birthdates, student IDs or school logins.

## Where data lives

Everything the user enters is in the browser's local storage on their device; the consumer app has no account system and sends no user data. The only network request is the public, unauthenticated offers catalog GET. A hosted plan with per-user row-level security is sketched in `docs/hosted-schema-plan.sql` (**not applied, not used**). `.env.example` lists placeholders only.

## Known limitations

- Due & Offers depends on the backend API. Records not yet confirmed by monitoring are labelled "Verification pending".
- Due Relay email forwarding is not available (no inbound email service). Only the paste-one-message organiser works, locally.

- Single device, single user. No sign-in, no sync, no household sharing yet. Clearing browser data erases records (export regularly).
- Reminders show in the app when it is opened and in calendar files. There is no push, email or WhatsApp delivery.
- A statement's linked items are matched to its period by date; items with unusual schedules may need manual review (the app warns if linked items exceed the statement).
- Next due date is a single date the user keeps updated; past dates are flagged but not rolled forward automatically.
- Datasets saved by earlier builds have their flagged example records removed once on load (`src/lib/migrate.ts`); the user's own records are untouched.
- The offline cache (`public/sw.js`) caches the app shell only and never caches `/api/` responses. Not tested on iOS Safari beyond basics.
- Not tested with real Indian users yet. Wording and flows need interviews (see `docs/product-strategy.md`).
- Legal text is a draft. Nothing here is legal advice or "compliant".

## Beta-launch checklist

- [ ] Interview 10 to 15 households with the dashboard; record misunderstandings and trust in estimates.
- [ ] Indian counsel has reviewed the checklist below and approved Terms and Privacy text.
- [ ] Real grievance/support contact added in `src/content/privacy.ts` and in the Terms.
- [ ] Hosting chosen (region noted); HTTPS on.
- [ ] Test on Android Chrome and iPhone Safari: install to home screen, offline open, month-end dates.
- [ ] Decide invite mechanism (private link or access code) and cap at 10 to 20 adults.
- [ ] Keep email/WhatsApp reminders labelled unavailable until a provider is configured and verified end to end.
- [ ] Export and delete flows checked by a non-technical tester.

## Checklist for Indian counsel

- Product classification and role: confirm a planning-only tool is outside payment-system, lending-service-provider and aggregator roles; re-review before any feature touches payments, loan leads, rankings or referrals.
- Consumer-protection and disclosure rules, including dark-pattern guidance and clear estimate/limitation wording; no blanket waiver of statutory consumer rights.
- DPDP Act and Rules: notice, consent, purpose limits, withdrawal, deletion, security, grievance, processor terms, and the commencement timetable (counsel to confirm dates).
- Child and family data: school-fee entries, adult-only accounts, and the no-child-identifiers rule.
- Grievance officer / support process and response times.
- RBI and payment-system exposure if the role ever changes.
- App-store policies (Google Play, Apple privacy labels) once distributed beyond the PWA.
- Meta WhatsApp Business policies (opt-in, templates) before any WhatsApp feature.
- Google restricted-scope verification and Google Play SMS permission rules before any email or SMS feature.

## Enabling email or WhatsApp reminders later (exact steps, not done)

1. Pick a provider and obtain credentials yourself (email API key, or Meta WhatsApp Business phone-number ID and token). Put them in a local `.env` only, never in git.
2. Add a small server function that sends reminders and records real delivery results. Do not call providers from the browser.
3. Add explicit opt-in per channel and approved message templates (WhatsApp).
4. Only after an end-to-end test with real delivery receipts, flip the channel in `CHANNEL_AVAILABILITY` (`src/lib/reminders.ts`) to available.

## Test and build output (last run)

```
npm test      -> 7 test files, 114 tests passed
npm run lint  -> no errors
npm run build -> tsc clean, vite build succeeded
```

The consumer-app mock/demo removal is documented in `src/MOCK_REMOVAL_REPORT.md`.
