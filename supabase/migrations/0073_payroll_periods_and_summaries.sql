-- 0073_payroll_periods_and_summaries.sql
-- Wrike #4507281885 / #4507281917 — Week 3, wage summaries, settlement and pay history.
--
-- This is where the Financial Rules Engine's OUTPUT lands. Principles from
-- docs/financial-rules-engine-principles.md that shape this file:
--   2. Explainability — every component of a statement is a separate, visible
--      figure (base pay, hours, revenue, target, bands, accelerator, retail,
--      deductions, adjustments, final total), never a single opaque number.
--      Both sides of a greater-of comparison survive, with the winner recorded.
--   3. Traceability   — pay_summary_lines carries source_type/source_id and the
--      rule version that priced each line; accrual is on work performed, not
--      when cash moved; inputs_snapshot lets a statement be re-derived later.
--   4. Source honesty — source_unavailable marks "we are not recording this",
--      and a CHECK forbids such a line from carrying a non-zero figure.
--   5. Netted settlement — the figure columns answer "whose money is whose":
--      total collected, the stylist's share, the business's share, rent,
--      deductions, bonuses, and a signed final payable (negative = the stylist
--      owes the business). For self-employed staff only the salon's share is
--      business revenue - the rest is a liability, and the Week 7 P&L must not
--      count it as income.
--
-- Four tables:
--   1. payroll.pay_periods       — the period being calculated or paid
--   2. payroll.pay_summaries     — one settlement statement per staff member
--   3. payroll.pay_summary_lines — the drill-down to source transactions
--   4. payroll.pay_adjustments   — corrections carried into a later period
--
-- Luke, 2026-07-25:
--   * Periods: weekly, fortnightly, four-weekly, monthly, custom - and
--     "calculation periods and payment periods should also be able to differ",
--     which is why a period has a `kind` and calculation periods can roll up
--     into a payment period.
--   * Approval: Draft -> Ready for Review -> Approved -> Locked -> Paid.
--   * "Locked payroll periods should never be silently changed. Instead,
--     adjustments should appear in the next available pay period with a full
--     audit trail." -> payroll.pay_adjustments, plus database triggers that
--     physically refuse to mutate a locked statement.
--   * Settlement must distinguish money collected / money belonging to the
--     stylist / money belonging to the business / tips / deductions / final
--     settlement -> the figure columns on payroll.pay_summaries.
--
-- All money is minor units in bigint. Deliberately wider than billing.*'s
-- integer columns because these aggregate across staff and periods.
--
-- DELETION POSTURE (verified empirically against PostgreSQL 18):
-- Once payroll exists it resists deletion, which is the correct posture for
-- financial records. Specifically: a pay period with summaries cannot be
-- deleted; a staff profile with summaries cannot be deleted; a rule version
-- referenced by a summary line cannot be deleted; and consequently a business
-- with payroll history cannot be deleted outright. The only business-deletion
-- path in the codebase today is the signup-failure rollback in
-- auth.service.ts (rollbackCreatedAccount), which runs against a
-- just-created business with no payroll rows, so this is not a regression.
-- Offboarding a real business with payroll history is a deliberate,
-- explicit operation and should stay that way.

-- =============================================================================
-- 1. Enums
-- =============================================================================

