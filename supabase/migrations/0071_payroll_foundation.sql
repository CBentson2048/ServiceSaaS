-- 0071_payroll_foundation.sql
-- Wrike #4507281663 / #4507281639 — Week 3, Commission Engine & Wage Calculations.
--
-- Foundation for the QLOOQO Financial Rules Engine.
--
-- FRAMING (agreed with Luke 2026-07-27): this is the first implementation of a
-- REUSABLE financial rules engine, not a payroll-only module. Payroll,
-- commission and settlement are its first three outputs. The binding design
-- principles are in docs/financial-rules-engine-principles.md; the ones that
-- shape this file are:
--   1. Rules engine    — a pay structure is an ordered stage pipeline, and every
--                        rate, threshold, basis and ordering is rule data
--                        resolved by effective date. No default philosophy.
--   2. Explainability  — bands, accelerators and hour rules are ROWS, not JSON,
--                        so a reviewer can read a structure with a plain SELECT.
--   3. Traceability    — each priced line records the rule version that priced it.
--   4. Source honesty  — a rule that depends on an uncaptured source must warn,
--                        never silently return GBP 0.00 (see
--                        payroll.business_data_sources / missing_data_sources).
--   6. Adapts to the   — if a real salon arrangement cannot be expressed as
--      business          configuration, that is an engine defect.
--
-- Scope discipline: this engine must not PREVENT future outputs (loyalty,
-- memberships, royalties, marketplace commission), but it must not anticipate
-- them either. No speculative tables, no unused abstraction layers.
--
-- Luke's 2026-07-25 direction: QLOOQO must carry NO default payroll philosophy.
-- Every rate, threshold, basis and ordering is configuration data, never code.
-- His four reference models must all be expressible purely as rows here:
--   A. Employed, National-Minimum-Wage-or-commission (whichever is higher)
--   B. "Luke Ormsby Hair" — hourly, target as a multiple of base pay, banded
--      commission, KPI accelerator
--   C. Chair renter, 60/40 split, salon processes all payments
--   D. Hybrid — weekly rent + revenue split + performance bonus
--
-- Four layers, deliberately separated:
--   1. payroll.pay_structures         — the named preset ("Senior Stylist 45%")
--   2. payroll.pay_structure_versions — effective-dated parameters, append-only
--   3. payroll.pay_structure_stages   — the ordered calculation pipeline
--   4. payroll.staff_pay_assignments  — which staff member is on which structure
--
-- Versioning is correct BY CONSTRUCTION: changing a rate closes the current
-- version and inserts a new one, so a historical pay run always resolves the
-- version in force on the service date. Nothing is ever edited in place, so
-- payroll history cannot be silently rewritten. (This is the single most
-- important property here — the competitor review found platforms whose
-- recalculation retro-applies today's rates to last year's pay.)
--
-- DEPLOYMENT NOTE: the new `payroll` schema must be added to Exposed Schemas in
-- the Supabase dashboard for every hosted project (dev-test, develop, staging,
-- prod). config.toml only covers local; omitting this produces PGRST106
-- "Invalid schema: payroll" at runtime.

create schema if not exists payroll;

comment on schema payroll is
  'Commission, wage and settlement engine: versioned pay rules, pay periods, summaries and adjustments.';

-- =============================================================================
-- 1. Enums
-- =============================================================================

-- The calculation pipeline. A pay structure is an ORDERED list of these stages
-- rather than a fixed structure "type", so Luke's "every stage should be
-- configurable" is literally true in the schema: employed, chair-renter and
-- hybrid models are all just different stage sequences.
do $$
begin
  create type payroll.pay_stage_type_enum as enum (
    'base_pay',       -- hourly rate x paid hours, or a fixed amount per period
    'commission',     -- flat or banded % of an eligible revenue stream
    'revenue_split',  -- stylist's share of revenue (chair renters)
    'chair_rent',     -- fixed rent charged to the stylist
    'deduction',      -- product/colour cost or other agreed deductions
    'bonus',          -- target-triggered bonus
    'greater_of',     -- pay the higher of the accumulated base vs commission
    'tips_payout'     -- tips passed through; never part of the commission base
  );
exception
  when duplicate_object then null;
end
$$;

