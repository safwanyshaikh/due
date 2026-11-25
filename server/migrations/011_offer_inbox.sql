-- Offer inbox: provider newsletters received on company research mailboxes (not user data), the provider directory,
-- and a public change log so the on-device engine can learn which catalog entries changed. Additive only.

CREATE TABLE provider_watch (
  slug            text PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,79}$'),
  display_name    text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
  sender_domains  text[] NOT NULL DEFAULT '{}',
  category        text NOT NULL DEFAULT 'other',
  country         text NOT NULL DEFAULT 'IN',
  signup_url      text,
  research_address text,
  status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('subscribed', 'pending', 'unsubscribed')),
  app_only        boolean NOT NULL DEFAULT false,
  notes           text,
  last_email_at   timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX provider_watch_status_idx ON provider_watch (status);

CREATE TABLE offer_inbox_messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id_hash  text UNIQUE,
  received_at      timestamptz NOT NULL,
  recipient        text NOT NULL,
  from_address     text,
  from_domain      text,
  subject          text,
  auth             jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_slug    text REFERENCES provider_watch(slug) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'parsed', 'quarantined', 'failed')),
  reason           text,
  personalised     boolean NOT NULL DEFAULT false,
  landing_urls     text[] NOT NULL DEFAULT '{}',
  candidates       jsonb NOT NULL DEFAULT '[]'::jsonb,
  reviews_queued   integer NOT NULL DEFAULT 0,
  -- Sealed (DATA_ENCRYPTION_KEY) raw message; wiped after 90 days.
  raw_sealed       text,
  parsed_at        timestamptz
);
CREATE INDEX offer_inbox_received_idx ON offer_inbox_messages (received_at DESC);
CREATE INDEX offer_inbox_provider_idx ON offer_inbox_messages (provider_slug, received_at DESC);
CREATE INDEX offer_inbox_unmatched_idx ON offer_inbox_messages (from_domain) WHERE provider_slug IS NULL;

-- Public change log behind GET /api/public/savings/catalog/changes. catalog_version = catalog hash AFTER the change.
CREATE TABLE savings_changes (
  id              bigserial PRIMARY KEY,
  entity          text NOT NULL CHECK (entity IN ('module', 'city_pack')),
  entity_id       text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('new', 'updated', 'verified', 'retired')),
  summary         text NOT NULL CHECK (char_length(summary) <= 200),
  prev_version    text NOT NULL,
  catalog_version text NOT NULL,
  changed_at      timestamptz NOT NULL
);
CREATE INDEX savings_changes_version_idx ON savings_changes (catalog_version);
CREATE INDEX savings_changes_prev_idx ON savings_changes (prev_version);
CREATE INDEX savings_changes_time_idx ON savings_changes (changed_at DESC);

ALTER TABLE offer_observations DROP CONSTRAINT IF EXISTS offer_observations_origin_check;
ALTER TABLE offer_observations ADD CONSTRAINT offer_observations_origin_check CHECK (origin IN ('engine', 'manual', 'seed', 'newsletter'));
