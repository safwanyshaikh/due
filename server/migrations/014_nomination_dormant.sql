-- DPDP gaps (26 Nov 2026): nominee (s.14) and dormant-account retention.

-- One nominee per account. The nominee's name, email and relationship are sealed (AES-256-GCM, scope
-- "nomination:<account id>") in data_enc; nothing about the nominee is stored in clear. Deleted with the account.
CREATE TABLE account_nominations (
  account_id uuid PRIMARY KEY REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  data_enc text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- Warning emails already sent for a dormant account. A row only counts while last_activity_at still equals the
-- account's latest activity; any later sign-in or sync makes the old warnings void (and the job removes them).
CREATE TABLE dormant_notices (
  account_id uuid NOT NULL REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  stage integer NOT NULL CHECK (stage IN (30, 7)),
  last_activity_at timestamptz NOT NULL,
  sent_at timestamptz NOT NULL,
  PRIMARY KEY (account_id, stage)
);

INSERT INTO jobs (id, enabled, interval_minutes, config) VALUES ('dormant_retention', true, 1440, '{}') ON CONFLICT (id) DO NOTHING;
