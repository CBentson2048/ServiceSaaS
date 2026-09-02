-- message_usage_accounting.sql — behavioural suite for migration 0107.
--
-- WHY THIS FILE EXISTS. This is BILLING-GRADE evidence, and the guarantees that
-- make it trustworthy are DATABASE guarantees, not application ones: exactly-once
-- counting across retries and channel fallback, an atomic increment that derives
-- the overage from the new used count under one row lock, one period per BUSINESS
-- (never per location), an immutable snapshot of the tier that applied, and a
-- ledger no salon can write to. The Jest suites stub Supabase and cannot prove
-- any of that. This file runs the constraints, the functions and the policies for
-- real.
--
-- 42 numbered cases. Every one must read PASS.
--
-- Run against a SCRATCH database with every migration through 0108 applied:
--   psql -d <scratch> -f supabase/tests/message_usage_accounting.sql
--
-- Cases 31-42 cover the 0108 hardening: the SQL/TypeScript key mirror, the
-- chain root, the anti-join that bounds its LIMIT by MISSING ledger entries, and
-- the reminder OCCURRENCE discriminator.
--
-- KNOWN LIMITATION, stated rather than hidden: this suite runs on ONE connection,
-- so it cannot execute two genuinely simultaneous transactions. What it proves
-- instead is the property that makes concurrency safe — record_message_usage
-- performs NO read-modify-write, so repeated application composes exactly (case
-- 12 crosses the cap step by step and lands on the precise figures a concurrent
-- run must also produce). The single-statement UPDATE and the unique ledger key
-- are what carry that to real concurrency.

\set ON_ERROR_STOP off
\pset pager off

begin;

-- Fixtures: 'm5' prefix, distinct from every other suite.
insert into core.businesses (id,name,slug,timezone,tier) values
 ('05500000-0000-0000-0000-000000000001','Usage Salon','usage-salon','Europe/London','pulse'),
 ('05500000-0000-0000-0000-000000000002','Rival Usage','rival-usage','Europe/London','pulse');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('05500000-0000-0000-0000-0000000000a1','05500000-0000-0000-0000-000000000001','U1','Primrose Hill','m5-primrose','1 Regents Park Rd','London','NW1 8UG','Europe/London'),
 ('05500000-0000-0000-0000-0000000000a2','05500000-0000-0000-0000-000000000001','U2','Pinner','m5-pinner','2 High St','Pinner','HA5 1AA','Europe/London');

insert into auth.users (id,email) values
 ('05500000-0000-0000-0000-0000000000f1'::uuid,'owner@m5.example'),
 ('05500000-0000-0000-0000-0000000000f2'::uuid,'stylist@m5.example'),
 ('05500000-0000-0000-0000-0000000000f3'::uuid,'rival@m5.example');

insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name,is_active) values
 ('05500000-0000-0000-0000-0000000000f1','owner@m5.example','Olive Owner','Olive','Owner','Olive',true),
 ('05500000-0000-0000-0000-0000000000f2','stylist@m5.example','Sam Stylist','Sam','Stylist','Sam',true),
 ('05500000-0000-0000-0000-0000000000f3','rival@m5.example','Ray Rival','Ray','Rival','Ray',true);

insert into core.user_memberships (business_id,location_id,user_profile_id,role,status,activated_at) values
 ('05500000-0000-0000-0000-000000000001',null,'05500000-0000-0000-0000-0000000000f1','owner','active',now()),
 ('05500000-0000-0000-0000-000000000001','05500000-0000-0000-0000-0000000000a1','05500000-0000-0000-0000-0000000000f2','stylist','active',now()),
 ('05500000-0000-0000-0000-000000000002',null,'05500000-0000-0000-0000-0000000000f3','owner','active',now());

create temporary table probe_results (case_name text primary key, result text) on commit drop;

-- A local helper so each case reads as one message, not twelve arguments.
create or replace function pg_temp.send(
  p_key text,
  p_business uuid default '05500000-0000-0000-0000-000000000001',
  p_allowance integer default 100,
  p_unlimited boolean default false,
  p_period date default '2026-09-01'
) returns table (counted boolean, used_count integer, overage_count integer)
language sql as $$
  select r.counted, r.used_count, r.overage_count
  from comms.record_message_usage(
    p_business, p_key, p_period, (p_period + interval '1 month - 1 day')::date,
    'Europe/London', 'pulse', p_allowance, p_unlimited, 1,
    null, 'transactional', 'whatsapp', 'booking_confirmation'
  ) r;
$$;

-- ===========================================================================
-- 1-3. THE OBJECTS EXIST, and the superseded one is gone.
-- ===========================================================================
select '01_TABLES_EXIST' as case,
       case when to_regclass('core.tier_message_policy') is not null
             and to_regclass('comms.message_usage_periods') is not null
             and to_regclass('comms.message_usage_entries') is not null
            then 'PASS' else 'FAIL: a usage table is missing' end as result;

select '02_SUPERSEDED_TABLE_REMOVED' as case,
       case when to_regclass('comms.messaging_usage_counters') is null
            then 'PASS'
            else 'FAIL: the per-location 0059 counter table still exists alongside the new model' end as result;

