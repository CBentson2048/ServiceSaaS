-- 0049: Make provider_payment_intent_id a FULL unique index on booking.deposits.
--
-- The public-booking deposit write (public-booking.service.ts upsertPendingDeposit)
-- calls supabase upsert with { onConflict: 'provider_payment_intent_id' }, which
-- PostgREST compiles to INSERT ... ON CONFLICT (provider_payment_intent_id) DO UPDATE.
-- Postgres will NOT infer a PARTIAL unique index for a bare ON CONFLICT target, so
-- the existing partial index (idx_booking_deposits_provider_payment_intent_id, from
-- migration 0017, WHERE provider_payment_intent_id IS NOT NULL) does not match and the
-- statement fails with SQLSTATE 42P10 ("no unique or exclusion constraint matching the
-- ON CONFLICT specification"). That surfaces as the "Unable to persist deposit" alert.
--
-- Fix: replace the partial unique index with a FULL (non-partial) unique index on the
-- same nullable column. Postgres treats NULLs as DISTINCT in unique indexes, so multiple
-- deposit rows with NULL provider_payment_intent_id remain allowed (identical semantics
-- to the old partial index for the NULL case) while ON CONFLICT inference now succeeds.

-- Idempotent: drop the old partial index if present.
drop index if exists booking.idx_booking_deposits_provider_payment_intent_id;

-- Recreate as a full unique index. Reuses the same name so nothing else needs updating.
-- NULLs remain distinct, so pending deposits created before a payment intent exists
-- (appointment_id NULL, provider_payment_intent_id set) are unaffected; only genuine
-- duplicate non-null intent ids would conflict, and Stripe payment intent ids are unique.
create unique index if not exists idx_booking_deposits_provider_payment_intent_id
  on booking.deposits (provider_payment_intent_id);
