# Security controls

This page records what the server enforces today, where in the code, and how to rotate each secret. Report vulnerabilities to the address in the `legal.incident_contact` setting.

## HTTP hardening (`server/src/http/security.ts`, `server/src/app.ts`)

- **Headers on every response:**
  - `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`
  - `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Resource-Policy: same-origin` (`cross-origin` only for `/api/public/*`)
  - `Permissions-Policy` (camera, microphone, geolocation and payment all off)
  - `Strict-Transport-Security: max-age=31536000; includeSubDomains` in production
- **Content Security Policy.** API responses get `default-src 'none'; frame-ancestors 'none'`. The app and admin SPA get a self-only policy (no inline scripts, no third-party origins).
- **Caching.** Private paths (`/api/admin`, `/api/auth`, `/api/account`, `/api/intake`, `/api/billing`, `/api/inbound`) send `Cache-Control: no-store`.
- **Error pages** never include stack traces, SQL, tokens or provider payloads. Unhandled errors return `{ error: { code: 'internal_error' } }` and are logged in redacted form. Error reports (`SENTRY_DSN`) are scrubbed by `beforeSend` in `server/src/observability/errorReporter.ts`, so they never carry request bodies, users, mail or document content, or amounts.
- **Correlation ids.** Each request gets an id (a valid incoming `x-request-id` is accepted; otherwise one is generated). It is returned as `x-request-id` and copied onto every job the request enqueues.
- **Logs** use pino with redaction paths for cookies, authorization headers, webhook signatures, `*.token`, `*.password`, `*.secret`, `*.text`, `*.body`, `*.subject` and OAuth tokens (`server/src/observability/redact.ts`). Secret query values (`token=`, `household_invite=`) are removed from logged URLs.

## CORS

Only `GET /api/public/*` (catalog, plans, status, legal) is cross-origin readable. It is restricted to the `PUBLIC_APP_ORIGIN` allowlist, with no credentials. Every other route is same-origin only, because the server never grants CORS for it.

## CSRF

The app and admin use cookies (`SameSite=Lax`, `HttpOnly`, and `Secure` in production). Every state-changing request under `/api/admin`, `/api/auth`, `/api/account` and `/api/intake` must send `X-Requested-With` (`due-admin` or `due-app`); a browser cannot send this header cross-site without a preflight the server never grants. When the browser sends `Origin`, it must be this server's own origin.

Exceptions are signature-authenticated machine endpoints:

- `/api/billing/razorpay/webhook`: HMAC of the raw body.
- `/api/inbound/email`: Basic auth, a Mailgun signature with a 15-minute replay window, or an HMAC.
- `POST /api/notifications/unsubscribe?token=`: an HMAC-signed token that can only turn a channel *off*.

Gmail OAuth uses `state` (HMAC-stored, single use, 10 minutes) and PKCE (see `GOOGLE_VERIFICATION.md`).

## SSRF

Source monitoring (`server/src/monitor/net.ts`) resolves DNS before connecting and refuses loopback, private, link-local, CGNAT, multicast and reserved addresses (IPv4, IPv6 and IPv4-mapped). The check is repeated on every redirect, with a cap of 5 redirects, a 20 s timeout, a 5 MB body limit and robots.txt respected. User-supplied links in mail are stored as data and never fetched or auto-opened.

## Rate limits and abuse controls

| Surface | Limit |
| --- | --- |
| Every route (per IP) | 600 requests a minute |
| Admin login | 10 failed attempts per IP+email per 15 minutes, with login events audited |
| Magic link | 30 requests per IP per 15 minutes; 5 per IP+email per 15 minutes; 10 per email per hour |
| Guest intake session | 10 per IP per hour |
| Inbound webhook | 300 requests a minute; 30 unknown aliases per IP per minute (then 429); 100 events per owner per day; 512 KB of text per message |
| Uploads | Free: 5 documents a month (`POST /api/account/uploads/count`, 402 when exceeded) |
| Unsubscribe and deletion status | 30 and 60 requests a minute |

Alert thresholds for abuse are listed in `RUNBOOK.md`.

## Data protection

- Raw intake text is encrypted with AES-256-GCM (`DATA_ENCRYPTION_KEY`). It is kept for 7 days and then purged by `retention.purge`.
- Forwarded messages are held sealed in `inbound_messages` only until `inbound.parse` runs. The body is wiped immediately after parsing, and any leftover is wiped after 24 h at most.
- Job payloads may only hold ids. `enqueue` rejects keys such as `text`, `body`, `subject` and `token`, and caps a payload at 8 KB. Job error messages are redacted.
- Gmail tokens are encrypted with `GMAIL_TOKEN_KEYS` (key ring). Account deletion revokes Google tokens before it deletes identities.
- Admin access to raw content is audited (`audit_log`, `consumer_audit`).

