-- 0099_in_app_notifications.sql
-- In-app notification service layer (V1.1, Wrike "Add in-app notification service
-- layer"). The reusable foundation that arrival alerts consume now and the Week 10
-- notification centre consumes later.
--
-- WHY NEW TABLES RATHER THAN comms.notification_events
--   comms.notification_events is the OUTBOUND CLIENT messaging outbox (booking
--   confirmations and reminders sent to clients over WhatsApp/SMS/Email). It is
--   the wrong home for a staff-facing in-app feed, for six concrete reasons —
--   each one a defect we would be shipping, not a matter of taste:
--
--     1. The dispatcher CANCELS what it does not recognise. process() cancels any
--        row whose channel is outside whatsapp/sms/email, and cancels any row no
--        NotificationSubjectResolver claims. An in-app row is protected today only
--        by a code-level `.in('channel', …)` filter on the due query — one widened
--        filter and every in-app notification is silently destroyed.
--     2. status = 'read' is ALREADY TAKEN. It means "the WhatsApp recipient opened
--        the message" and is written straight onto notification_events by the
--        Twilio status webhook. Overloading it for in-app read state would put an
--        external webhook in charge of a user's unread badge.
--     3. Its dedupe index is (business_id, dedupe_key, channel) — BUSINESS-scoped.
--        Fanning one notification out to five staff with one dedupe key would
--        insert exactly one row and silently drop four.
--     4. notification_events_booking_event_unique_idx is (appointment_id,
--        event_key, channel), so one appointment could carry only ONE arrival
--        notification total — not one per recipient.
--     5. Its RLS grants no per-user isolation: comms_notification_events_location_select
--        is location-wide, so every desk-access user at a location would read every
--        other user's notifications. Worse, the 0007 DO-loop policies on that table
--        carry no `to authenticated` clause and therefore apply to PUBLIC.
--     6. notification_events <-> message_logs are a circular FK pair; adding a
--        third concern to that knot makes both harder to reason about.
--
--   So this migration adds a separate, purpose-built model in the SAME schema,
--   following the SAME conventions, and deliberately reuses the established
--   patterns: durable rows (never an in-memory queue), unique-index idempotency,
--   service-role writes, RLS as defence-in-depth, and the comms helper functions.
--
-- WHAT THIS DOES
--   1. comms.notifications — one row per logical notification (the content/event).
--   2. comms.notification_recipients — per-user delivery + read state. Separating
--      the two is what lets one notification target many users and lets the Owner
--      read it while the Manager's copy stays unread.
--   3. comms.user_devices — the user/device targeting foundation for future push.
--   4. comms.create_notification(...) — the ONE atomic creation entry point:
--      validates tenancy/location/recipient eligibility, writes the notification
--      and every recipient row in a single statement-level transaction, and is
--      idempotent on dedupe_key.
--   5. comms.register_user_device(...) — safe device upsert with push-token
--      takeover, so one physical device can never receive duplicate pushes.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   - No APNs/FCM delivery, no push provider, no notification-preference matrix,
--     no WebSockets, no notification-centre UI. This is the foundation only.
--   - No new value on comms.channel_enum or comms.notification_status_enum. Both
--     already carry 'in_app'/'push' (unused), and `alter type … add value` cannot
--     be referenced in the transaction that adds it. Nothing here needs one.
--   - No change to comms.notification_events, comms.message_logs or the outbound
--     dispatcher. The outbound path is untouched by this migration.
--   - No notification TYPE enum. The canonical registry is the const object
--     NotificationType in @sheer/domain, mirroring how notification_events.event_key
--     is plain text with NotificationEventKey as its registry. That is what keeps
--     future types (zac_opportunity, low_stock, …) additive in code rather than a
--     schema migration.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Notification content/event
-- =============================================================================

create table if not exists comms.notifications (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- Null for a business-wide notification (e.g. an owner alert that is not about
  -- one salon). Not every notification has a location, so this is not forced.
  location_id uuid references core.locations(id) on delete cascade,
  -- Canonical registry: NotificationType in @sheer/domain. Text, not an enum, so a
  -- new producer ships without a migration — exactly how notification_events.event_key
  -- and its NotificationEventKey registry already work.
  type text not null check (length(btrim(type)) > 0),
  -- Closed set that will not grow with new producers, so a check constraint is
  -- right here where an enum-of-types would not be.
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  title text not null check (length(btrim(title)) > 0),
  body text not null,
  -- Structured routing context, so the UI never has to parse the body string to
  -- know where a notification points.
  entity_type text,
  entity_id uuid,
  action_path text,
  metadata jsonb not null default '{}'::jsonb,
  -- Caller-supplied idempotency key. Business-scoped (NOT per recipient): the
  -- notification is the logical event and recipients fan out from it, so one
  -- retried check-in must produce one notification with N recipients — never N
  -- notifications, and never (the notification_events failure mode) one recipient.
  dedupe_key text,
  created_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  -- Optional lifetime. An expired notification is excluded from the feed and from
  -- the unread count rather than deleted, so history stays intact.
  expires_at timestamptz,
  constraint notifications_entity_pairing
    check ((entity_type is null) = (entity_id is null))
);

comment on table comms.notifications is
  'One row per logical in-app notification (the content/event). Per-user delivery '
  'and read state live in comms.notification_recipients, which is what lets a single '
  'notification target many users without duplicating its content. Written only by '
  'comms.create_notification(); the API service role is the only writer.';
comment on column comms.notifications.type is
  'Canonical type key. The registry is the NotificationType const object in '
  '@sheer/domain — deliberately text rather than an enum so a new producer '
  '(zac_opportunity, low_stock, …) is a code change, not a migration. Mirrors '
  'comms.notification_events.event_key / NotificationEventKey.';
comment on column comms.notifications.dedupe_key is
  'Idempotency key, unique per business FOR ALL TIME — expiry does NOT release it, '
  'and a key is never reusable once consumed (see idx_notifications_dedupe_unique). '
  'Scoped to the business and NOT to the recipient, because one logical event fans '
  'out to N recipients: a double-submitted check-in must yield one notification with '
  'the same recipient set, not a second copy. Example: '
  '''client_arrived:<appointment-id>''. A caller that wants the same KIND of '
  'notification to recur must vary the key itself (''…:2026-08-28''). NULL means '
  '"no dedupe" and never collides.';
comment on column comms.notifications.entity_type is
  'Structured routing context (''appointment'', ''purchase_order'', …) paired with '
  'entity_id, so the UI routes from data rather than by parsing the body text. '
  'Both null or both set — enforced by notifications_entity_pairing.';
comment on column comms.notifications.action_path is
  'Relative in-app path the notification opens (e.g. ''/appointments/<id>''). '
  'Relative by design: the same record serves web and mobile.';
comment on column comms.notifications.expires_at is
  'Optional expiry. Past-dated rows are filtered out of the feed and the unread '
  'count (they stay in the table as history). NULL means it never expires.';
comment on column comms.notifications.metadata is
  'Small, UI-safe structured extras only. Never a copy of the source record: '
  'notifications are rendered on lock screens and shared devices, so client notes, '
  'medical/allergy data, payroll figures and ZAC memory must not be duplicated here. '
  'Reference the entity instead and let the target screen re-authorise the read.';

-- One notification per (business, dedupe_key), for all time. Deliberately NOT
-- scoped to "unexpired": an index predicate cannot call now(), and a key that
-- silently becomes reusable once a notification lapses would make idempotency
-- depend on wall-clock timing. A caller that wants a recurring notification puts
-- the recurrence in the key itself (…:2026-08-28), which is explicit.
create unique index if not exists idx_notifications_dedupe_unique
  on comms.notifications (business_id, dedupe_key)
  where dedupe_key is not null;

create index if not exists idx_notifications_business_created
  on comms.notifications (business_id, created_at desc);

create index if not exists idx_notifications_entity
  on comms.notifications (business_id, entity_type, entity_id)
  where entity_type is not null;

-- =============================================================================
-- 2. Per-recipient delivery + read state
-- =============================================================================

create table if not exists comms.notification_recipients (
  id uuid primary key default extensions.gen_random_uuid(),
  notification_id uuid not null references comms.notifications(id) on delete cascade,
  -- Denormalised from the parent so the feed query, its indexes and the RLS
  -- policy are all single-table. Kept honest by comms.create_notification(), the
  -- only writer, and by notification_recipients_business_matches below.
  business_id uuid not null references core.businesses(id) on delete cascade,
  user_profile_id uuid not null references core.user_profiles(id) on delete cascade,
  -- Delivered/displayed, as distinct from actually read. Optional: the feed works
  -- with read_at alone, and seen_at simply stays null until a client sets it.
  seen_at timestamptz,
  -- NULL = unread. A timestamp, not a boolean, so "when did they read it" survives
  -- and marking unread is a real state change rather than losing information.
  read_at timestamptz,
  -- Mirrors the parent's created_at so "my notifications, newest first" is an
  -- index-only ordering on this table instead of a sort over a join.
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per user per notification. Re-targeting the same user is a no-op, not
  -- a second unread badge.
  unique (notification_id, user_profile_id)
);

comment on table comms.notification_recipients is
  'Per-user state for one notification: who it targeted, whether they have seen it '
  'and whether they have read it. Separate from comms.notifications so one logical '
  'notification can target many users and each keeps independent read state — the '
  'Owner reading a notification must not mark it read for the Manager. This is the '
  'ONLY table a mark-read/mark-unread ever writes.';
comment on column comms.notification_recipients.read_at is
  'NULL = unread; a timestamp = read. Mark-unread sets it back to NULL. Modelled as '
  'a timestamp rather than a boolean so the read moment is preserved, and so the '
  'unread count is a partial-index scan on `read_at is null`.';
comment on column comms.notification_recipients.seen_at is
  'When the notification was delivered/displayed to this user, as distinct from '
  'read. Optional — nothing requires it, and it stays NULL unless a client sets it.';
comment on column comms.notification_recipients.business_id is
  'Denormalised copy of comms.notifications.business_id. Present so the per-user '
  'feed query, its covering indexes and the RLS policy never need the join. '
  'comms.create_notification() is the only writer and always copies the parent''s.';
comment on column comms.notification_recipients.created_at is
  'Copied from the parent notification so newest-first paging is served straight '
  'from idx_notification_recipients_feed without sorting across the join.';

-- The feed: "my notifications in this business, newest first".
create index if not exists idx_notification_recipients_feed
  on comms.notification_recipients (user_profile_id, business_id, created_at desc);

-- The badge: unread only. Partial, so the count touches only unread rows.
create index if not exists idx_notification_recipients_unread
  on comms.notification_recipients (user_profile_id, business_id)
  where read_at is null;

-- No separate index on (notification_id): the `unique (notification_id,
-- user_profile_id)` constraint above already creates a btree whose leading column
-- is notification_id, which serves fan-out reads and the cascade path equally well.
-- A second index would only add write cost to every fan-out (up to 500 rows in one
-- statement) and every mark-read.

drop trigger if exists notification_recipients_set_updated_at on comms.notification_recipients;
create trigger notification_recipients_set_updated_at
before update on comms.notification_recipients
for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Keep the denormalised business_id honest.
--
-- The column exists to keep the feed query single-table, which is only safe while
-- it always equals the parent's. comms.create_notification() is the sole writer
-- and always copies it, but the table is PostgREST-exposed and a future migration
-- could add a second writer, so the invariant is enforced rather than assumed:
-- a mismatched row would otherwise appear in the wrong tenant's feed.
-- ---------------------------------------------------------------------------
create or replace function comms.assert_recipient_business_matches()
returns trigger
language plpgsql
-- SECURITY DEFINER because this is an INTEGRITY guard, and an integrity guard that
-- can be blinded is not one. Without it the function runs as the writer, so RLS on
-- comms.notifications can hide the parent row from the lookup below; business_id
-- then reads NULL and the trigger rejects (or, with a visible parent, passes) for
-- reasons that have nothing to do with the invariant. Running as the owner makes
-- the check mean the same thing no matter who writes.
security definer
set search_path = public, comms
as $$
declare
  v_parent_business_id uuid;
begin
  select n.business_id into v_parent_business_id
  from comms.notifications n
  where n.id = new.notification_id;

  if v_parent_business_id is distinct from new.business_id then
    raise exception
      'notification_recipients.business_id (%) does not match notification % (business %)',
      new.business_id, new.notification_id, v_parent_business_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

comment on function comms.assert_recipient_business_matches() is
  'BEFORE INSERT OR UPDATE guard for comms.notification_recipients: the denormalised '
  'business_id must equal the parent notification''s. Without it a wrong value would '
  'place another tenant''s notification in a user''s feed, because the feed query and '
  'the RLS policy both trust this column instead of joining.';

-- Default EXECUTE-to-PUBLIC would make this callable directly; it is only ever a trigger.
revoke all on function comms.assert_recipient_business_matches() from public, anon, authenticated;

drop trigger if exists notification_recipients_assert_business on comms.notification_recipients;
create trigger notification_recipients_assert_business
before insert or update of business_id, notification_id on comms.notification_recipients
for each row execute function comms.assert_recipient_business_matches();

-- =============================================================================
-- 3. User/device targeting foundation
-- =============================================================================

create table if not exists comms.user_devices (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  user_profile_id uuid not null references core.user_profiles(id) on delete cascade,
  -- Stable per-installation identifier supplied by the app. apps/sheer-app carries
  -- neither expo-device nor expo-application, so there is no platform-provided
  -- installation id to lean on: the app generates a UUID once and persists it in
  -- expo-secure-store (where the auth session already lives). Identifies the DEVICE;
  -- the push token is the current delivery address and rotates independently.
  device_identifier text not null check (length(btrim(device_identifier)) > 0),
  platform text not null check (platform in ('ios', 'android', 'web')),
  push_token text,
  enabled boolean not null default true,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- One row per physical device per user per business. Re-registering the same
  -- installation updates that row (rotating its token) rather than adding another.
  unique (business_id, user_profile_id, device_identifier)
);

comment on table comms.user_devices is
  'User-to-device mapping: the targeting foundation future push delivery (APNs/FCM) '
  'will read. No delivery is implemented in this ticket — the table exists so push '
  'can be added without a schema redesign. Distinct from core.shared_devices, which '
  'is a SHARED salon tablet authenticated by a device session; this is a PERSONAL '
  'device belonging to one user.';
comment on column comms.user_devices.push_token is
  'Raw APNs/FCM/Expo push token. Stored unhashed BY NECESSITY and unlike '
  'core.shared_devices.device_session_token_hash: that is a credential the server '
  'verifies (so it stores only a hash), whereas this is a delivery ADDRESS the '
  'server must transmit to the push provider. It is therefore excluded from the '
  'authenticated column grants below and must never be logged.';
comment on column comms.user_devices.device_identifier is
  'Stable per-installation id from the app. Identifies the device across token '
  'rotations, so a reinstall updates one row instead of accumulating dead rows.';
comment on column comms.user_devices.enabled is
  'False = do not deliver. Set on logout, on token takeover by another user, or by '
  'the user turning push off. Rows are disabled rather than deleted so a returning '
  'device keeps its identity and history.';

create index if not exists idx_user_devices_user
  on comms.user_devices (business_id, user_profile_id)
  where enabled;

-- One enabled row per push token ACROSS the platform. This is what stops a physical
-- device receiving the same push twice — e.g. after a staff member is re-invited
-- under a new profile, or a shared handset is handed to a colleague. Registration
-- takes the token over (disabling the previous holder) rather than duplicating it.
create unique index if not exists idx_user_devices_push_token_unique
  on comms.user_devices (push_token)
  where push_token is not null and enabled;

drop trigger if exists user_devices_set_updated_at on comms.user_devices;
create trigger user_devices_set_updated_at
before update on comms.user_devices
for each row execute function public.set_updated_at();

-- =============================================================================
-- 4. Atomic creation entry point
-- =============================================================================
--
-- supabase-js has no client-side transaction, so "insert the notification AND its
-- recipients, or neither" can only be honoured inside the database. A single
-- function call is one implicit transaction, which is what makes partial
-- notification/recipient state unreachable.
--
-- It is also where recipient eligibility is enforced atomically: the API validates
-- first for good error messages, but a membership can be revoked between that
-- check and the write, so the authoritative filter is here.
-- ---------------------------------------------------------------------------

create or replace function comms.create_notification(
  p_business_id uuid,
  p_type text,
  p_title text,
  p_body text,
  p_recipient_user_profile_ids uuid[],
  p_location_id uuid default null,
  p_priority text default 'normal',
  p_entity_type text default null,
  p_entity_id uuid default null,
  p_action_path text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_dedupe_key text default null,
  p_created_by_user_profile_id uuid default null,
  p_expires_at timestamptz default null
)
returns table (
  notification_id uuid,
  recipient_count integer,
  requested_count integer,
  deduplicated boolean
)
language plpgsql
security definer
set search_path = public, comms, core
as $$
-- The RETURNS TABLE column `notification_id` is also a plpgsql variable, and it
-- collides with the real column of the same name in the ON CONFLICT inference
-- clause below. Every value this function actually reads is either p_-prefixed
-- (argument) or v_-prefixed (local), and the OUT columns are only ever produced by
-- RETURN QUERY — never read — so resolving bare ambiguous names to the COLUMN is
-- both safe and the intended meaning everywhere it applies.
#variable_conflict use_column
declare
  v_notification_id uuid;
  v_eligible uuid[];
  v_requested integer;
  v_inserted integer;
begin
  if p_business_id is null then
    raise exception 'create_notification requires a business_id' using errcode = 'null_value_not_allowed';
  end if;

  -- A location, when given, must belong to the business. Cross-tenant location
  -- targeting is a tenancy breach, not a bad request to tolerate.
  if p_location_id is not null then
    if not exists (
      select 1 from core.locations l
      where l.id = p_location_id and l.business_id = p_business_id
    ) then
      raise exception 'location % does not belong to business %', p_location_id, p_business_id
        using errcode = 'foreign_key_violation';
    end if;
  end if;

  -- Idempotency. A retried business event (double-tapped check-in, replayed job)
  -- must return the FIRST notification rather than create a second one.
  if p_dedupe_key is not null then
    select n.id into v_notification_id
    from comms.notifications n
    where n.business_id = p_business_id
      and n.dedupe_key = p_dedupe_key
    order by n.created_at
    limit 1;

    if v_notification_id is not null then
      return query
        select v_notification_id,
               (select count(*)::integer from comms.notification_recipients r
                 where r.notification_id = v_notification_id),
               coalesce(array_length(p_recipient_user_profile_ids, 1), 0),
               true;
      return;
    end if;
  end if;

  v_requested := coalesce(array_length(p_recipient_user_profile_ids, 1), 0);

  -- Eligible recipients only, de-duplicated. A user qualifies when they hold an
  -- ACTIVE membership of this business and their profile is active. When the
  -- notification is location-scoped they must also be relevant to that location —
  -- owners see the whole business, everyone else must be a member of it.
  --
  -- distinct is what prevents duplicate recipient rows when a caller passes the
  -- same id twice (or a user holds two memberships, e.g. manager AND stylist).
  select coalesce(array_agg(distinct m.user_profile_id), '{}'::uuid[])
    into v_eligible
  from core.user_memberships m
  join core.user_profiles up on up.id = m.user_profile_id
  where m.user_profile_id = any(coalesce(p_recipient_user_profile_ids, '{}'::uuid[]))
    and m.business_id = p_business_id
    and m.status = 'active'
    and up.is_active
    and (
      p_location_id is null
      or m.role = 'owner'
      or m.location_id = p_location_id
    );

  -- No eligible recipient means the notification would be unreachable data. Do not
  -- create an orphan; report zero and let the caller log it.
  if coalesce(array_length(v_eligible, 1), 0) = 0 then
    return query select null::uuid, 0, v_requested, false;
    return;
  end if;

  insert into comms.notifications (
    business_id, location_id, type, priority, title, body,
    entity_type, entity_id, action_path, metadata, dedupe_key,
    created_by_user_profile_id, expires_at
  )
  values (
    p_business_id, p_location_id, p_type, coalesce(p_priority, 'normal'), p_title, p_body,
    p_entity_type, p_entity_id, p_action_path, coalesce(p_metadata, '{}'::jsonb), p_dedupe_key,
    p_created_by_user_profile_id, p_expires_at
  )
  returning id into v_notification_id;

  insert into comms.notification_recipients (
    notification_id, business_id, user_profile_id, created_at
  )
  select v_notification_id, p_business_id, uid, now()
  from unnest(v_eligible) as uid
  on conflict (notification_id, user_profile_id) do nothing;

  get diagnostics v_inserted = row_count;

  return query select v_notification_id, v_inserted, v_requested, false;

exception
  -- Two concurrent calls with the same dedupe_key: one wins the unique index, the
  -- loser resolves to the winner's row instead of failing the business event.
  when unique_violation then
    if p_dedupe_key is null then
      raise;
    end if;
    select n.id into v_notification_id
    from comms.notifications n
    where n.business_id = p_business_id
      and n.dedupe_key = p_dedupe_key
    order by n.created_at
    limit 1;

    if v_notification_id is null then
      raise;
    end if;

    return query
      select v_notification_id,
             (select count(*)::integer from comms.notification_recipients r
               where r.notification_id = v_notification_id),
             coalesce(array_length(p_recipient_user_profile_ids, 1), 0),
             true;
end;
$$;

comment on function comms.create_notification(
  uuid, text, text, text, uuid[], uuid, text, text, uuid, text, jsonb, text, uuid, timestamptz
) is
  'The ONE atomic entry point for creating an in-app notification. Validates the '
  'location belongs to the business, filters the recipient list down to users with '
  'an active membership (and, for a location-scoped notification, relevance to that '
  'location), then writes the notification and every recipient row in a single '
  'transaction — partial notification/recipient state is therefore unreachable. '
  'Idempotent on dedupe_key, including under concurrency. Returns '
  '(notification_id, recipient_count, requested_count, deduplicated); '
  'notification_id is NULL with recipient_count 0 when no requested user was '
  'eligible, so callers can log rather than create orphan data. '
  'requested_count vs recipient_count is how the API detects an invalid recipient.';

revoke all on function comms.create_notification(
  uuid, text, text, text, uuid[], uuid, text, text, uuid, text, jsonb, text, uuid, timestamptz
) from public, anon, authenticated;
grant execute on function comms.create_notification(
  uuid, text, text, text, uuid[], uuid, text, text, uuid, text, jsonb, text, uuid, timestamptz
) to service_role;

-- =============================================================================
-- 5. Safe device registration
-- =============================================================================
--
-- Registration has to do three things as one unit: take the push token away from
-- any other device row still holding it, upsert this user's row for this
-- installation, and rotate the token. Split across statements, a crash between
-- them leaves two enabled rows with the same token — which is precisely the
-- duplicate-delivery bug the unique index exists to prevent.
-- ---------------------------------------------------------------------------

create or replace function comms.register_user_device(
  p_business_id uuid,
  p_user_profile_id uuid,
  p_device_identifier text,
  p_platform text,
  p_push_token text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, comms, core
as $$
declare
  v_device_id uuid;
begin
  -- The device's owner must be an active member of the business it is registered
  -- against. This is the atomic backstop behind the API's own check: it makes
  -- cross-business device assignment impossible even if a caller gets it wrong.
  if not exists (
    select 1
    from core.user_memberships m
    join core.user_profiles up on up.id = m.user_profile_id
    where m.user_profile_id = p_user_profile_id
      and m.business_id = p_business_id
      and m.status = 'active'
      and up.is_active
  ) then
    raise exception 'user % is not an active member of business %', p_user_profile_id, p_business_id
      using errcode = 'insufficient_privilege';
  end if;

  -- Token takeover. A push token addresses one physical device; if it is already
  -- registered elsewhere (a handset handed to a colleague, a profile re-created)
  -- the previous holder is disabled so the device is not pushed to twice.
  if p_push_token is not null then
    update comms.user_devices
    set push_token = null,
        enabled = false
    where push_token = p_push_token
      and enabled
      and not (
        business_id = p_business_id
        and user_profile_id = p_user_profile_id
        and device_identifier = p_device_identifier
      );
  end if;

  insert into comms.user_devices (
    business_id, user_profile_id, device_identifier, platform, push_token, enabled, last_seen_at
  )
  values (
    p_business_id, p_user_profile_id, p_device_identifier, p_platform, p_push_token, true, now()
  )
  on conflict (business_id, user_profile_id, device_identifier) do update
  set platform = excluded.platform,
      -- A re-registration that omits the token keeps the stored one: the app may
      -- be refreshing last_seen_at before the OS has handed it a token.
      push_token = coalesce(excluded.push_token, comms.user_devices.push_token),
      enabled = true,
      last_seen_at = now()
  returning id into v_device_id;

  return v_device_id;
end;
$$;

comment on function comms.register_user_device(uuid, uuid, text, text, text) is
  'Atomic device upsert for the push-targeting foundation. Verifies the user is an '
  'active member of the business (so cross-business assignment cannot happen), takes '
  'the push token over from any other enabled device still holding it (so one '
  'handset cannot receive duplicate pushes), then upserts this installation''s row '
  'and re-enables it. Omitting p_push_token preserves the stored one rather than '
  'clearing it. Returns the device id.';

revoke all on function comms.register_user_device(uuid, uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function comms.register_user_device(uuid, uuid, text, text, text) to service_role;

-- =============================================================================
-- 6. Row-level security
-- =============================================================================
--
-- comms is exposed through PostgREST (supabase/config.toml), so these tables are
-- reachable with an anon/authenticated key and RLS is the only barrier there. The
-- API itself uses the service-role key and bypasses RLS entirely, so RLS here is
-- defence-in-depth against direct access — not the API's tenancy mechanism, which
-- is the explicit business/user filters in NotificationsService.
--
-- The rule is recipient-based visibility: you can read a notification because it
-- was addressed to YOU. An owner does not inherit their staff's personal feed.
-- ---------------------------------------------------------------------------

alter table comms.notifications enable row level security;
alter table comms.notification_recipients enable row level security;
alter table comms.user_devices enable row level security;

-- --- comms.notifications ---------------------------------------------------
-- Readable only by its own recipients. Note there is deliberately NO owner/manager
-- policy: a manager reading an employee's personal notification is not a
-- management capability the product has asked for, and recipient-based visibility
-- is the whole security model of a personal feed.
drop policy if exists comms_notifications_recipient_select on comms.notifications;
create policy comms_notifications_recipient_select
on comms.notifications for select
to authenticated
using (exists (
  select 1 from comms.notification_recipients r
  where r.notification_id = comms.notifications.id
    and r.user_profile_id = public.current_user_id()
));

-- --- comms.notification_recipients -----------------------------------------
drop policy if exists comms_notification_recipients_own_select on comms.notification_recipients;
create policy comms_notification_recipients_own_select
on comms.notification_recipients for select
to authenticated
using (user_profile_id = public.current_user_id());

-- Mark read/unread/seen only on your OWN row. `with check` repeats the predicate so
-- a row cannot be reassigned to another user on the way out.
drop policy if exists comms_notification_recipients_own_update on comms.notification_recipients;
create policy comms_notification_recipients_own_update
on comms.notification_recipients for update
to authenticated
using (user_profile_id = public.current_user_id())
with check (user_profile_id = public.current_user_id());

-- --- comms.user_devices -----------------------------------------------------
drop policy if exists comms_user_devices_own_select on comms.user_devices;
create policy comms_user_devices_own_select
on comms.user_devices for select
to authenticated
using (user_profile_id = public.current_user_id());

-- =============================================================================
-- 7. Grants
-- =============================================================================
--
-- Deliberately narrow. Notifications are SERVER-CREATED: no authenticated role may
-- insert one, which is what makes "a browser cannot fabricate a notification for
-- another user" true at the database as well as in the API.
--
-- THE REVOKES ARE LOAD-BEARING — DO NOT DROP THEM.
-- Migration 0002 set ALTER DEFAULT PRIVILEGES on the comms schema granting
-- `authenticated` SELECT+INSERT+UPDATE+DELETE on every table created in it, for
-- ever. A new table therefore arrives with FULL table-level write access already
-- attached, and a `grant select (col, …)` on top of that is purely additive: it
-- restricts nothing. Every narrowing grant below must be preceded by a revoke, or
-- it is decoration.
--
-- Concretely, without the revoke on notification_recipients the RLS policy alone
-- leaves a live privilege escalation: table-wide UPDATE plus a WITH CHECK that only
-- pins user_profile_id lets a stylist repoint their OWN recipient row at any other
-- notification in the business — the owner's included — and then read its content
-- through the recipient-based SELECT policy. Restricting UPDATE to (seen_at,
-- read_at) is what closes it. Case 41 of supabase/tests/in_app_notifications.sql
-- is the regression test.
--
-- This is the same class of trap as the SECURITY DEFINER PUBLIC-execute default
-- handled in 0071 -> 0078: in this database, defaults are permissive, so every new
-- object states its own access explicitly.
-- ---------------------------------------------------------------------------

revoke all on comms.notifications from anon, authenticated;
grant select on comms.notifications to authenticated;
grant select, insert, update, delete on comms.notifications to service_role;

revoke all on comms.notification_recipients from anon, authenticated;
grant select on comms.notification_recipients to authenticated;
-- Read/seen state is the ONLY thing a user may change about their own recipient
-- row. Anything wider re-opens the repointing escalation described above.
grant update (seen_at, read_at) on comms.notification_recipients to authenticated;
grant select, insert, update, delete on comms.notification_recipients to service_role;

revoke all on comms.user_devices from anon, authenticated;
-- push_token is excluded on purpose: a delivery address should not be readable
-- over PostgREST even by its owner, and nothing in the product displays it.
grant select (
  id, business_id, user_profile_id, device_identifier, platform, enabled,
  last_seen_at, created_at, updated_at
) on comms.user_devices to authenticated;
grant select, insert, update, delete on comms.user_devices to service_role;
