-- Platform (launch): durable job queue, worker heartbeats, minimal inbound message store, consent v2,
-- notification preferences and delivery records, asynchronous account deletion and monthly upload counters.
-- Additive and forward-compatible: existing columns keep their meaning; new columns have defaults.
-- Rollback / recovery: docs/production/ROLLBACK.md ("Rollback notes for 006_platform.sql").

-- ---- Durable queue ----------------------------------------------------------------------------------
-- payload never holds raw mail, documents, tokens or secrets: only ids and small parameters.
CREATE TABLE jobs_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL CHECK (type ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$'),
  account_id uuid,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key text UNIQUE,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','dead')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 50),
  run_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  locked_by text,
  last_error_code text,
  last_error_message text,
  correlation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- 'failed' means "failed this attempt, waiting for its retry at run_at"; 'dead' is terminal.
CREATE INDEX jobs_queue_claim_idx ON jobs_queue(run_at, id) WHERE status IN ('queued','failed');
CREATE INDEX jobs_queue_running_idx ON jobs_queue(started_at) WHERE status = 'running';
CREATE INDEX jobs_queue_status_idx ON jobs_queue(status, created_at DESC);
CREATE INDEX jobs_queue_account_idx ON jobs_queue(account_id) WHERE account_id IS NOT NULL;

-- One row per worker process; readiness requires a beat in the last 2 minutes.
CREATE TABLE queue_heartbeats (
  worker_id text PRIMARY KEY,
  hostname text,
  started_at timestamptz NOT NULL,
  beat_at timestamptz NOT NULL,
  jobs_processed bigint NOT NULL DEFAULT 0
);

-- ---- Inbound email: minimal message held only until inbound.parse runs ------------------------------
-- body is AES-256-GCM ("v1:...") when DATA_ENCRYPTION_KEY is set; otherwise "plain:..." and it is wiped as
-- soon as the parse job finishes (and by retention.purge after 24 hours at the latest).
CREATE TABLE inbound_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias_id uuid REFERENCES intake_aliases(id) ON DELETE SET NULL,
  account_id uuid REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('postmark','mailgun')),
  message_id_hash text,
  sender_domain text,
  subject text,
  body text,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','processed','duplicate','rejected','failed')),
  error_code text,
  user_event_id uuid REFERENCES user_events(id) ON DELETE SET NULL,
  received_at timestamptz NOT NULL,
  processed_at timestamptz
);
CREATE UNIQUE INDEX inbound_messages_dedupe ON inbound_messages(account_id, message_id_hash) WHERE message_id_hash IS NOT NULL;
CREATE INDEX inbound_messages_body_idx ON inbound_messages(received_at) WHERE body IS NOT NULL;

-- ---- Consent v2 -------------------------------------------------------------------------------------
-- consent_records stays an append-only log. Each row is a grant or a withdrawal for one purpose; a grant row
-- gets revoked_at when a later withdrawal supersedes it. Legacy purposes are mapped to the v2 names.
ALTER TABLE consent_records DROP CONSTRAINT IF EXISTS consent_records_purpose_check;
UPDATE consent_records SET purpose = CASE purpose
  WHEN 'email_intake' THEN 'forwarding'
  WHEN 'document_parsing' THEN 'documents'
  WHEN 'telemetry' THEN 'analytics'
  ELSE purpose END;
ALTER TABLE consent_records ADD CONSTRAINT consent_records_purpose_check CHECK (purpose IN (
  'account','gmail','forwarding','documents','reminders_email','reminders_push','analytics',
  'offer_personalisation','household','sync_backup'));
ALTER TABLE consent_records
  ADD COLUMN policy_version text,
  ADD COLUMN scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN source text NOT NULL DEFAULT 'app' CHECK (source IN ('app','admin','import','system','email_link','oauth')),
  ADD COLUMN granted_at timestamptz,
  ADD COLUMN revoked_at timestamptz;
UPDATE consent_records SET policy_version = text_version, granted_at = CASE WHEN granted THEN at END;
UPDATE consent_records g SET revoked_at = (
  SELECT min(w.at) FROM consent_records w
   WHERE w.purpose = g.purpose AND NOT w.granted AND w.at >= g.at AND w.id > g.id
     AND w.account_id IS NOT DISTINCT FROM g.account_id AND w.temp_session_id IS NOT DISTINCT FROM g.temp_session_id)
 WHERE g.granted;
ALTER TABLE consent_records ALTER COLUMN policy_version SET NOT NULL;

-- The state machine holds whoever writes the row (older code paths insert only text_version):
-- policy_version defaults to text_version, a grant gets granted_at, and a withdrawal closes the open grant.
CREATE FUNCTION consent_records_v2_fill() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.policy_version := COALESCE(NEW.policy_version, NEW.text_version);
  IF NEW.granted THEN
    NEW.granted_at := COALESCE(NEW.granted_at, NEW.at);
    NEW.revoked_at := NULL;
  ELSE
    NEW.granted_at := NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER consent_records_v2_fill BEFORE INSERT ON consent_records
  FOR EACH ROW EXECUTE FUNCTION consent_records_v2_fill();

