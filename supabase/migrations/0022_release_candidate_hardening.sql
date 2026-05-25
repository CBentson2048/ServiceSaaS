-- 0022_release_candidate_hardening.sql
-- Release-candidate safety rails for payment finalization and diagnostic lookup.

create unique index if not exists booking_appointments_booking_attempt_unique_idx
on booking.appointments ((metadata->>'booking_attempt_id'))
where metadata ? 'booking_attempt_id'
  and metadata->>'booking_attempt_id' is not null;

create index if not exists idx_booking_attempts_payment_status_updated
on booking.booking_attempts (stripe_payment_intent_id, status, updated_at desc)
where stripe_payment_intent_id is not null;

comment on index booking.booking_appointments_booking_attempt_unique_idx is
  'Prevents Stripe webhook replay or concurrent workers from creating more than one appointment for the same public booking attempt.';

comment on index booking.idx_booking_attempts_payment_status_updated is
  'Speeds operational lookup of booking attempt state by Stripe PaymentIntent during webhook diagnostics.';
