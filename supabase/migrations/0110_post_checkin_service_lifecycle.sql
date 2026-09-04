-- 0110_post_checkin_service_lifecycle.sql
-- Post-check-in service lifecycle: booked vs performed (QLOOQO V1.1, confirmed
-- by Luke — "check-in cannot make the service list immutable").
--
-- THE PRINCIPLE. QLOOQO must distinguish WHAT WAS BOOKED from WHAT WAS ACTUALLY
-- PERFORMED. What a client has done very often changes after consultation — a
-- toner, a treatment, half instead of full head — and the FINAL performed set
-- must drive the bill, service revenue, staff attribution, commission, reporting
-- and client history, while the original booking stays reconstructable and every
-- change stays auditable: who, what, when, at which appointment status, at what
-- price.
--
-- WHAT THIS ADDS
--   1. Provenance on booking.appointment_services. The line table stays the ONE
--      representation of an appointment's services; each row now says where it
--      came from (`origin`: booked | post_checkin_add | post_checkin_replace) and,
--      for post-check-in changes, who added/removed it and when. A line that is
--      NOT performed is `status = 'cancelled'` (an enum value that has existed
--      since 0004 but nothing wrote) with `removed_at` set — it is never deleted,
--      so "what did the client originally book?" is a plain WHERE clause:
--
--        booked    = origin = 'booked'            (any status)
--        performed = status <> 'cancelled'        (any origin)
--
--   2. booking.appointment_service_changes — the structured, append-only history
--      of every post-check-in mutation: action, actor (user + staff profile),
--      appointment status at the time, before/after snapshots with price and
--      staff attribution, optional reason, and an idempotency key. It survives
--      checkout and payment untouched. The platform-wide audit.activity_log entry
--      is written by the API as well (fail-soft, for the audit page); THIS table
--      is written atomically with the line change, so the history can never be
--      missing a step the bill relied on.
--
--   3. booking.amend_appointment_services(p_payload jsonb) — the single canonical
--      mutation: add / remove / replace / reassign one line, under a row lock on
--      the appointment (concurrent adds by two staff both survive; there is no
--      whole-array overwrite), validated for tenancy (service belongs to the
--      business, is active, and is salon-wide or scoped to the appointment's
--      location), guarded by lifecycle (only `checked_in` and `awaiting_payment`),
--      and idempotent on an optional key (a retried POST returns the original
--      change instead of adding a second line).
--
--   4. Two triggers. Lines of a PAID appointment are immutable: no caller may
--      update or delete one, and no signed-in client role may insert one —
--      post-payment correction is a refund/void/adjustment concern, not a silent
--      service edit. Trusted callers (service_role, superuser) may still INSERT,
--      which is how a seed or backfill CONSTRUCTS the record of an already-paid
--      historical visit; the app path cannot reach it, because every write after
--      arrival goes through amend_appointment_services and that refuses `paid`.
--      The change history is append-only. Both triggers step aside for a cascade
--      delete of the appointment itself, so demo seeds and account deletion work.
--
--   5. crm.client_service_history (0097) now counts only PERFORMED lines, so a
--      booked-but-not-performed service cannot set a client's rebooking cadence.
--
--   5b. booking.appointments.original_services_snapshot — T0, the selection the
--      appointment was FIRST created with, captured once by a statement trigger
--      and immutable thereafter. Provenance alone answers "booked at check-in"
--      and "performed"; this answers "originally booked", which a pre-check-in
--      edit would otherwise erase. NULL on every pre-0110 appointment, reported
--      as unavailable rather than guessed.
--
--   5c. The write boundary: `authenticated`/`anon` lose INSERT/UPDATE/DELETE on
--      booking.appointment_services, so every service change necessarily goes
--      through amend_appointment_services and therefore necessarily writes
--      history. SELECT is unchanged.
--
--   6. The `bookings.services.modify_after_checkin` permission, seeded onto every
--      system security level that works the floor or the desk. ⚠️ Pairing rule
--      (0086): the key also ships in PERMISSION_CATALOG in @sheer/domain in the
--      same change, or auth.service strips it on read.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   - No second line table, no appointment duplication, no event-sourcing. The
--     booked baseline is the set of `origin = 'booked'` rows exactly as they stood
--     at check-in (pre-check-in edits keep replacing them through the booking
--     editor, which is the existing behaviour and the useful business boundary).
--   - No diary rewrite. A post-check-in line has NO scheduled window and never
--     moves scheduled_end_at or occupied_ranges — the client is in the chair; the
--     booked schedule is preserved separately from the performed set.
--   - No stock recipe. Stock continues to move only through recorded QLAB
--     formula/product usage.
--   - No pricing rule of its own: price_amount snapshots booking.services.base_price
--     exactly as the booking flow does; the bill is frozen by 0085 at payment.

