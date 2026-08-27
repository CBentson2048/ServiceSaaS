-- 0097_client_lapse_intelligence.sql
-- Lapsed-client detection: usual booking interval & service history (V1.1 Week 7).
--
-- WHAT THIS DOES
--   1. crm.retention_settings — the ONE place the lapsed buffer lives. Business
--      default row (location_id is null) with an optional per-location override.
--      NO ROW means "inherit"; a row with lapsed_buffer_days = 0 is an
--      INTENTIONAL zero grace period. Null-vs-zero is structural, exactly as in
--      0096's pricing rules: absence inherits, presence (any value, incl. 0) wins.
--      core.location_settings could not carry this: its location_id is NOT NULL
--      UNIQUE, so it cannot express a business-wide default, and a client is
--      business-scoped (core.client_profiles.business_id NOT NULL,
--      primary_location_id NULLABLE) — a business-wide client cannot be governed
--      by a per-location-only setting.
--
--   2. crm.client_service_history — ONE set-based query returning each client's
--      recent completed service visits (collapsed to salon-local dates, with the
--      services on each) plus the salon-configured per-service rebooking interval
--      from their most recent visit. This exists so the API never loops
--      "for every client, query all appointments".
--
--   3. crm.client_next_bookings — each client's earliest VALID upcoming
--      appointment. The inverse of the existing `clientAlreadyRebooked` check
--      (notification-dispatch.service.ts:254-277); the same business-wide,
--      cancelled/no_show/rejected-excluding predicate, so a client who has
--      rebooked is never targeted for reactivation.
--
--   4. Two supporting indexes.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   - No stored is_lapsed / lapse_status column anywhere. The status is computed
--     on read from live appointment data, so it is automatically correct the
--     moment an appointment is booked, cancelled, completed or re-statused.
--     There is no cache to invalidate and no way for it to go stale.
--   - No cadence maths in SQL. The median/buffer/status rule lives in exactly one
--     place — evaluateClientLapse() in @sheer/domain — so campaigns, QLOOQO 10
--     reporting and (later) ZAC cannot drift into competing definitions.
--   - No global default return interval. A client with too little history and no
--     service that has opted into the 0062 rebooking nudge is reported as
--     insufficient history, never given an invented six-week cadence.
--
-- WHAT COUNTS AS A COMPLETED SERVICE VISIT (the canonical predicate)
--   booking.visits with status in ('completed','awaiting_payment','paid') and a
--   non-null, non-future attendance instant coalesce(completed_at, started_at,
--   checked_in_at)  — the same coalesce ladder crm.service.ts:1419-1430 already
--   uses for "Last visit", so the Client Hub and this feature never disagree;
--   UNION
--   booking.appointments with status in ('awaiting_payment','paid') and a
--   non-null, non-future completed_at, for the appointment-only history that
--   exists when no visit row was ever created. ('completed' was merged into
--   'paid' for appointments by 0045 and is no longer a valid appointment value;
--   booking.visits kept its own enum and 'completed' IS still valid there.)
--   Deduped against qualifying visits by appointment_id, then collapsed to one
--   visit per salon-local date.
--   Excluded throughout: cancelled, rejected, no_show, pending, accepted,
--   checked_in, and anything without an attendance timestamp.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Retention settings — where the configurable buffer lives
-- =============================================================================
create table if not exists crm.retention_settings (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- NULL = the business-wide default. A non-null location_id is an override
  -- applied when a caller scopes the query to that single location.
  location_id uuid references core.locations(id) on delete cascade,
  lapsed_buffer_days integer not null default 14,
  min_completed_visits integer not null default 3,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- `nulls not distinct` so the business-wide row is unique too (Postgres 15+;
  -- the same idiom core.client_profiles and booking.services already use).
  unique nulls not distinct (business_id, location_id)
);

-- 0 is a legitimate buffer ("no grace period at all"), so the floor is 0, not 1.
alter table crm.retention_settings
  drop constraint if exists retention_settings_buffer_days_range;
alter table crm.retention_settings
  add constraint retention_settings_buffer_days_range
  check (lapsed_buffer_days between 0 and 365);

-- Two completed visits are the fewest that can produce a single interval, so
-- that is the floor. Below it there is nothing to take a median of.
alter table crm.retention_settings
  drop constraint if exists retention_settings_min_visits_range;
alter table crm.retention_settings
  add constraint retention_settings_min_visits_range
  check (min_completed_visits between 2 and 20);

