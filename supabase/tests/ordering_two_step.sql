-- ordering_two_step.sql — behavioural suite for migration 0100.
--
-- WHY THIS FILE EXISTS. 0100 is almost entirely data and permission changes, and
-- both are invisible to Jest: the API specs stub the Supabase client, so they can
-- prove the service ASKS to write 'approved', never that no order was stranded in
-- 'pending_approval' nor that the manager security level actually gained the key
-- that lets a manager send. The permission seed in particular is guarded by a
-- `@>` check whose effect — and its LIMIT — can only be shown by running the
-- statement twice, which cases 4 and 5 do.
--
-- 7 numbered cases. Read the RESULT column of each; every one must read PASS.
--
-- Run against a SCRATCH database that has every migration through 0100 applied:
--   psql -d <scratch> -f supabase/tests/ordering_two_step.sql
--
-- The whole suite runs inside one transaction that is rolled back at the end, so
-- it leaves no fixture rows behind and is re-runnable.

\set ON_ERROR_STOP off
\pset pager off

begin;

-- ---------------------------------------------------------------------------
-- Fixtures. 'ca' prefix, hex-only UUIDs, distinct from the other suites
-- ('ee' = week6/messaging, 'a6' = week6 acceptance, 'fa'/'fb' = notifications).
-- ---------------------------------------------------------------------------
insert into core.businesses (id, name, slug) values
 ('ca000000-0000-0000-0000-000000000001', 'Ordering Salon', 'ordering-salon'),
 ('ca000000-0000-0000-0000-000000000002', 'Second Salon', 'ordering-salon-2');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('ca000000-0000-0000-0000-0000000000a1','ca000000-0000-0000-0000-000000000001','C1','Pinner','ca-pinner','1 High St','Pinner','HA5 1AA','Europe/London');

insert into inventory.suppliers (id, business_id, name, contact_email) values
 ('ca000000-0000-0000-0000-000000000051','ca000000-0000-0000-0000-000000000001','Davines','orders@davines.example');

-- System security levels in their PRE-0100 shape. The migration itself already
-- ran (against an empty table on a scratch database), so the only way to exercise
-- the seed is to recreate the state it was written for and re-run it verbatim.
-- Two businesses, because the seed must reach every tenant, not just the first.
insert into core.security_levels (business_id, key, name, base_role, is_system, permissions) values
 ('ca000000-0000-0000-0000-000000000001','manager','Manager','manager',true,
  '["orders.view","orders.manage"]'::jsonb),
 ('ca000000-0000-0000-0000-000000000002','manager','Manager','manager',true,
  '["orders.view","orders.manage"]'::jsonb),
 ('ca000000-0000-0000-0000-000000000001','owner','Owner','owner',true,
  '["orders.view","orders.manage","orders.approve"]'::jsonb),
 ('ca000000-0000-0000-0000-000000000001','group_admin','Group Admin','owner',true,
  '["orders.view","orders.manage","orders.approve"]'::jsonb);

create temporary table probe_results (case_name text primary key, result text) on commit drop;

-- Verbatim re-run of the 0100 seed against the fixtures above. Everything from
-- here on observes its effect.
update core.security_levels
set permissions = permissions || '["orders.approve"]'::jsonb, updated_at = now()
where is_system = true and key = 'manager'
  and not permissions @> '["orders.approve"]'::jsonb;

-- ===========================================================================
-- 1. THE MANAGER LEVEL CAN SEND. This is the whole point of 0100: a location
--    manager completes their own order rather than waiting on an owner.
-- ===========================================================================
select '01_MANAGER_LEVEL_CAN_SEND' as case,
       case when (select count(*) from core.security_levels
                  where is_system = true and key = 'manager'
                    and business_id in ('ca000000-0000-0000-0000-000000000001',
                                        'ca000000-0000-0000-0000-000000000002')
                    and permissions @> '["orders.approve"]'::jsonb) = 2
       then 'PASS' else 'FAIL: the seed did not reach every business''s manager level' end as result;

-- ===========================================================================
-- 2. …WITHOUT LOSING THE PREPARE KEYS. Sending was added, nothing replaced.
-- ===========================================================================
select '02_MANAGER_KEEPS_PREPARE_KEYS' as case,
       case when (select count(*) from core.security_levels
                  where is_system = true and key = 'manager'
                    and permissions @> '["orders.view"]'::jsonb
                    and permissions @> '["orders.manage"]'::jsonb) = 2
       then 'PASS' else 'FAIL: a manager level lost orders.view/orders.manage' end as result;

-- ===========================================================================
-- 3. OWNER AND GROUP_ADMIN ARE UNTOUCHED — 0100 widened who can send, it did
--    not move the capability away from anybody.
-- ===========================================================================
select '03_ADMIN_LEVELS_UNCHANGED' as case,
       case when (select count(*) from core.security_levels
                  where is_system = true and key in ('owner','group_admin')
                    and permissions @> '["orders.approve"]'::jsonb) = 2
       then 'PASS' else 'FAIL: an owner/group_admin level lost orders.approve' end as result;

