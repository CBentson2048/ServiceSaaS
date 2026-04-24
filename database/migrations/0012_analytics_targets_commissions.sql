-- 0012_analytics_targets_commissions.sql

create type analytics.commission_metric_enum as enum (
  'service',
  'retail',
  'combined'
);

create type analytics.commission_run_status_enum as enum (
  'pending',
  'running',
  'completed',
  'failed',
  'cancelled'
);

create table analytics.commission_plans (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete cascade,
  name text not null,
  base_multiplier numeric(6,2) not null default 3.00,
  retail_target_percentage numeric(6,2) not null default 10.00,
  progressive_base_rate_enabled boolean not null default true,
  active_from date not null,
  active_to date,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (active_to is null or active_to >= active_from)
);

comment on table analytics.commission_plans is
  'Config layer for the commission engine. Default target formula is hourly_rate * 3 * rota_hours, with retail target at 10% of service target.';

create table analytics.commission_tiers (
  id uuid primary key default extensions.gen_random_uuid(),
  plan_id uuid not null references analytics.commission_plans(id) on delete cascade,
  metric analytics.commission_metric_enum not null,
  threshold_percentage numeric(7,2) not null check (threshold_percentage >= 0),
  base_rate_percentage numeric(7,2) not null default 0 check (base_rate_percentage >= 0),
  progressive_rate_percentage numeric(7,2) not null default 0 check (progressive_rate_percentage >= 0),
  bonus_amount numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (plan_id, metric, threshold_percentage)
);

create table analytics.stylist_target_snapshots (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  staff_profile_id uuid not null references core.staff_profiles(id) on delete cascade,
  commission_plan_id uuid references analytics.commission_plans(id) on delete set null,
  target_date date not null,
  period_start date not null,
  period_end date not null,
  rota_hours numeric(10,2) not null default 0,
  hourly_rate_amount numeric(12,2) not null default 0,
  service_target_amount numeric(12,2) not null default 0,
  retail_target_amount numeric(12,2) not null default 0,
  kpi_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (staff_profile_id, target_date),
  check (period_end >= period_start)
);

create table analytics.kpi_snapshots (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  staff_profile_id uuid references core.staff_profiles(id) on delete cascade,
  snapshot_date date not null,
  period_start date not null,
  period_end date not null,
  service_revenue_amount numeric(12,2) not null default 0,
  retail_revenue_amount numeric(12,2) not null default 0,
  booked_hours numeric(10,2) not null default 0,
  utilised_hours numeric(10,2) not null default 0,
  completed_visit_count integer not null default 0,
  rebook_count integer not null default 0,
  retail_items_sold integer not null default 0,
  average_ticket_amount numeric(12,2) not null default 0,
  metrics_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);

create table analytics.commission_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  plan_id uuid references analytics.commission_plans(id) on delete set null,
  period_start date not null,
  period_end date not null,
  status analytics.commission_run_status_enum not null default 'pending',
  triggered_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  started_at timestamptz,
  completed_at timestamptz,
  notes text,
  totals_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_end >= period_start)
);

create table analytics.commission_run_lines (
  id uuid primary key default extensions.gen_random_uuid(),
  commission_run_id uuid not null references analytics.commission_runs(id) on delete cascade,
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  staff_profile_id uuid not null references core.staff_profiles(id) on delete cascade,
  service_revenue_amount numeric(12,2) not null default 0,
  retail_revenue_amount numeric(12,2) not null default 0,
  target_attainment_percentage numeric(7,2) not null default 0,
  commission_rate_percentage numeric(7,2) not null default 0,
  progressive_base_amount numeric(12,2) not null default 0,
  commission_amount numeric(12,2) not null default 0,
  summary_json jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (commission_run_id, staff_profile_id)
);

create table analytics.location_daily_metrics (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  metric_date date not null,
  appointment_count integer not null default 0,
  completed_visit_count integer not null default 0,
  cancellation_count integer not null default 0,
  no_show_count integer not null default 0,
  service_revenue_amount numeric(12,2) not null default 0,
  retail_revenue_amount numeric(12,2) not null default 0,
  formula_usage_count integer not null default 0,
  created_at timestamptz not null default now(),
  unique (location_id, metric_date)
);

create table analytics.sheer_lab_metrics (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  metric_date date not null,
  formula_count integer not null default 0,
  duplicated_formula_count integer not null default 0,
  manual_fallback_count integer not null default 0,
  total_weight_grams bigint not null default 0,
  total_estimated_material_cost_amount numeric(12,2) not null default 0,
  created_at timestamptz not null default now(),
  unique (location_id, metric_date)
);

create table analytics.client_retention_metrics (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  metric_month date not null,
  last_visit_at timestamptz,
  previous_visit_at timestamptz,
  visits_last_12_months integer not null default 0,
  lifetime_visit_count integer not null default 0,
  days_since_last_visit integer,
  retention_bucket text,
  created_at timestamptz not null default now(),
  unique (client_profile_id, metric_month)
);
