-- 0054_staff_record_fields.sql
-- Wrike #4507280825 — staff/provider record fields the commission engine, wage
-- calculations, KPIs and P&L depend on. Existing staff migrate with safe
-- defaults so current role flows keep working.
--
-- Everything lives on core.staff_profiles (the per-stylist/provider record that
-- already holds hourly_rate, contracted_hours, employment_status, hire_date...).
-- Reused existing columns:
--   hire_date          -> "Start Date"
--   employment_status  -> "Status" (active/on_leave/notice/terminated)
--   hourly_rate, contracted_hours, average_bill_benchmark  -> pay/KPI inputs

-- =============================================================================
-- 1. Enums
-- =============================================================================

do $$
begin
  create type core.staff_employment_type_enum as enum ('employed', 'self_employed', 'hybrid');
exception
  when duplicate_object then null;
end
$$;

do $$
begin
  create type core.staff_commission_structure_enum as enum ('tiered', 'flat', 'none');
exception
  when duplicate_object then null;
end
$$;

-- =============================================================================
-- 2. New record columns (all NOT NULL columns carry a default so existing rows
--    migrate cleanly; performance_target_amount + photo_url stay nullable).
-- =============================================================================

alter table core.staff_profiles
  add column if not exists employment_type core.staff_employment_type_enum not null default 'employed';

-- 'tiered' = the existing V1 KPI commission engine; 'flat' uses the percent
-- below; 'none' disables commission for this member.
alter table core.staff_profiles
  add column if not exists commission_structure core.staff_commission_structure_enum not null default 'tiered';

alter table core.staff_profiles
  add column if not exists commission_flat_rate_percent numeric(5,2) not null default 0
    check (commission_flat_rate_percent >= 0 and commission_flat_rate_percent <= 100);

-- Optional owner-set performance target (major currency units). When null the
-- computed target (hourly_rate x multiplier x hours) is used.
alter table core.staff_profiles
  add column if not exists performance_target_amount numeric(12,2)
    check (performance_target_amount is null or performance_target_amount >= 0);

-- Annual paid-holiday entitlement in days (UK statutory default 28).
alter table core.staff_profiles
  add column if not exists holiday_entitlement_days numeric(5,1) not null default 28
    check (holiday_entitlement_days >= 0 and holiday_entitlement_days <= 366);

-- Periodic colour/product allowance granted to the provider (major currency units).
alter table core.staff_profiles
  add column if not exists colour_allowance_amount numeric(12,2) not null default 0
    check (colour_allowance_amount >= 0);

-- Provider photo. Created here once; reused by the Team Module and the
-- client-facing Salon Suite later. Distinct from core.user_profiles.avatar_url
-- (the member's personal account avatar).
alter table core.staff_profiles
  add column if not exists photo_url text;

comment on column core.staff_profiles.employment_type is
  'Employment basis: employed / self_employed / hybrid. Drives wage & commission handling.';
comment on column core.staff_profiles.commission_structure is
  'Commission model: tiered (V1 KPI engine), flat (commission_flat_rate_percent) or none.';
comment on column core.staff_profiles.performance_target_amount is
  'Optional owner-set performance target (major currency). Null = use computed target.';
comment on column core.staff_profiles.photo_url is
  'Provider profile photo (internal + client-facing Salon Suite). Distinct from user_profiles.avatar_url.';

-- =============================================================================
-- 3. Q Code — globally-unique, human-friendly, immutable provider identifier.
--    Mirrors the location Salon Code pattern (0052): generator + backfill +
--    unique index + immutability trigger. Format: 'Q' + 5 unambiguous chars.
-- =============================================================================

create or replace function core.generate_staff_q_code()
returns text
language plpgsql
volatile
as $$
declare
  -- Crockford-style alphabet with ambiguous glyphs (I, L, O, U, 0, 1) removed.
  alphabet constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  v_code text;
  i int;
begin
  loop
    v_code := 'Q';
    for i in 1..5 loop
      v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from core.staff_profiles where q_code = v_code);
  end loop;
  return v_code;
end;
$$;

comment on function core.generate_staff_q_code is
  'Generates a globally-unique, human-friendly provider Q Code (Q + 5 unambiguous chars) for core.staff_profiles.q_code.';

alter table core.staff_profiles
  add column if not exists q_code text;

-- Backfill row-by-row so each existing profile gets a distinct code and the
-- generator sees codes assigned earlier in the same loop.
do $$
declare
  r record;
begin
  for r in select id from core.staff_profiles where q_code is null loop
    update core.staff_profiles
      set q_code = core.generate_staff_q_code()
      where id = r.id;
  end loop;
end
$$;

alter table core.staff_profiles
  alter column q_code set not null,
  alter column q_code set default core.generate_staff_q_code();

create unique index if not exists staff_profiles_q_code_key
  on core.staff_profiles (q_code);

comment on column core.staff_profiles.q_code is
  'Globally-unique, immutable provider Q Code. Used internally and by the client-facing Salon Suite.';

create or replace function core.prevent_staff_q_code_change()
returns trigger
language plpgsql
as $$
begin
  if OLD.q_code is not null and NEW.q_code is distinct from OLD.q_code then
    raise exception 'staff q_code is immutable once issued (staff %)', OLD.id
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

drop trigger if exists staff_profiles_q_code_immutable on core.staff_profiles;
create trigger staff_profiles_q_code_immutable
  before update on core.staff_profiles
  for each row
  execute function core.prevent_staff_q_code_change();
