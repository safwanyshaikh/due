# Gmail OAuth and Google verification

Owner: Agent B (Gmail and identities). Code: `server/src/gmail/**`, `server/src/identities/**`,
`server/src/routes/{gmail,identities}.ts`, `server/migrations/007_gmail_identities.sql`.

## 1. Scopes Due requests

| Scope | Why |
| --- | --- |
| `https://www.googleapis.com/auth/gmail.readonly` | Due reads the body text of billing, renewal, trial, invoice, EMI, loan, card, recharge, school-fee, insurance and utility messages, and pulls out the provider, amount, dates and links. |
| `openid` | Gives a stable Google subject id (`sub`), so Due knows which Google account was linked. |
| `email` (`https://www.googleapis.com/auth/userinfo.email`) | Shows the user which Gmail address is connected, and keeps each address as its own identity. |

Authorization request parameters: `response_type=code`, `access_type=offline`, `prompt=consent`,
`include_granted_scopes=false`, PKCE `code_challenge_method=S256`, and a single-use `state`.

**Why not a narrower scope.** `gmail.metadata` gives headers and labels only, and Gmail's API refuses the
`q` search parameter under that scope. Due's job is to read amounts and renewal dates from message bodies,
so metadata access cannot do it. We do not quietly fall back to a scope that cannot support the feature.

**Scopes Due never requests:** `gmail.modify`, `gmail.compose`, `gmail.send`, `gmail.insert`,
`gmail.labels`, `gmail.settings.*` and `https://mail.google.com/`. The code calls only these endpoints:

- `POST oauth2.googleapis.com/token` (code exchange and refresh)
- `POST oauth2.googleapis.com/revoke`
- `GET gmail/v1/users/me/messages` (list)
- `GET gmail/v1/users/me/messages/{id}?format=full`
- `GET gmail/v1/users/me/messages/{id}/attachments/{aid}`, only when the user turns on attachment processing for that identity

Tests assert this allow-list (`server/test/gmail.test.ts`, `assertReadOnly`).

**Scope changes.** After the code exchange, and on every token refresh, the granted scopes are compared
exactly with the set above. If they differ (something missing or something broader), Due:

1. sets the identity to `status='error'` with `status_reason='scope_mismatch'`;
2. stores no token and revokes the one just issued;
3. requires the user to reconnect.

A `403 insufficientPermissions` from Gmail is handled the same way.

## 2. Restricted-scope implications

`gmail.readonly` is a **restricted** scope. To use it in production with users outside the test list:

- **OAuth app verification** by Google: brand, domain ownership, privacy policy, a scope justification and a demo video.
- **Annual security assessment (CASA)** by a Google-approved assessor. The tier is set by Google, and
  restricted Gmail scopes usually need Tier 2 or higher. Budget time (often 4–8+ weeks) and the assessor's fees.
- Compliance with the **Google API Services User Data Policy**, including the **Limited Use** requirements:
  - data is used only to provide the user-facing feature;
  - no advertising use;
  - no transfer except as needed to provide the feature or by law;
  - no human reading except with consent, for security, or by law.
- Until verification passes, the app stays in **Testing**, which allows at most 100 listed test users.
  Refresh tokens issued in Testing expire after 7 days.

The server reports the stage truthfully through `GET /api/account/gmail/status` and `GET /api/public/status`:

| `GMAIL_OAUTH_MODE` | Reported mode | Meaning |
| --- | --- | --- |
| (credentials missing) | `not_configured` | Connect returns `503 gmail_not_configured` and lists the missing variable names |
| `test` (default) | `test_mode` | Google app is in Testing; only listed test users can connect |
| `verification_pending` | `verification_pending` | Submitted for verification or CASA; new users may see the unverified-app screen or be refused |
| `live` | `live` | Verified, and the security assessment has passed |

Set `live` only after Google has confirmed verification **and** the security assessment has passed.

## 3. Data handling

