-- 0072_payroll_targets.sql
-- Wrike #4507281798 — Week 3, individual stylist targets and salon-level targets.
--
-- Targets are effective-dated records rather than scalar columns so that raising
-- someone's target in June does not retrospectively change whether they hit it
-- in May.
--
-- Scope note: these are TRACKING targets (revenue vs target on the Team report,
-- Week 7). They are deliberately separate from the thresholds inside a
-- commission stage, which are what actually move money - Luke's Example A pays
-- above "2.5x weekly base pay", and that lives on the commission stage in
-- payroll.pay_structure_stages, not here. Across every platform reviewed,
-- targets are motivational tracking and band thresholds are the pay-affecting
-- mechanism; keeping the two apart avoids conflating them.
--
-- Supersedes the scalar core.staff_profiles.performance_target_amount /
-- performance_target_mode columns (0054/0056), which are stored today but read
-- by no code. Those are left in place for now; the API reads targets from here.

-- =============================================================================
-- 1. Enums
-- =============================================================================

do $$
begin
  create type payroll.target_scope_enum as enum ('staff', 'location', 'business');
exception
  when duplicate_object then null;
end
$$;

-- 'service_revenue' is the metric Luke asked to surface as "Service Revenue
-- Target" (his 2026-07-21 rename request, pending final confirmation).
do $$
begin
  create type payroll.target_metric_enum as enum (
    'service_revenue',
    'retail_revenue',
    'total_revenue'
  );
exception
  when duplicate_object then null;
end
$$;

-- Mirrors the pay-period frequencies Luke asked for (2026-07-25) so a target can
-- be compared against the period it belongs to.
do $$
begin
  create type payroll.period_frequency_enum as enum (
    'weekly',
    'fortnightly',
    'four_weekly',
    'monthly',
    'custom'
  );
exception
  when duplicate_object then null;
end
$$;

-- Matches the existing core.staff_performance_target_mode_enum values. 'pro_rated'
-- scales the target by hours worked against contracted hours, per Luke's
-- 2026-07-13 direction ("pro rata by hours worked ... the fairest way").
do $$
begin
  create type payroll.target_basis_enum as enum ('flat', 'pro_rated');
exception
  when duplicate_object then null;
end
$$;

-- =============================================================================
-- 2. payroll.targets
-- =============================================================================

create table if not exists payroll.targets (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  scope payroll.target_scope_enum not null,

  -- Exactly one of these is set for staff/location scope; both null for
  -- business scope (enforced below).
  staff_profile_id uuid references core.staff_profiles(id) on delete cascade,
  location_id uuid references core.locations(id) on delete cascade,

  metric payroll.target_metric_enum not null default 'service_revenue',
  frequency payroll.period_frequency_enum not null default 'weekly',
  basis payroll.target_basis_enum not null default 'flat',

  -- Minor units. bigint throughout payroll: these aggregate across staff and
  -- periods, where int4 (max ~GBP 21.4m in pence) is uncomfortably close for a
  -- multi-location group's annual figures.
  amount_cents bigint not null check (amount_cents >= 0),
  currency_code text not null default 'GBP',

  effective_from date not null,
  effective_to date,

  notes text,
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint targets_effective_range
    check (effective_to is null or effective_to > effective_from),
  -- Scope determines exactly which owning id must be present.
  constraint targets_scope_ids check (
    (scope = 'staff'    and staff_profile_id is not null and location_id is null)
    or (scope = 'location' and location_id is not null and staff_profile_id is null)
    or (scope = 'business' and staff_profile_id is null and location_id is null)
  ),
  -- One target per subject + metric + frequency at any one time. Three partial
  -- constraints rather than one, because NULL owning ids never conflict in a
  -- GiST exclusion and business-scope rows would otherwise be unconstrained.
  constraint targets_staff_no_overlap
    exclude using gist (
      staff_profile_id with =,
      metric with =,
      frequency with =,
      daterange(effective_from, effective_to, '[)') with &&
    ) where (scope = 'staff'),
  constraint targets_location_no_overlap
    exclude using gist (
      location_id with =,
      metric with =,
      frequency with =,
      daterange(effective_from, effective_to, '[)') with &&
    ) where (scope = 'location'),
  constraint targets_business_no_overlap
    exclude using gist (
      business_id with =,
      metric with =,
      frequency with =,
      daterange(effective_from, effective_to, '[)') with &&
    ) where (scope = 'business')
);

comment on table payroll.targets is
  'Effective-dated revenue targets at staff, location or business scope. Tracking and reporting only - commission band thresholds live on payroll.pay_structure_stages.';

comment on column payroll.targets.basis is
  'flat = the figure as entered; pro_rated = scaled by hours worked against contracted hours for the period.';

create index if not exists idx_targets_staff_effective
  on payroll.targets (staff_profile_id, effective_from desc)
  where staff_profile_id is not null;

create index if not exists idx_targets_location_effective
  on payroll.targets (location_id, effective_from desc)
  where location_id is not null;

create index if not exists idx_targets_business_scope
  on payroll.targets (business_id, scope, metric);

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_targets_set_updated_at'
      and tgrelid = 'payroll.targets'::regclass
  ) then
    create trigger payroll_targets_set_updated_at
      before update on payroll.targets
      for each row execute function public.set_updated_at();
  end if;
end
$$;

-- =============================================================================
-- 3. Row-level security
-- =============================================================================

alter table payroll.targets enable row level security;

create policy targets_owner_select
  on payroll.targets
  for select
  to authenticated
  using (public.is_business_owner(business_id));

grant select, insert, update, delete on payroll.targets
  to authenticated, service_role;
