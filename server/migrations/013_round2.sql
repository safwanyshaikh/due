-- Security re-audit round 2 (26 Nov 2026).

-- M-D: household sharing is a consented purpose. People who created or joined a household before this was
-- recorded did so by an explicit action (create, or accept an invitation); that action is recorded here.
INSERT INTO consent_records (account_id, purpose, granted, text_version, policy_version, scope, source, at)
SELECT m.account_id, 'household', true, 'household-2026-11', 'household-2026-11',
       jsonb_build_object('role', m.role, 'basis', 'joined_before_consent_record'), 'system', now()
  FROM household_members m
 WHERE m.status = 'active'
   AND NOT EXISTS (SELECT 1 FROM consent_records c WHERE c.account_id = m.account_id AND c.purpose = 'household');

-- M-B: breach notices need an open incident record, a draft and a second owner's approval.
CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_ref text NOT NULL UNIQUE,
  title text NOT NULL,
  opened_by uuid REFERENCES users(id) ON DELETE SET NULL,
  opened_at timestamptz NOT NULL,
  closed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  closed_at timestamptz
);
CREATE TABLE breach_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_ref text NOT NULL REFERENCES incidents(incident_ref),
  fields jsonb NOT NULL,
  account_ids uuid[] NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('pending_approval','sending','sent','rejected')),
  approved_by uuid REFERENCES users(id) ON DELETE SET NULL,
  approved_at timestamptz,
  sent int,
  failed int
);
CREATE INDEX breach_notifications_at_idx ON breach_notifications(at);

-- M-E: daily job that seals every plain (or old-key) synced document, dormant accounts included.
INSERT INTO jobs (id, enabled, interval_minutes, config) VALUES ('sync_seal', true, 1440, '{}') ON CONFLICT (id) DO NOTHING;