-- ===========================================================================
-- 4. THE SEED IS IDEMPOTENT. Re-running the migration must not append a second
--    copy of the key — a jsonb array has no uniqueness of its own, so the `@>`
--    guard is the only thing preventing ["orders.approve","orders.approve"].
-- ===========================================================================
do $probe$
declare v_before integer; v_after integer;
begin
  select count(*) into v_before
  from core.security_levels, jsonb_array_elements_text(permissions) p
  where is_system = true and key = 'manager' and p = 'orders.approve';

  -- Verbatim re-run of the 0100 seed statement.
  update core.security_levels
  set permissions = permissions || '["orders.approve"]'::jsonb, updated_at = now()
  where is_system = true and key = 'manager'
    and not permissions @> '["orders.approve"]'::jsonb;

  select count(*) into v_after
  from core.security_levels, jsonb_array_elements_text(permissions) p
  where is_system = true and key = 'manager' and p = 'orders.approve';

  insert into probe_results values ('04_SEED_IS_IDEMPOTENT',
    case when v_after = v_before then 'PASS'
         else 'FAIL: re-applying duplicated the key (' || v_before || ' -> ' || v_after || ')' end);
end
$probe$;
select case_name as case, result from probe_results where case_name = '04_SEED_IS_IDEMPOTENT';

-- ===========================================================================
-- 5. THE KNOWN LIMIT, PINNED DELIBERATELY. `@>` cannot tell "never seeded" from
--    "seeded, then removed on purpose by an owner who wanted sign-off back" —
--    both look like a level lacking the key. So a REPLAY re-grants it.
--
--    This case asserts that re-granting is what actually happens. It is not an
--    endorsement: it exists so nobody reads the guard and assumes the opposite,
--    and so that if someone later needs an owner's removal to survive a replay,
--    this case fails loudly and tells them a "seeded" marker is required rather
--    than a wider `where` clause. Harmless today because migrations are applied
--    once and tracked.
-- ===========================================================================
do $probe$
declare v_has_key boolean;
begin
  -- An owner reinstates sign-off by removing the key from their managers.
  update core.security_levels
  set permissions = permissions - 'orders.approve'
  where is_system = true and key = 'manager'
    and business_id = 'ca000000-0000-0000-0000-000000000002';

  -- Migrations are replayed against that database.
  update core.security_levels
  set permissions = permissions || '["orders.approve"]'::jsonb, updated_at = now()
  where is_system = true and key = 'manager'
    and not permissions @> '["orders.approve"]'::jsonb;

  select permissions @> '["orders.approve"]'::jsonb into v_has_key
  from core.security_levels
  where business_id = 'ca000000-0000-0000-0000-000000000002' and key = 'manager';

  insert into probe_results values ('05_REPLAY_REGRANTS_A_REMOVED_KEY',
    case when v_has_key then 'PASS'
         else 'FAIL: behaviour changed — a replay no longer re-grants, so the '
              'comments in 0100 and this case are now wrong' end);
end
$probe$;
select case_name as case, result from probe_results where case_name = '05_REPLAY_REGRANTS_A_REMOVED_KEY';

-- ===========================================================================
-- 6. THE CARRY-ACROSS IS TRUTHFUL. Running the data migration against a
--    freshly-stranded row must move it to ready-to-send while PRESERVING when it
--    was raised and who raised it — not stamping now()/current-user, which would
--    fabricate an approval event that never happened.
-- ===========================================================================
do $probe$
declare v_status text; v_approved_at timestamptz; v_approved_by uuid;
  v_submitted constant timestamptz := now() - interval '3 days';
begin
  insert into inventory.purchase_orders
    (id, business_id, location_id, supplier_id, order_number, status, submitted_at, created_by)
  values
    ('ca000000-0000-0000-0000-0000000000b1','ca000000-0000-0000-0000-000000000001',
     'ca000000-0000-0000-0000-0000000000a1','ca000000-0000-0000-0000-000000000051',
     'PO-CA0001','pending_approval', v_submitted, null);

  -- Verbatim re-run of the 0100 carry-across.
  update inventory.purchase_orders
  set status = 'approved',
      approved_at = coalesce(approved_at, submitted_at, now()),
      approved_by = coalesce(approved_by, created_by),
      updated_at = now()
  where status = 'pending_approval';

  select status::text, approved_at, approved_by
    into v_status, v_approved_at, v_approved_by
  from inventory.purchase_orders where id = 'ca000000-0000-0000-0000-0000000000b1';

  insert into probe_results values ('06_CARRY_ACROSS_PRESERVES_HISTORY',
    case when v_status = 'approved' and v_approved_at = v_submitted then 'PASS'
         else 'FAIL: status=' || v_status || ' approved_at=' || coalesce(v_approved_at::text,'NULL')
              || ' (expected approved / ' || v_submitted::text || ')' end);
end
$probe$;
select case_name as case, result from probe_results where case_name = '06_CARRY_ACROSS_PRESERVES_HISTORY';

-- ===========================================================================
-- 7. AND AFTERWARDS NOTHING IS STRANDED. Nothing writes 'pending_approval' any more and the UI
--    offers no "Approve" button, so a row left in that state would be frozen:
--    un-sendable and un-cancellable from the new flow. Asserted AFTER case 6 has
--    created and migrated one, so it observes a real transition rather than an
--    empty table.
-- ===========================================================================
select '07_NO_ORDER_LEFT_PENDING_APPROVAL' as case,
       case when (select count(*) from inventory.purchase_orders
                  where status = 'pending_approval') = 0
       then 'PASS' else 'FAIL: orders are stranded in pending_approval' end as result;

-- ---------------------------------------------------------------------------
-- Teardown — nothing this suite created survives.
-- ---------------------------------------------------------------------------
rollback;
