-- 0065_widen_salon_code_to_8.sql
-- Luke Ormsby feedback: the Salon Code (the per-location public code shown on the
-- salon/location cards) should be an 8-character alphanumeric value, matching the
-- provider Q Code format (widened to 8 in 0056). Widen the generator from 6 -> 8
-- characters and re-issue every existing Salon Code so all codes are uniformly
-- 8 chars. No Salon Codes have been distributed publicly yet (pre-launch), so the
-- immutability guarantee only needs to hold from here on.

-- =============================================================================
-- 1. Generator -> 8 characters.
--    Same Crockford-style alphabet with the ambiguous glyphs (I, L, O, U, 0, 1)
--    removed so codes stay safe to read aloud and type. 30^8 ~= 656B combinations;
--    the function retries on the (astronomically rare) collision and the existing
--    unique index (locations_public_code_key) remains the real guarantee.
-- =============================================================================
create or replace function core.generate_location_public_code()
returns text
language plpgsql
volatile
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  v_code text;
  i int;
begin
  loop
    v_code := '';
    for i in 1..8 loop
      v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from core.locations where public_code = v_code);
  end loop;
  return v_code;
end;
$$;

comment on function core.generate_location_public_code is
  'Generates a globally-unique, human-friendly 8-char Salon Code (unambiguous alphabet) for core.locations.public_code.';

-- The column default calls the function above, so new rows now receive 8-char
-- codes automatically. Re-assert it here for clarity (no-op if unchanged).
alter table core.locations
  alter column public_code set default core.generate_location_public_code();

-- =============================================================================
-- 2. Re-issue existing Salon Codes to the new 8-char format. The immutability
--    trigger blocks public_code changes, so drop it for the backfill and
--    recreate it afterwards (same approach as the Q Code widening in 0056).
--    Row-by-row so each new code is unique against codes assigned earlier in the
--    same loop.
-- =============================================================================
drop trigger if exists locations_public_code_immutable on core.locations;

do $$
declare
  r record;
begin
  for r in select id from core.locations loop
    update core.locations
      set public_code = core.generate_location_public_code()
      where id = r.id;
  end loop;
end
$$;

create trigger locations_public_code_immutable
  before update on core.locations
  for each row
  execute function core.prevent_location_public_code_change();
