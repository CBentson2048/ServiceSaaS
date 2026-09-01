-- formula_change_detection.sql — behavioural suite for migration 0105.
--
-- WHY THIS FILE EXISTS. The Jest suites stub the Supabase client, so they prove
-- only that the SERVICE asks for the right things. They cannot prove that the
-- database refuses a -200% threshold, that the business-wide settings row
-- collides with itself while still permitting a per-location override, that a
-- manager querying lab.formula_change_settings directly through PostgREST with
-- their own token can read but not write it, or that another business's owner
-- sees nothing at all. This file is that proof, and it runs the constraints and
-- the policies for real.
--
-- 22 numbered cases. Read the RESULT column of each; every one must read PASS.
--
-- Run against a SCRATCH database that has every migration through 0105 applied:
--   psql -d <scratch> -f supabase/tests/formula_change_detection.sql
--
-- The whole suite runs inside one transaction that is rolled back at the end, so
-- it leaves no fixture rows behind and is re-runnable. Every expected failure
-- runs inside a plpgsql block whose exception handler records the verdict, so
-- the rejected write is undone while the evidence that it WAS rejected survives.
-- A savepoint/rollback probe would prove nothing: the rollback removes the row
-- whether the constraint rejected it or accepted it happily.
--
-- HOW THE RLS CASES WORK. `set local role authenticated` plus
-- `set_config('request.jwt.claim.sub', <user id>, true)` is exactly what
-- PostgREST does per request, and public.current_user_id() reads auth.uid()
-- which reads that claim. Role is always reset before recording a verdict,
-- because the temp results table is not readable by `authenticated`.

\set ON_ERROR_STOP off
\pset pager off

begin;

-- ---------------------------------------------------------------------------
-- Fixtures. 'fc' prefix, hex-only UUIDs, distinct from every other suite.
-- ---------------------------------------------------------------------------
insert into core.businesses (id,name,slug,timezone) values
 ('fc000000-0000-0000-0000-000000000001','Formula Salon','formula-salon','Europe/London'),
 ('fc000000-0000-0000-0000-000000000002','Rival Formula','rival-formula','Europe/London');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('fc000000-0000-0000-0000-0000000000a1','fc000000-0000-0000-0000-000000000001','F1','Primrose Hill','fc-primrose','1 Regents Park Rd','London','NW1 8UG','Europe/London'),
 ('fc000000-0000-0000-0000-0000000000a2','fc000000-0000-0000-0000-000000000001','F2','Pinner','fc-pinner','2 High St','Pinner','HA5 1AA','Europe/London'),
 ('fc000000-0000-0000-0000-0000000000a3','fc000000-0000-0000-0000-000000000002','F3','Rival','fc-rival','3 High St','Watford','WD1 1AA','Europe/London');

insert into auth.users (id,email) values
 ('fc000000-0000-0000-0000-0000000000f1'::uuid,'owner@fc.example'),
 ('fc000000-0000-0000-0000-0000000000f2'::uuid,'manager@fc.example'),
 ('fc000000-0000-0000-0000-0000000000f3'::uuid,'rival@fc.example');

insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name,is_active) values
 ('fc000000-0000-0000-0000-0000000000f1','owner@fc.example','Olive Owner','Olive','Owner','Olive',true),
 ('fc000000-0000-0000-0000-0000000000f2','manager@fc.example','Mo Manager','Mo','Manager','Mo',true),
 ('fc000000-0000-0000-0000-0000000000f3','rival@fc.example','Ray Rival','Ray','Rival','Ray',true);

insert into core.user_memberships (business_id,location_id,user_profile_id,role,status,activated_at) values
 ('fc000000-0000-0000-0000-000000000001',null,'fc000000-0000-0000-0000-0000000000f1','owner','active',now()),
 ('fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000a1','fc000000-0000-0000-0000-0000000000f2','manager','active',now()),
 ('fc000000-0000-0000-0000-000000000002',null,'fc000000-0000-0000-0000-0000000000f3','owner','active',now());

create temporary table probe_results (case_name text primary key, result text) on commit drop;

-- ===========================================================================
-- 1. THE TABLE EXISTS with the documented shape.
-- ===========================================================================
select '01_TABLE_EXISTS' as case,
       case when to_regclass('lab.formula_change_settings') is not null
            then 'PASS' else 'FAIL: lab.formula_change_settings is missing' end as result;

-- ===========================================================================
-- 2. PLATFORM DEFAULTS. An owner who configures nothing but the scope gets
--    30 / 15 / 10 — the same numbers DEFAULT_FORMULA_CHANGE_THRESHOLDS carries.
-- ===========================================================================
insert into lab.formula_change_settings (business_id) values ('fc000000-0000-0000-0000-000000000001');

