-- 0105_formula_change_detection.sql
-- Formula change detection sensitivity settings (QLOOQO V1.1, Wrike 4507283774).
--
-- WHAT THIS ADDS
--   1. lab.formula_change_settings — the salon's sensitivity thresholds, scoped
--      business-wide (location_id null) or per location, exactly like
--      crm.retention_settings (0097).
--   2. Two supporting indexes on lab.formulas for the comparable-history read.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD, AND WHY
--
--   NO flag/assessment table. QLOOQO's established client-intelligence pattern
--   is COMPUTED ON READ — crm.client_lapse_intelligence (0097) stores nothing
--   and recomputes from live rows on every call. Formula change detection
--   follows it exactly. That single decision resolves three of the ticket's open
--   questions at once:
--     - idempotency: there are no rows, so there is nothing to duplicate;
--     - threshold changes: an assessment always reflects the CURRENT settings,
--       because it is derived at read time from the current settings;
--     - staleness: editing or voiding a formula is reflected on the very next
--       call, with no cache to invalidate and no stale flag to explain away.
--
--   NO change to lab.formulas or lab.formula_items. Detection is READ-ONLY over
--   history that already exists. It never writes a formula, never touches
--   inventory.stock_movements, and cannot alter what the till charged.
--
--   NO level or tone column. This migration does NOT invent structured colour
--   level/tone fields, because inventing empty columns would imply the feature
--   compares them when it cannot. `lab.formula_items.shade` is free text and, on
--   the catalogue path, the Lab app writes the PRODUCT NAME into it, so it is a
--   display label rather than a shade code. Making level/tone real is a schema +
--   data-entry change (a canonical level/tone column populated at capture time),
--   and it is recorded as remaining work rather than faked here.
--
--   NO new comparability column. A formula's "what kind of colour work is this"
--   key is derived from its appointment's service categories via
--   booking.service_categories.billing_category (0091) — the same linkage Colour
--   Prep already uses. Denormalising it onto lab.formulas would create a second
--   source of truth that could disagree with the first.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Sensitivity settings
-- =============================================================================

create table if not exists lab.formula_change_settings (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- NULL = the business-wide default; set = an override for that location only.
  location_id uuid references core.locations(id) on delete cascade,
  -- Composition distance at or above which a formula is flagged, whole percent.
  composition_change_percent smallint not null default 30,
  -- Share a single component must reach before its addition/removal can flag on
  -- its own, whole percent.
  component_materiality_percent smallint not null default 15,
  -- Developer strength change, in volumes, at or above which a formula is flagged.
  developer_volume_delta smallint not null default 10,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Bounds mirrored EXACTLY by FORMULA_CHANGE_BOUNDS in @sheer/domain, so a row
  -- written by a script or a backfill can never hold a value the detector would
  -- refuse to apply.
  constraint formula_change_composition_range
    check (composition_change_percent between 1 and 100),
  constraint formula_change_materiality_range
    check (component_materiality_percent between 1 and 100),
  constraint formula_change_developer_range
    check (developer_volume_delta between 1 and 60),
  -- One row per scope. NULLS NOT DISTINCT makes the business-wide row collide
  -- with itself, so an upsert keeps one row rather than accumulating duplicates.
  unique nulls not distinct (business_id, location_id)
);

comment on table lab.formula_change_settings is
  'Salon sensitivity thresholds for formula change detection (0105, Wrike 4507283774). '
  'location_id null = business-wide default; a location row overrides it WHOLE (per row, not per '
  'field) so the three numbers always come from one scope somebody actually chose. Absence '
  'inherits DEFAULT_FORMULA_CHANGE_THRESHOLDS in @sheer/domain. Detection itself stores nothing — '
  'assessments are computed on read from live lab.formulas rows, so changing a threshold here is '
  'reflected on the very next read.';

comment on column lab.formula_change_settings.composition_change_percent is
  'Flag when the formula composition changes by at least this percent. The metric is '
  '0.5 x sum of absolute share differences over all products, so a pure batch-size change '
  '(30g+30g -> 45g+45g) is exactly 0 and never flags. Platform default 30 — an ENGINEERING '
  'default chosen to avoid noisy flags, not a client-supplied value.';
comment on column lab.formula_change_settings.component_materiality_percent is
  'Share a single component must reach before adding or removing it can flag on its own. '
  'A smaller component still contributes to the composition distance; it just cannot flag alone. '
  'Platform default 15.';
comment on column lab.formula_change_settings.developer_volume_delta is
  'Flag when the strongest developer in the mix moves by at least this many volumes '
  '(20 vol -> 40 vol). Only vol-vs-vol is compared; volumes and percents are never '
  'interconverted. Platform default 10 — one step on the 10/20/30/40 ladder.';

drop trigger if exists formula_change_settings_set_updated_at on lab.formula_change_settings;
create trigger formula_change_settings_set_updated_at
before update on lab.formula_change_settings
for each row execute function public.set_updated_at();

create index if not exists idx_formula_change_settings_business
  on lab.formula_change_settings (business_id);

-- =============================================================================
-- 2. Comparable-history read support
-- =============================================================================
--
-- The detector's hot path is "this client's finalised formulas, newest first,
-- for this business" — run for one client on the profile, and for a page of
-- clients in Colour Prep. Neither index changes any existing behaviour; they
-- only make the existing access pattern indexable.

create index if not exists idx_lab_formulas_client_saved
  on lab.formulas (business_id, client_profile_id, saved_at desc)
  where status = 'saved' and saved_at is not null;

-- Resolving each formula's comparability key reads its appointment. Partial so
-- the index stays small: a formula with no appointment has no service category
-- to inherit and is keyed 'uncategorised' without a lookup.
create index if not exists idx_lab_formulas_appointment
  on lab.formulas (appointment_id)
  where appointment_id is not null;

-- =============================================================================
-- 3. RLS
-- =============================================================================
--
-- Sensitivity thresholds decide when stylists get warned, so they are salon
-- configuration: owners manage them, any active member may READ them (the
-- Colour Prep and client-profile surfaces echo the thresholds that produced an
-- assessment, so a stylist has to be able to see them to understand the flag).
-- Every write the platform performs goes through the service role after the API
-- has independently checked role and permission; RLS here is defence in depth.
--
-- NOTE THE REVOKE. Migration 0002 sets ALTER DEFAULT PRIVILEGES ... GRANT
-- SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated for schema lab, so
-- this table was born with full authenticated CRUD. A narrowing GRANT alone
-- would be a no-op — the broad grant has to be revoked first.

alter table lab.formula_change_settings enable row level security;

revoke all on lab.formula_change_settings from authenticated;

drop policy if exists formula_change_settings_owner_all on lab.formula_change_settings;
create policy formula_change_settings_owner_all
on lab.formula_change_settings for all
to authenticated
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists formula_change_settings_member_select on lab.formula_change_settings;
create policy formula_change_settings_member_select
on lab.formula_change_settings for select
to authenticated
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = lab.formula_change_settings.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

grant select, insert, update, delete on lab.formula_change_settings to authenticated;
grant select, insert, update, delete on lab.formula_change_settings to service_role;
