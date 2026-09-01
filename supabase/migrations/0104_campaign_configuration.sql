-- 0104_campaign_configuration.sql
-- Campaign configuration & automated marketing (QLOOQO V1.1, Wrike 4507283957).
--
-- ONE campaign framework, four typed strategies — rebooking, birthday,
-- promotion, loyalty milestone. Not four systems.
--
-- WHAT THIS ADDS
--   1. comms.campaigns          — the owner's configuration. One row per campaign.
--   2. comms.campaign_runs      — one row per campaign per salon-local day it was
--                                 evaluated. The durable "has today been done?"
--                                 answer AND the operator's evidence trail.
--   3. comms.campaign_recipients— the permanent send ledger: one row per
--                                 (campaign, send identity), recording queued or
--                                 suppressed-with-a-reason.
--   4. comms.claim_campaign_recipient(...) — the atomic claim that makes
--                                 duplicate sends impossible across workers.
--   5. comms.campaign_loyalty_metrics(...) — set-based completed-visit count and
--                                 settled spend per client.
--   6. comms.campaign_birthday_candidates(...) — set-based birthday matching.
--
-- WHAT THIS DELIBERATELY DOES NOT ADD
--   - No new queue, no new message table, no new provider column. Campaign
--     messages are ordinary comms.notification_events rows queued through
--     MessagingService, delivered by the existing dispatcher over the existing
--     WhatsApp -> SMS -> Email chain, and logged in comms.message_logs exactly
--     like a booking confirmation. 0098 already added the one thing that was
--     missing for non-appointment messages: notification_events.dedupe_key and
--     its unique index. This migration relies on that index rather than adding
--     a second idempotency mechanism.
--   - No consent column. Marketing consent is core.client_profiles.marketing_opt_in
--     and opt-out is comms.channel_opt_outs (0098). Campaigns read both through
--     the messaging layer; they do not get their own rules.
--   - No loyalty ledger. "Completed visits" is the SAME predicate
--     crm.client_service_history (0097) uses, and spend is billing.bills where
--     status = 'paid' — integer pence, never floating point. Inventing a
--     parallel loyalty balance would immediately disagree with the till.
--   - No cadence maths. Rebooking eligibility comes from evaluateClientLapse()
--     in @sheer/domain via crm.client_service_history / crm.client_next_bookings.
--     There is no second definition of "overdue" anywhere.
--
-- FAILURE ISOLATION (Wrike section 35)
--   Nothing in booking, till, CRM or QLAB reads any object in this migration.
--   Every table here is additive and every function is new, so a total failure
--   of the campaign feature cannot affect a booking, a checkout or a bill.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Campaign configuration
-- =============================================================================

create table if not exists comms.campaigns (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- NULL = business-wide (every client of the business); set = only clients whose
  -- primary_location_id is this location. Same scoping convention as
  -- crm.retention_settings (0097) and booking.upsell_rules (0103).
  location_id uuid references core.locations(id) on delete cascade,
  campaign_type text not null check (
    campaign_type in ('rebooking', 'birthday', 'promotion', 'loyalty_milestone')
  ),
  name text not null,
  -- New campaigns are drafts. Configuring one can never send anything.
  status text not null default 'draft' check (status in ('draft', 'active', 'paused', 'archived')),
  -- 'auto' = the client's own place in the canonical WhatsApp -> SMS -> Email
  -- chain. A named channel NARROWS that chain, it never reorders or bypasses it
  -- (narrowCampaignChannel in @sheer/domain).
  channel text not null default 'auto' check (channel in ('auto', 'whatsapp', 'sms', 'email')),
  message_template text not null,
  message_subject text,
  -- Salon-LOCAL hour of day the campaign is evaluated and queued at. This is the
  -- platform's quiet-hours policy: bounded to 08:00-20:00 so automation cannot
  -- queue marketing overnight. There is no separate send-window scheduler.
  send_at_local_hour smallint not null default 10 check (send_at_local_hour between 8 and 20),
  -- Typed per-type configuration, validated by validateCampaignConfig() in
  -- @sheer/domain on write AND on read. Never an executable expression: every
  -- field is a bounded scalar or a fixed enum.
  config jsonb not null default '{}'::jsonb,
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  last_evaluated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaigns_name_not_blank check (length(btrim(name)) > 0),
  constraint campaigns_name_length check (length(name) <= 120),
  constraint campaigns_template_not_blank check (length(btrim(message_template)) > 0),
  constraint campaigns_template_length check (length(message_template) <= 1000),
  constraint campaigns_subject_length check (message_subject is null or length(message_subject) <= 200),
  constraint campaigns_config_is_object check (jsonb_typeof(config) = 'object')
);