CREATE FUNCTION consent_records_v2_revoke() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.granted THEN
    UPDATE consent_records SET revoked_at = NEW.at
     WHERE purpose = NEW.purpose AND granted AND revoked_at IS NULL AND id <> NEW.id
       AND account_id IS NOT DISTINCT FROM NEW.account_id AND temp_session_id IS NOT DISTINCT FROM NEW.temp_session_id;
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER consent_records_v2_revoke AFTER INSERT ON consent_records
  FOR EACH ROW EXECUTE FUNCTION consent_records_v2_revoke();

-- ---- Notifications ----------------------------------------------------------------------------------
CREATE TABLE notification_preferences (
  account_id uuid NOT NULL REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('email','push')),
  enabled boolean NOT NULL DEFAULT true,
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  quiet_start text CHECK (quiet_start ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  quiet_end text CHECK (quiet_end ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  snooze_until timestamptz,
  disabled_via text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, channel)
);

-- Reminder rows are "closed" once a final outcome is recorded; delivered_at is only ever set on SMTP acceptance.
ALTER TABLE reminder_schedule
  ADD COLUMN closed_at timestamptz,
  ADD COLUMN final_status text CHECK (final_status IN ('sent','failed','unavailable','suppressed','legacy')),
  ADD COLUMN deliver_after timestamptz,
  ADD COLUMN queued_at timestamptz,
  ADD COLUMN queue_round integer NOT NULL DEFAULT 0;
UPDATE reminder_schedule SET closed_at = delivered_at, final_status = 'legacy' WHERE delivered_at IS NOT NULL;
CREATE INDEX reminder_schedule_open_idx ON reminder_schedule(remind_at) WHERE closed_at IS NULL;

ALTER TABLE reminder_deliveries DROP CONSTRAINT IF EXISTS reminder_deliveries_status_check;
ALTER TABLE reminder_deliveries ADD CONSTRAINT reminder_deliveries_status_check
  CHECK (status IN ('scheduled','sending','sent','failed','unavailable','suppressed'));
ALTER TABLE reminder_deliveries
  ADD COLUMN reminder_id bigint REFERENCES reminder_schedule(id) ON DELETE SET NULL,
  ADD COLUMN job_id uuid,
  ADD COLUMN retry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN failure_reason text,
  ADD COLUMN due_date date,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
-- A schedule row is sent at most once.
CREATE UNIQUE INDEX reminder_deliveries_sent_once ON reminder_deliveries(reminder_id) WHERE status = 'sent';

CREATE TABLE reminder_reconcile_runs (
  id bigserial PRIMARY KEY,
  run_at timestamptz NOT NULL,
  missed integer NOT NULL,
  failed integer NOT NULL,
  -- ids only (reminder id, account id, reason): never titles or amounts.
  details jsonb NOT NULL DEFAULT '[]'::jsonb
);

-- ---- Account deletion (asynchronous) ----------------------------------------------------------------
ALTER TABLE consumer_accounts DROP CONSTRAINT IF EXISTS consumer_accounts_status_check;
ALTER TABLE consumer_accounts ADD CONSTRAINT consumer_accounts_status_check CHECK (status IN ('active','disabled','deleting'));

CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Not a foreign key: the request outlives the account so progress stays visible.
  account_id uuid,
  status_token_hash text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','completed','failed')),
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  job_id uuid,
  requested_at timestamptz NOT NULL,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text
);
CREATE INDEX deletion_requests_account_idx ON deletion_requests(account_id, requested_at DESC);

-- ---- Monthly document upload counter (Free: 5 a month) ----------------------------------------------
CREATE TABLE upload_counters (
  account_id uuid NOT NULL REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  month text NOT NULL CHECK (month ~ '^\d{4}-\d{2}$'),
  count integer NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, month)
);

-- ---- Billing webhook audit: refunds are recorded with their payment id -------------------------------
ALTER TABLE billing_events ADD COLUMN payment_id text, ADD COLUMN outcome text;

-- ---- Scheduler entries that enqueue daily queue jobs -------------------------------------------------
ALTER TABLE jobs DROP CONSTRAINT jobs_id_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_id_check
  CHECK (id IN ('monitor_sources','retry_failed','retention_cleanup','consumer_reminders','intake_purge',
                'reminder_reconcile','billing_reconcile'));
INSERT INTO jobs (id, enabled, interval_minutes, config) VALUES
  ('reminder_reconcile', true, 1440, '{}'),
  ('billing_reconcile', true, 1440, '{}')
ON CONFLICT (id) DO NOTHING;
