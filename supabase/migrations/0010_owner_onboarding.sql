-- 0010_owner_onboarding.sql
--
-- Adds a transactional helper used by the owner-onboarding endpoint in
-- apps/api. The auth.users row is created by the API service first; once
-- it exists this function performs every downstream insert (profile,
-- business, first location, owner membership, location settings, billing
-- rules) in a single transaction so a partial failure cannot leave an
-- orphaned business behind.
--
-- The function is SECURITY DEFINER and granted only to service_role so
-- the public anon key cannot call it. The API also pre-validates the
-- payload before invoking it.

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
  p_location_country text
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
begin
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
    status
  ) values (
    p_business_name,
    lower(p_business_slug),
    v_currency,
    v_country,
    v_business_tz,
    'trial'
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
  'Atomic bootstrap for a brand-new owner: profile + business + first location + owner membership + default location/billing settings. Called by the API after the auth user has been created.';

revoke all on function core.bootstrap_owner_business(
  uuid, text, text, text,
  text, text, text, text, text,
  text, text, text, text, text, text,
  text, text, text, text, text, text
) from public;

grant execute on function core.bootstrap_owner_business(
  uuid, text, text, text,
  text, text, text, text, text,
  text, text, text, text, text, text,
  text, text, text, text, text, text
) to service_role;