create index if not exists idx_retention_settings_business
  on crm.retention_settings (business_id);

comment on table crm.retention_settings is
  'Lapsed-client detection policy (0097). One business-wide row (location_id is '
  'null) plus optional per-location overrides. Absence of a row inherits the '
  'platform default; a stored value — including 0 — is an intentional override.';
comment on column crm.retention_settings.lapsed_buffer_days is
  'Grace days after the expected return date before a client counts as lapsed '
  '(at-risk in between). 0 means any overdue day is immediately lapsed. '
  'Platform default 14 — kept in sync with DEFAULT_LAPSE_DETECTION_SETTINGS.';
comment on column crm.retention_settings.min_completed_visits is
  'Completed visits required before a PERSONAL booking interval is claimed. '
  'Below this the client is reported as insufficient history rather than given '
  'a fabricated cadence. Platform default 3 (i.e. two measured intervals).';

drop trigger if exists retention_settings_set_updated_at on crm.retention_settings;
create trigger retention_settings_set_updated_at
before update on crm.retention_settings
for each row execute function public.set_updated_at();

alter table crm.retention_settings enable row level security;

drop policy if exists retention_settings_owner_all on crm.retention_settings;
create policy retention_settings_owner_all
on crm.retention_settings for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

drop policy if exists retention_settings_member_select on crm.retention_settings;
create policy retention_settings_member_select
on crm.retention_settings for select
using (exists (
  select 1 from core.user_memberships um
  where um.business_id = crm.retention_settings.business_id
    and um.user_profile_id = public.current_user_id()
    and um.status = 'active'
));

grant select, insert, update, delete on crm.retention_settings to authenticated, service_role;