-- =============================================================================
-- 1. Provenance on the line table
-- =============================================================================

alter table booking.appointment_services
  add column if not exists origin text not null default 'booked',
  add column if not exists added_at timestamptz,
  add column if not exists added_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  add column if not exists removed_at timestamptz,
  add column if not exists removed_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  add column if not exists removal_reason text,
  add column if not exists replaces_appointment_service_id uuid references booking.appointment_services(id) on delete set null;

alter table booking.appointment_services
  drop constraint if exists booking_appointment_services_origin_check;
alter table booking.appointment_services
  add constraint booking_appointment_services_origin_check
  check (origin in ('booked', 'post_checkin_add', 'post_checkin_replace'));

-- A post-check-in line always knows when it was added; a removed line is always
-- status 'cancelled' (the reverse is not enforced, so a future cancellation flow
-- may mark lines cancelled without claiming a post-check-in removal).
alter table booking.appointment_services
  drop constraint if exists booking_appointment_services_origin_added_check;
alter table booking.appointment_services
  add constraint booking_appointment_services_origin_added_check
  check (origin = 'booked' or added_at is not null);

alter table booking.appointment_services
  drop constraint if exists booking_appointment_services_removed_status_check;
alter table booking.appointment_services
  add constraint booking_appointment_services_removed_status_check
  check (removed_at is null or status = 'cancelled');

comment on column booking.appointment_services.origin is
  'Provenance (0110): booked = part of the booking at check-in; post_checkin_add = added during the visit; post_checkin_replace = added during the visit in place of a booked line (see replaces_appointment_service_id).';
comment on column booking.appointment_services.removed_at is
  'Set when the line was taken off the performed set after check-in (status becomes cancelled). The row is kept so the original booking stays reconstructable.';
comment on column booking.appointment_services.replaces_appointment_service_id is
  'For post_checkin_replace lines: the booked line this one was performed instead of.';

create index if not exists idx_booking_appointment_services_appointment_status
  on booking.appointment_services (appointment_id, status);

-- =============================================================================
-- 2. Structured change history
-- =============================================================================

create table if not exists booking.appointment_service_changes (
  id uuid primary key default extensions.gen_random_uuid(),
  -- Monotonic insertion order. created_at is the transaction timestamp, so two
  -- changes committed in one transaction (or one fast retry) can tie on it;
  -- ordering by (created_at, change_no) is always the true sequence of events.
  change_no bigint generated by default as identity,
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  appointment_id uuid not null references booking.appointments(id) on delete cascade,
  -- The line this change produced or affected: the new line for added/replaced,
  -- the removed line for removed, the reassigned line for reassigned.
  appointment_service_id uuid references booking.appointment_services(id) on delete set null,
  -- For a replacement: the booked line that was performed instead of.
  replaced_appointment_service_id uuid references booking.appointment_services(id) on delete set null,
  action text not null check (action in ('added', 'removed', 'replaced', 'reassigned')),
  appointment_status_at_change booking.appointment_status_enum not null,
  actor_user_profile_id uuid references core.user_profiles(id) on delete set null,
  actor_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  actor_role core.membership_role_enum,
  -- Structured line snapshots: {lineId, serviceId, serviceName, priceAmount,
  -- staffProfileId, status, origin}. `before` for removed/replaced/reassigned,
  -- `after` for added/replaced/reassigned.
  before jsonb,
  after jsonb,
  reason text,
  idempotency_key text,
  created_at timestamptz not null default now()
);

comment on table booking.appointment_service_changes is
  'Append-only history of post-check-in service mutations (0110): who changed which line, how, at which appointment status, with price and staff snapshots. Survives checkout and payment.';

create index if not exists idx_booking_appointment_service_changes_appointment
  on booking.appointment_service_changes (appointment_id, created_at, change_no);

-- Retry safety: one change per (appointment, key). The amend function returns the
-- original change on a replay instead of applying it twice.
create unique index if not exists booking_appointment_service_changes_idempotency_key
  on booking.appointment_service_changes (appointment_id, idempotency_key)
  where idempotency_key is not null;