-- THE most error-prone setting in any commission engine, and the one most
-- commonly named as an explicit option by other platforms. 'marginal' pays the
-- rate only on revenue ABOVE the band threshold (Luke's Example A);
-- 'retroactive' pays it on the WHOLE base once the threshold is crossed (what
-- apps/api/src/kpi/kpi.calc.ts does today). On Luke's own figures the two
-- differ by 1.5-3x, so this is never inferred — it is always stored.
do $$
begin
  create type payroll.tier_semantics_enum as enum ('marginal', 'retroactive');
exception
  when duplicate_object then null;
end
$$;

-- How a band threshold is expressed. Luke's Example A1 uses 2.5x weekly base pay
-- and the Luke Ormsby Hair model uses 3x, so a multiple must be first-class, not
-- just a fixed sum. 'percent_of_service_target' expresses a retail target as a
-- proportion of the service target (the existing V1 rule was retail = 10% of the
-- service target).
-- Luke 2026-07-27 confirmed the retail target must stay configurable across:
-- a fixed amount, a percentage of service revenue, a percentage of the Service
-- Revenue Target, a per-client figure, or no target at all. The last case
-- (commission on ALL retail) is expressed as 'absolute' with a zero threshold,
-- and "only above the target" versus "on everything" is the existing marginal
-- versus retroactive tier semantics rather than a separate basis.
-- Luke Ormsby Hair uses percent_of_service_target at 10%.
do $$
begin
  create type payroll.threshold_basis_enum as enum (
    'absolute',
    'multiple_of_base_pay',
    'percent_of_service_target',
    'percent_of_service_revenue',
    'per_client'
  );
exception
  when duplicate_object then null;
end
$$;

-- Accelerator conditions (Luke 2026-07-26). In the Luke Ormsby Hair model the
-- 30% rate REPLACES 15% on the top band when KPIs are achieved - it does not
-- apply to all revenue, and it does not stack. Which KPIs, and at what
-- thresholds, is rule data rather than the constants currently hardcoded in
-- apps/api/src/kpi/kpi.calc.ts.
do $$
begin
  create type payroll.accelerator_metric_enum as enum (
    'rebooking_rate_percent',
    'retail_revenue',
    'average_bill',
    'service_revenue',
    'utilisation_percent'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type payroll.comparator_enum as enum ('gte', 'gt', 'lte', 'lt', 'eq');
exception
  when duplicate_object then null;
end
$$;

-- How a set of accelerator conditions combines into a single yes/no.
-- Luke 2026-07-27 confirmed Luke Ormsby Hair uses 'all' (rebooking >= 50%,
-- retail target achieved, average bill >= individual benchmark - miss any one
-- and the normal rate applies), but other businesses must be able to configure
-- any-of, at-least-N, or a weighted points score.
do $$
begin
  create type payroll.accelerator_evaluation_enum as enum (
    'all',          -- every condition must pass (the LOH default)
    'any',          -- any single condition is enough
    'at_least_n',   -- e.g. any two of three, via required_condition_count
    'weighted',     -- sum the weights of passing conditions vs required_score
    'custom'        -- reserved: expression evaluated by the engine
  );
exception
  when duplicate_object then null;
end
$$;

-- How an accelerator condition's threshold is expressed.
do $$
begin
  create type payroll.condition_basis_enum as enum (
    'absolute_amount',
    'percent',
    'staff_benchmark',
    'target_met'
  );
exception
  when duplicate_object then null;
end
$$;

-- Luke 2026-07-26: the Service Revenue Target is derived from PAYABLE hours for
-- the period, not always full contracted hours, and the salon configures which
-- reasons for time count. The owner must be able to see exactly which hours
-- produced the target.
do $$
begin
  create type payroll.hour_category_enum as enum (
    'worked',
    'paid_holiday',
    'unpaid_leave',
    'sickness',
    'training',
    'authorised_absence',
    'additional',
    'manual_adjustment'
  );
exception
  when duplicate_object then null;
end
$$;

-- Transaction sources a pay rule can consume. Several are not captured by the
-- platform yet; payroll must be able to say "not yet captured" rather than
-- silently calculating zero (Luke 2026-07-26).
do $$
begin
  create type payroll.data_source_enum as enum (
    'service_revenue',
    'retail_sales',
    'tips',
    'refunds',
    'cancellation_fees',
    'product_cost'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type payroll.revenue_stream_enum as enum ('service', 'retail', 'service_and_retail');
exception
  when duplicate_object then null;
end
$$;

-- Luke 2026-07-25: the business chooses the commissionable value. His salons use
-- the headline price before discounts; many businesses use the amount actually paid.
do $$
begin
  create type payroll.discount_basis_enum as enum (
    'headline_before_discount',
    'actual_after_discount',
    'custom_commissionable_value'
  );
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type payroll.vat_basis_enum as enum ('exclusive', 'inclusive');
exception
  when duplicate_object then null;
end
$$;

-- Luke 2026-07-25: deposits normally count when the service is COMPLETED rather
-- than when the money was collected.
do $$
begin
  create type payroll.deposit_recognition_enum as enum ('on_completion', 'on_collection');
exception
  when duplicate_object then null;
end
$$;

-- Luke 2026-07-25, product & colour costs. 'actual_usage' reads the real QLAB
-- cost already captured on billing.visit_line_items.cost_amount_cents (0028) —
-- no competitor reviewed does this; they all use flat amounts.
do $$
begin
  create type payroll.product_cost_mode_enum as enum (
    'none',
    'fixed',
    'actual_usage',
    'percentage',
    'service_specific'
  );
exception
  when duplicate_object then null;
end
$$;

-- =============================================================================
-- 2. payroll.pay_structures — the named preset
-- =============================================================================
-- Identity only. Rates NEVER live here; they live on the effective-dated
-- version, so renaming a structure can never alter a historical pay run.

create table if not exists payroll.pay_structures (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  name text not null,
  description text,
  -- Set for presets QLOOQO seeds (e.g. the migrated V1 commission settings) so
  -- the UI can distinguish them from structures the owner built themselves.
  is_system boolean not null default false,
  is_active boolean not null default true,
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pay_structures_name_not_blank check (length(btrim(name)) > 0)
);

comment on table payroll.pay_structures is
  'Named, reusable pay preset. Carries identity only - all rates and parameters live on payroll.pay_structure_versions so history is never rewritten.';

create unique index if not exists idx_pay_structures_business_name
  on payroll.pay_structures (business_id, lower(btrim(name)));

create index if not exists idx_pay_structures_business_active
  on payroll.pay_structures (business_id, is_active);

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_structures_set_updated_at'
      and tgrelid = 'payroll.pay_structures'::regclass
  ) then
    create trigger payroll_pay_structures_set_updated_at
      before update on payroll.pay_structures
      for each row execute function public.set_updated_at();
  end if;
end
$$;

-- =============================================================================
-- 3. payroll.pay_structure_versions — effective-dated parameters (append-only)
-- =============================================================================
-- Effective window matches the billing.location_fixed_costs convention (0053):
-- a version applies on date d when effective_from <= d and (effective_to is null
-- or d < effective_to). effective_to is the EXCLUSIVE end.
--
-- Active / historic / future are DERIVED from these dates against the
-- calculation date - never stored as a mutable flag, which is what makes
-- "recalculating today never changes yesterday" structurally true.

create table if not exists payroll.pay_structure_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  structure_id uuid not null references payroll.pay_structures(id) on delete cascade,
  version_no integer not null check (version_no > 0),

  effective_from date not null,
  effective_to date,

  -- Commission-base policy. Defaults are Luke's stated recommendations
  -- (2026-07-25); every one of them is configurable per version.
  discount_basis payroll.discount_basis_enum not null default 'headline_before_discount',
  vat_basis payroll.vat_basis_enum not null default 'exclusive',
  tips_included_in_commission boolean not null default false,
  deposit_recognition payroll.deposit_recognition_enum not null default 'on_completion',
  product_cost_mode payroll.product_cost_mode_enum not null default 'none',

  -- Share of a retained cancellation / no-show fee passed to the stylist.
  -- NULL = the business keeps the whole fee. NOTE: forfeited deposits are not
  -- yet persisted as a fee anywhere (see the Week 3 analysis), so this is stored
  -- and honoured by the engine but will evaluate to zero until fee capture lands.
  cancellation_fee_share_percent numeric(5,2)
    check (cancellation_fee_share_percent is null
           or (cancellation_fee_share_percent >= 0 and cancellation_fee_share_percent <= 100)),

  notes text,
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint pay_structure_versions_effective_range
    check (effective_to is null or effective_to > effective_from),
  constraint pay_structure_versions_version_no_unique
    unique (structure_id, version_no),
  -- One structure cannot have two versions in force on the same day.
  constraint pay_structure_versions_no_overlap
    exclude using gist (
      structure_id with =,
      daterange(effective_from, effective_to, '[)') with &&
    )
);

comment on table payroll.pay_structure_versions is
  'Append-only, effective-dated parameters for a pay structure. A rate change closes the current version and inserts a new one; rows referenced by a locked pay summary must never be edited or deleted.';

comment on column payroll.pay_structure_versions.effective_to is
  'EXCLUSIVE end of the effective window; null means still in force. Matches the billing.location_fixed_costs convention.';

create index if not exists idx_pay_structure_versions_structure_effective
  on payroll.pay_structure_versions (structure_id, effective_from desc);

create index if not exists idx_pay_structure_versions_business
  on payroll.pay_structure_versions (business_id);

-- =============================================================================
-- 4. payroll.pay_structure_stages — the ordered calculation pipeline
-- =============================================================================
-- Stages are rows, not one jsonb blob, so a reviewer can read a pay structure
-- with a plain SELECT. The financial-logic rule for this project is that the
-- calculation must be deterministic, testable, auditable and MANUALLY
-- REVIEWABLE; an opaque config document would fail the last of those.
--
-- The two settings most capable of silently mispricing wages (tier semantics
-- and threshold basis) are typed columns rather than config keys, and are the
-- ONLY home for those values - they must never be duplicated into config.

create table if not exists payroll.pay_structure_stages (
  id uuid primary key default extensions.gen_random_uuid(),
  version_id uuid not null references payroll.pay_structure_versions(id) on delete cascade,
  sequence_no integer not null check (sequence_no > 0),
  stage_type payroll.pay_stage_type_enum not null,
  label text,

  -- Commission-stage only (null for every other stage type).
  tier_semantics payroll.tier_semantics_enum,
  threshold_basis payroll.threshold_basis_enum,
  revenue_stream payroll.revenue_stream_enum,

  -- Whether this stage takes part in a later 'greater_of' comparison.
  -- Luke 2026-07-26, Example A2: the comparison is between the guaranteed wage
  -- and the SERVICE commission only; retail commission and tips are paid on top
  -- and must sit outside it, "unless a business specifically configures
  -- otherwise". A flag per stage makes that configurable and readable, instead
  -- of burying stage references inside a config document.
  in_greater_of_comparison boolean not null default false,

  -- The transaction source this stage consumes, if any. Used to warn an owner
  -- that a rule depends on data the platform is not capturing yet.
  requires_data_source payroll.data_source_enum,

  -- Stage parameters that genuinely vary in shape: rent amount/cadence, split
  -- percentage, deduction amount, bonus trigger. Commission BANDS are not kept
  -- here - they are rows in payroll.pay_structure_bands, because band rates are
  -- the most consequential numbers in the whole engine and must be readable and
  -- constrainable. Validated per stage_type in the API DTO layer.
  config jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),

  constraint pay_structure_stages_sequence_unique unique (version_id, sequence_no),
  -- A commission stage without these is ambiguous and would let the engine
  -- guess at how bands apply. Fail closed at the database.
  constraint pay_structure_stages_commission_fields check (
    stage_type <> 'commission'
    or (tier_semantics is not null
        and threshold_basis is not null
        and revenue_stream is not null)
  ),
  -- Keep the commission-only columns null on other stage types so there is
  -- exactly one place each value can live.
  constraint pay_structure_stages_non_commission_fields check (
    stage_type = 'commission'
    or (tier_semantics is null
        and threshold_basis is null
        and revenue_stream is null)
  ),
  constraint pay_structure_stages_config_is_object
    check (jsonb_typeof(config) = 'object'),
  -- The comparison itself cannot be one of its own operands.
  constraint pay_structure_stages_greater_of_not_operand
    check (stage_type <> 'greater_of' or in_greater_of_comparison = false)
);

