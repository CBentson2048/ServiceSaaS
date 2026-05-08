-- 0016_booking_appointment_no_overlap.sql
--
-- Guard public/client booking creation against double-booking a stylist.

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
    and status in ('pending', 'confirmed', 'checked_in', 'in_progress')
  );
