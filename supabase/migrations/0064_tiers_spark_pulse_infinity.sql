-- 0064_tiers_spark_pulse_infinity.sql
--
-- Collapses the account tier model to Luke's final 3 public tiers, chosen at
-- sign-up (Wrike 4507280724, 2026-07-17). Replaces the old 4-value enum
-- (solo/studio/salon/group) entirely.
--
--   spark    — independent professional. 1 location, 1 bookable column (hard cap).
--   pulse    — single-location salon. 1 location, 5 included bookable columns.
--   infinity — multi-location / enterprise. Unlimited locations, 10 included
--              bookable columns per location.
--
-- Tiers are sliced by BOOKABLE COLUMNS (bookable service providers); non-bookable
-- staff never count. Extra columns on Pulse/Infinity are billable (separate
-- ticket), not blocked. Tiers NEVER gate inventory or colour tracking.
--
-- Existing-account mapping (nobody loses access — everyone lands on a tier that
-- covers current usage):
--   solo   -> spark      studio -> pulse
--   salon  -> infinity   group  -> infinity
--
-- Postgres cannot drop enum values in place, so we swap the type: rename the old
-- one aside, create the new one, retype + remap the column, rebind the onboarding
-- bootstrap function (its local var is typed to the enum), then drop the old type.

-- 1. Move the old enum aside ------------------------------------------------
alter type core.business_tier_enum rename to business_tier_enum_old;

-- 2. Create the new 3-value enum -------------------------------------------
create type core.business_tier_enum as enum ('spark', 'pulse', 'infinity');

-- 3. Retype + remap the column ---------------------------------------------
alter table core.businesses alter column tier drop default;

alter table core.businesses
  alter column tier type core.business_tier_enum
  using (
    case tier::text
      when 'solo'   then 'spark'
      when 'studio' then 'pulse'
      when 'salon'  then 'infinity'
      when 'group'  then 'infinity'
      else 'spark'
    end
  )::core.business_tier_enum;

alter table core.businesses alter column tier set default 'spark';

comment on column core.businesses.tier is
  'Account product tier (spark/pulse/infinity). Drives feature limits (locations + included bookable columns) and upgrade prompts. Never gates inventory/colour tracking.';

-- 4. Rebind the onboarding bootstrap to the new type ------------------------
-- Body is identical to 0051 except the tier default/fallback is now 'spark'.
drop function if exists core.bootstrap_owner_business(
  uuid, text, text, text,
  text, text, text, text, text,
  text, text, text, text, text, text,
  text, text, text, text, text, text,
  text
);

create or replace function core.bootstrap_owner_business(
  p_user_id uuid,
  p_email text,
  p_full_name text,
  p_phone text,
  p_business_name text,
  p_business_slug text,
  p_business_currency text,
  p_business_country text,
  p_business_timezone text,
  p_location_name text,
  p_location_slug text,
  p_location_code text,
  p_location_phone text,
  p_location_email text,
  p_location_timezone text,
  p_location_address_line_1 text,
  p_location_address_line_2 text,
  p_location_city text,
  p_location_region text,
  p_location_postal_code text,
  p_location_country text,
  p_business_tier text default 'spark'
)
returns table (
  user_profile_id uuid,
  business_id uuid,
  location_id uuid,
  membership_id uuid
)
language plpgsql
security definer
set search_path = public, core, billing, extensions
as $$
declare
  v_business_id uuid;
  v_location_id uuid;
  v_membership_id uuid;
  v_country text := upper(coalesce(nullif(p_business_country, ''), 'GB'));
  v_currency text := upper(coalesce(nullif(p_business_currency, ''), 'GBP'));
  v_business_tz text := coalesce(nullif(p_business_timezone, ''), 'Europe/London');
  v_location_tz text := coalesce(nullif(p_location_timezone, ''), v_business_tz);
  v_location_country text := upper(coalesce(nullif(p_location_country, ''), v_country));
  v_tier core.business_tier_enum;