alter table booking.appointment_service_changes enable row level security;

drop policy if exists booking_appointment_service_changes_select on booking.appointment_service_changes;
create policy booking_appointment_service_changes_select
on booking.appointment_service_changes
for select
using (public.can_access_appointment(appointment_id));

-- 0002 default privileges hand `authenticated` full CRUD on every new booking
-- table; the history is written ONLY by the amend function through the API.
revoke insert, update, delete on booking.appointment_service_changes from anon, authenticated;
grant select on booking.appointment_service_changes to authenticated, service_role;
grant insert on booking.appointment_service_changes to service_role;

-- Append-only. A cascade from a deleted appointment is allowed (the parent row is
-- already gone when the child trigger fires), so seeds and account deletion work.
create or replace function booking.assert_appointment_service_change_append_only()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from booking.appointments a where a.id = old.appointment_id) then
      raise exception 'APPOINTMENT_SERVICE_HISTORY_APPEND_ONLY: service change history cannot be deleted';
    end if;
    return old;
  end if;
  raise exception 'APPOINTMENT_SERVICE_HISTORY_APPEND_ONLY: service change history cannot be edited';
end;
$$;

drop trigger if exists booking_appointment_service_changes_append_only on booking.appointment_service_changes;
create trigger booking_appointment_service_changes_append_only
  before update or delete on booking.appointment_service_changes
  for each row execute function booking.assert_appointment_service_change_append_only();

-- =============================================================================
-- 3. Paid appointments have immutable service lines
-- =============================================================================
--
-- The bill is frozen at payment (0085). After that the performed set is
-- historical evidence. The invariant, stated exactly:
--
--   UPDATE / DELETE of a paid appointment's line  -> refused for EVERY caller,
--                                                    service_role included.
--   INSERT by a signed-in client role             -> refused (authenticated, anon).
--   INSERT by a trusted caller                    -> ALLOWED, deliberately: that is
--                                                    how a seed or a backfill builds
--                                                    the record of an already-paid
--                                                    historical visit (appointment
--                                                    inserted as 'paid', then its
--                                                    lines). The application cannot
--                                                    reach it — every write after
--                                                    arrival goes through
--                                                    amend_appointment_services,
--                                                    which refuses `paid` first.
--
-- Corrections after payment are a refund/void/adjustment concern, never a silent
-- service edit. A cascade delete of the appointment itself is still allowed
-- (the parent row is already gone when the child trigger fires).
--
-- THE PARENT LOOKUP MUST NOT BE RLS-FILTERED. This trigger stays SECURITY
-- INVOKER, because the client-role arm below tests `current_user` and a
-- definer context would report the function owner instead. But a SECURITY
-- INVOKER lookup of the parent appointment is subject to the caller's RLS, and
-- an invisible parent would return no row — sending the guard down the
-- "cascade delete" path and letting the write through. That is a fail-OPEN:
-- booking.appointment_services' own manager policy keys on the NEW row's
-- business_id/location_id, which the caller supplies, so a location-scoped
-- manager could satisfy it for an appointment they cannot see. The status is
-- therefore resolved through booking.appointment_status_for_guard(), a narrow
-- SECURITY DEFINER helper that returns one enum value and nothing else.

-- The ONLY thing this helper exposes is one appointment's status enum, for one
-- id the caller already names. It reads no other column and returns no row data.
create or replace function booking.appointment_status_for_guard(p_appointment_id uuid)
returns booking.appointment_status_enum
language sql
stable
security definer
set search_path = public, booking, core
as $$
  select a.status from booking.appointments a where a.id = p_appointment_id;
$$;

comment on function booking.appointment_status_for_guard(uuid) is
  'Authoritative, RLS-independent status of one appointment, for the paid-immutability trigger only (0110). Returns a single enum value; exposes no row data.';

create or replace function booking.assert_appointment_services_mutable()
returns trigger
language plpgsql
set search_path = public, booking, core
as $$
declare
  v_appointment_id uuid := case when tg_op = 'DELETE' then old.appointment_id else new.appointment_id end;
  v_status booking.appointment_status_enum;