do $$
begin
  create type payroll.pay_period_kind_enum as enum ('calculation', 'payment');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type payroll.pay_period_status_enum as enum (
    'draft',
    'ready_for_review',
    'approved',
    'locked',
    'paid'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type payroll.pay_line_type_enum as enum (
    'service_revenue',
    'retail_revenue',
    'base_pay',
    'commission',
    'revenue_split',
    'chair_rent',
    'deduction',
    'bonus',
    'tip',
    'adjustment',
    'net_payable'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type payroll.pay_line_source_enum as enum (
    'appointment',
    'visit',
    'appointment_service',
    'retail_sale',
    'deposit',
    'adjustment',
    'manual'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type payroll.adjustment_reason_enum as enum (
    'refund',
    'void',
    'correction',
    'manual'
  );
exception
  when duplicate_object then null;
end
$$;

-- =============================================================================
-- 1b. payroll.payroll_settings — how periods are generated for a business
-- =============================================================================
-- Luke Ormsby Hair runs a Tuesday-to-Monday operational week (2026-07-26):
-- "Start: Tuesday at 00:00, End: Monday at 23:59". The salons trade Tuesday to
-- Saturday, so the last service activity is normally Saturday; Sunday and
-- Monday stay inside the week for training, events or future opening.
-- Configurable per business, because other salons anchor elsewhere.

create table if not exists payroll.payroll_settings (
  business_id uuid primary key references core.businesses(id) on delete cascade,
  -- 0 = Sunday .. 6 = Saturday, matching the weekday convention already used by
  -- core.location_settings.opening_hours (0053). 2 = Tuesday.
  week_start_day smallint not null default 2
    check (week_start_day between 0 and 6),
  default_calculation_frequency payroll.period_frequency_enum not null default 'weekly',
  default_payment_frequency payroll.period_frequency_enum not null default 'monthly',
  -- Period boundaries are LOCAL dates. Visits are stored as timestamptz and the
  -- rest of the platform computes UTC windows, so attributing a visit to a
  -- period must convert through this timezone first - in Europe/London a
  -- Tuesday 00:00 local boundary is 23:00 UTC on Monday for half the year.
  -- Null falls back to the location's timezone (core.locations.timezone).
  timezone text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table payroll.payroll_settings is
  'Per business payroll period configuration: which day the pay week starts, default calculation and payment frequencies, and the timezone whose local dates define period boundaries.';

comment on column payroll.payroll_settings.week_start_day is
  '0=Sunday..6=Saturday. Defaults to 2 (Tuesday) per the Luke Ormsby Hair operational week.';

insert into payroll.payroll_settings (business_id)
select id from core.businesses
on conflict (business_id) do nothing;

-- Businesses created AFTER this migration need the same defaults, or they get
-- no week anchor and an empty capture matrix - which would make
-- payroll.missing_data_sources() warn about service revenue that is in fact
-- captured. (core.security_levels in 0055 has exactly this shape of gap, seeded
-- once at migration time and topped up by application code; payroll does it in
-- the database so there is no second place to forget.)
create or replace function payroll.seed_business_payroll_defaults()
returns trigger
language plpgsql
security definer
set search_path = payroll, public
as $$
begin
  insert into payroll.payroll_settings (business_id)
  values (new.id)
  on conflict (business_id) do nothing;

  perform payroll.seed_business_data_sources(new.id);

  return new;
end;
$$;

comment on function payroll.seed_business_payroll_defaults() is
  'Gives every newly created business its payroll settings row and data-source capture matrix.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'core_businesses_seed_payroll_defaults'
      and tgrelid = 'core.businesses'::regclass
  ) then
    create trigger core_businesses_seed_payroll_defaults
      after insert on core.businesses
      for each row execute function payroll.seed_business_payroll_defaults();
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_payroll_settings_set_updated_at'
      and tgrelid = 'payroll.payroll_settings'::regclass
  ) then
    create trigger payroll_payroll_settings_set_updated_at
      before update on payroll.payroll_settings
      for each row execute function public.set_updated_at();
  end if;
end
$$;

-- =============================================================================
-- 2. payroll.pay_periods
-- =============================================================================

create table if not exists payroll.pay_periods (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- null = the whole business (the common case); set to run payroll per site.
  location_id uuid references core.locations(id) on delete cascade,

  kind payroll.pay_period_kind_enum not null default 'calculation',
  frequency payroll.period_frequency_enum not null default 'monthly',

  -- period_end is the EXCLUSIVE end, consistent with the effective-dating
  -- convention used across payroll.* and billing.location_fixed_costs.
  period_start date not null,
  period_end date not null,
  label text,

  status payroll.pay_period_status_enum not null default 'draft',

  -- A calculation period may roll up into a payment period, so a salon can
  -- calculate weekly but pay monthly.
  parent_payment_period_id uuid references payroll.pay_periods(id) on delete set null,

  generated_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  generated_at timestamptz,
  approved_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  approved_at timestamptz,
  locked_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  locked_at timestamptz,
  marked_paid_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  paid_at timestamptz,

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pay_periods_range check (period_end > period_start),
  -- Only a calculation period may have a parent. That the parent is itself a
  -- payment period, in the same business, is enforced by trigger below - a
  -- CHECK cannot see another row.
  constraint pay_periods_parent_only_for_calculation
    check (parent_payment_period_id is null or kind = 'calculation'),
  constraint pay_periods_no_self_parent
    check (parent_payment_period_id is null or parent_payment_period_id <> id),
  -- Two periods of the same kind must never cover the same day for the same
  -- scope: overlapping windows would pay the same visit twice. A plain unique
  -- index on the exact window is not enough - 1-14 Jul and 7-21 Jul are
  -- distinct tuples but overlap. Two partial constraints because a NULL
  -- location_id never conflicts in a GiST exclusion.
  constraint pay_periods_location_no_overlap
    exclude using gist (
      business_id with =,
      location_id with =,
      kind with =,
      daterange(period_start, period_end, '[)') with &&
    ) where (location_id is not null),
  constraint pay_periods_business_no_overlap
    exclude using gist (
      business_id with =,
      kind with =,
      daterange(period_start, period_end, '[)') with &&
    ) where (location_id is null)
);

comment on table payroll.pay_periods is
  'A payroll window. kind=calculation is what the engine computes over; kind=payment is what is actually disbursed, and may aggregate several calculation periods.';

comment on column payroll.pay_periods.period_end is
  'EXCLUSIVE end date, matching the effective-dating convention used elsewhere.';

-- One period per business/location/kind/window. coalesce() gives business-wide
-- rows a stable key, since NULL location_id would otherwise never collide.
create unique index if not exists idx_pay_periods_unique_window
  on payroll.pay_periods (
    business_id,
    coalesce(location_id, '00000000-0000-0000-0000-000000000000'::uuid),
    kind,
    period_start,
    period_end
  );

create index if not exists idx_pay_periods_business_start
  on payroll.pay_periods (business_id, period_start desc);

create index if not exists idx_pay_periods_status
  on payroll.pay_periods (business_id, status);

create index if not exists idx_pay_periods_parent
  on payroll.pay_periods (parent_payment_period_id)
  where parent_payment_period_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_periods_set_updated_at'
      and tgrelid = 'payroll.pay_periods'::regclass
  ) then
    create trigger payroll_pay_periods_set_updated_at
      before update on payroll.pay_periods
      for each row execute function public.set_updated_at();
  end if;
end
$$;

-- =============================================================================
-- 3. payroll.pay_summaries — one settlement statement per staff member
-- =============================================================================
-- The figure columns are Luke's six settlement distinctions made explicit, so
-- an owner (or an accountant) can see exactly whose money is whose without
-- re-deriving anything.

create table if not exists payroll.pay_summaries (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- NOT cascade. Deleting a period must never silently take its statements with
  -- it: the lock trigger below resolves the period's status by lookup, so a
  -- cascade would delete the summary while the period row was already gone,
  -- find no status, and let locked payroll history disappear without error.
  -- (Verified against PostgreSQL 18 before this was changed.)
  -- NO ACTION rather than RESTRICT is deliberate: it is checked at end of
  -- statement, so deleting a whole business still cascades cleanly through
  -- business_id, while a direct "delete from payroll.pay_periods" is refused.
  pay_period_id uuid not null references payroll.pay_periods(id) on delete no action,
  staff_profile_id uuid not null references core.staff_profiles(id) on delete restrict,

  -- Snapshots: what was true when this statement was produced. Editing the
  -- staff record later must never change an issued statement.
  employment_type_snapshot core.staff_employment_type_enum not null,
  structure_id uuid references payroll.pay_structures(id) on delete set null,
  -- The rule version that governed the statement as a whole. Individual lines
  -- carry their own version reference, because a mid-period rule change splits
  -- a period across two versions.
  structure_version_id uuid references payroll.pay_structure_versions(id) on delete restrict,

  currency_code text not null default 'GBP',

  -- --- Revenue observed -----------------------------------------------------
  service_revenue_cents bigint not null default 0,
  retail_revenue_cents bigint not null default 0,
  -- Money the salon actually took for this stylist's work, including deposits
  -- and split tenders. Distinct from revenue: it is a cash-flow figure.
  total_collected_cents bigint not null default 0,

  -- --- How it is divided ----------------------------------------------------
  base_pay_cents bigint not null default 0,
  commission_cents bigint not null default 0,
  revenue_split_cents bigint not null default 0,
  bonus_cents bigint not null default 0,
  chair_rent_cents bigint not null default 0,
  deductions_cents bigint not null default 0,
  -- Tips are never part of the commission base; they pass through to the
  -- stylist and are shown separately (Luke, 2026-07-25). Split because a
  -- settlement has to distinguish tips the stylist has ALREADY received (cash
  -- taken at the chair, direct card tips) from tips the salon still owes them
  -- (terminal tips, pooled tips) - Luke 2026-07-27. Tips capture does not exist
  -- yet; until it does these stay zero and any tip-based rule renders as
  -- "source not captured" via pay_summary_lines.source_unavailable.
  tips_paid_out_cents bigint not null default 0,
  tips_owed_cents bigint not null default 0,
  -- Corrections carried in from an earlier locked period. Signed.
  adjustments_cents bigint not null default 0,

  -- --- The answer -----------------------------------------------------------
  -- Signed: negative means the stylist owes the business (a renter whose rent
  -- and deductions exceed their earnings).
  net_payable_cents bigint not null default 0,
  business_retained_cents bigint not null default 0,

  -- --- Whichever-is-higher transparency -------------------------------------
  -- Luke's Example A pays max(base pay, commission). Both figures are kept and
  -- the winner recorded, so the statement can show the comparison rather than a
  -- single unexplained number. When base pay wins this is also the evidence
  -- that a National-Minimum-Wage top-up was applied.
  greater_of_applied boolean not null default false,
  -- Only these two sides can win the comparison; the enum is wider because it
  -- is shared with pay_summary_lines.
  greater_of_winner payroll.pay_line_type_enum
    check (greater_of_winner is null or greater_of_winner in ('base_pay', 'commission')),

  -- --- Lifecycle ------------------------------------------------------------
  -- Set when source data changes after the statement was produced. The
  -- statement is NOT silently recalculated; it is flagged for a human.
  is_stale boolean not null default false,
  stale_reason text,
  -- Corrections append a new statement rather than editing this one.
  superseded_by_id uuid references payroll.pay_summaries(id) on delete set null,

  -- Everything the engine consumed, for reproducibility and dispute resolution.
  inputs_snapshot jsonb not null default '{}'::jsonb,

  generated_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  generated_at timestamptz not null default now(),
  exported_at timestamptz,
  emailed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint pay_summaries_no_self_supersede
    check (superseded_by_id is null or superseded_by_id <> id),
  constraint pay_summaries_greater_of_winner
    check (greater_of_applied = false or greater_of_winner is not null),
  constraint pay_summaries_inputs_is_object
    check (jsonb_typeof(inputs_snapshot) = 'object')
);

comment on table payroll.pay_summaries is
  'One settlement statement per staff member per pay period. Append-only in effect: corrections create a superseding row rather than editing an issued statement.';

comment on column payroll.pay_summaries.net_payable_cents is
  'Final settlement. Signed - negative means the stylist owes the business, which happens for renters whose rent and deductions exceed earnings.';

comment on column payroll.pay_summaries.is_stale is
  'Source data changed after this statement was produced. Flagged for a human rather than silently recalculated.';

-- One live statement per staff member per period. PARTIAL index: superseded
-- rows are history and must not collide.
-- WARNING: PostgREST cannot infer a partial unique index for upsert onConflict
-- (this is the same trap that produced the deposit-persist failure fixed in
-- migration 0049). Writes must use explicit select-then-insert logic, never
-- an onConflict upsert against this index.
create unique index if not exists idx_pay_summaries_live_per_staff
  on payroll.pay_summaries (pay_period_id, staff_profile_id)
  where superseded_by_id is null;

create index if not exists idx_pay_summaries_staff_generated
  on payroll.pay_summaries (staff_profile_id, generated_at desc);

create index if not exists idx_pay_summaries_period
  on payroll.pay_summaries (pay_period_id);

create index if not exists idx_pay_summaries_business_stale
  on payroll.pay_summaries (business_id, is_stale)
  where is_stale = true;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_summaries_set_updated_at'
      and tgrelid = 'payroll.pay_summaries'::regclass
  ) then
    create trigger payroll_pay_summaries_set_updated_at
      before update on payroll.pay_summaries
      for each row execute function public.set_updated_at();
  end if;