comment on table comms.campaigns is
  'Owner-configured marketing campaigns (0104, Wrike 4507283957). Four typed strategies share one '
  'lifecycle: configure -> activate -> daily evaluation -> durable message event -> existing '
  'WhatsApp/SMS/Email dispatcher. location_id null = business-wide. status=draft is the default so '
  'setting a campaign up can never send. Campaign messages are ordinary comms.notification_events '
  'rows with message_class=marketing; this table adds NO messaging capability of its own.';

comment on column comms.campaigns.send_at_local_hour is
  'Salon-local hour (8-20) the campaign is evaluated at. Doubles as the quiet-hours guard — the '
  'CHECK is the reason automation cannot queue a marketing message at 03:00. Timezone is the '
  'campaign location''s, or the business''s for a business-wide campaign.';

comment on column comms.campaigns.channel is
  'auto = the client''s own starting point in the canonical WhatsApp -> SMS -> Email chain '
  '(WhatsApp-first preserved). A named channel narrows the chain to that channel and below; it can '
  'never move a client UP the chain past their own stored communication_preference.';

comment on column comms.campaigns.config is
  'Typed per-type configuration. rebooking: {targetStatuses, minOverdueDays, serviceCategoryId}. '
  'birthday: {daysBefore}. promotion: {startDate, endDate, lapseStatuses, serviceCategoryId, '
  'minCompletedVisits}. loyalty_milestone: {metric, threshold}. Validated by validateCampaignConfig() '
  'in @sheer/domain on both write and read — never interpreted as an expression.';

-- One campaign of a given type per name per scope. Stops an owner creating two
-- identical birthday campaigns that would each message the same client.
-- NULLS NOT DISTINCT so the business-wide row (location_id is null) collides
-- with itself, while still permitting a business-wide + per-location pair.
create unique index if not exists uq_campaigns_scope_type_name
  on comms.campaigns (business_id, location_id, campaign_type, lower(btrim(name)))
  nulls not distinct
  where status <> 'archived';

-- The evaluator's hot path: every active campaign, business by business.
create index if not exists idx_campaigns_active
  on comms.campaigns (business_id, campaign_type)
  where status = 'active';

create index if not exists idx_campaigns_business
  on comms.campaigns (business_id, created_at desc);

drop trigger if exists campaigns_set_updated_at on comms.campaigns;
create trigger campaigns_set_updated_at
before update on comms.campaigns
for each row execute function public.set_updated_at();

-- =============================================================================
-- 2. Campaign runs — the durable "has today been done?" ledger
-- =============================================================================
--
-- One row per campaign per salon-local date. The UNIQUE constraint is what makes
-- evaluation safe across multiple API instances: two workers waking at the same
-- moment both attempt the insert, one gets 23505 and stands down. No advisory
-- locks, no leader election, no external scheduler.

