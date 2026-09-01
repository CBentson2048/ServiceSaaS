-- upsell_suggestions.sql — behavioural suite for migration 0103.
--
-- WHY THIS FILE EXISTS. The Jest suites stub the Supabase client, so they can only
-- prove that the SERVICE asks for the right things. They cannot prove that the
-- database refuses a self-suggesting rule, that the duplicate-rule indexes let a
-- business default and a location override coexist while rejecting a true
-- duplicate, that booking.service_cooccurrence counts only genuinely completed
-- appointments, or that a stylist querying booking.upsell_rules directly through
-- PostgREST with their own token cannot edit them. This file is that proof, and it
-- runs the constraints, the function and the policies for real.
--
-- 34 numbered cases. Read the RESULT column of each; every one must read PASS.
--
-- Run against a SCRATCH database that has every migration through 0103 applied:
--   psql -d <scratch> -f supabase/tests/upsell_suggestions.sql
--
-- The whole suite runs inside one transaction that is rolled back at the end, so it
-- leaves no fixture rows behind and is re-runnable. Every expected failure runs
-- inside a plpgsql block whose exception handler records the verdict, so the
-- rejected write is undone while the evidence that it WAS rejected survives.
--
-- HOW THE RLS CASES WORK. `set local role authenticated` plus
-- `set_config('request.jwt.claim.sub', <user id>, true)` is exactly what PostgREST
-- does per request, and public.current_user_id() reads auth.uid() which reads that
-- claim. So these cases exercise the real policies as the real role — not a
-- simulation of them. Role is always reset before recording a verdict, because the
-- temp results table is not readable by `authenticated`.

\set ON_ERROR_STOP off
\pset pager off

begin;

-- ---------------------------------------------------------------------------
-- Fixtures. 'fb' prefix, hex-only UUIDs, distinct from the other suites.
--
-- Two businesses so cross-tenant leakage has something to leak to; two locations
-- inside the first so location scoping has something to exclude.
-- ---------------------------------------------------------------------------
insert into core.businesses (id,name,slug) values
 ('fb000000-0000-0000-0000-000000000001','Upsell Salon','upsell-salon'),
 ('fb000000-0000-0000-0000-000000000002','Rival Upsell','rival-upsell');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('fb000000-0000-0000-0000-0000000000a1','fb000000-0000-0000-0000-000000000001','U1','Pinner','fb-pinner','1 High St','Pinner','HA5 1AA','Europe/London'),
 ('fb000000-0000-0000-0000-0000000000a2','fb000000-0000-0000-0000-000000000001','U2','Primrose Hill','fb-primrose','2 High St','London','NW1 8JR','Europe/London'),
 ('fb000000-0000-0000-0000-0000000000a3','fb000000-0000-0000-0000-000000000002','U3','Rival','fb-rival','3 High St','Watford','WD1 1AA','Europe/London');

-- core.user_profiles.id references auth.users(id), so the auth rows come first.
insert into auth.users (id,email) values
 ('fb000000-0000-0000-0000-0000000000f1'::uuid,'owner@fb.example'),
 ('fb000000-0000-0000-0000-0000000000f2'::uuid,'stylist@fb.example'),
 ('fb000000-0000-0000-0000-0000000000f3'::uuid,'rival@fb.example');

insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name,is_active) values
 ('fb000000-0000-0000-0000-0000000000f1','owner@fb.example','Olive Owner','Olive','Owner','Olive',true),
 ('fb000000-0000-0000-0000-0000000000f2','stylist@fb.example','Sam Stylist','Sam','Stylist','Sam',true),
 ('fb000000-0000-0000-0000-0000000000f3','rival@fb.example','Ray Rival','Ray','Rival','Ray',true);

insert into core.user_memberships (business_id,location_id,user_profile_id,role,status,activated_at) values
 ('fb000000-0000-0000-0000-000000000001',null,'fb000000-0000-0000-0000-0000000000f1','owner','active',now()),
 ('fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1','fb000000-0000-0000-0000-0000000000f2','stylist','active',now()),
 ('fb000000-0000-0000-0000-000000000002',null,'fb000000-0000-0000-0000-0000000000f3','owner','active',now());

insert into booking.service_categories (id,business_id,name) values
 ('fb000000-0000-0000-0000-0000000000c1','fb000000-0000-0000-0000-000000000001','Colour'),
 ('fb000000-0000-0000-0000-0000000000c2','fb000000-0000-0000-0000-000000000001','Cutting');

-- Services. COLOUR is the trigger throughout; TONER the configured add-on;
-- TREATMENT the pattern-only add-on; RARE has too little history to qualify.
insert into booking.services
 (id,business_id,location_id,slug,name,service_category_id,estimated_duration_minutes,base_price) values
 ('fb000000-0000-0000-0000-0000000000b1','fb000000-0000-0000-0000-000000000001',null,'fb-colour','Full Head Colour','fb000000-0000-0000-0000-0000000000c1',120,95),
 ('fb000000-0000-0000-0000-0000000000b2','fb000000-0000-0000-0000-000000000001',null,'fb-toner','Toner','fb000000-0000-0000-0000-0000000000c1',30,35),
 ('fb000000-0000-0000-0000-0000000000b3','fb000000-0000-0000-0000-000000000001',null,'fb-treatment','Olaplex Treatment','fb000000-0000-0000-0000-0000000000c1',20,25),
 ('fb000000-0000-0000-0000-0000000000b4','fb000000-0000-0000-0000-000000000001',null,'fb-rare','Scalp Ritual','fb000000-0000-0000-0000-0000000000c1',45,40),
 ('fb000000-0000-0000-0000-0000000000b5','fb000000-0000-0000-0000-000000000002',null,'fb-rival-colour','Rival Colour',null,120,95),
 ('fb000000-0000-0000-0000-0000000000b6','fb000000-0000-0000-0000-000000000002',null,'fb-rival-toner','Rival Toner',null,30,35);

