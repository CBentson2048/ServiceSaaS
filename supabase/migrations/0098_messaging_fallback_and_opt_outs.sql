-- 0098_messaging_fallback_and_opt_outs.sql
-- WhatsApp-first delivery with SMS/email fallback (V1.1 Week 7, Wrike #4507284095).
--
-- The messaging foundation (0006, 0020, 0032, 0059) already models the queue, the
-- per-attempt delivery record and every lifecycle state this ticket needs —
-- including `fallback_pending`, which 0059 added and nothing has written until
-- now. This migration adds only the two things the abstraction was missing to
-- serve messages that are NOT anchored to an appointment:
--
--   1. comms.notification_events.dedupe_key — an idempotency key for messages
--      with no appointment to key on. The existing guard,
--      notification_events_booking_event_unique_idx, is partial on
--      `appointment_id is not null`, so a campaign re-run had NOTHING stopping it
--      from queueing the same message to the same client twice. The new index
--      mirrors that one exactly, including `channel` (so the WhatsApp → SMS →
--      Email fallback events for one message are distinct rows, not duplicates)
--      and `status <> 'cancelled'` (so a cancelled attempt does not block a
--      legitimate re-send).
--
--   2. comms.channel_opt_outs — per-client, PER-CHANNEL opt-out. The ticket's
--      "on failure/opt-out, fall back" needs a durable record: a client who
--      replies STOP to a WhatsApp message, or whom Twilio reports as
--      unsubscribed (error 21610), must be skipped on that channel from then on
--      rather than costing a failed send every time. Per-channel is the whole
--      point — a WhatsApp STOP must not silence the transactional email
--      confirming tomorrow's appointment.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   - No new message/queue/lifecycle tables. The durable dispatcher in
--     apps/api/src/communications keeps its existing atomic-claim + lock TTL +
--     retry/backoff + terminal-state queue; this migration only widens what that
--     queue can carry.
--   - No provider-specific columns. Provider details stay behind the
--     MessageProvider abstraction in the API layer, as 0059 established.
--   - No marketing-consent column. Consent already lives on
--     core.client_profiles.marketing_opt_in; opt-out is a different, narrower
--     fact (this channel, revoked) and is kept separate from it.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Idempotency key for non-appointment messages
-- =============================================================================

alter table comms.notification_events
  add column if not exists dedupe_key text;

comment on column comms.notification_events.dedupe_key is
  'Caller-supplied idempotency key for messages with no appointment to key on '
  '(campaigns, client-intelligence alerts). Unique per (business, key, channel) '
  'among non-cancelled events, mirroring notification_events_booking_event_unique_idx. '
  'NULL for appointment-anchored events, which are already guarded by that index.';

create unique index if not exists notification_events_dedupe_unique_idx
  on comms.notification_events (business_id, dedupe_key, channel)
  where dedupe_key is not null and status <> 'cancelled';

-- Restate the lifecycle now that every state is actually reachable.
comment on column comms.notification_events.status is
  'Delivery lifecycle. queued -> sent once a provider accepts; the provider status '
  'webhook then advances the record to delivered/undelivered/failed/read. '
  'fallback_pending means this channel is finished (ineligible, or failed after its '
  'retries) AND the next channel in the WhatsApp -> SMS -> Email chain has been '
  'queued — the message is still in flight, so this is NOT a terminal state. '
  'failed means the chain is exhausted. cancelled/skipped are terminal non-sends.';

-- =============================================================================
-- 2. Per-client, per-channel messaging opt-outs
-- =============================================================================

create table if not exists comms.channel_opt_outs (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  channel comms.channel_enum not null,
  opted_out_at timestamptz not null default now(),
  -- How we learned about it: an inbound STOP/UNSUBSCRIBE keyword, a provider
  -- error reporting the recipient as unsubscribed, or a staff action.
  source text not null check (source in ('inbound_keyword', 'provider_error', 'staff')),
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per client per channel. Re-opting-out is a no-op, not a second row.
  unique (business_id, client_profile_id, channel)
);

comment on table comms.channel_opt_outs is
  'Per-client, per-channel messaging opt-outs. An opted-out channel is removed from '
  'the WhatsApp -> SMS -> Email chain entirely (resolveChannelPlan), so the next '
  'channel takes over exactly as it would after a delivery failure. Per-channel by '
  'design: a WhatsApp STOP must not silence transactional email. Opting back in '
  '(START/UNSTOP, or a staff correction) DELETES the row rather than flagging it, so '
  'the absence of a row always means "not opted out".';
comment on column comms.channel_opt_outs.source is
  'inbound_keyword = the client sent STOP/UNSUBSCRIBE/CANCEL/END/QUIT; '
  'provider_error = the provider reported the recipient as unsubscribed '
  '(Twilio 21610); staff = recorded on the client''s behalf in the salon.';

create index if not exists idx_channel_opt_outs_client
  on comms.channel_opt_outs (business_id, client_profile_id);

-- ---------------------------------------------------------------------------
-- Keep client merge working under the new unique constraint.
--
-- crm.merge_clients (0087) repoints every foreign key to core.client_profiles with
-- one blanket, conflict-unaware UPDATE per table, discovered from the catalog, and
-- it has no exception handler. comms.channel_opt_outs is the first table under that
-- loop to carry a UNIQUE constraint on client_profile_id, so merging two profiles
-- that had each opted out of the same channel would raise 23505 and roll the whole
-- merge back — leaving the duplicate permanently unmergeable until somebody deleted
-- a row by hand.
--
-- The survivor already holds that opt-out, so the duplicate's row states nothing new:
-- consent is identical whichever row survives. This lets the merge's UPDATE pass over
-- the redundant row instead of failing on it. The row stays on the tombstoned profile,
-- which nothing messages and nothing reads opt-outs for, and the FK's ON DELETE CASCADE
-- removes it if that profile is ever hard-deleted.
-- ---------------------------------------------------------------------------

create or replace function comms.skip_conflicting_opt_out_repoint()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from comms.channel_opt_outs existing
    where existing.business_id = new.business_id
      and existing.client_profile_id = new.client_profile_id
      and existing.channel = new.channel
      and existing.id <> new.id
  ) then
    -- Skip this row's UPDATE. The destination profile is already opted out of this
    -- channel, so the merge loses no consent information by leaving this row behind.
    return null;
  end if;
  return new;
