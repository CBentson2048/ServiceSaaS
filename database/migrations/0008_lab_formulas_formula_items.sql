-- 0008_lab_formulas_formula_items.sql

create type lab.device_pairing_status_enum as enum (
  'active',
  'revoked',
  'lost'
);

create type lab.formula_status_enum as enum (
  'draft',
  'finalized',
  'archived',
  'manual'
);

create type lab.formula_event_type_enum as enum (
  'created',
  'duplicated',
  'edited',
  'finalized',
  'archived',
  'recalculated',
  'manual_override'
);

create table lab.device_pairings (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  device_identifier text not null,
  bluetooth_identifier text,
  device_name text,
  vendor_name text,
  model_name text,
  status lab.device_pairing_status_enum not null default 'active',
  paired_at timestamptz not null default now(),
  unpaired_at timestamptz,
  last_seen_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, device_identifier)
);

create table lab.formulas (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  visit_id uuid references booking.visits(id) on delete set null,
  appointment_id uuid references booking.appointments(id) on delete set null,
  created_by_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  last_edited_by_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  based_on_formula_id uuid references lab.formulas(id) on delete set null,
  status lab.formula_status_enum not null default 'draft',
  formula_name text not null,
  formula_summary text,
  notes text,
  total_weight_grams integer not null default 0 check (total_weight_grams >= 0),
  manual_fallback_used boolean not null default false,
  finalized_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table lab.formulas is
  'Operational formula record tied to visit and client. Cost is stored separately so stylist access can stay conservative by default.';

create table lab.formula_items (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  formula_id uuid not null references lab.formulas(id) on delete cascade,
  product_id uuid,
  sequence_no integer not null check (sequence_no > 0),
  ingredient_name_snapshot text not null,
  weight_grams integer not null check (weight_grams >= 0),
  processing_minutes integer not null default 0 check (processing_minutes >= 0),
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (formula_id, sequence_no)
);

create table lab.formula_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  formula_id uuid not null references lab.formulas(id) on delete cascade,
  actor_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  event_type lab.formula_event_type_enum not null,
  event_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table lab.formula_versions (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  formula_id uuid not null references lab.formulas(id) on delete cascade,
  version_no integer not null check (version_no > 0),
  created_by_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  is_snapshot_of_finalized boolean not null default false,
  snapshot_json jsonb not null,
  created_at timestamptz not null default now(),
  unique (formula_id, version_no)
);

create table lab.formula_costs (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  formula_id uuid not null unique references lab.formulas(id) on delete cascade,
  cost_basis text not null default 'inventory_cost',
  material_cost_amount numeric(12,2) not null default 0,
  billed_amount numeric(12,2) not null default 0,
  margin_amount numeric(12,2) not null default 0,
  last_calculated_at timestamptz,
  calculated_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  details_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