comment on table payroll.pay_structure_stages is
  'Ordered calculation pipeline for one pay-structure version. Employed, chair-renter and hybrid models differ only in which stages are present and in what order.';

comment on column payroll.pay_structure_stages.tier_semantics is
  'marginal = rate applies only above the band threshold; retroactive = rate applies to the whole base once crossed. Never inferred - the two differ by 1.5-3x on real figures.';

create index if not exists idx_pay_structure_stages_version_sequence
  on payroll.pay_structure_stages (version_id, sequence_no);

-- =============================================================================
-- 4b. payroll.pay_structure_bands — the commission bands, as rows
-- =============================================================================
-- Luke's Luke Ormsby Hair model, stated 2026-07-26:
--   below 3x base pay        -> no commission
--   3x to 3.5x               -> 10% on the portion in that band only
--   above 3.5x               -> 15% on the portion above, or 30% when the
--                               accelerator KPIs are met (the 30% REPLACES the
--                               15%; it does not stack and does not reach back
--                               over the rest of the revenue)
-- With tier_semantics = 'marginal' each band applies only to the slice of
-- revenue inside it. accelerator_rate_percent is the substitute rate for that
-- same slice when the stage's accelerator evaluates true.

create table if not exists payroll.pay_structure_bands (
  id uuid primary key default extensions.gen_random_uuid(),
  stage_id uuid not null references payroll.pay_structure_stages(id) on delete cascade,
  sequence_no integer not null check (sequence_no > 0),

  -- Lower bound of the band. Exactly one form is used, matching the stage's
  -- threshold_basis (enforced by trigger, since a CHECK cannot see the parent):
  --   multiple_of_base_pay        -> from_multiple      (e.g. 3.0 = 3x base pay)
  --   absolute / per_client       -> from_amount_cents  (a money figure)
  --   percent_of_service_target   -> from_percent       (e.g. 10 = 10% of the
  --   percent_of_service_revenue                          Service Revenue Target,
  --                                                       which is the Luke Ormsby
  --                                                       Hair retail target)
  from_multiple numeric(8,4) check (from_multiple is null or from_multiple >= 0),
  from_amount_cents bigint check (from_amount_cents is null or from_amount_cents >= 0),
  from_percent numeric(8,4) check (from_percent is null or from_percent >= 0),

  rate_percent numeric(6,3) not null
    check (rate_percent >= 0 and rate_percent <= 100),
  -- Replaces rate_percent for this band when the accelerator is achieved.
  accelerator_rate_percent numeric(6,3)
    check (accelerator_rate_percent is null
           or (accelerator_rate_percent >= 0 and accelerator_rate_percent <= 100)),

  created_at timestamptz not null default now(),

  constraint pay_structure_bands_sequence_unique unique (stage_id, sequence_no),
  -- Exactly one lower-bound form, never two.
  constraint pay_structure_bands_one_lower_bound check (
    (case when from_multiple is not null then 1 else 0 end)
    + (case when from_amount_cents is not null then 1 else 0 end)
    + (case when from_percent is not null then 1 else 0 end) = 1
  )
);

