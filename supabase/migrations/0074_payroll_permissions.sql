-- 0074_payroll_permissions.sql
-- Wrike #4507282012 — Week 3, protect sensitive pay data.
--
-- Luke, 2026-07-25, asked for separate permissions for:
--   View, Approve, Edit, Lock, Export, Email
--
-- Seeded here as payroll.view / payroll.approve / payroll.edit / payroll.lock /
-- payroll.export / payroll.email, following the dotted key convention already
-- used by staff.pay.manage, report.commission.view and audit.read.
--
-- A seventh key, payroll.self.view, is added deliberately. Luke's six all
-- describe business-wide payroll; the approved Week 3 baseline also requires
-- that "a stylist can only see their own pay summary if permitted". Granting a
-- stylist payroll.view to achieve that would expose every colleague's pay
-- through the same endpoint, so self-service needs its own key.
--
-- Default posture is deliberately tight - the cost of under-granting is an
-- owner ticking a box, the cost of over-granting is a wage leak:
--   owner, group_admin : all six management keys + self view
--   manager            : payroll.view only (Luke: "Manager access depends on
--                        configured permissions")
--   receptionist       : nothing
--   stylist            : payroll.self.view only
--
-- FOLLOW-UP REQUIRED (Phase 4, not this migration): these keys must also be
-- added to the Permission union and PERMISSION_CATALOG (with `requires` edges -
-- approve/edit/lock/export/email all require payroll.view) in
-- packages/domain/src/index.ts, and @sheer/domain rebuilt. Until then the API
-- does not recognise the keys, and because owner-security-levels validates
-- against the catalogue, the rows seeded here would be stripped the first time
-- an owner saves a security level. Ship the domain change WITH this migration.
--
-- *** DO NOT add payroll.view to DEFAULT_ROLE_PERMISSIONS.manager. ***
-- 'receptionist' is not a role - core.membership_role_enum is only
-- owner/manager/stylist/client, and the receptionist system level has
-- base_role = 'manager'. Any membership without an explicit security_level_id
-- falls back to DEFAULT_ROLE_PERMISSIONS[role], so putting payroll.view in the
-- manager defaults would hand every unassigned front-desk user access to wage
-- data. Managers get the key through the 'manager' security level seeded below,
-- never through the role default.
-- Note that owner and group_admin pick these keys up automatically for
-- newly-created businesses, because SYSTEM_SECURITY_LEVELS derives them from
-- ALL_PERMISSIONS; only manager and stylist need deliberate handling.

-- =============================================================================
-- 1. Management keys — owner and group_admin
-- =============================================================================

update core.security_levels
set permissions = permissions || '["payroll.view"]'::jsonb,
    updated_at = now()
where is_system = true
  and key in ('owner', 'group_admin')
  and not permissions @> '["payroll.view"]'::jsonb;

update core.security_levels
set permissions = permissions || '["payroll.edit"]'::jsonb,
    updated_at = now()
where is_system = true
  and key in ('owner', 'group_admin')
  and not permissions @> '["payroll.edit"]'::jsonb;

update core.security_levels
set permissions = permissions || '["payroll.approve"]'::jsonb,
    updated_at = now()
where is_system = true
  and key in ('owner', 'group_admin')
  and not permissions @> '["payroll.approve"]'::jsonb;

update core.security_levels
set permissions = permissions || '["payroll.lock"]'::jsonb,
    updated_at = now()
where is_system = true
  and key in ('owner', 'group_admin')
  and not permissions @> '["payroll.lock"]'::jsonb;

update core.security_levels
set permissions = permissions || '["payroll.export"]'::jsonb,
    updated_at = now()
where is_system = true
  and key in ('owner', 'group_admin')
  and not permissions @> '["payroll.export"]'::jsonb;

update core.security_levels
set permissions = permissions || '["payroll.email"]'::jsonb,
    updated_at = now()
where is_system = true
  and key in ('owner', 'group_admin')
  and not permissions @> '["payroll.email"]'::jsonb;

-- =============================================================================
-- 2. Manager — read-only by default
-- =============================================================================
-- Owners can grant the remaining keys per business at /settings/security-levels.

update core.security_levels
set permissions = permissions || '["payroll.view"]'::jsonb,
    updated_at = now()
where is_system = true
  and key = 'manager'
  and not permissions @> '["payroll.view"]'::jsonb;

-- =============================================================================
-- 3. Own-pay visibility
-- =============================================================================
-- Owners and group admins get it so that a working owner can see their own
-- statement through the same stylist-facing surface.

update core.security_levels
set permissions = permissions || '["payroll.self.view"]'::jsonb,
    updated_at = now()
where is_system = true
  and key in ('owner', 'group_admin', 'stylist')
  and not permissions @> '["payroll.self.view"]'::jsonb;

-- =============================================================================
-- 4. Receptionist — explicitly nothing
-- =============================================================================
-- No statement here by design. Receptionist and client roles must never reach
-- payroll data, and the absence is deliberate rather than an oversight.
