-- Multi-email identities and read-only Gmail OAuth (Agent B). Additive and forward-compatible:
-- new tables only, two nullable/defaulted columns on user_events, and two CHECK constraints widened in place.
-- Rollback: DROP TABLE gmail_scan_runs, gmail_messages_seen, oauth_states, gmail_connections, email_identities CASCADE;
-- ALTER TABLE user_events DROP COLUMN identity_id, DROP COLUMN source_meta; (after deleting intake_type='gmail' rows).

CREATE TABLE email_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('gmail','work','family','forwarding')),
  label text NOT NULL DEFAULT '' CHECK (char_length(label) <= 80),
  email text NOT NULL CHECK (email = lower(email) AND char_length(email) <= 254),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','disconnected','error')),
  -- Machine-readable reason for 'error' (e.g. scope_mismatch, token_revoked) or 'disconnected'.
  status_reason text,
  consent_version text,
  consented_at timestamptz,
  revoked_at timestamptz,
  attachments_enabled boolean NOT NULL DEFAULT false,
  -- Optional extra Gmail sender/domain filters (e.g. 'netflix.com'); validated by the API.
  sender_filters text[] NOT NULL DEFAULT '{}',
  last_scan_at timestamptz,
  last_scan_status text CHECK (last_scan_status IN ('ok','error','cancelled')),
  last_scan_error_code text,
  -- Per-identity scan lock: set while a scan runs (stale after 30 minutes).
  scan_running_since timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, kind, email)
);
CREATE INDEX email_identities_account_idx ON email_identities(account_id, created_at);

-- OAuth tokens: AES-256-GCM ciphertext under GMAIL_TOKEN_KEYS[token_kid], bound to identity_id (AAD).
CREATE TABLE gmail_connections (
  identity_id uuid PRIMARY KEY REFERENCES email_identities(id) ON DELETE CASCADE,
  google_sub text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  token_kid text,
  access_token_enc text,
  refresh_token_enc text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  -- A revoked connection holds no token material.
  CHECK (revoked_at IS NULL OR (access_token_enc IS NULL AND refresh_token_enc IS NULL))
);

-- OAuth state: only an HMAC of the state value is stored; single use, 10-minute expiry.
CREATE TABLE oauth_states (
  state_hash text PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  code_verifier_enc text NOT NULL,
  verifier_kid text NOT NULL,
  redirect_uri text NOT NULL,
  consent_version text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  CHECK (expires_at > created_at AND expires_at <= created_at + interval '10 minutes')
);
CREATE INDEX oauth_states_expiry_idx ON oauth_states(expires_at);
CREATE INDEX oauth_states_account_idx ON oauth_states(account_id, created_at);

-- Gmail message ids already processed per identity (no content).
CREATE TABLE gmail_messages_seen (
  identity_id uuid NOT NULL REFERENCES email_identities(id) ON DELETE CASCADE,
  gmail_message_id text NOT NULL,
  fingerprint text,
  seen_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (identity_id, gmail_message_id)
);
CREATE INDEX gmail_messages_seen_fp_idx ON gmail_messages_seen(identity_id, fingerprint);

-- Visible scan status (the durable job itself lives in jobs_queue).
CREATE TABLE gmail_scan_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  identity_id uuid NOT NULL REFERENCES email_identities(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('initial','manual','scheduled')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled','skipped')),
  job_id text,
  requested_at timestamptz NOT NULL,
  started_at timestamptz,
  finished_at timestamptz,
  messages_listed integer NOT NULL DEFAULT 0,
  messages_new integer NOT NULL DEFAULT 0,
  events_created integer NOT NULL DEFAULT 0,
  duplicates integer NOT NULL DEFAULT 0,
  attachments_skipped integer NOT NULL DEFAULT 0,
  error_code text
);
CREATE INDEX gmail_scan_runs_identity_idx ON gmail_scan_runs(identity_id, requested_at DESC);

-- Gmail-derived review candidates live in user_events with intake_type 'gmail'.
ALTER TABLE user_events ADD COLUMN identity_id uuid REFERENCES email_identities(id) ON DELETE SET NULL;
ALTER TABLE user_events ADD COLUMN source_meta jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX user_events_identity_idx ON user_events(identity_id) WHERE identity_id IS NOT NULL;

-- Widen two CHECK constraints in place, preserving any values another migration (e.g. 006) added.
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'user_events'::regclass AND conname = 'user_events_intake_type_check';
  IF def IS NOT NULL AND position('''gmail''' IN def) = 0 AND position('ARRAY[' IN def) > 0 THEN
    ALTER TABLE user_events DROP CONSTRAINT user_events_intake_type_check;
    EXECUTE 'ALTER TABLE user_events ADD CONSTRAINT user_events_intake_type_check ' || replace(def, 'ARRAY[', 'ARRAY[''gmail''::text, ');
  END IF;

  SELECT pg_get_constraintdef(oid) INTO def FROM pg_constraint
   WHERE conrelid = 'consent_records'::regclass AND conname = 'consent_records_purpose_check';
  IF def IS NOT NULL AND position('''gmail''' IN def) = 0 AND position('ARRAY[' IN def) > 0 THEN
    ALTER TABLE consent_records DROP CONSTRAINT consent_records_purpose_check;
    EXECUTE 'ALTER TABLE consent_records ADD CONSTRAINT consent_records_purpose_check ' || replace(def, 'ARRAY[', 'ARRAY[''gmail''::text, ');
  END IF;
END $$;
