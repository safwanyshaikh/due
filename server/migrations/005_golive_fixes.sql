-- Go-live fixes.

-- Household sharing is not sold until it works end to end: the plan is inactive, so it is hidden from
-- GET /api/public/plans and checkout refuses it (400 plan_unavailable). Admins can re-activate it in Plans.
UPDATE plans SET active = false, updated_at = now() WHERE id = 'household';
ALTER TABLE plans ALTER COLUMN active SET DEFAULT false;

-- Forwarding aliases: new aliases are 'u' + 12 base32 characters (~60 bits). Existing 5-character
-- aliases stay valid and keep routing until the owner rotates them.
ALTER TABLE intake_aliases DROP CONSTRAINT IF EXISTS intake_aliases_alias_check;
ALTER TABLE intake_aliases ADD CONSTRAINT intake_aliases_alias_check CHECK (alias ~ '^u([a-z2-7]{5}|[a-z2-7]{12})$');
