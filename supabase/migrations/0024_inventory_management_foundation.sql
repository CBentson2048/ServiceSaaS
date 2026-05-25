-- 0024_inventory_management_foundation.sql
-- Production inventory management foundation: catalogue metadata, location stock,
-- auditable manual adjustments, and low-stock maintenance.

do $$
begin
  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'inventory'
      and t.typname = 'stock_movement_type_enum'
      and e.enumlabel = 'opening_balance'
  ) then
    alter type inventory.stock_movement_type_enum add value 'opening_balance';
  end if;

  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'inventory'
      and t.typname = 'stock_movement_type_enum'
      and e.enumlabel = 'restock'
  ) then
    alter type inventory.stock_movement_type_enum add value 'restock';
  end if;

  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'inventory'
      and t.typname = 'stock_movement_type_enum'
      and e.enumlabel = 'retail_sale'
  ) then
    alter type inventory.stock_movement_type_enum add value 'retail_sale';
  end if;

  if not exists (
    select 1
    from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'inventory'
      and t.typname = 'stock_movement_type_enum'
      and e.enumlabel = 'correction'
  ) then
    alter type inventory.stock_movement_type_enum add value 'correction';
  end if;
end
$$;

alter table inventory.products
  add column if not exists category text,
  add column if not exists size_value numeric(12,3),
  add column if not exists size_unit text not null default 'g',
  add column if not exists retail_price_cents integer check (retail_price_cents is null or retail_price_cents >= 0);

alter table inventory.location_stock
  add column if not exists is_active boolean not null default true,
  add column if not exists created_at timestamptz not null default now();

alter table inventory.stock_movements
  add column if not exists location_stock_id uuid references inventory.location_stock(id) on delete set null,
  add column if not exists reference_type text,
  add column if not exists reference_id uuid,
  add column if not exists notes text,
  add column if not exists created_by uuid references core.user_profiles(id) on delete set null,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

update inventory.stock_movements sm
set location_stock_id = ls.id
from inventory.location_stock ls
where sm.location_stock_id is null
  and ls.location_id = sm.location_id
  and ls.product_id = sm.product_id;

create index if not exists idx_inventory_products_business_active_category
on inventory.products (business_id, is_active, category, name);

create index if not exists idx_location_stock_location_active
on inventory.location_stock (business_id, location_id, is_active, product_id);

create index if not exists idx_stock_movements_location_created
on inventory.stock_movements (business_id, location_id, created_at desc);

create index if not exists idx_stock_movements_product_created
on inventory.stock_movements (business_id, product_id, created_at desc);

create or replace function inventory.adjust_location_stock(p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, inventory, core
as $$
declare
  v_business_id uuid := nullif(p_payload->>'businessId', '')::uuid;
  v_location_id uuid := nullif(p_payload->>'locationId', '')::uuid;
  v_product_id uuid := nullif(p_payload->>'productId', '')::uuid;
  v_created_by uuid := nullif(p_payload->>'createdBy', '')::uuid;
  v_delta numeric(12,3) := coalesce((p_payload->>'quantityDeltaGrams')::numeric, 0);
  v_movement_type inventory.stock_movement_type_enum :=
    coalesce(nullif(p_payload->>'movementType', ''), 'manual_adjustment')::inventory.stock_movement_type_enum;
  v_unit_cost integer;
  v_total_cost integer;
  v_threshold numeric(12,3);
  v_location_stock inventory.location_stock%rowtype;
  v_movement inventory.stock_movements%rowtype;
begin
  if v_business_id is null or v_location_id is null or v_product_id is null then
    raise exception 'businessId, locationId, and productId are required';
  end if;

  if v_delta = 0 then
    raise exception 'quantityDeltaGrams must not be zero';
  end if;

  select default_cost_per_gram_cents
  into v_unit_cost
  from inventory.products
  where id = v_product_id
    and business_id = v_business_id
    and is_active;

  if not found then
    raise exception 'Product is not active for this business';
  end if;

  insert into inventory.location_stock (
    business_id,
    location_id,
    product_id,
    quantity_on_hand_grams,
    low_stock_threshold_grams,
    is_active
  )
  values (v_business_id, v_location_id, v_product_id, 0, null, true)
  on conflict (location_id, product_id) do update
    set is_active = true
  returning * into v_location_stock;

  update inventory.location_stock
  set quantity_on_hand_grams = quantity_on_hand_grams + v_delta,
      is_active = true
  where id = v_location_stock.id
  returning * into v_location_stock;

  v_total_cost := case
    when v_unit_cost is null then null
    else round(abs(v_delta) * v_unit_cost)::integer
  end;

  insert into inventory.stock_movements (
    business_id,
    location_id,
    product_id,
    location_stock_id,
    movement_type,
    quantity_delta_grams,
    unit_cost_cents,
    total_cost_cents,
    reference_type,
    reference_id,
    reason,
    notes,
    created_by,
    metadata
  )
  values (
    v_business_id,
    v_location_id,
    v_product_id,
    v_location_stock.id,
    v_movement_type,
    v_delta,
    v_unit_cost,
    v_total_cost,
    nullif(p_payload->>'referenceType', ''),
    nullif(p_payload->>'referenceId', '')::uuid,
    nullif(p_payload->>'reason', ''),
    nullif(p_payload->>'notes', ''),
    v_created_by,
    coalesce(p_payload->'metadata', '{}'::jsonb)
  )
  returning * into v_movement;

  v_threshold := coalesce(v_location_stock.low_stock_threshold_grams, (
    select low_stock_threshold_grams from inventory.products where id = v_product_id
  ));

  if v_threshold is not null and v_threshold > 0 and v_location_stock.quantity_on_hand_grams <= v_threshold then
    insert into inventory.low_stock_alerts (
      business_id,
      location_id,
      product_id,
      remaining_quantity_grams,
      threshold_quantity_grams,
      status,
      last_triggered_at
    )
    values (
      v_business_id,
      v_location_id,
      v_product_id,
      v_location_stock.quantity_on_hand_grams,
      v_threshold,
      'open',
      now()
    )
    on conflict (location_id, product_id, status) do update set
      remaining_quantity_grams = excluded.remaining_quantity_grams,
      threshold_quantity_grams = excluded.threshold_quantity_grams,
      last_triggered_at = now();
  elsif v_threshold is null or v_threshold <= 0 or v_location_stock.quantity_on_hand_grams > v_threshold then
    update inventory.low_stock_alerts
    set status = 'resolved',
        resolved_at = now(),
        metadata = metadata || jsonb_build_object('resolvedBy', 'stock_adjustment')
    where location_id = v_location_id
      and product_id = v_product_id
      and status = 'open';
  end if;

  return jsonb_build_object(
    'locationStockId', v_location_stock.id,
    'movementId', v_movement.id,
    'quantityOnHandGrams', v_location_stock.quantity_on_hand_grams,
    'lowStockThresholdGrams', v_threshold
  );
end;
$$;

revoke all on function inventory.adjust_location_stock(jsonb) from public;
grant execute on function inventory.adjust_location_stock(jsonb) to service_role;

comment on function inventory.adjust_location_stock(jsonb) is
  'Atomically updates location stock, writes an auditable movement, and maintains low-stock alert state.';