comment on table payroll.pay_structure_bands is
  'Commission bands for one commission stage. Kept as rows rather than JSON because these rates are the most consequential numbers in the engine and must be readable and constrainable.';

comment on column payroll.pay_structure_bands.accelerator_rate_percent is
  'Substitute rate for this band when the stage accelerator is achieved. Replaces rate_percent for the same slice of revenue - it never stacks and never applies to lower bands.';

create index if not exists idx_pay_structure_bands_stage
  on payroll.pay_structure_bands (stage_id, sequence_no);

-- A band's lower bound must be expressed in the same terms as its stage.
create or replace function payroll.assert_band_matches_stage_basis()
returns trigger
language plpgsql
security definer
set search_path = payroll, public
as $$
declare
  v_basis payroll.threshold_basis_enum;
  v_type payroll.pay_stage_type_enum;
begin
  select threshold_basis, stage_type into v_basis, v_type
  from payroll.pay_structure_stages where id = new.stage_id;

  if v_type <> 'commission' then
    raise exception 'Bands may only be attached to a commission stage (stage is %).', v_type
      using errcode = 'check_violation';
  end if;

  if v_basis = 'multiple_of_base_pay' and new.from_multiple is null then
    raise exception 'This stage expresses thresholds as a multiple of base pay, so the band needs from_multiple.'
      using errcode = 'check_violation';
  end if;
  if v_basis in ('absolute', 'per_client') and new.from_amount_cents is null then
    raise exception 'This stage expresses thresholds as an amount, so the band needs from_amount_cents.'
      using errcode = 'check_violation';
  end if;
  if v_basis in ('percent_of_service_target', 'percent_of_service_revenue')
     and new.from_percent is null then
    raise exception 'This stage expresses thresholds as a percentage, so the band needs from_percent.'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function payroll.assert_band_matches_stage_basis() is
  'Keeps a band lower bound expressed in the same terms as its stage threshold_basis, so the engine never has to guess.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_structure_bands_basis_guard'
      and tgrelid = 'payroll.pay_structure_bands'::regclass
  ) then
    create trigger payroll_pay_structure_bands_basis_guard
      before insert or update on payroll.pay_structure_bands
      for each row execute function payroll.assert_band_matches_stage_basis();
  end if;