begin
  -- Definer helper: never RLS-filtered, so "no status" means the parent row is
  -- genuinely gone, not merely invisible to this caller.
  v_status := booking.appointment_status_for_guard(v_appointment_id);

  -- No parent row: the appointment itself is being deleted and these are its
  -- cascading children (demo seeds, account deletion). Nothing left to protect.
  if v_status is null then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  if v_status = 'paid' then
    -- CHANGING a line the frozen bill (0085) was computed from is refused for
    -- every caller, service_role included: post-payment corrections are a
    -- refund / void / adjustment, never a silent service edit.
    if tg_op in ('UPDATE', 'DELETE') then
      raise exception 'APPOINTMENT_PAID_IMMUTABLE: services of a paid appointment cannot be changed';
    end if;

    -- INSERT is narrower. A signed-in client role must never post a line onto a
    -- paid visit and claim more was performed than the bill charged. A trusted
    -- caller still may, because that is how a seed or backfill CONSTRUCTS an
    -- already-paid historical visit. `current_user` is meaningful here only
    -- because this function is SECURITY INVOKER.
    if current_user in ('authenticated', 'anon') then
      raise exception 'APPOINTMENT_PAID_IMMUTABLE: services of a paid appointment cannot be changed';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists booking_appointment_services_paid_immutable on booking.appointment_services;
create trigger booking_appointment_services_paid_immutable
  before insert or update or delete on booking.appointment_services
  for each row execute function booking.assert_appointment_services_mutable();

