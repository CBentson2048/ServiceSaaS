-- 0093_week6_dead_stock_alerts.sql
-- Week 6 ticket 7 — Dead stock alerts.
--
-- Dead stock = product sitting on a shelf with quantity on hand but no OUTBOUND
-- movement (usage, sale, consumption — any quantity_delta_grams < 0) for longer
-- than its threshold. Everything is COMPUTED ON READ: changing a threshold
-- reclassifies immediately, and nothing is materialised or scheduled.
--
-- WHAT THIS DOES
--   1. core.location_settings.dead_stock_days_default — the location-wide
--      threshold (90 days); products.dead_stock_days (0092) overrides it.
--   2. inventory.location_stock.created_at — the idle-clock anchor for stock
--      that has never moved. Backfilled from the pair's earliest movement.
--   3. A partial index so "last outbound for this shelf item" is a point read.
--   4. inventory.dead_stock_report(uuid, uuid[]) — the set-based computation.
--
-- DESIGN RULES (from the Week 6 plan §11.4)
--   - Outbound only: a restock is not usage and must NOT reset the idle clock.
--   - Zero on hand is excluded: that is "out of stock", not "dead stock".
--   - Threshold precedence: product.dead_stock_days, else the location default.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Location-wide default threshold
-- =============================================================================
alter table core.location_settings
  add column if not exists dead_stock_days_default integer not null default 90;

alter table core.location_settings
  drop constraint if exists location_settings_dead_stock_days_default_positive;
alter table core.location_settings
  add constraint location_settings_dead_stock_days_default_positive
  check (dead_stock_days_default > 0);

comment on column core.location_settings.dead_stock_days_default is
  'Days without an outbound stock movement before on-hand stock counts as dead. '
  'Per-product inventory.products.dead_stock_days (0092) overrides this.';

-- =============================================================================
-- 2. Idle-clock anchor for never-moved stock
-- =============================================================================
-- location_stock.created_at has existed NOT NULL DEFAULT now() since 0024, so
-- on any normally-migrated database everything below is a no-op and the column
-- already holds the honest "when was this shelf record created" anchor. The
-- guarded add + backfill stay only as a safety net for a database that somehow
-- missed 0024 (backfill from the pair's earliest movement, else updated_at, so
-- long-idle rows do not suddenly look fresh).
alter table inventory.location_stock
  add column if not exists created_at timestamptz;

update inventory.location_stock ls
set created_at = coalesce(
  (select min(m.created_at) from inventory.stock_movements m
    where m.location_id = ls.location_id and m.product_id = ls.product_id),
  ls.updated_at)
where ls.created_at is null;

alter table inventory.location_stock
  alter column created_at set default now();
alter table inventory.location_stock
  alter column created_at set not null;

comment on column inventory.location_stock.created_at is
  'When this shelf record was created (0024). Since 0093 it also anchors the '
  'dead-stock idle clock for stock that has never had a movement.';

-- =============================================================================
-- 3. Point-read index for "last outbound of this shelf item"
-- =============================================================================
create index if not exists idx_stock_movements_outbound_pair
  on inventory.stock_movements (location_id, product_id, created_at desc)
  where quantity_delta_grams < 0;

-- =============================================================================
-- 4. The report
-- =============================================================================
-- Set-based over the location scope the API resolved for the caller: one call
-- answers the whole screen. Only DEAD rows come back — the threshold filter is
-- here, next to the arithmetic it belongs to, so every consumer (API, SQL
-- suite, a future ordering engine excluding dead lines) agrees on what "dead"
-- means. SECURITY DEFINER matches the house RPCs; it is called with the
-- service-role key and both arguments are pinned by the API, never the client.
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
      coalesce(p.dead_stock_days, s.dead_stock_days_default, 90) as threshold_days,
      case when p.dead_stock_days is not null then 'product' else 'location_default' end as threshold_source
    from inventory.location_stock ls
    join inventory.products p
      on p.id = ls.product_id
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
  'Week 6 ticket 7. Shelf items with stock on hand and no outbound movement '
  'within their threshold (product.dead_stock_days, else the location default). '
  'Computed on read; restocks never reset the idle clock; zero on hand is out '
  'of stock, not dead stock.';

-- SECURITY DEFINER + caller-supplied tenant arguments means the default
-- EXECUTE-to-PUBLIC that Postgres puts on every new function would be a
-- cross-tenant read for any authenticated user (the 0071 bug, fixed in 0078).
-- Only the API's service-role client may call this.
revoke all on function inventory.dead_stock_report(uuid, uuid[]) from public, anon, authenticated;
grant execute on function inventory.dead_stock_report(uuid, uuid[]) to service_role;
