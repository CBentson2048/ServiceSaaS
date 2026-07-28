-- 0076_zac_access_permission.sql
-- ZAC Phase 1 Week 1 — `zac.access` feature permission (dark launch).
--
-- NOTE: authored for review in Week 1; apply together with 0077 via the normal
-- Supabase CLI flow. Numbered 0076: 0071–0075 are taken by the payroll /
-- financial-rules migrations already merged to develop.
--
-- `zac.access` only opens the ZAC assistant surface. It deliberately grants no
-- access to reports, clients, staff, QLAB, stock or business financials: every
-- ZAC tool independently re-checks the exact underlying permission it needs
-- (e.g. the business-health tool re-checks `report.dashboard.view`). Rollout
-- additionally requires the API-side `ZAC_ENABLED` flag and optional business
-- allowlist, so granting this permission exposes nothing while the feature is
-- dark.
--
-- Modeled on 0058's `audit.read` back-patch, with the same posture 0074 took
-- for payroll keys: only the owner-tier system levels (owner, group_admin) are
-- back-patched. This is consistency-only — members whose role is 'owner'
-- already resolve to the full permission catalogue in the API (auth.service
-- short-circuit), so no effective access changes here.
--
-- *** Managers are deliberately NOT seeded. *** During the Phase 1 dark launch
-- a manager gets ZAC only via an explicit `zac.access` grant on their security
-- level (the catalogue entry in @sheer/domain makes it tickable in the
-- security-levels UI). `DEFAULT_ROLE_PERMISSIONS.manager` also does not include
-- it — same reasoning as 0074's payroll.view note: role-default fallbacks
-- over-grant to every unassigned membership. Stylist and receptionist levels
-- receive nothing, and clients never do.

update core.security_levels
set permissions = permissions || '["zac.access"]'::jsonb,
    updated_at = now()
where is_system = true
  and key in ('owner', 'group_admin')
  and not permissions @> '["zac.access"]'::jsonb;