end
$$;

-- =============================================================================
-- 4. payroll.pay_summary_lines — drill-down to source transactions
-- =============================================================================
-- Luke ranked "transparent breakdowns" and "drill-down to source transactions"
-- third and fourth in his priority list. Every figure on a statement must be
-- traceable to the transaction and the rule version that produced it.

create table if not exists payroll.pay_summary_lines (
  id uuid primary key default extensions.gen_random_uuid(),
  summary_id uuid not null references payroll.pay_summaries(id) on delete cascade,
  sequence_no integer not null check (sequence_no > 0),

  line_type payroll.pay_line_type_enum not null,
  -- Which pipeline stage produced this line; null for pure source-revenue rows.
  stage_id uuid references payroll.pay_structure_stages(id) on delete set null,
  label text,

  -- Where the money came from, for drill-down.
  source_type payroll.pay_line_source_enum,
  source_id uuid,
  -- Service date. Drives which rule version applies and which period the line
  -- belongs to (accrual is on work performed, not when cash moved).
  occurred_on date,

  quantity numeric(12,3),
  -- The commissionable amount this line was calculated from, after the
  -- version's discount/VAT policy has been applied.
  basis_amount_cents bigint,
  -- The VAT rate actually used to derive basis_amount_cents. The platform does
  -- NOT persist a tax breakdown per transaction (billing.tax_settings is read
  -- live), so without this snapshot a later change to the salon's VAT rate
  -- would silently change what a historical commission was calculated on.
  -- Null when the rule version used vat_basis = 'inclusive'.
  vat_rate_percent_snapshot numeric(5,2)
    check (vat_rate_percent_snapshot is null
           or (vat_rate_percent_snapshot >= 0 and vat_rate_percent_snapshot <= 100)),
  rate_percent numeric(6,3)
    check (rate_percent is null or (rate_percent >= 0 and rate_percent <= 100)),
  -- Signed: deductions and rent are negative from the stylist's perspective.
  amount_cents bigint not null default 0,

  -- The rule version actually applied to THIS line. Recorded per line because a
  -- mid-period rule change splits a period across two versions.
  structure_version_id uuid references payroll.pay_structure_versions(id) on delete restrict,

  -- True when the rule asked for a source the platform is not capturing yet
  -- (retail, tips, refunds, cancellation fees). The line then means "we are not
  -- recording this", NOT "this was zero" - Luke 2026-07-26 was explicit that a
  -- silent GBP 0.00 is misleading and must not be shown.
  source_unavailable boolean not null default false,
  unavailable_source payroll.data_source_enum,

  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  constraint pay_summary_lines_sequence_unique unique (summary_id, sequence_no),
  constraint pay_summary_lines_metadata_is_object
    check (jsonb_typeof(metadata) = 'object'),
  -- An unavailable line must say which source is missing, and must not pretend
  -- to carry a figure.
  constraint pay_summary_lines_unavailable_consistency
    check (source_unavailable = false
           or (unavailable_source is not null and amount_cents = 0))
);

