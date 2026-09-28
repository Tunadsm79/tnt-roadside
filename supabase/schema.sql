-- TNT Roadside — Supabase schema
-- This file is a disaster-recovery record of the live Supabase database,
-- not a script meant to be re-run against the existing project -- most of
-- it (tables, existing policies, existing views) already exists live and
-- re-running those statements would just error. Only the REVOKE/UPDATE
-- grant block below (search "column-level grant") is a real pending
-- action as of 2026-09-21. On a brand-new project, the whole file can be
-- run top to bottom once.

create table customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  email text,
  created_at timestamptz default now()
);

create table technicians (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text not null,
  active boolean default true,
  current_lat numeric,
  current_lng numeric,
  location_updated_at timestamptz,
  created_at timestamptz default now()
);

create table jobs (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references customers(id),
  technician_id uuid references technicians(id),
  service_type text not null,       -- 'flat_tire' | 'dead_battery' | 'lockout' | 'fuel_delivery'
  status text default 'requested',  -- requested | dispatched | en_route | completed | cancelled
  payment_status text default 'none', -- none | authorized | captured | released
  customer_lat numeric,
  customer_lng numeric,
  customer_address text,
  eta_minutes integer,
  distance_miles numeric,
  price numeric(10,2),
  created_at timestamptz default now(),
  completed_at timestamptz
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id),
  amount numeric(10,2) not null,
  stripe_payment_intent_id text,
  status text default 'pending',    -- pending | authorized | captured | released
  authorized_at timestamptz,
  captured_at timestamptz,
  created_at timestamptz default now()
);

-- Row Level Security: ON for all four tables. Supabase's anon/public API key
-- is embedded in index.html/tech.html's client-side JS (it's designed to be
-- public), so without RLS, anyone with that key could read or write every
-- row in every table -- including other customers' names/phone numbers.
alter table customers enable row level security;
alter table technicians enable row level security;
alter table jobs enable row level security;
alter table payments enable row level security;

-- Live policies as of 2026-09-21 (confirmed against production via
-- pg_policies -- this replaces the old "no policies yet" placeholder):
create policy "anon can insert customers" on customers
  for insert to anon with check (true);

create policy "anon can insert jobs" on jobs
  for insert to anon with check (true);

create policy "anon can insert payments" on payments
  for insert to anon with check (true);

create policy "anon can read active technician for location" on technicians
  for select to anon using (active = true);

create policy "anon can update active technician location" on technicians
  for update to anon using (active = true) with check (active = true);

-- The policy above is intentionally row-scoped only (any active
-- technician's row). Column scope matters too: tech.html only ever writes
-- current_lat/current_lng/location_updated_at (see pushLocation() in
-- tech.html), but a plain broad UPDATE grant + row-level RLS does NOT
-- restrict which columns can be changed -- without this, anyone holding
-- the public anon key could PATCH a technician's name/phone directly via
-- the REST API, not just their location. This column-level grant closes
-- that gap without changing any app behavior:
revoke update on technicians from anon;
grant update (current_lat, current_lng, location_updated_at) on technicians to anon;

-- No insert/update/delete policies exist for jobs/payments/customers beyond
-- insert -- this is deliberate: once a job/payment row is written by the
-- customer-side dispatch flow, only the service-role key (used server-side
-- in api/complete-job.js and api/cancel-job.js, never exposed to the
-- browser) can change it. The anon key can create new rows but can't alter
-- or read back existing ones directly.

-- Two views give the browser scoped, safe read access without opening the
-- underlying tables to anon SELECT:
create view active_jobs_view as
  select id, service_type, price, status, payment_status, created_at,
         customer_lat, customer_lng, customer_address
  from jobs
  where status not in ('completed', 'cancelled');

create view technician_locations as
  select id, name, current_lat, current_lng, location_updated_at, active
  from technicians;

grant select on active_jobs_view to anon;
grant select on technician_locations to anon;

-- 2026-09-26: Vehicle Information (Year/Make/Model) feature. Adds three
-- nullable columns to the existing `jobs` table -- run once, by hand, in
-- the Supabase SQL Editor (Claude doesn't execute schema-modifying SQL
-- directly, per this project's standing rule). No new RLS policy or
-- GRANT is needed: `anon` already has a blanket INSERT policy + GRANT on
-- `jobs` (see "anon can insert jobs" above), which covers any column on
-- the table, and the service-role key already has ALL PRIVILEGES on
-- every table in the public schema (see the service_role GRANT fix
-- documented in the project reference doc). Values are optional/nullable
-- on purpose -- the customer can submit a request without picking a
-- vehicle if the NHTSA vPIC API is slow or down.
alter table jobs add column if not exists vehicle_year integer;
alter table jobs add column if not exists vehicle_make text;
alter table jobs add column if not exists vehicle_model text;

-- 2026-09-26: Customer <-> technician in-app messaging. Run once, by hand,
-- in the Supabase SQL Editor (Claude doesn't execute schema-modifying SQL
-- directly, per this project's standing rule).
--
-- Deliberately NO RLS policies granting anon anything on this table --
-- same treatment as `customers`/`payments`. All reads and writes go
-- through two new serverless functions (api/send-message.js,
-- api/job-messages.js) using the service-role key, same pattern as
-- accept-job.js/active-jobs.js. This keeps one message thread from being
-- readable by anyone else holding the public anon key, the same hard
-- line the rest of this app's security is built around.
create table messages (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id) not null,
  sender text not null,  -- 'customer' | 'tech' | 'dispatch' (T&T admin, added 2026-09-28; documentation only, no CHECK constraint)
  body text not null,
  created_at timestamptz default now()
);

create index messages_job_id_idx on messages(job_id, created_at);

alter table messages enable row level security;
-- No policies created for anon on purpose -- see comment above. RLS is ON
-- with zero policies, which means the anon key is flatly denied on this
-- table; only the service-role key (used server-side only) can touch it.

-- 2026-09-28: headlight-restoration lead capture (completed-job screen's
-- "Get Headlight Restoration" CTA, index.html). Run once, by hand, in the
-- Supabase SQL Editor (Claude doesn't execute schema-modifying SQL
-- directly, per this project's standing rule).
--
-- Same anon-insert-only RLS pattern as customers/jobs/payments -- no
-- select policy, so a lead can be created but never read back through the
-- public anon key.
--
-- unique(job_id, interest) is the real duplicate-prevention backstop (a
-- disabled button is just UI): index.html's insert code treats hitting
-- this constraint (Postgres error 23505) as success, since the lead really
-- is on file either way, rather than showing the customer an error.
--
-- IMPORTANT LESSON from live-testing this table on 2026-09-28: unlike
-- customers/jobs/payments (which already had an anon INSERT grant on the
-- underlying table from earlier in this project, on top of their RLS
-- policy -- see the "anon already has a blanket INSERT ... GRANT on jobs"
-- note above), a brand-new table does NOT get that grant automatically.
-- The RLS policy alone was not enough -- every insert failed with
-- "permission denied for table leads" (Postgres code 42501) until the
-- GRANT below was run too. Any future anon-writable table needs both
-- statements, not just the policy.
create table leads (
  id uuid primary key default gen_random_uuid(),
  job_id uuid references jobs(id),
  name text not null,
  phone text not null,
  interest text not null default 'headlight_restoration',
  created_at timestamptz default now(),
  unique (job_id, interest)
);

alter table leads enable row level security;

create policy "anon can insert leads" on leads
  for insert to anon with check (true);

grant insert on public.leads to anon;
