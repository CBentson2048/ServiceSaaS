-- 0075_service_revenue_target_rename.sql
-- Wrike #4507280825 — rename "Performance Target" to "Service Revenue Target".
--
-- Luke, 2026-07-26: "Performance is too broad because the system may separately
-- track service revenue, retail, rebooking, average bill, utilisation, client
-- retention and custom KPIs. Service Revenue Target is much clearer for the
-- monetary service threshold."
--
-- Pure rename. No behavioural change, no data change: every value carries over
-- because these are the same columns under a clearer name. Done as its own
-- migration so it can be reviewed and reverted independently of the payroll
-- engine work in 0071-0074.
--
-- The application code changes in the same commit — renaming a column without
-- the matching code change would break the Team edit screen immediately, since
-- the API selects these columns by name.

-- =============================================================================
-- 1. core.staff_profiles columns
-- =============================================================================

alter table core.staff_profiles
  rename column performance_target_amount to service_revenue_target_amount;

alter table core.staff_profiles
  rename column performance_target_mode to service_revenue_target_mode;

comment on column core.staff_profiles.service_revenue_target_amount is
  'Monetary service revenue target for the staff member. Null means fall back to the computed target. Renamed from performance_target_amount in 0075.';

comment on column core.staff_profiles.service_revenue_target_mode is
  'flat = the figure as entered; pro_rated = scaled by hours worked against contracted hours. Renamed from performance_target_mode in 0075.';

-- =============================================================================
-- 2. The enum type
-- =============================================================================
-- Renaming the type keeps the vocabulary consistent everywhere it appears
-- (\d output, error messages, generated types). The VALUES are unchanged, so
-- nothing that reads or writes 'flat' / 'pro_rated' is affected.

do $$
begin
  if exists (
    select 1 from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'core' and t.typname = 'staff_performance_target_mode_enum'
  ) then
    alter type core.staff_performance_target_mode_enum
      rename to staff_service_revenue_target_mode_enum;
  end if;
end
$$;
