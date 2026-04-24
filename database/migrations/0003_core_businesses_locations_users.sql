-- 0003_core_businesses_locations_users.sql

create type core.business_status_enum as enum (
  'trial',
  'active',
  'suspended',
  'closed'
);

create table core.businesses (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null,
  slug extensions.citext not null unique,
  legal_name text,
  support_email extensions.citext,
  support_phone text,
  default_currency_code char(3) not null default 'GBP',
  default_country_code char(2) not null default 'GB',
  timezone text not null default 'Europe/London',
  status core.business_status_enum not null default 'trial',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table core.businesses is
  'Top-level tenant boundary. Multiple independent businesses can coexist on one Supabase project.';

create table core.locations (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  code text not null,
  name text not null,
  slug extensions.citext not null,
  address_line_1 text not null,
  address_line_2 text,
  city text not null,
  region text,
  postal_code text not null,
  country_code char(2) not null default 'GB',
  timezone text not null,
  phone text,
  email extensions.citext,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, code),
  unique (business_id, slug)
);

comment on table core.locations is
  'Operational salon locations inside a business. Managers are intentionally scoped to these rows.';

create table core.user_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email extensions.citext not null unique,
  full_name text not null,
  phone text,
  avatar_url text,
  preferred_timezone text,
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table core.user_profiles is
  'Application-level profile mapped 1:1 to Supabase auth.users.';
