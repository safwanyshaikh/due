-- Cashfree Subscriptions alongside Razorpay: provider tracking, out-of-order guard and payment-failure grace.
ALTER TABLE entitlements DROP CONSTRAINT IF EXISTS entitlements_channel_check;
ALTER TABLE entitlements ADD CONSTRAINT entitlements_channel_check CHECK (channel IN ('razorpay','cashfree','manual'));
ALTER TABLE billing_subscriptions
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'razorpay',
  ADD COLUMN IF NOT EXISTS last_event_at timestamptz,
  ADD COLUMN IF NOT EXISTS grace_until timestamptz;
ALTER TABLE billing_events ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'razorpay';
