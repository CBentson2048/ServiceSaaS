-- 0039_appointment_awaiting_acceptance_status.sql
--
-- Client-booked appointments (mobile + public web) now start as
-- 'awaiting_acceptance' until an owner/manager reviews and approves them.
-- Staff-created bookings stay 'confirmed'.
--
-- The enum value is added in its own migration (its own transaction) so the
-- no-overlap constraint in 0040 can reference it — Postgres forbids using a
-- newly added enum value in the same transaction that adds it.

alter type booking.appointment_status_enum add value if not exists 'awaiting_acceptance';
