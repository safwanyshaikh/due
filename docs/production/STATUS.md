# Due production status

Date: 30 Oct 2026 (IST). This is the delivery report against the production go-live directive.

**Legend:** ✅ implemented and tested · 🔑 implemented, awaiting credentials or deploy · 🟡 partial · ⛔ blocked · ✖ not implemented.

## 1. Codebase audit (summary)

| Area | Before | Now |
| --- | --- | --- |
| Consumer app (`src/`) | Browser-only PWA. Demo commitments loaded on first launch, a bundled 22-offer catalog presented as live, simulated "check sources", and a fake Relay address. | Starts empty. Offers come only from `/api/public/catalog`. If the API is unreachable it says "Data unavailable" with the last successful time. Relay is marked "not available yet". |
| Backend | None | `server/`: Fastify + Postgres 16, auth, roles, audit, admin API, monitoring engine and scheduler. |
| Admin | None | `admin/`: React admin panel at `/admin/`. |
| Deploy | Static site only | `render.yaml`: one web service (app, admin and API on one origin) plus managed Postgres. |

## 2. Mock data removal

Removed:
- `src/lib/sample.ts` and every demo/sample badge, notice and button.
- The bundled offer catalog and its source table.
- The fake refresh.
- The Relay demo events and demo address.
- Hard-coded calculator figures.

Existing users' saved demo records are dropped once on load; their own records are untouched. Details: `src/MOCK_REMOVAL_REPORT.md`.

Guardrail tests fail the build if demo/sample imports or wording return to `src/`.

The 22 research-derived offers stay in the database as `research_snapshot`. They are labelled "Verification pending" everywhere and never shown as verified.

## 3. Architecture

Browser → Render web service `due`:
- `/` serves the Due PWA (user data stays in the browser).
- `/admin/` serves the admin SPA.
- `/api/*` is the Fastify API.

The scheduler runs inside the same service (`RUN_SCHEDULER=true`). Postgres advisory locks keep a job single-run even with several instances. The database is Render Postgres 16.

## 4. Database

Migrations live in `server/migrations/` (`001_init.sql`, `002_vendor_intel.sql`). They are applied on every start (idempotent) and tracked in `schema_migrations`.

Tables:
- users, sessions, login_events, password_resets, audit_log
- categories, companies, sources
- snapshots, fetch_runs, records, record_versions
- jobs, job_runs, alerts, settings, offers, vendor_intel

## 5. Admin access

URL: `https://<your-render-host>/admin/`. There is no default password.

The first owner is created once at `/admin/setup` with the `ADMIN_SETUP_TOKEN` you set in Render. Remove the token afterwards. Later users are invited from Users, which produces a one-time setup link.

## 6. Admin panel modules

| Module | Status | Notes |
| --- | --- | --- |
| Dashboard (DB counts, latest runs, job health, alerts) | ✅ | Counts verified against SQL in the end-to-end run. |
| Companies & vendors (add, edit, archive, verify, monitoring on/off, sources, records, research intel) | ✅ | |
| Sources (add/edit, validate, run, retry, disable, run log, snapshots, diff) | ✅ | |
| Data/records (search, filter, approve/reject, correct with version, history, CSV/JSON export with attribution) | ✅ | Lists show up to 500 rows; full pagination is not built (🟡 at scale). |
| Users & access (roles, invite, disable, reset link, revoke sessions, login history, sessions, audit log) | ✅ | |
| Automation (enable/disable, interval, run now, run logs, alerts) | ✅ | |
| Settings (frequency defaults, backoff, retention, notifications, business) | ✅ | Email alerts are 🔑 and need `SMTP_URL`. |

## 7. Vendor and source inventory

Seeds come from `server/seed/registry.json` and `server/seed/registry-payments.json`. They are imported on every start, idempotently.

- **Vendors (18):**
  - Reliance Jio, Bharti Airtel, Vodafone Idea, BSNL
  - Amazon India (Prime), Amazon Pay, Google One/Gemini, Google Pay
  - Paytm, PhonePe, MobiKwik, CRED, NPCI (UPI/RuPay/BHIM)
  - JioHotstar, Netflix India, Apple India
- **Sources:** 77 official or candidate URLs. All are currently unverified, because the research agents' network was blocked (see §14). Each source records the exact reason. The production monitor fetches every one from Render.
- **Vendors without sources:** BSNL, JioHotstar, Netflix India and Apple have none yet. They need sources added in the admin panel, or a research re-run once network access is allowed.

## 8. Real-data ingestion results

| Test | Result |
| --- | --- |
| Real public URL fetched by the engine (`registry.npmjs.org/react/latest`, the only public host reachable from the build sandbox) | ✅ First run "changed": snapshot stored, 1 record created, pending review. |
| Same URL re-checked | ✅ "unchanged": no new snapshot. |
| Conditional GET | ✅ 304 "not modified". |
| Duplicate source URL | ✅ Rejected with 409. |
| Indian vendor sites from the sandbox | ⛔ DNS blocked by the sandbox network policy. Errors were recorded honestly with backoff. Expected to work on Render. |

## 9. Monitoring schedule (defaults, editable in the admin panel)

- **Critical sources:** daily (1,440 min). **Regular and secondary sources:** weekly (10,080 min).
- **Scheduler:** polls every 60 s, every day including weekends.
- **Jobs:**
  - `monitor_sources`: every 15 min, picks up whichever sources are due.
  - `retry_failed`: every 30 min, with exponential backoff (30 min doubling to 24 h). After 8 failures a source is marked inaccessible and an alert is raised.
  - `retention_cleanup`: daily.

## 10. Automation execution log (local end-to-end run)