-- =============================================================================
-- 4. The canonical mutation
-- =============================================================================
--
-- Payload:
--   appointmentId, businessId          — tenancy; both required
--   action                             — add | remove | replace | reassign
--   serviceId                          — add / replace: the catalogue service
--   lineId                             — remove / replace / reassign: the target line
--   staffProfileId                     — add / replace: attribution (defaults to the
--                                        appointment's stylist); reassign: the new one
--   actorUserProfileId, actorStaffProfileId, actorRole — the authenticated actor,
--                                        NEVER taken from a client body
--   reason, idempotencyKey             — optional
--
-- Returns {changeId, lineId, replayed, alreadyApplied}. Raises with a stable
-- UPPER_SNAKE prefix the API maps to 404/409:
--   APPOINTMENT_NOT_FOUND, APPOINTMENT_NOT_AMENDABLE:<status>,
--   SERVICE_NOT_AVAILABLE, LINE_NOT_FOUND, LAST_PERFORMED_SERVICE,
--   STAFF_NOT_IN_BUSINESS, INVALID_ACTION.

create or replace function booking.amend_appointment_services(p_payload jsonb)
returns jsonb
language plpgsql
set search_path = public, booking, core
as $$
declare
  v_appointment_id uuid := nullif(p_payload->>'appointmentId', '')::uuid;
  v_business_id uuid := nullif(p_payload->>'businessId', '')::uuid;
  v_action text := lower(coalesce(p_payload->>'action', ''));
  v_service_id uuid := nullif(p_payload->>'serviceId', '')::uuid;
  v_line_id uuid := nullif(p_payload->>'lineId', '')::uuid;
  v_staff_id uuid := nullif(p_payload->>'staffProfileId', '')::uuid;
  v_actor_user uuid := nullif(p_payload->>'actorUserProfileId', '')::uuid;
  v_actor_staff uuid := nullif(p_payload->>'actorStaffProfileId', '')::uuid;
  v_actor_role core.membership_role_enum := nullif(p_payload->>'actorRole', '')::core.membership_role_enum;
  v_reason text := nullif(btrim(coalesce(p_payload->>'reason', '')), '');
  v_key text := nullif(p_payload->>'idempotencyKey', '');
  v_appt booking.appointments%rowtype;
  v_service booking.services%rowtype;
  v_line booking.appointment_services%rowtype;
  v_removed booking.appointment_services%rowtype;
  v_new_line booking.appointment_services%rowtype;
  v_existing booking.appointment_service_changes%rowtype;
  v_change_id uuid;
  v_line_status booking.appointment_service_status_enum;
  v_performed_count integer;
begin
  if v_appointment_id is null or v_business_id is null then
    raise exception 'INVALID_ACTION: appointmentId and businessId are required';
  end if;
  if v_action not in ('add', 'remove', 'replace', 'reassign') then
    raise exception 'INVALID_ACTION: unknown action %', v_action;
  end if;

  -- Serialise every amendment of one appointment. Two staff adding different
  -- services at once both get in; neither can overwrite the other.
  select * into v_appt
  from booking.appointments a
  where a.id = v_appointment_id and a.business_id = v_business_id
  for update;
  if not found then
    raise exception 'APPOINTMENT_NOT_FOUND: appointment % is not in this business', v_appointment_id;
  end if;

  -- Retry safety, decided under the same lock so a racing duplicate cannot slip
  -- between the check and the write.
  if v_key is not null then
    select * into v_existing
    from booking.appointment_service_changes c
    where c.appointment_id = v_appointment_id and c.idempotency_key = v_key;
    if found then
      return jsonb_build_object(
        'changeId', v_existing.id,
        'lineId', v_existing.appointment_service_id,
        'replayed', true,
        'alreadyApplied', false
      );
    end if;
  end if;

  if v_appt.status not in ('checked_in', 'awaiting_payment') then
    raise exception 'APPOINTMENT_NOT_AMENDABLE:%', v_appt.status;
  end if;

  -- A line added once the visit is complete is a performed service, not a
  -- scheduled one; before completion it follows the booked lines to 'completed'
  -- when the appointment is completed.
  v_line_status := case when v_appt.status = 'awaiting_payment' then 'completed' else 'scheduled' end;

  if v_action in ('add', 'replace') then
    if v_service_id is null then
      raise exception 'INVALID_ACTION: serviceId is required to % a service', v_action;
    end if;
    -- Tenancy + availability: the business's own active service, salon-wide or
    -- scoped to THIS appointment's location. Business A can never add Business
    -- B's service; a Pinner-only service cannot be added at Primrose Hill.
    select * into v_service
    from booking.services s
    where s.id = v_service_id
      and s.business_id = v_business_id
      and s.is_active
      and (s.location_id is null or s.location_id = v_appt.location_id);
    if not found then
      raise exception 'SERVICE_NOT_AVAILABLE: service % is not available at this location', v_service_id;
    end if;

    v_staff_id := coalesce(v_staff_id, v_appt.assigned_staff_profile_id);
    if v_staff_id is not null and not exists (
      select 1 from core.staff_profiles sp where sp.id = v_staff_id and sp.business_id = v_business_id
    ) then
      raise exception 'STAFF_NOT_IN_BUSINESS: staff profile % is not in this business', v_staff_id;
    end if;

    if v_action = 'replace' then
      if v_line_id is null then
        raise exception 'INVALID_ACTION: lineId is required to replace a service';
      end if;
      select * into v_removed
      from booking.appointment_services l
      where l.id = v_line_id and l.appointment_id = v_appointment_id
      for update;
      if not found or v_removed.status = 'cancelled' then
        raise exception 'LINE_NOT_FOUND: line % is not a performed service on this appointment', v_line_id;
      end if;
      update booking.appointment_services
      set status = 'cancelled',
          removed_at = now(),
          removed_by_user_profile_id = v_actor_user,
          removal_reason = v_reason
      where id = v_removed.id
      returning * into v_removed;
    end if;

    insert into booking.appointment_services (
      business_id, location_id, appointment_id, service_id, assigned_staff_profile_id,
      sequence_no, service_name_snapshot, duration_minutes, price_amount,
      deposit_required_amount, status, scheduled_start_at, scheduled_end_at,
      segments, origin, added_at, added_by_user_profile_id, replaces_appointment_service_id
    )
    values (
      v_business_id, v_appt.location_id, v_appointment_id, v_service.id, v_staff_id,
      (select coalesce(max(sequence_no), 0) + 1 from booking.appointment_services where appointment_id = v_appointment_id),
      v_service.name, greatest(v_service.estimated_duration_minutes, 1), v_service.base_price,
      0, v_line_status, null, null,
      '[]'::jsonb,
      case when v_action = 'replace' then 'post_checkin_replace' else 'post_checkin_add' end,
      now(), v_actor_user,
      case when v_action = 'replace' then v_removed.id else null end
    )
    returning * into v_new_line;

    insert into booking.appointment_service_changes (
      business_id, location_id, appointment_id, appointment_service_id,
      replaced_appointment_service_id, action, appointment_status_at_change,
      actor_user_profile_id, actor_staff_profile_id, actor_role, before, after, reason, idempotency_key
    )
    values (
      v_business_id, v_appt.location_id, v_appointment_id, v_new_line.id,
      case when v_action = 'replace' then v_removed.id else null end,
      case when v_action = 'replace' then 'replaced' else 'added' end,
      v_appt.status,
      v_actor_user, v_actor_staff, v_actor_role,
      case when v_action = 'replace' then booking.appointment_service_snapshot(v_removed) else null end,
      booking.appointment_service_snapshot(v_new_line),
      v_reason, v_key
    )
    returning id into v_change_id;

    return jsonb_build_object('changeId', v_change_id, 'lineId', v_new_line.id, 'replayed', false, 'alreadyApplied', false);
  end if;

  -- remove / reassign target an existing performed line.
  if v_line_id is null then
    raise exception 'INVALID_ACTION: lineId is required to % a service', v_action;
  end if;
  select * into v_line
  from booking.appointment_services l
  where l.id = v_line_id and l.appointment_id = v_appointment_id
  for update;
  if not found then
    raise exception 'LINE_NOT_FOUND: line % is not on this appointment', v_line_id;
  end if;

  if v_action = 'remove' then
    if v_line.status = 'cancelled' then
      -- Already off the performed set: a second remove is a no-op, not an error.
      select id into v_change_id
      from booking.appointment_service_changes c
      where c.appointment_service_id = v_line.id and c.action in ('removed', 'replaced')
      order by c.created_at desc
      limit 1;
      return jsonb_build_object('changeId', v_change_id, 'lineId', v_line.id, 'replayed', false, 'alreadyApplied', true);
    end if;
    select count(*) into v_performed_count
    from booking.appointment_services l
    where l.appointment_id = v_appointment_id and l.status <> 'cancelled';
    if v_performed_count <= 1 then
      raise exception 'LAST_PERFORMED_SERVICE: an appointment must keep at least one performed service — replace it instead';
    end if;

    update booking.appointment_services
    set status = 'cancelled',
        removed_at = now(),
        removed_by_user_profile_id = v_actor_user,
        removal_reason = v_reason
    where id = v_line.id
    returning * into v_removed;

    insert into booking.appointment_service_changes (
      business_id, location_id, appointment_id, appointment_service_id, action,
      appointment_status_at_change, actor_user_profile_id, actor_staff_profile_id, actor_role,
      before, after, reason, idempotency_key
    )
    values (
      v_business_id, v_appt.location_id, v_appointment_id, v_removed.id, 'removed',
      v_appt.status, v_actor_user, v_actor_staff, v_actor_role,
      booking.appointment_service_snapshot(v_line), null, v_reason, v_key
    )
    returning id into v_change_id;

    return jsonb_build_object('changeId', v_change_id, 'lineId', v_removed.id, 'replayed', false, 'alreadyApplied', false);
  end if;

  -- reassign
  if v_line.status = 'cancelled' then
    raise exception 'LINE_NOT_FOUND: line % is no longer a performed service', v_line_id;
  end if;
  if v_staff_id is null then
    raise exception 'INVALID_ACTION: staffProfileId is required to reassign a service';
  end if;
  if not exists (select 1 from core.staff_profiles sp where sp.id = v_staff_id and sp.business_id = v_business_id) then
    raise exception 'STAFF_NOT_IN_BUSINESS: staff profile % is not in this business', v_staff_id;
  end if;
  if v_line.assigned_staff_profile_id is not distinct from v_staff_id then
    select id into v_change_id
    from booking.appointment_service_changes c
    where c.appointment_service_id = v_line.id and c.action = 'reassigned'
    order by c.created_at desc
    limit 1;
    return jsonb_build_object('changeId', v_change_id, 'lineId', v_line.id, 'replayed', false, 'alreadyApplied', true);
  end if;

  update booking.appointment_services
  set assigned_staff_profile_id = v_staff_id
  where id = v_line.id
  returning * into v_new_line;

  insert into booking.appointment_service_changes (
    business_id, location_id, appointment_id, appointment_service_id, action,
    appointment_status_at_change, actor_user_profile_id, actor_staff_profile_id, actor_role,
    before, after, reason, idempotency_key
  )
  values (
    v_business_id, v_appt.location_id, v_appointment_id, v_line.id, 'reassigned',
    v_appt.status, v_actor_user, v_actor_staff, v_actor_role,
    booking.appointment_service_snapshot(v_line), booking.appointment_service_snapshot(v_new_line),
    v_reason, v_key
  )
  returning id into v_change_id;

  return jsonb_build_object('changeId', v_change_id, 'lineId', v_line.id, 'replayed', false, 'alreadyApplied', false);
end;
$$;

-- The structured before/after shape. One place, so every history row reads the same.
create or replace function booking.appointment_service_snapshot(p_line booking.appointment_services)
returns jsonb
language sql
immutable
as $$
  select jsonb_build_object(
    'lineId', p_line.id,
    'serviceId', p_line.service_id,
    'serviceName', p_line.service_name_snapshot,
    'priceAmount', p_line.price_amount,
    'staffProfileId', p_line.assigned_staff_profile_id,
    'status', p_line.status,
    'origin', p_line.origin
  );
$$;

comment on function booking.amend_appointment_services(jsonb) is
  'Canonical post-check-in service mutation (0110): add / remove / replace / reassign one line under an appointment row lock, tenancy-checked, lifecycle-guarded (checked_in, awaiting_payment), idempotent on an optional key, with an atomic history row.';

revoke all on function booking.amend_appointment_services(jsonb) from public, anon, authenticated;
grant execute on function booking.amend_appointment_services(jsonb) to service_role;
revoke all on function booking.appointment_service_snapshot(booking.appointment_services) from public, anon, authenticated;
grant execute on function booking.appointment_service_snapshot(booking.appointment_services) to service_role;
revoke all on function booking.assert_appointment_services_mutable() from public, anon, authenticated;
revoke all on function booking.assert_appointment_service_change_append_only() from public, anon, authenticated;
-- The guard helper is called from a SECURITY INVOKER trigger, so the CALLER needs
-- EXECUTE. Only trusted callers ever write this table (see the write boundary
-- below), so only they get it: if the boundary were ever loosened, a client role
-- would be refused by the function ACL instead of slipping past the guard —
-- fail-closed either way.
revoke all on function booking.appointment_status_for_guard(uuid) from public, anon, authenticated;
grant execute on function booking.appointment_status_for_guard(uuid) to service_role;

-- =============================================================================
-- 4b. The write boundary: appointment services are written by the API, not by
--     a browser
-- =============================================================================
--
-- 0002 grants `authenticated` full CRUD on every new table in these schemas by
-- default, and 0007's owner/manager FOR ALL policies then let a signed-in user
-- POST a service line straight at PostgREST — bypassing the permission key, the
-- lifecycle guard, idempotency, the structured history and the application
-- audit trail in one request. Every legitimate writer is the API, which holds
-- the service role (verified: every createClient in apps/api/src is constructed
-- with SUPABASE_SERVICE_ROLE_KEY, and no front end ships supabase-js at all).
--
-- SELECT is untouched: the diary, the client's own appointment view and the
-- history endpoint all still read through RLS exactly as before.
revoke insert, update, delete on booking.appointment_services from anon, authenticated;
grant select on booking.appointment_services to authenticated, service_role;
grant insert, update, delete on booking.appointment_services to service_role;


-- =============================================================================
-- 5. Lapse intelligence counts performed services only
-- =============================================================================
--
-- Identical to 0097 except that both line subqueries skip status = 'cancelled':
-- a booked-but-removed service must not define the client's next-visit cadence,
-- and a service added during the visit must.

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
            'serviceName', asv.service_name_snapshot,
            'serviceCategoryId', s.service_category_id
          ))
          from booking.appointment_services asv
          left join booking.services s on s.id = asv.service_id
          where asv.appointment_id = any (r.appointment_ids)
            -- 0110: performed lines only.
            and asv.status <> 'cancelled'
        ),
        '[]'::jsonb
      ) as services,
      (
        select min(s2.rebooking_nudge_interval_days)
        from booking.appointment_services asv2
        join booking.services s2 on s2.id = asv2.service_id
        where asv2.appointment_id = any (r.appointment_ids)
          and asv2.status <> 'cancelled'
          and s2.rebooking_nudge_enabled
      ) as nudge_interval_days
    from recent r
  )
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