end
$$;

-- =============================================================================
-- 4c. payroll.accelerators — the KPI conditions that swap a band rate
-- =============================================================================

create table if not exists payroll.accelerators (
  id uuid primary key default extensions.gen_random_uuid(),
  version_id uuid not null references payroll.pay_structure_versions(id) on delete cascade,
  -- The commission stage whose top band this accelerator promotes.
  stage_id uuid not null references payroll.pay_structure_stages(id) on delete cascade,
  name text not null default 'Accelerator',
  evaluation_mode payroll.accelerator_evaluation_enum not null default 'all',
  -- Only for 'at_least_n': how many conditions must pass (e.g. 2 of 3).
  required_condition_count integer
    check (required_condition_count is null or required_condition_count > 0),
  -- Only for 'weighted': the score the passing conditions must reach.
  required_score numeric(10,3)
    check (required_score is null or required_score >= 0),
  created_at timestamptz not null default now(),
  constraint accelerators_stage_unique unique (stage_id),
  -- Each mode needs exactly the parameter it uses, and no other - otherwise the
  -- engine would have to guess which one governs.
  constraint accelerators_mode_parameters check (
    (evaluation_mode = 'at_least_n'
       and required_condition_count is not null and required_score is null)
    or (evaluation_mode = 'weighted'
       and required_score is not null and required_condition_count is null)
    or (evaluation_mode in ('all', 'any', 'custom')
       and required_condition_count is null and required_score is null)
  )
);