- `monitor_sources` (scheduled): `due 50, error 50`. These are vendor DNS failures from the sandbox, as expected.
- `retention_cleanup` (scheduled): success.
- `retry_failed` (scheduled): success, `due 0`.
- Manual runs and validations on the reachable source: success (see §8).
- Weekend runs: covered by tests with an injected Saturday/Sunday clock.

## 11. Integrations

| Integration | Status |
| --- | --- |
| HTML / RSS / JSON polling with robots.txt, throttling, size and time limits, private-IP blocking | ✅ |
| Email alerts | 🔑 needs `SMTP_URL` |
| Due Relay inbound email | ✖ needs an inbound email provider and domain |
| Official vendor APIs and webhooks | ✖ none publicly available for these offers; polling is used and labelled as such |
| Vendor login portals, CAPTCHA and paywalled pages | not attempted, by design |

## 12. Security and QA

- **Passwords and sessions:** passwords hashed with scrypt; session tokens stored only as HMAC hashes.
- **Cookies:** httpOnly, Secure and SameSite=Strict cookies, with idle and absolute expiry.
- **CSRF:** `X-Requested-With` header plus an Origin check.
- **Rate limits:** global, plus a login limit.
- **Validation and authorisation:** zod validation on every route; roles enforced on the server; every admin mutation audited.
- **Headers:** CSP, HSTS, nosniff and frame-deny.
- **Secrets:** none in git.

Tests:
- server: 51 against real Postgres
- consumer: 114
- admin: 24

Typecheck, lint and builds pass. A browser end-to-end run covered setup, login, the dashboard, vendors, source detail, a viewer being blocked from changes (403, and edit buttons hidden), and the consumer app (empty start, catalog loaded, no horizontal scroll at 390 px).

## 13. Deployment status

`render.yaml` is ready. 🔑 Nothing is deployed to Render from this session: it has no Render access, and you need to approve the cost.

- **Plans:** web `starter` (always on, needed for the scheduler) and Postgres `basic-256mb`, region Singapore.
- **Backups:** follow Render's Postgres plan; check them after creation. No separate backup export is built (🟡).

## 14. Outstanding manual requirements (only what needs you)

1. **Render deploy and cost approval.**
   - Why: production hosting, the database and the always-on scheduler.
   - Steps: Render → New + → Blueprint → `safwanyshaikh/due`, branch `main` → Apply. This creates `due` and `due-db` on paid plans (check current prices on Render). Then delete the old free static site `due` if you created it earlier.
2. **Set `ADMIN_SETUP_TOKEN`.**
   - Why: creating the first owner.
   - Steps: Render → `due` → Environment → add `ADMIN_SETUP_TOKEN` (a long random value) → Save. Open `https://<host>/admin/setup`, create the owner, then delete the variable.
3. **Optional: email alerts.**
   - Why: important-change emails.
   - Steps: create an SMTP account (for example a transactional email provider), then set `SMTP_URL` and `SMTP_FROM` on `due`.
4. **Optional: allow vendor hosts in this Claude environment.**
   - Why: lets the research agents verify sources and add new ones (BSNL, JioHotstar, Netflix, Apple) from here.
   - Steps: session environment menu → Edit → Network access → allow the hosts listed in `research-evidence.md` and `research-payments.md`.
5. **Legal review.**
   - Why: required before public launch.
   - What: Terms, privacy notice, DPDP obligations, and crawling terms for each vendor site (see the README checklist).

## Update: obligation-first redesign go-live (30 Oct 2026)

What changed since the first production report:

- **Home** is now obligation-first: next 7 days header with "Why?", next-due hero card (Review / Snooze / Edit), 7-day and 30-day totals with "Needs attention", next three by date, then Add due item / Import. Category tiles live on the separate All page.
- **Start without an account**: "See my next due date" leads to four equal paths (add manually, upload a bill or sanction letter, forward an email, sign in).
- **Domain v2**: recurrence for one-time, monthly, quarterly, half-yearly, annual, end-of-month, weekday, custom months, trial-to-paid and irregular schedules. Amounts and dates carry confidence and source. The next date can be moved without rewriting history. Every change is audited with a 6-second Undo.
- **Import**: PDF and text are read in the browser (never uploaded), with sensitive numbers masked first. Single SMS and CSV import. Nothing is saved before review.
- **Accounts (server)**: email magic-link sign-in with a confirm-on-device step, sessions and devices, backup and sync with conflict handling, consents that take effect, export and delete.
- **Plans**: Free and Plus on sale; Household is off sale until sharing ships. Prices are admin-editable. Razorpay checkout and webhook are built but inactive without keys.
- **Forwarding**: a private address per user or temporary session, encrypted raw text with 7-day retention, and a review queue. Inactive until an inbound email provider is configured.
- **QA**: 22 bugs found and fixed in review and the go-live pass (see commit history). In the final browser walkthrough a date bug was found and fixed: the day-of-month ignored the picked date.

| Feature | Status |
| --- | --- |
| Guest use, home, edit/snooze/undo, PDF/SMS/CSV import, reminders in app, admin | ✅ tested end to end |
| Email sign-in, email reminders, household invites | 🔑 need `SMTP_URL`, `SMTP_FROM` |
| Payments (Plus) | 🔑 need the `RAZORPAY_*` keys and plan ids (Admin → Plans) |
| Email forwarding | 🔑 need `INBOUND_EMAIL_DOMAIN`, `INBOUND_WEBHOOK_SECRET` and an inbound provider (Postmark or Mailgun) |
| Raw email storage | 🔑 needs `DATA_ENCRYPTION_KEY` (without it, only structured fields are kept) |
| Photo (JPG/PNG) text recognition, push notifications, household sharing UI | ✖ not built yet; the app says so |
