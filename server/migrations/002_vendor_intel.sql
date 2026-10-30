-- Offer patterns and partner lists from the research registry (read-only in the admin UI).
CREATE TABLE vendor_intel (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('offer_pattern','partner')),
  data jsonb NOT NULL,
  source_url text,
  fetched_at timestamptz,
  method text,
  verification_status text NOT NULL DEFAULT 'pending'
    CHECK (verification_status IN ('pending','verified','rejected')),
  data_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, kind, data_hash)
);
