-- 0066_drop_service_processing_time.sql
-- Remove the standalone per-service "processing time" scalar.
--
-- booking.services.processing_time_minutes (added in 0004) was a free-standing
-- number entered on the service form. It never fed the availability/scheduling
-- engine — the engine derives an appointment's span from estimated_duration_minutes
-- and, for the "stylist is free while colour develops" case, from stylist-free
-- service_segments (0048/0050). The scalar was therefore cosmetic and, worse,
-- unvalidated (it could exceed the service's own duration).
--
-- Processing/development time is now modelled ONLY as a service segment flagged
-- is_stylist_free, which the engine actually honours. Drop the redundant column.
--
-- NOTE: this is unrelated to lab.formulas' processing_time_minutes (how long a
-- colour formula develops), which is a distinct, still-live concept and is left
-- untouched.

alter table booking.services
  drop column if exists processing_time_minutes;
