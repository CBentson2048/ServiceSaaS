-- 0010_billing_tax_rules_charges_payments.sql

create type billing.charge_type_enum as enum (
  'service',
  'formula',
  'product',
  'deposit',
  'discount',
  'tax',
  'fee',
  'adjustment'
);

create type billing.payment_category_enum as enum (
  'deposit',
  'visit_balance',
  'retail_sale',
  'other'
);

create type billing.payment_status_enum as enum (
  'pending',
  'authorized',
  'paid',
  'failed',
  'refunded',
  'cancelled'
);

create type billing.payment_method_enum as enum (
  'cash',
  'card_terminal',
  'stripe',
  'bank_transfer',
  'gift_card',
  'other'
);

create type billing.refund_status_enum as enum (
  'pending',
  'succeeded',
  'failed',
  'cancelled'
);

create table billing.tax_settings (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete cascade,
  tax_name text not null,
  tax_code text not null,
  jurisdiction_code text,
  rate_percentage numeric(7,4) not null check (rate_percentage >= 0),
  is_price_inclusive boolean not null default false,
  applies_to_services boolean not null default true,
  applies_to_products boolean not null default true,
  applies_to_deposits boolean not null default true,
  effective_from date not null,
  effective_to date,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (effective_to is null or effective_to >= effective_from),
  unique nulls not distinct (business_id, location_id, tax_code, effective_from)
);

comment on table billing.tax_settings is
  'Tax configuration is location-aware and jurisdiction-neutral; nothing here assumes UK VAT only.';

create table billing.billing_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null unique references core.locations(id) on delete cascade,
  charge_formula_by_default boolean not null default true,
  formula_markup_type text not null default 'fixed_amount',
  formula_markup_value numeric(12,2) not null default 0,
  deduct_inventory_on_visit_completion boolean not null default true,
  allow_manual_charge_override boolean not null default true,
  apply_deposit_to_final_total boolean not null default true,
  round_to_minor_unit boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table billing.visit_charges (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  visit_id uuid not null references booking.visits(id) on delete cascade,
  appointment_id uuid references booking.appointments(id) on delete set null,
  formula_id uuid references lab.formulas(id) on delete set null,
  charge_type billing.charge_type_enum not null,
  source_schema text,
  source_table text,
  source_id uuid,
  description text not null,
  quantity numeric(12,2) not null default 1 check (quantity > 0),
  unit_amount numeric(12,2) not null default 0,
  subtotal_amount numeric(12,2) not null default 0,
  tax_setting_id uuid references billing.tax_settings(id) on delete set null,
  tax_rate_percentage numeric(7,4) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  total_amount numeric(12,2) not null default 0,
  is_client_visible boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table billing.visit_totals (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  visit_id uuid not null unique references booking.visits(id) on delete cascade,
  subtotal_amount numeric(12,2) not null default 0,
  tax_amount numeric(12,2) not null default 0,
  deposit_credit_amount numeric(12,2) not null default 0,
  discount_amount numeric(12,2) not null default 0,
  refund_amount numeric(12,2) not null default 0,
  grand_total_amount numeric(12,2) not null default 0,
  paid_amount numeric(12,2) not null default 0,
  outstanding_amount numeric(12,2) not null default 0,
  last_recalculated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table billing.payments (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  visit_id uuid references booking.visits(id) on delete set null,
  appointment_id uuid references booking.appointments(id) on delete set null,
  client_profile_id uuid references core.client_profiles(id) on delete set null,
  deposit_id uuid references booking.deposits(id) on delete set null,
  payment_category billing.payment_category_enum not null default 'visit_balance',
  payment_method billing.payment_method_enum not null,
  status billing.payment_status_enum not null default 'pending',
  provider text,
  provider_reference text,
  external_checkout_session_id text,
  amount numeric(12,2) not null check (amount >= 0),
  currency_code char(3) not null default 'GBP',
  received_at timestamptz,
  processed_at timestamptz,
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table billing.refunds (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  payment_id uuid not null references billing.payments(id) on delete cascade,
  visit_id uuid references booking.visits(id) on delete set null,
  amount numeric(12,2) not null check (amount >= 0),
  reason text,
  status billing.refund_status_enum not null default 'pending',
  provider_reference text,
  refunded_at timestamptz,
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