create table if not exists comms.campaign_runs (
  id uuid primary key default extensions.gen_random_uuid(),
  campaign_id uuid not null references comms.campaigns(id) on delete cascade,
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- The SALON-LOCAL calendar date this run covers, not a UTC timestamp. A run is
  -- a day in the salon's own calendar (Wrike section 22).
  run_local_date date not null,
  status text not null default 'running' check (status in ('running', 'completed', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  candidate_count integer not null default 0 check (candidate_count >= 0),
  eligible_count integer not null default 0 check (eligible_count >= 0),
  queued_count integer not null default 0 check (queued_count >= 0),
  suppressed_count integer not null default 0 check (suppressed_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  -- suppression reason -> count. The operator's answer to "why did nobody get this?".
  suppression_breakdown jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now()
);

comment on table comms.campaign_runs is
  'One row per campaign per salon-local evaluation day (0104). unique (campaign_id, run_local_date) '
  'IS the cross-instance concurrency guard: two evaluators racing the same day, '
  'one wins the insert and the other gets 23505 and stands down. Also the operator evidence trail — '
  'candidates, eligible, queued, suppressed (with a reason breakdown) and failed.';

comment on column comms.campaign_runs.run_local_date is
  'The salon-local calendar date evaluated, resolved in the campaign''s governing timezone '
  '(location''s, or business''s for a business-wide campaign). Never a UTC date.';

-- THE concurrency guard. Unconditional: a campaign is evaluated at most once
-- per salon-local day, whoever asks. The audience preview writes NOTHING at all
-- — no run row, no recipient row, no event — so it needs no exemption here.
create unique index if not exists uq_campaign_runs_daily
  on comms.campaign_runs (campaign_id, run_local_date);

create index if not exists idx_campaign_runs_campaign
  on comms.campaign_runs (campaign_id, run_local_date desc);

-- =============================================================================
-- 3. Campaign recipients — the permanent send ledger
-- =============================================================================
--
-- WHY THIS EXISTS ALONGSIDE notification_events.dedupe_key
--
--   The dedupe index on notification_events is partial on `status <> 'cancelled'`,
--   which is correct for messaging (a cancelled attempt should not block a
--   legitimate re-send) but WRONG as a loyalty-milestone guard: a cancelled
--   event would let "your 10th visit!" fire a second time. This table is the
--   durable identity ledger that survives event cancellation.
--
--   It is also the only place a SUPPRESSED client is recorded at all. A client
--   with no marketing consent never produces a notification_event, so without
--   this row there would be no answer to "why did Jane not get it?".
--
-- WHY SUPPRESSED ROWS DO NOT BLOCK FOREVER
--   The claim function below UPDATES a suppressed row rather than treating it as
--   taken. Consent granted tomorrow must be able to produce a send tomorrow. A
--   'queued' row, by contrast, is final: that identity has had its message.

create table if not exists comms.campaign_recipients (
  id uuid primary key default extensions.gen_random_uuid(),
  campaign_id uuid not null references comms.campaigns(id) on delete cascade,
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- The run that most recently touched this row. Nullable so a row outlives a
  -- pruned run rather than disappearing with it.
  run_id uuid references comms.campaign_runs(id) on delete set null,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  -- The deterministic send identity (birthdayDedupeKey / loyaltyDedupeKey /
  -- promotionDedupeKey / rebookingDedupeKey in @sheer/domain). Also written to
  -- comms.notification_events.dedupe_key, so the two guards agree by construction.
  dedupe_key text not null,
  status text not null check (status in ('queued', 'suppressed', 'failed')),
  suppression_reason text,
  -- The event this became. Null for suppressed/failed, and for a duplicate the
  -- messaging layer reported without creating a new row.
  notification_event_id uuid references comms.notification_events(id) on delete set null,
  channel text,
  -- Plain-language statement of why this client matched, for the audience preview.
  match_reason text,
  first_seen_at timestamptz not null default now(),
  queued_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint campaign_recipients_dedupe_key_not_blank check (length(btrim(dedupe_key)) > 0),
  constraint campaign_recipients_suppression_reason_present check (
    status <> 'suppressed' or suppression_reason is not null
  )
);

comment on table comms.campaign_recipients is
  'Permanent per-(campaign, send identity) ledger (0104). A queued row is FINAL — that identity has '
  'had its message and can never have another, which is what makes a loyalty milestone fire once '
  'and a birthday fire once per year even if the notification event is later cancelled. A '
  'suppressed row records WHY nothing was sent and is upgradeable: consent granted tomorrow '
  'produces a send tomorrow. Written only by comms.claim_campaign_recipient().';

comment on column comms.campaign_recipients.dedupe_key is
  'Deterministic send identity, identical to the value written to '
  'comms.notification_events.dedupe_key. Never includes the message text, so editing a campaign''s '
  'wording cannot make an already-messaged client eligible again (Wrike section 27).';

-- THE idempotency guard. One row per (campaign, identity), full — not partial —
-- so it holds regardless of status or of what happened to the event.
create unique index if not exists uq_campaign_recipients_identity
  on comms.campaign_recipients (campaign_id, dedupe_key);

create index if not exists idx_campaign_recipients_run
  on comms.campaign_recipients (run_id)
  where run_id is not null;

create index if not exists idx_campaign_recipients_client
  on comms.campaign_recipients (business_id, client_profile_id, created_at desc);

drop trigger if exists campaign_recipients_set_updated_at on comms.campaign_recipients;
create trigger campaign_recipients_set_updated_at
before update on comms.campaign_recipients
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Keep client merge working under the new unique constraint.
--
-- crm.merge_clients (0087) repoints every FK to core.client_profiles with one
-- blanket, conflict-unaware UPDATE per table. comms.campaign_recipients has no
-- unique constraint ON client_profile_id, so the merge cannot collide here — the
-- identity key contains the DUPLICATE's client id, which stays distinct from the
-- survivor's. The repointed rows keep their historical keys, which is correct:
-- they record messages that really were sent to that person. No trigger needed;
-- this note exists so a future reader does not add one "for symmetry" with
-- comms.channel_opt_outs (0098), where a real collision was possible.
-- ---------------------------------------------------------------------------

-- =============================================================================
-- 4. The atomic recipient claim
-- =============================================================================
--
-- Wrike section 26/58: idempotency must not rely on "check, then insert".
--
-- INSERT ... ON CONFLICT DO UPDATE ... WHERE is a single atomic statement. Two
-- concurrent evaluators both run it:
--   - one inserts and gets its row back -> it owns the send;
--   - the other conflicts, and the DO UPDATE's WHERE (`status = 'suppressed'`)
--     rejects the update because the row is now 'queued' -> it gets NO ROW back,
--     which it reports as `claimed = false`.
-- No lock, no retry loop, no window. The database decides.
--
-- A previously SUPPRESSED row IS updatable: it is re-offered to the campaign
-- because the reason for suppression (no consent, no valid contact) may have
-- changed. A 'failed' row is also re-offered — a transient enqueue failure must
-- not silently retire a client forever.
--
-- SECURITY: plain SECURITY INVOKER (the default). The API calls it as
-- service_role, so no definer privilege is needed and the platform's
-- SECURITY DEFINER surface is not widened. EXECUTE is revoked from
-- public/anon/authenticated and granted only to service_role.

create or replace function comms.claim_campaign_recipient(
  p_campaign_id uuid,
  p_business_id uuid,
  p_run_id uuid,
  p_client_profile_id uuid,
  p_dedupe_key text,
  p_match_reason text default null
)
returns table (
  recipient_id uuid,
  claimed boolean
)
language sql
volatile
as $$
  with claimed_row as (
    insert into comms.campaign_recipients (
      campaign_id, business_id, run_id, client_profile_id, dedupe_key,
      status, suppression_reason, match_reason
    )
    values (
      p_campaign_id, p_business_id, p_run_id, p_client_profile_id, p_dedupe_key,
      -- Claimed rows start as 'suppressed' with a placeholder reason and are
      -- promoted to 'queued' only once the messaging layer accepts the message.
      -- A crash between claim and enqueue therefore leaves a re-offerable row,
      -- never a phantom "sent".
      'suppressed', 'claimed, not yet enqueued', p_match_reason
    )
    on conflict (campaign_id, dedupe_key) do update
      set run_id = excluded.run_id,
          match_reason = coalesce(excluded.match_reason, comms.campaign_recipients.match_reason),
          suppression_reason = 'claimed, not yet enqueued',
          updated_at = now()
      -- The whole guard, in one predicate: a row that has already been queued is
      -- never re-offered. Only a suppressed or failed identity may be retried.
      where comms.campaign_recipients.status in ('suppressed', 'failed')
    returning id
  )
  select id as recipient_id, true as claimed from claimed_row;
$$;

comment on function comms.claim_campaign_recipient(uuid, uuid, uuid, uuid, text, text) is
  'Atomically claim one campaign send identity (0104). Returns a row when THIS caller owns the send, '
  'and no rows when the identity has already been queued by another worker, tick or run. Single '
  'statement, so concurrent evaluators cannot both win — this is the final defence against duplicate '
  'campaign messages, not a check-before-insert. A suppressed or failed identity is re-offered '
  '(consent may since have been granted); a queued one never is.';

revoke all on function comms.claim_campaign_recipient(uuid, uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function comms.claim_campaign_recipient(uuid, uuid, uuid, uuid, text, text)
  to service_role;

-- Record the outcome of an accepted claim. Separate from the claim itself so a
-- failure to enqueue leaves the row re-offerable rather than falsely 'queued'.
create or replace function comms.settle_campaign_recipient(
  p_recipient_id uuid,
  p_status text,
  p_suppression_reason text default null,
  p_notification_event_id uuid default null,
  p_channel text default null
)
returns void
language sql
volatile
as $$
  update comms.campaign_recipients
     set status = p_status,
         suppression_reason = case when p_status = 'queued' then null else p_suppression_reason end,
         notification_event_id = coalesce(p_notification_event_id, notification_event_id),
         channel = coalesce(p_channel, channel),
         queued_at = case when p_status = 'queued' then now() else queued_at end,
         updated_at = now()
   where id = p_recipient_id;
$$;

comment on function comms.settle_campaign_recipient(uuid, text, text, uuid, text) is
  'Record the outcome of a claimed campaign send identity (0104). Split from claim_campaign_recipient '
  'so a crash between claiming and enqueueing leaves a re-offerable row rather than a phantom send.';

revoke all on function comms.settle_campaign_recipient(uuid, text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function comms.settle_campaign_recipient(uuid, text, text, uuid, text)
  to service_role;

-- =============================================================================
-- 5. Loyalty metrics — set-based, canonical, integer money
-- =============================================================================
--
-- Wrike sections 13 and 41. Two metrics, both derived from data that already
-- exists and that the till itself produced:
--
--   completed_visits — the SAME attendance predicate crm.client_service_history
--                      (0097) uses: a visit row in ('completed','awaiting_payment',
--                      'paid'), or a completed appointment in ('awaiting_payment',
--                      'paid') with no qualifying visit row. Cancelled, no-show
--                      and rejected never count. Collapsed to one visit per
--                      salon-local date, exactly as 0097 does, so colour + a cut
--                      on one Tuesday is ONE visit.
--
--   total_spend      — sum of billing.bills.gross_cents where status = 'paid'.
--                      INTEGER PENCE. Voided bills are excluded, which is how a
--                      refunded/voided transaction fails to inflate a milestone.
--                      No floating point appears anywhere in this path.
--
-- One row per client, one query. Never one query per client.

create or replace function comms.campaign_loyalty_metrics(
  p_business_id uuid,
  p_timezone text default 'Europe/London',
  p_location_ids uuid[] default null,
  p_limit integer default 1000,
  p_offset integer default 0
)
returns table (
  client_profile_id uuid,
  first_name text,
  last_name text,
  email text,
  phone text,
  marketing_opt_in boolean,
  primary_location_id uuid,
  completed_visits integer,
  total_spend_cents bigint
)
language sql
stable
as $$
  with params as (
    select
      coalesce(nullif(btrim(p_timezone), ''), 'Europe/London') as tz,
      least(greatest(coalesce(p_limit, 1000), 1), 1000) as row_limit,
      greatest(coalesce(p_offset, 0), 0) as row_offset
  ),
  scoped_clients as (
    select c.id, c.first_name, c.last_name, c.email, c.phone,
           c.marketing_opt_in, c.primary_location_id
    from core.client_profiles c
    where c.business_id = p_business_id
      -- 0087 merge tombstones are never a client in their own right.
      and c.merged_into_id is null
      and (p_location_ids is null or c.primary_location_id = any (p_location_ids))
  ),
  visit_rows as (
    select v.client_profile_id,
           coalesce(v.completed_at, v.started_at, v.checked_in_at) as attended_at,
           v.appointment_id
    from booking.visits v
    join scoped_clients sc on sc.id = v.client_profile_id
    where v.business_id = p_business_id
      and v.status in ('completed', 'awaiting_payment', 'paid')
      and coalesce(v.completed_at, v.started_at, v.checked_in_at) is not null
  ),
  appointment_rows as (
    select a.client_profile_id,
           a.completed_at as attended_at,
           a.id as appointment_id
    from booking.appointments a
    join scoped_clients sc on sc.id = a.client_profile_id
    where a.business_id = p_business_id
      and a.status in ('awaiting_payment', 'paid')
      and a.completed_at is not null
      and not exists (select 1 from visit_rows vr where vr.appointment_id = a.id)
  ),
  attended_dates as (
    select distinct
      r.client_profile_id,
      (r.attended_at at time zone (select tz from params))::date as visit_date
    from (
      select client_profile_id, attended_at from visit_rows
      union all
      select client_profile_id, attended_at from appointment_rows
    ) r
    where r.attended_at <= now()
  ),
  visit_counts as (
    select ad.client_profile_id, count(*)::integer as completed_visits
    from attended_dates ad
    group by ad.client_profile_id
  ),
  spend as (
    select b.client_profile_id, sum(b.gross_cents)::bigint as total_spend_cents
    from billing.bills b
    join scoped_clients sc on sc.id = b.client_profile_id
    where b.business_id = p_business_id
      -- A voided bill is not spend. This is the whole of the refund/void rule.
      and b.status = 'paid'
    group by b.client_profile_id
  )
  select
    sc.id,
    sc.first_name,
    sc.last_name,
    sc.email::text,
    sc.phone,
    sc.marketing_opt_in,
    sc.primary_location_id,
    coalesce(vc.completed_visits, 0),
    coalesce(sp.total_spend_cents, 0::bigint)
  from scoped_clients sc
  left join visit_counts vc on vc.client_profile_id = sc.id
  left join spend sp on sp.client_profile_id = sc.id
  -- Only clients with something to measure. A client with no visits and no spend
  -- can never cross any milestone, so returning them would be pure noise.
  where coalesce(vc.completed_visits, 0) > 0 or coalesce(sp.total_spend_cents, 0) > 0
  order by sc.id
  limit (select row_limit from params)
  offset (select row_offset from params);
$$;

comment on function comms.campaign_loyalty_metrics(uuid, text, uuid[], integer, integer) is
  'Canonical loyalty metrics per client for milestone campaigns (0104). completed_visits reuses the '
  'exact attendance predicate and salon-local same-day collapse of crm.client_service_history (0097). '
  'total_spend_cents sums billing.bills.gross_cents for status=''paid'' only — integer pence, voided '
  'bills excluded. No parallel loyalty ledger exists or should exist.';

revoke all on function comms.campaign_loyalty_metrics(uuid, text, uuid[], integer, integer)
  from public, anon, authenticated;
grant execute on function comms.campaign_loyalty_metrics(uuid, text, uuid[], integer, integer)
  to service_role;

-- =============================================================================
-- 6. Birthday candidates — set-based, salon-local, leap-day aware
-- =============================================================================
--
-- Wrike sections 11 and 42. The caller passes the SALON-LOCAL date it wants
-- birthdays for (already resolved in the campaign's timezone — this function
-- never reads the clock), and gets back every client whose birthday falls on it.
--
-- LEAP DAY: a 29 February birthday is observed on 28 February in a common year.
-- Matches birthdayOccurrence() in @sheer/domain exactly; the TypeScript and the
-- SQL must agree because the preview renders from one and the send keys off the
-- other.
--
-- NULL and malformed dates simply do not match: date_of_birth is a `date`
-- column, so a malformed legacy value could never have been stored, and NULL
-- fails every comparison. A birthday is never inferred.

create or replace function comms.campaign_birthday_candidates(
  p_business_id uuid,
  p_target_date date,
  p_location_ids uuid[] default null,
  p_limit integer default 1000,
  p_offset integer default 0
)
returns table (
  client_profile_id uuid,
  first_name text,
  last_name text,
  email text,
  phone text,
  marketing_opt_in boolean,
  primary_location_id uuid,
  date_of_birth date
)
language sql
stable
as $$
  with params as (
    select
      least(greatest(coalesce(p_limit, 1000), 1), 1000) as row_limit,
      greatest(coalesce(p_offset, 0), 0) as row_offset,
      extract(month from p_target_date)::int as target_month,
      extract(day from p_target_date)::int as target_day,
      -- 28 February in a NON-leap year additionally observes 29 February
      -- birthdays. In a leap year it does not — those clients get their real day.
      (
        extract(month from p_target_date)::int = 2
        and extract(day from p_target_date)::int = 28
        and not (
          (extract(year from p_target_date)::int % 4 = 0
             and extract(year from p_target_date)::int % 100 <> 0)
          or extract(year from p_target_date)::int % 400 = 0
        )
      ) as observes_leap_day
  )
  select
    c.id,
    c.first_name,
    c.last_name,
    c.email::text,
    c.phone,
    c.marketing_opt_in,
    c.primary_location_id,
    c.date_of_birth
  from core.client_profiles c, params p
  where c.business_id = p_business_id
    and c.merged_into_id is null
    and c.date_of_birth is not null
    and (p_location_ids is null or c.primary_location_id = any (p_location_ids))
    and (
      (extract(month from c.date_of_birth)::int = p.target_month
        and extract(day from c.date_of_birth)::int = p.target_day)
      or (p.observes_leap_day
        and extract(month from c.date_of_birth)::int = 2
        and extract(day from c.date_of_birth)::int = 29)
    )
  order by c.id
  limit (select row_limit from params)
  offset (select row_offset from params);
$$;

comment on function comms.campaign_birthday_candidates(uuid, date, uuid[], integer, integer) is
  'Clients whose birthday falls on a given SALON-LOCAL date (0104). The caller resolves that date in '
  'the campaign''s timezone; this function never reads the clock. A 29 February birthday is observed '
  'on 28 February in a common year, matching birthdayOccurrence() in @sheer/domain — the two must '
  'agree because the preview renders from one and the send keys off the other.';

revoke all on function comms.campaign_birthday_candidates(uuid, date, uuid[], integer, integer)
  from public, anon, authenticated;
grant execute on function comms.campaign_birthday_candidates(uuid, date, uuid[], integer, integer)
  to service_role;

-- Birthday matching is a month/day scan, which no plain index on date_of_birth
-- can serve. This expression index makes it one.
create index if not exists idx_client_profiles_birthday_month_day
  on core.client_profiles (
    business_id,
    (extract(month from date_of_birth)),
    (extract(day from date_of_birth))
  )
  where date_of_birth is not null and merged_into_id is null;

-- Spend milestones scan settled bills per client.
create index if not exists idx_billing_bills_client_paid
  on billing.bills (business_id, client_profile_id)
  where status = 'paid';

-- =============================================================================
-- 7. RLS
-- =============================================================================
--
-- Campaign configuration is sensitive business configuration: it decides who
-- gets messaged. Only the OWNER may read or write it through the API's
-- authenticated path. Every write the platform actually performs goes through
-- the service role (which bypasses RLS) after the API has independently checked
-- the actor's role and permission — RLS here is defence in depth, not the only
-- gate.
--
-- NOTE THE REVOKE. Migration 0002 sets ALTER DEFAULT PRIVILEGES ... GRANT SELECT,
-- INSERT, UPDATE, DELETE ON TABLES TO authenticated for schema comms, so these
-- tables were born with full authenticated CRUD. A narrowing GRANT alone would
-- be a no-op — the broad grant has to be revoked first.

alter table comms.campaigns enable row level security;
alter table comms.campaign_runs enable row level security;
alter table comms.campaign_recipients enable row level security;

revoke all on comms.campaigns from authenticated;
revoke all on comms.campaign_runs from authenticated;
revoke all on comms.campaign_recipients from authenticated;

drop policy if exists comms_campaigns_owner_all on comms.campaigns;
create policy comms_campaigns_owner_all
on comms.campaigns for all
to authenticated
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

-- Runs and recipients are the audit trail of what the automation did. Owners may
-- read them; nobody may write them from a browser session. Every write comes
-- from the evaluator running as service_role.
drop policy if exists comms_campaign_runs_owner_select on comms.campaign_runs;
create policy comms_campaign_runs_owner_select
on comms.campaign_runs for select
to authenticated
using (public.is_business_owner(business_id));

drop policy if exists comms_campaign_recipients_owner_select on comms.campaign_recipients;
create policy comms_campaign_recipients_owner_select
on comms.campaign_recipients for select
to authenticated
using (public.is_business_owner(business_id));

grant select, insert, update, delete on comms.campaigns to authenticated;
grant select on comms.campaign_runs to authenticated;
grant select on comms.campaign_recipients to authenticated;

grant select, insert, update, delete
  on comms.campaigns, comms.campaign_runs, comms.campaign_recipients
  to service_role;
