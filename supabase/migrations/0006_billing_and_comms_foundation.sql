-- 0006_billing_and_comms_foundation.sql

create type comms.channel_enum as enum (
  'sms',
  'email',
  'push',
  'whatsapp'
);

create type comms.notification_status_enum as enum (
  'queued',
  'sent',
  'delivered',
  'failed',
  'cancelled'
);

create type billing.formula_billing_mode_enum as enum (
  'cost_plus_markup_percent',
  'cost_only',
  'fixed_uplift'
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
  applies_to_deposits boolean not null default true,
  effective_from date not null,
  effective_to date,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (business_id, location_id, tax_code, effective_from),
  check (effective_to is null or effective_to >= effective_from)
);
create trigger tax_settings_set_updated_at
before update on billing.tax_settings
for each row execute function public.set_updated_at();

comment on table billing.tax_settings is
  'Location-aware tax configuration. The model is jurisdiction-neutral and not hardcoded to UK VAT.';

create table billing.billing_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null unique references core.locations(id) on delete cascade,

  charge_deposit_on_booking boolean not null default true,
  deposit_due_hours_before_appointment integer not null default 0
   check (deposit_due_hours_before_appointment >= 0),
  deposit_refundable_before_hours integer not null default 24
   check (deposit_refundable_before_hours >= 0),
  apply_deposit_to_final_total boolean not null default true,
  allow_manual_charge_override boolean not null default true,

  formula_billing_mode billing.formula_billing_mode_enum not null default 'cost_plus_markup_percent',
  formula_markup_percent numeric(7,2)
   check (formula_markup_percent is null or formula_markup_percent >= 0),
  formula_fixed_uplift_amount numeric(12,2)
   check (formula_fixed_uplift_amount is null or formula_fixed_uplift_amount >= 0),
  auto_bill_formula_on_save boolean not null default true,
  rebill_formula_on_edit boolean not null default true,
  combine_formulas_into_single_charge boolean not null default true,
  formula_inactivity_timeout_minutes integer not null default 30 check
   (formula_inactivity_timeout_minutes > 0),

  cancellation_policy_note text,
  metadata jsonb not null default '{}'::jsonb,
  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint billing_rules_formula_mode_requirements check (
    (formula_billing_mode = 'cost_only')
    or
    (formula_billing_mode = 'cost_plus_markup_percent' and formula_markup_percent is not null)
    or
    (formula_billing_mode = 'fixed_uplift' and formula_fixed_uplift_amount is not null)
  )
);

comment on column billing.billing_rules.formula_billing_mode is 'Controls how formula cost becomes the billed colour charge for a location.';
  
create trigger billing_rules_set_updated_at
before update on billing.billing_rules
for each row execute function public.set_updated_at();

comment on trigger billing_rules_set_updated_at on billing.billing_rules is 'Before update trigger helper for mutable billing rules table.';

create table comms.notification_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  client_profile_id uuid references core.client_profiles(id) on delete set null,
  user_profile_id uuid references core.user_profiles(id) on delete set null,
  appointment_id uuid references booking.appointments(id) on delete set null,
  visit_id uuid references booking.visits(id) on delete set null,
  channel comms.channel_enum not null,
  event_key text not null,
  status comms.notification_status_enum not null default 'queued',
  payload_json jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz,
  sent_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger notification_events_set_updated_at
before update on comms.notification_events
for each row execute function public.set_updated_at();

create table comms.message_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  client_profile_id uuid references core.client_profiles(id) on delete set null,
  user_profile_id uuid references core.user_profiles(id) on delete set null,
  notification_event_id uuid references comms.notification_events(id) on delete set null,
  appointment_id uuid references booking.appointments(id) on delete set null,
  visit_id uuid references booking.visits(id) on delete set null,
  channel comms.channel_enum not null,
  provider text,
  provider_message_id text,
  delivery_status comms.notification_status_enum not null default 'queued',
  content_preview text,
  error_message text,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
