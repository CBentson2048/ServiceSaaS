-- 0041_service_categories.sql
-- Adds a managed service category catalogue (booking.service_categories) so
-- service categories are a controlled, business-scoped list — completely
-- independent from the product catalogue (inventory.categories). Services link
-- to it via booking.services.service_category_id. The legacy free-text
-- booking.services.category column is retained for now and backfilled into the
-- new table (a later migration can drop it once nothing reads it).

create table if not exists booking.service_categories (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  name text not null,
  description text,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One category name per business, case-insensitive.
create unique index if not exists service_categories_business_name_key
  on booking.service_categories (business_id, lower(name));

create index if not exists idx_service_categories_business_id
  on booking.service_categories (business_id);

drop trigger if exists service_categories_set_updated_at on booking.service_categories;
create trigger service_categories_set_updated_at
before update on booking.service_categories
for each row execute function public.set_updated_at();

alter table booking.service_categories enable row level security;

drop policy if exists service_categories_owner_all on booking.service_categories;
create policy service_categories_owner_all
on booking.service_categories for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists service_categories_member_select on booking.service_categories;
create policy service_categories_member_select
on booking.service_categories for select
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = booking.service_categories.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

grant select, insert, update, delete on booking.service_categories to authenticated, service_role;

comment on table booking.service_categories is
  'Business-scoped service category catalogue (e.g. Hair Colour, Barbering). Independent from inventory.categories — services only.';

-- Link services to the managed catalogue.
alter table booking.services
  add column if not exists service_category_id uuid
  references booking.service_categories(id) on delete set null;

create index if not exists idx_services_service_category_id
  on booking.services (service_category_id);

-- Backfill: promote existing distinct free-text service categories into the
-- catalogue, then link each service to its matching category (case-insensitive).
insert into booking.service_categories (business_id, name)
select distinct s.business_id, trim(s.category)
from booking.services s
where s.category is not null
  and trim(s.category) <> ''
on conflict (business_id, lower(name)) do nothing;

update booking.services s
set service_category_id = sc.id
from booking.service_categories sc
where sc.business_id = s.business_id
  and s.category is not null
  and lower(trim(s.category)) = lower(sc.name)
  and s.service_category_id is null;
