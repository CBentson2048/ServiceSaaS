-- 0043_service_billing_rules.sql
-- Adds per-service-category "Billing & Revenue Rules" for the Sheer Lab station.
-- Each location gets one rule per colour service category (permanent colour,
-- lightener/bleach, semi & toners, special treatments) describing how product
-- usage on that category type is charged: the charging strategy (track only /
-- overage / charge all), the included gram allowance, and the salon markup.
-- A companion settings row holds the location-level global parameters that power
-- the live billing preview. Defaults are seeded lazily by the API on first read
-- (and restorable via the "Restore Defaults" action), so this migration only
-- defines the structure.

-- 1. Enums --------------------------------------------------------------------

do $$ begin
  create type billing.service_billing_category_enum as enum (
    'permanent_colour',
    'lightener_bleach',
    'semi_toners',
    'special_treatments'
  );
exception when duplicate_object then null; end $$;

do $$ begin
  create type billing.charging_strategy_enum as enum (
    'track_only',
    'overage',
    'charge_all'
  );
exception when duplicate_object then null; end $$;

-- 2. Per-category rules -------------------------------------------------------

create table if not exists billing.service_billing_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  category billing.service_billing_category_enum not null,
  charging_strategy billing.charging_strategy_enum not null default 'overage',
  standard_allowance_grams numeric(10,2) not null default 0
    check (standard_allowance_grams >= 0),
  salon_markup_percent numeric(7,2) not null default 0
    check (salon_markup_percent >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, category)
);

create index if not exists idx_service_billing_rules_location
  on billing.service_billing_rules (location_id);
create index if not exists idx_service_billing_rules_business
  on billing.service_billing_rules (business_id);

drop trigger if exists service_billing_rules_set_updated_at on billing.service_billing_rules;
create trigger service_billing_rules_set_updated_at
before update on billing.service_billing_rules
for each row execute function public.set_updated_at();

-- 3. Location-level global parameters (one row per location) ------------------

create table if not exists billing.service_billing_settings (
  location_id uuid primary key references core.locations(id) on delete cascade,
  business_id uuid not null references core.businesses(id) on delete cascade,
  sample_usage_grams numeric(10,2) not null default 65
    check (sample_usage_grams >= 0),
  base_cost_per_gram_cents integer not null default 18
    check (base_cost_per_gram_cents >= 0),
  currency_code char(3) not null default 'GBP',
  default_markup_percent numeric(7,2) not null default 200
    check (default_markup_percent >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_service_billing_settings_business
  on billing.service_billing_settings (business_id);

drop trigger if exists service_billing_settings_set_updated_at on billing.service_billing_settings;
create trigger service_billing_settings_set_updated_at
before update on billing.service_billing_settings
for each row execute function public.set_updated_at();

-- 4. Row level security -------------------------------------------------------
-- Mirrors booking.service_categories: owners manage everything for their
-- business; active members may read. The API itself uses the service-role key
-- (bypassing RLS) and enforces the owner/manager gate in the service layer.

alter table billing.service_billing_rules enable row level security;

drop policy if exists service_billing_rules_owner_all on billing.service_billing_rules;
create policy service_billing_rules_owner_all
on billing.service_billing_rules for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists service_billing_rules_member_select on billing.service_billing_rules;
create policy service_billing_rules_member_select
on billing.service_billing_rules for select
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = billing.service_billing_rules.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

alter table billing.service_billing_settings enable row level security;

drop policy if exists service_billing_settings_owner_all on billing.service_billing_settings;
create policy service_billing_settings_owner_all
on billing.service_billing_settings for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists service_billing_settings_member_select on billing.service_billing_settings;
create policy service_billing_settings_member_select
on billing.service_billing_settings for select
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = billing.service_billing_settings.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

grant select, insert, update, delete on billing.service_billing_rules to authenticated, service_role;
grant select, insert, update, delete on billing.service_billing_settings to authenticated, service_role;

comment on table billing.service_billing_rules is
  'Per-location, per-colour-service-category billing rules (charging strategy, gram allowance, salon markup) shown on the Sheer Lab "Billing & Revenue Rules" page.';
comment on table billing.service_billing_settings is
  'Per-location global parameters (sample usage, base cost/g, currency, default markup) backing the Billing & Revenue Rules preview.';
