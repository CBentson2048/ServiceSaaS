-- 0005_booking_services_appointments_visits.sql

create type booking.appointment_status_enum as enum (
  'pending',
  'confirmed',
  'checked_in',
  'in_progress',
  'completed',
  'cancelled',
  'no_show'
);

create type booking.appointment_service_status_enum as enum (
  'scheduled',
  'in_progress',
  'completed',
  'cancelled'
);

create type booking.staff_request_mode_enum as enum (
  'specific_staff',
  'next_available'
);

create type booking.booking_channel_enum as enum (
  'client_app',
  'staff_app',
  'web_dashboard',
  'phone',
  'walk_in',
  'api'
);

create type booking.deposit_status_enum as enum (
  'pending',
  'requires_action',
  'authorized',
  'paid',
  'partially_refunded',
  'refunded',
  'failed',
  'cancelled'
);

create type booking.waitlist_status_enum as enum (
  'active',
  'matched',
  'cancelled',
  'expired'
);

create type booking.visit_status_enum as enum (
  'checked_in',
  'in_progress',
  'completed',
  'cancelled'
);

create table booking.services (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete cascade,
  slug extensions.citext not null,
  name text not null,
  description text,
  category text,
  estimated_duration_minutes integer not null check (estimated_duration_minutes > 0),
  processing_time_minutes integer not null default 0 check (processing_time_minutes >= 0),
  base_price numeric(12,2) not null default 0,
  deposit_type core.deposit_rule_type_enum not null default 'none',
  deposit_value numeric(12,2) not null default 0,
  requires_patch_test boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (business_id, location_id, slug),
  check (
    (deposit_type = 'none' and deposit_value = 0)
    or (deposit_type <> 'none' and deposit_value >= 0)
  )
);

create table booking.stylist_service_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  staff_profile_id uuid not null references core.staff_profiles(id) on delete cascade,
  service_id uuid not null references booking.services(id) on delete cascade,
  is_active boolean not null default true,
  can_perform_alone boolean not null default true,
  override_duration_minutes integer check (override_duration_minutes is null or override_duration_minutes > 0),
  override_price_amount numeric(12,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, staff_profile_id, service_id)
);

create table booking.appointments (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete restrict,
  client_profile_id uuid not null references core.client_profiles(id) on delete restrict,
  booked_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  assigned_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  requested_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  staff_request_mode booking.staff_request_mode_enum not null default 'specific_staff',
  status booking.appointment_status_enum not null default 'pending',
  booking_channel booking.booking_channel_enum not null default 'client_app',
  scheduled_start_at timestamptz not null,
  scheduled_end_at timestamptz not null,
  check_in_at timestamptz,
  cancelled_at timestamptz,
  completed_at timestamptz,
  communication_preference text,
  client_note text,
  internal_note text,
  cancellation_reason text,
  stripe_checkout_session_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (scheduled_end_at > scheduled_start_at)
);

comment on table booking.appointments is
  'Booking header row. The detailed service lines sit in booking.appointment_services so multi-service bookings stay normalized.';

create table booking.appointment_services (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  appointment_id uuid not null references booking.appointments(id) on delete cascade,
  service_id uuid not null references booking.services(id) on delete restrict,
  assigned_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  sequence_no integer not null check (sequence_no > 0),
  service_name_snapshot text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  price_amount numeric(12,2) not null default 0,
  deposit_required_amount numeric(12,2) not null default 0,
  status booking.appointment_service_status_enum not null default 'scheduled',
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (appointment_id, sequence_no),
  check (
    scheduled_start_at is null
    or scheduled_end_at is null
    or scheduled_end_at > scheduled_start_at
  )
);

create table booking.appointment_status_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  appointment_id uuid not null references booking.appointments(id) on delete cascade,
  old_status booking.appointment_status_enum,
  new_status booking.appointment_status_enum not null,
  changed_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  source text not null default 'api',
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table booking.deposits (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  appointment_id uuid not null references booking.appointments(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete restrict,
  provider text not null default 'stripe',
  provider_payment_intent_id text,
  provider_charge_id text,
  status booking.deposit_status_enum not null default 'pending',
  amount numeric(12,2) not null check (amount >= 0),
  currency_code char(3) not null default 'GBP',
  authorization_expires_at timestamptz,
  paid_at timestamptz,
  refunded_at timestamptz,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table booking.reschedule_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  appointment_id uuid not null references booking.appointments(id) on delete cascade,
  previous_start_at timestamptz not null,
  previous_end_at timestamptz not null,
  new_start_at timestamptz not null,
  new_end_at timestamptz not null,
  changed_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  reason text,
  created_at timestamptz not null default now(),
  check (previous_end_at > previous_start_at),
  check (new_end_at > new_start_at)
);

create table booking.waitlist_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  preferred_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  requested_service_ids uuid[] not null default '{}',
  requested_start_date date not null,
  requested_end_date date,
  preferred_time_window text,
  party_size integer not null default 1 check (party_size > 0),
  communication_preference text,
  status booking.waitlist_status_enum not null default 'active',
  notes text,
  matched_appointment_id uuid references booking.appointments(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requested_end_date is null or requested_end_date >= requested_start_date)
);

create table booking.visits (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete restrict,
  appointment_id uuid unique references booking.appointments(id) on delete set null,
  client_profile_id uuid not null references core.client_profiles(id) on delete restrict,
  primary_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  status booking.visit_status_enum not null default 'checked_in',
  checked_in_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  source text not null default 'appointment',
  service_summary text,
  client_visible_summary text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
