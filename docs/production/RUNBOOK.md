# Operations runbook

This page covers what to watch, what the alerts mean, and what on-call does. Services: `due` (web), `due-worker` (queue and scheduler) and `due-db` (Postgres 16), all on Render. See also `BACKUP.md`, `ROLLBACK.md` and `SECURITY.md`.

## Signals

| Signal | Where | Healthy |
| --- | --- | --- |
| Liveness | `GET /health/live` | `{ ok: true }` |
| Readiness | `GET /health/ready` | 200. The database answers and a worker heartbeat is under 2 minutes old. **Point uptime monitoring here** (for example Better Stack or UptimeRobot, every minute, alert after 3 failures). |
| Integrations | Admin > Health (`GET /api/admin/health/integrations`) | One entry each for db, queue, encryption, smtp, inbound, gmail_oauth, ocr_storage, billing and error_tracking. Each is `ok`, `not_configured`, `degraded` or `error`. `not_configured` is expected for integrations you have not set up. |
| Metrics | the same response, under `metrics` | Counters and timers since the process started: `http.requests{status}`, `http.errors_5xx`, `http.request_ms{route}`, `queue.jobs{type,status}`, `queue.job_ms{type}`, `queue.recovered_stale`, `notifications.delivery{status}`, `inbound.received`, `inbound.rejected{reason}`, `inbound.parse{outcome}`, `billing.webhook{outcome}`, `billing.reconcile{outcome}`. These are per process (web), so for worker-side counts use queue stats. |
| Queue | Admin > Queue (`GET /api/admin/queue/stats`, `GET /api/admin/queue?status=dead`) | `heartbeatFresh: true`, no `dead` jobs, `oldestDueSeconds` under 600 |
| Reminder reconciliation | `GET /api/admin/notifications/reconcile` plus an in-app alert | `missed: 0, failed: 0`. Runs daily, re-queues missed reminders and raises an important alert when anything is wrong. |
| Public status | `GET /api/public/status` | Shows the current incident banner and honest integration modes (live, test_mode, verification_pending or not_configured) |
| Logs | Render > service > Logs | Structured JSON. Each line has a `requestId` (also returned as the `x-request-id` header) or a `correlationId` for jobs. Secrets, cookies, tokens, mail text, subjects and amounts are redacted. |
| Errors | Sentry project (when `SENTRY_DSN` is set) | Reports are scrubbed. Search by the `correlation_id` tag. |

## Alert thresholds (configure in the uptime and error tools)

- `/health/ready` fails 3 times in a row: **page**. This means the worker is down or the database is unreachable.
- More than 5 HTTP 5xx in 5 minutes in Sentry or the logs: page.
- More than 0 dead jobs in the queue: ticket. More than 20 in 1 hour: page.
- Reminder reconciliation reports missed or failed reminders (in-app alert, emailed when admin notifications are on): ticket the same day.
- `smtp` degraded (failed reminder emails outnumber sent ones in 24 h): page during the day.
- `billing` degraded (rejected webhook signatures): investigate within 4 hours. This could be secret drift or someone probing the endpoint.
- Abuse: watch these in the logs and metrics. A spike in `rate_limited` responses on `/api/account/magic-link`; `inbound.rejected{reason=invalid_signature}` above 10 an hour; `inbound email: too many unknown aliases` warnings; Gmail scan failures (`gmail.scan` dead jobs); upload 402s above normal. Rate limits already apply per IP, per IP+email and per alias.

## Incident procedure

1. **Acknowledge** the page and open an incident note with times in UTC.
2. **Tell users** if they can see the problem:

   ```bash
   curl -X PATCH https://<host>/api/admin/incident -H 'content-type: application/json' \
     -H 'x-requested-with: due-admin' -H 'origin: https://<host>' --cookie 'due_session=…' \
     -d '{"level":"major","message":"Email reminders are delayed. Nothing is lost; they will be sent when service recovers."}'
   ```

   You can also set it from the admin panel when it offers an incident screen. Allowed levels are `info`, `minor`, `major` and `critical`. The app shows the banner from `/api/public/status`.
3. **Triage** with the playbooks below.
4. **Mitigate.** Prefer a rollback (`ROLLBACK.md`) over a hot fix.
5. **Recover.** Retry dead jobs (Admin > Queue > Retry, or `POST /api/admin/queue/:id/retry`) once the cause is fixed. Let the reconciliation re-queue missed reminders, or run it now (Admin > Jobs > reminder_reconcile > Run, then let the worker drain the queue).
6. **Clear the banner** with `PATCH /api/admin/incident {"clear": true}`.
7. **Postmortem** within 5 working days. If personal data may have been exposed, follow "Personal data incident" below.

## Playbooks

**Readiness 503 with `queue: error`.** The worker is down or stuck.
- Check Render > due-worker. Is it crashed or restarting? Read its logs.
- Restart it. Jobs it held are requeued automatically once its heartbeat is 2 minutes stale (`last_error_code = worker_lost`), and nothing is lost.
- Emergency only: set `RUN_QUEUE_WORKER=true` on the web service so the queue runs there until the worker is fixed.

**Readiness 503 with `db: error`.**
- Check Render > due-db (status, connections, disk). The API returns 503 and the queue pauses, so no work is lost while the database is down.
- If the data is corrupted or lost, restore it (`BACKUP.md`).

**Dead jobs piling up.**
- Group them with `GET /api/admin/queue?status=dead&type=…` and read `lastErrorCode` and `lastErrorMessage` (the message is redacted).
- `smtp_failed`: check the SMTP provider and its credentials. `provider_unreachable` (billing): check Razorpay status. `encryption_key_missing`: `DATA_ENCRYPTION_KEY` was removed. Put it back, because those messages cannot be read without it.
- After the fix, retry the affected jobs.

**Reminders not arriving.**
- Look at `/api/admin/notifications/reconcile` → `recentFailures` (it shows reasons such as `consent_required`, `channel_disabled`, `premium_required` or SMTP errors).
- A reminder is marked `sent` only after the SMTP server accepted it.
- Check the SMTP provider's activity log using the provider message id.

**Inbound forwarding failing.**
- Check `inbound` in the integrations view, `inbound.rejected{reason}` in metrics, and `inbound_messages.status` / `error_code` (no content is kept).
- Signature failures usually mean `INBOUND_WEBHOOK_SECRET` does not match the provider setting.

**Payments.**
- Webhooks are idempotent: each event id is stored once. `billing.reconcile` runs daily and repairs missed webhooks. To repair one subscription now, the person can use Restore in the app, or you can run `billing_reconcile` from Admin > Jobs.
- Never grant Plus because of a client-side success screen. Use a manual grant (audited) only after confirming the payment in the Razorpay dashboard.

**Personal data incident.**
- Contain it first: rotate secrets (`SECURITY.md`), revoke sessions, and pause intake with `INBOUND_WEBHOOK_SECRET` rotation.
- Record what data was affected, which accounts, and when.
- Notify within the required time. Under India's DPDP Act, report to the Data Protection Board and to affected users as the Rules require. The incident contact is the `legal.incident_contact` setting.
- Keep the evidence.

## On-call checklist (weekly)

- [ ] `/health/ready` green. No dead jobs older than 24 h.
- [ ] Reconciliation shows 0 missed and 0 failed (or each one explained).
- [ ] `npm audit` and the CI secret scan are green on main.
- [ ] Last backup in the bucket is under 25 h old. Restore drill run in the last 30 days (`BACKUP.md`).
- [ ] `GET /api/public/legal` returns `complete: true` (the launch gate).
