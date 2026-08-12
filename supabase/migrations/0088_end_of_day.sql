-- 0088_end_of_day.sql
-- Week 5 — "Implement end-of-day data model" + "Connect completed appointments
-- & checkout records to daily reconciliation".
--
-- The platform previously had NO cash-up capability: nothing recorded a
-- trading day's float, expected vs counted takings, petty cash or sign-off.
-- This migration provides the data model and the aggregation feed:
--
--   1. billing.eod_reconciliations — one row per location per trading day
--      (unique). Expected figures are auto-populated from real checkout
--      records; staff enter counted amounts; sign-off freezes the variance.
--      This is the substrate the contracted R7 Cash Up report (Week 7) reads.
--   2. billing.eod_petty_cash_entries — individual petty-cash outs with a
--      reason and who recorded them (the header carries a denormalised sum).
--   3. billing.eod_expected_figures(...) — the reconciliation feed: one call
--      aggregates the day's salon payments (cash/card, split tenders are one
--      row per method), retail sales, deposits collected (Stripe-side) and
--      deposits redeemed (billing.bills.deposit_applied_cents — recorded
--      explicitly since 0085), plus a count of still-unclosed tickets.
--   4. The previously-missing (business_id, location_id, paid_at) index on
--      billing.salon_payments that the daily sweep needs.
--   5. Permission seeds: eod.manage (front desk can run the count) and
--      eod.sign_off (managers and above). Paired with PERMISSION_CATALOG
--      entries in @sheer/domain — both halves ship together or the keys are
--      silently stripped (blocker B1).
--
-- Deliberately NOT modelled yet: automatic refunds/voids feeds — the platform
-- records neither (payroll.business_data_sources documents this honestly), so
-- those columns are manual-entry until the refund/void model is decided.
--
-- Access model: service-role writes only; owners read business-wide and
-- managers/desk roles read their locations via RLS (defence-in-depth — the
-- API guards are the real enforcement).

create table if not exists billing.eod_reconciliations (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  -- Explicit location-local trading date — never derived from a timestamptz
  -- at read time, so a day means the same thing forever.
  business_date date not null,
  status text not null default 'open' check (status in ('open', 'signed_off')),
  opening_float_cents integer not null default 0 check (opening_float_cents >= 0),
  expected_cash_cents integer,
  counted_cash_cents integer check (counted_cash_cents >= 0),
  expected_card_cents integer,
  counted_card_cents integer check (counted_card_cents >= 0),
  -- Retail rows whose payment method was not recorded (the column is nullable)
  -- — surfaced honestly instead of being guessed into cash or card.
  unclassified_retail_cents integer not null default 0,
  deposits_collected_cents integer not null default 0,
  deposits_redeemed_cents integer not null default 0,
  -- Manual until the refund/void data model exists (see header).
  voids_cents integer not null default 0 check (voids_cents >= 0),
  refunds_cents integer not null default 0 check (refunds_cents >= 0),
  petty_cash_out_cents integer not null default 0 check (petty_cash_out_cents >= 0),
  -- (counted cash + card) − (expected cash + card), frozen at sign-off.
  variance_cents integer,
  notes text,
  opened_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  signed_off_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  signed_off_at timestamptz,
  currency_code char(3) not null default 'GBP',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (location_id, business_date)
);

comment on table billing.eod_reconciliations is
  'End-of-day cash-up: one record per location per trading day (0088). '
  'Expected figures feed from checkout records; counted figures are entered '
  'at the till; sign-off freezes the variance for the R7 Cash Up report.';

