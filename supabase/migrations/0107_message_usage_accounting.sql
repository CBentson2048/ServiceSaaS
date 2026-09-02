-- 0107_message_usage_accounting.sql
-- Tier-based monthly message allowance, usage and overage (QLOOQO V1.1,
-- Wrike 4507284256).
--
-- THE PLATFORM-WIDE LAYER THE CAMPAIGN TICKET FOUND MISSING. 0104 recorded that
-- message caps did not exist anywhere and deliberately did NOT build a
-- campaign-specific counter. This migration builds the one accounting layer, and
-- because every outbound client message already flows through
-- MessagingService -> comms.notification_events -> NotificationDispatchService,
-- campaigns, booking confirmations, reminders and rebooking nudges all begin
-- consuming it WITHOUT ANY CALLER-SIDE CODE.
--
-- WHAT THIS ADDS
--   1. core.tier_message_policy        — enforcement mode + warn threshold ONLY.
--                                        The allowance NUMBERS stay in BUSINESS_TIER_LIMITS.
--   2. comms.message_usage_periods     — one monthly bucket per BUSINESS, with a
--                                        tier/allowance snapshot and atomic counters.
--   3. comms.message_usage_entries     — the immutable ledger. One row per LOGICAL
--                                        message. This is the accounting truth.
--   4. comms.record_message_usage(...) — the atomic, idempotent recorder.
--   5. comms.reconcile_message_usage(...) — evidence/recovery, never a nightly repair.
--
-- ---------------------------------------------------------------------------
-- THE COUNTABLE UNIT: ONE LOGICAL MESSAGE, NOT ONE PROVIDER ATTEMPT
-- ---------------------------------------------------------------------------
-- A booking confirmation that tries WhatsApp, fails, and succeeds on SMS is ONE
-- message to the client and costs ONE unit. The platform makes that identity
-- available already:
--
--   * A fallback is a NEW comms.notification_events row carrying the SAME
--     dedupe_key (or the same appointment_id + event_key) with a DIFFERENT
--     channel — see NotificationEscalationService.queueFallback, and the two
--     unique indexes from 0020/0098 which both include `channel` precisely so
--     the chain can exist as separate rows.
--   * A retry is the SAME row attempted again.
--
-- So the logical identity is exactly those shared columns WITHOUT the channel:
--     dedupe_key present  ->  'dk:' || business_id || ':' || dedupe_key
--     appointment-anchored ->  'ap:' || appointment_id || ':' || event_key
--     neither              ->  'ev:' || event_id      (a lone event is its own message)
--
-- The API computes this key (logicalMessageKey in message-usage.service.ts) and
-- the ledger's UNIQUE (business_id, logical_message_key) makes double counting
-- impossible — across retries, across the fallback chain, and across concurrent
-- workers. It is a database guarantee, not a check-before-insert.
--
-- ---------------------------------------------------------------------------
-- WHAT THIS DELIBERATELY DOES NOT DO
-- ---------------------------------------------------------------------------
--   NO new queue, dispatcher or provider path. Usage accounting hangs off the
--   EXISTING durable pipeline at its single "provider accepted" transition
--   (NotificationDispatchService.markAccepted). Nothing about how a message is
--   sent changes.
--
--   NO campaign-specific counter. That is the whole point of this ticket.
--
--   NO second copy of the allowance numbers. They already exist, for the current
--   tiers, in BUSINESS_TIER_LIMITS.messagingMonthlyCapPerLocation (spark 100,
--   pulse 600, infinity 1,000 per location) — the same constant the API enforces
--   location and bookable-column limits from, and the same one the plan card
--   already shows customers. Its own comment says "Enforcement (counters +
--   overage) lands in Week 6; this is the authoritative cap the counters
--   snapshot against", and this migration is that enforcement. Duplicating the
--   figures into a table would create exactly the second tier representation the
--   ticket forbids.
--
--   NO per-location POOL. The per-location cap is multiplied by the account's
--   active locations into ONE business-wide pool and ONE period, so a
--   three-location Infinity salon has 3,000 shared messages rather than three
--   separate 1,000-message allowances with three separate month boundaries.
--
--   NO per-location allowance. The cap is an ACCOUNT-level entitlement, so the
--   period is keyed on business_id alone and every location shares it.
--
--   NO destructive monthly reset. A new month is a new period row; last month
--   stays exactly as it was, because this is future billing evidence.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 0. Retire the superseded per-location counter table
-- =============================================================================
--
-- 0059 created comms.messaging_usage_counters as a Week-1 foundation for exactly
-- this feature. It is retired here rather than reused, for three reasons:
--
--   1. IT IS PER-LOCATION. Its key is (business_id, location_id, period_month)
--      with location_id NOT NULL, so a two-location salon would receive TWO
--      allowances. This ticket requires the opposite — the cap is an ACCOUNT
--      entitlement and a multi-location business must share one pool — so the
--      shapes are not reconcilable, they are contradictory.
--
--   2. ITS TIER NUMBERS ARE FOR A DELETED TIER MODEL. Its comment records
--      "Solo 100 / Studio 300 / Salon 600 / Group 1,000 per location", which are
--      the 0051 tiers. 0064 replaced that enum entirely with spark/pulse/infinity
--      and remapped every account, so those numbers name tiers that no longer
--      exist and cannot be carried across.
--
--   3. IT HAS NEVER BEEN WRITTEN. There is not one reference to it anywhere in
--      apps/ or packages/ — no reader, no writer, no migration backfill. It has
--      only ever been an empty table, so dropping it destroys no data and no
--      billing evidence.
--
-- Leaving it in place would be worse than dropping it: a future engineer would
-- find two usage tables with incompatible grains and no way to tell which one
-- the platform actually believes.
--
-- HOSTED PREFLIGHT, BEFORE APPLYING THIS MIGRATION. Points 1-3 above are
-- verifiable from the repository and hold; what the repository cannot tell you is
-- what is in the HOSTED table. Run:
--
--     select count(*) from comms.messaging_usage_counters;
--
-- Zero is expected. If it is NOT zero, do not apply this migration: something
-- outside this repository wrote to it, export the rows and investigate first.
-- The contents cannot be mechanically carried across — the grains are
-- contradictory (per-location vs per-account) and the tier names belong to the
-- deleted 0051 model — so it is a judgement call about historical billing, not a
-- transform. See docs/V1.1/message-usage-deployment-preflight.md.