begin
  -- Validate the tier defensively; fall back to spark on anything unexpected.
  begin
    v_tier := coalesce(nullif(p_business_tier, ''), 'spark')::core.business_tier_enum;
  exception
    when invalid_text_representation then
      v_tier := 'spark';
  end;

  -- Owner profile (1:1 with auth.users; row may already exist if the API
  -- pre-created it, so upsert defensively).
  insert into core.user_profiles (id, email, full_name, phone)
  values (
    p_user_id,
    lower(p_email),
    p_full_name,
    nullif(p_phone, '')
  )
  on conflict (id) do update
    set email = excluded.email,
        full_name = excluded.full_name,
        phone = coalesce(excluded.phone, core.user_profiles.phone),
        updated_at = now();

  -- Business
  insert into core.businesses (
    name,
    slug,
    default_currency_code,
    default_country_code,
    timezone,
    status,
    tier
  ) values (
    p_business_name,
    lower(p_business_slug),
    v_currency,
    v_country,
    v_business_tz,
    'trial',
    v_tier
  )
  returning id into v_business_id;

  -- First location. Address fields are required NOT NULL in the schema
  -- but the onboarding flow keeps them optional, so default to '' here
  -- and let owners refine the address later from settings.
  insert into core.locations (
    business_id,
    code,
    name,
    slug,
    address_line_1,
    address_line_2,
    city,
    region,
    postal_code,
    country_code,
    timezone,
    phone,
    email,
    is_active,
    sort_order
  ) values (
    v_business_id,
    coalesce(nullif(p_location_code, ''), upper(left(p_location_slug, 12))),
    p_location_name,
    lower(p_location_slug),
    coalesce(nullif(p_location_address_line_1, ''), ''),
    nullif(p_location_address_line_2, ''),
    coalesce(nullif(p_location_city, ''), ''),
    nullif(p_location_region, ''),
    coalesce(nullif(p_location_postal_code, ''), ''),
    v_location_country,
    v_location_tz,
    nullif(p_location_phone, ''),
    nullif(p_location_email, ''),
    true,
    0
  )
  returning id into v_location_id;

  -- Owner membership: business-wide, location_id null per the schema check
  -- constraint on core.user_memberships.
  insert into core.user_memberships (
    business_id,
    location_id,
    user_profile_id,
    role,
    status,
    activated_at
  ) values (
    v_business_id,
    null,
    p_user_id,
    'owner',
    'active',
    now()
  )
  returning id into v_membership_id;

  -- Default location settings for the first location.
  insert into core.location_settings (
    business_id,
    location_id,
    currency_code
  ) values (
    v_business_id,
    v_location_id,
    v_currency
  );

  -- Default billing rules. The 'cost_plus_markup_percent' mode requires a
  -- non-null markup, so seed it at 0 and let the owner tune it later.
  insert into billing.billing_rules (
    business_id,
    location_id,
    formula_billing_mode,
    formula_markup_percent
  ) values (
    v_business_id,
    v_location_id,
    'cost_plus_markup_percent',
    0
  );

  return query
  select p_user_id, v_business_id, v_location_id, v_membership_id;
end;
$$;

comment on function core.bootstrap_owner_business is
  'Atomic bootstrap for a brand-new owner: profile + business (with account tier) + first location + owner membership + default location/billing settings. Called by the API after the auth user has been created.';

revoke all on function core.bootstrap_owner_business(
  uuid, text, text, text,
  text, text, text, text, text,
  text, text, text, text, text, text,
  text, text, text, text, text, text,
  text
) from public;

grant execute on function core.bootstrap_owner_business(
  uuid, text, text, text,
  text, text, text, text, text,
  text, text, text, text, text, text,
  text, text, text, text, text, text,
  text
) to service_role;

-- 5. Drop the old enum (now unreferenced) ----------------------------------
drop type core.business_tier_enum_old;
