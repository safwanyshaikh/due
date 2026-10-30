# Due production backend: shared contract (source of truth for all agents)

Monorepo layout (each agent edits ONLY its own directory):
- `src/` + `src/lib/__tests__` — consumer PWA (existing). Owner: consumer agent.
- `server/` — Node 22 + TypeScript API, monitoring engine, migrations, tests. Owner: backend agent.
- `admin/` — React + Vite admin SPA, built to `admin/dist`, served by the server at `/admin/`. Owner: admin agent.
- `server/seed/registry.json` — vendor/source registry seed. Owner: research agent.
- `render.yaml`, `docs/production/*` — integrator (main session).

## Hard rules
- No mock, sample, demo or invented data in any production path. Empty states say: "Data unavailable", "Verification pending", "Source inaccessible", with last-checked time and reason.
- Every stored fact carries source URL, retrieved_at, extraction method, verification status.
- Never label polling as real-time. Respect robots.txt, rate limits, auth walls. No CAPTCHA/paywall bypass. User agent: `DueSourceMonitor/1.0 (+https://<public host>/about-monitoring)`.
- No default credentials. No secrets in git. No unauthenticated admin endpoints.

## Database (Postgres 16). Migrations: `server/migrations/NNN_name.sql`, applied by `npm run migrate` (tracked in `schema_migrations`).
users(id uuid pk, email text unique (lower-cased), name, password_hash, role ('owner'|'admin'|'editor'|'viewer'), status ('active'|'disabled'), created_at, last_login_at)
sessions(id_hash text pk = sha256(token), user_id, created_at, expires_at, last_seen_at, ip, user_agent, revoked_at)
login_events(id bigserial, user_id null, email, success bool, reason, ip, user_agent, at)
password_resets(token_hash pk, user_id, created_by, expires_at, used_at)
audit_log(id bigserial, actor_user_id null, action, entity_type, entity_id, before jsonb, after jsonb, ip, at)
categories(id uuid, name unique, description, created_at)
companies(id uuid, kind ('company'|'vendor'), name, slug unique, official_website, description, country, category_id null, status ('active'|'archived'), verification_status ('unverified'|'pending'|'verified'|'rejected'), verified_by null, verified_at null, verification_note, monitoring_enabled bool, created_at, updated_at)
sources(id uuid, company_id, url, label, source_category ('official_site'|'product_page'|'pricing'|'terms'|'press'|'news'|'rss'|'help'|'api'|'document'|'social'|'secondary'), is_official bool, extraction_method ('html_text'|'rss'|'json'|'sitemap'), css_selector null, priority ('critical'|'regular'|'secondary'), frequency_minutes int, enabled bool, status ('active'|'failing'|'blocked_robots'|'inaccessible'|'disabled'), next_check_at, last_checked_at, last_success_at, last_change_at, consecutive_failures int, last_error, created_at, updated_at, unique(company_id,url))
snapshots(id bigserial, source_id, fetched_at, http_status, content_hash, content_type, title, text_content (max 200k chars), etag, last_modified, bytes, duration_ms) — stored only when content_hash differs from the previous snapshot (version history).
fetch_runs(id bigserial, source_id, job_run_id null, started_at, finished_at, outcome ('changed'|'unchanged'|'error'|'skipped_robots'|'skipped_disabled'|'not_modified'), http_status, error, attempt)
records(id uuid, company_id, source_id, record_type ('page'|'rss_item'|'announcement'|'price_mention'), fingerprint, title, url, summary, published_at null, first_seen_at, last_seen_at, current_version int, verification_status ('pending'|'approved'|'rejected'), sensitive bool, reviewed_by, reviewed_at, review_note, unique(company_id,fingerprint))
record_versions(id bigserial, record_id, version, data jsonb, content_hash, snapshot_id null, change_type ('new'|'modified'|'manual_correction'), changed_by null, captured_at)
jobs(id text pk: 'monitor_sources'|'retry_failed'|'retention_cleanup', enabled, interval_minutes, last_run_at, next_run_at, config jsonb)
job_runs(id bigserial, job_id, triggered_by ('schedule'|'manual'), started_at, finished_at, status ('running'|'success'|'failed'), stats jsonb, error)
alerts(id bigserial, level ('info'|'important'), title, body, entity_type, entity_id, created_at, read_at)
settings(key pk, value jsonb, updated_by, updated_at). Keys: frequency_defaults {critical:1440, regular:10080, secondary:10080}, retry {base_minutes:30, max_minutes:1440, max_attempts_before_inaccessible:8}, retention {snapshots_days:365, login_events_days:180}, notifications {email_enabled:false, recipients:[]}, business {app_name:"Due", support_email:null}.
offers(id text pk, provider, product_family, name, benefit_type, price_inr null, billing_period null, benefit_value jsonb, source_ids uuid[]/source_urls text[], official_end_at null, terms_status, page_status, computed_status, confidence, notes text[], verification_status ('research_snapshot'|'pending'|'verified'|'rejected'), observed_at, last_confirmed_at, updated_at)

