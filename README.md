# Recurring Payables Planner (India, invite-only beta)

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

Open the address it prints (usually http://localhost:5173). The first launch shows clearly labelled **sample data** (one subscription, one EMI, one card statement with a linked subscription, one school-fee instalment, one seasonal plan). Remove it from the home banner or Settings.

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
- A test scans shipped code for payment wording, broad SMS permissions, mailbox tokens, credential fields, scraping tools and network calls.
- School-fee records use generic labels. No child names, birthdates, student IDs or school logins.

## Where data lives

Everything is in the browser's local storage on the user's device. There is no server, no account system and no hosted database in this release, so there is no cross-user access to test. A hosted plan with per-user row-level security is sketched in `docs/hosted-schema-plan.sql` (**not applied, not used**). `.env.example` lists placeholders only.

## Known limitations

- Single device, single user. No sign-in, no sync, no household sharing yet. Clearing browser data erases records (export regularly).
- Reminders show in the app when it is opened and in calendar files. There is no push, email or WhatsApp delivery.
- A statement's linked items are matched to its period by date; items with unusual schedules may need manual review (the app warns if linked items exceed the statement).
- Next due date is a single date the user keeps updated; past dates are flagged but not rolled forward automatically.
- Sample-data dates are relative to today, so "this month" may be empty on the first screen if the sample dates fall next month.
- The offline cache (`public/sw.js`) caches the app shell only. Not tested on iOS Safari beyond basics.
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
npm test      -> 6 test files, 64 tests passed
npm run lint  -> no errors
npm run build -> tsc clean, vite build succeeded
```

Browser smoke test (headless Chromium, 390px wide): home, categories, add/edit, limits, seasons, reminders and settings rendered without errors; the duplicate warning, card-link suggestion and sensitive-text refusal behaved as designed.