-- =============================================================================
-- 5b. T0 — the ORIGINAL booking, preserved across a pre-check-in edit
-- =============================================================================
--
-- Provenance on the line table answers two of the three questions an owner asks
-- after payment:
--
--   T1  what was booked when the client arrived   origin = 'booked'
--   T2  what was actually performed               status <> 'cancelled'
--
-- It cannot answer the third. Before check-in the booking editor still replaces
-- the service list wholesale (delete + re-insert, unchanged behaviour), and the
-- replacement rows are indistinguishable from rows booked at creation — so a
-- consultation-by-phone swap made the day before erases what the client
-- originally asked for. Luke's requirement is explicit: "the original booking
-- shouldn't simply be overwritten and lost."
--
--   T0  what was originally booked                appointments.original_services_snapshot
--
-- WHY A SNAPSHOT AND NOT MORE ROWS. Keeping superseded lines in the line table
-- would need a fourth origin value, would drag stale rows through every
-- performed/booked query and every diary calculation, and would still not say
-- which generation a row belonged to. One immutable JSONB column, written once,
-- answers the question exactly and changes no existing query.
--
-- WHY A TRIGGER AND NOT FOUR CODE PATHS. Appointments are created in four
-- places (staff booking, client app, the deposit flow, stylist rebooking) and a
-- fifth would forget. Capture is therefore a database concern: the first
-- statement that gives an appointment any service lines writes the snapshot,
-- and nothing ever writes it again.