comment on table payroll.pay_summary_lines is
  'Itemised breakdown of a pay summary. Every line records its source transaction, the basis amount, the rate and the rule version applied.';

create index if not exists idx_pay_summary_lines_summary_sequence
  on payroll.pay_summary_lines (summary_id, sequence_no);

create index if not exists idx_pay_summary_lines_source
  on payroll.pay_summary_lines (source_type, source_id)
  where source_id is not null;

-- =============================================================================
-- 4b. payroll.pay_summary_hours — how the Service Revenue Target was derived
-- =============================================================================
-- Luke 2026-07-26: the target moves with payable hours, "provided the
-- calculation is transparent and the owner can see exactly which hours created
-- the target". This is that record: one row per hour category that contributed
-- to (or was excluded from) the period.

create table if not exists payroll.pay_summary_hours (
  id uuid primary key default extensions.gen_random_uuid(),
  summary_id uuid not null references payroll.pay_summaries(id) on delete cascade,
  category payroll.hour_category_enum not null,
  hours numeric(8,2) not null default 0 check (hours >= 0),
  -- What the rule version in force decided about this category.
  counted_toward_target boolean not null default false,
  counted_as_paid boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  constraint pay_summary_hours_unique unique (summary_id, category)
);

comment on table payroll.pay_summary_hours is
  'Per pay summary, the hours behind the Service Revenue Target broken down by category, and whether each counted. Makes every target explainable to the staff member it applies to.';

