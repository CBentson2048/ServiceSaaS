-- 0033_user_profile_timezone.sql
-- Adds a per-user IANA timezone so owners/managers can control how dates and
-- times are displayed across the dashboard. Defaults to Europe/London to match
-- the existing location default and en-GB formatting.

alter table core.user_profiles
  add column if not exists timezone text not null default 'Europe/London'
    check (length(btrim(timezone)) > 0);

comment on column core.user_profiles.timezone is
  'IANA timezone (e.g. Europe/London) used to render dates/times for this user across surfaces.';