insert into core.client_profiles (id,business_id,primary_location_id,first_name,last_name) values
 ('fb000000-0000-0000-0000-0000000000d1','fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1','Jane','Client'),
 ('fb000000-0000-0000-0000-0000000000d2','fb000000-0000-0000-0000-000000000002','fb000000-0000-0000-0000-0000000000a3','Rhona','Rival');

create temporary table probe_results (case_name text primary key, result text) on commit drop;

-- ---------------------------------------------------------------------------
-- History fixtures for the co-occurrence function.
--
-- The shape is deliberate and hand-countable, so the thresholds have something
-- exact to bite on:
--
--   20 PAID appointments contain Colour.
--       12 of them also contain Toner       -> 12/20 = 0.60   qualifies
--        5 of them also contain Treatment   ->  5/20 = 0.25   qualifies
--        2 of them also contain Scalp Ritual->  2/20 = 0.10   REJECTED (count + rate)
--    4 CANCELLED / NO_SHOW / PENDING appointments contain Colour + Toner
--                                            -> must not count at all
-- ---------------------------------------------------------------------------
do $$
declare
  i integer;
  appt uuid;
  status_value booking.appointment_status_enum;
begin
  -- 20 completed (paid) appointments containing Colour.
  for i in 1..20 loop
    appt := ('fb000000-0000-0000-0000-00000000' || lpad(to_hex(4096 + i), 4, '0'))::uuid;
    insert into booking.appointments
      (id,business_id,location_id,client_profile_id,status,scheduled_start_at,scheduled_end_at,completed_at,occupied_ranges)
    values
      (appt,'fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1',
       'fb000000-0000-0000-0000-0000000000d1','paid',
       now() - (i || ' days')::interval, now() - (i || ' days')::interval + interval '2 hours',
       now() - (i || ' days')::interval + interval '2 hours',
       tstzmultirange(tstzrange(now() - (i || ' days')::interval,
                                now() - (i || ' days')::interval + interval '2 hours', '[)')));

    insert into booking.appointment_services
      (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes)
    values
      ('fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1',appt,
       'fb000000-0000-0000-0000-0000000000b1',1,'Full Head Colour',120);

    if i <= 12 then
      insert into booking.appointment_services
        (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes)
      values
        ('fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1',appt,
         'fb000000-0000-0000-0000-0000000000b2',2,'Toner',30);
    end if;

    if i <= 5 then
      insert into booking.appointment_services
        (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes)
      values
        ('fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1',appt,
         'fb000000-0000-0000-0000-0000000000b3',3,'Olaplex Treatment',20);
    end if;

    if i <= 2 then
      insert into booking.appointment_services
        (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes)
      values
        ('fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1',appt,
         'fb000000-0000-0000-0000-0000000000b4',4,'Scalp Ritual',45);
    end if;
  end loop;

  -- 4 appointments that must NEVER count: cancelled, no_show, pending, accepted.
  -- Each contains Colour + Toner, so if any of them leaked in, the Toner counts
  -- above would move and case 20 would fail.
  for i in 1..4 loop
    appt := ('fb000000-0000-0000-0000-00000000' || lpad(to_hex(8192 + i), 4, '0'))::uuid;
    status_value := (array['cancelled','no_show','pending','accepted'])[i]::booking.appointment_status_enum;
    insert into booking.appointments
      (id,business_id,location_id,client_profile_id,status,scheduled_start_at,scheduled_end_at,completed_at,cancelled_at,occupied_ranges)
    values
      (appt,'fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1',
       'fb000000-0000-0000-0000-0000000000d1',status_value,
       now() - interval '3 days', now() - interval '3 days' + interval '2 hours',
       -- A cancelled appointment carrying a completed_at is the nastiest case:
       -- only the STATUS predicate keeps it out.
       case when i = 1 then now() - interval '3 days' else null end,
       case when i = 1 then now() - interval '3 days' else null end,
       tstzmultirange(tstzrange(now() - interval '3 days',
                                now() - interval '3 days' + interval '2 hours', '[)')));

    insert into booking.appointment_services
      (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes)
    values
      ('fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1',appt,
       'fb000000-0000-0000-0000-0000000000b1',1,'Full Head Colour',120),
      ('fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1',appt,
       'fb000000-0000-0000-0000-0000000000b2',2,'Toner',30);
  end loop;

  -- The rival business books Colour + Toner 30 times. None of it may ever reach
  -- business 1's counts.
  for i in 1..30 loop
    appt := ('fb000000-0000-0000-0000-00000000' || lpad(to_hex(12288 + i), 4, '0'))::uuid;
    insert into booking.appointments
      (id,business_id,location_id,client_profile_id,status,scheduled_start_at,scheduled_end_at,completed_at,occupied_ranges)
    values
      (appt,'fb000000-0000-0000-0000-000000000002','fb000000-0000-0000-0000-0000000000a3',
       'fb000000-0000-0000-0000-0000000000d2','paid',
       now() - (i || ' days')::interval, now() - (i || ' days')::interval + interval '2 hours',
       now() - (i || ' days')::interval + interval '2 hours',
       tstzmultirange(tstzrange(now() - (i || ' days')::interval,
                                now() - (i || ' days')::interval + interval '2 hours', '[)')));

    insert into booking.appointment_services
      (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes)
    values
      ('fb000000-0000-0000-0000-000000000002','fb000000-0000-0000-0000-0000000000a3',appt,
       'fb000000-0000-0000-0000-0000000000b5',1,'Rival Colour',120),
      ('fb000000-0000-0000-0000-000000000002','fb000000-0000-0000-0000-0000000000a3',appt,
       'fb000000-0000-0000-0000-0000000000b6',2,'Rival Toner',30);
  end loop;
