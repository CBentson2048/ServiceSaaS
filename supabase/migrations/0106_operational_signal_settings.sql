-- 0106_operational_signal_settings.sql
-- Sensitivity thresholds for the four operational intelligence signals
-- (QLOOQO V1.1, Wrike 4507283793): client spend trend, client no-show risk,
-- back-to-back colour warning and slot gap detector.
--
-- WHAT THIS ADDS
--   1. analytics.operational_signal_settings — one threshold set per scope,
--      business-wide (location_id null) or per location, exactly like
--      crm.retention_settings (0097) and lab.formula_change_settings (0105).
--   2. Three supporting indexes on the read paths the signals actually use.
--
-- WHY analytics. Migration 0002 created this schema and reserved it for exactly
-- this ("Reserved for analytics tables added in later phases"). The thresholds
-- govern two client signals and two diary signals, so they belong to neither crm
-- nor booking nor rota; analytics is the neutral home that does not imply one.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD, AND WHY
--
--   NO signal/flag table. QLOOQO's established intelligence pattern is COMPUTED
--   ON READ — crm client-lapse (0097) and formula-change (0105) both store
--   nothing and recompute from live rows. These four follow it exactly, which
--   means a cancelled appointment, a settled bill, a moved shift or a changed
--   threshold is reflected on the very next call, with no cache to invalidate
--   and no second ledger to drift from the first.
--
--   NO change to booking, billing or rota. Every signal is READ-ONLY over data
--   those modules already own. Nothing here can create, cancel, reprice or move
--   an appointment, and no Tier 1 workflow reads any object in this migration —
--   so a signal failure cannot reach booking, checkout, QLAB, CRM or the till.
--
--   NO derived spend/attendance columns. Spend is billing.bills.gross_cents for
--   a status='paid' bill; attendance is booking.appointments.status. Copying
--   either onto a summary column would create a second source of truth that
--   silently disagrees with the till the first time a bill is voided.
--
--   NO late-cancellation column. A late cancellation is already fully derivable
--   from canonical data: appointments.cancelled_at against the location's own
--   core.location_settings.cancellation_notice_hours — the same value the client
--   app calls the refund cutoff. Storing a duplicate flag would let the two
--   disagree the moment an owner changes the policy.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Sensitivity settings
-- =============================================================================

create table if not exists analytics.operational_signal_settings (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- NULL = the business-wide default; set = an override for that location only.
  location_id uuid references core.locations(id) on delete cascade,

  -- Spend trend: latest N settled visits vs the N before, and the percentage
  -- move in AVERAGE VALUE PER VISIT that counts as material.
  spend_window_visits smallint not null default 3,
  spend_materiality_percent smallint not null default 15,

  -- No-show risk.
  no_show_lookback_days smallint not null default 365,
  no_show_minimum_appointments smallint not null default 5,
  no_show_medium_rate_percent smallint not null default 15,
  no_show_high_rate_percent smallint not null default 30,
  no_show_high_count smallint not null default 3,
  no_show_medium_late_cancellations smallint not null default 3,

  -- Back-to-back colour: stylist-free minutes wanted between two colour clients.
  colour_buffer_minutes smallint not null default 15,

  -- Slot gap: shortest unbooked window worth reporting as lost capacity.
  slot_gap_minimum_minutes smallint not null default 15,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Bounds mirrored EXACTLY by OPERATIONAL_SIGNAL_BOUNDS in @sheer/domain, so a
  -- row written by a script or a backfill can never hold a value the calculators
  -- would refuse to apply.
  constraint signal_spend_window_range check (spend_window_visits between 2 and 12),
  constraint signal_spend_materiality_range check (spend_materiality_percent between 1 and 100),
  constraint signal_no_show_lookback_range check (no_show_lookback_days between 30 and 1095),
  constraint signal_no_show_minimum_range check (no_show_minimum_appointments between 2 and 50),
  constraint signal_no_show_medium_rate_range check (no_show_medium_rate_percent between 1 and 100),
  constraint signal_no_show_high_rate_range check (no_show_high_rate_percent between 1 and 100),
  constraint signal_no_show_high_count_range check (no_show_high_count between 1 and 20),
  constraint signal_no_show_late_cancel_range check (no_show_medium_late_cancellations between 1 and 20),
  constraint signal_colour_buffer_range check (colour_buffer_minutes between 0 and 240),
  constraint signal_slot_gap_range check (slot_gap_minimum_minutes between 5 and 240),

  -- A medium rate above the high rate would make `medium` unreachable — a
  -- silently dead branch rather than a rejected configuration.
  constraint signal_no_show_rates_ordered
    check (no_show_medium_rate_percent <= no_show_high_rate_percent),

  -- One row per scope. NULLS NOT DISTINCT makes the business-wide row collide
  -- with itself, so an upsert keeps one row rather than accumulating duplicates.
  unique nulls not distinct (business_id, location_id)
);

comment on table analytics.operational_signal_settings is
  'Sensitivity thresholds for the four operational intelligence signals (0106, Wrike 4507283793). '
  'location_id null = business-wide default; a location row overrides it WHOLE (per row, not per '
  'field) so the threshold set always comes from one scope somebody actually chose. Absence '
  'inherits DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS in @sheer/domain. The signals themselves store '
  'nothing — they are computed on read from live appointment, bill and rota rows, so changing a '
  'threshold here is reflected on the very next read.';

