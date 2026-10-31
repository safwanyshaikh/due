# Rollback and migration recovery

## Principles

- **Migrations are additive and forward-compatible.** They add new tables and nullable or defaulted columns, and widen CHECK constraints. The *previous* release keeps working against the *new* schema, so a code rollback never needs a schema rollback.
- Destructive changes (drop, rename, narrowing a constraint) ship in two releases. The first release stops using the column or table; a later migration removes it, and only after a verified backup (`BACKUP.md`).
- `migrate` holds `pg_advisory_lock(724190001)`. Each file runs in its own transaction, so a failed migration leaves the database exactly as it was before that file.

## Roll back a bad deploy (code)

1. Render dashboard > `due` > Events, pick the last good deploy, then **Rollback**. Do the same for `due-worker` and choose the deploy from the **same commit**. Both services must run the same code, because job payloads and handlers move together.
   - From the CLI or API: `render deploys list <service-id>`, then trigger a deploy of the previous commit. Alternatively, revert the commit on `main` and let auto-deploy run, which is slower but leaves an audit trail.
2. Rolled-back code ignores newer columns and tables. Jobs whose type the old worker does not know stay `queued`: workers only claim types they have handlers for, so nothing goes dead. They run after you roll forward again.
3. Check `/health/ready`, Admin > Health and the queue stats. Post or clear the incident banner as needed (`RUNBOOK.md`).
4. Turn off auto-deploy on both services while the fix is prepared, if it might redeploy the bad commit.

## A migration failed during deploy

- The web start command (`migrate && seed && start`) exits, so Render keeps the **previous deploy serving** and the new one is marked failed. The failed file was rolled back in full by its transaction, and `schema_migrations` does not list it.
- Read the error in the deploy logs (`Migration NNN_x.sql failed: …`).
- Fix the SQL in a new commit and deploy again. Never edit a migration that has already been applied in production; add a new numbered file instead.

## A migration succeeded but caused harm

Choose in this order:

1. **Roll the code back** (above). Additive schema changes are harmless to the old code.
2. **Repair forward** with a new migration (for example, restore a dropped default or fix data). Run it first against a restored copy of production.
3. **Undo the schema change manually.** Each migration's header documents its rollback statements. For example, `006_platform.sql` adds only new tables, columns and triggers, and the consent v2 change maps legacy purpose names, which can be reversed with `UPDATE consent_records SET purpose = 'email_intake' WHERE purpose = 'forwarding'` and so on. Then delete the row from `schema_migrations` **only if** you have fully reversed the file.
4. **Restore from backup** (`BACKUP.md`) into a new database and switch `DATABASE_URL`. This is the last resort: you lose writes made since the backup, up to the RPO.

### Rollback notes for 006_platform.sql (Platform)

All of these are additive:

- `jobs_queue`, `queue_heartbeats`, `inbound_messages`, `notification_preferences`, `reminder_reconcile_runs`, `deletion_requests`, `upload_counters`
- New columns on `consent_records`, `reminder_schedule`, `reminder_deliveries` and `billing_events`
- Widened CHECK constraints (consent purposes, delivery statuses, account status `deleting`, job ids)
- Two consent triggers

Manual reversal, after rolling the code back:

```sql
DROP TRIGGER consent_records_v2_fill ON consent_records; DROP FUNCTION consent_records_v2_fill();
DROP TRIGGER consent_records_v2_revoke ON consent_records; DROP FUNCTION consent_records_v2_revoke();
UPDATE consent_records SET purpose = CASE purpose WHEN 'forwarding' THEN 'email_intake' WHEN 'documents' THEN 'document_parsing'
  WHEN 'analytics' THEN 'telemetry' ELSE purpose END;
DELETE FROM consent_records WHERE purpose NOT IN ('email_intake','document_parsing','reminders_email','telemetry','sync_backup');
-- Re-add the old purpose CHECK, then drop the new tables only after exporting anything needed (deletion_requests!).
```

Before dropping `jobs_queue`, make sure no `account.delete` job is still pending. Deletion requests must finish.

## After any rollback

- Retry the dead jobs the bad release produced (Admin > Queue).
- Run `reminder_reconcile` (Admin > Jobs > Run) so missed reminders are queued again.
- Write it up in the incident note (`RUNBOOK.md`).
