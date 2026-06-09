-- 0037_backfill_inventory_categories_from_products.sql
-- Seeds inventory.categories from the distinct free-text categories already
-- stored on inventory.products (e.g. "Toner", "Hair Color", "Treatment") so the
-- managed catalogue reflects existing data. DISTINCT ON collapses case-only
-- duplicates within the statement; ON CONFLICT DO NOTHING makes it idempotent
-- against the case-insensitive unique (business_id, lower(name)) index.

insert into inventory.categories (business_id, name)
select distinct on (p.business_id, lower(trim(p.category)))
  p.business_id,
  trim(p.category) as name
from inventory.products p
where p.category is not null
  and trim(p.category) <> ''
order by p.business_id, lower(trim(p.category)), trim(p.category)
on conflict do nothing;