drop table if exists comms.messaging_usage_counters;

-- =============================================================================
-- 1. Per-tier entitlement
-- =============================================================================

create table if not exists core.tier_message_policy (
  tier core.business_tier_enum primary key,
  -- track_only    — count everything, never block. The shipped default.
  -- allow_overage — count, surface the overage prominently, still never block.
  -- block_at_cap  — refuse to call a provider once the allowance is exhausted.
  enforcement_mode text not null default 'track_only'
    check (enforcement_mode in ('track_only', 'allow_overage', 'block_at_cap')),
  -- Percentage of the allowance at which the admin surface warns. In-app only:
  -- an external warning that itself consumed the allowance would be absurd.
  warn_at_percent smallint not null default 80 check (warn_at_percent between 1 and 100),
  updated_at timestamptz not null default now()
);

comment on table core.tier_message_policy is
  'Operational policy for the monthly message allowance (0107, Wrike 4507284256): how to behave at '
  'the cap, and when to warn. It deliberately holds NO allowance numbers. The allowance itself is '
  'BUSINESS_TIER_LIMITS.messagingMonthlyCapPerLocation in @sheer/domain — spark 100, pulse 600, '
  'infinity 1,000 per location per calendar month — which is already the authoritative constant the '
  'API enforces other tier limits from and the plan card shows customers. Copying those numbers into '
  'a table would create a second source of truth that silently drifts from the one the product '
  'displays; this table adds only the policy the constant does not carry.';

