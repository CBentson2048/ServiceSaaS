-- 0094_week6_purchase_orders.sql
-- Week 6 tickets 8 + 9 — Automated order forms; approval, supplier email, history.
--
-- Ticket 8 computes WHAT to order (suggested quantities from trailing usage,
-- rounded up through pack size -> minimum order quantity -> order multiple) and
-- stores it as an editable DRAFT purchase order, one per supplier. Ticket 9 is
-- the control layer on top: a draft becomes a commercial act only through
-- submit -> approve -> send, approval is the spend control with its own
-- permission keys, the send emails the supplier, and the stored rows are the
-- permanent history.
--
-- WHAT THIS DOES
--   1. Reorder planning knobs on core.location_settings.
--   2. inventory.purchase_orders / purchase_order_lines / purchase_order_counters.
--   3. inventory.create_purchase_order(jsonb, jsonb) — gapless PO numbers via
--      the bill_counters pattern (0085), one OPEN order per supplier+location.
--   4. inventory.reorder_usage(uuid, uuid, timestamptz) — outbound usage
--      aggregate the suggestion algorithm reads.
--   5. orders.view / orders.manage / orders.approve permission seeds. The
--      matching PERMISSION_CATALOG entries ship in the same commit (the 0074
--      rule: a key seeded only here is silently stripped on the next save).
--
-- STATE MACHINE (enforced by the API service; the DB stores the truth):
--   draft -> pending_approval -> approved -> sent
--   draft/pending_approval/approved -> cancelled
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Reorder planning settings
-- =============================================================================
alter table core.location_settings
  add column if not exists reorder_usage_window_weeks integer not null default 8,
  add column if not exists reorder_coverage_weeks integer not null default 4;

alter table core.location_settings
  drop constraint if exists location_settings_reorder_window_positive;
alter table core.location_settings
  add constraint location_settings_reorder_window_positive
  check (reorder_usage_window_weeks > 0);

alter table core.location_settings
  drop constraint if exists location_settings_reorder_coverage_positive;
alter table core.location_settings
  add constraint location_settings_reorder_coverage_positive
  check (reorder_coverage_weeks > 0);

comment on column core.location_settings.reorder_usage_window_weeks is
  'Trailing weeks of outbound movements the reorder suggestion averages over.';
comment on column core.location_settings.reorder_coverage_weeks is
  'Weeks of forecast usage a suggested order should cover.';

-- =============================================================================
-- 2. Purchase orders
-- =============================================================================
do $$ begin
  create type inventory.purchase_order_status_enum as enum (
    'draft', 'pending_approval', 'approved', 'sent', 'cancelled'
  );
exception when duplicate_object then null; end $$;

create table if not exists inventory.purchase_order_counters (
  business_id uuid primary key references core.businesses(id) on delete cascade,
  next_number bigint not null default 1
);

comment on table inventory.purchase_order_counters is
  'Per-business sequence behind human PO numbers. Same gapless pattern as '
  'billing.bill_counters (0085): allocation happens inside the guarded insert '
  'so a lost race rolls the increment back.';

create table if not exists inventory.purchase_orders (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete restrict,
  supplier_id uuid not null references inventory.suppliers(id) on delete restrict,
  order_number text not null,
  status inventory.purchase_order_status_enum not null default 'draft',
  currency_code char(3) not null default 'GBP',
  subtotal_cents integer not null default 0 check (subtotal_cents >= 0),
  notes text,
  created_by uuid references core.user_profiles(id) on delete set null,
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references core.user_profiles(id) on delete set null,
  sent_at timestamptz,
  sent_to_email text,
  send_error text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, order_number)
);

-- One OPEN order per supplier at a location. This is what makes a retried
-- "generate" safe: the second attempt loses this race and is handed the
-- existing draft instead of numbering a duplicate.
create unique index if not exists inventory_purchase_orders_open_supplier_key
  on inventory.purchase_orders (location_id, supplier_id)
  where status in ('draft', 'pending_approval');

create index if not exists idx_purchase_orders_business_status
  on inventory.purchase_orders (business_id, status, created_at desc);
create index if not exists idx_purchase_orders_location
  on inventory.purchase_orders (business_id, location_id, created_at desc);

