-- =============================================================================
-- 0102 — Push delivery for in-app notifications (V1.1, Wrike "Implement arrival
-- alert trigger (check-in -> assigned stylist in-app/push where supported)").
-- =============================================================================
--
-- WHAT THIS ADDS. Migration 0099 built the notification record, the per-user read
-- state and the user/device targeting foundation, and said explicitly that no
-- delivery was implemented. This migration adds the ONE missing piece: a durable
-- outbox that turns a persisted notification into push attempts against the
-- recipient's registered devices.
--
-- WHY AN OUTBOX TABLE AND NOT A FIRE-AND-FORGET CALL. A push provider call inside
-- the check-in request would put a third-party HTTP round trip on the latency path
-- of a front-desk action, and a dangling promise would lose every queued push on
-- deploy or crash. A row per (notification, device) makes the attempt durable,
-- retryable and observable, and lets the sender run on the same claim-based poller
-- pattern comms.notification_events already uses (see
-- apps/api/src/communications/notification-dispatch.service.ts).
--
-- WHY THE IN-APP NOTIFICATION REMAINS THE SOURCE OF TRUTH. Rows here are a
-- DELIVERY LOG, never the notification itself. comms.notifications is written
-- first and independently; if this table is empty, broken, or the provider is
-- down, the stylist still sees the alert in the app. Nothing in the check-in path
-- reads this table.
--
-- WHY NO NEW RECIPIENT LOGIC. Eligibility was already decided when
-- comms.create_notification fanned the notification out to
-- comms.notification_recipients. This migration only maps those recipients to
-- their own enabled devices. There is deliberately no second permission system.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. The outbox
-- -----------------------------------------------------------------------------

create table if not exists comms.push_deliveries (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  notification_id uuid not null references comms.notifications(id) on delete cascade,
  user_profile_id uuid not null references core.user_profiles(id) on delete cascade,
  -- The device row this attempt targets. ON DELETE CASCADE because a delivery to a
  -- device that no longer exists has nothing left to describe.
  user_device_id uuid not null references comms.user_devices(id) on delete cascade,
  -- queued  : waiting for the poller.
  -- sent    : the provider accepted it (acceptance, NOT proof of arrival on the
  --           handset — that would need a receipt poll, which is Week 10 polish).
  -- failed  : terminal after max attempts, or a permanent provider rejection.
  -- skipped : the device stopped being deliverable before we sent (disabled, token
  --           cleared). Distinct from failed so a disabled handset does not read as
  --           a provider fault in diagnostics.
  status text not null default 'queued'
    check (status in ('queued', 'sent', 'failed', 'skipped')),
  attempts integer not null default 0,
  -- Claim lease, mirroring comms.notification_events.locked_until: a worker takes a
  -- row by stamping this into the future, so two API instances cannot both send.
  locked_until timestamptz,
  processing_started_at timestamptz,
  sent_at timestamptz,
  -- Provider-side id, kept so a delivery can be traced in the provider dashboard.
  provider_receipt_id text,
  -- Provider error CODE or a short message. Never the push token.
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Idempotency: one attempt row per notification per device, forever. A retried
  -- enqueue (double-tapped check-in, API retry, replayed job) collides here and is
  -- discarded by `on conflict do nothing` rather than pushing the stylist twice.
  unique (notification_id, user_device_id)
);

comment on table comms.push_deliveries is
  'Durable outbox turning a persisted comms.notifications row into per-device push '
  'attempts. A DELIVERY LOG, never the notification itself: comms.notifications is '
  'the source of truth and the in-app alert works whether or not anything here '
  'succeeds.';
comment on column comms.push_deliveries.status is
  'queued -> sent | failed | skipped. skipped means the device stopped being '
  'deliverable before send (disabled or token cleared), which is not a fault.';
comment on column comms.push_deliveries.locked_until is
  'Claim lease. A worker owns the row until this passes; mirrors the claim pattern '
  'on comms.notification_events so multiple API instances cannot double-send.';
comment on column comms.push_deliveries.last_error is
  'Provider error code or short message. MUST NOT contain the push token.';

-- The poller''s due-candidate query: queued rows whose lease has lapsed, oldest
-- first. Partial on status so the index stays the size of the backlog rather than
-- the size of all delivery history.
create index if not exists idx_push_deliveries_due
  on comms.push_deliveries (created_at)
  where status = 'queued';

-- Diagnostics: "what happened to the pushes for this notification?"
create index if not exists idx_push_deliveries_notification
  on comms.push_deliveries (notification_id);

drop trigger if exists push_deliveries_set_updated_at on comms.push_deliveries;
create trigger push_deliveries_set_updated_at
before update on comms.push_deliveries
for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 2. Enqueue entry point
-- -----------------------------------------------------------------------------
--
-- Called once, by the API, immediately after comms.create_notification succeeds.
-- Expands the notification's ALREADY-DECIDED recipients into their enabled,
-- token-carrying devices. It re-derives nothing about who should be notified:
-- comms.notification_recipients is the authority, so a recipient the database
-- dropped as ineligible can never acquire a push here.
--
-- Returns the number of attempt rows created (0 is a completely normal answer: the
-- stylist may simply have no device registered, which is the "push not supported"
-- case the ticket calls for degrading gracefully).

create or replace function comms.enqueue_push_for_notification(
  p_notification_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public, comms, core
as $$
declare
  v_business_id uuid;
  v_created integer;
begin
  -- Anchor on the notification's own business rather than trusting a parameter, so
  -- a caller cannot attribute a delivery to another tenant.
  select n.business_id into v_business_id
  from comms.notifications n
  where n.id = p_notification_id;

  if v_business_id is null then
    return 0;
  end if;

  with targets as (
    select
      r.user_profile_id,
      d.id as user_device_id
    from comms.notification_recipients r
    join comms.user_devices d
      on d.user_profile_id = r.user_profile_id
     and d.business_id = r.business_id
    where r.notification_id = p_notification_id
      and d.enabled
      and d.push_token is not null
  )
  insert into comms.push_deliveries (
    business_id, notification_id, user_profile_id, user_device_id
  )
  select v_business_id, p_notification_id, t.user_profile_id, t.user_device_id
  from targets t
  -- The unique (notification_id, user_device_id) constraint makes a repeated
  -- enqueue a no-op instead of a duplicate push.
  on conflict (notification_id, user_device_id) do nothing;

  get diagnostics v_created = row_count;
  return v_created;
end;
$$;

comment on function comms.enqueue_push_for_notification(uuid) is
  'Expands an already-created notification into one queued push attempt per enabled, '
  'token-carrying device of its existing recipients. Decides nothing about WHO is '
  'notified — comms.notification_recipients already did. Returns rows created; 0 '
  'means the recipients have no registered device, which is not an error.';

-- SECURITY DEFINER defaults to PUBLIC EXECUTE in this database (the 0071 -> 0078
-- trap). Only the API's service role may enqueue deliveries.
revoke all on function comms.enqueue_push_for_notification(uuid) from public, anon, authenticated;
grant execute on function comms.enqueue_push_for_notification(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 3. Access control
-- -----------------------------------------------------------------------------
--
-- This table is SERVER-ONLY. Nothing in any client reads or writes it: the app
-- shows notifications, not delivery telemetry, and a row here reveals which
-- handsets a user carries. RLS is enabled with NO policy for `authenticated`, so
-- even if a grant were ever widened by accident the rows stay invisible.
--
-- The revokes are load-bearing. Migration 0002 runs ALTER DEFAULT PRIVILEGES
-- granting `authenticated` full CRUD on every new table in the comms schema, so a
-- narrowing grant without a prior revoke restricts nothing at all.

alter table comms.push_deliveries enable row level security;

revoke all on comms.push_deliveries from anon, authenticated;
grant select, insert, update, delete on comms.push_deliveries to service_role;
