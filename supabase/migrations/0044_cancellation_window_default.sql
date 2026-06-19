-- 0044_cancellation_window_default.sql
-- Customer self-service cancel/rebook: the per-location cancellation window is
-- stored in core.location_settings.cancellation_notice_hours (the same value the
-- booking flow already surfaces as the cancellation-notice policy). The product
-- default for self-service cancellation is "2 days" of notice, so bump the column
-- default from 24h to 48h for NEWLY created locations. Existing rows are left
-- untouched — owners/managers tune the value per location from Location settings.

alter table core.location_settings
  alter column cancellation_notice_hours set default 48;
