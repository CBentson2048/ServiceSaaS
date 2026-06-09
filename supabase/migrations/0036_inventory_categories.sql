-- 0036_inventory_categories.sql
-- Adds a managed inventory category catalogue (inventory.categories) so
-- businesses can maintain a controlled taxonomy instead of free-text product
-- categories. Scoped per business; category names are unique per business
-- (case-insensitive). inventory.products.category remains free text for now —
-- a future migration can link products to this table via FK.

create table if not exists inventory.categories (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One category name per business, case-insensitive.
create unique index if not exists inventory_categories_business_name_key
  on inventory.categories (business_id, lower(name));

create index if not exists idx_inventory_categories_business_id
  on inventory.categories (business_id);

drop trigger if exists inventory_categories_set_updated_at on inventory.categories;
create trigger inventory_categories_set_updated_at
before update on inventory.categories
for each row execute function public.set_updated_at();

alter table inventory.categories enable row level security;

drop policy if exists inventory_categories_owner_all on inventory.categories;
create policy inventory_categories_owner_all
on inventory.categories for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists inventory_categories_member_select on inventory.categories;
create policy inventory_categories_member_select
on inventory.categories for select
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = inventory.categories.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

grant select, insert, update, delete on inventory.categories to authenticated, service_role;

comment on table inventory.categories is
  'Business-scoped inventory category catalogue for organising the product range.';