comment on column analytics.operational_signal_settings.spend_window_visits is
  'Settled visits per comparison window; the latest N are compared with the N before. A fixed VISIT '
  'count rather than a calendar period, because salon cadence varies from 4 to 12 weeks and equal '
  'date windows would compare a three-visit quarter against a one-visit quarter. Platform default 3 '
  '(so 6 settled visits are needed before any trend is claimed) — an ENGINEERING default requiring '
  'product tuning, not a client-supplied value.';
comment on column analytics.operational_signal_settings.spend_materiality_percent is
  'Move in AVERAGE VALUE PER VISIT that counts as rising/falling. Compared exactly (never against a '
  'rounded percentage), so a change one pence inside the line stays stable. Platform default 15.';
comment on column analytics.operational_signal_settings.no_show_lookback_days is
  'How far back attendance counts. A no-show five years ago is not the same fact as one last month. '
  'Platform default 365.';
comment on column analytics.operational_signal_settings.no_show_minimum_appointments is
  'Relevant appointments (attended + no-show + late cancellation) required before a RATE is trusted. '
  'Below it only the count-based overrides can fire, so one miss out of one appointment is never '
  'reported as a 100% risk. Platform default 5.';
comment on column analytics.operational_signal_settings.no_show_high_count is
  'No-shows that reach HIGH on their own, whatever the rate — three misses is a pattern even for a '
  'frequent client. Platform default 3.';
comment on column analytics.operational_signal_settings.no_show_medium_late_cancellations is
  'Late cancellations that reach MEDIUM on their own. Counted SEPARATELY from no-shows and never '
  'treated as equivalent: the client did tell the salon, just too late to refill the slot. A late '
  'cancellation is derived from appointments.cancelled_at against the location''s own '
  'core.location_settings.cancellation_notice_hours — the platform''s existing refund cutoff, not a '
  'new concept. Platform default 3.';
comment on column analytics.operational_signal_settings.colour_buffer_minutes is
  'Stylist-free minutes wanted between two colour appointments on ONE stylist. Measured between '
  'their OCCUPIED windows (booking.appointments.occupied_ranges), not their booked spans, because '
  'QLOOQO models colour development as stylist-free time — measuring raw boundaries would warn about '
  'exactly the interleaving the platform is designed to allow. Platform default 15.';
comment on column analytics.operational_signal_settings.slot_gap_minimum_minutes is
  'Shortest unbooked window reported as lost capacity. Below this is turnaround, not a gap. '
  'Platform default 15.';

drop trigger if exists operational_signal_settings_set_updated_at
  on analytics.operational_signal_settings;
create trigger operational_signal_settings_set_updated_at
before update on analytics.operational_signal_settings
for each row execute function public.set_updated_at();

create index if not exists idx_operational_signal_settings_business
  on analytics.operational_signal_settings (business_id);

-- =============================================================================
-- 2. Read-path support
-- =============================================================================
--
-- None of these changes behaviour; they make the signals' existing access
-- patterns indexable rather than sequential scans on an interactive screen.

-- Spend trend: "this client's settled bills, newest first".
create index if not exists idx_billing_bills_client_settled
  on billing.bills (business_id, client_profile_id, occurred_at desc)
  where status = 'paid';

-- No-show risk: "this client's resolved appointments since <date>". Partial on
-- the four statuses the signal actually reads, so pending/accepted rows — the
-- bulk of a busy diary — stay out of the index entirely.
create index if not exists idx_booking_appointments_client_attendance
  on booking.appointments (business_id, client_profile_id, scheduled_start_at desc)
  where status in ('awaiting_payment', 'paid', 'no_show', 'cancelled');

-- Slot gaps: "published shifts overlapping this window at this location".
create index if not exists idx_rota_shifts_location_window
  on rota.shifts (business_id, location_id, scheduled_start_at)
  where status in ('published', 'completed');

-- =============================================================================
-- 3. RLS
-- =============================================================================
--
-- Thresholds decide what staff get warned about, so they are salon
-- configuration: owners manage them, any active member may READ them (the diary
-- and client profile echo the thresholds behind a signal, so a stylist has to be
-- able to see them to understand the flag). Every write the platform performs
-- goes through the service role after the API has independently checked role and
-- permission; RLS here is defence in depth.
--
-- NOTE THE REVOKE. Migration 0002 sets ALTER DEFAULT PRIVILEGES ... GRANT SELECT,
-- INSERT, UPDATE, DELETE ON TABLES TO authenticated for schema analytics, so
-- this table was born with full authenticated CRUD. A narrowing GRANT alone
-- would be a no-op — the broad grant has to be revoked first.

alter table analytics.operational_signal_settings enable row level security;

revoke all on analytics.operational_signal_settings from authenticated;

drop policy if exists operational_signal_settings_owner_all
  on analytics.operational_signal_settings;
create policy operational_signal_settings_owner_all
on analytics.operational_signal_settings for all
to authenticated
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists operational_signal_settings_member_select
  on analytics.operational_signal_settings;
create policy operational_signal_settings_member_select
on analytics.operational_signal_settings for select
to authenticated
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = analytics.operational_signal_settings.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

grant select, insert, update, delete on analytics.operational_signal_settings to authenticated;
grant select, insert, update, delete on analytics.operational_signal_settings to service_role;
