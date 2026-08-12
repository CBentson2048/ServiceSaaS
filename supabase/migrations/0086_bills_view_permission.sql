-- 0086_bills_view_permission.sql
-- Week 5 — "Implement bill finder search by client, date, stylist and amount".
--
-- Adds the `bills.view` permission key behind the bill finder (GET /bills and
-- the /bills page): read-only search over the stored bills created by 0085.
--
-- Seeded onto the system security levels that staff the front desk or run the
-- business — owner, group admin, manager AND receptionist ("a client is on the
-- phone about a charge from three weeks ago" is a front-desk moment). Stylist
-- levels deliberately do not receive it: the finder exposes business-wide
-- financial history.
--
-- ⚠️ Pairing rule (blocker B1, docs/V1.1/3-2 plan.md): this key must ALSO exist
-- in PERMISSION_CATALOG in packages/domain/src/index.ts — auth.service and
-- owner-security-levels filter permissions through ALL_PERMISSIONS and silently
-- strip unknown keys on every read/save. The catalog entry ships in the same
-- change as this migration.

update core.security_levels
set permissions = permissions || '["bills.view"]'::jsonb
where is_system = true
  and key in ('owner', 'group_admin', 'manager', 'receptionist')
  -- Idempotent: re-running never duplicates the key inside the jsonb array.
  and not (permissions ? 'bills.view');
