-- 0103_upsell_suggestions.sql
-- Rule-based upsell suggestions: owner-configured add-on rules + a deterministic
-- historical booking-pattern signal (QLOOQO V1.1, Wrike 4507283916).
--
-- WHAT THIS DOES
--   1. booking.upsell_rules — the owner's salon intent, expressed as
--      "when X is booked, suggest Y". X is either ONE service or ONE service
--      category (trigger_type); Y is always one service. A rule is business-wide
--      (location_id is null) or pinned to one location, exactly as
--      booking.service_upgrade_suggestions and crm.retention_settings already
--      scope themselves: absence inherits, presence wins.
--
--   2. booking.service_cooccurrence(...) — ONE set-based query answering
--      "of the completed appointments containing service A, how many also
--      contained service B?". No ML, no scoring, no stored recommendations:
--      counts only, recomputed on read.
--
--   3. Two supporting indexes for the co-occurrence scan.
--
-- WHY A NEW TABLE RATHER THAN EXTENDING booking.service_upgrade_suggestions
--   0019's table is the CLIENT-facing upgrade prompt shown during online
--   self-booking: title + description are NOT NULL because they are marketing
--   copy the client reads, and trigger_service_id is NOT NULL. Upsell rules are
--   a STAFF-facing operational tool with a different shape (category triggers,
--   priority, suppression semantics) and a different audience. Relaxing 0019's
--   NOT NULLs to fit would have let a category-trigger row surface in
--   public-booking.service.ts with a null triggerServiceId, which its response
--   contract types as a string. The two tables stay independent on purpose;
--   neither reads the other.
--
-- ENABLED = FALSE IS SUPPRESSION, NOT MERELY "OFF" (the decision Wrike left open)
--   A disabled rule does not just stop producing its own suggestion — it stops
--   the (trigger, suggested service) relationship being suggested at all in that
--   scope, including by the historical pattern engine. An owner who switches
--   "Full Head Colour -> Toner" off has said "do not suggest Toner for Colour
--   here", and history must not talk them back into it. This is the safest
--   reading of an explicit owner action; the precedence order that implements it
--   lives in resolveUpsellRule() in @sheer/domain, not in SQL.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   - No stored suggestions table. Suggestions are derived from live rules +
--     live history + the live booking context on every read, so a rule toggle or
--     a newly added service line is reflected on the very next call, with no
--     cache to invalidate and no stale recommendation to explain away.
--   - No thresholds baked into SQL. min base sample / min co-occurrence / min
--     rate arrive as parameters from UPSELL_PATTERN_THRESHOLDS in @sheer/domain,
--     so there is exactly one place to change them.
--   - No writes of any kind. Nothing here can add a service, alter a booking or
--     touch a bill; the whole feature is read-only by construction.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Owner-configured rules
-- =============================================================================

create table if not exists booking.upsell_rules (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- NULL = business-wide default; set = applies only at that location.
  location_id uuid references core.locations(id) on delete cascade,
  name text not null,
  enabled boolean not null default true,
  trigger_type text not null check (trigger_type in ('service', 'service_category')),
  trigger_service_id uuid references booking.services(id) on delete cascade,
  trigger_service_category_id uuid references booking.service_categories(id) on delete cascade,
  suggested_service_id uuid not null references booking.services(id) on delete cascade,
  -- Higher wins. Bounded so a stray value cannot dominate every other rule.
  priority integer not null default 0 check (priority between 0 and 1000),
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint upsell_rules_name_not_blank check (length(btrim(name)) > 0),
  -- Exactly one trigger, and it must be the one trigger_type names.
  constraint upsell_rules_trigger_matches_type check (
    (trigger_type = 'service'
      and trigger_service_id is not null
      and trigger_service_category_id is null)
    or (trigger_type = 'service_category'
      and trigger_service_category_id is not null
      and trigger_service_id is null)
  ),
  -- A service can never suggest itself (Wrike §10). Enforced here as well as in
  -- the DTO so no code path — backfill, script or future caller — can create one.
  constraint upsell_rules_no_self_suggestion check (
    trigger_service_id is null or trigger_service_id <> suggested_service_id
  )
);

comment on table booking.upsell_rules is
  'Owner-configured add-on rules: "when this service (or service category) is booked, suggest this service". '
  'location_id null = business-wide default, set = that location only. enabled=false SUPPRESSES the relationship '
  'in scope, including against the historical pattern engine — it is not merely a pause. Consumed by '
  'UpsellSuggestionService at booking and checkout; nothing here is ever applied automatically.';