create index if not exists idx_pay_summary_hours_summary
  on payroll.pay_summary_hours (summary_id);

-- =============================================================================
-- 4c. payroll.target_adjustments — authorised manual changes to a target
-- =============================================================================
-- Luke 2026-07-27: the 'manual_adjustment' hour category counts toward the
-- Service Revenue Target "only if authorised and fully recorded", and the record
-- must carry a reason, the person who made it, the date and time, the original
-- target and the adjusted target. Every column below is therefore mandatory
-- except the free-text note - a manual change to someone's target is exactly the
-- kind of thing that must never be possible to make quietly.

create table if not exists payroll.target_adjustments (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  staff_profile_id uuid not null references core.staff_profiles(id) on delete restrict,
  pay_period_id uuid not null references payroll.pay_periods(id) on delete no action,
  -- Set once the summary exists; adjustments can be raised before generation.
  summary_id uuid references payroll.pay_summaries(id) on delete set null,

  original_target_cents bigint not null check (original_target_cents >= 0),
  adjusted_target_cents bigint not null check (adjusted_target_cents >= 0),
  reason text not null,

  -- Who authorised it. NOT NULL and RESTRICT: the actor must survive as long as
  -- the adjustment does, or the audit trail is incomplete.
  adjusted_by_user_profile_id uuid not null
    references core.user_profiles(id) on delete restrict,
  adjusted_at timestamptz not null default now(),
  notes text,

  constraint target_adjustments_reason_not_blank
    check (length(btrim(reason)) > 0),
  constraint target_adjustments_actually_changes
    check (adjusted_target_cents <> original_target_cents)
);

comment on table payroll.target_adjustments is
  'Authorised manual changes to a staff member''s Service Revenue Target: original figure, adjusted figure, reason, actor and timestamp. Required before a manual adjustment may count toward a target.';

create index if not exists idx_target_adjustments_staff_period
  on payroll.target_adjustments (staff_profile_id, pay_period_id);

create index if not exists idx_target_adjustments_summary
  on payroll.target_adjustments (summary_id)
  where summary_id is not null;

-- An adjustment is a historical record in its own right; once made it cannot be
-- rewritten. Correcting one means raising another.
create or replace function payroll.assert_target_adjustment_immutable()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and new.summary_id is not distinct from old.summary_id then
    raise exception
      'A target adjustment is an audit record and cannot be edited. Raise a further adjustment instead.'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then
    raise exception
      'A target adjustment is an audit record and cannot be deleted.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function payroll.assert_target_adjustment_immutable() is
  'Target adjustments are append-only. Only the link to a later-generated summary may be filled in.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_target_adjustments_immutable'
      and tgrelid = 'payroll.target_adjustments'::regclass
  ) then
    create trigger payroll_target_adjustments_immutable
      before update or delete on payroll.target_adjustments
      for each row execute function payroll.assert_target_adjustment_immutable();
  end if;
end
$$;

-- =============================================================================
-- 5. payroll.pay_adjustments — corrections carried into a later period
-- =============================================================================
-- Luke, 2026-07-25: "Refunds should normally reverse the original commission.
-- Locked payroll periods should never be silently changed. Instead, adjustments
-- should appear in the next available pay period with a full audit trail."