end $$;

-- ===========================================================================
-- PART A — RULE TABLE CONSTRAINTS
-- ===========================================================================

-- ===========================================================================
-- 1. A VALID BUSINESS-WIDE RULE IS ACCEPTED. The baseline every other case
--    varies from: Colour -> Toner, enabled, no location.
-- ===========================================================================
insert into booking.upsell_rules
 (id,business_id,location_id,name,enabled,trigger_type,trigger_service_id,suggested_service_id,priority)
values
 ('fb000000-0000-0000-0000-0000000000e1','fb000000-0000-0000-0000-000000000001',null,
  'Colour to Toner',true,'service','fb000000-0000-0000-0000-0000000000b1',
  'fb000000-0000-0000-0000-0000000000b2',100);

select '01_BUSINESS_RULE_STORED' as case,
       case when (select count(*) from booking.upsell_rules
                  where id='fb000000-0000-0000-0000-0000000000e1') = 1
       then 'PASS' else 'FAIL: a valid business-wide rule was rejected' end as result;

-- ===========================================================================
-- 2. A SERVICE CANNOT SUGGEST ITSELF. Enforced by the table, so no code path —
--    a script, a backfill, a future caller — can create one.
-- ===========================================================================
do $$
begin
  insert into booking.upsell_rules
   (business_id,name,trigger_type,trigger_service_id,suggested_service_id)
  values ('fb000000-0000-0000-0000-000000000001','Self','service',
          'fb000000-0000-0000-0000-0000000000b1','fb000000-0000-0000-0000-0000000000b1');
  insert into probe_results values ('02_SELF_SUGGESTION_REJECTED','FAIL: a service was allowed to suggest itself');