comment on column booking.upsell_rules.priority is
  'Owner ranking hint, 0-1000, higher first. Ranks suggestions; it does NOT decide enable-vs-suppress — '
  'scope specificity does (location beats business-wide, service trigger beats category trigger).';

comment on column booking.upsell_rules.enabled is
  'false = the owner has explicitly said "do not suggest this add-on for this trigger in this scope". '
  'The pattern engine cannot reintroduce a suppressed pair.';

-- Duplicate prevention (Wrike §32), split by trigger_type so each partial index
-- constrains the trigger column that is actually populated. NULLS NOT DISTINCT
-- makes the business-wide (location_id is null) row collide with itself, while
-- still permitting a deliberate business-default + location-specific pair.
create unique index if not exists uq_upsell_rules_service_trigger
  on booking.upsell_rules (business_id, location_id, trigger_service_id, suggested_service_id)
  nulls not distinct
  where trigger_type = 'service';

create unique index if not exists uq_upsell_rules_category_trigger
  on booking.upsell_rules (business_id, location_id, trigger_service_category_id, suggested_service_id)
  nulls not distinct
  where trigger_type = 'service_category';

-- Hot path: every rule whose trigger is one of the services/categories in the
-- current booking context, for this business.
create index if not exists idx_upsell_rules_business_trigger_service
  on booking.upsell_rules (business_id, trigger_service_id)
  where trigger_service_id is not null;

create index if not exists idx_upsell_rules_business_trigger_category
  on booking.upsell_rules (business_id, trigger_service_category_id)
  where trigger_service_category_id is not null;

-- Support FK cascade cleanup when a service, category or location is deleted.
create index if not exists idx_upsell_rules_suggested_service
  on booking.upsell_rules (suggested_service_id);

create index if not exists idx_upsell_rules_location
  on booking.upsell_rules (location_id)
  where location_id is not null;

drop trigger if exists upsell_rules_set_updated_at on booking.upsell_rules;
create trigger upsell_rules_set_updated_at
before update on booking.upsell_rules
for each row execute function public.set_updated_at();

-- RLS. 0002 grants `authenticated` full CRUD by default on every new table in
-- the booking schema, so these policies — not the grants — are the tenancy
-- boundary. Owners manage; any active member of the business may read (staff
-- need to see which suggestions are configured, but never to edit them).
alter table booking.upsell_rules enable row level security;

drop policy if exists upsell_rules_owner_all on booking.upsell_rules;
create policy upsell_rules_owner_all
on booking.upsell_rules for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists upsell_rules_member_select on booking.upsell_rules;
create policy upsell_rules_member_select
on booking.upsell_rules for select
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = booking.upsell_rules.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

grant select, insert, update, delete on booking.upsell_rules to authenticated, service_role;

