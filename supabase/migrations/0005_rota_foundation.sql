-- 0005_rota_foundation.sql

create type rota.shift_status_enum as enum (
  'draft',
  'published',
  'completed',
  'cancelled'
);

create type rota.leave_request_status_enum as enum (
  'pending',
  'approved',
  'rejected',
  'cancelled'
);

create type rota.absence_type_enum as enum (
  'sickness',
  'emergency',
  'bereavement',
  'unauthorised',
  'other'
);

create table rota.shifts (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  staff_profile_id uuid not null references core.staff_profiles(id) on delete cascade,
  status rota.shift_status_enum not null default 'draft',
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  published_at timestamptz,
  source text not null default 'rota',
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (scheduled_end_at > scheduled_start_at)
);

comment on table rota.shifts is
  'Week 1 availability source of truth. Booking should derive staff availability from these rows.';

create table rota.shift_breaks (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  shift_id uuid not null references rota.shifts(id) on delete cascade,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  is_paid boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  check (ended_at > started_at)
);

create table rota.leave_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  staff_profile_id uuid not null references core.staff_profiles(id) on delete cascade,
  requested_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  reviewed_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  start_date date not null,
  end_date date not null,
  status rota.leave_request_status_enum not null default 'pending',
  reason text,
  reviewed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_date >= start_date)
);

create table rota.absence_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  staff_profile_id uuid not null references core.staff_profiles(id) on delete cascade,
  absence_type rota.absence_type_enum not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  notes text,
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at is null or ends_at > starts_at)
);
