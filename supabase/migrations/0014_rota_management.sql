-- 0014_rota_management.sql
--
-- Schema additions for the rota management phase. The schema for
-- shifts / breaks / leave / absences themselves was created in
-- 0005_rota_foundation.sql; this migration adds the *configuration*
-- and *audit* tables the manager-facing rota flow needs:
--
--   1. rota.staff_break_defaults
--      Per-stylist break defaults consumed when a manager creates a new
--      shift. Editable by owners; read-only for managers (they read it
--      so the shift form can pre-fill). One row per staff_profile.
--
--   2. core.location_settings.holiday_notice_days
--      Per-location threshold (in days) for the "leave too close to
--      requested date" auto-decline rule. Defaults to 30.
--
--   3. audit.rota_audit_events
--      Append-only log of who-did-what-when on rota records. Captures
--      past-rota edits (with mandatory reason), leave approvals/
--      rejections (and overrides of the holiday notice rule), and
--      absence creations. Owners see business-wide; managers see only
--      their own location.
--
-- RLS reuses the existing helpers (`public.is_business_owner`,
-- `public.has_location_management_scope`). Writes are intentionally
-- service-role-only — the API layer is the single chokepoint that
-- captures audit rows and enforces the past-edit-with-reason rule.

-- ---------------------------------------------------------------------------
-- Per-staff break defaults
-- ---------------------------------------------------------------------------

create table rota.staff_break_defaults (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  staff_profile_id uuid not null unique references core.staff_profiles(id) on delete cascade,
  break_minutes integer not null default 30 check (break_minutes >= 0 and break_minutes <= 240),
  is_paid boolean not null default false,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table rota.staff_break_defaults is
  'Per-stylist break defaults used when a manager creates a new shift. One row per staff_profile.';

create index idx_rota_staff_break_defaults_business_id
  on rota.staff_break_defaults (business_id);

create trigger rota_staff_break_defaults_set_updated_at
before update on rota.staff_break_defaults
for each row execute function public.set_updated_at();

alter table rota.staff_break_defaults enable row level security;

create policy rota_staff_break_defaults_owner_all
  on rota.staff_break_defaults
  for all
  to authenticated
  using (public.is_business_owner(business_id))
  with check (public.is_business_owner(business_id));

-- Managers can read defaults for staff at the locations they manage.
-- We resolve the location via the staff profile's primary_location_id
-- so a manager only sees defaults that belong inside their scope.
create policy rota_staff_break_defaults_manager_select
  on rota.staff_break_defaults
  for select
  to authenticated
  using (
    exists (
      select 1
      from core.staff_profiles sp
      where sp.id = rota.staff_break_defaults.staff_profile_id
        and public.has_location_management_scope(sp.business_id, sp.primary_location_id)
    )
  );

-- ---------------------------------------------------------------------------
-- Holiday notice rule (per-location, default 30 days)
-- ---------------------------------------------------------------------------

alter table core.location_settings
  add column if not exists holiday_notice_days integer not null default 30
  check (holiday_notice_days >= 0 and holiday_notice_days <= 365);

comment on column core.location_settings.holiday_notice_days is
  'Minimum days of notice required for an approvable leave request. Requests inside the threshold auto-decline by default; manager can override at approval time.';

-- ---------------------------------------------------------------------------
-- Rota audit log
-- ---------------------------------------------------------------------------

create table audit.rota_audit_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  actor_user_profile_id uuid references core.user_profiles(id) on delete set null,
  actor_role core.membership_role_enum,
  -- Logical entity touched. Free text rather than enum so adding a new
  -- rota object later (e.g. rota.shift_blocks) doesn't require a
  -- migration. Validated by the API layer.
  entity_type text not null,
  entity_id uuid,
  -- create / update / delete / approve / reject / override / mark_absence /
  -- past_edit. Validated by the API layer.
  action text not null,
  -- Mandatory reason for past-rota edits. Optional everywhere else.
  reason text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table audit.rota_audit_events is
  'Append-only audit trail for rota mutations: shift CRUD, break CRUD, leave approvals (incl. holiday-notice overrides), absences, and past-rota edits.';

create index idx_rota_audit_events_business_location_created
  on audit.rota_audit_events (business_id, location_id, created_at desc);

create index idx_rota_audit_events_entity
  on audit.rota_audit_events (entity_type, entity_id);

create index idx_rota_audit_events_actor_created
  on audit.rota_audit_events (actor_user_profile_id, created_at desc);

alter table audit.rota_audit_events enable row level security;

create policy rota_audit_events_owner_select
  on audit.rota_audit_events
  for select
  to authenticated
  using (public.is_business_owner(business_id));

create policy rota_audit_events_manager_select
  on audit.rota_audit_events
  for select
  to authenticated
  using (
    location_id is not null
    and public.has_location_management_scope(business_id, location_id)
  );

-- Writes flow exclusively through the API service role. Authenticated
-- users (including owners + managers) cannot insert audit rows directly;
-- this keeps the audit log tamper-evident.