-- =============================================================================
-- 2. Historical booking-pattern signal (service co-occurrence)
-- =============================================================================
--
-- Deterministic and explainable: for each trigger service it returns the number
-- of completed appointments containing it (base_count) and, per other service,
-- how many of those also contained that service (cooccurrence_count). Same data
-- in, same counts out — there is no model, no randomness and no state.
--
-- WHAT COUNTS AS EVIDENCE (Wrike §14)
--   booking.appointments with status in ('awaiting_payment','paid') and a
--   non-null, not-in-the-future completed_at. This is the same predicate
--   crm.client_service_history (0097) uses for appointment-only history, so
--   lapse detection and upsell never disagree about what "completed" means.
--   'completed' is NOT a valid appointment status — 0045 merged it into 'paid'.
--   Excluded: pending, accepted, rejected, checked_in, cancelled, no_show, and
--   anything with no completion instant. Individually cancelled service LINES
--   are excluded too, so a service removed at checkout stops being evidence.
--
-- SCOPE (Wrike §13)
--   Business-wide, never cross-business: p_business_id is filtered on the
--   appointment AND on the service line. History is deliberately NOT narrowed to
--   one location — a two-chair second site would never reach a usable sample —
--   so the caller MUST still validate that a suggested service is available at
--   the acting location. UpsellSuggestionService does exactly that.
--
-- BOUNDS (Wrike §36)
--   p_since bounds the scan to a lookback window, p_max_rows caps the result,
--   and the thresholds prune before rows are returned. One query answers every
--   trigger service in the context — never one query per candidate.
create or replace function booking.service_cooccurrence(
  p_business_id uuid,
  p_trigger_service_ids uuid[],
  p_since timestamptz default null,
  p_min_base_sample integer default 10,
  p_min_cooccurrence integer default 3,
  p_min_rate numeric default 0.2,
  p_max_rows integer default 200
)
returns table (
  trigger_service_id uuid,
  suggested_service_id uuid,
  base_count integer,
  cooccurrence_count integer
)
language sql
stable
as $$
  with bounds as (
    select
      greatest(coalesce(p_min_base_sample, 10), 1) as min_base,
      greatest(coalesce(p_min_cooccurrence, 3), 1) as min_cooc,
      least(greatest(coalesce(p_min_rate, 0.2), 0), 1) as min_rate,
      least(greatest(coalesce(p_max_rows, 200), 1), 500) as row_limit
  ),
  completed_appointments as (
    select a.id
    from booking.appointments a
    where a.business_id = p_business_id
      and a.status in ('awaiting_payment', 'paid')
      and a.completed_at is not null
      and a.completed_at <= now()
      and (p_since is null or a.completed_at >= p_since)
  ),
  -- DISTINCT: the same service booked twice on one appointment is one piece of
  -- evidence, not two, for both the base count and the pair count.
  appointment_service_set as (
    select distinct s.appointment_id, s.service_id
    from booking.appointment_services s
    join completed_appointments ca on ca.id = s.appointment_id
    where s.business_id = p_business_id
      and s.status <> 'cancelled'
  ),
  base as (
    select
      ass.service_id as trigger_service_id,
      count(*)::integer as base_count
    from appointment_service_set ass
    where ass.service_id = any (p_trigger_service_ids)
    group by ass.service_id
  ),
  pairs as (
    select
      a.service_id as trigger_service_id,
      b.service_id as suggested_service_id,
      count(*)::integer as cooccurrence_count
    from appointment_service_set a
    join appointment_service_set b
      on b.appointment_id = a.appointment_id
     and b.service_id <> a.service_id
    where a.service_id = any (p_trigger_service_ids)
    group by a.service_id, b.service_id
  )
  select
    p.trigger_service_id,
    p.suggested_service_id,
    b.base_count,
    p.cooccurrence_count
  from pairs p
  join base b on b.trigger_service_id = p.trigger_service_id
  cross join bounds
  where b.base_count >= bounds.min_base
    and p.cooccurrence_count >= bounds.min_cooc
    and p.cooccurrence_count::numeric / b.base_count::numeric >= bounds.min_rate
  -- Deterministic total order: ties broken by id so the same data always
  -- returns the same rows in the same sequence.
  order by
    p.cooccurrence_count desc,
    p.trigger_service_id,
    p.suggested_service_id
  limit (select row_limit from bounds);
$$;

comment on function booking.service_cooccurrence(uuid, uuid[], timestamptz, integer, integer, numeric, integer) is
  'Deterministic service co-occurrence over COMPLETED appointments (0103). Counts only — no scoring, no ML. '
  'History is business-wide; the caller must still validate that a suggested service is active and available '
  'at the acting location. Thresholds are parameters, sourced from UPSELL_PATTERN_THRESHOLDS in @sheer/domain.';

-- Called only by the API, which holds the service-role key. No PUBLIC, anon or
-- authenticated execute: a client-side caller could otherwise pass any
-- p_business_id and read another salon''s booking history.
revoke all on function booking.service_cooccurrence(uuid, uuid[], timestamptz, integer, integer, numeric, integer)
  from public, anon, authenticated;
grant execute on function booking.service_cooccurrence(uuid, uuid[], timestamptz, integer, integer, numeric, integer)
  to service_role;

-- =============================================================================
-- 3. Indexes supporting the co-occurrence scan
-- =============================================================================

-- The completed-appointment window. The existing idx_booking_appointments_completed_at
-- is partial on `status = 'paid'` only, so it cannot serve a predicate that also
-- accepts 'awaiting_payment'.
create index if not exists idx_booking_appointments_business_completed_window
  on booking.appointments (business_id, completed_at desc)
  where status in ('awaiting_payment', 'paid') and completed_at is not null;

-- The trigger side of the self-join: service lines for a business by service.
-- The existing idx_booking_appointment_services_appointment_id already serves
-- the co-occurring side.
create index if not exists idx_booking_appointment_services_business_service
  on booking.appointment_services (business_id, service_id, appointment_id);