create table if not exists billing.eod_petty_cash_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  eod_id uuid not null references billing.eod_reconciliations(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  reason text not null,
  recorded_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table billing.eod_petty_cash_entries is
  'Individual petty-cash outs for a trading day, each with a reason (0088).';

create index if not exists idx_billing_eod_biz_loc_date
  on billing.eod_reconciliations (business_id, location_id, business_date desc);
create index if not exists idx_billing_eod_petty_eod
  on billing.eod_petty_cash_entries (eod_id);
-- The daily takings sweep: previously salon_payments was only indexed by visit.
create index if not exists idx_billing_salon_payments_biz_loc_paid
  on billing.salon_payments (business_id, location_id, paid_at);

drop trigger if exists billing_eod_reconciliations_set_updated_at on billing.eod_reconciliations;
create trigger billing_eod_reconciliations_set_updated_at
  before update on billing.eod_reconciliations
  for each row execute function public.set_updated_at();

alter table billing.eod_reconciliations enable row level security;
alter table billing.eod_petty_cash_entries enable row level security;

drop policy if exists eod_owner_select on billing.eod_reconciliations;
create policy eod_owner_select on billing.eod_reconciliations
  for select using (public.is_business_owner(business_id));

drop policy if exists eod_desk_select on billing.eod_reconciliations;
create policy eod_desk_select on billing.eod_reconciliations
  for select using (public.has_location_desk_access(business_id, location_id));

drop policy if exists eod_petty_parent_select on billing.eod_petty_cash_entries;
create policy eod_petty_parent_select on billing.eod_petty_cash_entries
  for select using (
    exists (
      select 1 from billing.eod_reconciliations e
      where e.id = eod_petty_cash_entries.eod_id
        and (
          public.is_business_owner(e.business_id)
          or public.has_location_desk_access(e.business_id, e.location_id)
        )
    )
  );

grant select on billing.eod_reconciliations, billing.eod_petty_cash_entries to authenticated;
grant all on billing.eod_reconciliations, billing.eod_petty_cash_entries to service_role;

-- ---------------------------------------------------------------------------
-- The reconciliation feed: every expected figure for one location-local day
-- window, in a single round trip (the sources span booking + billing, which
-- PostgREST cannot join). The window boundaries arrive as timestamps — the
-- API computes them in the location's timezone, this function stays tz-naive.
-- ---------------------------------------------------------------------------
create or replace function billing.eod_expected_figures(
  p_business_id uuid,
  p_location_id uuid,
  p_day_start timestamptz,
  p_day_end timestamptz
)
returns table (
  expected_cash_cents bigint,
  expected_card_cents bigint,
  unclassified_retail_cents bigint,
  deposits_collected_cents bigint,
  deposits_redeemed_cents bigint,
  open_visits bigint
)
language sql
stable
as $$
  select
    -- Till takings by tender + retail sales recorded with the same method.
    coalesce((select sum(sp.amount_cents) from billing.salon_payments sp
      where sp.business_id = p_business_id and sp.location_id = p_location_id
        and sp.paid_at >= p_day_start and sp.paid_at < p_day_end
        and sp.payment_method = 'cash'), 0)
    + coalesce((select sum(rs.total_amount_cents) from billing.retail_sales rs
      where rs.business_id = p_business_id and rs.location_id = p_location_id
        and rs.sold_at >= p_day_start and rs.sold_at < p_day_end
        and rs.payment_method = 'cash'), 0)
    as expected_cash_cents,
    coalesce((select sum(sp.amount_cents) from billing.salon_payments sp
      where sp.business_id = p_business_id and sp.location_id = p_location_id
        and sp.paid_at >= p_day_start and sp.paid_at < p_day_end
        and sp.payment_method = 'card_reader'), 0)
    + coalesce((select sum(rs.total_amount_cents) from billing.retail_sales rs
      where rs.business_id = p_business_id and rs.location_id = p_location_id
        and rs.sold_at >= p_day_start and rs.sold_at < p_day_end
        and rs.payment_method = 'card_reader'), 0)
    as expected_card_cents,
    coalesce((select sum(rs.total_amount_cents) from billing.retail_sales rs
      where rs.business_id = p_business_id and rs.location_id = p_location_id
        and rs.sold_at >= p_day_start and rs.sold_at < p_day_end
        and (rs.payment_method is null or rs.payment_method = 'other')), 0)
    as unclassified_retail_cents,
    -- Stripe-side deposits taken today; they never pass through the till, so
    -- there is no overlap with the tender sums above.
    coalesce((select round(sum(d.amount) * 100)::bigint from booking.deposits d
      where d.business_id = p_business_id and d.location_id = p_location_id
        and d.status = 'paid'
        and d.paid_at >= p_day_start and d.paid_at < p_day_end), 0)
    as deposits_collected_cents,
    -- Deposit credit consumed by today's settled bills — recordable only
    -- because 0085 writes deposit_applied_cents onto every stored bill.
    coalesce((select sum(b.deposit_applied_cents) from billing.bills b
      where b.business_id = p_business_id and b.location_id = p_location_id
        and b.occurred_at >= p_day_start and b.occurred_at < p_day_end), 0)
    as deposits_redeemed_cents,
    -- Visits completed but not yet paid — the "unclosed tickets" warning
    -- shown before sign-off (uses the 0026 partial index).
    coalesce((select count(*) from booking.visits v
      where v.business_id = p_business_id and v.location_id = p_location_id
        and v.checkout_status = 'awaiting_payment'
        and v.checkout_ready_at >= p_day_start and v.checkout_ready_at < p_day_end), 0)
    as open_visits
$$;

comment on function billing.eod_expected_figures(uuid, uuid, timestamptz, timestamptz) is
  'Aggregates one location-local day of checkout records into the expected '
  'side of the end-of-day reconciliation. Service-role only.';

revoke all on function billing.eod_expected_figures(uuid, uuid, timestamptz, timestamptz) from public;
revoke all on function billing.eod_expected_figures(uuid, uuid, timestamptz, timestamptz) from anon;
revoke all on function billing.eod_expected_figures(uuid, uuid, timestamptz, timestamptz) from authenticated;
grant execute on function billing.eod_expected_figures(uuid, uuid, timestamptz, timestamptz) to service_role;

-- Permission seeds (catalog entries ship in the same change — blocker B1).
-- Front desk runs the count; sign-off is a management act.
update core.security_levels
set permissions = permissions || '["eod.manage"]'::jsonb
where is_system = true
  and key in ('owner', 'group_admin', 'manager', 'receptionist')
  and not (permissions ? 'eod.manage');

update core.security_levels
set permissions = permissions || '["eod.sign_off"]'::jsonb
where is_system = true
  and key in ('owner', 'group_admin', 'manager')
  and not (permissions ? 'eod.sign_off');
