-- 0079_product_use_classification.sql
--
-- Product use classification (Salon / Lab / Retail) — Luke's 4 Aug 2026 review.
-- A product can carry several use flags at once; the flags gate conditional
-- pricing fields in the UI (lab markup, retail price) and downstream behaviour
-- (retail-sale product picker, Lab deduction config).
--
-- NOTE ON HISTORY: this migration was first applied to the dev-test branch on
-- 2026-08-04 (schema_migrations version 20260804193713) before the file landed
-- in the repo; this file records those exact statements so every environment
-- and the repo agree. All statements are idempotent — re-applying is a no-op.
--
-- retail_price_cents ALREADY exists (0024) and retail sales already price from
-- it (0031): this migration deliberately does NOT add a price column. Billing
-- application of lab_markup_percent ships separately (see comment below).

alter table inventory.products
  add column if not exists is_salon_use boolean not null default false;

alter table inventory.products
  add column if not exists is_lab_use boolean not null default false;

alter table inventory.products
  add column if not exists is_retail boolean not null default false;

alter table inventory.products
  add column if not exists lab_markup_percent numeric(6,2);

alter table inventory.products
  drop constraint if exists products_lab_markup_percent_range;
alter table inventory.products
  add constraint products_lab_markup_percent_range
  check (lab_markup_percent is null or (lab_markup_percent >= 0 and lab_markup_percent <= 1000));

comment on column inventory.products.is_salon_use is
  'Product is consumed by the salon itself (backwash, towels-and-tools stock). Owner-configurable; a product can carry several use flags.';
comment on column inventory.products.is_lab_use is
  'Product is used by QLOOQO Lab formulas (colour stock). Gates the lab markup field in the UI.';
comment on column inventory.products.is_retail is
  'Product is sold to clients to take home. Gates the retail price field in the UI and the retail-sale product picker.';
comment on column inventory.products.lab_markup_percent is
  'Markup applied on product cost when billed through Lab usage (cost x (1 + markup/100)). Stored even when is_lab_use is off so re-ticking restores it. Application to billing ships separately.';

update inventory.products
set
  is_lab_use = true,
  is_retail = (retail_price_cents is not null)
where is_salon_use = false
  and is_lab_use = false
  and is_retail = false
  and created_at < '2026-08-05';
