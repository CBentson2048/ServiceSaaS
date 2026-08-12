-- 0084_slot_size_options.sql
-- Week 5 — "Implement configurable appointment slot size per location
-- (15/30/60 min)".
--
-- The column core.location_settings.appointment_slot_minutes has existed since
-- 0003 with only a `> 0` check, so any integer (7, 13, 480…) was storable while
-- the product promise is exactly three granularities. The diary grid, the
-- availability engine and the settings UI all now key off this value, so the
-- database enforces the closed set the app layers assume.
--
-- Rows holding an out-of-range value (none are expected on dev/prod, but the
-- old DTO allowed 1–480) are normalised to the platform default of 15 before
-- the constraint lands, keeping the migration re-runnable and never failing on
-- legacy data.

update core.location_settings
set appointment_slot_minutes = 15
where appointment_slot_minutes not in (15, 30, 60);

alter table core.location_settings
  drop constraint if exists location_settings_slot_minutes_allowed;

alter table core.location_settings
  add constraint location_settings_slot_minutes_allowed
  check (appointment_slot_minutes in (15, 30, 60));

comment on column core.location_settings.appointment_slot_minutes is
  'Diary/booking granularity for this location: 15, 30 or 60 minutes. Drives '
  'the appointment-book grid, click-to-book snapping and online availability '
  'stepping (kept in sync with APPOINTMENT_SLOT_OPTIONS in @sheer/domain).';
