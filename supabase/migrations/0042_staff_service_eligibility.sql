-- 0042_staff_service_eligibility.sql
-- Adds the service <-> stylist eligibility model. Not every stylist can perform
-- every service (e.g. a senior stylist can do Balayage but an apprentice cannot),
-- so booking.staff_service_eligibility records which staff member is qualified to
-- perform which service.
--
-- Semantics (decided with the business owner):
--   * A service with NO eligibility rows is treated as UNASSIGNED / unbookable —
--     no stylist will be offered for it in any booking flow. The dashboard surfaces
--     these as a warning so an owner can assign stylists. There is intentionally
--     NO backfill: existing services start unassigned until an owner picks stylists.
--   * Eligibility is per (staff, service). Services already carry their own
--     location scope (booking.services.location_id), and staff have a single
--     primary location, so the junction does not duplicate a location dimension.
--   * A stylist must be eligible for ALL selected services to be bookable for a
--     multi-service appointment (one stylist performs the whole appointment).

create table if not exists booking.staff_service_eligibility (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  service_id uuid not null references booking.services(id) on delete cascade,
  staff_profile_id uuid not null references core.staff_profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (service_id, staff_profile_id)
);

-- Hot query: eligible stylists for a set of services within a business
-- (booking flow). Also serves business_id-only scans via the leading column.
create index if not exists idx_staff_service_eligibility_business_service
  on booking.staff_service_eligibility (business_id, service_id);

-- Hot query: the services a stylist can perform within a business
-- (staff hydration + replacement).
create index if not exists idx_staff_service_eligibility_business_staff
  on booking.staff_service_eligibility (business_id, staff_profile_id);

-- Support FK cascade cleanup when a service or staff profile is deleted.
create index if not exists idx_staff_service_eligibility_service_id
  on booking.staff_service_eligibility (service_id);

create index if not exists idx_staff_service_eligibility_staff_profile_id
  on booking.staff_service_eligibility (staff_profile_id);

drop trigger if exists staff_service_eligibility_set_updated_at on booking.staff_service_eligibility;
create trigger staff_service_eligibility_set_updated_at
before update on booking.staff_service_eligibility
for each row execute function public.set_updated_at();

alter table booking.staff_service_eligibility enable row level security;

drop policy if exists staff_service_eligibility_owner_all on booking.staff_service_eligibility;
create policy staff_service_eligibility_owner_all
on booking.staff_service_eligibility for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists staff_service_eligibility_member_select on booking.staff_service_eligibility;
create policy staff_service_eligibility_member_select
on booking.staff_service_eligibility for select
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = booking.staff_service_eligibility.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

grant select, insert, update, delete on booking.staff_service_eligibility to authenticated, service_role;

comment on table booking.staff_service_eligibility is
  'Which staff member (stylist) is qualified to perform which service. A service with no rows is unassigned/unbookable. Eligibility is per (staff, service); booking requires a stylist eligible for ALL selected services.';

-- Atomic full-replacement of a stylist's service eligibility. Performing the
-- delete + insert inside one function call keeps them in a single transaction,
-- so a caller never observes a partial set (and there is no non-transactional
-- upsert/prune window). The API validates that the service IDs belong to the
-- business before calling this; the function itself only touches rows for the
-- given (business, staff) pair.
create or replace function booking.set_staff_service_eligibility(
  p_business_id uuid,
  p_staff_profile_id uuid,
  p_service_ids uuid[]
) returns void
language plpgsql
as $$
begin
  delete from booking.staff_service_eligibility
   where business_id = p_business_id
     and staff_profile_id = p_staff_profile_id
     and (p_service_ids is null or not (service_id = any (p_service_ids)));

  if p_service_ids is not null and array_length(p_service_ids, 1) is not null then
    insert into booking.staff_service_eligibility (business_id, service_id, staff_profile_id)
    select p_business_id, sid, p_staff_profile_id
      from unnest(p_service_ids) as sid
    on conflict (service_id, staff_profile_id) do nothing;
  end if;
end;
$$;

grant execute on function booking.set_staff_service_eligibility(uuid, uuid, uuid[])
  to authenticated, service_role;