## Monitoring engine (server/src/monitor/)
- A source is due when enabled && company.monitoring_enabled && company.status='active' && next_check_at <= now(). Weekends are not skipped.
- Fetch: robots.txt (cached 24h per host; disallow → status blocked_robots, no fetch), per-host min gap 10s, timeout 20s, max 5 MB, conditional GET with ETag/Last-Modified.
- Extract: html_text → title + visible text (strip script/style/nav), optional css_selector; rss → items (title, link, pubDate, summary) each a record_type 'rss_item'; json → canonical JSON text.
- Change detection: content_hash = sha256(normalised text). Same hash → fetch_run 'unchanged', no new snapshot. Different → new snapshot, upsert records by fingerprint (sha256 of url+title for rss items; of source url for page records), new record_version only when record content hash changed. Alert level 'important' when a critical source changes or a source becomes inaccessible.
- Failures: consecutive_failures++, next_check_at = now + min(base*2^(n-1), max); after max_attempts → status 'inaccessible' (still retried at max interval, alert raised). Success resets.
- Scheduler: loop every 60s (RUN_SCHEDULER=true) picks due jobs from `jobs`, uses a Postgres advisory lock so only one instance runs a job. Manual run = same code path, triggered_by 'manual'.

## HTTP API (Fastify). JSON. Cookie session `due_session` (httpOnly, Secure in prod, SameSite=Strict, 12h idle / 7d max). Mutating requests require header `X-Requested-With: due-admin` and same-origin Origin check. Rate limit login 10/15min per IP+email.
Auth: POST /api/auth/setup {setupToken,email,name,password} — only when users table is empty AND env ADMIN_SETUP_TOKEN set; POST /api/auth/login {email,password}; POST /api/auth/logout; GET /api/auth/me → {id,email,name,role}; POST /api/auth/change-password {current,next}; POST /api/auth/reset {token,password}. Password: min 12 chars; hash with node:crypto scrypt (N=2^15) + random salt.
Roles: viewer=read; editor=viewer + companies/sources/records/review/run jobs; admin=editor + users(non-owner)/settings/jobs config/categories; owner=all.
Admin (prefix /api/admin, all require auth):
GET dashboard → {companies, vendors, activeSources, monitoredSources, newRecords7d, updatedRecords7d, failedFetches7d, pendingVerification, latestRuns[], automation:{jobs[]}} — all from SQL counts.
companies: GET ?kind=&q=&status= ; POST ; GET :id (with sources, recent records) ; PATCH :id ; POST :id/archive ; POST :id/verify {status,note}
sources: GET ?companyId=&status= ; POST ; PATCH :id ; POST :id/validate (one fetch, robots check, returns result, does not store unless changed) ; POST :id/run ; GET :id/runs ; GET :id/snapshots ; GET /snapshots/:id ; GET /snapshots/:id/diff?against=:otherId → {added[],removed[]} line diff
records: GET ?q=&status=&companyId=&type= ; GET :id (with versions) ; POST :id/review {decision:'approved'|'rejected',note} ; PATCH :id {title,summary,note} → manual_correction version
export: GET /api/admin/export/records.csv , records.json (approved + pending, with source attribution)
categories: GET, POST, PATCH :id, DELETE :id
users (admin+): GET ; POST {email,name,role} → returns one-time setup link (no password chosen by admin) ; PATCH :id {role,status} ; POST :id/reset-link ; POST :id/revoke-sessions ; GET /login-events ; GET /sessions
audit: GET ?entityType=&actor=
jobs: GET ; PATCH :id {enabled,interval_minutes} ; POST :id/run ; GET /job-runs?jobId=
alerts: GET ?unread=1 ; POST :id/read
settings: GET ; PATCH {key,value}
offers: GET ; POST ; PATCH :id
Public (no auth, cached 5 min, CORS allow-list from env PUBLIC_APP_ORIGIN): GET /api/public/catalog → {generatedAt, offers:[{...offer, sources:[{url,label,category,lastCheckedAt,status}]}]} ; GET /api/health → {ok, db, scheduler:{lastRunAt}}.
Errors: {error:{code,message}} with proper status codes. Validation with zod.

## Env
DATABASE_URL, SESSION_SECRET (≥32 chars), ADMIN_SETUP_TOKEN (one-time, remove after setup), PUBLIC_APP_ORIGIN, PUBLIC_BASE_URL, RUN_SCHEDULER (true/false), NODE_ENV. Optional: SMTP_URL (email alerts; without it alerts are in-app only).
