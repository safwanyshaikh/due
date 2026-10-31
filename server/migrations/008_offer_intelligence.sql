-- Offer intelligence engine (Agent D): append-only observations, audited status transitions, a manual change review
-- queue, parser versions, provider families and freshness tracking. Additive only; history is never deleted.

-- ---- Provider families ------------------------------------------------------------------------------
ALTER TABLE companies ADD COLUMN provider_family text
  CHECK (provider_family IS NULL OR provider_family IN ('jio','airtel','vi','amazon_prime_ott','google_one_gemini','apple',
    'banks_cards','upi_payments','broadband_dth','insurance','utilities','education_fees','generic_subscriptions'));

-- ---- Sources: per-source request timeout, offer refresh schedule, unverified candidate URLs -----------
ALTER TABLE sources
  ADD COLUMN request_timeout_ms integer CHECK (request_timeout_ms IS NULL OR request_timeout_ms BETWEEN 1000 AND 60000),
  ADD COLUMN offer_next_refresh_at timestamptz,
  -- A candidate official URL added from the registry that the engine has not fetched successfully yet.
  ADD COLUMN candidate boolean NOT NULL DEFAULT false;

-- ---- Offers: identity, freshness and supersession ---------------------------------------------------
ALTER TABLE offers
  ADD COLUMN sku text,
  ADD COLUMN geography text,
  ADD COLUMN official_start_at date,
  ADD COLUMN superseded_by text REFERENCES offers(id) ON DELETE SET NULL,
  ADD COLUMN last_successful_check_at timestamptz,
  ADD COLUMN last_attempted_check_at timestamptz,
  ADD COLUMN last_check_error text,
  ADD COLUMN freshness_window_hours integer NOT NULL DEFAULT 168 CHECK (freshness_window_hours BETWEEN 1 AND 8760),
  ADD COLUMN provider_family text
    CHECK (provider_family IS NULL OR provider_family IN ('jio','airtel','vi','amazon_prime_ott','google_one_gemini','apple',
      'banks_cards','upi_payments','broadband_dth','insurance','utilities','education_fees','generic_subscriptions')),
  ADD COLUMN status_reason text,
  ADD COLUMN status_changed_at timestamptz;

UPDATE offers SET
  sku = COALESCE(sku, details->>'skuOrPlanCode'),
  geography = COALESCE(geography, details->>'geography'),
  official_start_at = COALESCE(official_start_at,
    CASE WHEN details->>'officialStartAt' ~ '^\d{4}-\d{2}-\d{2}$' THEN (details->>'officialStartAt')::date END);

CREATE INDEX offers_source_ids_idx ON offers USING gin (source_ids);

-- ---- Parser versions ---------------------------------------------------------------------------------
CREATE TABLE parser_versions (
  id bigserial PRIMARY KEY,
  source_id uuid REFERENCES sources(id) ON DELETE CASCADE,
  provider text,
  version text NOT NULL CHECK (version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  rules jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  active boolean NOT NULL DEFAULT false,
  activated_at timestamptz,
  CHECK (source_id IS NOT NULL OR provider IS NOT NULL)
);
CREATE UNIQUE INDEX parser_versions_scope_version_idx
  ON parser_versions (COALESCE(source_id::text, ''), COALESCE(provider, ''), version);
-- At most one active parser per scope (a source, or a provider).
CREATE UNIQUE INDEX parser_versions_active_idx
  ON parser_versions (COALESCE(source_id::text, ''), COALESCE(provider, '')) WHERE active;

-- ---- Observations (append-only) ----------------------------------------------------------------------
-- source_id and snapshot_id are plain values (not foreign keys): snapshots are purged by retention and
-- sources can be removed, but an observation is history and is never rewritten.
CREATE TABLE offer_observations (
  id bigserial PRIMARY KEY,
  offer_id text NOT NULL REFERENCES offers(id) ON DELETE RESTRICT,
  source_id uuid,
  source_url text,
  observed_at timestamptz NOT NULL,
  parser_version_id bigint,
  parser_version text NOT NULL,
  fingerprint text NOT NULL,
  -- {price, billing_period, benefit_value, official_start, official_end, page_status, terms_status}; null = not observed.
  fields jsonb NOT NULL,
  content_hash text,
  snapshot_id bigint,
  http_status integer,
  origin text NOT NULL DEFAULT 'engine' CHECK (origin IN ('engine','manual','seed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX offer_observations_offer_idx ON offer_observations (offer_id, id DESC);
CREATE INDEX offer_observations_source_idx ON offer_observations (offer_id, source_id, id DESC);

-- ---- Status transitions (append-only audit of every computed status change) --------------------------
CREATE TABLE offer_status_transitions (
  id bigserial PRIMARY KEY,
  offer_id text NOT NULL REFERENCES offers(id) ON DELETE RESTRICT,
  from_status text,
  to_status text NOT NULL,
  reason text NOT NULL,
  actor text NOT NULL CHECK (actor IN ('system','admin')),
  -- Not a foreign key so the row never changes; actor_email is a snapshot for display.
  actor_user_id uuid,
  actor_email text,
  at timestamptz NOT NULL
);
CREATE INDEX offer_status_transitions_offer_idx ON offer_status_transitions (offer_id, id DESC);

CREATE FUNCTION offer_history_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER offer_observations_append_only BEFORE UPDATE OR DELETE ON offer_observations
  FOR EACH ROW EXECUTE FUNCTION offer_history_append_only();
CREATE TRIGGER offer_status_transitions_append_only BEFORE UPDATE OR DELETE ON offer_status_transitions
  FOR EACH ROW EXECUTE FUNCTION offer_history_append_only();

-- ---- Manual change review queue ----------------------------------------------------------------------
CREATE TABLE offer_review_queue (
  id bigserial PRIMARY KEY,
  offer_id text REFERENCES offers(id) ON DELETE RESTRICT,
  observation_id bigint REFERENCES offer_observations(id) ON DELETE RESTRICT,
  source_id uuid,
  change_kind text NOT NULL CHECK (change_kind IN ('price','eligibility','expiry','status','new_offer')),
  proposed jsonb NOT NULL,
  current jsonb NOT NULL DEFAULT '{}'::jsonb,
  proposed_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  created_at timestamptz NOT NULL,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  note text CHECK (note IS NULL OR char_length(note) <= 2000)
);
CREATE INDEX offer_review_queue_status_idx ON offer_review_queue (status, created_at DESC);
-- The same proposed change is queued once while pending.
CREATE UNIQUE INDEX offer_review_queue_pending_idx
  ON offer_review_queue (COALESCE(offer_id, ''), change_kind, proposed_hash) WHERE status = 'pending';

-- ---- Scheduler entries (the scheduler enqueues; the queue does the work) -------------------------------
-- Relax the fixed id list into a format check so later migrations can add scheduler entries without
-- rewriting each other's lists (runner.ts JOB_IDS remains the allow-list in code).
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_id_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_id_check CHECK (id ~ '^[a-z][a-z0-9_]{1,62}$');
INSERT INTO jobs (id, enabled, interval_minutes, config) VALUES
  ('offers_refresh', true, 15, '{"batch_size": 50}'),
  ('offers_status', true, 60, '{}')
ON CONFLICT (id) DO NOTHING;
