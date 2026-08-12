-- 0085_bills.sql
-- Week 5 — "Ensure every completed visit has an itemised bill (services,
-- colour charges, retail, deposits, discounts, VAT, total)".
--
-- Until now the platform had NO persisted bill: every read of a visit's bill
-- recomputed it from live prices, live billing rules and the CURRENT tax
-- configuration — so changing the VAT rate silently repriced every historical
-- bill, nothing carried a bill number, and money reports had no immutable
-- source. These tables freeze the bill at the moment payment is confirmed.
--
-- Model:
--   billing.bill_counters — per-business sequence behind human bill numbers.
--   billing.bills         — one immutable header per visit (unique visit_id):
--                           net/tax/gross totals, deposit applied, balance
--                           collected at the till, tax-rate snapshot, status.
--   billing.bill_lines    — the exact itemised lines the till displayed
--                           (per-service, per-colour-product), each with its
--                           own net/tax/gross and tax-rate snapshot.
--   billing.record_bill() — atomic allocate-number + insert header + lines,
--                           idempotent per visit (concurrent calls return the
--                           existing bill).
--
-- Line-type vocabulary matches the checkout ('service', 'product_usage');
-- 'retail', 'deposit_credit' and 'discount' are admitted by the check
-- constraint so those features can land without another migration (retail
-- awaits the capture UI linking sales to visits; discounts await the
-- Week-4-or-7 product decision recorded in the plan).
--
-- Access model: service-role writes only (the API is the gatekeeper);
-- authenticated users read via RLS — owners business-wide, managers/desk
-- roles per location.

create table if not exists billing.bill_counters (
  business_id uuid primary key references core.businesses(id) on delete cascade,
  next_number bigint not null default 1
);

comment on table billing.bill_counters is
  'Per-business monotonic counter behind human-readable bill numbers (0085).';

create table if not exists billing.bills (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  visit_id uuid not null references booking.visits(id) on delete cascade,
  appointment_id uuid references booking.appointments(id) on delete set null,
  client_profile_id uuid references core.client_profiles(id) on delete set null,
  staff_profile_id uuid,
  bill_number bigint not null,
  status text not null default 'paid' check (status in ('paid', 'voided')),
  -- net may go negative on a ledger-reconciled historical bill (an adjustment
  -- line absorbs drift between recomputed figures and the payments ledger).
  net_cents integer not null,
  tax_cents integer not null default 0 check (tax_cents >= 0),
  gross_cents integer not null check (gross_cents >= 0),
  discount_cents integer not null default 0 check (discount_cents >= 0),
  deposit_applied_cents integer not null default 0 check (deposit_applied_cents >= 0),
  balance_collected_cents integer not null default 0 check (balance_collected_cents >= 0),
  currency_code char(3) not null default 'GBP',
  tax_label text,
  tax_rate_percent numeric(7,4) not null default 0,
  occurred_at timestamptz not null,
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (visit_id),
  unique (business_id, bill_number)
);

comment on table billing.bills is
  'Immutable per-visit bill snapshot frozen at payment confirmation (0085). '
  'Totals are the exact figures the till collected; later price/tax changes '
  'never reprice a stored bill.';
comment on column billing.bills.deposit_applied_cents is
  'Deposit credit consumed by this bill — the first explicit deposit-redemption '
  'record on the platform (end-of-day reconciliation reads it).';
comment on column billing.bills.balance_collected_cents is
  'What the till actually collected (gross minus deposit applied).';

create table if not exists billing.bill_lines (
  id uuid primary key default extensions.gen_random_uuid(),
  bill_id uuid not null references billing.bills(id) on delete cascade,
  sequence_no integer not null,
  line_type text not null check (
    line_type in ('service', 'product_usage', 'retail', 'deposit_credit', 'discount', 'adjustment')
  ),
  description text not null,
  staff_profile_id uuid,
  net_cents integer not null,
  tax_cents integer not null default 0,
  gross_cents integer not null,
  tax_rate_percent numeric(7,4) not null default 0,
  source_ref jsonb not null default '{}'::jsonb,
  unique (bill_id, sequence_no)
);

comment on table billing.bill_lines is
  'Itemised lines of a stored bill, exactly as the till displayed them, each '
  'with its own net/tax/gross and tax-rate snapshot (0085).';

-- Finder-shaped indexes (the Week 5 bill-finder ticket filters on exactly
-- these columns; creating them with the table avoids a later rewrite).
create index if not exists idx_billing_bills_biz_loc_occurred
  on billing.bills (business_id, location_id, occurred_at desc);
create index if not exists idx_billing_bills_client
  on billing.bills (business_id, client_profile_id, occurred_at desc);
create index if not exists idx_billing_bills_staff
  on billing.bills (business_id, staff_profile_id, occurred_at desc);
create index if not exists idx_billing_bill_lines_bill
  on billing.bill_lines (bill_id);

alter table billing.bill_counters enable row level security;
alter table billing.bills enable row level security;
alter table billing.bill_lines enable row level security;

