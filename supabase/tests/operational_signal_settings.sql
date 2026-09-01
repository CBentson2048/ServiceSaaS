-- operational_signal_settings.sql — behavioural suite for migration 0106.
--
-- WHY THIS FILE EXISTS. The Jest suites stub the Supabase client, so they prove
-- only that the SERVICE asks for the right things. They cannot prove that the
-- database refuses a -200% threshold or a medium rate above the high rate, that
-- the business-wide row collides with itself while a per-location override
-- coexists, that a manager querying analytics.operational_signal_settings
-- directly through PostgREST can read but not write it, or that the read-path
-- indexes the four signals depend on exist with the right predicates. This file
-- is that proof, and it runs the constraints and the policies for real.
--
-- 20 numbered cases. Every one must read PASS.
--
-- Run against a SCRATCH database with every migration through 0106 applied:
--   psql -d <scratch> -f supabase/tests/operational_signal_settings.sql
--
-- The suite runs inside one transaction that is rolled back at the end. Every
-- expected failure runs inside a plpgsql block whose exception handler records
-- the verdict, so the rejected write is undone while the evidence that it WAS
-- rejected survives. A savepoint/rollback probe would prove nothing: the
-- rollback removes the row whether the constraint rejected it or accepted it.

\set ON_ERROR_STOP off
\pset pager off

begin;

-- Fixtures: '05' prefix, distinct from every other suite.
insert into core.businesses (id,name,slug,timezone) values
 ('05000000-0000-0000-0000-000000000001','Signal Salon','signal-salon','Europe/London'),
 ('05000000-0000-0000-0000-000000000002','Rival Signals','rival-signals','Europe/London');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('05000000-0000-0000-0000-0000000000a1','05000000-0000-0000-0000-000000000001','S1','Primrose Hill','os-primrose','1 Regents Park Rd','London','NW1 8UG','Europe/London'),
 ('05000000-0000-0000-0000-0000000000a2','05000000-0000-0000-0000-000000000001','S2','Pinner','os-pinner','2 High St','Pinner','HA5 1AA','Europe/London');

insert into auth.users (id,email) values
 ('05000000-0000-0000-0000-0000000000f1'::uuid,'owner@os.example'),
 ('05000000-0000-0000-0000-0000000000f2'::uuid,'manager@os.example'),
 ('05000000-0000-0000-0000-0000000000f3'::uuid,'rival@os.example');

insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name,is_active) values
 ('05000000-0000-0000-0000-0000000000f1','owner@os.example','Olive Owner','Olive','Owner','Olive',true),
 ('05000000-0000-0000-0000-0000000000f2','manager@os.example','Mo Manager','Mo','Manager','Mo',true),
 ('05000000-0000-0000-0000-0000000000f3','rival@os.example','Ray Rival','Ray','Rival','Ray',true);

insert into core.user_memberships (business_id,location_id,user_profile_id,role,status,activated_at) values
 ('05000000-0000-0000-0000-000000000001',null,'05000000-0000-0000-0000-0000000000f1','owner','active',now()),
 ('05000000-0000-0000-0000-000000000001','05000000-0000-0000-0000-0000000000a1','05000000-0000-0000-0000-0000000000f2','manager','active',now()),
 ('05000000-0000-0000-0000-000000000002',null,'05000000-0000-0000-0000-0000000000f3','owner','active',now());

create temporary table probe_results (case_name text primary key, result text) on commit drop;

-- ===========================================================================
-- 1. THE TABLE EXISTS.
-- ===========================================================================
select '01_TABLE_EXISTS' as case,
       case when to_regclass('analytics.operational_signal_settings') is not null
            then 'PASS' else 'FAIL: table is missing' end as result;

-- ===========================================================================
-- 2. PLATFORM DEFAULTS match DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS exactly.
--    If these drift, the database and the calculators disagree about what a
--    salon that configured nothing is actually running on.
-- ===========================================================================
insert into analytics.operational_signal_settings (business_id)
values ('05000000-0000-0000-0000-000000000001');