select '03_POLICY_SHIPS_NON_BLOCKING' as case,
       case when (select count(*) from core.tier_message_policy) = 3
             and (select count(*) from core.tier_message_policy where enforcement_mode <> 'track_only') = 0
            then 'PASS'
            else 'FAIL: every tier should ship with track_only enforcement' end as result;

-- ===========================================================================
-- 3b. THE POLICY TABLE HOLDS NO ALLOWANCE NUMBERS. They live in
--     BUSINESS_TIER_LIMITS in @sheer/domain — the constant the API already
--     enforces tier limits from and the plan card already shows customers.
--     A stored copy would be a second source of truth that drifts from it.
-- ===========================================================================
select '03B_POLICY_HOLDS_NO_NUMBERS' as case,
       case when not exists (
              select 1 from information_schema.columns
              where table_schema='core' and table_name='tier_message_policy'
                and column_name in ('monthly_allowance','is_unlimited','cap','allowance')
            ) then 'PASS' else 'FAIL: the policy table duplicates the allowance numbers' end as result;

-- ===========================================================================
-- 4. THE PERIOD SNAPSHOTS THE LOCATION COUNT, so "why was the allowance 3,000?"
--    stays answerable after a location is opened or closed.
-- ===========================================================================
select '04_PERIOD_SNAPSHOTS_LOCATION_COUNT' as case,
       case when exists (
              select 1 from information_schema.columns
              where table_schema='comms' and table_name='message_usage_periods'
                and column_name='location_count'
            ) then 'PASS' else 'FAIL: the period does not record the location count' end as result;

-- ===========================================================================
-- 5-7. FIRST SEND, then the two ways a message must NOT be counted twice.
-- ===========================================================================
select '05_FIRST_SEND_COUNTS' as case,
       case when (select used_count from pg_temp.send('dk:biz1:msg-A')) = 1
            then 'PASS' else 'FAIL: the first send did not count' end as result;

