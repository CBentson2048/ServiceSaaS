-- 0038_link_products_to_inventory_categories.sql
-- Replaces the free-text inventory.products.category column with category_id, a
-- foreign key into inventory.categories. Existing free-text values are matched
-- to the categories seeded in 0037 by case-insensitive name per business;
-- unmatched or blank values become NULL (uncategorised).
-- Requires 0036 (categories table) and 0037 (category seed) to have run first.

-- 1. New FK column (nullable: products may be uncategorised).
alter table inventory.products
  add column if not exists category_id uuid
  references inventory.categories(id) on delete set null;

-- 2. Backfill from the existing free-text name, matched per business.
update inventory.products p
set category_id = c.id
from inventory.categories c
where c.business_id = p.business_id
  and lower(c.name) = lower(trim(p.category))
  and p.category is not null
  and trim(p.category) <> '';

-- 3. Drop the old free-text column. Its dependent index
--    (idx_inventory_products_business_active_category) is dropped automatically.
alter table inventory.products
  drop column category;

-- 4. Recreate the catalogue index against the new FK column.
create index if not exists idx_inventory_products_business_active_category_id
  on inventory.products (business_id, is_active, category_id, name);

comment on column inventory.products.category_id is
  'FK to inventory.categories. Null means the product is uncategorised.';
