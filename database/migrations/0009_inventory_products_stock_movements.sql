-- 0009_inventory_products_stock_movements.sql

create type inventory.unit_of_measure_enum as enum (
  'grams',
  'millilitres',
  'units'
);

create type inventory.stock_movement_type_enum as enum (
  'purchase',
  'formula_usage',
  'sale',
  'adjustment',
  'transfer_in',
  'transfer_out',
  'waste',
  'return',
  'correction'
);

create type inventory.waste_reason_enum as enum (
  'expired',
  'spill',
  'damaged',
  'sample_use',
  'manual_adjustment',
  'other'
);

create type inventory.low_stock_alert_status_enum as enum (
  'open',
  'acknowledged',
  'resolved'
);

create table inventory.products (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  sku text not null,
  brand_name text,
  product_name text not null,
  category text,
  manufacturer_name text,
  barcode text,
  unit_of_measure inventory.unit_of_measure_enum not null,
  package_size integer not null check (package_size > 0),
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, sku)
);

comment on table inventory.products is
  'Operational catalog only. Financial values live in inventory.product_costs to avoid leaking owner-only margin data to stylists.';

create table inventory.location_stock (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  product_id uuid not null references inventory.products(id) on delete cascade,
  on_hand_quantity integer not null default 0,
  reserved_quantity integer not null default 0,
  reorder_threshold_quantity integer not null default 0,
  target_stock_quantity integer not null default 0,
  last_counted_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, product_id),
  check (on_hand_quantity >= 0),
  check (reserved_quantity >= 0),
  check (reorder_threshold_quantity >= 0),
  check (target_stock_quantity >= 0)
);

create table inventory.stock_movements (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  product_id uuid not null references inventory.products(id) on delete restrict,
  visit_id uuid references booking.visits(id) on delete set null,
  formula_id uuid references lab.formulas(id) on delete set null,
  movement_type inventory.stock_movement_type_enum not null,
  quantity_delta integer not null check (quantity_delta <> 0),
  reference_table text,
  reference_id uuid,
  recorded_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  recorded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table inventory.waste_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  product_id uuid not null references inventory.products(id) on delete restrict,
  stock_movement_id uuid unique references inventory.stock_movements(id) on delete set null,
  quantity integer not null check (quantity > 0),
  waste_reason inventory.waste_reason_enum not null,
  recorded_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  occurred_at timestamptz not null default now(),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table inventory.low_stock_alerts (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  product_id uuid not null references inventory.products(id) on delete cascade,
  location_stock_id uuid references inventory.location_stock(id) on delete set null,
  threshold_quantity integer not null check (threshold_quantity >= 0),
  current_quantity integer not null check (current_quantity >= 0),
  status inventory.low_stock_alert_status_enum not null default 'open',
  triggered_at timestamptz not null default now(),
  acknowledged_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  acknowledged_at timestamptz,
  resolved_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table inventory.product_costs (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete cascade,
  product_id uuid not null references inventory.products(id) on delete cascade,
  effective_from date not null,
  effective_to date,
  unit_cost_amount numeric(12,2) not null default 0,
  retail_price_amount numeric(12,2),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (product_id, location_id, effective_from),
  check (effective_to is null or effective_to >= effective_from)
);
