-- 0050_service_segment_free_time.sql
-- Development-time segments + stylist interleaving.
--
-- Some service segments are "development time": the client is processing (e.g.
-- colour developing) and the STYLIST is free to serve another client, even though
-- the chair/appointment still spans the whole time. This migration lets a segment
-- be flagged as stylist-free and moves the double-booking guard off the whole
-- appointment span onto only the stylist's OCCUPIED sub-windows, so a second
-- booking may overlap another's development time as long as their occupied windows
-- don't collide.
--
-- Model:
--   * booking.service_segments.is_stylist_free marks a segment as free.
--   * booking.appointments.occupied_ranges (tstzmultirange) is a WRITE-TIME snapshot
--     of the union of the appointment's non-free segment sub-intervals. A service
--     with no segments contributes one range spanning its whole duration (unchanged
--     behaviour). A fully-free service contributes nothing (never blocks).
--   * booking.appointment_services.segments (jsonb) snapshots the per-service
--     breakdown [{name,durationMinutes,isStylistFree}] for display + stable
--     enforcement (later catalogue edits never move an existing booking's windows).
--   * The no-overlap GiST exclusion is re-keyed from the header span to
--     occupied_ranges &&, so only occupied windows conflict.
--   * booking_attempts (pending checkouts) get the same snapshot columns so the
--     availability engine sees their occupied footprint; there is intentionally NO
--     GiST constraint on attempts (their guard must honour expires_at > now(),
--     which is not immutable) — they stay guarded by the in-app availability recheck
--     plus the appointment-level constraint at finalisation, exactly as today.

-- ---------------------------------------------------------------------------
-- 1. Per-segment "stylist free" flag.
-- ---------------------------------------------------------------------------
alter table booking.service_segments
  add column if not exists is_stylist_free boolean not null default false;

comment on column booking.service_segments.is_stylist_free is
  'When true, the stylist is free during this segment (e.g. colour development), so the window is bookable for another client even though the appointment still spans it.';

-- ---------------------------------------------------------------------------
-- 2. Occupied-window snapshots on appointments + attempts.
-- ---------------------------------------------------------------------------
alter table booking.appointments
  add column if not exists occupied_ranges tstzmultirange;

alter table booking.appointment_services
  add column if not exists segments jsonb not null default '[]'::jsonb;

alter table booking.booking_attempts
  add column if not exists occupied_ranges tstzmultirange;

alter table booking.booking_attempt_services
  add column if not exists segments jsonb not null default '[]'::jsonb;

-- Backfill existing rows to the single full-span range so behaviour is unchanged
-- and — critically — no row is left NULL (a NULL key is skipped by the exclusion
-- index, which would silently un-guard that appointment).
update booking.appointments
   set occupied_ranges = tstzmultirange(tstzrange(scheduled_start_at, scheduled_end_at, '[)'))
 where occupied_ranges is null;

update booking.booking_attempts
   set occupied_ranges = tstzmultirange(tstzrange(selected_start_at, selected_end_at, '[)'))
 where occupied_ranges is null;

alter table booking.appointments
  alter column occupied_ranges set not null;

alter table booking.booking_attempts
  alter column occupied_ranges set not null;

comment on column booking.appointments.occupied_ranges is
  'Write-time snapshot of the union of this appointment''s stylist-occupied sub-intervals (non-free segments). Keys the no-overlap exclusion constraint. A no-segment service spans its whole duration; a fully-free service is empty (never blocks).';

-- ---------------------------------------------------------------------------
-- 3. Re-key the no-overlap constraint onto occupied_ranges.
--    Same predicate as 0045 (statuses pending/accepted/checked_in; assigned
--    stylist not null). Drop + add in one transaction so the guard is never
--    absent. btree_gist (0001) provides the = opclasses; PG17 has the built-in
--    tstzmultirange GiST opclass for &&.
-- ---------------------------------------------------------------------------
alter table booking.appointments
  drop constraint if exists booking_appointments_staff_no_overlap;

alter table booking.appointments
  add constraint booking_appointments_staff_no_overlap
  exclude using gist (
    business_id with =,
    location_id with =,
    assigned_staff_profile_id with =,
    occupied_ranges with &&
  )
  where (
    assigned_staff_profile_id is not null
    and status in ('pending', 'accepted', 'checked_in')
  );

-- ---------------------------------------------------------------------------
-- 4. Teach set_service_segments about is_stylist_free.
--    Unchanged from 0048 except it now persists the per-segment free flag.
--    estimated_duration_minutes stays the SUM of ALL segment durations (free ones
--    included) — the appointment still spans the full time.
-- ---------------------------------------------------------------------------
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
    insert into booking.service_segments (business_id, service_id, name, duration_minutes, is_stylist_free, sort_order)
    select
      p_business_id,
      p_service_id,
      trim(elem->>'name'),
      (elem->>'durationMinutes')::integer,
      coalesce((elem->>'isStylistFree')::boolean, false),
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