## Least privilege

- Production, staging and development use separate Render services, databases and credentials. Never reuse a production secret elsewhere.
- Optional: give the app a database role without `CREATEDB` or superuser. Only `backup:verify` needs `CREATEDB`, and you can avoid that by passing `SCRATCH_DATABASE_URL`.
- No secret reaches the client bundle. The client only receives the public Razorpay key id at checkout.

## Supply chain (CI, `.github/workflows/ci.yml`)

- `npm ci` is lockfile-exact. Review lockfile diffs in pull requests.
- `npm audit --audit-level=high` runs for the root, server and admin packages on every push.
- gitleaks secret scanning runs over the full history (`gitleaks/gitleaks-action@v2.3.7`).
- Current status: 0 high or critical findings everywhere. Admin has 2 moderate `react-router` advisories that are only fixed in v7 (a breaking upgrade), are not exploitable in this SPA (no SSR, no backslash links), and are tracked for the admin owner.

## Secret rotation

Rotate a secret immediately if it may be compromised, and otherwise once a year. Rotate each one in Render > Environment Groups > `due-shared` (or on the service for `ADMIN_SETUP_TOKEN`), then redeploy **both** `due` and `due-worker`.

### `SESSION_SECRET`

It keys the HMACs for admin and consumer session ids, magic links, guest intake tokens, delete confirmations, unsubscribe links and deletion-status tokens.

1. Generate a new value: `openssl rand -base64 48`.
2. Set it in `due-shared` and redeploy web and worker together.
3. Effects: every admin and consumer session ends (people sign in again). Outstanding magic links, invites, unsubscribe links in emails already sent, and deletion-status tokens stop working. Deletion jobs themselves still finish.
4. Post an `info` incident banner beforehand ("You will be asked to sign in again").

### `DATA_ENCRYPTION_KEY` (single key, AES-256-GCM)

Key versioning is not implemented yet. Rotating the key therefore throws away raw text that is at most 7 days old. Structured fields, reviews and confirmations are not affected.

1. Pause intake: rotate `INBOUND_WEBHOOK_SECRET` (see below) or post an incident banner, then wait for the queue to drain (`inbound.parse` count 0 in queue stats).
2. Run `UPDATE user_events SET raw_text = NULL, raw_retention_until = NULL WHERE raw_text IS NOT NULL; UPDATE inbound_messages SET body = NULL, status = 'failed', error_code = 'key_rotated' WHERE body IS NOT NULL;`
3. Set the new key (`openssl rand -base64 32`), redeploy web and worker, and re-enable intake.
4. If the old key may have leaked, also treat any database backup taken while it was current as containing readable raw text, and expire those backups early.

### `GMAIL_TOKEN_KEYS` (key ring `kid:base64key,...`, first entry current)

1. Prepend a new key: `new2026:<openssl rand -base64 32>,old2025:<old>`. Redeploy both services.
2. Tokens are re-encrypted under the new key the next time they are used or refreshed (`server/src/gmail/service.ts`). Wait at least one full scan cycle, or until every identity has `token_kid = 'new2026'`, by checking `SELECT token_kid, count(*) FROM gmail_connections WHERE revoked_at IS NULL GROUP BY 1`.
3. Remove the old key and redeploy. If a key leaked, also revoke the affected Google tokens (disconnect) and ask users to reconnect.

### `ADMIN_SETUP_TOKEN`

It is used once, to create the first owner at `/admin/setup`. Delete the variable straight after; while admin users exist the server ignores it and logs a warning. To "rotate" it, set a fresh random value only for the moment you need setup on an empty database, then delete it again.

### Provider secrets

`INBOUND_WEBHOOK_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `RAZORPAY_KEY_SECRET`, `SMTP_URL` password, `GOOGLE_CLIENT_SECRET`, `SENTRY_DSN` and `BACKUP_S3_*`:

1. Create the new credential at the provider.
2. Update `due-shared` and redeploy.
3. Revoke the old credential.

Webhooks signed with the old secret fail with 401/400 during the switch. Providers retry, and `billing.reconcile` repairs any missed subscription state the next day.

### `BACKUP_ENCRYPTION_KEY`

Old dumps need the old key. Keep the old key in the password manager until the last dump encrypted with it has expired (30 days), then delete it.
