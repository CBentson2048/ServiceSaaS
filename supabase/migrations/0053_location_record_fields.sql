-- 0053_location_record_fields.sql
-- Wrike #4507280748 — salon/location record fields that every later report, P&L
-- and policy check reads from. Must work identically for 1 location or 60.
--
-- Two parts:
--   1. Extend core.location_settings with operating/reporting/policy fields
--      (opening hours, chair capacity, thresholds, Sunday Night Report config).
--      Every column is NOT NULL with a safe default so existing rows backfill.
--   2. New effective-dated billing.location_fixed_costs so a mid-year change to
--      rent/rates/utilities/insurance does not distort past P&L (Week 7 reads it).

-- =============================================================================
-- 1. core.location_settings — new record fields
-- =============================================================================

-- Standard trading week: Mon–Sat 09:00–18:00, Sunday closed. weekday: 0=Sun..6=Sat.
-- Built via jsonb_build_array so the default expression carries no embedded double
-- quotes (keeps tooling that transports this SQL simple).
alter table core.location_settings
  add column if not exists opening_hours jsonb not null default jsonb_build_array(
    jsonb_build_object('weekday', 0, 'isOpen', false, 'opensAt', '09:00', 'closesAt', '18:00'),
    jsonb_build_object('weekday', 1, 'isOpen', true,  'opensAt', '09:00', 'closesAt', '18:00'),
    jsonb_build_object('weekday', 2, 'isOpen', true,  'opensAt', '09:00', 'closesAt', '18:00'),
    jsonb_build_object('weekday', 3, 'isOpen', true,  'opensAt', '09:00', 'closesAt', '18:00'),
    jsonb_build_object('weekday', 4, 'isOpen', true,  'opensAt', '09:00', 'closesAt', '20:00'),
    jsonb_build_object('weekday', 5, 'isOpen', true,  'opensAt', '09:00', 'closesAt', '18:00'),
    jsonb_build_object('weekday', 6, 'isOpen', true,  'opensAt', '09:00', 'closesAt', '17:00')
  );

alter table core.location_settings
  add column if not exists chair_count integer not null default 1
    check (chair_count >= 0);

-- Policy thresholds -----------------------------------------------------------
alter table core.location_settings
  add column if not exists discount_authorisation_threshold_percent numeric(5,2) not null default 20
    check (discount_authorisation_threshold_percent >= 0 and discount_authorisation_threshold_percent <= 100);

alter table core.location_settings
  add column if not exists cash_variance_threshold_amount numeric(12,2) not null default 5
    check (cash_variance_threshold_amount >= 0);

-- Reporting targets / warning thresholds -------------------------------------
alter table core.location_settings
  add column if not exists colour_margin_target_percent numeric(5,2) not null default 65
    check (colour_margin_target_percent >= 0 and colour_margin_target_percent <= 100);

alter table core.location_settings
  add column if not exists waste_allowance_percent numeric(5,2) not null default 10
    check (waste_allowance_percent >= 0 and waste_allowance_percent <= 100);

alter table core.location_settings
  add column if not exists rebook_rate_benchmark_percent numeric(5,2) not null default 50
    check (rebook_rate_benchmark_percent >= 0 and rebook_rate_benchmark_percent <= 100);

alter table core.location_settings
  add column if not exists utilisation_warning_threshold_percent numeric(5,2) not null default 60
    check (utilisation_warning_threshold_percent >= 0 and utilisation_warning_threshold_percent <= 100);

-- Payroll cost as a % of revenue: warning (amber) then critical (red).
alter table core.location_settings
  add column if not exists payroll_warning_percent numeric(5,2) not null default 45
    check (payroll_warning_percent >= 0 and payroll_warning_percent <= 100);

alter table core.location_settings
  add column if not exists payroll_critical_percent numeric(5,2) not null default 55
    check (payroll_critical_percent >= 0 and payroll_critical_percent <= 100);

-- Sunday Night Report ---------------------------------------------------------
alter table core.location_settings
  add column if not exists sunday_report_enabled boolean not null default true;

-- List of recipient email strings, e.g. ["owner@salon.com"].
alter table core.location_settings
  add column if not exists sunday_report_recipients jsonb not null default '[]'::jsonb;

alter table core.location_settings
  add column if not exists sunday_report_send_hour smallint not null default 18
    check (sunday_report_send_hour >= 0 and sunday_report_send_hour <= 23);

