-- 0096_retail_pricing_and_classification.sql
-- Product Use Classification & Pricing Resolution (approved CR, final rules).
--
-- WHAT THIS DOES
--   1. inventory.retail_pricing_rules — ONE canonical table for every level of
--      Luke's confirmed retail pricing precedence:
--        location_product > product > location_category > category > location
--      A rule is either a percentage markup on cost or a fixed selling price.
--      NO ROW means "inherit from the next level"; a row with markup 0 means an
--      INTENTIONAL zero-markup override that stops inheritance. Null-vs-zero is
--      therefore structural: absence inherits, presence (any value, incl. 0)
--      wins. Rules never stack — the resolver stops at the first row it finds.
--   2. Pricing provenance snapshots on billing.retail_sales, so a completed
--      sale permanently records the cost, mode, source and configured value
--      that produced its price. Completed transactions are never recomputed.
--   3. billing.record_retail_sale — same behaviour as the 0091 version, plus
--      it persists the pricing snapshot when the API supplies one. When no
--      snapshot/price is supplied the 0091 behaviour is byte-for-byte intact
--      (unit price defaults to products.retail_price_cents), so nothing about
--      existing salons changes until rules are configured.
--
-- DELIBERATELY NOT DONE
--   - No backfill into retail_pricing_rules: the table starts EMPTY, so every
--     product resolves to "no rule" and keeps today's price
--     (products.retail_price_cents at the till). No salon's prices move
--     because the schema shipped.
--   - products.retail_price_cents is NOT dropped or repurposed: it remains the
--     legacy fallback ("existing QLOOQO billing behaviour") when no rule at
--     any level is configured.
--   - Location availability introduces NO new table: a product is available at
--     a location when its inventory.location_stock row is active — the
--     existing structure already models product+location+active with the
--     required uniqueness and indexes.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. The canonical pricing-rule table
-- =============================================================================
do $$ begin
  create type inventory.retail_pricing_scope_enum as enum (
    'location_product', 'product', 'location_category', 'category', 'location'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type inventory.retail_pricing_mode_enum as enum (
    'percentage_markup', 'fixed_price'
  );
exception when duplicate_object then null; end $$;

create table if not exists inventory.retail_pricing_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  scope inventory.retail_pricing_scope_enum not null,
  -- Which entity the rule binds to. The shape is enforced per scope below.
  product_id uuid references inventory.products(id) on delete cascade,
  category_id uuid references inventory.categories(id) on delete cascade,
  location_id uuid references core.locations(id) on delete cascade,
  pricing_mode inventory.retail_pricing_mode_enum not null,
  -- Exactly one of these carries the value, matching pricing_mode.
  -- markup_percent = 0 is a VALID, intentional zero-markup override.
  markup_percent numeric(8,2),
  fixed_price_cents integer,
  created_by uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Scope shape: each level binds to exactly the entities that define it.
alter table inventory.retail_pricing_rules
  drop constraint if exists retail_pricing_rules_scope_shape;
alter table inventory.retail_pricing_rules
  add constraint retail_pricing_rules_scope_shape check (
    (scope = 'location_product'  and product_id is not null and category_id is null     and location_id is not null) or
    (scope = 'product'           and product_id is not null and category_id is null     and location_id is null) or
    (scope = 'location_category' and product_id is null     and category_id is not null and location_id is not null) or
    (scope = 'category'          and product_id is null     and category_id is not null and location_id is null) or
    (scope = 'location'          and product_id is null     and category_id is null     and location_id is not null)
  );

-- Mode/value pairing: one active value, never both, never neither.
alter table inventory.retail_pricing_rules
  drop constraint if exists retail_pricing_rules_mode_value;
alter table inventory.retail_pricing_rules
  add constraint retail_pricing_rules_mode_value check (
    (pricing_mode = 'percentage_markup' and markup_percent is not null and markup_percent >= 0 and fixed_price_cents is null) or
    (pricing_mode = 'fixed_price' and fixed_price_cents is not null and fixed_price_cents >= 0 and markup_percent is null)
  );

-- One rule per level per target. NULLS NOT DISTINCT makes the scope tuple
-- genuinely unique (e.g. only one 'product' rule per product).
create unique index if not exists retail_pricing_rules_scope_key
  on inventory.retail_pricing_rules (business_id, scope, product_id, category_id, location_id)
  nulls not distinct;

create index if not exists idx_retail_pricing_rules_product
  on inventory.retail_pricing_rules (business_id, product_id) where product_id is not null;
create index if not exists idx_retail_pricing_rules_category
  on inventory.retail_pricing_rules (business_id, category_id) where category_id is not null;
create index if not exists idx_retail_pricing_rules_location
  on inventory.retail_pricing_rules (business_id, location_id) where location_id is not null;

drop trigger if exists retail_pricing_rules_set_updated_at on inventory.retail_pricing_rules;
create trigger retail_pricing_rules_set_updated_at
before update on inventory.retail_pricing_rules
for each row execute function public.set_updated_at();

alter table inventory.retail_pricing_rules enable row level security;

drop policy if exists retail_pricing_rules_owner_select on inventory.retail_pricing_rules;
create policy retail_pricing_rules_owner_select
on inventory.retail_pricing_rules for select
using (public.is_business_owner(business_id));

-- Pricing configuration flows only through the permission-checked service-role
-- API (settings.billing.manage) — deliberately NOT granted to authenticated
-- (the 0095 posture for money-sensitive tables).
grant all on inventory.retail_pricing_rules to service_role;

comment on table inventory.retail_pricing_rules is
  'Retail selling-price rules. Precedence: location_product > product > '
  'location_category > category > location; the resolver stops at the first '
  'configured rule (rules never stack). Absence of a row = inherit; '
  'markup_percent 0 = intentional zero-markup override. When no rule exists at '
  'any level, the legacy products.retail_price_cents applies unchanged.';

-- =============================================================================
-- 2. Pricing provenance snapshots on completed retail sales
-- =============================================================================
-- A completed sale must be reproducible forever from its own row: later rule
-- changes never touch it. All columns nullable — pre-existing rows and sales
-- recorded without the resolver simply carry no snapshot.
alter table billing.retail_sales
  add column if not exists unit_cost_cents integer,
  add column if not exists pricing_mode text,
  add column if not exists pricing_source text,
  add column if not exists pricing_configured_value numeric(12,3),
  add column if not exists effective_markup_percent numeric(8,2);

alter table billing.retail_sales
  drop constraint if exists retail_sales_pricing_mode_allowed;
alter table billing.retail_sales
  add constraint retail_sales_pricing_mode_allowed check (
    pricing_mode is null or pricing_mode in ('percentage_markup', 'fixed_price')
  );
alter table billing.retail_sales
  drop constraint if exists retail_sales_pricing_source_allowed;
alter table billing.retail_sales
  add constraint retail_sales_pricing_source_allowed check (
    pricing_source is null or pricing_source in (
      'location_product', 'product_default', 'location_category',
      'category_default', 'location_default', 'legacy_retail_price', 'manual'
    )
  );

comment on column billing.retail_sales.pricing_source is
  'Which pricing level produced unit_price_cents at the moment of sale '
  '(or manual for a till-side override). Snapshot only — never recomputed.';
comment on column billing.retail_sales.pricing_configured_value is
  'The configured rule value at sale time: the markup percent, or the fixed '
  'price in cents. 0 is a real value (explicit zero markup), not "unset".';

-- =============================================================================
-- 3. record_retail_sale — persist the snapshot the API resolved
-- =============================================================================
-- Identical to the 0091 version except for the optional `pricing` object in
-- the payload. Behaviour with no pricing/unit price supplied is unchanged:
-- unit price falls back to products.retail_price_cents.
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
  v_pricing jsonb := p_payload->'pricing';
  v_product inventory.products%rowtype;
  v_grams numeric(12,3);
  v_pack_size numeric(12,3);
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

  -- Default unit price to the product's configured retail price when omitted
  -- (legacy behaviour, unchanged).
  if v_unit_price < 0 then
    v_unit_price := coalesce(v_product.retail_price_cents, 0);
  end if;
  v_total := v_unit_price * v_quantity;

  insert into billing.retail_sales (
    business_id, location_id, staff_profile_id, product_id, client_profile_id, visit_id,
    quantity, unit_price_cents, total_amount_cents, currency_code, payment_method,
    sold_at, notes, created_by_user_profile_id,
    unit_cost_cents, pricing_mode, pricing_source, pricing_configured_value,
    effective_markup_percent
  ) values (
    v_business_id, v_location_id, v_staff_id, v_product_id, v_client_id, v_visit_id,
    v_quantity, v_unit_price, v_total, v_currency, v_payment_method,
    v_sold_at, v_notes, v_created_by,
    nullif(v_pricing->>'unitCostCents', '')::integer,
    nullif(v_pricing->>'pricingMode', ''),
    nullif(v_pricing->>'pricingSource', ''),
    nullif(v_pricing->>'configuredValue', '')::numeric,
    nullif(v_pricing->>'effectiveMarkupPercent', '')::numeric
  ) returning * into v_sale;

  -- Stock deduction — unchanged from 0091 (fail loudly, never drift silently).
  if v_product.stock_unit = 'unit' then
    v_grams := v_quantity;
  else
    v_pack_size := coalesce(v_product.pack_size, v_product.size_value);
    if v_pack_size is null or v_pack_size <= 0 then
      raise exception
        'Product % has no pack size recorded, so the sale cannot deduct stock. Set a size on the product, or set its stock unit to ''unit'', before selling it.',
        coalesce(v_product.name, v_product_id::text)
        using errcode = 'check_violation';
    end if;
    v_grams := v_quantity * v_pack_size;
  end if;

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

revoke all on function billing.record_retail_sale(jsonb) from public, anon, authenticated;
grant execute on function billing.record_retail_sale(jsonb) to service_role;
