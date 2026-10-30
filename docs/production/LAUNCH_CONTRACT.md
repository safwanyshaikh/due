# Launch build contract (shared by all agents)

Spec: `docs/production/LAUNCH_SPEC.md` is the source of truth. It overrides REDESIGN_SPEC where they conflict. In particular, the eight category tiles return to Home's first viewport.

## Ownership (edit only your own areas)

| Agent | Owns |
| --- | --- |
| A Platform | `server/src/queue/**`, `server/src/health/**`, `server/src/observability/**`, `server/src/consumer/{notifications,billing-reconcile,deletion}.ts`, `server/src/legal/**`, `server/migrations/006_*.sql`, `server/scripts/**` (backup/restore), `.github/workflows/**`, `render.yaml`, `docs/production/{RUNBOOK,BACKUP,ROLLBACK,SECURITY}.md` |
| B Gmail and identities | `server/src/gmail/**`, `server/src/identities/**`, `server/src/routes/{gmail,identities}.ts`, `server/migrations/007_*.sql`, `src/lib/account/{gmail,identities}.ts` (client wrappers), `docs/production/GOOGLE_VERIFICATION.md` |
| C UI | `src/ui/**`, `src/content/**`, `public/**`, `index.html`, root `package.json`/`vite.config.ts`/`playwright.config.ts`, `e2e/**`. Calls the endpoints below through the client wrappers. |
| D Offer intelligence and admin | `server/src/monitor/**`, `server/src/catalog.ts`, `server/src/routes/admin/{offers,review,integrations,privacy,incidents}.ts`, `server/migrations/008_*.sql`, `admin/**` |

Shared files that several agents may append to (make small, additive edits and re-read before editing): `server/src/app.ts` (route registration), `server/src/routes/admin/index.ts`, `server/src/config.ts`, `server/.env.example`, `src/lib/account/client.ts`, `src/lib/account/types.ts`.

Migrations: A = 006, B = 007, D = 008. Each must be additive and forward-compatible.

## Durable queue (A implements; B and D use it)

`server/src/queue/index.ts` exports:

```ts
enqueue(db, { type, payload, accountId?, idempotencyKey?, runAt?, maxAttempts? = 5 }): Promise<{ id, deduped: boolean }>
registerHandler(type: string, handler: (job: JobContext) => Promise<void>): void
```

`JobContext` is `{ id, type, payload, accountId, attempt, correlationId, log }`. The log redacts its payload; never log raw mail, documents, tokens or secrets.

- **Table** `jobs_queue`: id, type, account_id, payload jsonb (no raw content), idempotency_key UNIQUE, status (`queued | running | succeeded | failed | dead`), attempts, max_attempts, run_at, started_at, finished_at, last_error_code, last_error_message (redacted), correlation_id, created_at.
- **Worker:** claims jobs with `FOR UPDATE SKIP LOCKED`, retries with exponential backoff, and dead-letters after `max_attempts`.
- **Admin endpoints:**
  - `GET /api/admin/queue?status=`
  - `POST /api/admin/queue/:id/retry`
  - `GET /api/admin/queue/stats`
- **Job types that exist** (handlers registered by their owners): `gmail.scan` (B), `inbound.parse` (A moves the existing inbound parsing here), `reminder.deliver` (A), `reminder.reconcile` (A, daily), `retention.purge` (A), `account.delete` (A, asynchronous with progress), `offers.refresh` (D, per source), `billing.reconcile` (A, daily).

## Health (A)

- `GET /health/live` returns `{ ok: true }` (process only).
- `GET /health/ready` checks the database and the queue (worker heartbeat under 2 minutes). Returns 503 if either fails.
- `GET /api/admin/health/integrations` (admin auth) returns a separate entry for each of: db, queue, encryption, smtp, inbound, gmail_oauth, ocr/storage, billing, error_tracking. Each entry is `{ status: 'ok' | 'not_configured' | 'degraded' | 'error', detail }`.
- Public `GET /api/public/status` returns `{ incident: null | { level, message, updatedAt }, integrations: { smtp, inbound, gmail, billing } }`. Each integration value is one of `'live' | 'test_mode' | 'verification_pending' | 'not_configured'`. The app uses this to label features honestly.

## Gmail and identities (B)

- `GET /api/account/identities` lists the user's identities: `[{ id, kind: 'gmail' | 'work' | 'family' | 'forwarding', label, email, status, consentVersion, lastScanAt, lastScanStatus, createdAt }]`.
- `POST /api/account/identities` creates a work, family or forwarding identity: `{ kind, label, email }` (Gmail is created through OAuth).
- `DELETE /api/account/identities/:id?deleteData=true|false`.
- **Gmail OAuth:**
  - `POST /api/account/gmail/connect { consentVersion }` returns `{ authorizeUrl }`, using state and PKCE with the redirect from `GOOGLE_REDIRECT_URI`.
  - `GET /api/account/gmail/callback` redirects to `/?gmail=connected | error`.
  - `POST /api/account/gmail/:identityId/scan` enqueues `gmail.scan`.
  - `POST /api/account/gmail/:identityId/disconnect { deleteImported }`.
  - `GET /api/account/gmail/status` returns `{ mode: 'not_configured' | 'test_mode' | 'verification_pending' | 'live', scopes: [...] }`.
- **Scope:** `https://www.googleapis.com/auth/gmail.readonly` (restricted). Document why: metadata-only scope cannot read bodies.
- **Token encryption:** tokens are encrypted with `GMAIL_TOKEN_KEYS`, a comma-separated list of `kid:base64key` where the first entry is current, which allows key rotation.
- **Scan results:** go into the existing `user_events` review queue with `intake_type 'gmail'`, deduplicated on (identity, gmail message id) and fingerprint.
- **Plan gating:** Gmail scanning and inbound forwarding are Plus features (server-side `requireFeature`). Free and guest users can upload with limits: 5 documents a month for Free and guests, unlimited on Plus. The limit is enforced server-side for signed-in users and locally for guests.

## Legal content (A: storage and API; C: pages)

- **Settings keys:** `legal.entity_name`, `legal.address`, `legal.grievance_officer_name`, `legal.grievance_email`, `legal.grievance_phone`, `legal.support_email`, `legal.incident_contact`, `legal.privacy_policy_md`, `legal.terms_md`, `legal.deletion_policy_md`, `legal.subprocessors` (a list of `{ name, purpose, region }`), `legal.effective_date`.
- `GET /api/public/legal` returns these values plus `complete: boolean`. `complete` is false while any required field is empty.
- **Launch gate:** the UI and the admin panel show "Legal details incomplete" until `complete` is true. Never ship placeholder grievance contacts as if they were real.
