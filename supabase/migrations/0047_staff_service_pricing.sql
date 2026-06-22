-- 0047_staff_service_pricing.sql
-- Adds per-stylist service pricing. A service has a single base price
-- (booking.services.base_price), but an owner can charge different prices per
-- stylist for the same service (e.g. a senior stylist's haircut costs more than
-- an apprentice's). The price lives on the existing eligibility row since that
-- is already keyed per (staff, service).
--
-- Semantics:
--   * price_amount NULL  -> inherit booking.services.base_price (the default).
--     Existing eligibility rows keep NULL, so there is NO backfill and every
--     stylist keeps charging the service base price until an owner sets one.
--   * price_amount set    -> this stylist charges exactly this amount for the
--     service. Major currency units, matching services.base_price numeric(12,2).

alter table booking.staff_service_eligibility
  add column if not exists price_amount numeric(12,2);

comment on column booking.staff_service_eligibility.price_amount is
  'Per-stylist price for this service in major currency units. NULL inherits booking.services.base_price.';

-- The eligibility-set RPC now carries prices. The previous (uuid[]) signature
-- could only insert ids and used `on conflict do nothing`, which cannot update
-- the price on an already-eligible service. Replace it with a jsonb variant.
drop function if exists booking.set_staff_service_eligibility(uuid, uuid, uuid[]);

-- Atomic full-replacement of a stylist's service eligibility AND prices.
-- p_assignments is a jsonb array of objects:
--   [{"service_id": <uuid>, "price_amount": <numeric|null>}, ...]
-- Delete + upsert run in one function call so a caller never observes a partial
-- set. The API validates that the service ids belong to the business before
-- calling this; the function itself only touches rows for the (business, staff)
-- pair.
create or replace function booking.set_staff_service_eligibility(
  p_business_id uuid,
  p_staff_profile_id uuid,
  p_assignments jsonb
) returns void
language plpgsql
as $$
begin
  delete from booking.staff_service_eligibility e
   where e.business_id = p_business_id
     and e.staff_profile_id = p_staff_profile_id
     and (p_assignments is null
          or not exists (
            select 1
              from jsonb_to_recordset(p_assignments)
                as a(service_id uuid, price_amount numeric)
             where a.service_id = e.service_id));

  if p_assignments is not null and jsonb_array_length(p_assignments) > 0 then
    insert into booking.staff_service_eligibility (business_id, service_id, staff_profile_id, price_amount)
    select p_business_id, a.service_id, p_staff_profile_id, a.price_amount
      from jsonb_to_recordset(p_assignments)
        as a(service_id uuid, price_amount numeric)
    on conflict (service_id, staff_profile_id)
    do update set price_amount = excluded.price_amount, updated_at = now();
  end if;
end;
$$;

grant execute on function booking.set_staff_service_eligibility(uuid, uuid, jsonb)
  to authenticated, service_role;
