-- 0062_service_rebooking_nudge.sql
-- Per-service rebooking nudge (Wrike #4507281502).
--
-- A configurable, per-service retention nudge: after a client completes a
-- qualifying appointment, schedule an automated "time to rebook" message at a
-- per-service interval (default ~5 weeks). On/off and interval are configured
-- per service; the message is delivered through the existing WhatsApp-first
-- messaging service, and suppressed if the client has already rebooked.
--
-- This migration only adds the two config columns on booking.services. The
-- scheduling reuses comms.notification_events (new event_key 'rebooking_nudge')
-- so no new messaging tables are needed.

alter table booking.services
  add column if not exists rebooking_nudge_enabled boolean not null default false;

alter table booking.services
  add column if not exists rebooking_nudge_interval_days integer not null default 35;

-- Sensible bounds: at least a day, at most a year. Only meaningful when enabled,
-- but we keep the value valid regardless so toggling on is always safe.
alter table booking.services
  drop constraint if exists services_rebooking_interval_days_range;
alter table booking.services
  add constraint services_rebooking_interval_days_range
  check (rebooking_nudge_interval_days between 1 and 365);

comment on column booking.services.rebooking_nudge_enabled is
  'When true, completing an appointment with this service schedules a rebooking nudge (Wrike #4507281502).';
comment on column booking.services.rebooking_nudge_interval_days is
  'Days after appointment completion to send the rebooking nudge. Default 35 (~5 weeks). Only used when rebooking_nudge_enabled.';
