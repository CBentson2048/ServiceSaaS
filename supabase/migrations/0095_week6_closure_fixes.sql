-- 0095_week6_closure_fixes.sql
-- Week 6 closure pass — two defects found auditing the shipped 0092/0094 work.
--
-- 1. PERMISSION BYPASS. 0092 granted `select, insert, update, delete` on
--    inventory.suppliers to `authenticated`, and 0094 granted `select` on
--    inventory.purchase_orders / purchase_order_lines, each with a
--    "any active member of the business" RLS policy. The `inventory` schema is
--    exposed through PostgREST (supabase/config.toml), and every signed-in user
--    holds a JWT PostgREST accepts, so a stylist could read supplier pricing and
--    the salon's purchase-order spend straight from the REST endpoint —
--    bypassing `orders.view` and the location scoping the API enforces.
--    Nothing in the web app reads these tables directly (every path goes through
--    the service-role API), so the grants bought nothing and are withdrawn.
--
-- 2. DUPLICATE ORDERS. 0094's partial unique index treated only `draft` and
--    `pending_approval` as OPEN. An order that was approved but not yet sent
--    therefore did not block a fresh Generate, so a second run created a second
--    order for the same supplier and location — duplicate spend.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Withdraw direct client access to supplier and purchase-order data
-- =============================================================================
revoke all on inventory.suppliers from authenticated;
revoke all on inventory.purchase_orders from authenticated;
revoke all on inventory.purchase_order_lines from authenticated;

drop policy if exists inventory_suppliers_member_select on inventory.suppliers;
drop policy if exists purchase_orders_member_select on inventory.purchase_orders;
drop policy if exists purchase_order_lines_parent_select on inventory.purchase_order_lines;

comment on table inventory.suppliers is
  'Business-scoped supplier catalogue. contact_email is where the Week 7 '
  'automated order form is sent; lead_time_days informs reorder planning. '
  'Reachable only through the service-role API, which enforces inventory.manage '
  'and the caller''s location scope — deliberately NOT granted to authenticated.';
comment on table inventory.purchase_orders is
  'Purchase orders. Reachable only through the service-role API, which enforces '
  'orders.view / orders.manage / orders.approve and location scope. Deliberately '
  'NOT granted to authenticated: spend data must not be readable straight from '
  'PostgREST by any signed-in member.';

-- =============================================================================
-- 2. An approved-but-unsent order is still OPEN
-- =============================================================================
drop index if exists inventory.inventory_purchase_orders_open_supplier_key;
create unique index if not exists inventory_purchase_orders_open_supplier_key
  on inventory.purchase_orders (location_id, supplier_id)
  where status in ('draft', 'pending_approval', 'approved');

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
  -- OPEN now includes `approved`: an order that is authorised but not yet sent
  -- still covers this supplier, so a repeated Generate must not duplicate it.
  select * into v_existing
  from inventory.purchase_orders po
  where po.location_id = v_location_id
    and po.supplier_id = v_supplier_id
    and po.status in ('draft', 'pending_approval', 'approved');
  if found then
    return query select v_existing.id, v_existing.order_number, false;
    return;
  end if;

  begin
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
    select * into v_existing
    from inventory.purchase_orders po
    where po.location_id = v_location_id
      and po.supplier_id = v_supplier_id
      and po.status in ('draft', 'pending_approval', 'approved');
    if found then
      return query select v_existing.id, v_existing.order_number, false;
    else
      raise;
    end if;
  end;
end;
$$;

revoke all on function inventory.create_purchase_order(jsonb, jsonb) from public, anon, authenticated;
grant execute on function inventory.create_purchase_order(jsonb, jsonb) to service_role;
