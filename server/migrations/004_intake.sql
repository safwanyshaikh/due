-- No-auth intake: temporary sessions, unique forwarding aliases, private user events (forwarded email,
-- shared SMS, document text, manual), parser templates, consent records and private offer matches.

CREATE TABLE intake_temp_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  claimed_by uuid REFERENCES consumer_accounts(id) ON DELETE SET NULL,
  claimed_at timestamptz
);
CREATE INDEX intake_temp_sessions_expiry_idx ON intake_temp_sessions(expires_at) WHERE claimed_at IS NULL;

CREATE TABLE intake_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  alias text NOT NULL UNIQUE CHECK (alias ~ '^u[a-z2-7]{5}$'),
  -- Owners are SET NULL on deletion so retired aliases stay as tombstones and are never re-issued.
  account_id uuid REFERENCES consumer_accounts(id) ON DELETE SET NULL,
  temp_session_id uuid REFERENCES intake_temp_sessions(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','rotated')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (status = 'rotated' OR account_id IS NOT NULL OR temp_session_id IS NOT NULL)
);
-- At most one usable (active or paused) alias per owner.
CREATE UNIQUE INDEX intake_aliases_account_live ON intake_aliases(account_id) WHERE status <> 'rotated' AND account_id IS NOT NULL;
CREATE UNIQUE INDEX intake_aliases_temp_live ON intake_aliases(temp_session_id) WHERE status <> 'rotated' AND account_id IS NULL;

CREATE TABLE provider_parser_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_domain text NOT NULL CHECK (sender_domain = lower(sender_domain)),
  message_class text NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sender_domain, message_class, version)
);

CREATE TABLE user_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  temp_session_id uuid REFERENCES intake_temp_sessions(id) ON DELETE CASCADE,
  alias_id uuid REFERENCES intake_aliases(id) ON DELETE SET NULL,
  intake_type text NOT NULL CHECK (intake_type IN ('forwarded_email','document','shared_sms','manual')),
  message_fingerprint text,
  message_id_hash text,
  source_domain text,
  extracted_fields jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_status text NOT NULL DEFAULT 'needs_review'
    CHECK (review_status IN ('needs_review','confirmed','ignored','deleted','unreadable')),
  -- AES-256-GCM ciphertext ("v1:<base64 iv|tag|ct>"); NULL when no key is configured or after purge/delete.
  raw_text text,
  raw_retention_until timestamptz,
  parser_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (account_id IS NOT NULL OR temp_session_id IS NOT NULL)
);
CREATE INDEX user_events_account_idx ON user_events(account_id, created_at DESC);
CREATE INDEX user_events_temp_idx ON user_events(temp_session_id, created_at DESC);
CREATE INDEX user_events_raw_purge_idx ON user_events(raw_retention_until) WHERE raw_text IS NOT NULL;

CREATE TABLE consent_records (
  id bigserial PRIMARY KEY,
  account_id uuid REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  temp_session_id uuid REFERENCES intake_temp_sessions(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('email_intake','document_parsing','reminders_email','telemetry','sync_backup')),
  granted boolean NOT NULL,
  text_version text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  CHECK (account_id IS NOT NULL OR temp_session_id IS NOT NULL)
);
CREATE INDEX consent_records_account_idx ON consent_records(account_id, purpose, at DESC);

-- Private link between a user's confirmed event and a public offer. Public tables never receive user content.
CREATE TABLE offer_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  temp_session_id uuid REFERENCES intake_temp_sessions(id) ON DELETE CASCADE,
  user_event_id uuid NOT NULL REFERENCES user_events(id) ON DELETE CASCADE,
  offer_id text NOT NULL REFERENCES offers(id) ON DELETE CASCADE,
  match_basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  eligibility_status text NOT NULL DEFAULT 'unconfirmed' CHECK (eligibility_status IN ('unconfirmed','confirmed','not_eligible')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_event_id, offer_id)
);

ALTER TABLE jobs DROP CONSTRAINT jobs_id_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_id_check
  CHECK (id IN ('monitor_sources','retry_failed','retention_cleanup','consumer_reminders','intake_purge'));
INSERT INTO jobs (id, enabled, interval_minutes, config) VALUES ('intake_purge', true, 60, '{}');
