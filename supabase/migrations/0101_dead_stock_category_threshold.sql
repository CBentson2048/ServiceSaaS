-- 0101_dead_stock_category_threshold.sql
-- Lets a dead-stock threshold be set per PRODUCT CATEGORY.
--
-- WHY. 0093 shipped two levels: a per-product override and a per-location
-- default. In a real salon that is the wrong granularity in the middle — colour
-- turns over on a completely different clock from retail, but nobody is going to
-- set dead_stock_days by hand on four hundred individual products, and the
-- location default has to stay a single number because it is the catch-all. The
-- category is the level people actually think in.
--
-- THE PRECEDENCE, from most specific to least:
--
--   inventory.products.dead_stock_days      one product
--     -> inventory.categories.dead_stock_days   a group of products  <-- NEW
--       -> core.location_settings.dead_stock_days_default   this location
--         -> 90                                             the platform floor
--
-- WHY CATEGORY BEATS THE LOCATION DEFAULT, and not the other way round. It is
-- tempting to let a location's own setting win over a business-wide category
-- rule, but it cannot work: dead_stock_days_default is NOT NULL DEFAULT 90 and
-- migration 0053 backfilled a settings row for EVERY location (LocationsService
-- .ensureLocationSettings keeps that true for new ones). So the location value is
-- never null, would always win the coalesce, and the category column would be
-- write-only — settable in the UI and incapable of ever changing a result.
-- Ordering by product specificity is also the honest reading: "colour sits for
-- six months" is a fact about the product type, not about the salon.
--
-- The location default keeps its job: it is what UNCATEGORISED products and
-- categories with no threshold of their own fall back to.
--
-- WHAT THIS DOES
--   1. inventory.categories.dead_stock_days — nullable; NULL means "inherit".
--   2. Rewrites inventory.dead_stock_report to consult it, and to report
--      'category' as the threshold_source so the UI can explain the number.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   - No per-location category override. That needs a join table, and nothing has
--     asked for "colour is 180 days at Pinner but 120 at Harrow" yet.
--   - Nothing is stored or backfilled. The report is still COMPUTED ON READ, so
--     changing a category threshold re-evaluates immediately with no job to run.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. The category-level threshold
-- =============================================================================

alter table inventory.categories
  add column if not exists dead_stock_days integer;

-- NULL is meaningful here and is NOT the same as 0: null = "inherit the location
-- default", whereas 0 would mean "everything in this category is dead the moment
-- it lands". The check forbids 0 outright so the two can never be confused —
-- matching location_settings_dead_stock_days_default_positive (0093) and the
-- >= 1 rule the product field already enforces in its form.
alter table inventory.categories
  drop constraint if exists inventory_categories_dead_stock_days_positive;
alter table inventory.categories
  add constraint inventory_categories_dead_stock_days_positive
  check (dead_stock_days is null or dead_stock_days > 0);

comment on column inventory.categories.dead_stock_days is
  'Days idle before stock in this category counts as dead. NULL = inherit '
  'core.location_settings.dead_stock_days_default. Overridden by a product''s own '
  'inventory.products.dead_stock_days, and overrides the location default — see '
  'inventory.dead_stock_report for the single place that precedence is applied. '
  'Business-wide: a category is not location-scoped, so this value applies at '
  'every location.';

-- =============================================================================
-- 2. Teach the report the new level
-- =============================================================================
--
-- Unchanged from 0093 except for the category join, the extra coalesce term and
-- the extra threshold_source branch. The whole precedence still lives in this one
-- function, so every consumer (API, SQL suite, acceptance harness) agrees on what
-- "dead" means and none of them re-derives it.

create or replace function inventory.dead_stock_report(
  p_business_id uuid,
  p_location_ids uuid[]
) returns table (
  location_id uuid,
  product_id uuid,
  quantity_on_hand_grams numeric,
  last_outbound_at timestamptz,
  idle_since timestamptz,
  days_idle integer,
  threshold_days integer,
  threshold_source text
)
language sql
stable
security definer
set search_path = public, inventory, core
as $$
  select *
  from (
    select
      ls.location_id,
      ls.product_id,
      ls.quantity_on_hand_grams,
      ob.last_outbound_at,
      -- The idle clock starts at the last outbound; a never-used product falls
      -- back to its first movement (its opening balance / restock), then to the
      -- shelf record itself. A later restock never appears here, so it cannot
      -- reset the clock.
      coalesce(ob.last_outbound_at, fm.first_movement_at, ls.created_at) as idle_since,
      floor(extract(epoch from (now() - coalesce(ob.last_outbound_at, fm.first_movement_at, ls.created_at))) / 86400)::integer as days_idle,
      coalesce(p.dead_stock_days, c.dead_stock_days, s.dead_stock_days_default, 90) as threshold_days,
      case
        when p.dead_stock_days is not null then 'product'
        when c.dead_stock_days is not null then 'category'
        else 'location_default'
      end as threshold_source
    from inventory.location_stock ls
    join inventory.products p
      on p.id = ls.product_id
    -- LEFT: products.category_id is nullable (0038), so an uncategorised product
    -- simply falls through to the location default.
    left join inventory.categories c
      on c.id = p.category_id
     and c.business_id = ls.business_id
    left join core.location_settings s
      on s.location_id = ls.location_id
    left join lateral (
      select max(m.created_at) as last_outbound_at
      from inventory.stock_movements m
      where m.location_id = ls.location_id
        and m.product_id = ls.product_id
        and m.quantity_delta_grams < 0
    ) ob on true
    left join lateral (
      select min(m.created_at) as first_movement_at
      from inventory.stock_movements m
      where m.location_id = ls.location_id
        and m.product_id = ls.product_id
    ) fm on true
    where ls.business_id = p_business_id
      and ls.location_id = any(p_location_ids)
      and ls.is_active
      and p.is_active
      and ls.quantity_on_hand_grams > 0
  ) report
  where report.days_idle >= report.threshold_days
  order by report.days_idle desc, report.quantity_on_hand_grams desc;
$$;

comment on function inventory.dead_stock_report(uuid, uuid[]) is
  'Products idle at or beyond their dead-stock threshold, for the given business '
  'and location scope. Threshold precedence, most specific first: '
  'product.dead_stock_days, else category.dead_stock_days (0101), else the '
  'location default, else 90. threshold_source names which level supplied the '
  'number so the UI can explain it. Computed on read — changing any threshold '
  'takes effect on the next call with nothing to backfill.';

-- A deactivated category must not keep applying its threshold silently... except
-- it should: is_active governs whether a category can be CHOSEN, not whether the
-- products already in it exist. Deliberately not filtered, so archiving a
-- category never silently changes which stock reads as dead.
