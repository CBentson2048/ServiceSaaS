-- 0030_tax_configuration.sql
-- Completes the pre-existing billing.tax_settings table (introduced in 0006) so
-- it can back the configurable, location-aware Tax Configuration feature.
--
-- The model stays jurisdiction-neutral and is NOT hardcoded to UK VAT: the label,
-- rate, what the tax applies to, and how amounts are displayed are all configurable
-- per location. The application manages a single "primary" tax configuration per
-- (business, location) keyed by tax_code = 'primary' and a fixed sentinel
-- effective_from, which the existing
--   unique nulls not distinct (business_id, location_id, tax_code, effective_from)
-- constraint reduces to "one primary config per location" — giving a clean upsert
-- target. The effective-dating / multi-code columns remain available for future
-- multi-jurisdiction support without blocking the current simple model.

-- 1. Enums capturing the approved business rules ("applies to" + "display mode").
do $$ begin
  create type billing.tax_applies_to_enum as enum ('services', 'retail', 'both');
exception when duplicate_object then null; end $$;

do $$ begin
  create type billing.tax_display_mode_enum as enum ('inc_tax', 'ex_tax', 'both');
exception when duplicate_object then null; end $$;

-- 2. New columns on billing.tax_settings.
--    applies_to  — services only / retail only / both
--    display_mode — inc-tax / ex-tax / both
alter table billing.tax_settings
  add column if not exists applies_to billing.tax_applies_to_enum not null default 'both',
  add column if not exists display_mode billing.tax_display_mode_enum not null default 'ex_tax';

comment on column billing.tax_settings.applies_to is
  'Which sales the tax applies to: services only, retail only, or both. Jurisdiction-neutral.';
comment on column billing.tax_settings.display_mode is
  'How taxed amounts are presented to users: tax-inclusive, tax-exclusive, or both. '
  'is_price_inclusive is kept in sync (true when display_mode = inc_tax) for backward compatibility.';

-- 3. tax_name (the configurable label) may be empty while a location has tax disabled.
--    The application enforces a non-empty label when tax is enabled.
alter table billing.tax_settings
  alter column tax_name drop not null;

comment on column billing.tax_settings.tax_name is
  'Configurable tax label (e.g. "VAT", "GST", "Sales Tax"). Required by the application when is_active = true.';
comment on column billing.tax_settings.rate_percentage is
  'Tax rate as a percentage (e.g. 20 = 20%). Constrained to >= 0 at the database level.';
comment on column billing.tax_settings.is_active is
  'Tax on/off toggle for this configuration.';
