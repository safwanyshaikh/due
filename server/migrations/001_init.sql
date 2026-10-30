-- Due production schema (see docs/production/CONTRACT.md).
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email)),
  name text NOT NULL,
  password_hash text,
  role text NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  ip text,
  user_agent text,
  revoked_at timestamptz
);
CREATE INDEX sessions_user_idx ON sessions(user_id);

CREATE TABLE login_events (
  id bigserial PRIMARY KEY,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  email text NOT NULL,
  success boolean NOT NULL,
  reason text,
  ip text,
  user_agent text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX login_events_rate_idx ON login_events(email, ip, at);

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  before jsonb,
  after jsonb,
  ip text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_entity_idx ON audit_log(entity_type, at DESC);

CREATE TABLE categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  description text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL DEFAULT 'company' CHECK (kind IN ('company','vendor')),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  official_website text,
  description text,
  country text,
  category_id uuid REFERENCES categories(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  verification_status text NOT NULL DEFAULT 'unverified'
    CHECK (verification_status IN ('unverified','pending','verified','rejected')),
  verified_by uuid REFERENCES users(id) ON DELETE SET NULL,
  verified_at timestamptz,
  verification_note text,
  monitoring_enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  url text NOT NULL,
  label text NOT NULL,
  source_category text NOT NULL CHECK (source_category IN
    ('official_site','product_page','pricing','terms','press','news','rss','help','api','document','social','secondary')),
  is_official boolean NOT NULL DEFAULT false,
  extraction_method text NOT NULL DEFAULT 'html_text'
    CHECK (extraction_method IN ('html_text','rss','json','sitemap')),
  css_selector text,
  priority text NOT NULL DEFAULT 'regular' CHECK (priority IN ('critical','regular','secondary')),
  frequency_minutes integer NOT NULL CHECK (frequency_minutes >= 15),
  enabled boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','failing','blocked_robots','inaccessible','disabled')),
  next_check_at timestamptz NOT NULL DEFAULT now(),
  last_checked_at timestamptz,
  last_success_at timestamptz,
  last_change_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_error text,
  -- Validators from the last successful response, used for conditional GET.
  http_etag text,
  http_last_modified text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, url)
);
CREATE INDEX sources_due_idx ON sources(next_check_at) WHERE enabled;
CREATE INDEX sources_url_idx ON sources(url);

CREATE TABLE snapshots (
  id bigserial PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  fetched_at timestamptz NOT NULL,
  http_status integer,
  content_hash text NOT NULL,
  content_type text,
  title text,
  text_content text CHECK (char_length(text_content) <= 200000),
  etag text,
  last_modified text,
  bytes integer,
  duration_ms integer
);
CREATE INDEX snapshots_source_idx ON snapshots(source_id, id DESC);

CREATE TABLE jobs (
  id text PRIMARY KEY CHECK (id IN ('monitor_sources','retry_failed','retention_cleanup')),
  enabled boolean NOT NULL DEFAULT true,
  interval_minutes integer NOT NULL CHECK (interval_minutes >= 1),
  last_run_at timestamptz,
  next_run_at timestamptz,
  config jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE job_runs (
  id bigserial PRIMARY KEY,
  job_id text NOT NULL REFERENCES jobs(id),
  triggered_by text NOT NULL CHECK (triggered_by IN ('schedule','manual')),
  triggered_by_user uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('running','success','failed')),
  stats jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);
CREATE INDEX job_runs_job_idx ON job_runs(job_id, id DESC);

CREATE TABLE fetch_runs (
  id bigserial PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  job_run_id bigint REFERENCES job_runs(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('changed','unchanged','error','skipped_robots','skipped_disabled','not_modified')),
  http_status integer,
  error text,
  attempt integer NOT NULL DEFAULT 1,
  -- 'monitor' for engine fetches; 'research_webfetch' for evidence imported from the research registry.
  method text NOT NULL DEFAULT 'monitor',
  note text
);
CREATE INDEX fetch_runs_source_idx ON fetch_runs(source_id, id DESC);
CREATE INDEX fetch_runs_started_idx ON fetch_runs(started_at);

CREATE TABLE records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  source_id uuid REFERENCES sources(id) ON DELETE SET NULL,
  record_type text NOT NULL CHECK (record_type IN ('page','rss_item','announcement','price_mention')),
  fingerprint text NOT NULL,
  title text,
  url text,
  summary text,
  published_at timestamptz,
  first_seen_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  current_version integer NOT NULL DEFAULT 1,
  verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','approved','rejected')),
  sensitive boolean NOT NULL DEFAULT false,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  review_note text,
  UNIQUE (company_id, fingerprint)
);
CREATE INDEX records_source_idx ON records(source_id);

CREATE TABLE record_versions (
  id bigserial PRIMARY KEY,
  record_id uuid NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  version integer NOT NULL,
  data jsonb NOT NULL,
  content_hash text NOT NULL,
  snapshot_id bigint REFERENCES snapshots(id) ON DELETE SET NULL,
  change_type text NOT NULL CHECK (change_type IN ('new','modified','manual_correction')),
  changed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  captured_at timestamptz NOT NULL,
  UNIQUE (record_id, version)
);

CREATE TABLE alerts (
  id bigserial PRIMARY KEY,
  level text NOT NULL CHECK (level IN ('info','important')),
  title text NOT NULL,
  body text,
  entity_type text,
  entity_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE offers (
  id text PRIMARY KEY,
  provider text NOT NULL,
  product_family text NOT NULL,
  name text NOT NULL,
  benefit_type text NOT NULL,
  price_inr numeric(12,2),
  billing_period text,
  benefit_value jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_ids uuid[] NOT NULL DEFAULT '{}',
  source_urls text[] NOT NULL DEFAULT '{}',
  official_end_at date,
  terms_status text NOT NULL DEFAULT 'unknown',
  page_status text NOT NULL DEFAULT 'unknown',
  computed_status text NOT NULL DEFAULT 'unknown',
  confidence text NOT NULL DEFAULT 'low',
  notes text[] NOT NULL DEFAULT '{}',
  -- Remaining offer fields from the research model (eligibility, cadence, geography, source labels...).
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('research_snapshot','pending','verified','rejected')),
  observed_at timestamptz,
  last_confirmed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO jobs (id, enabled, interval_minutes, config) VALUES
  ('monitor_sources', true, 15, '{"batch_size": 50, "concurrency": 4}'),
  ('retry_failed', true, 30, '{"batch_size": 50, "concurrency": 2}'),
  ('retention_cleanup', true, 1440, '{}');