create table if not exists inventory.purchase_order_lines (
  id uuid primary key default extensions.gen_random_uuid(),
  purchase_order_id uuid not null references inventory.purchase_orders(id) on delete cascade,
  product_id uuid not null references inventory.products(id) on delete restrict,
  -- Snapshots: history must stay truthful after a product is renamed or
  -- repacked, so the line freezes what was true when the order was drafted.
  product_name_snapshot text not null,
  pack_size_snapshot numeric(12,3),
  stock_unit_snapshot text not null default 'gram',
  suggested_quantity integer not null check (suggested_quantity >= 0),
  ordered_quantity integer not null check (ordered_quantity >= 0),
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  line_total_cents integer not null default 0 check (line_total_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (purchase_order_id, product_id)
);

create index if not exists idx_purchase_order_lines_order
  on inventory.purchase_order_lines (purchase_order_id);

drop trigger if exists inventory_purchase_orders_set_updated_at on inventory.purchase_orders;
create trigger inventory_purchase_orders_set_updated_at
before update on inventory.purchase_orders
for each row execute function public.set_updated_at();

drop trigger if exists inventory_purchase_order_lines_set_updated_at on inventory.purchase_order_lines;
create trigger inventory_purchase_order_lines_set_updated_at
before update on inventory.purchase_order_lines
for each row execute function public.set_updated_at();

alter table inventory.purchase_orders enable row level security;
alter table inventory.purchase_order_lines enable row level security;
alter table inventory.purchase_order_counters enable row level security;

drop policy if exists purchase_orders_owner_select on inventory.purchase_orders;
create policy purchase_orders_owner_select
on inventory.purchase_orders for select
using (public.is_business_owner(business_id));

drop policy if exists purchase_orders_member_select on inventory.purchase_orders;
create policy purchase_orders_member_select
on inventory.purchase_orders for select
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = inventory.purchase_orders.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

drop policy if exists purchase_order_lines_parent_select on inventory.purchase_order_lines;
create policy purchase_order_lines_parent_select
on inventory.purchase_order_lines for select
using (exists (
  select 1 from inventory.purchase_orders po
  where po.id = inventory.purchase_order_lines.purchase_order_id
));

-- All WRITES go through the service-role API (which owns the state machine and
-- the permission checks); clients get read-only visibility under RLS.
grant select on inventory.purchase_orders, inventory.purchase_order_lines to authenticated;
grant all on inventory.purchase_orders, inventory.purchase_order_lines,
  inventory.purchase_order_counters to service_role;

-- =============================================================================
-- 3. Gapless, race-safe order creation
-- =============================================================================
create or replace function inventory.create_purchase_order(
  p_order jsonb,
  p_lines jsonb
) returns table (id uuid, order_number text, created boolean)
language plpgsql
security definer
set search_path = public, inventory, core
as $$
declare
  v_business_id uuid := (p_order->>'business_id')::uuid;
  v_location_id uuid := (p_order->>'location_id')::uuid;
  v_supplier_id uuid := (p_order->>'supplier_id')::uuid;
  v_existing inventory.purchase_orders%rowtype;
  v_number bigint;
  v_order_number text;
  v_id uuid;
  v_line jsonb;
begin
  -- Fast path: an open order for this supplier+location already exists.
  select * into v_existing
  from inventory.purchase_orders po
  where po.location_id = v_location_id
    and po.supplier_id = v_supplier_id
    and po.status in ('draft', 'pending_approval');
  if found then
    return query select v_existing.id, v_existing.order_number, false;
    return;
  end if;

  begin
    -- Counter allocation lives INSIDE the guarded block so a lost race on the
    -- open-order unique index rolls the increment back too — the per-business
    -- sequence stays gapless instead of burning a number per race (0085 pattern).
    insert into inventory.purchase_order_counters as c (business_id, next_number)
    values (v_business_id, 2)
    on conflict (business_id) do update set next_number = c.next_number + 1
    returning c.next_number - 1 into v_number;

    v_order_number := 'PO-' || lpad(v_number::text, 5, '0');

    insert into inventory.purchase_orders (
      business_id, location_id, supplier_id, order_number, status,
      currency_code, subtotal_cents, notes, created_by
    ) values (
      v_business_id, v_location_id, v_supplier_id, v_order_number, 'draft',
      coalesce(p_order->>'currency_code', 'GBP'),
      coalesce((p_order->>'subtotal_cents')::integer, 0),
      p_order->>'notes',
      (p_order->>'created_by')::uuid
    ) returning inventory.purchase_orders.id into v_id;

    for v_line in select * from jsonb_array_elements(p_lines) loop
      insert into inventory.purchase_order_lines (
        purchase_order_id, product_id, product_name_snapshot,
        pack_size_snapshot, stock_unit_snapshot,
        suggested_quantity, ordered_quantity, unit_cost_cents, line_total_cents
      ) values (
        v_id,
        (v_line->>'product_id')::uuid,
        v_line->>'product_name',
        (v_line->>'pack_size')::numeric,
        coalesce(v_line->>'stock_unit', 'gram'),
        (v_line->>'suggested_quantity')::integer,
        (v_line->>'ordered_quantity')::integer,
        (v_line->>'unit_cost_cents')::integer,
        coalesce((v_line->>'line_total_cents')::integer, 0)
      );
    end loop;

    return query select v_id, v_order_number, true;
  exception when unique_violation then
    -- Lost the race: hand back whoever won.
    select * into v_existing
    from inventory.purchase_orders po
    where po.location_id = v_location_id
      and po.supplier_id = v_supplier_id
      and po.status in ('draft', 'pending_approval');
    if found then
      return query select v_existing.id, v_existing.order_number, false;
    else
      raise;
    end if;
  end;
end;
$$;

comment on function inventory.create_purchase_order(jsonb, jsonb) is
  'Creates a draft purchase order with a gapless per-business PO number, or '
  'returns the existing OPEN order for the supplier+location (created=false). '
  'Race-safe: the counter increment rolls back with a lost race.';

-- =============================================================================
-- 4. Outbound usage aggregate for reorder suggestions
-- =============================================================================
-- Outbound only (quantity_delta_grams < 0): a restock is not usage, and
-- counting it would inflate every forecast. The MOQ/pack arithmetic itself
-- lives in TypeScript (orders/reorder-math.ts) where it is unit-tested.
create or replace function inventory.reorder_usage(
  p_business_id uuid,
  p_location_id uuid,
  p_from timestamptz
) returns table (product_id uuid, outbound_base numeric)
language sql
stable
security definer
set search_path = public, inventory
as $$
  select m.product_id, sum(-m.quantity_delta_grams) as outbound_base
  from inventory.stock_movements m
  where m.business_id = p_business_id
    and m.location_id = p_location_id
    and m.quantity_delta_grams < 0
    and m.created_at >= p_from
  group by m.product_id;
$$;

comment on function inventory.reorder_usage(uuid, uuid, timestamptz) is
  'Total outbound base quantity per product at a location since p_from. '
  'Feeds the Week 6 reorder suggestion; outbound-only by design.';

-- Both functions take caller-supplied tenant arguments and run as definer:
-- without this revoke, Postgres''s default EXECUTE-to-PUBLIC would make them a
-- cross-tenant surface for any authenticated user (0071 bug, 0078 fix pattern).
revoke all on function inventory.create_purchase_order(jsonb, jsonb) from public, anon, authenticated;
revoke all on function inventory.reorder_usage(uuid, uuid, timestamptz) from public, anon, authenticated;
grant execute on function inventory.create_purchase_order(jsonb, jsonb) to service_role;
grant execute on function inventory.reorder_usage(uuid, uuid, timestamptz) to service_role;

-- =============================================================================
-- 5. Permission seeds — orders.view / orders.manage / orders.approve
-- =============================================================================
-- Approval is the spend control: managers PREPARE orders (view + manage), only
-- owner/group_admin APPROVE and SEND by default. Owners can widen this per
-- business at /settings/security-levels.
--
-- *** DO NOT add any orders key to DEFAULT_ROLE_PERMISSIONS.manager. ***
-- Memberships without an explicit security_level_id fall back to role
-- defaults, which would hand every unassigned front-desk user ordering rights
-- (the 0074 lesson). Managers get keys through the 'manager' system level.

update core.security_levels
set permissions = permissions || '["orders.view"]'::jsonb, updated_at = now()
where is_system = true and key in ('owner', 'group_admin', 'manager')
  and not permissions @> '["orders.view"]'::jsonb;

update core.security_levels
set permissions = permissions || '["orders.manage"]'::jsonb, updated_at = now()
where is_system = true and key in ('owner', 'group_admin', 'manager')
  and not permissions @> '["orders.manage"]'::jsonb;

update core.security_levels
set permissions = permissions || '["orders.approve"]'::jsonb, updated_at = now()
where is_system = true and key in ('owner', 'group_admin')
  and not permissions @> '["orders.approve"]'::jsonb;