-- =============================================================================
-- 2. Set-based service history
-- =============================================================================
--
-- Returns ONE row per client. `visits` is an ascending JSON array of
--   { visitDate, visitAt, locationId, services: [{serviceId, serviceName,
--     serviceCategoryId}] }
-- already collapsed to one entry per salon-local date (a client who had colour
-- and a cut on the same Tuesday returned ONCE — counting that as a zero-day
-- interval would drag their median toward zero).
--
-- History is always read BUSINESS-WIDE, never truncated to one location: a
-- client seen at another branch HAS returned, and calling them lapsed at branch
-- A because their last visit was at branch B would be wrong. `p_location_ids`
-- therefore selects WHICH CLIENTS are in scope (by primary_location_id), never
-- which of their visits count. Clients with a NULL primary_location_id match no
-- location filter — the same rule crm.service.ts listClients already applies.
--
-- `service_rebooking_interval_days` is the shortest ENABLED
-- booking.services.rebooking_nudge_interval_days (0062) among the services on
-- the client's most recent completed visit — 0062's own "nudge when the
-- soonest-due service is due" rule (rebooking-nudge.service.ts:151
-- `Math.min(...intervals)`), reused rather than reinvented. NULL when no service
-- on that visit has opted in, in which case there is no authoritative fallback.
--
-- Paging: p_limit/p_offset over a client_profile_id ordering. PostgREST caps any
-- response at config.toml `max_rows = 1000`, so the caller must page rather than
-- assume one call returns every client.
create or replace function crm.client_service_history(
  p_business_id uuid,
  p_timezone text,
  p_client_ids uuid[] default null,
  p_location_ids uuid[] default null,
  p_since timestamptz default null,
  p_max_visits integer default 10,
  p_limit integer default 1000,
  p_offset integer default 0
)
returns table (
  client_profile_id uuid,
  client_code text,
  first_name text,
  last_name text,
  email text,
  phone text,
  marketing_opt_in boolean,
  primary_location_id uuid,
  visits jsonb,
  service_rebooking_interval_days integer
)
language sql
stable
as $$
  with params as (
    select
      coalesce(nullif(btrim(p_timezone), ''), 'Europe/London') as tz,
      greatest(coalesce(p_max_visits, 10), 2) as max_visits,
      least(greatest(coalesce(p_limit, 1000), 1), 1000) as row_limit,
      greatest(coalesce(p_offset, 0), 0) as row_offset
  ),
  scoped_clients as (
    select c.id
    from core.client_profiles c
    where c.business_id = p_business_id
      -- 0087 merge tombstones are never a client in their own right.
      and c.merged_into_id is null
      and (p_client_ids is null or c.id = any (p_client_ids))
      and (p_location_ids is null or c.primary_location_id = any (p_location_ids))
  ),
  visit_rows as (
    select
      v.client_profile_id,
      coalesce(v.completed_at, v.started_at, v.checked_in_at) as attended_at,
      v.location_id,
      v.appointment_id
    from booking.visits v
    join scoped_clients sc on sc.id = v.client_profile_id
    where v.business_id = p_business_id
      and v.status in ('completed', 'awaiting_payment', 'paid')
      and coalesce(v.completed_at, v.started_at, v.checked_in_at) is not null
  ),
  appointment_rows as (
    select
      a.client_profile_id,
      a.completed_at as attended_at,
      a.location_id,
      a.id as appointment_id
    from booking.appointments a
    join scoped_clients sc on sc.id = a.client_profile_id
    where a.business_id = p_business_id
      and a.status in ('awaiting_payment', 'paid')
      and a.completed_at is not null
      -- Deduped against QUALIFYING visits only. A cancelled visit row must not
      -- erase a paid appointment; and because both land on the same local date,
      -- the per-date collapse below is a second backstop against double count.
      and not exists (
        select 1 from visit_rows vr where vr.appointment_id = a.id
      )
  ),
  attended as (
    select
      r.client_profile_id,
      r.attended_at,
      r.location_id,
      r.appointment_id,
      (r.attended_at at time zone (select tz from params))::date as visit_date
    from (
      select * from visit_rows
      union all
      select * from appointment_rows
    ) r
    where r.attended_at <= now()
      and (p_since is null or r.attended_at >= p_since)
  ),
  per_date as (
    select
      a.client_profile_id,
      a.visit_date,
      max(a.attended_at) as visit_at,
      (array_agg(a.location_id order by a.attended_at desc nulls last))[1] as location_id,
      array_remove(array_agg(distinct a.appointment_id), null) as appointment_ids
    from attended a
    group by a.client_profile_id, a.visit_date
  ),
  recent as (
    select p.*
    from (
      select
        d.*,
        row_number() over (
          partition by d.client_profile_id order by d.visit_date desc
        ) as rn
      from per_date d
    ) p
    where p.rn <= (select max_visits from params)
  ),
  with_services as (
    select
      r.client_profile_id,
      r.visit_date,
      r.visit_at,
      r.location_id,
      r.rn,
      coalesce(
        (
          select jsonb_agg(distinct jsonb_build_object(
            'serviceId', asv.service_id,
            -- The historic snapshot, so a renamed, re-priced or deactivated
            -- service still reads correctly on an old visit.
            'serviceName', asv.service_name_snapshot,
            'serviceCategoryId', s.service_category_id
          ))
          from booking.appointment_services asv
          left join booking.services s on s.id = asv.service_id
          where asv.appointment_id = any (r.appointment_ids)
        ),
        '[]'::jsonb
      ) as services,
      (
        select min(s2.rebooking_nudge_interval_days)
        from booking.appointment_services asv2
        join booking.services s2 on s2.id = asv2.service_id
        where asv2.appointment_id = any (r.appointment_ids)
          and s2.rebooking_nudge_enabled
      ) as nudge_interval_days
    from recent r
  )
  -- The client's display fields ride along on the same row. That removes an
  -- entire follow-up round trip AND the PostgREST URL-length hazard of sending
  -- a thousand ids back through an `in.(...)` filter.
  select
    ws.client_profile_id,
    c.client_code,
    c.first_name,
    c.last_name,
    c.email::text,
    c.phone,
    c.marketing_opt_in,
    c.primary_location_id,
    jsonb_agg(
      jsonb_build_object(
        'visitDate', to_char(ws.visit_date, 'YYYY-MM-DD'),
        'visitAt', ws.visit_at,
        'locationId', ws.location_id,
        'services', ws.services
      )
      order by ws.visit_date asc
    ) as visits,
    -- rn = 1 is the most recent visit; its services carry the fallback interval.
    min(ws.nudge_interval_days) filter (where ws.rn = 1) as service_rebooking_interval_days
  from with_services ws
  join core.client_profiles c on c.id = ws.client_profile_id
  group by
    ws.client_profile_id, c.client_code, c.first_name, c.last_name,
    c.email, c.phone, c.marketing_opt_in, c.primary_location_id
  order by ws.client_profile_id
  limit (select row_limit from params)
  offset (select row_offset from params);
$$;

