-- 0031_retail_sales.sql
--
-- First-class retail sales. Until now "retail" existed only as an inventory
-- `retail_sale` stock movement (cost-tracked, no stylist link, grams-based),
-- which made the retail KPI and commission base unreliable. This migration
-- records retail sales as real revenue:
--   * stylist attribution (staff_profile_id)
--   * units sold + unit sale price + total (price snapshot)
--   * linked checkout/payment record (payment_method, optional visit_id)
--   * stock deduction on sale (via the existing inventory.adjust_location_stock)
--   * period-safe reporting (sold_at)
--
-- The KPI engine reads retail revenue from this table (summed by stylist and
-- windowed by sold_at) instead of deriving it from stock movements.

create table if not exists billing.retail_sales (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  -- The selling stylist credited for the retail KPI / commission. Nullable so a
  -- front-desk sale without a stylist is still captured at location level.
  staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  product_id uuid not null references inventory.products(id) on delete restrict,
  client_profile_id uuid references core.client_profiles(id) on delete set null,
  -- Optional link to the visit/checkout the sale was rung up against.
  visit_id uuid references booking.visits(id) on delete set null,
  quantity integer not null check (quantity > 0),
  unit_price_cents integer not null check (unit_price_cents >= 0),
  total_amount_cents integer not null check (total_amount_cents >= 0),
  currency_code char(3) not null default 'GBP',
  payment_method text check (payment_method is null or payment_method in ('cash', 'card_reader', 'other')),
  -- The stock movement that deducted inventory for this sale (audit link).
  stock_movement_id uuid references inventory.stock_movements(id) on delete set null,
  -- Period-safe reporting timestamp (when the sale occurred).
  sold_at timestamptz not null default now(),
  notes text,
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table billing.retail_sales is
  'First-class retail product sales: stylist-attributed revenue with stock deduction, used by the retail KPI and commission base.';

create index if not exists idx_retail_sales_business_location_sold_at
  on billing.retail_sales (business_id, location_id, sold_at);
create index if not exists idx_retail_sales_staff_sold_at
  on billing.retail_sales (staff_profile_id, sold_at);
create index if not exists idx_retail_sales_product
  on billing.retail_sales (product_id);

drop trigger if exists retail_sales_set_updated_at on billing.retail_sales;
create trigger retail_sales_set_updated_at
before update on billing.retail_sales
for each row execute function public.set_updated_at();

-- Atomically records a retail sale and deducts stock. Stock deduction reuses
-- the tested inventory.adjust_location_stock function (units × pack size grams),
-- so location_stock + stock_movements + low-stock alerts stay consistent. The
-- whole thing runs in one transaction; a stock failure rolls back the sale.
create or replace function billing.record_retail_sale(p_payload jsonb)
returns billing.retail_sales
language plpgsql
security definer
set search_path = public, billing, inventory, booking, core
as $$
declare
  v_business_id uuid := nullif(p_payload->>'businessId', '')::uuid;
  v_location_id uuid := nullif(p_payload->>'locationId', '')::uuid;
  v_product_id uuid := nullif(p_payload->>'productId', '')::uuid;
  v_staff_id uuid := nullif(p_payload->>'staffProfileId', '')::uuid;
  v_client_id uuid := nullif(p_payload->>'clientProfileId', '')::uuid;
  v_visit_id uuid := nullif(p_payload->>'visitId', '')::uuid;
  v_quantity integer := coalesce((p_payload->>'quantity')::integer, 0);
  v_unit_price integer := coalesce(nullif(p_payload->>'unitPriceCents', '')::integer, -1);
  v_payment_method text := nullif(p_payload->>'paymentMethod', '');
  v_currency char(3) := coalesce(nullif(p_payload->>'currencyCode', ''), 'GBP');
  v_sold_at timestamptz := coalesce(nullif(p_payload->>'soldAt', '')::timestamptz, now());
  v_created_by uuid := nullif(p_payload->>'createdBy', '')::uuid;
  v_notes text := nullif(p_payload->>'notes', '');
  v_product inventory.products%rowtype;
  v_grams numeric(12,3);
  v_total integer;
  v_sale billing.retail_sales%rowtype;
begin
  if v_business_id is null or v_location_id is null or v_product_id is null then
    raise exception 'businessId, locationId and productId are required';
  end if;
  if v_quantity <= 0 then
    raise exception 'quantity must be a positive integer';
  end if;

  select * into v_product
  from inventory.products
  where id = v_product_id and business_id = v_business_id and is_active;
  if not found then
    raise exception 'Product is not active for this business';
  end if;

  -- Default unit price to the product's configured retail price when omitted.
  if v_unit_price < 0 then
    v_unit_price := coalesce(v_product.retail_price_cents, 0);
  end if;
  v_total := v_unit_price * v_quantity;

  insert into billing.retail_sales (
    business_id, location_id, staff_profile_id, product_id, client_profile_id, visit_id,
    quantity, unit_price_cents, total_amount_cents, currency_code, payment_method,
    sold_at, notes, created_by_user_profile_id
  ) values (
    v_business_id, v_location_id, v_staff_id, v_product_id, v_client_id, v_visit_id,
    v_quantity, v_unit_price, v_total, v_currency, v_payment_method,
    v_sold_at, v_notes, v_created_by
  ) returning * into v_sale;

  -- Deduct stock by units × pack size (only when the product tracks a size).
  v_grams := v_quantity * coalesce(v_product.size_value, 0);
  if v_grams > 0 then
    perform inventory.adjust_location_stock(jsonb_build_object(
      'businessId', v_business_id,
      'locationId', v_location_id,
      'productId', v_product_id,
      'quantityDeltaGrams', (-v_grams),
      'movementType', 'retail_sale',
      'referenceType', 'retail_sale',
      'referenceId', v_sale.id,
      'createdBy', v_created_by,
      'notes', v_notes
    ));

    update billing.retail_sales
    set stock_movement_id = (
      select id from inventory.stock_movements
      where reference_type = 'retail_sale' and reference_id = v_sale.id
      order by created_at desc
      limit 1
    )
    where id = v_sale.id
    returning * into v_sale;
  end if;

  return v_sale;
end;
$$;

revoke all on function billing.record_retail_sale(jsonb) from public;
grant execute on function billing.record_retail_sale(jsonb) to service_role;

comment on function billing.record_retail_sale(jsonb) is
  'Atomically records a retail sale (stylist-attributed revenue) and deducts stock via inventory.adjust_location_stock.';

alter table billing.retail_sales enable row level security;

drop policy if exists retail_sales_management_all on billing.retail_sales;
create policy retail_sales_management_all
on billing.retail_sales for all
using (public.has_location_management_scope(business_id, location_id))
with check (public.has_location_management_scope(business_id, location_id));

drop policy if exists retail_sales_desk_select on billing.retail_sales;
create policy retail_sales_desk_select
on billing.retail_sales for select
using (public.has_location_desk_access(business_id, location_id));

grant select, insert, update, delete on billing.retail_sales to authenticated, service_role;
