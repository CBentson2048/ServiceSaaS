-- 0100_ordering_two_step.sql
-- Collapse purchase ordering from three steps to two.
--
-- WHAT CHANGED AND WHY. Ordering shipped in 0094 as
--   draft -> pending_approval -> approved -> sent
-- with approval as a separate spend control held only by owner/group_admin. In
-- practice the whole feature is reachable only by business owners and location
-- managers, and a manager is already scoped to their own location, so the extra
-- hop earned nothing: the same small set of people clicked "submit", then
-- "approve", then "send". The flow becomes
--   draft -> approved ("ready to send") -> sent
-- driven by two buttons: "Submit for order" and "Send to supplier".
--
-- WHY THE SPEND CONTROL SURVIVES ANYWAY. `orders.approve` is NOT deleted — it is
-- now the gate on SENDING, and this migration seeds it to the manager level so
-- managers can complete their own orders by default. An owner who wants sign-off
-- back simply removes that one key at /settings/security-levels: the manager's
-- flow then stops at "Submit for order" and the owner's "Send to supplier" click
-- IS the approval. Same two buttons, no code change, no dead UI. That property is
-- the reason approval became a permission rather than a status.
--
-- WHAT THIS DOES
--   1. Moves every existing `pending_approval` order to `approved`, preserving
--      when and by whom it was raised.
--   2. Grants `orders.approve` to the `manager` system security level.
--   3. Documents `pending_approval` as a legacy value nothing writes any more.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   - Does NOT remove 'pending_approval' from
--     inventory.purchase_order_status_enum. Postgres cannot drop an enum value,
--     and rewriting the type (the 0045 appointment-status exercise) is a large,
--     risky operation to buy nothing: an unused label costs no storage and no
--     correctness. It stays readable so historical audit rows still render.
--   - Does NOT touch inventory_purchase_orders_open_supplier_key or
--     inventory.create_purchase_order. 0095 already widened the OPEN set to
--     ('draft','pending_approval','approved'), so an order sitting in the new
--     ready-to-send state already blocks a duplicate for the same
--     supplier+location. Nothing to change.
--   - Does NOT change orders.view / orders.manage, the reorder maths, or the
--     supplier email.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Carry existing in-flight orders across
-- =============================================================================
--
-- An order awaiting approval when this deploys must not be stranded in a state
-- no button can move: nothing writes 'pending_approval' after this, and the UI
-- stops offering "Approve". Moving it to 'approved' lands it exactly where the
-- new flow expects it — ready to send — with one click still to go, so no order
-- is silently sent that a human had not already queued for sending.
--
-- The stamps are preserved rather than set to now(): `submitted_at` is when the
-- order was actually raised, and attributing the approval to whoever prepared it
-- is truthful (they are the one who acted), where now()/current-user would
-- fabricate an approval event that never happened.

update inventory.purchase_orders
set status = 'approved',
    approved_at = coalesce(approved_at, submitted_at, now()),
    approved_by = coalesce(approved_by, created_by),
    updated_at = now()
where status = 'pending_approval';

comment on column inventory.purchase_orders.status is
  'draft -> approved -> sent, plus cancelled. ''approved'' means READY TO SEND: '
  'it is reached by the single "Submit for order" action, not by a separate '
  'approval step. ''pending_approval'' is LEGACY — 0100 migrated every row out of '
  'it and no code writes it any more; the enum label survives only because '
  'Postgres cannot drop one.';

comment on column inventory.purchase_orders.approved_at is
  'When the order was finalised for sending (the "Submit for order" click). Named '
  'for the three-step flow 0094 shipped; since 0100 there is no separate approval '
  'step, and this is stamped together with submitted_at.';

-- =============================================================================
-- 2. Managers can send their own location's orders
-- =============================================================================
--
-- 0094 deliberately kept `orders.approve` off the manager level because approval
-- was a distinct authority. Now that sending IS that authority and the feature is
-- manager-facing by design, the manager level gets the key.
--
-- Still seeded to the SYSTEM LEVEL, never to DEFAULT_ROLE_PERMISSIONS.manager —
-- the 0074 lesson holds: memberships with no explicit security_level_id fall back
-- to role defaults, and putting an orders key there would hand ordering rights to
-- every unassigned front-desk user.
--
-- The `@>` guard makes re-applying safe in the sense that matters here: the
-- permissions column is a jsonb ARRAY with no uniqueness of its own, so without it
-- a second run would append ["orders.approve","orders.approve"].
--
-- It does NOT, and cannot, distinguish "never seeded" from "seeded and then
-- deliberately removed by an owner" — both look like a level lacking the key, so a
-- re-run would re-grant it. That is acceptable because migrations are applied once
-- and tracked; it is called out so nobody later mistakes this for a guarantee that
-- an owner's removal survives a replay. If that guarantee is ever needed, it wants
-- an explicit "seeded" marker, not a wider `where` clause.

update core.security_levels
set permissions = permissions || '["orders.approve"]'::jsonb, updated_at = now()
where is_system = true and key = 'manager'
  and not permissions @> '["orders.approve"]'::jsonb;
