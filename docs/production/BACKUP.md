# Backups and disaster recovery

Owner: Platform (Agent A). This page covers the backup layers, how to restore, the pre-migration procedure, and the restore drill that was actually run.

## Targets

| | Target | How it is met |
| --- | --- | --- |
| **RPO** (maximum data loss) | **24 hours**. 1 hour with the optional hourly script. | Render's managed Postgres takes a daily snapshot. `server/scripts/backup.sh` can also run hourly from a cron job and upload an encrypted dump off Render (S3-compatible storage). |
| **RTO** (time to restore service) | **1 hour** | The restore drill below took about 1 s for a seeded database. On a paid plan Render restores a snapshot in minutes. The rest of the hour covers detecting the problem, deciding to restore, re-pointing `DATABASE_URL` and running smoke tests. |
| Retention | Render snapshots: whatever the database plan provides (confirm it in the dashboard and record it here). Off-site encrypted dumps: 30 days, set with a bucket lifecycle rule. | Deleted user data leaves the last backup within 30 days. The deletion screen states this exception. |

## Layers

1. **Render managed backups.** Daily and automatic. Point-in-time recovery depends on the database plan. You restore from Render dashboard > due-db > Recovery, which creates a *new* database. You then switch `DATABASE_URL`, or use Render's restore-in-place flow.
2. **Encrypted logical dumps.** These are independent of Render, and they are the only layer that protects you if the Render account itself is lost.
   - `server/scripts/backup.sh` runs `pg_dump --format=custom`. It then encrypts the dump with AES-256-CBC, using a PBKDF2-SHA256 key (200,000 iterations) derived from `BACKUP_ENCRYPTION_KEY`. An HMAC-SHA256 tag (`.hmac`) authenticates the ciphertext.
   - Uploads happen only when `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY_ID` and `BACKUP_S3_SECRET_ACCESS_KEY` are set. The upload uses curl's SigV4 signing (AWS S3, Cloudflare R2, Backblaze B2 and MinIO all work). Use a bucket with versioning and object lock, plus a lifecycle rule that deletes objects after 30 days. Give it write-only credentials.
   - `BACKUP_ENCRYPTION_KEY` must be at least 32 characters (`openssl rand -base64 33`). Store it in the password manager or secret store, **never** in the backup bucket. If the key is lost, every dump is unreadable.
   - Hourly schedule (optional, RPO 1 h): create a Render Cron Job that uses the worker's build, with schedule `7 * * * *` and command `bash server/scripts/backup.sh /tmp/backups`, plus the `due-shared` env group and `DATABASE_URL`.
3. **Restore drill.** `npm --prefix server run backup:verify` backs up, restores into a scratch database and compares exact row counts for every table. CI runs it on every push (job `server`). Run it against a production replica each month and before risky migrations.

## Restore

```bash
# 1. Fetch the dump and its tag (from the bucket, or from the local output directory).
# 2. Restore into a NEW, empty database first, and never straight over production:
BACKUP_ENCRYPTION_KEY=... TARGET_DATABASE_URL=postgres://.../due_restore \
  PG_BIN=/usr/lib/postgresql/16/bin bash server/scripts/restore.sh due-20261031T000917Z.dump.enc
# 3. Check it: row counts, a few account exports, SELECT max(applied_at) FROM schema_migrations.
# 4. Point DATABASE_URL (web + worker, or the due-shared group) at the restored database and redeploy both services.
```

`restore.sh` checks the HMAC before it decrypts anything. A wrong key or a tampered file exits with code 3 and changes nothing (both cases were tested; see below). The restore runs in a single transaction (`pg_restore --single-transaction --exit-on-error`).

## Before every production migration

Migrations are additive and forward-compatible by policy (see `ROLLBACK.md`). Even so:

1. Announce it in the incident banner if any downtime is possible: `PATCH /api/admin/incident {"level":"info","message":"Maintenance ..."}`.
2. **Take and verify a backup:**
   - Render dashboard > due-db > Backups > "Create backup" (on paid plans), **and**
   - `DATABASE_URL=<prod> BACKUP_ENCRYPTION_KEY=... bash server/scripts/backup.sh`
   - then restore that file into a scratch database with `restore.sh`, or run `backup:verify` with `SCRATCH_DATABASE_URL` set to a non-production database.
3. Deploy. `npm --prefix server run migrate` holds the **migration lock**: `pg_advisory_lock(724190001)` in `server/src/migrate.ts`. The web and worker services both run `migrate` on start, so only one of them applies a migration and the other waits, then finds nothing to do. Each migration file runs in its own transaction and is recorded in `schema_migrations`.
4. Watch `/health/ready`, `/api/admin/health/integrations` and the queue stats for 15 minutes.

## Restore drill results (run locally)

- Run: 2026-10-31 00:09 UTC, Postgres 16.15, `npm run backup:verify`
- Source database: all migrations 001–008, the seeded registry, and synthetic load (250 accounts with sync data, 250 reminders, 250 consent records and 250 queue rows)

```
backup: dumping database (custom format)
backup: encrypting (AES-256, PBKDF2) and signing (HMAC-SHA256)
backup: wrote /tmp/tmp.p1eR5l0o4v/due-20261031T000917Z.dump.enc (210192 bytes)
restore: integrity tag verified
restore: decrypted; restoring into target
restore: done
backup:verify: due-20261031T000917Z.dump.enc 210192 bytes; backup 0s, restore 1s
backup:verify: OK - 57 tables, 1448 rows, every table count matches
table                                  rows
account_data                            250
alerts                                    0
audit_log                                30
billing_events                            0
billing_subscriptions                     0
categories                                0
companies                                30
consent_records                         250
consumer_accounts                       250
consumer_audit                            0
consumer_sessions                         0
deletion_requests                         0
email_identities                          0
entitlements                              0
fetch_runs                                0
gmail_connections                         0
gmail_messages_seen                       0
gmail_scan_runs                           0
household_data                            0
household_invites                         0
household_members                         0
households                                0
inbound_messages                          0
intake_aliases                            0
intake_temp_sessions                      0
job_runs                                  0
jobs                                      9
jobs_queue                              250
login_events                              0
magic_links                               0
notification_preferences                  0
oauth_states                              0
offer_matches                             0
offer_observations                        0
offer_review_queue                        0
offer_status_transitions                  0
offers                                   22
parser_versions                           0
password_resets                           0
plans                                     3
provider_parser_templates                 0
queue_heartbeats                          0
record_versions                           0
records                                   0
reminder_deliveries                       0
reminder_reconcile_runs                   0
reminder_schedule                       250
schema_migrations                         8
sessions                                  0
settings                                  0
snapshots                                 0
sources                                  96
telemetry_events                          0
upload_counters                           0
user_events                               0
users                                     0
vendor_intel                              0
```

Negative tests on the same build:

```
$ BACKUP_ENCRYPTION_KEY=<wrong> TARGET_DATABASE_URL=... restore.sh due-....dump.enc
restore: HMAC mismatch (wrong key or tampered file); aborting      (exit 3, target untouched: 0 tables)
$ printf x >> due-....dump.enc; restore.sh due-....dump.enc       (correct key)
restore: HMAC mismatch (wrong key or tampered file); aborting      (exit 3)
```

**Status:** a backup restores with matching row counts, which is proven locally and in CI on every push. Still to do before commercial launch: run `backup:verify` against a copy of the **production** database once the Render database exists, then record the date and table/row totals here. Also confirm the Render plan's backup retention, and set up the off-site bucket with its lifecycle rule.