select '02_DEFAULTS_MATCH_DOMAIN' as case,
       case when (select composition_change_percent from lab.formula_change_settings
                   where business_id='fc000000-0000-0000-0000-000000000001' and location_id is null) = 30
             and (select component_materiality_percent from lab.formula_change_settings
                   where business_id='fc000000-0000-0000-0000-000000000001' and location_id is null) = 15
             and (select developer_volume_delta from lab.formula_change_settings
                   where business_id='fc000000-0000-0000-0000-000000000001' and location_id is null) = 10
            then 'PASS' else 'FAIL: defaults do not match the domain constants' end as result;

-- ===========================================================================
-- 3-8. IMPOSSIBLE THRESHOLDS ARE REFUSED at the database, not only in the DTO.
-- ===========================================================================
do $$
begin
  insert into lab.formula_change_settings (business_id, location_id, composition_change_percent)
  values ('fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000a1',-200);
  insert into probe_results values ('03_NEGATIVE_COMPOSITION_REJECTED','FAIL: -200% was accepted');
exception when check_violation then
  insert into probe_results values ('03_NEGATIVE_COMPOSITION_REJECTED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='03_NEGATIVE_COMPOSITION_REJECTED';

do $$
begin
  insert into lab.formula_change_settings (business_id, location_id, composition_change_percent)
  values ('fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000a1',5000);
  insert into probe_results values ('04_OVER_100_COMPOSITION_REJECTED','FAIL: 5000% was accepted');
exception when check_violation then
  insert into probe_results values ('04_OVER_100_COMPOSITION_REJECTED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='04_OVER_100_COMPOSITION_REJECTED';

do $$
begin
  insert into lab.formula_change_settings (business_id, location_id, composition_change_percent)
  values ('fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000a1',0);
  insert into probe_results values ('05_ZERO_COMPOSITION_REJECTED','FAIL: a 0% threshold was accepted');
exception when check_violation then
  insert into probe_results values ('05_ZERO_COMPOSITION_REJECTED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='05_ZERO_COMPOSITION_REJECTED';

do $$
begin
  insert into lab.formula_change_settings (business_id, location_id, component_materiality_percent)
  values ('fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000a1',101);
  insert into probe_results values ('06_MATERIALITY_BOUNDED','FAIL: 101% materiality was accepted');
exception when check_violation then
  insert into probe_results values ('06_MATERIALITY_BOUNDED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='06_MATERIALITY_BOUNDED';

do $$
begin
  insert into lab.formula_change_settings (business_id, location_id, developer_volume_delta)
  values ('fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000a1',0);
  insert into probe_results values ('07_DEVELOPER_DELTA_BOUNDED','FAIL: a 0 vol delta was accepted');
exception when check_violation then
  insert into probe_results values ('07_DEVELOPER_DELTA_BOUNDED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='07_DEVELOPER_DELTA_BOUNDED';

do $$
begin
  insert into lab.formula_change_settings (business_id, location_id, developer_volume_delta)
  values ('fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000a1',61);
  insert into probe_results values ('08_DEVELOPER_DELTA_UPPER_BOUND','FAIL: 61 vol was accepted');
exception when check_violation then
  insert into probe_results values ('08_DEVELOPER_DELTA_UPPER_BOUND','PASS');
end $$;
select case_name as case, result from probe_results where case_name='08_DEVELOPER_DELTA_UPPER_BOUND';

-- ===========================================================================
-- 9. EVERY DOCUMENTED BOUND IS ACCEPTED at both ends.
-- ===========================================================================
do $$
begin
  insert into lab.formula_change_settings
    (business_id, location_id, composition_change_percent, component_materiality_percent, developer_volume_delta)
  values ('fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000a2',1,1,1);
  update lab.formula_change_settings
     set composition_change_percent=100, component_materiality_percent=100, developer_volume_delta=60
   where location_id='fc000000-0000-0000-0000-0000000000a2';
  insert into probe_results values ('09_BOUNDS_ACCEPTED','PASS');
exception when check_violation then
  insert into probe_results values ('09_BOUNDS_ACCEPTED','FAIL: a documented bound was rejected');
end $$;
select case_name as case, result from probe_results where case_name='09_BOUNDS_ACCEPTED';

-- ===========================================================================
-- 10. THE BUSINESS-WIDE ROW COLLIDES WITH ITSELF. NULLS NOT DISTINCT is what
--     makes the upsert keep one row rather than accumulating duplicates.
-- ===========================================================================
do $$
begin
  insert into lab.formula_change_settings (business_id, location_id)
  values ('fc000000-0000-0000-0000-000000000001', null);
  insert into probe_results values ('10_BUSINESS_ROW_UNIQUE','FAIL: a second business-wide row was accepted');
exception when unique_violation then
  insert into probe_results values ('10_BUSINESS_ROW_UNIQUE','PASS');
end $$;
select case_name as case, result from probe_results where case_name='10_BUSINESS_ROW_UNIQUE';

-- ===========================================================================
-- 11. A LOCATION OVERRIDE COEXISTS with the business default.
-- ===========================================================================
select '11_LOCATION_OVERRIDE_COEXISTS' as case,
       case when (select count(*) from lab.formula_change_settings
                   where business_id='fc000000-0000-0000-0000-000000000001') = 2
            then 'PASS' else 'FAIL: business-wide + location rows did not coexist' end as result;

-- ===========================================================================
-- 12. A SECOND ROW FOR THE SAME LOCATION IS REFUSED.
-- ===========================================================================
do $$
begin
  insert into lab.formula_change_settings (business_id, location_id)
  values ('fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000a2');
  insert into probe_results values ('12_LOCATION_ROW_UNIQUE','FAIL: a duplicate location row was accepted');
exception when unique_violation then
  insert into probe_results values ('12_LOCATION_ROW_UNIQUE','PASS');
end $$;
select case_name as case, result from probe_results where case_name='12_LOCATION_ROW_UNIQUE';

-- ===========================================================================
-- 13. TWO BUSINESSES MAY EACH HAVE A BUSINESS-WIDE ROW.
-- ===========================================================================
do $$
begin
  insert into lab.formula_change_settings (business_id) values ('fc000000-0000-0000-0000-000000000002');
  insert into probe_results values ('13_PER_BUSINESS_ROWS','PASS');
exception when unique_violation then
  insert into probe_results values ('13_PER_BUSINESS_ROWS','FAIL: a second business was blocked');
end $$;
select case_name as case, result from probe_results where case_name='13_PER_BUSINESS_ROWS';

-- ===========================================================================
-- 14. THE updated_at TRIGGER FIRES.
--
--     Deliberately NOT written as "read updated_at, sleep, update, read again":
--     public.set_updated_at() assigns now(), which is TRANSACTION START TIME and
--     is constant for the whole of this suite. That version passes on a table
--     with no trigger at all and fails on one that has it, which is exactly
--     backwards. Back-dating the row first makes the assertion real: only a
--     firing trigger can drag updated_at back to now().
-- ===========================================================================
do $$
declare after_ts timestamptz;
begin
  update lab.formula_change_settings set updated_at = timestamptz '2000-01-01 00:00:00Z'
   where business_id='fc000000-0000-0000-0000-000000000001' and location_id is null;

  update lab.formula_change_settings set composition_change_percent = 35
   where business_id='fc000000-0000-0000-0000-000000000001' and location_id is null;

  select updated_at into after_ts from lab.formula_change_settings
   where business_id='fc000000-0000-0000-0000-000000000001' and location_id is null;

  insert into probe_results values ('14_UPDATED_AT_TRIGGER',
    case when after_ts = now() then 'PASS'
         else 'FAIL: updated_at was left at ' || after_ts::text end);
end $$;
select case_name as case, result from probe_results where case_name='14_UPDATED_AT_TRIGGER';

-- ===========================================================================
-- 15. DELETING A LOCATION REMOVES ITS OVERRIDE, never orphans it.
-- ===========================================================================
do $$
declare remaining integer;
begin
  delete from core.locations where id='fc000000-0000-0000-0000-0000000000a2';
  select count(*) into remaining from lab.formula_change_settings
   where location_id='fc000000-0000-0000-0000-0000000000a2';
  insert into probe_results values ('15_LOCATION_CASCADE',
    case when remaining = 0 then 'PASS' else 'FAIL: an orphaned override survived' end);
end $$;
select case_name as case, result from probe_results where case_name='15_LOCATION_CASCADE';

-- ===========================================================================
-- 16-17. THE COMPARABLE-HISTORY INDEXES EXIST and match the detector's query.
--        Without them, "this client's finalised formulas, newest first" is a
--        sequential scan on every client profile and every Colour Prep load.
-- ===========================================================================
select '16_CLIENT_HISTORY_INDEX' as case,
       case when exists (select 1 from pg_indexes
                          where schemaname='lab' and indexname='idx_lab_formulas_client_saved')
            then 'PASS' else 'FAIL: idx_lab_formulas_client_saved is missing' end as result;

select '17_APPOINTMENT_INDEX' as case,
       case when exists (select 1 from pg_indexes
                          where schemaname='lab' and indexname='idx_lab_formulas_appointment')
            then 'PASS' else 'FAIL: idx_lab_formulas_appointment is missing' end as result;

-- ===========================================================================
-- 18. THE HISTORY INDEX IS PARTIAL ON THE DETECTOR'S OWN PREDICATE. A partial
--     index whose predicate did not match the query would never be used.
-- ===========================================================================
select '18_HISTORY_INDEX_PREDICATE' as case,
       case when (select indexdef from pg_indexes
                   where schemaname='lab' and indexname='idx_lab_formulas_client_saved')
                 like '%status = ''saved''%'
            then 'PASS' else 'FAIL: the index predicate does not match the finalised-only query' end as result;

-- ===========================================================================
-- 19. RLS IS ENABLED. Without it the policies below are decoration.
-- ===========================================================================
select '19_RLS_ENABLED' as case,
       case when (select relrowsecurity from pg_class
                   where oid = 'lab.formula_change_settings'::regclass)
            then 'PASS' else 'FAIL: row level security is not enabled' end as result;

-- ===========================================================================
-- 20. A MANAGER MAY READ the thresholds — they explain a flag the manager sees.
-- ===========================================================================
do $$
declare visible integer;
begin
  perform set_config('request.jwt.claim.sub','fc000000-0000-0000-0000-0000000000f2',true);
  set local role authenticated;
  select count(*) into visible from lab.formula_change_settings
   where business_id='fc000000-0000-0000-0000-000000000001';
  reset role;
  insert into probe_results values ('20_MANAGER_CAN_READ',
    case when visible >= 1 then 'PASS' else 'FAIL: a manager could not read the thresholds' end);
exception when others then
  reset role;
  insert into probe_results values ('20_MANAGER_CAN_READ','FAIL: unexpected ' || sqlstate || ' ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='20_MANAGER_CAN_READ';

-- ===========================================================================
-- 21. A MANAGER MAY NOT WRITE them. Changing sensitivity changes who gets
--     warned, so it is an owner decision.
-- ===========================================================================
do $$
begin
  perform set_config('request.jwt.claim.sub','fc000000-0000-0000-0000-0000000000f2',true);
  set local role authenticated;
  update lab.formula_change_settings set composition_change_percent = 5
   where business_id='fc000000-0000-0000-0000-000000000001' and location_id is null;
  -- An RLS-filtered UPDATE matches no rows rather than raising, so the verdict
  -- is whether the value actually moved.
  reset role;
  insert into probe_results values ('21_MANAGER_CANNOT_WRITE',
    case when (select composition_change_percent from lab.formula_change_settings
                where business_id='fc000000-0000-0000-0000-000000000001' and location_id is null) = 35
         then 'PASS' else 'FAIL: a manager changed the sensitivity' end);
exception when insufficient_privilege then
  reset role;
  insert into probe_results values ('21_MANAGER_CANNOT_WRITE','PASS');
when others then
  reset role;
  insert into probe_results values ('21_MANAGER_CANNOT_WRITE','FAIL: unexpected ' || sqlstate || ' ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='21_MANAGER_CANNOT_WRITE';

-- ===========================================================================
-- 22. ANOTHER BUSINESS'S OWNER SEES NOTHING. Ray is a legitimate
--     `authenticated` user with an owner membership — of the WRONG business.
-- ===========================================================================
do $$
declare leaked integer;
begin
  perform set_config('request.jwt.claim.sub','fc000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  select count(*) into leaked from lab.formula_change_settings
   where business_id='fc000000-0000-0000-0000-000000000001';
  reset role;
  insert into probe_results values ('22_CROSS_BUSINESS_HIDDEN',
    case when leaked = 0 then 'PASS' else 'FAIL: another business''s thresholds were readable' end);
exception when others then
  reset role;
  insert into probe_results values ('22_CROSS_BUSINESS_HIDDEN','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='22_CROSS_BUSINESS_HIDDEN';

-- ---------------------------------------------------------------------------
-- Summary. Any row that is not PASS is a failure, and a count of zero means the
-- suite aborted rather than succeeded.
-- ---------------------------------------------------------------------------
select 'SUMMARY' as case,
       count(*) filter (where result = 'PASS')::text || ' of ' || count(*)::text
         || ' recorded probe cases passed' as result
from probe_results;

rollback;
