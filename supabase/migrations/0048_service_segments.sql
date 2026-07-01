-- 0048_service_segments.sql
-- Breaks a service down into ordered segments, each with its own time to complete
-- (e.g. Balayage = Consultation 15m -> Apply colour 45m -> Rinse & style 15m).
--
-- Semantics (decided with the business owner):
--   * A segment has a name, a duration in minutes, and a position (sort_order).
--   * When a service has one or more segments, its total time is the SUM of its
--     segment durations, and booking.services.estimated_duration_minutes is kept
--     in sync automatically (see booking.set_service_segments). The booking engine
--     is unaffected: it keeps reading estimated_duration_minutes.
--   * A service with NO segments keeps a manually-entered estimated_duration_minutes,
--     exactly as before. There is intentionally NO backfill.
--   * Segments are managed by owners/managers via the service edit form; the whole
--     set is replaced atomically on save.

create table if not exists booking.service_segments (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  service_id uuid not null references booking.services(id) on delete cascade,
  name text not null,
  duration_minutes integer not null check (duration_minutes > 0),
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Hot query: a service's segments in order (service edit form + list hydration).
-- Also serves business_id-only scans via the leading column.
create index if not exists idx_service_segments_business_service
  on booking.service_segments (business_id, service_id, sort_order);

-- Support FK cascade cleanup when a service is deleted.
create index if not exists idx_service_segments_service_id
  on booking.service_segments (service_id);

drop trigger if exists service_segments_set_updated_at on booking.service_segments;
create trigger service_segments_set_updated_at
before update on booking.service_segments
for each row execute function public.set_updated_at();

alter table booking.service_segments enable row level security;

drop policy if exists service_segments_owner_all on booking.service_segments;
create policy service_segments_owner_all
on booking.service_segments for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists service_segments_member_select on booking.service_segments;
create policy service_segments_member_select
on booking.service_segments for select
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = booking.service_segments.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

grant select, insert, update, delete on booking.service_segments to authenticated, service_role;

comment on table booking.service_segments is
  'Ordered breakdown of a service into named segments, each with a duration in minutes. When a service has segments, its estimated_duration_minutes equals the sum of its segment durations (kept in sync by booking.set_service_segments).';

-- Atomic full-replacement of a service's segments. Delete + insert inside one
-- function call keeps them in a single transaction, so a caller never observes a
-- partial set. p_segments is a jsonb array of {name, durationMinutes} in the
-- desired display order; sort_order is assigned from the array position. When the
-- array is non-empty, the service's estimated_duration_minutes is set to the sum
-- of the segment durations in the same transaction, so the total can never diverge
-- from the segments. An empty/null array clears the segments and leaves the
-- (manually-entered) estimated_duration_minutes untouched. The API validates that
-- the service belongs to the business before calling this; the function only
-- touches rows for the given (business, service) pair.
create or replace function booking.set_service_segments(
  p_business_id uuid,
  p_service_id uuid,
  p_segments jsonb
) returns void
language plpgsql
as $$
declare
  v_total integer;
begin
  delete from booking.service_segments
   where business_id = p_business_id
     and service_id = p_service_id;

  if p_segments is not null
     and jsonb_typeof(p_segments) = 'array'
     and jsonb_array_length(p_segments) > 0 then
    insert into booking.service_segments (business_id, service_id, name, duration_minutes, sort_order)
    select
      p_business_id,
      p_service_id,
      trim(elem->>'name'),
      (elem->>'durationMinutes')::integer,
      (ord - 1)::integer
    from jsonb_array_elements(p_segments) with ordinality as t(elem, ord);

    select coalesce(sum(duration_minutes), 0) into v_total
      from booking.service_segments
     where business_id = p_business_id
       and service_id = p_service_id;

    update booking.services
       set estimated_duration_minutes = v_total
     where id = p_service_id
       and business_id = p_business_id;
  end if;
end;
$$;

grant execute on function booking.set_service_segments(uuid, uuid, jsonb)
  to authenticated, service_role;
