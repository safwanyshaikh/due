# Security re-audit round 2 — 26 Nov 2026, 15:04–15:10 IST (report only, main @ cd706cd)

**Result:** no Critical. Round-1 fixes mostly hold; H3 (server still holds the sync key) and H4 (hosting/logs in US until an India log sink is configured) remain partial. Six new Medium issues came from the fixes.

## New findings
- **M-A** Percent-encoded paths (e.g. `/%61pi/auth/login`) bypass the admin IP allowlist and CSRF/no-store hooks, which match the raw URL. Fix: match on the decoded route (`req.routeOptions.url`) in every hook.
- **M-B** Breach-notice tool can be used by one admin as a phishing channel. Fix: owner (two-person) approval, fixed template, no external links, alert all owners, daily global cap, open-incident requirement.
- **M-C** An admin can reset another admin's 2FA and receives the reset link in the response → takeover. Fix: owner-only for admin-role users; never return the link when SMTP is configured.
- **M-D** Withdrawing consent doesn't stop processing (Gmail scans continue; server sync copy kept; household purpose unchecked). Fix: withdrawal disconnects/erases; handlers check consent.
- **M-E** Plaintext sync rows remain until next read (dormant accounts, dead tuples, old backups). Fix: backfill job, VACUUM FULL, expire old backups.
- **M-F** `TRUST_PROXY_HOPS=1` not verified against Render's real X-Forwarded-For chain. Fix: measure on staging; set from evidence.
- **Low:** 2FA enrolment race; audit-shipping cursor gaps and unredacted names; Cashfree webhook timestamp window; intake ciphertext not row-bound (AAD); editor writes without fresh code; TOTP guessing alerting; legacy GET offer-match still served.

## Mobile
Good: Keychain/Keystore token, allowBackup=false, no cleartext, association files gated. Fix: Android dataExtractionRules, narrow FileProvider, reject file:// and own-authority URIs, enable minification; exclude WebView data from iCloud backup; app-switcher privacy screen; CI check for native CSP.

## Store and policy gaps
- Paid Plus inside the native apps must follow Apple in-app purchase rules (3.1.1) and Google Play Billing / user-choice billing. Until decided, hide checkout in the native apps (beta is free anyway).
- Privacy manifest / Data safety: add Purchase History and Phone Number (payment provider).
- DPDP: nomination (s.14) and dormant-account retention still missing.

## Round-1 status
Fixed: H1 (hop count to verify), M1, M2, M3, M4, M8, M12, L1–L7, L10. Partly: H2, H3, H4, M5, M6, M7, M9, M10, M11, L8. Not fixed: L9 (operational).

## Fix status (fix pass 2)

Fixed with regression tests (`server/test/round2.test.ts`, `compliance.test.ts`, `cashfree.test.ts`, app `mobileHardening`, `platform`, `researchProviders` tests):
M-A (one decoded/routed path for every hook), M-C (owner-only credential resets for admins; links never returned with SMTP), M-D (withdrawal disconnects Gmail, erases the server backup, leaves/deletes the household; handlers check consent), M-B (incident record, fixed link-free template, owner alerts, second-owner approval, 5,000/day cap), M-E (`sync.seal_backfill` job; VACUUM FULL and backup expiry in `E2E_SYNC_PLAN.md`), M-F (proxy-chain evidence logging, optional `CLIENT_IP_HEADER`, verification steps in `SECURITY.md`), M5 (GET offer match removed), M6 (server accepts known provider names only), M10 (CI step `scripts/check-native-csp.mjs`), M11 (Purchase History, Phone Number), all listed Lows, Android/iOS hardening, and no purchase in the native apps (decision table in `PAYMENTS.md`).
Still open: H3 end-to-end encryption, H4 India hosting, DPDP nomination and dormant-account retention, L9.
