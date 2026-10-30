-- PLAN ONLY. Not applied and not used by the MVP, which stores data locally in the browser.
-- If a hosted Postgres is adopted later, every table must carry user_id and enforce row-level security.
-- Service-role credentials stay server-side. Do not add columns for card numbers, PINs, passwords, PAN, Aadhaar,
-- mailbox tokens, or raw inbox/chat content.

create table commitments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('subscription','emi','other_loan','credit_card','school_fee','bill','other')),
  provider text not null,
  nickname text not null default '',
  amount_paise bigint check (amount_paise is null or amount_paise >= 0),
  currency text not null default 'INR',
  frequency text not null,
  interval_months int,
  next_due date not null,
  due_confidence text not null default 'estimate',
  amount_confidence text not null default 'estimate',
  remaining_occurrences int,
  rail text not null default 'unknown',
  account_nickname text not null default '',
  owner_label text not null default '',
  importance text not null default 'important',
  notes text not null default '',
  last_confirmed date,
  reminder_offsets int[] not null default '{7,3,1}',
  reminders_enabled boolean not null default true,
  status text not null default 'active',
  billing_email_label_id uuid,
  cooling_off_until date,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table loan_terms (
  commitment_id uuid primary key references commitments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  lender_nickname text,
  loan_type text,
  principal_paise bigint,
  interest_rate_pct numeric(5,2),
  rate_type text check (rate_type in ('fixed','variable')),
  original_tenure_months int
);

create table statements (
  commitment_id uuid primary key references commitments(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  card_nickname text not null,
  period_start date,
  period_end date,
  confirmed_from_latest boolean not null default false
);

create table commitment_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_id uuid not null references commitments(id) on delete cascade,
  component_id uuid not null references commitments(id) on delete cascade,
  relation text not null default 'included_in_statement',
  confirmed_by_user boolean not null default true,
  unique (component_id)
);

create table budgets (
  user_id uuid primary key references auth.users(id) on delete cascade,
  enabled boolean not null default false,
  overall_monthly_cap_paise bigint,
  discretionary_monthly_cap_paise bigint,
  thresholds int[] not null default '{80,100}',
  timezone text not null default 'Asia/Kolkata'
);

create table seasons (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  start_date date not null,
  end_date date not null,
  linked_commitment_ids uuid[] not null default '{}',
  consider_lead_days int not null default 7,
  review_lead_days int not null default 3,
  restart_date date
);

-- Label only. No inbox connection or token.
create table billing_email_labels (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  label text not null,
  display_name text
);

create table reminders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  commitment_id uuid references commitments(id) on delete cascade,
  type text not null,
  local_date date not null,
  local_time time not null,
  channel text not null,
  status text not null,
  idempotency_key text not null,
  unique (user_id, idempotency_key)
);

create table action_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  commitment_id uuid references commitments(id) on delete cascade,
  action text not null,
  confirmation_source text not null default 'user_entered',
  at timestamptz not null default now()
);

-- Row-level security: repeat this pattern for EVERY table above.
alter table commitments enable row level security;
create policy "own rows" on commitments for all using (user_id = auth.uid()) with check (user_id = auth.uid());
-- Required tests before use: user A cannot select, insert, update or delete user B's rows in any table.