create table if not exists payroll.pay_adjustments (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  staff_profile_id uuid not null references core.staff_profiles(id) on delete restrict,

  -- The locked period the correction relates to (null for a standalone manual
  -- adjustment that does not correct a prior period).
  -- RESTRICT, not SET NULL: nulling origin_pay_period_id would silently erase
  -- the provenance of a correction, and nulling applied_in_pay_period_id would
  -- violate pay_adjustments_applied_consistency below (applied_at would remain
  -- set with no period), making the row unwritable ever after.
  origin_pay_period_id uuid references payroll.pay_periods(id) on delete restrict,
  -- Where it actually lands. Null until the next period is generated.
  applied_in_pay_period_id uuid references payroll.pay_periods(id) on delete restrict,

  reason payroll.adjustment_reason_enum not null,
  -- Signed: negative claws back commission already paid on a refunded service.
  amount_cents bigint not null,
  description text not null,

  -- Traceability back to what triggered it (a refund, a voided payment...).
  source_type payroll.pay_line_source_enum,
  source_id uuid,

  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,

  constraint pay_adjustments_description_not_blank
    check (length(btrim(description)) > 0),
  constraint pay_adjustments_applied_consistency
    check ((applied_in_pay_period_id is null) = (applied_at is null)),
  constraint pay_adjustments_origin_differs
    check (origin_pay_period_id is null
           or applied_in_pay_period_id is null
           or origin_pay_period_id <> applied_in_pay_period_id)
);

comment on table payroll.pay_adjustments is
  'Corrections to an already-locked period, carried forward into the next available period rather than rewriting history.';

create index if not exists idx_pay_adjustments_staff_pending
  on payroll.pay_adjustments (staff_profile_id, created_at)
  where applied_in_pay_period_id is null;

create index if not exists idx_pay_adjustments_origin
  on payroll.pay_adjustments (origin_pay_period_id)
  where origin_pay_period_id is not null;

create index if not exists idx_pay_adjustments_applied
  on payroll.pay_adjustments (applied_in_pay_period_id)
  where applied_in_pay_period_id is not null;

-- =============================================================================
-- 6. Locked-period immutability
-- =============================================================================
-- "Locked payroll periods should never be silently changed" is enforced in the
-- database, not just in the service layer, because this is the property the
-- whole audit story rests on.

create or replace function payroll.assert_period_not_locked()
returns trigger
language plpgsql
security definer
set search_path = payroll, public
as $$
declare
  v_old_status payroll.pay_period_status_enum;
  v_new_status payroll.pay_period_status_enum;
begin
  -- Resolve the owning period for BOTH the old and the new row. Checking only
  -- the new parent would let a single UPDATE re-point a locked statement at an
  -- open period and rewrite its figures in the same statement, escaping the
  -- guard entirely.
  if tg_table_name = 'pay_summary_lines' then
    if tg_op <> 'INSERT' then
      select p.status into v_old_status
      from payroll.pay_summaries s
      join payroll.pay_periods p on p.id = s.pay_period_id
      where s.id = old.summary_id;
    end if;
    if tg_op <> 'DELETE' then
      select p.status into v_new_status
      from payroll.pay_summaries s
      join payroll.pay_periods p on p.id = s.pay_period_id
      where s.id = new.summary_id;
    end if;
  else
    if tg_op <> 'INSERT' then
      select p.status into v_old_status
      from payroll.pay_periods p where p.id = old.pay_period_id;
    end if;
    if tg_op <> 'DELETE' then
      select p.status into v_new_status
      from payroll.pay_periods p where p.id = new.pay_period_id;
    end if;
  end if;

  if coalesce(v_old_status, v_new_status) in ('locked', 'paid')
     or coalesce(v_new_status, v_old_status) in ('locked', 'paid') then

    -- Inserting into, or deleting from, a locked period is always wrong.
    if tg_op <> 'UPDATE' then
      raise exception
        'Pay period is % - payroll history cannot be changed. Raise a payroll adjustment instead.',
        coalesce(v_old_status, v_new_status)
        using errcode = 'check_violation';
    end if;

    if tg_table_name = 'pay_summaries' then
      -- Explicit ALLOWLIST of what may still change on a locked statement.
      -- An allowlist rather than a list of protected columns: a denylist
      -- silently fails open every time a column is added to the table, and it
      -- previously left pay_period_id and staff_profile_id writable, so a
      -- locked statement could be reassigned to another stylist or period.
      if (to_jsonb(new) - 'exported_at' - 'emailed_at' - 'superseded_by_id'
                        - 'is_stale' - 'stale_reason' - 'updated_at')
         is distinct from
         (to_jsonb(old) - 'exported_at' - 'emailed_at' - 'superseded_by_id'
                        - 'is_stale' - 'stale_reason' - 'updated_at')
      then
        raise exception
          'Pay summary belongs to a % period - only export/email stamps, stale flags and supersede links may change. Raise a payroll adjustment instead.',
          coalesce(v_old_status, v_new_status)
          using errcode = 'check_violation';
      end if;
    else
      raise exception
        'Pay period is % - payroll lines cannot be changed. Raise a payroll adjustment instead.',
        coalesce(v_old_status, v_new_status)
        using errcode = 'check_violation';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function payroll.assert_period_not_locked() is
  'Refuses any change to a pay summary or line once its period is locked or paid, checking the old and new parent period so a row cannot be moved out of the lock. Only export/email stamps, stale flags and supersede links stay writable.';

