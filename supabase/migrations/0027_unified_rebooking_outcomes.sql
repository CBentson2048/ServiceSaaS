-- 0027_unified_rebooking_outcomes.sql
-- Unified source-visit to follow-up appointment linkage for rebooking KPIs.

create table if not exists booking.rebooking_outcomes (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete restrict,
  source_visit_id uuid not null references booking.visits(id) on delete cascade,
  source_appointment_id uuid references booking.appointments(id) on delete set null,
  source_client_profile_id uuid not null references core.client_profiles(id) on delete restrict,
  source_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  rebooked_appointment_id uuid not null references booking.appointments(id) on delete cascade,
  rebook_source text not null check (rebook_source in ('stylist', 'client')),
  rebooked_at timestamptz not null default now(),
  rebooked_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_visit_id),
  check (source_appointment_id is null or source_appointment_id <> rebooked_appointment_id)
);

comment on table booking.rebooking_outcomes is
  'Primary rebooking outcome for a completed/source visit. KPI credit is source-visit based; rebook_source is reporting metadata.';

alter table booking.rebooking_outcomes enable row level security;

drop trigger if exists booking_rebooking_outcomes_set_updated_at on booking.rebooking_outcomes;
create trigger booking_rebooking_outcomes_set_updated_at
before update on booking.rebooking_outcomes
for each row execute function public.set_updated_at();

create index if not exists idx_booking_rebooking_outcomes_business_location
on booking.rebooking_outcomes (business_id, location_id, rebooked_at desc);

create index if not exists idx_booking_rebooking_outcomes_source_staff
on booking.rebooking_outcomes (business_id, source_staff_profile_id, rebooked_at desc);

create index if not exists idx_booking_rebooking_outcomes_client
on booking.rebooking_outcomes (business_id, source_client_profile_id, rebooked_at desc);

drop policy if exists booking_rebooking_outcomes_owner_all on booking.rebooking_outcomes;
create policy booking_rebooking_outcomes_owner_all
on booking.rebooking_outcomes
for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists booking_rebooking_outcomes_select on booking.rebooking_outcomes;
create policy booking_rebooking_outcomes_select
on booking.rebooking_outcomes
for select
using (
  public.is_client_profile_owner(source_client_profile_id)
  or public.has_location_desk_access(business_id, location_id)
  or (
    source_staff_profile_id is not null
    and public.is_staff_profile_owner(source_staff_profile_id)
  )
);

grant select, insert, update, delete on booking.rebooking_outcomes to authenticated, service_role;
