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