comment on table payroll.accelerators is
  'Conditions that promote a commission band to its accelerator rate. Replaces the hardcoded all-KPIs gate in apps/api/src/kpi/kpi.calc.ts with rule data.';

create table if not exists payroll.accelerator_conditions (
  id uuid primary key default extensions.gen_random_uuid(),
  accelerator_id uuid not null references payroll.accelerators(id) on delete cascade,
  sequence_no integer not null check (sequence_no > 0),
  metric payroll.accelerator_metric_enum not null,
  comparator payroll.comparator_enum not null default 'gte',
  basis payroll.condition_basis_enum not null default 'absolute_amount',
  -- Interpreted per basis: a percentage, an amount in minor units, or ignored
  -- for 'staff_benchmark' / 'target_met' which read the staff record or the
  -- configured target instead.
  threshold_value numeric(14,4),
  -- Points this condition contributes when it passes, under evaluation_mode
  -- 'weighted'. Ignored by the other modes.
  weight numeric(10,3) not null default 1
    check (weight >= 0),
  created_at timestamptz not null default now(),
  constraint accelerator_conditions_sequence_unique unique (accelerator_id, sequence_no),
  constraint accelerator_conditions_threshold_required
    check (basis in ('staff_benchmark', 'target_met') or threshold_value is not null)
);

comment on table payroll.accelerator_conditions is
  'One KPI condition. The V1 gate was rebooking >= 50%, retail target met, and average bill >= the staff benchmark - all three expressible here.';

create index if not exists idx_accelerator_conditions_accelerator
  on payroll.accelerator_conditions (accelerator_id, sequence_no);

-- =============================================================================
-- 4d. payroll.version_hour_rules — which hours build the Service Revenue Target
-- =============================================================================
-- Luke 2026-07-26: the target moves with payable hours, and the salon decides
-- which reasons for time count. Eight categories, one row each per version, so
-- the configuration is explicit rather than implied by absence.

create table if not exists payroll.version_hour_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  version_id uuid not null references payroll.pay_structure_versions(id) on delete cascade,
  category payroll.hour_category_enum not null,
  -- Counts toward the hours that derive the Service Revenue Target.
  counts_toward_target boolean not null default false,
  -- Counts as payable time for the base_pay stage.
  counts_as_paid boolean not null default false,
  created_at timestamptz not null default now(),
  constraint version_hour_rules_unique unique (version_id, category)
);

comment on table payroll.version_hour_rules is
  'Per pay-rule version, which categories of time count toward the Service Revenue Target and which are payable. Owner-visible so a target is always explainable.';

create index if not exists idx_version_hour_rules_version
  on payroll.version_hour_rules (version_id);

-- =============================================================================
-- 4e. payroll.business_data_sources — what the platform actually captures
-- =============================================================================
-- Several sources a rule can reference are not captured by QLOOQO yet: retail
-- has no capture UI, and tips, refunds of salon takings and retained
-- cancellation fees have no data model at all. Payroll must distinguish
-- "nothing happened" from "we are not recording this", so a rule that depends
-- on a missing source can warn instead of silently paying zero.

create table if not exists payroll.business_data_sources (
  business_id uuid not null references core.businesses(id) on delete cascade,
  source payroll.data_source_enum not null,
  is_captured boolean not null default false,
  notes text,
  updated_at timestamptz not null default now(),
  primary key (business_id, source)
);

comment on table payroll.business_data_sources is
  'Per business, whether a transaction source is actually being captured. Drives the "not yet captured" state on pay summary lines and the warning when a rule is built against a missing source.';