end;
$$;

comment on function comms.skip_conflicting_opt_out_repoint() is
  'BEFORE UPDATE OF client_profile_id guard for comms.channel_opt_outs: when the destination '
  'client already has an opt-out for the same channel, skip the row rather than raising 23505. '
  'Exists so crm.merge_clients (0087), which repoints foreign keys with a blanket conflict-unaware '
  'UPDATE, cannot be broken by this table''s unique constraint.';

-- Default EXECUTE-to-PUBLIC would make this callable directly; it is only ever a trigger.
revoke all on function comms.skip_conflicting_opt_out_repoint() from public, anon, authenticated;

drop trigger if exists channel_opt_outs_skip_conflicting_repoint on comms.channel_opt_outs;
create trigger channel_opt_outs_skip_conflicting_repoint
before update of client_profile_id on comms.channel_opt_outs
for each row
when (old.client_profile_id is distinct from new.client_profile_id)
execute function comms.skip_conflicting_opt_out_repoint();

drop trigger if exists channel_opt_outs_set_updated_at on comms.channel_opt_outs;
create trigger channel_opt_outs_set_updated_at
before update on comms.channel_opt_outs
for each row execute function public.set_updated_at();

alter table comms.channel_opt_outs enable row level security;

-- Owners manage the whole business; any active member can see that a client has
-- opted out (it explains why a message was skipped in CRM history). Writes from
-- the messaging layer run as the service role, which bypasses RLS.
drop policy if exists comms_channel_opt_outs_owner_all on comms.channel_opt_outs;
create policy comms_channel_opt_outs_owner_all
on comms.channel_opt_outs for all
to authenticated
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists comms_channel_opt_outs_member_select on comms.channel_opt_outs;
create policy comms_channel_opt_outs_member_select
on comms.channel_opt_outs for select
to authenticated
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = comms.channel_opt_outs.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

grant select, insert, update, delete on comms.channel_opt_outs to authenticated, service_role;