select '02_DEFAULTS_MATCH_DOMAIN' as case,
       case when (select spend_window_visits = 3 and spend_materiality_percent = 15
                    and no_show_lookback_days = 365 and no_show_minimum_appointments = 5
                    and no_show_medium_rate_percent = 15 and no_show_high_rate_percent = 30
                    and no_show_high_count = 3 and no_show_medium_late_cancellations = 3
                    and colour_buffer_minutes = 15 and slot_gap_minimum_minutes = 15
                  from analytics.operational_signal_settings
                  where business_id='05000000-0000-0000-0000-000000000001' and location_id is null)
            then 'PASS' else 'FAIL: defaults do not match the domain constants' end as result;

-- ===========================================================================
-- 3-7. IMPOSSIBLE VALUES REFUSED at the database, not only in the DTO.
-- ===========================================================================
do $$ begin
  insert into analytics.operational_signal_settings (business_id,location_id,spend_materiality_percent)
  values ('05000000-0000-0000-0000-000000000001','05000000-0000-0000-0000-0000000000a1',-200);
  insert into probe_results values ('03_NEGATIVE_MATERIALITY_REJECTED','FAIL: -200% accepted');
exception when check_violation then
  insert into probe_results values ('03_NEGATIVE_MATERIALITY_REJECTED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='03_NEGATIVE_MATERIALITY_REJECTED';

do $$ begin
  insert into analytics.operational_signal_settings (business_id,location_id,spend_window_visits)
  values ('05000000-0000-0000-0000-000000000001','05000000-0000-0000-0000-0000000000a1',1);
  insert into probe_results values ('04_WINDOW_MINIMUM_ENFORCED','FAIL: a 1-visit window accepted');
exception when check_violation then
  insert into probe_results values ('04_WINDOW_MINIMUM_ENFORCED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='04_WINDOW_MINIMUM_ENFORCED';

do $$ begin
  insert into analytics.operational_signal_settings (business_id,location_id,no_show_lookback_days)
  values ('05000000-0000-0000-0000-000000000001','05000000-0000-0000-0000-0000000000a1',5);
  insert into probe_results values ('05_LOOKBACK_MINIMUM_ENFORCED','FAIL: a 5-day lookback accepted');
exception when check_violation then
  insert into probe_results values ('05_LOOKBACK_MINIMUM_ENFORCED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='05_LOOKBACK_MINIMUM_ENFORCED';

do $$ begin
  insert into analytics.operational_signal_settings (business_id,location_id,slot_gap_minimum_minutes)
  values ('05000000-0000-0000-0000-000000000001','05000000-0000-0000-0000-0000000000a1',1);
  insert into probe_results values ('06_SLOT_GAP_MINIMUM_ENFORCED','FAIL: a 1-minute gap threshold accepted');
exception when check_violation then
  insert into probe_results values ('06_SLOT_GAP_MINIMUM_ENFORCED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='06_SLOT_GAP_MINIMUM_ENFORCED';

do $$ begin
  insert into analytics.operational_signal_settings (business_id,location_id,colour_buffer_minutes)
  values ('05000000-0000-0000-0000-000000000001','05000000-0000-0000-0000-0000000000a1',999);
  insert into probe_results values ('07_COLOUR_BUFFER_BOUNDED','FAIL: a 999-minute buffer accepted');
exception when check_violation then
  insert into probe_results values ('07_COLOUR_BUFFER_BOUNDED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='07_COLOUR_BUFFER_BOUNDED';

-- ===========================================================================
-- 8. A ZERO COLOUR BUFFER IS LEGAL. A salon may genuinely accept touching
--    colour appointments; the bound must not force a warning nobody wanted.
-- ===========================================================================
do $$ begin
  insert into analytics.operational_signal_settings (business_id,location_id,colour_buffer_minutes)
  values ('05000000-0000-0000-0000-000000000001','05000000-0000-0000-0000-0000000000a2',0);
  insert into probe_results values ('08_ZERO_COLOUR_BUFFER_ALLOWED','PASS');
exception when check_violation then
  insert into probe_results values ('08_ZERO_COLOUR_BUFFER_ALLOWED','FAIL: a deliberate 0-minute buffer was rejected');
end $$;
select case_name as case, result from probe_results where case_name='08_ZERO_COLOUR_BUFFER_ALLOWED';

-- ===========================================================================
-- 9. MEDIUM RATE ABOVE HIGH RATE REFUSED. Otherwise `medium` is unreachable —
--    a silently dead branch rather than a rejected configuration.
-- ===========================================================================
do $$ begin
  update analytics.operational_signal_settings
     set no_show_medium_rate_percent = 60, no_show_high_rate_percent = 30
   where business_id='05000000-0000-0000-0000-000000000001' and location_id is null;
  insert into probe_results values ('09_RATE_ORDER_ENFORCED','FAIL: medium > high accepted');
exception when check_violation then
  insert into probe_results values ('09_RATE_ORDER_ENFORCED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='09_RATE_ORDER_ENFORCED';

-- ===========================================================================
-- 10. EQUAL RATES ARE LEGAL — a single escalation point is a valid policy.
-- ===========================================================================
do $$ begin
  update analytics.operational_signal_settings
     set no_show_medium_rate_percent = 30, no_show_high_rate_percent = 30
   where business_id='05000000-0000-0000-0000-000000000001' and location_id is null;
  insert into probe_results values ('10_EQUAL_RATES_ALLOWED','PASS');
exception when check_violation then
  insert into probe_results values ('10_EQUAL_RATES_ALLOWED','FAIL: equal rates rejected');
end $$;
select case_name as case, result from probe_results where case_name='10_EQUAL_RATES_ALLOWED';

-- ===========================================================================
-- 11. THE BUSINESS-WIDE ROW COLLIDES WITH ITSELF (NULLS NOT DISTINCT), which
--     is what makes the upsert keep one row rather than accumulating duplicates.
-- ===========================================================================
do $$ begin
  insert into analytics.operational_signal_settings (business_id,location_id)
  values ('05000000-0000-0000-0000-000000000001', null);
  insert into probe_results values ('11_BUSINESS_ROW_UNIQUE','FAIL: a second business-wide row accepted');
exception when unique_violation then
  insert into probe_results values ('11_BUSINESS_ROW_UNIQUE','PASS');
end $$;
select case_name as case, result from probe_results where case_name='11_BUSINESS_ROW_UNIQUE';

-- ===========================================================================
-- 12. A LOCATION OVERRIDE COEXISTS with the business default.
-- ===========================================================================
select '12_LOCATION_OVERRIDE_COEXISTS' as case,
       case when (select count(*) from analytics.operational_signal_settings
                   where business_id='05000000-0000-0000-0000-000000000001') = 2
            then 'PASS' else 'FAIL: business-wide + location rows did not coexist' end as result;

-- ===========================================================================
-- 13. A SECOND ROW FOR THE SAME LOCATION IS REFUSED.
-- ===========================================================================
do $$ begin
  insert into analytics.operational_signal_settings (business_id,location_id)
  values ('05000000-0000-0000-0000-000000000001','05000000-0000-0000-0000-0000000000a2');
  insert into probe_results values ('13_LOCATION_ROW_UNIQUE','FAIL: duplicate location row accepted');
exception when unique_violation then
  insert into probe_results values ('13_LOCATION_ROW_UNIQUE','PASS');
end $$;
select case_name as case, result from probe_results where case_name='13_LOCATION_ROW_UNIQUE';

-- ===========================================================================
-- 14. DELETING A LOCATION REMOVES ITS OVERRIDE, never orphans it.
-- ===========================================================================
do $$ declare remaining integer; begin
  delete from core.locations where id='05000000-0000-0000-0000-0000000000a2';
  select count(*) into remaining from analytics.operational_signal_settings
   where location_id='05000000-0000-0000-0000-0000000000a2';
  insert into probe_results values ('14_LOCATION_CASCADE',
    case when remaining = 0 then 'PASS' else 'FAIL: orphaned override survived' end);
end $$;
select case_name as case, result from probe_results where case_name='14_LOCATION_CASCADE';

-- ===========================================================================
-- 15. THE updated_at TRIGGER FIRES.
--
--     Deliberately NOT written as "read, sleep, update, re-read":
--     public.set_updated_at() assigns now(), which is TRANSACTION START TIME and
--     constant for this whole suite. That version passes on a table with no
--     trigger and fails on one that has it — exactly backwards. Back-dating the
--     row first makes the assertion real: only a firing trigger can drag
--     updated_at back to now().
-- ===========================================================================
do $$ declare after_ts timestamptz; begin
  update analytics.operational_signal_settings set updated_at = timestamptz '2000-01-01 00:00:00Z'
   where business_id='05000000-0000-0000-0000-000000000001' and location_id is null;
  update analytics.operational_signal_settings set slot_gap_minimum_minutes = 20
   where business_id='05000000-0000-0000-0000-000000000001' and location_id is null;
  select updated_at into after_ts from analytics.operational_signal_settings
   where business_id='05000000-0000-0000-0000-000000000001' and location_id is null;
  insert into probe_results values ('15_UPDATED_AT_TRIGGER',
    case when after_ts = now() then 'PASS' else 'FAIL: updated_at left at ' || after_ts::text end);
end $$;
select case_name as case, result from probe_results where case_name='15_UPDATED_AT_TRIGGER';

-- ===========================================================================
-- 16-18. THE READ-PATH INDEXES EXIST with the predicates the signals rely on.
--        A partial index whose predicate does not match the query is never used,
--        so asserting the NAME alone would prove nothing.
-- ===========================================================================
select '16_SPEND_INDEX' as case,
       case when (select indexdef from pg_indexes
                   where schemaname='billing' and indexname='idx_billing_bills_client_settled')
                 like '%status = ''paid''%'
            then 'PASS' else 'FAIL: settled-bill index missing or wrong predicate' end as result;

select '17_ATTENDANCE_INDEX' as case,
       case when (select indexdef from pg_indexes
                   where schemaname='booking' and indexname='idx_booking_appointments_client_attendance')
                 like '%no_show%'
            then 'PASS' else 'FAIL: attendance index missing or wrong predicate' end as result;

select '18_SHIFT_INDEX' as case,
       case when (select indexdef from pg_indexes
                   where schemaname='rota' and indexname='idx_rota_shifts_location_window')
                 like '%published%'
            then 'PASS' else 'FAIL: shift index missing or wrong predicate' end as result;

-- ===========================================================================
-- 19. RLS — A MANAGER MAY READ but NOT WRITE the thresholds. A manager needs to
--     see them to understand a flag; changing what staff get warned about is an
--     owner decision.
-- ===========================================================================
do $$ declare visible integer; begin
  perform set_config('request.jwt.claim.sub','05000000-0000-0000-0000-0000000000f2',true);
  set local role authenticated;
  select count(*) into visible from analytics.operational_signal_settings
   where business_id='05000000-0000-0000-0000-000000000001';
  -- An RLS-filtered UPDATE matches no rows rather than raising, so the verdict
  -- is whether the value actually moved.
  update analytics.operational_signal_settings set slot_gap_minimum_minutes = 99
   where business_id='05000000-0000-0000-0000-000000000001' and location_id is null;
  reset role;
  insert into probe_results values ('19_MANAGER_READ_NOT_WRITE',
    case when visible = 0 then 'FAIL: a manager could not read the thresholds'
         when (select slot_gap_minimum_minutes from analytics.operational_signal_settings
                where business_id='05000000-0000-0000-0000-000000000001' and location_id is null) <> 20
           then 'FAIL: a manager changed the thresholds'
         else 'PASS' end);
exception when insufficient_privilege then
  reset role;
  insert into probe_results values ('19_MANAGER_READ_NOT_WRITE','PASS');
when others then
  reset role;
  insert into probe_results values ('19_MANAGER_READ_NOT_WRITE','FAIL: unexpected ' || sqlstate || ' ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='19_MANAGER_READ_NOT_WRITE';

-- ===========================================================================
-- 20. RLS — ANOTHER BUSINESS'S OWNER SEES NOTHING. Ray is a legitimate
--     `authenticated` user with an owner membership — of the WRONG business.
-- ===========================================================================
do $$ declare leaked integer; begin
  perform set_config('request.jwt.claim.sub','05000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  select count(*) into leaked from analytics.operational_signal_settings
   where business_id='05000000-0000-0000-0000-000000000001';
  reset role;
  insert into probe_results values ('20_CROSS_BUSINESS_HIDDEN',
    case when leaked = 0 then 'PASS' else 'FAIL: another business''s thresholds were readable' end);
exception when others then
  reset role;
  insert into probe_results values ('20_CROSS_BUSINESS_HIDDEN','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='20_CROSS_BUSINESS_HIDDEN';

-- ---------------------------------------------------------------------------
-- Summary. Any row that is not PASS is a failure, and a count of zero means the
-- suite aborted rather than succeeded.
-- ---------------------------------------------------------------------------
select 'SUMMARY' as case,
       count(*) filter (where result = 'PASS')::text || ' of ' || count(*)::text
         || ' recorded probe cases passed' as result
from probe_results;

rollback;