drop policy if exists bills_owner_select on billing.bills;
create policy bills_owner_select on billing.bills
  for select using (public.is_business_owner(business_id));

drop policy if exists bills_desk_select on billing.bills;
create policy bills_desk_select on billing.bills
  for select using (public.has_location_desk_access(business_id, location_id));

drop policy if exists bill_lines_parent_select on billing.bill_lines;
create policy bill_lines_parent_select on billing.bill_lines
  for select using (
    exists (
      select 1 from billing.bills b
      where b.id = bill_lines.bill_id
        and (
          public.is_business_owner(b.business_id)
          or public.has_location_desk_access(b.business_id, b.location_id)
        )
    )
  );

grant select on billing.bills, billing.bill_lines to authenticated;
grant all on billing.bill_counters, billing.bills, billing.bill_lines to service_role;

-- Atomic bill recording: allocate the next per-business number, insert the
-- header and its lines. Idempotent per visit — a concurrent or repeated call
-- returns the already-stored bill instead of failing or double-numbering.
create or replace function billing.record_bill(p_bill jsonb, p_lines jsonb)
returns table (id uuid, bill_number bigint, created boolean)
language plpgsql
as $$
declare
  v_business_id uuid := (p_bill->>'business_id')::uuid;
  v_visit_id uuid := (p_bill->>'visit_id')::uuid;
  v_existing billing.bills%rowtype;
  v_number bigint;
  v_id uuid;
begin
  select * into v_existing from billing.bills b where b.visit_id = v_visit_id;
  if found then
    return query select v_existing.id, v_existing.bill_number, false;
    return;
  end if;

  begin
    -- Counter allocation lives INSIDE the guarded block so a lost race on
    -- unique(visit_id) rolls the increment back too — the per-business
    -- sequence stays gapless instead of burning a number per race.
    insert into billing.bill_counters as c (business_id, next_number)
    values (v_business_id, 2)
    on conflict (business_id) do update set next_number = c.next_number + 1
    returning c.next_number - 1 into v_number;

    insert into billing.bills (
      business_id, location_id, visit_id, appointment_id, client_profile_id,
      staff_profile_id, bill_number, status, net_cents, tax_cents, gross_cents,
      discount_cents, deposit_applied_cents, balance_collected_cents,
      currency_code, tax_label, tax_rate_percent, occurred_at,
      created_by_user_profile_id
    ) values (
      v_business_id,
      (p_bill->>'location_id')::uuid,
      v_visit_id,
      (p_bill->>'appointment_id')::uuid,
      (p_bill->>'client_profile_id')::uuid,
      (p_bill->>'staff_profile_id')::uuid,
      v_number,
      coalesce(p_bill->>'status', 'paid'),
      (p_bill->>'net_cents')::integer,
      coalesce((p_bill->>'tax_cents')::integer, 0),
      (p_bill->>'gross_cents')::integer,
      coalesce((p_bill->>'discount_cents')::integer, 0),
      coalesce((p_bill->>'deposit_applied_cents')::integer, 0),
      coalesce((p_bill->>'balance_collected_cents')::integer, 0),
      coalesce(p_bill->>'currency_code', 'GBP'),
      p_bill->>'tax_label',
      coalesce((p_bill->>'tax_rate_percent')::numeric, 0),
      (p_bill->>'occurred_at')::timestamptz,
      (p_bill->>'created_by_user_profile_id')::uuid
    ) returning billing.bills.id into v_id;
  exception when unique_violation then
    -- Lost a race on unique(visit_id): hand back the winner's bill.
    select * into v_existing from billing.bills b where b.visit_id = v_visit_id;
    return query select v_existing.id, v_existing.bill_number, false;
    return;
  end;

  insert into billing.bill_lines (
    bill_id, sequence_no, line_type, description, staff_profile_id,
    net_cents, tax_cents, gross_cents, tax_rate_percent, source_ref
  )
  select
    v_id,
    (line->>'sequence_no')::integer,
    line->>'line_type',
    line->>'description',
    (line->>'staff_profile_id')::uuid,
    (line->>'net_cents')::integer,
    coalesce((line->>'tax_cents')::integer, 0),
    (line->>'gross_cents')::integer,
    coalesce((line->>'tax_rate_percent')::numeric, 0),
    coalesce(line->'source_ref', '{}'::jsonb)
  from jsonb_array_elements(coalesce(p_lines, '[]'::jsonb)) as line;

  return query select v_id, v_number, true;
end;
$$;

comment on function billing.record_bill(jsonb, jsonb) is
  'Atomically allocates the next per-business bill number and stores the bill '
  'header + itemised lines. Idempotent per visit. Service-role only — the API '
  'builds the snapshot and is the sole writer.';

revoke all on function billing.record_bill(jsonb, jsonb) from public;
revoke all on function billing.record_bill(jsonb, jsonb) from anon;
revoke all on function billing.record_bill(jsonb, jsonb) from authenticated;
grant execute on function billing.record_bill(jsonb, jsonb) to service_role;