alter table booking.appointments
  add column if not exists original_services_snapshot jsonb;

comment on column booking.appointments.original_services_snapshot is
  'T0 (0110): the service selection this appointment was FIRST created with, captured once and never rewritten — so a pre-check-in edit cannot erase what the client originally booked. NULL means the original booking is not known (every appointment created before 0110): report it as unavailable, never substitute the current set.';

-- Captured from the whole statement, so one INSERT of N lines yields one
-- snapshot of N services. SECURITY DEFINER because it writes booking.appointments
-- on behalf of whoever inserted the lines; it computes its own value and takes
-- nothing from the caller but the appointment ids in the transition table.
create or replace function booking.capture_original_services()
returns trigger
language plpgsql
security definer
set search_path = public, booking, core
as $$
begin
  update booking.appointments a
  set original_services_snapshot = (
    select jsonb_agg(
             jsonb_build_object(
               'serviceId', s.service_id,
               'serviceName', s.service_name_snapshot,
               'priceAmount', s.price_amount,
               'durationMinutes', s.duration_minutes,
               'staffProfileId', s.assigned_staff_profile_id,
               'sequenceNo', s.sequence_no
             )
             order by s.sequence_no, s.id
           )
    from booking.appointment_services s
    where s.appointment_id = a.id
  )
  where a.id in (select distinct n.appointment_id from new_rows n)
    -- Write once.
    and a.original_services_snapshot is null
    -- ONLY at creation. A line added after the client arrives, and a seed
    -- building an already-paid historical visit, must never be labelled "the
    -- original booking" — an appointment that reaches this point without a
    -- snapshot simply has none, which is the honest answer (§1C).
    and a.status in ('pending', 'accepted');
  return null;