-- A RETRY: the same logical key arriving again must change nothing.
select '06_RETRY_COUNTS_ONCE' as case,
       case when (select counted from pg_temp.send('dk:biz1:msg-A')) = false
             and (select used_count from comms.message_usage_periods
                   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-09-01') = 1
            then 'PASS' else 'FAIL: a retry double counted' end as result;

-- A FALLBACK: WhatsApp then SMS are two notification_events rows sharing one
-- logical key. That is the whole reason the key excludes the channel.
select '07_FALLBACK_COUNTS_ONCE' as case,
       case when (select count(*) from comms.message_usage_entries
                   where business_id='05500000-0000-0000-0000-000000000001'
                     and logical_message_key='dk:biz1:msg-A') = 1
            then 'PASS' else 'FAIL: a fallback pair produced more than one ledger entry' end as result;

-- ===========================================================================
-- 8. THE LEDGER'S UNIQUE KEY IS THE GUARANTEE — even a direct insert is refused.
-- ===========================================================================
do $$ begin
  insert into comms.message_usage_entries (business_id, period_id, logical_message_key, final_channel)
  select '05500000-0000-0000-0000-000000000001', id, 'dk:biz1:msg-A', 'sms'
  from comms.message_usage_periods
  where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-09-01';
  insert into probe_results values ('08_LEDGER_KEY_ENFORCED','FAIL: a duplicate ledger entry was inserted directly');
exception when unique_violation then
  insert into probe_results values ('08_LEDGER_KEY_ENFORCED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='08_LEDGER_KEY_ENFORCED';

-- ===========================================================================
-- 9. TWO LOCATIONS, ONE ALLOWANCE. The period is keyed on business_id alone, so
--    a multi-location salon can never receive a second allowance.
-- ===========================================================================
select pg_temp.send('dk:biz1:loc-a-msg');
select pg_temp.send('dk:biz1:loc-b-msg');
select '09_ONE_PERIOD_PER_BUSINESS' as case,
       case when (select count(*) from comms.message_usage_periods
                   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-09-01') = 1
             and (select used_count from comms.message_usage_periods
                   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-09-01') = 3
            then 'PASS' else 'FAIL: locations did not share one business period' end as result;

-- ===========================================================================
-- 10. TENANT ISOLATION. Business B is untouched by anything above.
-- ===========================================================================
select pg_temp.send('dk:biz2:msg-A', '05500000-0000-0000-0000-000000000002');
select '10_TENANT_ISOLATION' as case,
       case when (select used_count from comms.message_usage_periods
                   where business_id='05500000-0000-0000-0000-000000000002' and period_start='2026-09-01') = 1
             and (select used_count from comms.message_usage_periods
                   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-09-01') = 3
            then 'PASS' else 'FAIL: one business''s usage affected another''s' end as result;

-- ===========================================================================
-- 11. THE SAME LOGICAL KEY IN TWO BUSINESSES IS TWO MESSAGES. The ledger is
--     unique per (business, key), not globally.
-- ===========================================================================
select '11_KEY_SCOPED_TO_BUSINESS' as case,
       case when (select counted from pg_temp.send('dk:biz1:msg-A', '05500000-0000-0000-0000-000000000002')) = true
            then 'PASS' else 'FAIL: a key from another business blocked this one' end as result;

-- ===========================================================================
-- 12. THE CAP BOUNDARY, EXACTLY. Allowance 5. Walk up to it and over it.
--
--     This is also the concurrency proof available on one connection: the
--     recorder does no read-modify-write, so applying it repeatedly lands on the
--     exact figures a concurrent run must also produce. used=6 with overage=1
--     is only reachable if each increment derived its overage from the NEW used
--     value inside the same statement.
-- ===========================================================================
do $$
declare i integer; v_used integer; v_over integer;
begin
  for i in 1..4 loop
    select used_count, overage_count into v_used, v_over
    from pg_temp.send('cap:msg-' || i, '05500000-0000-0000-0000-000000000001', 5, false, '2026-10-01');
  end loop;
  insert into probe_results values ('12A_BELOW_CAP',
    case when v_used = 4 and v_over = 0 then 'PASS'
         else 'FAIL: at 4 of 5 got used=' || v_used || ' overage=' || v_over end);

  select used_count, overage_count into v_used, v_over
  from pg_temp.send('cap:msg-5', '05500000-0000-0000-0000-000000000001', 5, false, '2026-10-01');
  insert into probe_results values ('12B_AT_CAP',
    case when v_used = 5 and v_over = 0 then 'PASS'
         else 'FAIL: AT the cap got used=' || v_used || ' overage=' || v_over || ' (overage must still be 0)' end);

  select used_count, overage_count into v_used, v_over
  from pg_temp.send('cap:msg-6', '05500000-0000-0000-0000-000000000001', 5, false, '2026-10-01');
  insert into probe_results values ('12C_FIRST_OVERAGE',
    case when v_used = 6 and v_over = 1 then 'PASS'
         else 'FAIL: first message past the cap got used=' || v_used || ' overage=' || v_over end);

  for i in 7..10 loop
    select used_count, overage_count into v_used, v_over
    from pg_temp.send('cap:msg-' || i, '05500000-0000-0000-0000-000000000001', 5, false, '2026-10-01');
  end loop;
  insert into probe_results values ('12D_OVERAGE_ACCUMULATES',
    case when v_used = 10 and v_over = 5 then 'PASS'
         else 'FAIL: at 10 of 5 got used=' || v_used || ' overage=' || v_over end);
end $$;
select case_name as case, result from probe_results where case_name like '12%' order by case_name;

-- ===========================================================================
-- 13. A CONFIGURED ZERO ALLOWANCE. Legitimate, and NOT the same as unconfigured:
--     the first message is immediately overage 1.
-- ===========================================================================
do $$
declare v_used integer; v_over integer;
begin
  select used_count, overage_count into v_used, v_over
  from pg_temp.send('zero:msg-1', '05500000-0000-0000-0000-000000000001', 0, false, '2026-11-01');
  insert into probe_results values ('13_ZERO_ALLOWANCE',
    case when v_used = 1 and v_over = 1 then 'PASS'
         else 'FAIL: zero allowance gave used=' || v_used || ' overage=' || v_over end);
end $$;
select case_name as case, result from probe_results where case_name='13_ZERO_ALLOWANCE';

-- ===========================================================================
-- 14. AN UNCONFIGURED ALLOWANCE COUNTS BUT NEVER OVERAGES. An overage against
--     an unknown allowance would be a fabricated number.
-- ===========================================================================
do $$
declare v_used integer; v_over integer;
begin
  select used_count, overage_count into v_used, v_over
  from pg_temp.send('unset:msg-1', '05500000-0000-0000-0000-000000000001', null, false, '2026-12-01');
  select used_count, overage_count into v_used, v_over
  from pg_temp.send('unset:msg-2', '05500000-0000-0000-0000-000000000001', null, false, '2026-12-01');
  insert into probe_results values ('14_UNCONFIGURED_COUNTS_NO_OVERAGE',
    case when v_used = 2 and v_over = 0 then 'PASS'
         else 'FAIL: unconfigured gave used=' || v_used || ' overage=' || v_over end);
end $$;
select case_name as case, result from probe_results where case_name='14_UNCONFIGURED_COUNTS_NO_OVERAGE';

-- ===========================================================================
-- 15. AN UNLIMITED TIER TRACKS USAGE BUT IS NEVER OVER.
-- ===========================================================================
do $$
declare i integer; v_used integer; v_over integer;
begin
  for i in 1..7 loop
    select used_count, overage_count into v_used, v_over
    from pg_temp.send('unl:msg-' || i, '05500000-0000-0000-0000-000000000001', null, true, '2027-01-01');
  end loop;
  insert into probe_results values ('15_UNLIMITED_TRACKS_NEVER_OVERAGES',
    case when v_used = 7 and v_over = 0 then 'PASS'
         else 'FAIL: unlimited gave used=' || v_used || ' overage=' || v_over end);
end $$;
select case_name as case, result from probe_results where case_name='15_UNLIMITED_TRACKS_NEVER_OVERAGES';

-- ===========================================================================
-- 16-17. MONTH ROLLOVER. A new month is a NEW period; the old one is untouched.
--        No cron, no reset, no zeroing — period SELECTION does the work.
-- ===========================================================================
select '16_NEW_PERIOD_STARTS_FRESH' as case,
       case when (select used_count from pg_temp.send('roll:sep-last', '05500000-0000-0000-0000-000000000001', 100, false, '2026-09-01')) = 4
             and (select used_count from pg_temp.send('roll:oct-first', '05500000-0000-0000-0000-000000000002', 100, false, '2026-10-01')) = 1
            then 'PASS' else 'FAIL: the new period did not start fresh' end as result;

select '17_OLD_PERIOD_PRESERVED' as case,
       case when (select used_count from comms.message_usage_periods
                   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-09-01') = 4
             and (select count(*) from comms.message_usage_periods
                   where business_id='05500000-0000-0000-0000-000000000001') >= 4
            then 'PASS' else 'FAIL: a previous period was destroyed or altered' end as result;

-- ===========================================================================
-- 18-19. TIER SNAPSHOT. The period records which allowance applied, and a later
--        tier change CANNOT rewrite that history.
-- ===========================================================================
select '18_PERIOD_SNAPSHOTS_TIER' as case,
       case when (select tier_key from comms.message_usage_periods
                   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-10-01') = 'pulse'
             and (select allowance from comms.message_usage_periods
                   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-10-01') = 5
            then 'PASS' else 'FAIL: the period did not snapshot the tier and allowance' end as result;

-- Send again mid-period claiming a DIFFERENT tier and allowance, as an upgrade
-- would. The snapshot must not move.
select pg_temp.send('tierchange:msg', '05500000-0000-0000-0000-000000000001', 9999, false, '2026-10-01');
select '19_TIER_CHANGE_CANNOT_REWRITE_HISTORY' as case,
       case when (select allowance from comms.message_usage_periods
                   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-10-01') = 5
            then 'PASS'
            else 'FAIL: a later send overwrote the period''s allowance snapshot' end as result;

-- ===========================================================================
-- 20. THE LEDGER HOLDS NO CLIENT CONTENT. Billing needs counts, not private
--     correspondence.
-- ===========================================================================
select '20_LEDGER_HAS_NO_CONTENT' as case,
       case when not exists (
              select 1 from information_schema.columns
              where table_schema='comms' and table_name='message_usage_entries'
                and column_name in ('body','content','recipient','client_profile_id','phone','email')
            ) then 'PASS' else 'FAIL: the usage ledger carries message or client content' end as result;

-- ===========================================================================
-- 21-23. RECONCILIATION. The ledger is the source of truth; drift is detected
--        and only repaired on request.
-- ===========================================================================
select '21_RECONCILE_CLEAN' as case,
       case when (select counter_used = ledger_used and counter_overage = ledger_overage
                  from comms.reconcile_message_usage('05500000-0000-0000-0000-000000000001','2026-10-01',false))
            then 'PASS' else 'FAIL: a healthy period did not reconcile' end as result;

-- Corrupt a counter behind the recorder's back, as a lost write would.
update comms.message_usage_periods set used_count = 999
 where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-10-01';

select '22_RECONCILE_DETECTS_DRIFT' as case,
       case when (select counter_used <> ledger_used
                  from comms.reconcile_message_usage('05500000-0000-0000-0000-000000000001','2026-10-01',false))
            then 'PASS' else 'FAIL: drift was not detected' end as result;

-- The repair runs in its OWN statement. Folding it into a boolean expression
-- alongside a read of the row it repairs would depend on Postgres's evaluation
-- order inside that expression, which is not defined — the read could happen
-- before the side effect and the case would fail against correct code.
do $$
declare v_applied boolean; v_after integer; v_ledger integer;
begin
  select applied into v_applied
  from comms.reconcile_message_usage('05500000-0000-0000-0000-000000000001','2026-10-01',true);

  select used_count into v_after from comms.message_usage_periods
   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-10-01';

  select count(*)::integer into v_ledger from comms.message_usage_entries e
   join comms.message_usage_periods p on p.id = e.period_id
   where p.business_id='05500000-0000-0000-0000-000000000001' and p.period_start='2026-10-01';

  insert into probe_results values ('23_RECONCILE_REPAIRS_FROM_LEDGER',
    case when v_applied and v_after = v_ledger then 'PASS'
         else 'FAIL: applied=' || coalesce(v_applied::text,'null')
              || ' counter=' || coalesce(v_after::text,'null')
              || ' ledger=' || coalesce(v_ledger::text,'null') end);
end $$;
select case_name as case, result from probe_results where case_name='23_RECONCILE_REPAIRS_FROM_LEDGER';

-- ===========================================================================
-- 24-25. PERIOD INTEGRITY CONSTRAINTS.
-- ===========================================================================
do $$ begin
  insert into comms.message_usage_periods (business_id, period_start, period_end, tier_key)
  values ('05500000-0000-0000-0000-000000000001','2026-09-01','2026-09-30','pulse');
  insert into probe_results values ('24_ONE_PERIOD_ROW_PER_MONTH','FAIL: a duplicate period row was accepted');
exception when unique_violation then
  insert into probe_results values ('24_ONE_PERIOD_ROW_PER_MONTH','PASS');
end $$;
select case_name as case, result from probe_results where case_name='24_ONE_PERIOD_ROW_PER_MONTH';

do $$ begin
  insert into comms.message_usage_periods (business_id, period_start, period_end, tier_key)
  values ('05500000-0000-0000-0000-000000000001','2027-06-01','2027-05-01','pulse');
  insert into probe_results values ('25_PERIOD_ORDER_ENFORCED','FAIL: an inverted period was accepted');
exception when check_violation then
  insert into probe_results values ('25_PERIOD_ORDER_ENFORCED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='25_PERIOD_ORDER_ENFORCED';

-- ===========================================================================
-- 25b. THE updated_at TRIGGER FIRES on a usage period.
--
--      Deliberately NOT "read, sleep, update, re-read": public.set_updated_at()
--      assigns now(), which is TRANSACTION START TIME and constant for this whole
--      suite, so that version passes without the trigger and fails with it.
--      Back-dating first makes the assertion real.
-- ===========================================================================
do $$ declare after_ts timestamptz; begin
  update comms.message_usage_periods set updated_at = timestamptz '2000-01-01 00:00:00Z'
   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-09-01';
  update comms.message_usage_periods set timezone = 'Europe/London'
   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-09-01';
  select updated_at into after_ts from comms.message_usage_periods
   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-09-01';
  insert into probe_results values ('25B_UPDATED_AT_TRIGGER',
    case when after_ts = now() then 'PASS' else 'FAIL: updated_at left at ' || after_ts::text end);
end $$;
select case_name as case, result from probe_results where case_name='25B_UPDATED_AT_TRIGGER';

-- ===========================================================================
-- 26. THE RECORDING FUNCTIONS ARE NOT PUBLICLY CALLABLE. Otherwise any signed-in
--     user could tell the server how many messages they sent.
-- ===========================================================================
select '26_FUNCTION_GRANTS_NARROW' as case,
       case when not has_function_privilege('authenticated',
              'comms.record_message_usage(uuid,text,date,date,text,text,integer,boolean,integer,uuid,text,text,text)','execute')
             and not has_function_privilege('anon',
              'comms.record_message_usage(uuid,text,date,date,text,text,integer,boolean,integer,uuid,text,text,text)','execute')
             and not has_function_privilege('authenticated',
              'comms.reconcile_message_usage(uuid,date,boolean)','execute')
             and has_function_privilege('service_role',
              'comms.record_message_usage(uuid,text,date,date,text,text,integer,boolean,integer,uuid,text,text,text)','execute')
            then 'PASS' else 'FAIL: usage functions are callable by the wrong role' end as result;

-- ===========================================================================
-- 27. AN OWNER MAY READ their own usage.
-- ===========================================================================
do $$ declare visible integer; begin
  perform set_config('request.jwt.claim.sub','05500000-0000-0000-0000-0000000000f1',true);
  set local role authenticated;
  select count(*) into visible from comms.message_usage_periods
   where business_id='05500000-0000-0000-0000-000000000001';
  reset role;
  insert into probe_results values ('27_OWNER_CAN_READ',
    case when visible >= 1 then 'PASS' else 'FAIL: an owner could not read their own usage' end);
exception when others then
  reset role;
  insert into probe_results values ('27_OWNER_CAN_READ','FAIL: unexpected ' || sqlstate || ' ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='27_OWNER_CAN_READ';

-- ===========================================================================
-- 28. NOBODY MAY WRITE USAGE FROM A BROWSER SESSION. A salon must not be able to
--     tell the server it sent fewer messages than it did.
-- ===========================================================================
do $$ begin
  perform set_config('request.jwt.claim.sub','05500000-0000-0000-0000-0000000000f1',true);
  set local role authenticated;
  update comms.message_usage_periods set used_count = 0
   where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-10-01';
  reset role;
  insert into probe_results values ('28_USAGE_NOT_BROWSER_WRITABLE',
    case when (select used_count from comms.message_usage_periods
                where business_id='05500000-0000-0000-0000-000000000001' and period_start='2026-10-01') = 11
         then 'PASS' else 'FAIL: an owner zeroed their own usage from a session' end);
exception when insufficient_privilege then
  reset role;
  insert into probe_results values ('28_USAGE_NOT_BROWSER_WRITABLE','PASS');
when others then
  reset role;
  insert into probe_results values ('28_USAGE_NOT_BROWSER_WRITABLE','FAIL: unexpected ' || sqlstate || ' ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='28_USAGE_NOT_BROWSER_WRITABLE';

-- ===========================================================================
-- 29. A STYLIST SEES NO ACCOUNT USAGE. It is commercial data, not shift data.
-- ===========================================================================
do $$ declare visible integer; begin
  perform set_config('request.jwt.claim.sub','05500000-0000-0000-0000-0000000000f2',true);
  set local role authenticated;
  select count(*) into visible from comms.message_usage_periods
   where business_id='05500000-0000-0000-0000-000000000001';
  reset role;
  insert into probe_results values ('29_STYLIST_SEES_NOTHING',
    case when visible = 0 then 'PASS' else 'FAIL: a stylist read ' || visible || ' usage periods' end);
exception when insufficient_privilege then
  reset role;
  insert into probe_results values ('29_STYLIST_SEES_NOTHING','PASS');
when others then
  reset role;
  insert into probe_results values ('29_STYLIST_SEES_NOTHING','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='29_STYLIST_SEES_NOTHING';

-- ===========================================================================
-- 30. ANOTHER BUSINESS'S OWNER SEES NOTHING.
-- ===========================================================================
do $$ declare leaked integer; begin
  perform set_config('request.jwt.claim.sub','05500000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  select count(*) into leaked from comms.message_usage_periods
   where business_id='05500000-0000-0000-0000-000000000001';
  reset role;
  insert into probe_results values ('30_CROSS_BUSINESS_HIDDEN',
    case when leaked = 0 then 'PASS' else 'FAIL: another business''s usage was readable' end);
exception when others then
  reset role;
  insert into probe_results values ('30_CROSS_BUSINESS_HIDDEN','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='30_CROSS_BUSINESS_HIDDEN';

-- ===========================================================================
-- 31-33. THE SQL KEY MIRRORS THE TYPESCRIPT ONE (0108).
--
-- comms.logical_message_key only ever FILTERS the recovery scan — the key
-- written to the ledger is always the API's. But a divergence would still waste
-- work and hide gaps, so the same golden vectors are pinned here and in
-- message-usage-rules.spec.ts. Change one without the other and this goes red.
-- ===========================================================================

select '31_KEY_GOLDEN_VECTORS' as case,
       case when comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', 'camp:1', null, 'k', '05500000-0000-0000-0000-0000000000e1')
                 = 'dk:05500000-0000-0000-0000-000000000001:camp:1'
             and comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', null,
                   '05500000-0000-0000-0000-0000000000b1', 'booking_confirmation',
                   '05500000-0000-0000-0000-0000000000e1')
                 = 'ap:05500000-0000-0000-0000-0000000000b1:booking_confirmation'
             and comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', null, null, 'k', '05500000-0000-0000-0000-0000000000e1')
                 = 'ev:05500000-0000-0000-0000-0000000000e1'
            then 'PASS' else 'FAIL: SQL key does not match the TypeScript vectors' end as result;

select '32_KEY_PRECEDENCE_AND_TRIM' as case,
       case when comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', ' camp:1 ',
                   '05500000-0000-0000-0000-0000000000b1', 'k', '05500000-0000-0000-0000-0000000000e1')
                 = 'dk:05500000-0000-0000-0000-000000000001:camp:1'
             -- A whitespace-only dedupe key is NOT a key, exactly as JS trim() decides.
             and comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', '   ',
                   '05500000-0000-0000-0000-0000000000b1', 'k', '05500000-0000-0000-0000-0000000000e1')
                 = 'ap:05500000-0000-0000-0000-0000000000b1:k'
            then 'PASS' else 'FAIL: precedence or trimming differs from logicalMessageKey()' end as result;

select '33_KEY_FOLLOWS_CHAIN_ROOT' as case,
       case when comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', null, null, 'k',
                   '05500000-0000-0000-0000-0000000000e2', '05500000-0000-0000-0000-0000000000e1')
                 = 'ev:05500000-0000-0000-0000-0000000000e1'
             -- ...and a message with a real key ignores the root entirely.
             and comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', 'camp:1', null, 'k',
                   '05500000-0000-0000-0000-0000000000e2', '05500000-0000-0000-0000-0000000000e1')
                 = 'dk:05500000-0000-0000-0000-000000000001:camp:1'
            then 'PASS' else 'FAIL: the chain root is not honoured as the last-resort identity' end as result;

-- ===========================================================================
-- 34-38. THE ANTI-JOIN. The bound must apply to MISSING entries, not to traffic.
-- ===========================================================================

-- Three sent events for the fixture business: two already accounted, one not.
insert into comms.notification_events
  (id, business_id, location_id, client_profile_id, appointment_id, channel, event_key, status,
   scheduled_for, sent_at, dedupe_key, payload_json)
values
  ('05500000-0000-0000-0000-0000000000c1','05500000-0000-0000-0000-000000000001',
   '05500000-0000-0000-0000-0000000000a1', null, null, 'whatsapp', 'campaign:x', 'sent',
   now() - interval '10 days', now() - interval '10 days', 'acc-old-1', '{}'::jsonb),
  ('05500000-0000-0000-0000-0000000000c2','05500000-0000-0000-0000-000000000001',
   '05500000-0000-0000-0000-0000000000a1', null, null, 'whatsapp', 'campaign:x', 'sent',
   now() - interval '9 days', now() - interval '9 days', 'acc-old-2', '{}'::jsonb),
  -- THE GAP: older than nothing in particular, but it must still be found.
  ('05500000-0000-0000-0000-0000000000c3','05500000-0000-0000-0000-000000000001',
   '05500000-0000-0000-0000-0000000000a1', null, null, 'whatsapp', 'campaign:x', 'sent',
   now() - interval '30 days', now() - interval '30 days', 'the-gap', '{}'::jsonb),
  -- Push is not countable and must never be offered for recovery.
  ('05500000-0000-0000-0000-0000000000c4','05500000-0000-0000-0000-000000000001',
   '05500000-0000-0000-0000-0000000000a1', null, null, 'push', 'campaign:x', 'sent',
   now() - interval '5 days', now() - interval '5 days', 'push-msg', '{}'::jsonb),
  -- Never sent: no sent_at, so there is nothing to account for.
  ('05500000-0000-0000-0000-0000000000c5','05500000-0000-0000-0000-000000000001',
   '05500000-0000-0000-0000-0000000000a1', null, null, 'whatsapp', 'campaign:x', 'queued',
   now(), null, 'never-sent', '{}'::jsonb);

select pg_temp.send('dk:05500000-0000-0000-0000-000000000001:acc-old-1');
select pg_temp.send('dk:05500000-0000-0000-0000-000000000001:acc-old-2');

select '34_ANTIJOIN_FINDS_ONLY_THE_GAP' as case,
       case when (select count(*) from comms.find_unaccounted_sends(
                    100, 0, '05500000-0000-0000-0000-000000000001')) = 1
             and (select f.dedupe_key from comms.find_unaccounted_sends(
                    100, 0, '05500000-0000-0000-0000-000000000001') f) = 'the-gap'
            then 'PASS' else 'FAIL: the anti-join did not isolate the unaccounted send' end as result;

select '35_LIMIT_BOUNDS_GAPS_NOT_TRAFFIC' as case,
       -- A limit of 1 with two accounted sends in the way STILL returns the gap.
       -- Under the old newest-500 scan the bound was spent on accounted rows.
       case when (select f.dedupe_key from comms.find_unaccounted_sends(
                    1, 0, '05500000-0000-0000-0000-000000000001') f) = 'the-gap'
            then 'PASS' else 'FAIL: the limit is being spent on already-accounted sends' end as result;

select '36_NON_COUNTABLE_AND_UNSENT_EXCLUDED' as case,
       case when not exists (
              select 1 from comms.find_unaccounted_sends(100, 0, '05500000-0000-0000-0000-000000000001') f
               where f.dedupe_key in ('push-msg', 'never-sent'))
            then 'PASS' else 'FAIL: a push or unsent event was offered for recovery' end as result;

select '37_GRACE_WINDOW_HOLDS_BACK_FRESH_SENDS' as case,
       -- A 60-day grace excludes everything here, so recovery can never race the
       -- recordSend the dispatcher is running right now.
       case when (select count(*) from comms.find_unaccounted_sends(
                    100, 5184000, '05500000-0000-0000-0000-000000000001')) = 0
            then 'PASS' else 'FAIL: the grace window did not hold back a recent send' end as result;

-- Recording it must be a separate statement from re-scanning: two scalar
-- subqueries in one CASE have no guaranteed evaluation order, so the scan could
-- otherwise run BEFORE the write it is meant to observe.
select r.counted as recorded_the_gap
from pg_temp.send('dk:05500000-0000-0000-0000-000000000001:the-gap') r;

select '38_RECOVERY_CLOSES_THE_GAP' as case,
       case when (select count(*) from comms.find_unaccounted_sends(
                    100, 0, '05500000-0000-0000-0000-000000000001')) = 0
            then 'PASS' else 'FAIL: recording the gap did not remove it from the scan' end as result;

-- ===========================================================================
-- 39-42. THE REMINDER OCCURRENCE DISCRIMINATOR (Wrike section 13).
--
-- One appointment can legitimately emit the same reminder event_key twice: send
-- the 24h reminder, reschedule, and the client must be reminded again. Both used
-- to collapse onto ap:<appointment>:<event_key> and the second was free.
-- ===========================================================================

select '39_OCCURRENCE_KEY_REMINDERS_ONLY' as case,
       case when comms.reminder_occurrence_key('appointment_reminder_24h',
                   '{"appointment_start":"2026-10-01T09:00:00Z"}'::jsonb) = '2026-10-01T09:00:00Z'
             -- One-shot messages have no occurrence: their snapshot may be
             -- refreshed mid-fallback, so keying on it would count twice.
             and comms.reminder_occurrence_key('booking_confirmation',
                   '{"appointment_start":"2026-10-01T09:00:00Z"}'::jsonb) is null
             and comms.reminder_occurrence_key('rebooking_nudge',
                   '{"appointment_start":"2026-10-01T09:00:00Z"}'::jsonb) is null
             and comms.reminder_occurrence_key('appointment_reminder_24h', '{}'::jsonb) is null
            then 'PASS' else 'FAIL: occurrence key does not match reminderOccurrenceKey()' end as result;

select '40_OCCURRENCE_SPLITS_TWO_REMINDERS' as case,
       case when comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', null,
                   '05500000-0000-0000-0000-0000000000b1', 'appointment_reminder_24h',
                   '05500000-0000-0000-0000-0000000000e1', null, '2026-10-01T09:00:00Z')
                 <> comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', null,
                   '05500000-0000-0000-0000-0000000000b1', 'appointment_reminder_24h',
                   '05500000-0000-0000-0000-0000000000e2', null, '2026-10-08T09:00:00Z')
             -- ...while a fallback of ONE occurrence (different event id, same
             -- anchor) still resolves to a single identity.
             and comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', null,
                   '05500000-0000-0000-0000-0000000000b1', 'appointment_reminder_24h',
                   '05500000-0000-0000-0000-0000000000e1', null, '2026-10-01T09:00:00Z')
                 = comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', null,
                   '05500000-0000-0000-0000-0000000000b1', 'appointment_reminder_24h',
                   '05500000-0000-0000-0000-0000000000e2', null, '2026-10-01T09:00:00Z')
            then 'PASS' else 'FAIL: occurrence does not separate two reminders, or splits one' end as result;

select '41_ONE_SHOT_KEYS_UNCHANGED' as case,
       -- The previous fix's keys must be byte-for-byte what they were.
       case when comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', null,
                   '05500000-0000-0000-0000-0000000000b1', 'booking_confirmation',
                   '05500000-0000-0000-0000-0000000000e1')
                 = 'ap:05500000-0000-0000-0000-0000000000b1:booking_confirmation'
             and comms.logical_message_key(
                   '05500000-0000-0000-0000-000000000001', 'camp:1', null, 'k',
                   '05500000-0000-0000-0000-0000000000e1', null, '2026-10-01T09:00:00Z')
                 = 'dk:05500000-0000-0000-0000-000000000001:camp:1'
            then 'PASS' else 'FAIL: a one-shot or campaign identity changed' end as result;

-- THE REAL SEQUENCE, and note what it proves about the schema. The partial index
-- notification_events_booking_event_unique_idx (appointment_id, event_key,
-- channel) where status <> 'cancelled' means two LIVE occurrences cannot coexist
-- on one channel — so a second occurrence only ever exists because the first was
-- retired to 'cancelled' by retireHandedOverEvent after it handed over. That is
-- exactly the path this ticket is about, and it is the only one that can produce
-- a genuine second reminder today.
insert into core.client_profiles (id, business_id, first_name, last_name)
values ('05500000-0000-0000-0000-0000000000c9','05500000-0000-0000-0000-000000000001','Rem','Inder');

insert into booking.appointments
  (id, business_id, location_id, client_profile_id, scheduled_start_at, scheduled_end_at, occupied_ranges)
values ('05500000-0000-0000-0000-0000000000b9','05500000-0000-0000-0000-000000000001',
        '05500000-0000-0000-0000-0000000000a1','05500000-0000-0000-0000-0000000000c9',
        timestamptz '2026-10-08 09:00:00+00', timestamptz '2026-10-08 10:00:00+00',
        tstzmultirange(tstzrange(timestamptz '2026-10-08 09:00:00+00',
                                 timestamptz '2026-10-08 10:00:00+00')));

insert into comms.notification_events
  (id, business_id, location_id, client_profile_id, appointment_id, channel, event_key, status,
   scheduled_for, sent_at, payload_json)
values
  -- Occurrence A on WhatsApp: never sent, handed over, then retired.
  ('05500000-0000-0000-0000-0000000000d1','05500000-0000-0000-0000-000000000001',
   '05500000-0000-0000-0000-0000000000a1', null, '05500000-0000-0000-0000-0000000000b9',
   'whatsapp', 'appointment_reminder_24h', 'cancelled', now() - interval '3 days', null,
   '{"appointment_start":"2026-10-01T09:00:00Z"}'::jsonb),
  -- The SMS fallback of occurrence A: SENT, and carrying the SAME anchor.
  ('05500000-0000-0000-0000-0000000000d2','05500000-0000-0000-0000-000000000001',
   '05500000-0000-0000-0000-0000000000a1', null, '05500000-0000-0000-0000-0000000000b9',
   'sms', 'appointment_reminder_24h', 'sent', now() - interval '3 days', now() - interval '3 days',
   '{"appointment_start":"2026-10-01T09:00:00Z"}'::jsonb),
  -- The appointment moved. Occurrence B is a genuinely second communication,
  -- and the retired row above is what frees the channel slot for it.
  ('05500000-0000-0000-0000-0000000000d3','05500000-0000-0000-0000-000000000001',
   '05500000-0000-0000-0000-0000000000a1', null, '05500000-0000-0000-0000-0000000000b9',
   'whatsapp', 'appointment_reminder_24h', 'sent', now() - interval '2 days', now() - interval '2 days',
   '{"appointment_start":"2026-10-08T09:00:00Z"}'::jsonb);

select '42_ANTIJOIN_SEES_TWO_OCCURRENCES_NOT_THREE_SENDS' as case,
       -- Two SENT rows, two distinct occurrences, two logical messages. Before
       -- this fix both collapsed onto one key and the second was billed as zero.
       case when (select count(distinct f.logical_message_key)
                    from comms.find_unaccounted_sends(100, 0, '05500000-0000-0000-0000-000000000001') f
                   where f.appointment_id = '05500000-0000-0000-0000-0000000000b9') = 2
            then 'PASS'
            else 'FAIL: expected 2 logical messages across 3 reminder sends, got '
                 || (select count(distinct f.logical_message_key)::text
                       from comms.find_unaccounted_sends(100, 0, '05500000-0000-0000-0000-000000000001') f
                      where f.appointment_id = '05500000-0000-0000-0000-0000000000b9') end as result;

-- ---------------------------------------------------------------------------
-- Summary. Any row that is not PASS is a failure, and a count of zero means the
-- suite aborted rather than succeeded.
-- ---------------------------------------------------------------------------
select 'SUMMARY' as case,
       count(*) filter (where result = 'PASS')::text || ' of ' || count(*)::text
         || ' recorded probe cases passed' as result
from probe_results;

rollback;
