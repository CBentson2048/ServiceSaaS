-- Messaging & notification base foundation (Build Brief §3.19; Week 1).
--
-- Builds on the existing comms model (comms.notification_events queue +
-- comms.message_logs delivery records). This migration:
--   1. Completes the lifecycle-state and channel enums (fallback-pending +
--      in-app), so a message can be recorded and transitioned through every
--      state the abstraction promises.
--   2. Adds the per-location monthly usage counter that per-tier caps and
--      overage tracking build on (enforcement logic lands in Week 6).
--
-- No provider-specific columns are added here — provider details stay behind
-- the internal MessageProvider abstraction in the API layer.

-- ---------------------------------------------------------------------------
-- 1. Lifecycle-state + channel enum completion
-- ---------------------------------------------------------------------------
-- NOTE: `alter type ... add value` cannot reference the new value in the same
-- transaction, but adding values alongside unrelated DDL is safe. These are
-- additive and idempotent.

-- `fallback_pending`: primary channel failed/ineligible and a fallback has been
-- scheduled but not yet delivered (the holding state for the WhatsApp → Email →
-- SMS chain wired in Week 6).
alter type comms.notification_status_enum add value if not exists 'fallback_pending';

-- `in_app`: in-app notification channel. In-app messages use the shared lifecycle
-- (delivered → read) so in-app state lives in the same model as outbound sends.
alter type comms.channel_enum add value if not exists 'in_app';

-- ---------------------------------------------------------------------------
-- 2. Per-location monthly messaging usage counters (caps + overage foundation)
-- ---------------------------------------------------------------------------
create table if not exists comms.messaging_usage_counters (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  -- First day of the calendar month (UTC) this counter covers.
  period_month date not null,
  -- Tier cap snapshot for the period (null = unlimited). Snapshotting keeps
  -- historical usage accurate even if the business changes tier later.
  monthly_cap integer,
  -- Billable messages (WhatsApp/SMS) counted this period.
  sent_count integer not null default 0 check (sent_count >= 0),
  -- Messages sent beyond monthly_cap this period.
  overage_count integer not null default 0 check (overage_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, location_id, period_month)
);

comment on table comms.messaging_usage_counters is
  'Per-location, per-month billable-message counters. Foundation for tier caps (Solo 100 / Studio 300 / Salon 600 / Group 1,000 per location) and overage tracking; enforcement lands in Week 6.';

create index if not exists idx_messaging_usage_counters_business_period
  on comms.messaging_usage_counters (business_id, period_month desc);

create trigger messaging_usage_counters_set_updated_at
  before update on comms.messaging_usage_counters
  for each row execute function public.set_updated_at();

alter table comms.messaging_usage_counters enable row level security;

-- Owners see the whole business; managers see their location scope. Writes flow
-- through the API service role (mirrors the rest of the comms schema).
create policy comms_messaging_usage_counters_owner_all
  on comms.messaging_usage_counters
  for all
  to authenticated
  using (public.is_business_owner(business_id))
  with check (public.is_business_owner(business_id));

create policy comms_messaging_usage_counters_manager_select
  on comms.messaging_usage_counters
  for select
  to authenticated
  using (public.has_location_management_scope(business_id, location_id));