comment on column core.location_settings.opening_hours is
  'Weekly trading hours [{weekday 0=Sun..6=Sat, isOpen, opensAt "HH:MM", closesAt "HH:MM"}]. Read by reporting/utilisation.';
comment on column core.location_settings.chair_count is
  'Number of working chairs/stations. Denominator for utilisation reporting.';

-- Backfill: guarantee every location has a settings row so all downstream reads
-- resolve real values (additional locations created via the API historically did
-- not seed settings). New columns pick up their defaults automatically.
insert into core.location_settings (business_id, location_id, currency_code)
select l.business_id, l.id, coalesce(nullif(b.default_currency_code, ''), 'GBP')
from core.locations l
join core.businesses b on b.id = l.business_id
where not exists (
  select 1 from core.location_settings s where s.location_id = l.id
);

-- =============================================================================
-- 2. billing.location_fixed_costs — effective-dated fixed costs
-- =============================================================================

do $$
begin
  create type billing.fixed_cost_category_enum as enum
    ('rent', 'rates', 'utilities', 'insurance', 'software', 'marketing', 'equipment', 'other');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type billing.fixed_cost_cadence_enum as enum
    ('weekly', 'monthly', 'quarterly', 'annual');
exception
  when duplicate_object then null;
end
$$;

create table if not exists billing.location_fixed_costs (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  category billing.fixed_cost_category_enum not null,
  label text,
  amount numeric(12,2) not null check (amount >= 0),
  cadence billing.fixed_cost_cadence_enum not null default 'monthly',
  -- Effective window: a cost applies on date d when
  --   effective_from <= d and (effective_to is null or d < effective_to)
  -- effective_to is the EXCLUSIVE end (the day the cost stops / is superseded);
  -- null means still in force. This versioning keeps historical P&L accurate.
  effective_from date not null,
  effective_to date,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint location_fixed_costs_effective_range
    check (effective_to is null or effective_to > effective_from)
);

comment on table billing.location_fixed_costs is
  'Effective-dated fixed overheads (rent, rates, utilities, insurance...) per location. Week 7 P&L reads the monthly-equivalent in force for any historical date via billing.location_fixed_costs_monthly().';

create index if not exists idx_location_fixed_costs_location_effective
  on billing.location_fixed_costs (location_id, effective_from desc);
create index if not exists idx_location_fixed_costs_business
  on billing.location_fixed_costs (business_id);

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'billing_location_fixed_costs_set_updated_at'
      and tgrelid = 'billing.location_fixed_costs'::regclass
  ) then
    create trigger billing_location_fixed_costs_set_updated_at
      before update on billing.location_fixed_costs
      for each row execute function public.set_updated_at();
  end if;
end
$$;

-- Monthly-equivalent total of the fixed costs in force on a given date. Cadences
-- are normalized to a month so the P&L can sum a comparable figure. Returns 0
-- when nothing is configured/effective.
create or replace function billing.location_fixed_costs_monthly(
  p_location_id uuid,
  p_on date
)
returns numeric
language sql
stable
as $$
  select coalesce(sum(
    case cadence
      when 'weekly'    then amount * 52.0 / 12.0
      when 'monthly'   then amount
      when 'quarterly' then amount / 3.0
      when 'annual'    then amount / 12.0
    end
  ), 0)::numeric(12,2)
  from billing.location_fixed_costs
  where location_id = p_location_id
    and effective_from <= p_on
    and (effective_to is null or p_on < effective_to);
$$;

comment on function billing.location_fixed_costs_monthly is
  'Monthly-equivalent total of location fixed costs effective on p_on (weekly*52/12, quarterly/3, annual/12). Used by Week 7 P&L.';

-- RLS: mirror billing.billing_rules — owner full access, manager scoped access.
alter table billing.location_fixed_costs enable row level security;

create policy billing_location_fixed_costs_owner_all
  on billing.location_fixed_costs
  for all
  using (public.is_business_owner(business_id))
  with check (public.is_business_owner(business_id));

create policy billing_location_fixed_costs_manager_all
  on billing.location_fixed_costs
  for all
  using (public.has_location_management_scope(business_id, location_id))
  with check (public.has_location_management_scope(business_id, location_id));

grant execute on function billing.location_fixed_costs_monthly(uuid, date) to service_role, authenticated;