-- Today's capture reality, in one place. Used both to backfill existing
-- businesses here and to seed businesses created later (trigger in 0073), so
-- the defaults can never drift between the two paths.
create or replace function payroll.seed_business_data_sources(p_business_id uuid)
returns void
language sql
security definer
set search_path = payroll, public
as $$
  insert into payroll.business_data_sources (business_id, source, is_captured, notes)
  select p_business_id, s.source, s.captured, s.note
  from (
    values
      ('service_revenue'::payroll.data_source_enum, true,
       'Captured via booking.appointment_services and billing.visit_line_items.'),
      ('product_cost'::payroll.data_source_enum, true,
       'Actual QLAB usage cost captured on billing.visit_line_items.cost_amount_cents.'),
      ('retail_sales'::payroll.data_source_enum, false,
       'billing.retail_sales exists but no app writes to it and staff attribution is nullable.'),
      ('tips'::payroll.data_source_enum, false,
       'No tips or gratuity capture anywhere in the platform.'),
      ('refunds'::payroll.data_source_enum, false,
       'billing.salon_payments is insert-only; no refund or void path for in-salon takings.'),
      ('cancellation_fees'::payroll.data_source_enum, false,
       'A forfeited deposit is never recorded as a fee; only an audit-log entry exists.')
  ) as s(source, captured, note)
  on conflict (business_id, source) do nothing;
$$;

comment on function payroll.seed_business_data_sources(uuid) is
  'Seeds the data-source capture matrix for one business. Single source of truth for the defaults, shared by the backfill and the new-business trigger.';

-- Backfill businesses that already exist.
select payroll.seed_business_data_sources(id) from core.businesses;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_business_data_sources_set_updated_at'
      and tgrelid = 'payroll.business_data_sources'::regclass
  ) then
    create trigger payroll_business_data_sources_set_updated_at
      before update on payroll.business_data_sources
      for each row execute function public.set_updated_at();
  end if;
end
$$;

-- Reports every data source a version depends on that the business is not
-- capturing. The API calls this before saving/activating a version and surfaces
-- the result as a warning: "This rule uses retail sales, but retail transaction
-- capture has not yet been enabled." Deliberately a warning, not a hard block -
-- an owner may legitimately configure a rule ahead of the capture work landing.
create or replace function payroll.missing_data_sources(p_version_id uuid)
returns table (source payroll.data_source_enum, stage_label text)
language sql
stable
security definer
set search_path = payroll, public
as $$
  select distinct st.requires_data_source, st.label
  from payroll.pay_structure_stages st
  join payroll.pay_structure_versions v on v.id = st.version_id
  left join payroll.business_data_sources ds
    on ds.business_id = v.business_id
   and ds.source = st.requires_data_source
  where st.version_id = p_version_id
    and st.requires_data_source is not null
    and coalesce(ds.is_captured, false) = false;
$$;

comment on function payroll.missing_data_sources(uuid) is
  'Data sources a pay-rule version depends on that the business is not capturing yet. Surfaced by the API as an activation warning.';

-- =============================================================================
-- 5. payroll.staff_pay_assignments — staff member to structure, over time
-- =============================================================================
-- Also append-only and effective-dated: moving someone onto a new structure
-- closes the old assignment and opens a new one. Calculation resolves
-- (staff member, service date) -> assignment -> version in force that day.

create table if not exists payroll.staff_pay_assignments (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  staff_profile_id uuid not null references core.staff_profiles(id) on delete cascade,
  -- restrict: a structure that has ever been assigned cannot be deleted out
  -- from under a historical pay run.
  structure_id uuid not null references payroll.pay_structures(id) on delete restrict,

  effective_from date not null,
  effective_to date,

  notes text,
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),

  constraint staff_pay_assignments_effective_range
    check (effective_to is null or effective_to > effective_from),
  -- A staff member cannot be on two pay structures on the same day.
  constraint staff_pay_assignments_no_overlap
    exclude using gist (
      staff_profile_id with =,
      daterange(effective_from, effective_to, '[)') with &&
    )
);

comment on table payroll.staff_pay_assignments is
  'Effective-dated link from a staff member to a pay structure. Append-only: a change closes the current row and opens a new one.';

create index if not exists idx_staff_pay_assignments_staff_effective
  on payroll.staff_pay_assignments (staff_profile_id, effective_from desc);

create index if not exists idx_staff_pay_assignments_business
  on payroll.staff_pay_assignments (business_id);

create index if not exists idx_staff_pay_assignments_structure
  on payroll.staff_pay_assignments (structure_id);

-- business_id is denormalized on these tables (repo convention), so nothing in
-- the FKs stops a staff member being assigned to another business's pay
-- structure, or a version being filed under a different business from its
-- structure. Either would leak one salon's rates into another's payroll.
create or replace function payroll.assert_payroll_business_consistent()
returns trigger
language plpgsql
security definer
set search_path = payroll, core, public
as $$
declare
  v_structure_business uuid;
  v_staff_business uuid;
