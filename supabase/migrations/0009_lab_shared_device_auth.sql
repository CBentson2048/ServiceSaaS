-- 0009_lab_shared_device_auth.sql
-- Shared-device Sheer Lab V1 auth/session foundation.

do $$
begin
  if not exists (select 1 from pg_type where typnamespace = 'core'::regnamespace and typname = 'shared_device_status_enum') then
    create type core.shared_device_status_enum as enum ('registered', 'active', 'inactive', 'revoked');
  end if;

  if not exists (select 1 from pg_type where typnamespace = 'core'::regnamespace and typname = 'shared_device_type_enum') then
    create type core.shared_device_type_enum as enum ('ipad', 'tablet', 'browser');
  end if;

  if not exists (select 1 from pg_type where typnamespace = 'core'::regnamespace and typname = 'shared_device_app_mode_enum') then
    create type core.shared_device_app_mode_enum as enum ('sheer_lab');
  end if;

  if not exists (select 1 from pg_type where typnamespace = 'core'::regnamespace and typname = 'stylist_pin_status_enum') then
    create type core.stylist_pin_status_enum as enum ('active', 'inactive', 'locked', 'rotation_required');
  end if;

  if not exists (select 1 from pg_type where typnamespace = 'lab'::regnamespace and typname = 'device_pairing_status_enum') then
    create type lab.device_pairing_status_enum as enum ('unpaired', 'pairing', 'paired', 'disconnected', 'revoked');
  end if;

  if not exists (select 1 from pg_type where typnamespace = 'lab'::regnamespace and typname = 'formula_session_status_enum') then
    create type lab.formula_session_status_enum as enum ('unlocking', 'active', 'locked', 'expired', 'logged_out');
  end if;
end
$$;

create table core.shared_devices (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  device_name text not null,
  device_type core.shared_device_type_enum not null default 'ipad',
  station_label text,
  app_mode core.shared_device_app_mode_enum not null default 'sheer_lab',
  status core.shared_device_status_enum not null default 'registered',
  registered_at timestamptz not null default now(),
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, location_id, device_name)
);

comment on table core.shared_devices is
  'Salon-scoped shared devices, currently used by the Sheer Lab iPad app.';

create table core.stylist_pin_credentials (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  user_profile_id uuid not null references core.user_profiles(id) on delete cascade,
  role core.membership_role_enum not null,
  pin_hash text not null,
  is_active boolean not null default true,
  status core.stylist_pin_status_enum not null default 'active',
  failed_attempts integer not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  last_verified_at timestamptz,
  last_rotated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(pin_hash) >= 32),
  check (role in ('owner', 'manager', 'stylist'))
);

comment on table core.stylist_pin_credentials is
  'Hashed 4-digit Sheer Lab PIN credentials. Raw PINs must never be stored.';
comment on column core.stylist_pin_credentials.pin_hash is
  'Server-side hash of location-scoped PIN with application pepper/salt. Never store raw PIN.';

create unique index idx_stylist_pin_credentials_active_location_hash
  on core.stylist_pin_credentials (business_id, location_id, pin_hash)
  where is_active;

create unique index idx_stylist_pin_credentials_active_user_location
  on core.stylist_pin_credentials (business_id, location_id, user_profile_id)
  where is_active;

create table lab.device_pairings (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  shared_device_id uuid not null references core.shared_devices(id) on delete cascade,
  ble_device_identifier text not null,
  ble_device_name text,
  device_model text,
  pairing_status lab.device_pairing_status_enum not null default 'pairing',
  paired_at timestamptz,
  last_connected_at timestamptz,
  last_disconnected_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index idx_device_pairings_active_device
  on lab.device_pairings (shared_device_id)
  where pairing_status in ('pairing', 'paired', 'disconnected');

create table lab.formula_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  shared_device_id uuid not null references core.shared_devices(id) on delete restrict,
  user_profile_id uuid not null references core.user_profiles(id) on delete restrict,
  role core.membership_role_enum not null,
  status lab.formula_session_status_enum not null default 'unlocking',
  started_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  expires_at timestamptz not null,
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (role in ('owner', 'manager', 'stylist')),
  check (ended_at is null or ended_at >= started_at)
);

create index idx_formula_sessions_device_status on lab.formula_sessions (shared_device_id, status);
create index idx_formula_sessions_location_activity on lab.formula_sessions (business_id, location_id, last_activity_at desc);
create index idx_formula_sessions_user_status on lab.formula_sessions (user_profile_id, status);

create table audit.lab_access_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  shared_device_id uuid references core.shared_devices(id) on delete set null,
  user_profile_id uuid references core.user_profiles(id) on delete set null,
  event_type text not null,
  metadata_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index idx_lab_access_events_location_created on audit.lab_access_events (business_id, location_id, created_at desc);
create index idx_lab_access_events_device_created on audit.lab_access_events (shared_device_id, created_at desc);
create index idx_lab_access_events_user_created on audit.lab_access_events (user_profile_id, created_at desc);

create trigger shared_devices_set_updated_at
before update on core.shared_devices
for each row execute function public.set_updated_at();

create trigger stylist_pin_credentials_set_updated_at
before update on core.stylist_pin_credentials
for each row execute function public.set_updated_at();

create trigger device_pairings_set_updated_at
before update on lab.device_pairings
for each row execute function public.set_updated_at();

create trigger formula_sessions_set_updated_at
before update on lab.formula_sessions
for each row execute function public.set_updated_at();

alter table core.shared_devices enable row level security;
alter table core.stylist_pin_credentials enable row level security;
alter table lab.device_pairings enable row level security;
alter table lab.formula_sessions enable row level security;
alter table audit.lab_access_events enable row level security;

create policy shared_devices_location_management_select
  on core.shared_devices
  for select
  to authenticated
  using (public.has_location_management_scope(business_id, location_id));

create policy device_pairings_location_management_select
  on lab.device_pairings
  for select
  to authenticated
  using (public.has_location_management_scope(business_id, location_id));

create policy formula_sessions_location_membership_select
  on lab.formula_sessions
  for select
  to authenticated
  using (public.has_location_membership(business_id, location_id));

create policy lab_access_events_location_management_select
  on audit.lab_access_events
  for select
  to authenticated
  using (public.has_location_management_scope(business_id, location_id));

-- Writes for shared devices, PIN credentials, Lab sessions, and audit rows should flow through
-- the API service role so PIN hashing, lockout, session expiry, inventory, and billing handoff
-- stay transactional and auditable.