-- A locked period must not be quietly re-opened and edited. Moving backwards
-- before approval is fine (an owner spotting a mistake in review); once locked,
-- the only way forward is 'paid', and any correction goes through
-- payroll.pay_adjustments.
create or replace function payroll.assert_period_status_forward_only()
returns trigger
language plpgsql
as $$
declare
  v_old integer;
  v_new integer;
begin
  if new.status = old.status then
    return new;
  end if;

  v_old := case old.status
             when 'draft' then 1 when 'ready_for_review' then 2 when 'approved' then 3
             when 'locked' then 4 when 'paid' then 5 end;
  v_new := case new.status
             when 'draft' then 1 when 'ready_for_review' then 2 when 'approved' then 3
             when 'locked' then 4 when 'paid' then 5 end;

  if v_old >= 4 and v_new < v_old then
    raise exception
      'Pay period is % and cannot be re-opened (attempted %). Raise a payroll adjustment instead.',
      old.status, new.status
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function payroll.assert_period_status_forward_only() is
  'Once a pay period is locked or paid it cannot move backwards. Corrections go through payroll.pay_adjustments.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_periods_status_ratchet'
      and tgrelid = 'payroll.pay_periods'::regclass
  ) then
    create trigger payroll_pay_periods_status_ratchet
      before update on payroll.pay_periods
      for each row execute function payroll.assert_period_status_forward_only();
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_summaries_locked_guard'
      and tgrelid = 'payroll.pay_summaries'::regclass
  ) then
    create trigger payroll_pay_summaries_locked_guard
      before insert or update or delete on payroll.pay_summaries
      for each row execute function payroll.assert_period_not_locked();
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_summary_lines_locked_guard'
      and tgrelid = 'payroll.pay_summary_lines'::regclass
  ) then
    create trigger payroll_pay_summary_lines_locked_guard
      before insert or update or delete on payroll.pay_summary_lines
      for each row execute function payroll.assert_period_not_locked();
  end if;
end
$$;

-- =============================================================================
-- 6b. Rule versions become immutable once they have priced real money
-- =============================================================================
-- 0071 documents pay_structure_versions and pay_structure_stages as append-only,
-- but nothing enforced it: editing a band rate in place would retroactively
-- change what a closed period was calculated on, which is exactly the
-- retro-recalculation behaviour this design exists to avoid. Once a version has
-- been referenced by any pay summary or line it is frozen; a rate change must
-- close the version and open a new one.

create or replace function payroll.assert_rule_version_unused()
returns trigger
language plpgsql
security definer
set search_path = payroll, public
as $$
declare
  v_version_id uuid;
  v_used boolean;
begin
  if tg_table_name = 'pay_structure_stages' then
    v_version_id := coalesce(old.version_id, new.version_id);
  elsif tg_table_name in ('accelerators', 'version_hour_rules') then
    v_version_id := coalesce(old.version_id, new.version_id);
  elsif tg_table_name = 'pay_structure_bands' then
    select st.version_id into v_version_id
    from payroll.pay_structure_stages st
    where st.id = coalesce(old.stage_id, new.stage_id);
  elsif tg_table_name = 'accelerator_conditions' then
    select a.version_id into v_version_id
    from payroll.accelerators a
    where a.id = coalesce(old.accelerator_id, new.accelerator_id);
  else
    v_version_id := coalesce(old.id, new.id);
  end if;

  select exists (
    select 1 from payroll.pay_summaries s where s.structure_version_id = v_version_id
    union all
    select 1 from payroll.pay_summary_lines l where l.structure_version_id = v_version_id
  ) into v_used;

  if v_used then
    raise exception
      'Pay rule version % has already been used to calculate pay and cannot be modified. Close it with an effective_to date and create a new version instead.', v_version_id
      using errcode = 'check_violation';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function payroll.assert_rule_version_unused() is
  'Freezes a pay-structure version and its stages once any pay summary or line has been calculated from it.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_structure_versions_frozen'
      and tgrelid = 'payroll.pay_structure_versions'::regclass
  ) then
    create trigger payroll_pay_structure_versions_frozen
      before update or delete on payroll.pay_structure_versions
      for each row execute function payroll.assert_rule_version_unused();
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_structure_stages_frozen'
      and tgrelid = 'payroll.pay_structure_stages'::regclass
  ) then
    create trigger payroll_pay_structure_stages_frozen
      before insert or update or delete on payroll.pay_structure_stages
      for each row execute function payroll.assert_rule_version_unused();
  end if;
end
$$;

-- Band rates, accelerator conditions and hour rules are all part of the priced
-- rule, so they freeze with it. Without these the headline guard would be
-- theatre: the version row would be locked while the actual percentages
-- remained editable.
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_structure_bands_frozen'
      and tgrelid = 'payroll.pay_structure_bands'::regclass
  ) then
    create trigger payroll_pay_structure_bands_frozen
      before insert or update or delete on payroll.pay_structure_bands
      for each row execute function payroll.assert_rule_version_unused();
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_accelerators_frozen'
      and tgrelid = 'payroll.accelerators'::regclass
  ) then
    create trigger payroll_accelerators_frozen
      before insert or update or delete on payroll.accelerators
      for each row execute function payroll.assert_rule_version_unused();
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_accelerator_conditions_frozen'
      and tgrelid = 'payroll.accelerator_conditions'::regclass
  ) then
    create trigger payroll_accelerator_conditions_frozen
      before insert or update or delete on payroll.accelerator_conditions
      for each row execute function payroll.assert_rule_version_unused();
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_version_hour_rules_frozen'
      and tgrelid = 'payroll.version_hour_rules'::regclass
  ) then
    create trigger payroll_version_hour_rules_frozen
      before insert or update or delete on payroll.version_hour_rules
      for each row execute function payroll.assert_rule_version_unused();
  end if;