comment on column core.tier_message_policy.enforcement_mode is
  'Shipped as track_only for every tier, deliberately. Blocking is supported (block_at_cap) but is '
  'not the default: silently stopping a salon''s booking confirmations is a commercial decision '
  'nobody has made, and the ticket asks for warn/block "according to configuration".';

insert into core.tier_message_policy (tier, enforcement_mode, warn_at_percent)
values ('spark', 'track_only', 80), ('pulse', 'track_only', 80), ('infinity', 'track_only', 80)
on conflict (tier) do nothing;

drop trigger if exists tier_message_policy_set_updated_at on core.tier_message_policy;
create trigger tier_message_policy_set_updated_at
before update on core.tier_message_policy
for each row execute function public.set_updated_at();

-- =============================================================================
-- 2. Monthly usage period — one bucket per BUSINESS
-- =============================================================================

create table if not exists comms.message_usage_periods (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- Salon-local calendar month boundaries, resolved in the BUSINESS timezone.
  -- No subscription/billing period exists on this platform (there is no Stripe
  -- subscription model — Stripe is used for booking deposits only), so a
  -- calendar month in one canonical account timezone is the period.
  period_start date not null,
  period_end date not null,
  timezone text not null default 'Europe/London',

  -- SNAPSHOT, written once when the period is created and never overwritten.
  -- This is what lets a future invoice answer "which allowance applied, and
  -- why?" after the business has changed tier. Today's tier must never be able
  -- to rewrite last month's evidence.
  tier_key text not null,
  -- The RESOLVED account allowance for the period: the tier's per-location cap
  -- multiplied by the locations active when the period opened. NULL = unlimited.
  allowance integer check (allowance is null or allowance >= 0),
  is_unlimited boolean not null default false,
  -- Snapshotted so "why was the allowance 3,000?" is answerable later, after a
  -- location has been opened or closed.
  location_count integer not null default 1 check (location_count >= 0),

  -- Materialised summary. The ledger is the truth; these exist so the send path
  -- and the admin screen never have to COUNT(*) a month of messages.
  used_count integer not null default 0 check (used_count >= 0),
  overage_count integer not null default 0 check (overage_count >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint message_usage_period_ordered check (period_end >= period_start),
  -- One period per business per month. This is also the concurrency guard: two
  -- workers racing the first message of a month both attempt the insert and one
  -- gets 23505.
  unique (business_id, period_start)
);

comment on table comms.message_usage_periods is
  'One monthly outbound-message usage bucket per BUSINESS (0107). Keyed on business_id alone — the '
  'allowance is an ACCOUNT entitlement, so a multi-location salon shares one pool and never receives '
  'a second allowance per location. tier_key/allowance/is_unlimited are SNAPSHOTS taken when the '
  'period is created and never rewritten, so a tier change mid-month cannot erase the evidence of '
  'which allowance actually applied. A new month is a new row; previous months are never reset, '
  'zeroed or deleted, because this is future billing evidence.';
comment on column comms.message_usage_periods.used_count is
  'Materialised count of countable logical messages sent in this period. The immutable ledger '
  '(comms.message_usage_entries) is the source of truth; if the two ever disagree the ledger wins, '
  'and comms.reconcile_message_usage() reports the difference.';
comment on column comms.message_usage_periods.overage_count is
  'max(used - allowance, 0), maintained atomically alongside used_count. Always 0 for an unlimited '
  'tier and always 0 while the allowance is unconfigured — an overage against an unknown allowance '
  'would be a fabricated number.';

create index if not exists idx_message_usage_periods_business
  on comms.message_usage_periods (business_id, period_start desc);

drop trigger if exists message_usage_periods_set_updated_at on comms.message_usage_periods;
create trigger message_usage_periods_set_updated_at
before update on comms.message_usage_periods
for each row execute function public.set_updated_at();

-- =============================================================================
-- 3. The immutable usage ledger
-- =============================================================================

create table if not exists comms.message_usage_entries (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  period_id uuid not null references comms.message_usage_periods(id) on delete cascade,

  -- The LOGICAL message identity: stable across every retry of an event and
  -- across the whole WhatsApp -> SMS -> Email fallback chain. Derived by
  -- logicalMessageKey() in the API from columns that already exist; never the
  -- provider's message id, which changes per attempt.
  logical_message_key text not null,

  -- The event that actually reached the provider. Nullable ON DELETE SET NULL so
  -- pruning the queue can never destroy billing evidence.
  notification_event_id uuid references comms.notification_events(id) on delete set null,

  message_class text not null default 'transactional',
  final_channel text not null,
  event_key text,
  counted_at timestamptz not null default now(),

  constraint message_usage_entry_key_not_blank check (length(btrim(logical_message_key)) > 0),
  -- THE exactly-once guarantee. A database constraint, not a check-before-insert:
  -- concurrent workers, a retried dispatcher tick and a fallback that succeeds
  -- after its predecessor was also accepted all collide here and count once.
  unique (business_id, logical_message_key)
);

comment on table comms.message_usage_entries is
  'Immutable per-logical-message usage ledger (0107) — the accounting source of truth for future '
  'billing. UNIQUE (business_id, logical_message_key) is what makes counting exactly-once across '
  'retries, channel fallback and concurrent dispatcher workers. Deliberately holds NO message body, '
  'no recipient and no client identity: billing needs counts, not private correspondence.';
comment on column comms.message_usage_entries.logical_message_key is
  'Stable identity of ONE outbound message to a client. dk:<business>:<dedupe_key> for a keyed '
  'message (campaigns, client alerts), ap:<appointment>:<event_key> for an appointment-anchored one '
  '(confirmations, reminders, nudges), ev:<event_id> for a lone event. Excludes the channel on '
  'purpose, so a WhatsApp attempt and its SMS fallback share one key and cost one unit.';
comment on column comms.message_usage_entries.final_channel is
  'The channel the provider actually accepted, for explainability. It is NOT part of the identity: '
  'including it would make a fallback count twice.';

create index if not exists idx_message_usage_entries_period
  on comms.message_usage_entries (period_id, counted_at);
create index if not exists idx_message_usage_entries_event
  on comms.message_usage_entries (notification_event_id)
  where notification_event_id is not null;

-- =============================================================================
-- 4. The atomic, idempotent recorder
-- =============================================================================
--
-- ONE statement per step, no read-modify-write anywhere:
--
--   1. Ensure the period exists (insert ... on conflict do nothing).
--   2. Claim the logical message (insert ... on conflict do nothing returning).
--      No row returned means it was already counted — the idempotent outcome.
--   3. Increment the counters with a single UPDATE that derives the new overage
--      from the new used value in the same statement, so the row lock covers
--      both and two concurrent messages crossing the cap produce used+2 and
--      overage+1, never a lost update.
--
-- SECURITY: plain SECURITY INVOKER. The dispatcher calls it as service_role, so
-- no definer privilege is needed and the platform's SECURITY DEFINER surface is
-- not widened. EXECUTE is revoked from public/anon/authenticated.

create or replace function comms.record_message_usage(
  p_business_id uuid,
  p_logical_message_key text,
  p_period_start date,
  p_period_end date,
  p_timezone text,
  p_tier_key text,
  p_allowance integer,
  p_is_unlimited boolean,
  p_location_count integer default 1,
  p_notification_event_id uuid default null,
  p_message_class text default 'transactional',
  p_final_channel text default 'whatsapp',
  p_event_key text default null
)
returns table (
  counted boolean,
  used_count integer,
  overage_count integer,
  allowance integer,
  is_unlimited boolean
)
language plpgsql
volatile
as $$
declare
  v_period comms.message_usage_periods%rowtype;
  v_entry_id uuid;
begin
  -- 1. The period. Snapshot columns are written ONLY on creation: `do nothing`
  --    means a tier change mid-month leaves the original snapshot intact, which
  --    is exactly the historical evidence a future invoice needs.
  insert into comms.message_usage_periods (
    business_id, period_start, period_end, timezone, tier_key, allowance, is_unlimited, location_count
  )
  values (
    p_business_id, p_period_start, p_period_end,
    coalesce(nullif(btrim(p_timezone), ''), 'Europe/London'),
    p_tier_key, p_allowance, coalesce(p_is_unlimited, false), greatest(coalesce(p_location_count, 1), 0)
  )
  on conflict (business_id, period_start) do nothing;

  select * into v_period
  from comms.message_usage_periods
  where business_id = p_business_id and period_start = p_period_start;

  -- 2. Claim the logical message. The unique constraint is the guarantee.
  insert into comms.message_usage_entries (
    business_id, period_id, logical_message_key, notification_event_id,
    message_class, final_channel, event_key
  )
  values (
    p_business_id, v_period.id, p_logical_message_key, p_notification_event_id,
    coalesce(p_message_class, 'transactional'), p_final_channel, p_event_key
  )
  on conflict (business_id, logical_message_key) do nothing
  returning id into v_entry_id;

  if v_entry_id is null then
    -- Already counted: a retry, the other half of a fallback pair, or a second
    -- worker. Report the current state and change nothing.
    return query select false, v_period.used_count, v_period.overage_count,
                        v_period.allowance, v_period.is_unlimited;
    return;
  end if;

  -- 3. One atomic increment. `used_count` on the right is the pre-update value,
  --    so the new overage is derived from the new used count inside the same
  --    statement and under the same row lock.
  update comms.message_usage_periods p
     set used_count = p.used_count + 1,
         overage_count = case
           -- An unlimited tier can never be over. An unconfigured allowance has
           -- nothing to be over BY — reporting one would be a fabricated number.
           when p.is_unlimited then 0
           when p.allowance is null then 0
           else greatest((p.used_count + 1) - p.allowance, 0)
         end
   where p.id = v_period.id
  returning p.used_count, p.overage_count, p.allowance, p.is_unlimited
  into used_count, overage_count, allowance, is_unlimited;

  counted := true;
  return next;
end;
$$;

comment on function comms.record_message_usage(uuid, text, date, date, text, text, integer, boolean, integer, uuid, text, text, text) is
  'Record ONE logical outbound message against a business''s monthly allowance (0107). Idempotent by '
  'construction: the ledger''s UNIQUE (business_id, logical_message_key) absorbs retries, the second '
  'half of a WhatsApp->SMS fallback pair, and concurrent workers, returning counted=false without '
  'touching the counters. The increment is a single UPDATE that derives the new overage from the new '
  'used value under one row lock, so two messages crossing the cap concurrently yield used+2 and '
  'overage+1 rather than a lost update. Period snapshot columns are written on creation only.';

revoke all on function comms.record_message_usage(uuid, text, date, date, text, text, integer, boolean, integer, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function comms.record_message_usage(uuid, text, date, date, text, text, integer, boolean, integer, uuid, text, text, text)
  to service_role;

-- =============================================================================
-- 5. Reconciliation — evidence and recovery, never a scheduled repair
-- =============================================================================
--
-- The counters are maintained transactionally, so this is NOT a nightly fixer
-- that production correctness depends on. It exists so an operator (or a test)
-- can ask "do the counters still match the ledger?" and get a definitive answer,
-- and so a period can be repaired if one ever drifts.
--
-- It recomputes from the ledger, which is the source of truth, and reports what
-- changed rather than silently rewriting.

create or replace function comms.reconcile_message_usage(
  p_business_id uuid,
  p_period_start date,
  p_apply boolean default false
)
returns table (
  period_id uuid,
  counter_used integer,
  ledger_used integer,
  counter_overage integer,
  ledger_overage integer,
  applied boolean
)
language plpgsql
volatile
as $$
declare
  v_period comms.message_usage_periods%rowtype;
  v_ledger integer;
  v_overage integer;
begin
  select * into v_period
  from comms.message_usage_periods
  where business_id = p_business_id and period_start = p_period_start;
  if not found then return; end if;

  select count(*)::integer into v_ledger
  from comms.message_usage_entries e
  where e.period_id = v_period.id;

  v_overage := case
    when v_period.is_unlimited then 0
    when v_period.allowance is null then 0
    else greatest(v_ledger - v_period.allowance, 0)
  end;

  if p_apply and (v_period.used_count <> v_ledger or v_period.overage_count <> v_overage) then
    update comms.message_usage_periods
       set used_count = v_ledger, overage_count = v_overage
     where id = v_period.id;
    return query select v_period.id, v_period.used_count, v_ledger,
                        v_period.overage_count, v_overage, true;
  else
    return query select v_period.id, v_period.used_count, v_ledger,
                        v_period.overage_count, v_overage, false;
  end if;
end;
$$;

comment on function comms.reconcile_message_usage(uuid, date, boolean) is
  'Compare a period''s materialised counters against the immutable ledger (0107). The ledger is the '
  'source of truth. Read-only unless p_apply is true. This is evidence and recovery — the counters '
  'are maintained transactionally by record_message_usage(), so no scheduled repair job exists or '
  'should be relied upon.';

revoke all on function comms.reconcile_message_usage(uuid, date, boolean) from public, anon, authenticated;
grant execute on function comms.reconcile_message_usage(uuid, date, boolean) to service_role;

-- =============================================================================
-- 6. RLS
-- =============================================================================
--
-- Usage is account-sensitive commercial data. Owners may READ their own; nobody
-- may write any of it from a browser session, because a salon must not be able
-- to tell the server how many messages it sent. Every write happens through the
-- service role from inside the dispatcher.
--
-- NOTE THE REVOKES. Migration 0002 grants authenticated full CRUD by default on
-- new tables in schemas core and comms, so a narrowing GRANT alone would be a
-- no-op — the broad grant has to be revoked first.

alter table core.tier_message_policy enable row level security;
alter table comms.message_usage_periods enable row level security;
alter table comms.message_usage_entries enable row level security;

revoke all on core.tier_message_policy from authenticated;
revoke all on comms.message_usage_periods from authenticated;
revoke all on comms.message_usage_entries from authenticated;

-- The entitlement table is platform pricing configuration: readable by any
-- signed-in user (the admin screen shows "your plan includes N"), writable by
-- nobody through the API.
drop policy if exists tier_message_policy_read on core.tier_message_policy;
create policy tier_message_policy_read
on core.tier_message_policy for select
to authenticated
using (true);

drop policy if exists message_usage_periods_owner_select on comms.message_usage_periods;
create policy message_usage_periods_owner_select
on comms.message_usage_periods for select
to authenticated
using (public.is_business_owner(business_id));

-- The ledger stays owner-readable for reconciliation and future billing support.
-- It carries no message content and no client identity by design.
drop policy if exists message_usage_entries_owner_select on comms.message_usage_entries;
create policy message_usage_entries_owner_select
on comms.message_usage_entries for select
to authenticated
using (public.is_business_owner(business_id));

grant select on core.tier_message_policy to authenticated;
grant select on comms.message_usage_periods to authenticated;
grant select on comms.message_usage_entries to authenticated;

grant select, insert, update, delete
  on core.tier_message_policy, comms.message_usage_periods, comms.message_usage_entries
  to service_role;
