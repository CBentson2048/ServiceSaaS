-- 0003_core_foundation.sql

create type core.business_status_enum as enum (
  'trial',
  'active',
  'suspended',
  'closed'
);

create type core.membership_role_enum as enum (
  'owner',
  'admin',
  'manager',
  'front_desk',
  'stylist',
  'assistant',
  'client'
);

create type core.membership_status_enum as enum (
  'invited',
  'active',
  'suspended',
  'revoked'
);

create type core.staff_employment_status_enum as enum (
  'active',
  'on_leave',
  'notice',
  'terminated'
);

create type core.deposit_rule_type_enum as enum (
  'none',
  'fixed_amount',
  'percentage'
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
  'Top-level tenant boundary. Multiple independent businesses can coexist on the same infrastructure.';

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
  'Application profile mapped 1:1 to Supabase auth.users.';

create table core.user_memberships (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete cascade,
  user_profile_id uuid not null references core.user_profiles(id) on delete cascade,
  role core.membership_role_enum not null,
  status core.membership_status_enum not null default 'invited',
  invited_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  activated_at timestamptz,
  suspended_at timestamptz,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (business_id, location_id, user_profile_id, role),
  check (
    (role in ('owner', 'admin') and location_id is null)
    or (role not in ('owner', 'admin'))
  )
);

comment on table core.user_memberships is
  'Role assignment by business and optional location. Owners and admins remain business-wide.';

create table core.staff_profiles (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  user_profile_id uuid not null references core.user_profiles(id) on delete cascade,
  primary_location_id uuid not null references core.locations(id) on delete restrict,
  display_name text not null,
  employment_status core.staff_employment_status_enum not null default 'active',
  hourly_rate numeric(12,2) not null default 0,
  hire_date date,
  termination_date date,
  color_hex text,
  bio text,
  is_bookable boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, user_profile_id),
  check (termination_date is null or hire_date is null or termination_date >= hire_date)
);

create table core.client_profiles (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  user_profile_id uuid references core.user_profiles(id) on delete set null,
  primary_location_id uuid references core.locations(id) on delete set null,
  external_ref text,
  first_name text not null,
  last_name text not null,
  email extensions.citext,
  phone text,
  date_of_birth date,
  communication_preference text,
  marketing_opt_in boolean not null default false,
  source text,
  tags text[] not null default '{}',
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (business_id, user_profile_id)
);

create table core.location_settings (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null unique references core.locations(id) on delete cascade,
  online_booking_enabled boolean not null default true,
  allow_next_available boolean not null default true,
  appointment_slot_minutes integer not null default 15 check (appointment_slot_minutes > 0),
  same_day_booking_cutoff_minutes integer not null default 120 check (same_day_booking_cutoff_minutes >= 0),
  cancellation_notice_hours integer not null default 24 check (cancellation_notice_hours >= 0),
  default_deposit_type core.deposit_rule_type_enum not null default 'none',
  default_deposit_value numeric(12,2) not null default 0,
  currency_code char(3) not null default 'GBP',
  locale text not null default 'en-GB',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (default_deposit_type = 'none' and default_deposit_value = 0)
    or (default_deposit_type <> 'none' and default_deposit_value >= 0)
  )
);