exception when check_violation then
  insert into probe_results values ('02_SELF_SUGGESTION_REJECTED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='02_SELF_SUGGESTION_REJECTED';

-- ===========================================================================
-- 3. A SERVICE TRIGGER MUST CARRY A TRIGGER SERVICE.
-- ===========================================================================
do $$
begin
  insert into booking.upsell_rules
   (business_id,name,trigger_type,trigger_service_id,suggested_service_id)
  values ('fb000000-0000-0000-0000-000000000001','No trigger','service',null,
          'fb000000-0000-0000-0000-0000000000b2');
  insert into probe_results values ('03_SERVICE_TRIGGER_REQUIRES_SERVICE','FAIL: a service trigger with no service was stored');
exception when check_violation then
  insert into probe_results values ('03_SERVICE_TRIGGER_REQUIRES_SERVICE','PASS');
end $$;
select case_name as case, result from probe_results where case_name='03_SERVICE_TRIGGER_REQUIRES_SERVICE';

-- ===========================================================================
-- 4. A CATEGORY TRIGGER MUST CARRY A CATEGORY, NOT A SERVICE. The trigger and
--    its declared type can never disagree.
-- ===========================================================================
do $$
begin
  insert into booking.upsell_rules
   (business_id,name,trigger_type,trigger_service_id,trigger_service_category_id,suggested_service_id)
  values ('fb000000-0000-0000-0000-000000000001','Mismatched','service_category',
          'fb000000-0000-0000-0000-0000000000b1','fb000000-0000-0000-0000-0000000000c1',
          'fb000000-0000-0000-0000-0000000000b2');
  insert into probe_results values ('04_CATEGORY_TRIGGER_REJECTS_SERVICE_ID','FAIL: a category rule kept a service trigger id');
exception when check_violation then
  insert into probe_results values ('04_CATEGORY_TRIGGER_REJECTS_SERVICE_ID','PASS');
end $$;
select case_name as case, result from probe_results where case_name='04_CATEGORY_TRIGGER_REJECTS_SERVICE_ID';

-- ===========================================================================
-- 5. A VALID CATEGORY RULE IS ACCEPTED.
-- ===========================================================================
insert into booking.upsell_rules
 (id,business_id,name,trigger_type,trigger_service_category_id,suggested_service_id,priority)
values
 ('fb000000-0000-0000-0000-0000000000e2','fb000000-0000-0000-0000-000000000001',
  'Any colour to Treatment','service_category','fb000000-0000-0000-0000-0000000000c1',
  'fb000000-0000-0000-0000-0000000000b3',50);

select '05_CATEGORY_RULE_STORED' as case,
       case when (select trigger_service_id is null and trigger_service_category_id is not null
                  from booking.upsell_rules where id='fb000000-0000-0000-0000-0000000000e2')
       then 'PASS' else 'FAIL: a valid category rule was not stored cleanly' end as result;

-- ===========================================================================
-- 6. A DUPLICATE BUSINESS-WIDE RULE IS REJECTED. NULLS NOT DISTINCT is what
--    makes the location_id-is-null row collide with itself; without it two
--    identical business defaults would both be stored.
-- ===========================================================================
do $$
begin
  insert into booking.upsell_rules
   (business_id,location_id,name,trigger_type,trigger_service_id,suggested_service_id)
  values ('fb000000-0000-0000-0000-000000000001',null,'Duplicate','service',
          'fb000000-0000-0000-0000-0000000000b1','fb000000-0000-0000-0000-0000000000b2');
  insert into probe_results values ('06_DUPLICATE_BUSINESS_RULE_REJECTED','FAIL: a duplicate business-wide rule was stored');
exception when unique_violation then
  insert into probe_results values ('06_DUPLICATE_BUSINESS_RULE_REJECTED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='06_DUPLICATE_BUSINESS_RULE_REJECTED';

-- ===========================================================================
-- 7. A LOCATION OVERRIDE OF THE SAME PAIR IS ALLOWED. This is the legitimate
--    business-default + location-specific configuration, and it must NOT be
--    caught by the duplicate index.
-- ===========================================================================
insert into booking.upsell_rules
 (id,business_id,location_id,name,enabled,trigger_type,trigger_service_id,suggested_service_id)
values
 ('fb000000-0000-0000-0000-0000000000e3','fb000000-0000-0000-0000-000000000001',
  'fb000000-0000-0000-0000-0000000000a1','Pinner: no toner',false,'service',
  'fb000000-0000-0000-0000-0000000000b1','fb000000-0000-0000-0000-0000000000b2');

select '07_LOCATION_OVERRIDE_ALLOWED' as case,
       case when (select count(*) from booking.upsell_rules
                  where trigger_service_id='fb000000-0000-0000-0000-0000000000b1'
                    and suggested_service_id='fb000000-0000-0000-0000-0000000000b2') = 2
       then 'PASS' else 'FAIL: a location override of a business default was rejected' end as result;

-- ===========================================================================
-- 8. A DUPLICATE AT THE SAME LOCATION IS STILL REJECTED.
-- ===========================================================================
do $$
begin
  insert into booking.upsell_rules
   (business_id,location_id,name,trigger_type,trigger_service_id,suggested_service_id)
  values ('fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1',
          'Pinner duplicate','service','fb000000-0000-0000-0000-0000000000b1',
          'fb000000-0000-0000-0000-0000000000b2');
  insert into probe_results values ('08_DUPLICATE_LOCATION_RULE_REJECTED','FAIL: a duplicate location rule was stored');
exception when unique_violation then
  insert into probe_results values ('08_DUPLICATE_LOCATION_RULE_REJECTED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='08_DUPLICATE_LOCATION_RULE_REJECTED';

-- ===========================================================================
-- 9. THE SAME PAIR AT A DIFFERENT LOCATION IS A DIFFERENT RULE.
-- ===========================================================================
insert into booking.upsell_rules
 (id,business_id,location_id,name,trigger_type,trigger_service_id,suggested_service_id)
values
 ('fb000000-0000-0000-0000-0000000000e4','fb000000-0000-0000-0000-000000000001',
  'fb000000-0000-0000-0000-0000000000a2','Primrose: toner','service',
  'fb000000-0000-0000-0000-0000000000b1','fb000000-0000-0000-0000-0000000000b2');

select '09_SECOND_LOCATION_RULE_ALLOWED' as case,
       case when (select count(*) from booking.upsell_rules
                  where trigger_service_id='fb000000-0000-0000-0000-0000000000b1'
                    and suggested_service_id='fb000000-0000-0000-0000-0000000000b2') = 3
       then 'PASS' else 'FAIL: a second location''s rule was rejected as a duplicate' end as result;

-- ===========================================================================
-- 10. PRIORITY IS BOUNDED. A stray value cannot dominate every other rule.
-- ===========================================================================
do $$
begin
  insert into booking.upsell_rules
   (business_id,name,trigger_type,trigger_service_id,suggested_service_id,priority)
  values ('fb000000-0000-0000-0000-000000000001','Too loud','service',
          'fb000000-0000-0000-0000-0000000000b1','fb000000-0000-0000-0000-0000000000b3',99999);
  insert into probe_results values ('10_PRIORITY_BOUNDED','FAIL: an out-of-range priority was stored');
exception when check_violation then
  insert into probe_results values ('10_PRIORITY_BOUNDED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='10_PRIORITY_BOUNDED';

-- ===========================================================================
-- 11. A BLANK NAME IS REJECTED. An owner must be able to recognise their rule.
-- ===========================================================================
do $$
begin
  insert into booking.upsell_rules
   (business_id,name,trigger_type,trigger_service_id,suggested_service_id)
  values ('fb000000-0000-0000-0000-000000000001','   ','service',
          'fb000000-0000-0000-0000-0000000000b1','fb000000-0000-0000-0000-0000000000b4');
  insert into probe_results values ('11_BLANK_NAME_REJECTED','FAIL: a whitespace-only rule name was stored');
exception when check_violation then
  insert into probe_results values ('11_BLANK_NAME_REJECTED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='11_BLANK_NAME_REJECTED';

-- ===========================================================================
-- 12. A RULE DEFAULTS TO ENABLED. A newly created rule takes effect; an owner
--     never has to switch on what they just configured.
-- ===========================================================================
select '12_DEFAULT_ENABLED' as case,
       case when (select enabled from booking.upsell_rules
                  where id='fb000000-0000-0000-0000-0000000000e4')
       then 'PASS' else 'FAIL: a new rule did not default to enabled' end as result;

-- ===========================================================================
-- 13. updated_at IS MAINTAINED BY THE TRIGGER, NOT BY THE CALLER. now() is
--     fixed for the whole transaction, so "did the timestamp advance?" is
--     unprovable here. Instead a stale value is planted directly and the next
--     update must overwrite it — which only the trigger can do.
-- ===========================================================================
do $$
declare after_ts timestamptz;
begin
  update booking.upsell_rules set updated_at = timestamptz '2000-01-01 00:00:00Z'
   where id='fb000000-0000-0000-0000-0000000000e1';
  update booking.upsell_rules set enabled=false where id='fb000000-0000-0000-0000-0000000000e1';
  select updated_at into after_ts from booking.upsell_rules where id='fb000000-0000-0000-0000-0000000000e1';
  insert into probe_results values ('13_UPDATED_AT_TRIGGER',
    case when after_ts = now() then 'PASS'
         else 'FAIL: updated_at was not reset by the trigger (got ' || after_ts || ')' end);
  update booking.upsell_rules set enabled=true where id='fb000000-0000-0000-0000-0000000000e1';
end $$;
select case_name as case, result from probe_results where case_name='13_UPDATED_AT_TRIGGER';

-- ===========================================================================
-- 14. DELETING A SERVICE REMOVES ITS RULES. A rule pointing at a deleted
--     service must not survive to suggest a service that no longer exists.
-- ===========================================================================
do $$
declare remaining integer;
begin
  insert into booking.services
   (id,business_id,slug,name,estimated_duration_minutes,base_price)
  values ('fb000000-0000-0000-0000-0000000000b9','fb000000-0000-0000-0000-000000000001',
          'fb-doomed','Doomed Service',30,10);
  insert into booking.upsell_rules
   (business_id,name,trigger_type,trigger_service_id,suggested_service_id)
  values ('fb000000-0000-0000-0000-000000000001','Doomed','service',
          'fb000000-0000-0000-0000-0000000000b1','fb000000-0000-0000-0000-0000000000b9');
  delete from booking.services where id='fb000000-0000-0000-0000-0000000000b9';
  select count(*) into remaining from booking.upsell_rules
    where suggested_service_id='fb000000-0000-0000-0000-0000000000b9';
  insert into probe_results values ('14_SERVICE_DELETE_CASCADES',
    case when remaining = 0 then 'PASS' else 'FAIL: a rule outlived its suggested service' end);
end $$;
select case_name as case, result from probe_results where case_name='14_SERVICE_DELETE_CASCADES';

-- ===========================================================================
-- PART B — CO-OCCURRENCE FUNCTION
-- ===========================================================================

-- ===========================================================================
-- 15. THE BASE COUNT IS THE COMPLETED APPOINTMENTS CONTAINING THE TRIGGER.
--     20, not 24 — the cancelled / no_show / pending / accepted appointments
--     that also contain Colour are not evidence.
-- ===========================================================================
select '15_BASE_COUNT_COMPLETED_ONLY' as case,
       case when (select distinct base_count from booking.service_cooccurrence(
                    'fb000000-0000-0000-0000-000000000001',
                    array['fb000000-0000-0000-0000-0000000000b1']::uuid[],
                    null, 1, 1, 0, 500)) = 20
       then 'PASS' else 'FAIL: base count included non-completed appointments' end as result;

-- ===========================================================================
-- 16. A STRONG PAIR IS RETURNED WITH ITS EXACT COUNT. Toner co-occurs 12 times
--     out of 20 — again, not 16, because the four excluded appointments also
--     contained Toner.
-- ===========================================================================
select '16_TONER_PAIR_COUNTED' as case,
       case when (select cooccurrence_count from booking.service_cooccurrence(
                    'fb000000-0000-0000-0000-000000000001',
                    array['fb000000-0000-0000-0000-0000000000b1']::uuid[],
                    null, 10, 3, 0.2, 500)
                  where suggested_service_id='fb000000-0000-0000-0000-0000000000b2') = 12
       then 'PASS' else 'FAIL: the Colour+Toner pair was miscounted' end as result;

-- ===========================================================================
-- 17. A PAIR CLEARING EVERY THRESHOLD SURVIVES. Treatment at 5/20 = 0.25 is
--     over the 0.20 rate and the 3-count floor.
-- ===========================================================================
select '17_TREATMENT_PAIR_QUALIFIES' as case,
       case when (select count(*) from booking.service_cooccurrence(
                    'fb000000-0000-0000-0000-000000000001',
                    array['fb000000-0000-0000-0000-0000000000b1']::uuid[],
                    null, 10, 3, 0.2, 500)
                  where suggested_service_id='fb000000-0000-0000-0000-0000000000b3') = 1
       then 'PASS' else 'FAIL: a qualifying pair was dropped' end as result;

-- ===========================================================================
-- 18. A WEAK PAIR IS REJECTED. Scalp Ritual at 2/20 fails BOTH the minimum
--     co-occurrence (2 < 3) and the rate (0.10 < 0.20). This is the noise floor
--     that stops a coincidence being sold as a recommendation.
-- ===========================================================================
select '18_WEAK_PAIR_REJECTED' as case,
       case when (select count(*) from booking.service_cooccurrence(
                    'fb000000-0000-0000-0000-000000000001',
                    array['fb000000-0000-0000-0000-0000000000b1']::uuid[],
                    null, 10, 3, 0.2, 500)
                  where suggested_service_id='fb000000-0000-0000-0000-0000000000b4') = 0
       then 'PASS' else 'FAIL: a below-threshold pair was returned' end as result;

-- ===========================================================================
-- 19. THE RATE THRESHOLD BITES INDEPENDENTLY OF THE COUNT. Treatment's 5
--     occurrences clear a 3-count floor but not a 0.30 rate.
-- ===========================================================================
select '19_RATE_THRESHOLD_INDEPENDENT' as case,
       case when (select count(*) from booking.service_cooccurrence(
                    'fb000000-0000-0000-0000-000000000001',
                    array['fb000000-0000-0000-0000-0000000000b1']::uuid[],
                    null, 10, 3, 0.30, 500)
                  where suggested_service_id='fb000000-0000-0000-0000-0000000000b3') = 0
       then 'PASS' else 'FAIL: the rate threshold was not applied' end as result;

-- ===========================================================================
-- 20. THE BASE-SAMPLE THRESHOLD SILENCES THE WHOLE TRIGGER. With a base of 20
--     and a floor of 21, nothing at all is returned — a service with too little
--     history produces NO pattern suggestions rather than confident noise.
-- ===========================================================================
select '20_BASE_SAMPLE_SILENCES_TRIGGER' as case,
       case when (select count(*) from booking.service_cooccurrence(
                    'fb000000-0000-0000-0000-000000000001',
                    array['fb000000-0000-0000-0000-0000000000b1']::uuid[],
                    null, 21, 1, 0, 500)) = 0
       then 'PASS' else 'FAIL: a below-sample trigger still produced candidates' end as result;

-- ===========================================================================
-- 21. ANOTHER BUSINESS'S HISTORY IS NEVER MIXED IN. The rival salon booked
--     Colour+Toner 30 times; business 1's counts must be untouched by it.
-- ===========================================================================
select '21_CROSS_BUSINESS_HISTORY_ISOLATED' as case,
       case when (select count(*) from booking.service_cooccurrence(
                    'fb000000-0000-0000-0000-000000000001',
                    array['fb000000-0000-0000-0000-0000000000b5']::uuid[],
                    null, 1, 1, 0, 500)) = 0
       then 'PASS' else 'FAIL: another business''s services produced candidates' end as result;

-- ===========================================================================
-- 22. AND THE REVERSE: THE RIVAL SEES ONLY ITS OWN. Proof the isolation is a
--     filter on business_id, not an accident of which ids were asked for.
-- ===========================================================================
select '22_RIVAL_SEES_ONLY_ITS_OWN' as case,
       case when (select suggested_service_id from booking.service_cooccurrence(
                    'fb000000-0000-0000-0000-000000000002',
                    array['fb000000-0000-0000-0000-0000000000b5']::uuid[],
                    null, 10, 3, 0.2, 500))
                 = 'fb000000-0000-0000-0000-0000000000b6'
       then 'PASS' else 'FAIL: the rival business''s own pattern was not returned' end as result;

-- ===========================================================================
-- 23. A SERVICE NEVER CO-OCCURS WITH ITSELF. Self-suggestion is impossible from
--     the pattern side too, not only from the rule side.
-- ===========================================================================
select '23_NO_SELF_COOCCURRENCE' as case,
       case when (select count(*) from booking.service_cooccurrence(
                    'fb000000-0000-0000-0000-000000000001',
                    array['fb000000-0000-0000-0000-0000000000b1']::uuid[],
                    null, 1, 1, 0, 500)
                  where suggested_service_id='fb000000-0000-0000-0000-0000000000b1') = 0
       then 'PASS' else 'FAIL: a service co-occurred with itself' end as result;

-- ===========================================================================
-- 24. A SERVICE BOOKED TWICE ON ONE APPOINTMENT IS ONE PIECE OF EVIDENCE.
--     Without the DISTINCT, a two-line duplicate would inflate the pair count
--     and could push a weak pair over the threshold.
-- ===========================================================================
do $$
declare toner_count integer;
begin
  insert into booking.appointment_services
    (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes)
  values
    ('fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1',
     'fb000000-0000-0000-0000-000000001001','fb000000-0000-0000-0000-0000000000b2',
     9,'Toner (second application)',30);

  select cooccurrence_count into toner_count from booking.service_cooccurrence(
    'fb000000-0000-0000-0000-000000000001',
    array['fb000000-0000-0000-0000-0000000000b1']::uuid[], null, 10, 3, 0.2, 500)
  where suggested_service_id='fb000000-0000-0000-0000-0000000000b2';

  insert into probe_results values ('24_DUPLICATE_LINE_COUNTED_ONCE',
    case when toner_count = 12 then 'PASS'
         else 'FAIL: a repeated service line inflated the pair count to ' || toner_count end);

  delete from booking.appointment_services
   where appointment_id='fb000000-0000-0000-0000-000000001001' and sequence_no=9;
end $$;
select case_name as case, result from probe_results where case_name='24_DUPLICATE_LINE_COUNTED_ONCE';

-- ===========================================================================
-- 25. A CANCELLED SERVICE LINE STOPS BEING EVIDENCE. A service removed at
--     checkout must not keep driving suggestions.
-- ===========================================================================
do $$
declare toner_count integer;
begin
  update booking.appointment_services set status='cancelled'
   where appointment_id='fb000000-0000-0000-0000-000000001001'
     and service_id='fb000000-0000-0000-0000-0000000000b2';

  select cooccurrence_count into toner_count from booking.service_cooccurrence(
    'fb000000-0000-0000-0000-000000000001',
    array['fb000000-0000-0000-0000-0000000000b1']::uuid[], null, 10, 3, 0.2, 500)
  where suggested_service_id='fb000000-0000-0000-0000-0000000000b2';

  insert into probe_results values ('25_CANCELLED_LINE_EXCLUDED',
    case when toner_count = 11 then 'PASS'
         else 'FAIL: a cancelled service line still counted (got ' || coalesce(toner_count::text,'null') || ')' end);

  update booking.appointment_services set status='scheduled'
   where appointment_id='fb000000-0000-0000-0000-000000001001'
     and service_id='fb000000-0000-0000-0000-0000000000b2';
end $$;
select case_name as case, result from probe_results where case_name='25_CANCELLED_LINE_EXCLUDED';

-- ===========================================================================
-- 26. THE LOOKBACK WINDOW BOUNDS THE SCAN. p_since = 5 days ago leaves only the
--     5 most recent Colour appointments, so Toner's pair count falls to 5.
-- ===========================================================================
select '26_LOOKBACK_WINDOW_APPLIED' as case,
       case when (select cooccurrence_count from booking.service_cooccurrence(
                    'fb000000-0000-0000-0000-000000000001',
                    array['fb000000-0000-0000-0000-0000000000b1']::uuid[],
                    now() - interval '5 days', 1, 1, 0, 500)
                  where suggested_service_id='fb000000-0000-0000-0000-0000000000b2') = 5
       then 'PASS' else 'FAIL: the lookback window was not applied' end as result;

-- ===========================================================================
-- 27. A FUTURE COMPLETION INSTANT IS NOT EVIDENCE. A clock-skewed or bad row
--     cannot invent history that has not happened.
-- ===========================================================================
do $$
declare base integer;
begin
  insert into booking.appointments
    (id,business_id,location_id,client_profile_id,status,scheduled_start_at,scheduled_end_at,completed_at,occupied_ranges)
  values
    ('fb000000-0000-0000-0000-00000000ff01','fb000000-0000-0000-0000-000000000001',
     'fb000000-0000-0000-0000-0000000000a1','fb000000-0000-0000-0000-0000000000d1','paid',
     now() + interval '10 days', now() + interval '10 days' + interval '2 hours',
     now() + interval '10 days' + interval '2 hours',
     tstzmultirange(tstzrange(now() + interval '10 days',
                              now() + interval '10 days' + interval '2 hours', '[)')));
  insert into booking.appointment_services
    (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes)
  values
    ('fb000000-0000-0000-0000-000000000001','fb000000-0000-0000-0000-0000000000a1',
     'fb000000-0000-0000-0000-00000000ff01','fb000000-0000-0000-0000-0000000000b1',1,'Full Head Colour',120);

  select distinct base_count into base from booking.service_cooccurrence(
    'fb000000-0000-0000-0000-000000000001',
    array['fb000000-0000-0000-0000-0000000000b1']::uuid[], null, 1, 1, 0, 500);

  insert into probe_results values ('27_FUTURE_COMPLETION_EXCLUDED',
    case when base = 20 then 'PASS' else 'FAIL: a future completed_at counted as history' end);

  delete from booking.appointment_services where appointment_id='fb000000-0000-0000-0000-00000000ff01';
  delete from booking.appointments where id='fb000000-0000-0000-0000-00000000ff01';
end $$;
select case_name as case, result from probe_results where case_name='27_FUTURE_COMPLETION_EXCLUDED';

-- ===========================================================================
-- 28. THE ROW CAP IS ENFORCED. The server bounds the result whatever the caller
--     asks for.
-- ===========================================================================
select '28_ROW_CAP_ENFORCED' as case,
       case when (select count(*) from booking.service_cooccurrence(
                    'fb000000-0000-0000-0000-000000000001',
                    array['fb000000-0000-0000-0000-0000000000b1']::uuid[],
                    null, 1, 1, 0, 1)) = 1
       then 'PASS' else 'FAIL: p_max_rows did not bound the result' end as result;

-- ===========================================================================
-- 29. RESULTS ARE DETERMINISTIC. The same call twice returns the identical
--     ordered rows — the whole basis of "same inputs, same suggestions".
-- ===========================================================================
select '29_DETERMINISTIC' as case,
       case when (
         select array_agg(suggested_service_id order by ord)
         from (select suggested_service_id, row_number() over () as ord
               from booking.service_cooccurrence(
                 'fb000000-0000-0000-0000-000000000001',
                 array['fb000000-0000-0000-0000-0000000000b1']::uuid[], null, 10, 3, 0.2, 500)) a
       ) = (
         select array_agg(suggested_service_id order by ord)
         from (select suggested_service_id, row_number() over () as ord
               from booking.service_cooccurrence(
                 'fb000000-0000-0000-0000-000000000001',
                 array['fb000000-0000-0000-0000-0000000000b1']::uuid[], null, 10, 3, 0.2, 500)) b
       )
       then 'PASS' else 'FAIL: two identical calls returned different orders' end as result;

-- ===========================================================================
-- PART C — SECURITY
-- ===========================================================================

-- ===========================================================================
-- 30. THE FUNCTION IS NOT EXECUTABLE BY `authenticated`. Without this, a
--     client-side caller could pass ANY p_business_id and read another salon's
--     entire booking history.
-- ===========================================================================
select '30_FUNCTION_NOT_PUBLIC' as case,
       case when not has_function_privilege('authenticated',
              'booking.service_cooccurrence(uuid,uuid[],timestamptz,integer,integer,numeric,integer)','execute')
             and not has_function_privilege('anon',
              'booking.service_cooccurrence(uuid,uuid[],timestamptz,integer,integer,numeric,integer)','execute')
       then 'PASS' else 'FAIL: the co-occurrence function is executable by a client role' end as result;

-- ===========================================================================
-- 31. service_role CAN EXECUTE IT. The API must still work.
-- ===========================================================================
select '31_SERVICE_ROLE_CAN_EXECUTE' as case,
       case when has_function_privilege('service_role',
              'booking.service_cooccurrence(uuid,uuid[],timestamptz,integer,integer,numeric,integer)','execute')
       then 'PASS' else 'FAIL: service_role cannot execute the function' end as result;

-- ===========================================================================
-- 32. RLS IS ENABLED ON THE RULE TABLE. Migration 0002 grants `authenticated`
--     full CRUD on every new table in the booking schema by default, so the
--     policies are the ONLY tenancy boundary here.
-- ===========================================================================
select '32_RLS_ENABLED' as case,
       case when (select relrowsecurity from pg_class
                  where oid = 'booking.upsell_rules'::regclass)
       then 'PASS' else 'FAIL: RLS is not enabled on booking.upsell_rules' end as result;

-- ===========================================================================
-- 33. A STYLIST CAN READ THEIR SALON'S RULES BUT CANNOT CHANGE THEM. Staff
--     consume suggestions; they do not decide what the salon recommends.
-- ===========================================================================
do $$
declare visible integer; changed integer;
begin
  perform set_config('request.jwt.claim.sub','fb000000-0000-0000-0000-0000000000f2',true);
  set local role authenticated;

  select count(*) into visible from booking.upsell_rules
   where business_id='fb000000-0000-0000-0000-000000000001';

  update booking.upsell_rules set enabled=false
   where id='fb000000-0000-0000-0000-0000000000e1';
  get diagnostics changed = row_count;

  reset role;
  insert into probe_results values ('33_STYLIST_READ_ONLY',
    case when visible > 0 and changed = 0 then 'PASS'
         when visible = 0 then 'FAIL: a member of the salon could not read its rules'
         else 'FAIL: a stylist changed an owner rule' end);
exception when others then
  -- RLS filters an UPDATE to zero rows; it does not raise. Any exception here is
  -- an environment problem masquerading as a policy result, so it fails loudly
  -- rather than being scored as the policy working.
  reset role;
  insert into probe_results values ('33_STYLIST_READ_ONLY',
    'FAIL: unexpected ' || sqlstate || ' ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='33_STYLIST_READ_ONLY';

-- ===========================================================================
-- 34. ANOTHER BUSINESS'S OWNER SEES NOTHING. The rival owner is a legitimate
--     `authenticated` user with an owner membership — of the WRONG business.
-- ===========================================================================
do $$
declare leaked integer;
begin
  perform set_config('request.jwt.claim.sub','fb000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  select count(*) into leaked from booking.upsell_rules
   where business_id='fb000000-0000-0000-0000-000000000001';
  reset role;
  insert into probe_results values ('34_CROSS_BUSINESS_RULES_HIDDEN',
    case when leaked = 0 then 'PASS' else 'FAIL: another business''s rules were readable' end);
exception when others then
  reset role;
  insert into probe_results values ('34_CROSS_BUSINESS_RULES_HIDDEN','FAIL: unexpected error ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='34_CROSS_BUSINESS_RULES_HIDDEN';

-- ---------------------------------------------------------------------------
-- Teardown — nothing this suite created survives.
-- ---------------------------------------------------------------------------
rollback;