end;
$$;

drop trigger if exists booking_appointment_services_capture_original on booking.appointment_services;
create trigger booking_appointment_services_capture_original
  after insert on booking.appointment_services
  referencing new table as new_rows
  for each statement execute function booking.capture_original_services();

-- Write-once, enforced at the table: a pre-check-in edit, a post-check-in
-- amendment and payment all leave it exactly as first written.
create or replace function booking.assert_original_services_snapshot_write_once()
returns trigger
language plpgsql
as $$
begin
  if old.original_services_snapshot is not null
     and new.original_services_snapshot is distinct from old.original_services_snapshot then
    raise exception 'ORIGINAL_BOOKING_IMMUTABLE: the original booking snapshot is written once and never changed';
  end if;
  return new;
end;
$$;

drop trigger if exists booking_appointments_original_snapshot_write_once on booking.appointments;
create trigger booking_appointments_original_snapshot_write_once
  before update on booking.appointments
  for each row execute function booking.assert_original_services_snapshot_write_once();

revoke all on function booking.capture_original_services() from public, anon, authenticated;
revoke all on function booking.assert_original_services_snapshot_write_once() from public, anon, authenticated;

-- NO BACKFILL. An appointment created before this migration has no reliable
-- record of its original selection: its current lines may already be the result
-- of a pre-check-in edit, and nothing distinguishes the two. Writing today's set
-- and calling it "original" would be a fabrication, so the column stays NULL and
-- the API reports originalBookingAvailable = false.

-- =============================================================================
-- 6. Permission
-- =============================================================================
--
-- Every system level that works the floor or the desk: the stylist adding a
-- toner mid-appointment, the receptionist adding a treatment before checkout,
-- the manager reconciling a consultation change. Stylists are still scoped to
-- their own column by the API (assertCanAccessAppointment).

update core.security_levels
set permissions = permissions || '["bookings.services.modify_after_checkin"]'::jsonb
where is_system = true
  and key in ('owner', 'group_admin', 'manager', 'receptionist', 'stylist')
  -- Idempotent: re-running never duplicates the key inside the jsonb array.
  and not (permissions ? 'bookings.services.modify_after_checkin');
