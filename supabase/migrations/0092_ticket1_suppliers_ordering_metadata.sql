-- 0092_ticket1_suppliers_ordering_metadata.sql
-- Week 6 ticket 1 completion — Product size & stock metadata.
--
-- 0091 shipped the unit half of the ticket (stock_unit, pack_size, barcode).
-- This file ships the ordering half: the supplier entity and the per-product
-- ordering metadata (supplier link, minimum order quantity, order multiple,
-- dead-stock threshold). Purchase orders themselves are Week 7 and are
-- deliberately absent — these columns are the product metadata the ticket
-- names, and the Week 7 ordering engine reads them.
--
-- WHAT THIS DOES
--   1. inventory.suppliers — business-scoped supplier catalogue (name unique
--      per business, contact email for the Week 7 order email).
--   2. inventory.products — supplier_id, minimum_order_quantity,
--      order_multiple, dead_stock_days.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Suppliers
-- =============================================================================
-- Mirrors inventory.categories (0036): per-business catalogue, case-insensitive
-- name uniqueness, soft deactivation, owner-writable / member-readable RLS.

create table if not exists inventory.suppliers (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  name text not null,
  contact_email text,
  contact_phone text,
  account_reference text,
  lead_time_days integer,
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table inventory.suppliers
  drop constraint if exists suppliers_lead_time_days_non_negative;
alter table inventory.suppliers
  add constraint suppliers_lead_time_days_non_negative
  check (lead_time_days is null or lead_time_days >= 0);

-- One supplier name per business, case-insensitive.
create unique index if not exists inventory_suppliers_business_name_key
  on inventory.suppliers (business_id, lower(name));

create index if not exists idx_inventory_suppliers_business_id
  on inventory.suppliers (business_id);

drop trigger if exists inventory_suppliers_set_updated_at on inventory.suppliers;
create trigger inventory_suppliers_set_updated_at
before update on inventory.suppliers
for each row execute function public.set_updated_at();

alter table inventory.suppliers enable row level security;

drop policy if exists inventory_suppliers_owner_all on inventory.suppliers;
create policy inventory_suppliers_owner_all
on inventory.suppliers for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists inventory_suppliers_member_select on inventory.suppliers;
create policy inventory_suppliers_member_select
on inventory.suppliers for select
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = inventory.suppliers.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

grant select, insert, update, delete on inventory.suppliers to authenticated, service_role;

comment on table inventory.suppliers is
  'Business-scoped supplier catalogue. contact_email is where the Week 7 '
  'automated order form is sent; lead_time_days informs reorder planning.';

-- =============================================================================
-- 2. Product ordering metadata
-- =============================================================================
-- minimum_order_quantity and order_multiple are expressed in PACKS (pack_size
-- base quantities each), because that is the unit a supplier sells in — "order
-- 6 bottles", never "order 1500 grams". dead_stock_days is per-product; a
-- product with null falls back to the location default when Week 7 computes
-- dead stock.

alter table inventory.products
  add column if not exists supplier_id uuid references inventory.suppliers(id) on delete set null,
  add column if not exists minimum_order_quantity integer not null default 1,
  add column if not exists order_multiple integer not null default 1,
  add column if not exists dead_stock_days integer;

alter table inventory.products
  drop constraint if exists products_minimum_order_quantity_min;
alter table inventory.products
  add constraint products_minimum_order_quantity_min
  check (minimum_order_quantity >= 1);

alter table inventory.products
  drop constraint if exists products_order_multiple_min;
alter table inventory.products
  add constraint products_order_multiple_min
  check (order_multiple >= 1);

alter table inventory.products
  drop constraint if exists products_dead_stock_days_positive;
alter table inventory.products
  add constraint products_dead_stock_days_positive
  check (dead_stock_days is null or dead_stock_days > 0);

create index if not exists idx_inventory_products_supplier
  on inventory.products (business_id, supplier_id)
  where supplier_id is not null;

comment on column inventory.products.supplier_id is
  'Supplier this product is ordered from. Null means unassigned; deleting a '
  'supplier detaches its products rather than blocking or cascading.';
comment on column inventory.products.minimum_order_quantity is
  'Smallest order a supplier accepts, in packs of pack_size base quantities.';
comment on column inventory.products.order_multiple is
  'Supplier order step in packs (e.g. 6 = sold by the half-dozen). Suggested '
  'orders round up to the next multiple.';
comment on column inventory.products.dead_stock_days is
  'Days without outbound movement before stock counts as dead. Null falls back '
  'to the location default when Week 7 dead-stock alerts compute it.';
