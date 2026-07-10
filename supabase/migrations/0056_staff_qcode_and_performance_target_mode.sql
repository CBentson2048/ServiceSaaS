-- 0056_staff_qcode_and_performance_target_mode.sql
-- Wrike #4507280825 — Luke Ormsby review feedback on the staff record fields:
--   1. "the qcode needs to be 8 digit alfa numerical code" — widen the provider
--      Q Code from 'Q' + 5 chars (6 total) to an 8-character alphanumeric code.
--   2. "performance target [needs] option to either flat performance target or
--      pro-rated (if team member works one day less/more one week the target
--      changes automatically)" — record whether the stored performance target is
--      a flat figure or a pro-rated basis that the Week 3 pay engine scales by the
--      days actually worked.

-- =============================================================================
-- 1. Q Code — 8-character alphanumeric.
--    Keep the leading 'Q' (Q Code branding; still alphanumeric) followed by 7
--    unambiguous chars = 8 characters total. Regenerate existing codes so every
--    provider ends up on the new format (no codes have been handed out yet, so
--    the immutability guarantee only needs to hold from here on).
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
    for i in 1..7 loop
      v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from core.staff_profiles where q_code = v_code);
  end loop;
  return v_code;
end;
$$;

comment on function core.generate_staff_q_code is
  'Generates a globally-unique, human-friendly 8-char provider Q Code (Q + 7 unambiguous chars) for core.staff_profiles.q_code.';

-- Re-issue existing codes to the new 8-char format. The immutability trigger
-- blocks q_code changes, so drop it for the backfill and recreate it after.
drop trigger if exists staff_profiles_q_code_immutable on core.staff_profiles;

do $$
declare
  r record;
begin
  for r in select id from core.staff_profiles loop
    update core.staff_profiles
      set q_code = core.generate_staff_q_code()
      where id = r.id;
  end loop;
end
$$;

create trigger staff_profiles_q_code_immutable
  before update on core.staff_profiles
  for each row
  execute function core.prevent_staff_q_code_change();

-- =============================================================================
-- 2. Performance target mode — flat vs pro-rated.
--    'flat'      = performance_target_amount is used exactly as entered.
--    'pro_rated' = performance_target_amount is the full-week basis; the pay
--                  engine scales it by days worked / standard days that week, so
--                  working one day less/more automatically moves the target.
-- =============================================================================

do $$
begin
  create type core.staff_performance_target_mode_enum as enum ('flat', 'pro_rated');
exception
  when duplicate_object then null;
end
$$;

alter table core.staff_profiles
  add column if not exists performance_target_mode core.staff_performance_target_mode_enum
    not null default 'flat';

comment on column core.staff_profiles.performance_target_mode is
  'How performance_target_amount is applied: flat (as entered) or pro_rated (scaled by days worked that week by the pay engine).';
