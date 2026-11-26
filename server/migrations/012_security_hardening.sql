-- Security and privacy fix pass (audit 2026-11-25).

-- H1: per-email and per-IP login limits.
CREATE INDEX IF NOT EXISTS login_events_email_at_idx ON login_events(email, at);
CREATE INDEX IF NOT EXISTS login_events_ip_at_idx ON login_events(ip, at);
CREATE INDEX IF NOT EXISTS magic_links_email_created_idx ON magic_links(email, created_at);

-- H2: mandatory TOTP for admin users.
ALTER TABLE users
  ADD COLUMN totp_secret_enc text,
  ADD COLUMN totp_enrolled_at timestamptz,
  ADD COLUMN totp_last_step bigint;

CREATE TABLE admin_recovery_codes (
  id bigserial PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX admin_recovery_codes_user_idx ON admin_recovery_codes(user_id);

-- Password checked, second step pending (5 minutes, 5 attempts). Only a hash of the token is stored.
CREATE TABLE admin_mfa_challenges (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('verify','enrol')),
  pending_secret_enc text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  attempts int NOT NULL DEFAULT 0,
  used_at timestamptz
);
CREATE INDEX admin_mfa_challenges_user_idx ON admin_mfa_challenges(user_id);

-- Time of the last TOTP check on this session (re-authentication for owner/admin changes).
ALTER TABLE sessions ADD COLUMN mfa_at timestamptz;
-- Sessions opened before 2-step verification existed end now: every admin signs in (and enrols) again.
UPDATE sessions SET revoked_at = now() WHERE revoked_at IS NULL;

-- M8: 18+ self-declaration at sign-in is recorded as its own consent row (with the notice version).
ALTER TABLE consent_records DROP CONSTRAINT IF EXISTS consent_records_purpose_check;
ALTER TABLE consent_records ADD CONSTRAINT consent_records_purpose_check CHECK (purpose IN (
  'account','gmail','forwarding','documents','reminders_email','reminders_push','analytics',
  'offer_personalisation','household','sync_backup','age_18_plus'));

-- H4: audit rows go to an India-region write-once store (LOG_SINK_URL) every 15 minutes; admin sign-in
-- history is kept 365 days.
INSERT INTO jobs (id, enabled, interval_minutes, config) VALUES ('audit_ship', true, 15, '{}') ON CONFLICT (id) DO NOTHING;
UPDATE settings SET value = jsonb_set(value, '{login_events_days}', '365'::jsonb)
 WHERE key = 'retention' AND (value->>'login_events_days')::int < 365;
CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log(at);
CREATE INDEX IF NOT EXISTS consumer_audit_at_idx ON consumer_audit(at);
CREATE INDEX IF NOT EXISTS telemetry_events_at_idx ON telemetry_events(at);

-- H4: per-account breach notices sent from the admin console (no addresses or message text stored here).
CREATE TABLE breach_notifications (
  id bigserial PRIMARY KEY,
  incident_ref text NOT NULL,
  account_id uuid REFERENCES consumer_accounts(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('sent','failed','skipped')),
  sent_by uuid REFERENCES users(id) ON DELETE SET NULL,
  at timestamptz NOT NULL
);
CREATE INDEX breach_notifications_ref_idx ON breach_notifications(incident_ref, at);

-- M12: Mailgun webhook tokens are accepted once (the signature does not cover the body). Purged after a day.
CREATE TABLE webhook_replay_tokens (
  token_hash text PRIMARY KEY,
  seen_at timestamptz NOT NULL
);
CREATE INDEX webhook_replay_tokens_seen_idx ON webhook_replay_tokens(seen_at);

-- H3 (minimum): synced documents are sealed per account / per household (AES-256-GCM, key derived from
-- DATA_ENCRYPTION_KEY). Existing plain rows are sealed on their next read or write; `data` then holds '{}'.
ALTER TABLE account_data ADD COLUMN data_enc text;
ALTER TABLE household_data ADD COLUMN data_enc text;
