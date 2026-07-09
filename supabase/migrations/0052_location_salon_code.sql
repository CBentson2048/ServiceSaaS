-- 0052_location_salon_code.sql
-- Wrike #4507280837 — unique, public-facing Salon Code for every salon, location
-- and Solo stylist (a Solo stylist is modelled as a single location, so the code
-- lives on core.locations and covers all three cases identically).
--
-- The existing core.locations.code is only unique PER BUSINESS and is derived
-- from the slug, so it cannot be handed out as a public identifier (two different
-- businesses can both have code 'MAIN'). This adds a separate, GLOBALLY unique,
-- human-friendly, immutable public_code that clients use to find a salon in the
-- Week 9 Salon Suite ("search by Salon Code or name").

-- 1. Generator ------------------------------------------------------------------
-- Six characters from a Crockford-style alphabet with the ambiguous glyphs
-- (I, L, O, U, 0, 1) removed so codes are safe to read aloud and type. 30^6 ≈
-- 729M combinations; the function retries on the (astronomically rare) collision
-- and the unique index below is the real guarantee.
create or replace function core.generate_location_public_code()
returns text
language plpgsql
volatile
as $$
declare
  alphabet constant text := 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  -- Prefixed to avoid ambiguity with core.locations.code (an existing column).
  v_code text;
  i int;
begin
  loop
    v_code := '';
    for i in 1..6 loop
      v_code := v_code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;
    exit when not exists (select 1 from core.locations where public_code = v_code);
  end loop;
  return v_code;
end;
$$;

comment on function core.generate_location_public_code is
  'Generates a globally-unique, human-friendly 6-char Salon Code (unambiguous alphabet) for core.locations.public_code.';

-- 2. Column ---------------------------------------------------------------------
alter table core.locations
  add column if not exists public_code text;

-- 3. Backfill existing locations (row-by-row so each gets a distinct code and the
--    generator sees codes assigned earlier in the same loop).
do $$
declare
  r record;
begin
  for r in select id from core.locations where public_code is null loop
    update core.locations
      set public_code = core.generate_location_public_code()
      where id = r.id;
  end loop;
end
$$;

-- 4. Lock it in: not null, default for new rows, globally unique.
alter table core.locations
  alter column public_code set not null,
  alter column public_code set default core.generate_location_public_code();

create unique index if not exists locations_public_code_key
  on core.locations (public_code);

comment on column core.locations.public_code is
  'Globally-unique, public-facing Salon Code. Stable/immutable once issued; used by clients to find the salon/location (Week 9 Salon Suite). Distinct from core.locations.code (internal, per-business).';

-- 5. Immutability: once issued a Salon Code never changes, so it stays a reliable
--    reference in links, QR codes and client memory.
create or replace function core.prevent_location_public_code_change()
returns trigger
language plpgsql
as $$
begin
  if OLD.public_code is not null and NEW.public_code is distinct from OLD.public_code then
    raise exception 'location public_code is immutable once issued (location %)', OLD.id
      using errcode = 'check_violation';
  end if;
  return NEW;
end;
$$;

drop trigger if exists locations_public_code_immutable on core.locations;
create trigger locations_public_code_immutable
  before update on core.locations
  for each row
  execute function core.prevent_location_public_code_change();