- **Tokens** are encrypted with AES-256-GCM using `GMAIL_TOKEN_KEYS`.
  - The ciphertext is bound to the identity and the field (additional authenticated data), and stored with its `token_kid`.
  - Refresh tokens are never sent to the browser, never logged and never placed in queue payloads. The queue refuses `token`, `refresh_token` and similar payload keys.
  - Identity API responses never contain token material.
- **OAuth state** is stored only as an HMAC (keyed with `SESSION_SECRET`). It expires after 10 minutes, is consumed atomically on first use, and is bound to the signed-in Due account and to the exact `GOOGLE_REDIRECT_URI`. The PKCE verifier is encrypted under the token key.
- **Scan output.** Review candidates go into `user_events` with `intake_type='gmail'`. Each one stores:
  - the extracted fields and their confidence;
  - the sender domain;
  - `source_meta`: Gmail message id, from domain, SHA-256 of the subject, date, message class, whether the text came from plain text or HTML, and how many attachments were skipped.

  No raw body is stored by default. Only when `DATA_ENCRYPTION_KEY` is set does Due keep a redacted
  excerpt of at most 2,000 characters, encrypted, for **3 days**. Card numbers, PAN, Aadhaar-like numbers, OTPs and CVVs are masked before any parsing or storage.
- **Bodies.** Due parses `text/plain` first. When a message has only HTML, it is converted to text and
  then parsed. It is never rendered, links are never fetched, and scripts, styles and comments are dropped.
- **Attachments** are skipped by default. With the identity's `attachmentsEnabled`, only small (≤256 KB)
  `text/plain` or `text/csv` attachments are read. Other types are counted as skipped.
- **Dedupe.**
  - Per identity, by Gmail message id (`gmail_messages_seen`). This table holds ids and fingerprints, no content.
  - Across the whole account, by normalised content fingerprint and RFC Message-ID, so a message that was also forwarded is not duplicated.
- **Isolation.** Identities belong to exactly one Due account and are never merged by sender address. The
  same Gmail address linked to two Due accounts gives two independent identities.
- **Rate limits.** One running scan per identity, at most 4 manual scans per identity per rolling 24 hours,
  and per-scan caps of 500 messages for the initial 365-day scan and 300 for incremental scans.
- **Plan.** Connecting and scanning need the Plus feature `email_import`, checked on the server and again
  inside the job. Disconnecting never needs a paid plan.

## 4. Retention and deletion

| Data | Retention |
| --- | --- |
| OAuth state | Up to 10 minutes. Expired or used rows are purged at the next connect. |
| Tokens | Until disconnect, identity deletion, account deletion, `invalid_grant`, or scope mismatch. All of these wipe them. |
| Encrypted excerpt | 3 days. Purged by the existing raw-text purge on `raw_retention_until`. |
| Extracted review items | Until the user deletes them, deletes the identity with `deleteData=true`, or disconnects with `deleteImported=true`. |
| Seen Gmail ids | Removed on disconnect and on identity deletion. |
| Scan runs (counts only) | Kept with the identity. Removed when the identity is deleted. |

**Disconnect** (`POST /api/account/gmail/:id/disconnect`):

1. One transaction sets the identity to `disconnected`, wipes the tokens, cancels queued runs, records a consent withdrawal and optionally deletes imported items. A running scan checks the status before each message and stops.
2. Due then calls Google's revoke endpoint. If Google cannot confirm, the response says `revoked:false` and includes `manualRevokeUrl` (myaccount.google.com/permissions).

**Account deletion:** the deletion job should call `revokeAllForAccount(deps, accountId)` from
`server/src/gmail/service.ts` before cascading, so grants are revoked at Google. Database rows cascade from `consumer_accounts`.

## 5. Test-mode setup

1. **Google Cloud project.** Create one (for example `due-prod`) and enable the **Gmail API**.
2. **OAuth consent screen** (Google Auth Platform):
   - User type **External**, publishing status **Testing**.
   - App name, support email, logo, app domain, privacy policy URL, terms URL, and the authorised domain (the domain of `PUBLIC_BASE_URL`).
   - **Data access**: add `openid`, `.../auth/userinfo.email` and `.../auth/gmail.readonly`.
   - **Audience → Test users**: add each tester's Gmail address (100 at most).