end
$$;

-- =============================================================================
-- 6c. Applied adjustments freeze; period parents are validated
-- =============================================================================

create or replace function payroll.assert_adjustment_not_applied()
returns trigger
language plpgsql
as $$
begin
  if old.applied_at is not null then
    raise exception
      'Payroll adjustment has already been applied to a pay period and cannot be changed or removed.'
      using errcode = 'check_violation';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

comment on function payroll.assert_adjustment_not_applied() is
  'An adjustment that has landed in a pay period is itself history; it cannot be edited or deleted.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_adjustments_applied_guard'
      and tgrelid = 'payroll.pay_adjustments'::regclass
  ) then
    create trigger payroll_pay_adjustments_applied_guard
      before update or delete on payroll.pay_adjustments
      for each row execute function payroll.assert_adjustment_not_applied();
  end if;
end
$$;

-- A CHECK cannot see another row, so the roll-up rules are enforced here: the
-- parent must be a payment period, in the same business, and must not itself
-- have a parent (keeping the hierarchy exactly one level deep).
create or replace function payroll.assert_period_parent_valid()
returns trigger
language plpgsql
security definer
set search_path = payroll, public
as $$
declare
  v_parent payroll.pay_periods%rowtype;
begin
  if new.parent_payment_period_id is null then
    return new;
  end if;

  select * into v_parent from payroll.pay_periods where id = new.parent_payment_period_id;

  if not found then
    raise exception 'Parent pay period % does not exist.', new.parent_payment_period_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_parent.kind <> 'payment' then
    raise exception 'A calculation period may only roll up into a payment period (parent is %).', v_parent.kind
      using errcode = 'check_violation';
  end if;
  if v_parent.business_id <> new.business_id then
    raise exception 'A pay period cannot roll up into another business''s payment period.'
      using errcode = 'check_violation';
  end if;
  if v_parent.parent_payment_period_id is not null then
    raise exception 'Pay period roll-up is one level deep; the parent already has a parent.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function payroll.assert_period_parent_valid() is
  'Enforces that a calculation period rolls up only into a same-business payment period, one level deep.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_periods_parent_guard'
      and tgrelid = 'payroll.pay_periods'::regclass
  ) then
    create trigger payroll_pay_periods_parent_guard
      before insert or update on payroll.pay_periods
      for each row execute function payroll.assert_period_parent_valid();
  end if;
end
$$;

-- =============================================================================
-- 7. Row-level security
-- =============================================================================

alter table payroll.payroll_settings enable row level security;
alter table payroll.pay_periods enable row level security;
alter table payroll.pay_summaries enable row level security;
alter table payroll.pay_summary_lines enable row level security;
alter table payroll.pay_summary_hours enable row level security;
alter table payroll.target_adjustments enable row level security;
alter table payroll.pay_adjustments enable row level security;

create policy target_adjustments_owner_select
  on payroll.target_adjustments
  for select
  to authenticated
  using (public.is_business_owner(business_id));

create policy payroll_settings_owner_select
  on payroll.payroll_settings
  for select
  to authenticated
  using (public.is_business_owner(business_id));

create policy pay_summary_hours_owner_select
  on payroll.pay_summary_hours
  for select
  to authenticated
  using (
    exists (
      select 1
      from payroll.pay_summaries s
      where s.id = pay_summary_hours.summary_id
        and public.is_business_owner(s.business_id)
    )
  );

create policy pay_periods_owner_select
  on payroll.pay_periods
  for select
  to authenticated
  using (public.is_business_owner(business_id));

create policy pay_summaries_owner_select
  on payroll.pay_summaries
  for select
  to authenticated
  using (public.is_business_owner(business_id));

create policy pay_summary_lines_owner_select
  on payroll.pay_summary_lines
  for select
  to authenticated
  using (
    exists (
      select 1
      from payroll.pay_summaries s
      where s.id = pay_summary_lines.summary_id
        and public.is_business_owner(s.business_id)
    )
  );

create policy pay_adjustments_owner_select
  on payroll.pay_adjustments
  for select
  to authenticated
  using (public.is_business_owner(business_id));

grant select, insert, update, delete on
  payroll.payroll_settings,
  payroll.pay_periods,
  payroll.pay_summaries,
  payroll.pay_summary_lines,
  payroll.pay_summary_hours,
  payroll.target_adjustments,
  payroll.pay_adjustments
to authenticated, service_role;
