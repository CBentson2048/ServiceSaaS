-- 0055_security_levels.sql
-- Wrike #4507280889 — expanded, configurable security model.
--
-- Adds a permission layer on top of the base membership roles WITHOUT changing
-- core.membership_role_enum (so all V1 role flows and RLS stay intact):
--   * core.security_levels: named permission sets per business. System levels
--     mirror the base roles (incl. the expanded Receptionist and Group Admin);
--     owners can add custom levels (Senior Stylist, Bookkeeper view-only, ...).
--   * core.user_memberships.security_level_id: the level assigned to a member.
--     NULL means "use the base-role defaults" — i.e. existing members are
--     unchanged after migration.
-- Effective permissions are resolved server-side (auth.service) and enforced by
-- the PermissionsGuard. `base_role` keeps a level tied to an existing role for
-- DB scoping/RLS purposes.

-- =============================================================================
-- 1. Table
-- =============================================================================

create table if not exists core.security_levels (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- System-level key ('owner','group_admin','manager','receptionist','stylist')
  -- or NULL for an owner-created custom level.
  key text,
  name text not null,
  description text,
  base_role core.membership_role_enum not null,
  is_system boolean not null default false,
  -- Array of permission keys (see PERMISSION_CATALOG in @sheer/domain).
  permissions jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint security_levels_base_role_chk check (base_role in ('owner', 'manager', 'stylist')),
  constraint security_levels_permissions_is_array check (jsonb_typeof(permissions) = 'array')
);

comment on table core.security_levels is
  'Configurable security levels (named permission sets) per business. System levels mirror base roles incl. Receptionist/Group Admin; custom levels are owner-created. Enforced server-side via the PermissionsGuard.';

create unique index if not exists security_levels_business_key_uq
  on core.security_levels (business_id, key) where key is not null;
create unique index if not exists security_levels_business_name_uq
  on core.security_levels (business_id, lower(name));
create index if not exists idx_security_levels_business
  on core.security_levels (business_id);

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'core_security_levels_set_updated_at'
      and tgrelid = 'core.security_levels'::regclass
  ) then
    create trigger core_security_levels_set_updated_at
      before update on core.security_levels
      for each row execute function public.set_updated_at();
  end if;
end
$$;

-- =============================================================================
-- 2. Membership assignment column
-- =============================================================================

alter table core.user_memberships
  add column if not exists security_level_id uuid references core.security_levels(id) on delete set null;

create index if not exists idx_user_memberships_security_level
  on core.user_memberships (security_level_id);

comment on column core.user_memberships.security_level_id is
  'Optional security level applied to this membership. NULL = base-role default permissions (V1 behaviour).';

-- =============================================================================
-- 3. Seed system levels for every existing business
-- =============================================================================

insert into core.security_levels (business_id, key, name, description, base_role, is_system, permissions)
select b.id, s.key, s.name, s.description, s.base_role::core.membership_role_enum, true, s.permissions
from core.businesses b
cross join (
  values
    (
      'owner', 'Owner',
      'Full access to everything, including account and security settings.',
      'owner',
      to_jsonb(array[
        'report.dashboard.view','report.performance.view','report.commission.view','report.financials.view','report.lab_analytics.view',
        'bookings.manage','crm.view','crm.manage','retail.record','inventory.manage','services.manage','rota.manage',
        'staff.view','staff.manage','staff.pay.manage',
        'locations.manage','settings.location.manage','settings.billing.manage','settings.tax.manage','settings.booking.manage',
        'account.manage','security.manage'
      ])
    ),
    (
      'group_admin', 'Group Admin',
      'Runs the whole group across all locations, but cannot change the account plan or the security model.',
      'owner',
      to_jsonb(array[
        'report.dashboard.view','report.performance.view','report.commission.view','report.financials.view','report.lab_analytics.view',
        'bookings.manage','crm.view','crm.manage','retail.record','inventory.manage','services.manage','rota.manage',
        'staff.view','staff.manage','staff.pay.manage',
        'locations.manage','settings.location.manage','settings.billing.manage','settings.tax.manage','settings.booking.manage'
      ])
    ),
    (
      'manager', 'Manager',
      'Runs a location: reports, settings, rota, clients and stock. No account, security, pay or location creation.',
      'manager',
      to_jsonb(array[
        'report.dashboard.view','report.performance.view','report.commission.view','report.financials.view','report.lab_analytics.view',
        'bookings.manage','crm.view','crm.manage','retail.record','inventory.manage','services.manage','rota.manage',
        'staff.view','settings.location.manage','settings.billing.manage','settings.tax.manage','settings.booking.manage'
      ])
    ),
    (
      'receptionist', 'Receptionist',
      'Front desk: bookings, clients and taking payments. No reports, financials, pay or settings.',
      'manager',
      to_jsonb(array['bookings.manage','crm.view','crm.manage','retail.record'])
    ),
    (
      'stylist', 'Stylist',
      'Their own column: bookings, clients and taking payments.',
      'stylist',
      to_jsonb(array['bookings.manage','crm.view','retail.record'])
    )
) as s(key, name, description, base_role, permissions)
where not exists (
  select 1 from core.security_levels sl
  where sl.business_id = b.id and sl.key = s.key
);

-- Existing memberships keep security_level_id = NULL → base-role defaults, so no
-- behavioural change. (Owners could later assign the matching system level.)

-- =============================================================================
-- 4. RLS — service role bypasses; this is defense-in-depth for direct clients.
-- =============================================================================

alter table core.security_levels enable row level security;

drop policy if exists security_levels_owner_all on core.security_levels;
create policy security_levels_owner_all
  on core.security_levels
  for all
  using (public.is_business_owner(business_id))
  with check (public.is_business_owner(business_id));

drop policy if exists security_levels_member_select on core.security_levels;
create policy security_levels_member_select
  on core.security_levels
  for select
  using (
    public.is_business_owner(business_id)
    or exists (
      select 1 from core.user_memberships m
      where m.business_id = core.security_levels.business_id
        and m.user_profile_id = public.current_user_id()
        and m.status = 'active'
    )
  );
