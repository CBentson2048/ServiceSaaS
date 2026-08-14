-- 0081_zac_default_access.sql
-- ZAC leaves the dark launch — grant `zac.access` to the staff system levels.
--
-- Follow-up to 0076, which back-patched only the owner-tier levels (owner,
-- group_admin) while ZAC was dark-launched. The rollout decision has changed
-- (Luke, 2026-08-07): every staff role — owner, manager, stylist — now gets the
-- ZAC assistant by default, still scoped to their role. The permission remains
-- surface-only: every ZAC tool independently re-checks the exact underlying
-- report/feature permission it needs, and the registry serves stylists a
-- stylist-safe, self-scoped catalogue, so this widens no data access.
--
-- Ship WITH the @sheer/domain change that adds `zac.access` to
-- DEFAULT_ROLE_PERMISSIONS.manager/.stylist (SYSTEM_SECURITY_LEVELS derives
-- from those lists): the role defaults cover memberships without a security
-- level and system levels of newly-created businesses; this migration
-- back-patches the rows already seeded in existing businesses.
-- ensureSystemLevels() only inserts missing levels — it never updates existing
-- rows — so without this migration existing salons' stylists and managers would
-- stay locked out despite the new code defaults.
--
-- Receptionist is deliberately NOT granted: front desk holds no report
-- permissions, so ZAC would only answer capability questions for them — keep
-- it an explicit owner decision. Custom (owner-created) levels are also left
-- untouched: owners curate those lists deliberately, and the "ZAC assistant"
-- box is tickable at /settings/security-levels.

update core.security_levels
set permissions = permissions || '["zac.access"]'::jsonb,
    updated_at = now()
where is_system = true
  and key in ('manager', 'stylist')
  and not permissions @> '["zac.access"]'::jsonb;