3. **Credentials → Create OAuth client ID → Web application.**
   - Authorised redirect URI: exactly `https://<your-host>/api/account/gmail/callback`. For local development, use `http://localhost:<port>/api/account/gmail/callback`.
4. **Server environment:**
   ```
   GOOGLE_CLIENT_ID=<client id>
   GOOGLE_CLIENT_SECRET=<client secret>
   GOOGLE_REDIRECT_URI=https://<your-host>/api/account/gmail/callback   # must equal the console value exactly
   GMAIL_TOKEN_KEYS=k2026a:<openssl rand -base64 32>
   GMAIL_OAUTH_MODE=test
   ```
   `GOOGLE_REDIRECT_URI` must be https, except on localhost.
5. **Queue worker.** Make sure a queue worker process runs with the `gmail.scan` handler registered by
   `registerGmailJobs()` from `server/src/gmail/index.ts`. The web process registers it when the routes load.
6. **Try it.** Sign in with a Plus account, open Connect Gmail, accept the consent text, and approve at Google
   as a listed test user. You should land on `/?gmail=connected`, and an initial scan is queued.

**Rotating the token key.** Prepend a new key, for example `GMAIL_TOKEN_KEYS=k2026b:<new>,k2026a:<old>`.
New and refreshed tokens are written under `k2026b`, and each identity is re-encrypted on its next scan.
Once no `gmail_connections.token_kid` equals `k2026a`, remove the old key. Check with
`SELECT token_kid, count(*) FROM gmail_connections WHERE revoked_at IS NULL GROUP BY 1`.
Removing a key that is still in use flags those identities `error/token_key_missing`, and they must reconnect.

## 6. Production verification checklist

- [ ] Domain verified in Google Search Console for the app domain and the redirect host.
- [ ] Consent screen complete:
  - [ ] name and logo match the product;
  - [ ] support and developer emails are monitored;
  - [ ] homepage, privacy policy and terms are on the verified domain;
  - [ ] the privacy policy describes Gmail data use, retention (section 4), deletion, and Limited Use compliance in plain words.
- [ ] Privacy policy carries the Limited Use disclosure: "Due's use and transfer of information received from Google APIs adheres to the Google API Services User Data Policy, including the Limited Use requirements."
- [ ] In-app consent copy (`GMAIL_CONSENT_TEXT`, version `GMAIL_CONSENT_VERSION`) is shown before the redirect and matches the policy.
- [ ] Scope justification submitted (section 1 text) for `gmail.readonly`, including why `gmail.metadata` is not enough.
- [ ] Demo video (unlisted YouTube) showing:
  - [ ] the consent screen with the client ID visible;
  - [ ] the full OAuth flow;
  - [ ] how scanned data is used (review queue);
  - [ ] disconnect and data deletion.
- [ ] CASA security assessment:
  - [ ] assessor engaged, scope agreed (web app, API, worker, database);
  - [ ] SAST/DAST findings fixed;
  - [ ] letter of validation uploaded;
  - [ ] renewal date (annual) in the runbook.
- [ ] Production redirect URI is the only https redirect on the client; no stray development URIs.
- [ ] `GMAIL_TOKEN_KEYS` is generated per environment and kept in the secret store (not in the repository), with a rotation date set.
- [ ] Error tracking and logs reviewed: no tokens, no message bodies, and no subjects in logs or queue payloads.
- [ ] Data retention jobs verified: raw excerpt purge (3 days) and expired OAuth state cleanup.
- [ ] Disconnect revokes at Google (check myaccount.google.com/permissions), and account deletion calls `revokeAllForAccount`.
- [ ] `GMAIL_OAUTH_MODE=verification_pending` while under review, and `live` only after approval. The UI labels each stage honestly.
- [ ] Support runbook entries for: `scope_mismatch`, `token_revoked`, `token_key_missing`, the unverified-app warning, and the 7-day refresh-token expiry in Testing.
