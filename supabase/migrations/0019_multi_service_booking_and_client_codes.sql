-- 0019_multi_service_booking_and_client_codes.sql
--
-- Multi-service public booking configuration plus immutable CRM client codes.

alter table core.client_profiles
  add column client_code text;

create unique index idx_core_client_profiles_client_code
  on core.client_profiles (client_code)
  where client_code is not null;

alter table core.client_profiles
  add constraint core_client_profiles_client_code_format
  check (client_code is null or client_code ~ '^[A-Z0-9]{8,}$');

create or replace function core.generate_client_code()
returns text
language plpgsql
as $$
declare
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text := '';
  i integer;
begin
  for i in 1..8 loop
    code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::integer, 1);
  end loop;
  return code;
end;
$$;

create or replace function core.assign_client_code()
returns trigger
language plpgsql
as $$
declare
  candidate text;
begin
  if tg_op = 'UPDATE' and new.client_code is distinct from old.client_code then
    raise exception 'client_code is immutable';
  end if;

  if new.client_code is null then
    loop
      candidate := core.generate_client_code();
      exit when not exists (
        select 1
        from core.client_profiles cp
        where cp.client_code = candidate
      );
    end loop;
    new.client_code := candidate;
  end if;

  return new;
end;
$$;

create trigger core_client_profiles_assign_client_code
before insert or update on core.client_profiles
for each row execute function core.assign_client_code();

update core.client_profiles
set updated_at = updated_at
where client_code is null;

alter table core.client_profiles
  alter column client_code set not null;

comment on column core.client_profiles.client_code is
  'Immutable system-generated alphanumeric client identifier. It is never derived from mutable client contact details.';

create table booking.service_requirement_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete cascade,
  trigger_service_id uuid not null references booking.services(id) on delete cascade,
  title text not null,
  description text,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(btrim(title)) > 0)
);

create table booking.service_requirement_options (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete cascade,
  rule_id uuid not null references booking.service_requirement_rules(id) on delete cascade,
  service_id uuid not null references booking.services(id) on delete cascade,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  unique (rule_id, service_id)
);

create table booking.service_upgrade_suggestions (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete cascade,
  trigger_service_id uuid not null references booking.services(id) on delete cascade,
  suggested_service_id uuid not null references booking.services(id) on delete cascade,
  title text not null,
  description text not null,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (business_id, location_id, trigger_service_id, suggested_service_id),
  check (trigger_service_id <> suggested_service_id),
  check (length(btrim(title)) > 0),
  check (length(btrim(description)) > 0)
);

create table booking.booking_attempt_services (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  booking_attempt_id uuid not null references booking.booking_attempts(id) on delete cascade,
  service_id uuid not null references booking.services(id) on delete restrict,
  assigned_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  sequence_no integer not null check (sequence_no > 0),
  service_name_snapshot text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  price_amount numeric(12,2) not null default 0,
  deposit_required_amount numeric(12,2) not null default 0,
  scheduled_start_at timestamptz,
  scheduled_end_at timestamptz,
  created_at timestamptz not null default now(),
  unique (booking_attempt_id, sequence_no),
  check (
    scheduled_start_at is null
    or scheduled_end_at is null
    or scheduled_end_at > scheduled_start_at
  )
);

create index idx_booking_service_requirement_rules_trigger
  on booking.service_requirement_rules (business_id, location_id, trigger_service_id)
  where is_active;

create index idx_booking_service_requirement_options_rule
  on booking.service_requirement_options (rule_id, sort_order);

create index idx_booking_service_upgrade_suggestions_trigger
  on booking.service_upgrade_suggestions (business_id, location_id, trigger_service_id, sort_order)
  where is_active;

create index idx_booking_attempt_services_attempt
  on booking.booking_attempt_services (booking_attempt_id, sequence_no);

create trigger booking_service_requirement_rules_set_updated_at
before update on booking.service_requirement_rules
for each row execute function public.set_updated_at();

create trigger booking_service_upgrade_suggestions_set_updated_at
before update on booking.service_upgrade_suggestions
for each row execute function public.set_updated_at();

alter table booking.service_requirement_rules enable row level security;
alter table booking.service_requirement_options enable row level security;
alter table booking.service_upgrade_suggestions enable row level security;
alter table booking.booking_attempt_services enable row level security;

create policy booking_service_requirement_rules_owner_all
on booking.service_requirement_rules
for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

create policy booking_service_requirement_options_owner_all
on booking.service_requirement_options
for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

create policy booking_service_upgrade_suggestions_owner_all
on booking.service_upgrade_suggestions
for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

create policy booking_booking_attempt_services_owner_all
on booking.booking_attempt_services
for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

create policy booking_booking_attempt_services_manager_all
on booking.booking_attempt_services
for all
using (public.has_location_management_scope(business_id, location_id))
with check (public.has_location_management_scope(business_id, location_id));

create policy booking_booking_attempt_services_client_select
on booking.booking_attempt_services
for select
using (
  exists (
    select 1
    from booking.booking_attempts ba
    where ba.id = booking.booking_attempt_services.booking_attempt_id
      and public.is_client_profile_owner(ba.client_profile_id)
  )
);

grant select, insert, update, delete
  on booking.service_requirement_rules,
     booking.service_requirement_options,
     booking.service_upgrade_suggestions,
     booking.booking_attempt_services
  to authenticated, service_role;
