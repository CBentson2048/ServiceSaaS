-- 0040_appointment_awaiting_acceptance_no_overlap.sql
--
-- An 'awaiting_acceptance' booking must still reserve the stylist's slot so two
-- clients cannot request — and then both be approved into — the same time.
-- Recreate the staff no-overlap exclusion constraint with 'awaiting_acceptance'
-- included in the active-status set (separate migration from 0039 so the new
-- enum value is committed and usable here).

alter table booking.appointments
  drop constraint if exists booking_appointments_staff_no_overlap;

alter table booking.appointments
  add constraint booking_appointments_staff_no_overlap
  exclude using gist (
    business_id with =,
    location_id with =,
    assigned_staff_profile_id with =,
    tstzrange(scheduled_start_at, scheduled_end_at, '[)') with &&
  )
  where (
    assigned_staff_profile_id is not null
    and status in ('awaiting_acceptance', 'pending', 'confirmed', 'checked_in', 'in_progress')
  );