begin
  select business_id into v_structure_business
  from payroll.pay_structures where id = new.structure_id;

  if v_structure_business is null then
    raise exception 'Pay structure % does not exist.', new.structure_id
      using errcode = 'foreign_key_violation';
  end if;
  if v_structure_business <> new.business_id then
    raise exception 'Pay structure belongs to a different business.'
      using errcode = 'check_violation';
  end if;

  if tg_table_name = 'staff_pay_assignments' then
    select business_id into v_staff_business
    from core.staff_profiles where id = new.staff_profile_id;
    if v_staff_business is distinct from new.business_id then
      raise exception 'Staff member belongs to a different business than this pay assignment.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

comment on function payroll.assert_payroll_business_consistent() is
  'Keeps the denormalized business_id on pay assignments and rule versions in step with the structure and staff member they reference.';

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_staff_pay_assignments_business_guard'
      and tgrelid = 'payroll.staff_pay_assignments'::regclass
  ) then
    create trigger payroll_staff_pay_assignments_business_guard
      before insert or update on payroll.staff_pay_assignments
      for each row execute function payroll.assert_payroll_business_consistent();
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'payroll_pay_structure_versions_business_guard'
      and tgrelid = 'payroll.pay_structure_versions'::regclass
  ) then
    create trigger payroll_pay_structure_versions_business_guard
      before insert or update on payroll.pay_structure_versions
      for each row execute function payroll.assert_payroll_business_consistent();
  end if;
end
$$;

-- =============================================================================
-- 6. Row-level security
-- =============================================================================
-- Defense-in-depth only. Every API service uses the service-role client, which
-- bypasses RLS, so pay-data authorization is enforced in the API layer by the
-- payroll.* permission keys (migration 0074). These policies exist so a direct
-- PostgREST client cannot read pay rules.

alter table payroll.pay_structures enable row level security;
alter table payroll.pay_structure_versions enable row level security;
alter table payroll.pay_structure_stages enable row level security;
alter table payroll.pay_structure_bands enable row level security;
alter table payroll.accelerators enable row level security;
alter table payroll.accelerator_conditions enable row level security;
alter table payroll.version_hour_rules enable row level security;
alter table payroll.business_data_sources enable row level security;
alter table payroll.staff_pay_assignments enable row level security;

create policy pay_structures_owner_select
  on payroll.pay_structures
  for select
  to authenticated
  using (public.is_business_owner(business_id));

create policy pay_structure_versions_owner_select
  on payroll.pay_structure_versions
  for select
  to authenticated
  using (public.is_business_owner(business_id));

create policy pay_structure_stages_owner_select
  on payroll.pay_structure_stages
  for select
  to authenticated
  using (
    exists (
      select 1
      from payroll.pay_structure_versions v
      where v.id = pay_structure_stages.version_id
        and public.is_business_owner(v.business_id)
    )
  );

create policy staff_pay_assignments_owner_select
  on payroll.staff_pay_assignments
  for select
  to authenticated
  using (public.is_business_owner(business_id));

-- Rule detail tables reach the owning business through their stage/version.
create policy pay_structure_bands_owner_select
  on payroll.pay_structure_bands
  for select
  to authenticated
  using (
    exists (
      select 1
      from payroll.pay_structure_stages st
      join payroll.pay_structure_versions v on v.id = st.version_id
      where st.id = pay_structure_bands.stage_id
        and public.is_business_owner(v.business_id)
    )
  );

create policy accelerators_owner_select
  on payroll.accelerators
  for select
  to authenticated
  using (
    exists (
      select 1
      from payroll.pay_structure_versions v
      where v.id = accelerators.version_id
        and public.is_business_owner(v.business_id)
    )
  );

create policy accelerator_conditions_owner_select
  on payroll.accelerator_conditions
  for select
  to authenticated
  using (
    exists (
      select 1
      from payroll.accelerators a
      join payroll.pay_structure_versions v on v.id = a.version_id
      where a.id = accelerator_conditions.accelerator_id
        and public.is_business_owner(v.business_id)
    )
  );

create policy version_hour_rules_owner_select
  on payroll.version_hour_rules
  for select
  to authenticated
  using (
    exists (
      select 1
      from payroll.pay_structure_versions v
      where v.id = version_hour_rules.version_id
        and public.is_business_owner(v.business_id)
    )
  );

create policy business_data_sources_owner_select
  on payroll.business_data_sources
  for select
  to authenticated
  using (public.is_business_owner(business_id));

-- =============================================================================
-- 7. Grants
-- =============================================================================

grant usage on schema payroll to authenticated, service_role;

alter default privileges in schema payroll
  grant select, insert, update, delete on tables to authenticated, service_role;

grant select, insert, update, delete on all tables in schema payroll
  to authenticated, service_role;
