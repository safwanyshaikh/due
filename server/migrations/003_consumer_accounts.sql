-- Consumer accounts (separate from admin users): passwordless email sign-in, device sessions,
-- backup/sync, household sharing, entitlements, synced reminders and allow-listed telemetry.

CREATE TABLE consumer_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled'))
);

-- Session tokens are stored only as an HMAC (keyed with SESSION_SECRET). public_id is the
-- non-secret handle used by the device list / revoke endpoints.
CREATE TABLE consumer_sessions (
  id_hash text PRIMARY KEY,
  public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  device_label text,
  user_agent text,
  ip text,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX consumer_sessions_account_idx ON consumer_sessions(account_id);

CREATE TABLE magic_links (
  token_hash text PRIMARY KEY,
  email text NOT NULL CHECK (email = lower(email)),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  ip text
);
CREATE INDEX magic_links_email_idx ON magic_links(email, created_at DESC);

-- Personal backup / multi-device sync document with optimistic concurrency (version).
CREATE TABLE account_data (
  account_id uuid PRIMARY KEY REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE households (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_account_id uuid NOT NULL UNIQUE REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One household membership per account keeps shared-data access unambiguous.
CREATE TABLE household_members (
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  account_id uuid NOT NULL UNIQUE REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner','member')),
  invited_email text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (household_id, account_id)
);

CREATE TABLE household_invites (
  token_hash text PRIMARY KEY,
  household_id uuid NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  email text NOT NULL CHECK (email = lower(email)),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX household_invites_household_idx ON household_invites(household_id);

CREATE TABLE household_data (
  household_id uuid PRIMARY KEY REFERENCES households(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 0 CHECK (version >= 0),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by uuid REFERENCES consumer_accounts(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Prices are product hypotheses (Plus Rs 149/1,299; Household Rs 249/2,199) and are editable by admins.
-- provider_plan_ids holds the Razorpay plan ids for each cadence; checkout is unavailable until they are set.
CREATE TABLE plans (
  id text PRIMARY KEY CHECK (id IN ('free','plus','household')),
  name text NOT NULL,
  price_inr_monthly numeric(10,2),
  price_inr_yearly numeric(10,2),
  active boolean NOT NULL DEFAULT true,
  features jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_plan_ids jsonb NOT NULL DEFAULT '{}'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO plans (id, name, price_inr_monthly, price_inr_yearly, active, features, sort_order) VALUES
  ('free', 'Free', NULL, NULL, true,
   '["manual_obligations","upcoming_view","basic_reminders","csv_export","local_data","backup","multi_device"]', 0),
  ('plus', 'Plus', 149, 1299, true,
   '["manual_obligations","upcoming_view","basic_reminders","csv_export","local_data","backup","multi_device",
     "reminder_email","email_import","statement_import","calendar_sync","advanced_recurrence",
     "reconciliation_history","multi_channel","cancellation_guidance","verified_evidence"]', 1),
  ('household', 'Household', 249, 2199, false, -- not sold until household sharing works end to end (see 005)
   '["manual_obligations","upcoming_view","basic_reminders","csv_export","local_data","backup","multi_device",
     "reminder_email","email_import","statement_import","calendar_sync","advanced_recurrence",
     "reconciliation_history","multi_channel","cancellation_guidance","verified_evidence","household_sharing"]', 2);

CREATE TABLE entitlements (
  account_id uuid PRIMARY KEY REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free' REFERENCES plans(id),
  billing_period text CHECK (billing_period IN ('monthly','yearly')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','expired')),
  current_period_end timestamptz,
  channel text CHECK (channel IN ('razorpay','manual')),
  provider_ref text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Razorpay subscriptions created at checkout (pending until a verified webhook activates them).
CREATE TABLE billing_subscriptions (
  id text PRIMARY KEY,
  account_id uuid REFERENCES consumer_accounts(id) ON DELETE SET NULL,
  plan text NOT NULL REFERENCES plans(id),
  billing_period text NOT NULL CHECK (billing_period IN ('monthly','yearly')),
  status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_subscriptions_account_idx ON billing_subscriptions(account_id);

-- Webhook idempotency: each provider event is applied once.
CREATE TABLE billing_events (
  event_id text PRIMARY KEY,
  event text NOT NULL,
  subscription_id text,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE consumer_audit (
  id bigserial PRIMARY KEY,
  account_id uuid REFERENCES consumer_accounts(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  before jsonb,
  after jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX consumer_audit_account_idx ON consumer_audit(account_id, id DESC);

-- Reminder plan uploaded by the client on sync (lead time, quiet hours and timezone already resolved).
CREATE TABLE reminder_schedule (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  obligation_ref text NOT NULL,
  title text NOT NULL,
  due_date date NOT NULL,
  remind_at timestamptz NOT NULL,
  channel text NOT NULL CHECK (channel IN ('email','push')),
  timezone text NOT NULL DEFAULT 'Asia/Kolkata',
  quiet_start text,
  quiet_end text,
  attempts integer NOT NULL DEFAULT 0,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, obligation_ref, remind_at, channel)
);
CREATE INDEX reminder_schedule_due_idx ON reminder_schedule(remind_at) WHERE delivered_at IS NULL;

CREATE TABLE reminder_deliveries (
  id bigserial PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES consumer_accounts(id) ON DELETE CASCADE,
  obligation_ref text NOT NULL,
  channel text NOT NULL,
  scheduled_for timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled','sent','failed','unavailable')),
  provider_message_id text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reminder_deliveries_account_idx ON reminder_deliveries(account_id, id DESC);

CREATE TABLE telemetry_events (
  id bigserial PRIMARY KEY,
  account_id uuid REFERENCES consumer_accounts(id) ON DELETE SET NULL,
  anon_id text NOT NULL,
  name text NOT NULL CHECK (name IN ('first_obligation_completed','import_approved','import_ignored',
    'reminder_resolved','correction_made','missed_or_late','trial_converted','churn_reason','notification_opt_out')),
  props jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX telemetry_events_name_idx ON telemetry_events(name, at);

ALTER TABLE jobs DROP CONSTRAINT jobs_id_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_id_check
  CHECK (id IN ('monitor_sources','retry_failed','retention_cleanup','consumer_reminders'));
INSERT INTO jobs (id, enabled, interval_minutes, config) VALUES ('consumer_reminders', true, 15, '{"batch_size": 200}');
