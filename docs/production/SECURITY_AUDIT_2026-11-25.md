# Security and privacy audit — 25 Nov 2026 (report only)

Independent audit pass. Full method, evidence and probe scripts were kept outside the repo. Status of each item is tracked in the fix pass that follows.

## Result
- **Critical:** none. Two-account tests found no way for one account to read or change another's data (intake, identities, Gmail, sessions, sync data, household, deletion). Admin routes reject consumer sessions.
- **High**
  - H1 Rate limits keyed on a spoofable `X-Forwarded-For` (trustProxy=true). Fix: trust exactly the Render proxy hop; add per-email limits.
  - H2 Admin console: password only, same origin as the app. Fix: mandatory TOTP/passkey, separate origin or allowlist, `__Host-` cookies.
  - H3 Synced account/household data stored as plain JSON (incl. savings summaries with daily balances). Fix: end-to-end encrypted sync (key on device), minimum per-account server-side encryption; keep daily balances off sync unless opted in.
  - H4 CERT-In / DPDP: hosting and logs in the US, no 180-day/1-year log retention in India, no 6-hour / 72-hour breach process, no per-user breach notice. Fix: ship logs + audit tables to India-region storage (≥1 year), breach runbook, admin "notify affected accounts", CERT-In point of contact.
- **Medium**
  - M1 Error logs not redacted (emails seen in a log line).
  - M2 `DATA_ENCRYPTION_KEY` optional; forwarded mail can be stored in plain text.
  - M3 Usage analytics on by default, tied to account, survive deletion.
  - M4 Account export incomplete.
  - M5 Offer-match GET puts provider and price in URLs (access logs).
  - M6 Research-label PII guard too weak (names, addresses, non-ASCII digits pass).
  - M7 Statement fixtures derived from real documents; earlier versions in git history.
  - M8 No 18+ age confirmation (DPDP s.9).
  - M9 Server treats "never withdrawn" as consent; legal-details gate not enforced in production.
  - M10 No CSP in the native app.
  - M11 iOS privacy manifest missing; store data-safety answers incomplete.
  - M12 Mailgun webhook signatures replayable within 15 minutes.
- **Low:** tokens in cached URLs (service worker); export/delete without fresh sign-in; unsubscribe tokens never expire; intake redaction misses account numbers/phones/emails/IFSC; invite-email phishing vectors; npm moderate advisories (no high/critical); cookie/CSP/HSTS hardening; retention of audit and dormant accounts; key management (KMS, separate backup keys, backup schedule); per-email login cap.

## Verified sound
Tenant isolation; admin role checks; magic links (256-bit, HMAC-stored, 15 min, single use, CSRF); session cookies; Gmail token encryption, PKCE, revoke; parameterised SQL; no XSS sinks or third-party scripts; documents and statements parsed on the device; savings research/reports carry no account id or IP; no secrets in git history.

## Compliance status (summary)
DPDP notice/consent/rights: partial · breach notice: missing · children: missing · nomination: missing · CERT-In: missing · RBI (no lending/payments): OK, keep information-only · Google Limited Use disclosure: missing · Play data safety / Apple privacy manifest: to do.

## Fix order
H1 → H2 → M1, M2 → H4, M8, M9 (before public launch) → H3 → remaining Medium → Low.
