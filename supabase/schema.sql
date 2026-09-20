-- TNT Roadside — Supabase schema
-- Run this once in the Supabase project's SQL Editor (Dashboard > SQL Editor > New query).
-- Matches the schema documented in TNT-Roadside-Project-Reference.md.

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
-- will eventually be embedded in index.html's client-side JS (it's designed
-- to be public), so without RLS, anyone with that key could read or write
-- every row in every table -- including other customers' names/phone
-- numbers. Locking this down now, before any client-side wiring happens,
-- means there's never a window where the tables sit open.
alter table customers enable row level security;
alter table technicians enable row level security;
alter table jobs enable row level security;
alter table payments enable row level security;

-- No policies are created here on purpose -- with RLS on and zero policies,
-- the anon key can't read or write anything by default (safe starting
-- point). Policies get added deliberately in the step where each table is
-- actually wired up to the browser or to a Make.com webhook, scoped to
-- exactly what that flow needs (e.g. "anon can insert into jobs but not
-- select other customers' rows").