comment on function crm.client_service_history(uuid, text, uuid[], uuid[], timestamptz, integer, integer, integer) is
  'Set-based completed service history per client for lapsed detection (0097). '
  'History is business-wide; p_location_ids scopes which CLIENTS are returned, '
  'never which of their visits count. Cadence maths deliberately lives in '
  '@sheer/domain evaluateClientLapse(), not here.';

revoke all on function crm.client_service_history(uuid, text, uuid[], uuid[], timestamptz, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function crm.client_service_history(uuid, text, uuid[], uuid[], timestamptz, integer, integer, integer)
  to service_role;

-- =============================================================================
-- 3. Valid upcoming bookings
-- =============================================================================
--
-- One row per client: their EARLIEST valid upcoming appointment. Mirrors the
-- established "has this client rebooked?" predicate exactly — business-wide,
-- strictly future, excluding cancelled / no_show / rejected. A cancelled future
-- appointment therefore gives a client NO protection from lapsing, which is the
-- required behaviour.
create or replace function crm.client_next_bookings(
  p_business_id uuid,
  p_client_ids uuid[] default null,
  p_location_ids uuid[] default null,
  p_now timestamptz default now(),
  p_limit integer default 1000,
  p_offset integer default 0
)
returns table (
  client_profile_id uuid,
  appointment_id uuid,
  scheduled_start_at timestamptz,
  location_id uuid
)
language sql
stable
as $$
  with params as (
    select
      coalesce(p_now, now()) as at_now,
      least(greatest(coalesce(p_limit, 1000), 1), 1000) as row_limit,
      greatest(coalesce(p_offset, 0), 0) as row_offset
  ),
  scoped_clients as (
    select c.id
    from core.client_profiles c
    where c.business_id = p_business_id
      and c.merged_into_id is null
      and (p_client_ids is null or c.id = any (p_client_ids))
      and (p_location_ids is null or c.primary_location_id = any (p_location_ids))
  ),
  upcoming as (
    select distinct on (a.client_profile_id)
      a.client_profile_id,
      a.id as appointment_id,
      a.scheduled_start_at,
      a.location_id
    from booking.appointments a
    join scoped_clients sc on sc.id = a.client_profile_id
    where a.business_id = p_business_id
      and a.scheduled_start_at > (select at_now from params)
      and a.status not in ('cancelled', 'no_show', 'rejected')
    order by a.client_profile_id, a.scheduled_start_at asc
  )
  select u.client_profile_id, u.appointment_id, u.scheduled_start_at, u.location_id
  from upcoming u
  order by u.client_profile_id
  limit (select row_limit from params)
  offset (select row_offset from params);
$$;

comment on function crm.client_next_bookings(uuid, uuid[], uuid[], timestamptz, integer, integer) is
  'Earliest valid upcoming appointment per client (0097). Same predicate as the '
  'rebooking-nudge suppression check: business-wide, strictly future, excluding '
  'cancelled/no_show/rejected.';

revoke all on function crm.client_next_bookings(uuid, uuid[], uuid[], timestamptz, integer, integer)
  from public, anon, authenticated;
grant execute on function crm.client_next_bookings(uuid, uuid[], uuid[], timestamptz, integer, integer)
  to service_role;

-- =============================================================================
-- 4. Indexes
-- =============================================================================
-- Existing coverage checked first, so these are the only two that are new work:
--   * booking.visits has (client_profile_id) and (primary_staff_profile_id) only
--     (0008) — nothing keyed on business_id, and nothing on the attendance
--     instant. The expression index below matches the exact coalesce ladder the
--     history function filters and orders on.
--   * booking.appointments already has a partial (business_id, location_id,
--     completed_at desc) WHERE status = 'paid' (0045). It misses
--     'awaiting_payment' and leads with location_id, so it cannot serve a
--     business-wide completed-visit window; the one below can.
-- Deliberately NOT added: an index for the upcoming-bookings scan.
-- idx_booking_appointments_business_location_start (business_id, location_id,
-- scheduled_start_at) already leads on business_id, so
-- `business_id = X and scheduled_start_at > now()` is an index scan with a
-- residual filter. A near-duplicate index would cost writes for no real gain.
create index if not exists idx_booking_visits_business_attended
  on booking.visits (business_id, (coalesce(completed_at, started_at, checked_in_at)) desc);

create index if not exists idx_booking_appointments_business_completed
  on booking.appointments (business_id, completed_at desc)
  where completed_at is not null;
