-- Savings engine: public rules catalog (modules, city packs), anonymous research requests and opt-in anonymous
-- savings reports. Additive only. No account ids and no personal amounts are stored here.

CREATE TABLE savings_modules (
  id         text PRIMARY KEY,
  version    integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  status     text NOT NULL DEFAULT 'research' CHECK (status IN ('research', 'verified', 'retired')),
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX savings_modules_status_idx ON savings_modules (status);

CREATE TABLE city_packs (
  id         text PRIMARY KEY,
  status     text NOT NULL DEFAULT 'research' CHECK (status IN ('research', 'verified', 'retired')),
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX city_packs_status_idx ON city_packs (status);

-- Providers people have in their data that Due has no module for yet. Labels are PII-guarded before insert.
CREATE TABLE research_requests (
  id             bigserial PRIMARY KEY,
  provider_label text NOT NULL CHECK (char_length(provider_label) BETWEEN 1 AND 60),
  category       text NOT NULL,
  city_pack      text,
  request_count  integer NOT NULL DEFAULT 1 CHECK (request_count >= 1),
  first_seen     timestamptz NOT NULL DEFAULT now(),
  last_seen      timestamptz NOT NULL DEFAULT now(),
  status         text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'researching', 'done', 'rejected')),
  module_id      text
);
CREATE UNIQUE INDEX research_requests_label_category_key ON research_requests (lower(provider_label), category);
CREATE INDEX research_requests_count_idx ON research_requests (request_count DESC);

CREATE TABLE savings_reports (
  id                 bigserial PRIMARY KEY,
  move_kind          text NOT NULL,
  module_id          text,
  city_pack          text,
  saved_monthly_inr  integer NOT NULL CHECK (saved_monthly_inr BETWEEN 1 AND 100000),
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX savings_reports_group_idx ON savings_reports (move_kind, module_id, city_pack);
