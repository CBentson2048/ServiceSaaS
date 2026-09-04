-- post_checkin_service_lifecycle.sql — behavioural suite for migration 0110.
--
-- WHY THIS FILE EXISTS. The Jest suites stub the Supabase client, so they can
-- prove the API asks the database for the right things but not that the
-- database keeps its promises: that a post-check-in add keeps the booked line,
-- that a retried request with the same key adds nothing twice, that the lines
-- of a PAID appointment cannot be touched, that the change history cannot be
-- rewritten, that Business A cannot put its service on Business B's visit, and
-- that a stylist reading the history through PostgREST sees only their own
-- column. This file is that proof: the function, the triggers, the constraints
-- and the policies run for real.
--
-- 65 numbered cases. Every RESULT must read PASS.
--
-- Run against a SCRATCH database that has every migration through 0110 applied:
--   psql -d <scratch> -f supabase/tests/post_checkin_service_lifecycle.sql
--
-- The whole suite runs inside one transaction rolled back at the end. Every
-- expected failure runs inside a plpgsql block whose exception handler records
-- the verdict, so the rejected write is undone while the evidence survives.
--
-- HOW THE RLS CASES WORK. `set local role authenticated` plus
-- `set_config('request.jwt.claim.sub', <user id>, true)` is exactly what
-- PostgREST does per request. Role is always reset before recording a verdict.

\set ON_ERROR_STOP off
\pset pager off

begin;

create temporary table probe_results (case_name text primary key, result text) on commit drop;

-- ---------------------------------------------------------------------------
-- Fixtures. 'ac' prefix, hex-only UUIDs, distinct from the other suites.
-- ---------------------------------------------------------------------------
insert into core.businesses (id,name,slug) values
 ('ac000000-0000-0000-0000-000000000001','Lifecycle Salon','lifecycle-salon'),
 ('ac000000-0000-0000-0000-000000000002','Rival Lifecycle','rival-lifecycle');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-000000000001','L1','Pinner','ac-pinner','1 High St','Pinner','HA5 1AA','Europe/London'),
 ('ac000000-0000-0000-0000-0000000000a2','ac000000-0000-0000-0000-000000000001','L2','Primrose Hill','ac-primrose','2 High St','London','NW1 8JR','Europe/London'),
 ('ac000000-0000-0000-0000-0000000000a3','ac000000-0000-0000-0000-000000000002','L3','Rival','ac-rival','3 High St','Watford','WD1 1AA','Europe/London');

insert into auth.users (id,email) values
 ('ac000000-0000-0000-0000-0000000000f1'::uuid,'owner@ac.example'),
 ('ac000000-0000-0000-0000-0000000000f2'::uuid,'jane@ac.example'),
 ('ac000000-0000-0000-0000-0000000000f3'::uuid,'sarah@ac.example'),
 ('ac000000-0000-0000-0000-0000000000f4'::uuid,'rival@ac.example');

insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name,is_active) values
 ('ac000000-0000-0000-0000-0000000000f1','owner@ac.example','Olive Owner','Olive','Owner','Olive',true),
 ('ac000000-0000-0000-0000-0000000000f2','jane@ac.example','Jane Stylist','Jane','Stylist','Jane',true),
 ('ac000000-0000-0000-0000-0000000000f3','sarah@ac.example','Sarah Manager','Sarah','Manager','Sarah',true),
 ('ac000000-0000-0000-0000-0000000000f4','rival@ac.example','Ray Rival','Ray','Rival','Ray',true);

insert into core.user_memberships (business_id,location_id,user_profile_id,role,status,activated_at) values
 ('ac000000-0000-0000-0000-000000000001',null,'ac000000-0000-0000-0000-0000000000f1','owner','active',now()),
 ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000f2','stylist','active',now()),
 ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000f3','stylist','active',now()),
 ('ac000000-0000-0000-0000-000000000002',null,'ac000000-0000-0000-0000-0000000000f4','owner','active',now());

insert into core.staff_profiles (id,business_id,user_profile_id,primary_location_id,display_name) values
 ('ac000000-0000-0000-0000-0000000000d1','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000f2','ac000000-0000-0000-0000-0000000000a1','Jane'),
 ('ac000000-0000-0000-0000-0000000000d2','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000f3','ac000000-0000-0000-0000-0000000000a1','Sarah'),
 ('ac000000-0000-0000-0000-0000000000d9','ac000000-0000-0000-0000-000000000002','ac000000-0000-0000-0000-0000000000f4','ac000000-0000-0000-0000-0000000000a3','Ray');

insert into core.client_profiles (id,business_id,primary_location_id,first_name,last_name) values
 ('ac000000-0000-0000-0000-0000000000c1','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','Jane','Test'),
 ('ac000000-0000-0000-0000-0000000000c2','ac000000-0000-0000-0000-000000000002','ac000000-0000-0000-0000-0000000000a3','Rival','Client');

-- Services: the demo catalogue plus the three that must be REFUSED — a
-- Primrose-only service on a Pinner visit, an inactive service, and the rival's.
insert into booking.services (id,business_id,location_id,slug,name,estimated_duration_minutes,base_price,is_active,rebooking_nudge_enabled,rebooking_nudge_interval_days) values
 ('ac000000-0000-0000-0000-0000000000b1','ac000000-0000-0000-0000-000000000001',null,'ac-fhc','Full Head Colour',60,100.00,true,true,42),
 ('ac000000-0000-0000-0000-0000000000b2','ac000000-0000-0000-0000-000000000001',null,'ac-cut','Cut & Finish',45,50.00,true,true,35),
 ('ac000000-0000-0000-0000-0000000000b3','ac000000-0000-0000-0000-000000000001',null,'ac-toner','Toner',20,30.00,true,false,35),
 ('ac000000-0000-0000-0000-0000000000b4','ac000000-0000-0000-0000-000000000001',null,'ac-treat','Treatment',15,20.00,true,false,35),
 ('ac000000-0000-0000-0000-0000000000b5','ac000000-0000-0000-0000-000000000001',null,'ac-hhh','Half Head Highlights',75,100.00,true,true,56),
 ('ac000000-0000-0000-0000-0000000000b6','ac000000-0000-0000-0000-000000000001',null,'ac-fhh','Full Head Highlights',90,150.00,true,true,56),
 ('ac000000-0000-0000-0000-0000000000b7','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a2','ac-primrose-only','Primrose Gloss',30,40.00,true,false,35),
 ('ac000000-0000-0000-0000-0000000000b8','ac000000-0000-0000-0000-000000000001',null,'ac-retired','Retired Service',30,40.00,false,false,35),
 ('ac000000-0000-0000-0000-0000000000b9','ac000000-0000-0000-0000-000000000002',null,'ac-rival','Rival Colour',60,90.00,true,false,35);

-- Appointments. Jane (d1) is the stylist on every Lifecycle Salon visit; each
-- sits in its own hour so the no-overlap constraint has nothing to object to.
--   ap1 checked_in       — the main scenario (Full Head Colour + Cut & Finish)
--   ap2 accepted         — not yet arrived
--   ap3 checked_in→paid  — immutability (set to paid after its lines exist)
--   ap4 awaiting_payment — visit exists; bill is live
--   ap5 cancelled, ap6 no_show
--   ap7 rival business
--   ap9 checked_in with ONE line — the last-service guard
insert into booking.appointments (id,business_id,location_id,client_profile_id,assigned_staff_profile_id,status,scheduled_start_at,scheduled_end_at,check_in_at,occupied_ranges) values
 ('ac000000-0000-0000-0000-0000000000e1','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000c1','ac000000-0000-0000-0000-0000000000d1','checked_in',now()-interval '9 hours',now()-interval '8 hours',now()-interval '9 hours',tstzmultirange(tstzrange(now()-interval '9 hours',now()-interval '8 hours','[)'))),
 ('ac000000-0000-0000-0000-0000000000e2','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000c1','ac000000-0000-0000-0000-0000000000d1','accepted',now()+interval '1 day',now()+interval '1 day 1 hour',null,tstzmultirange(tstzrange(now()+interval '1 day',now()+interval '1 day 1 hour','[)'))),
 ('ac000000-0000-0000-0000-0000000000e3','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000c1','ac000000-0000-0000-0000-0000000000d1','checked_in',now()-interval '7 hours',now()-interval '6 hours',now()-interval '7 hours',tstzmultirange(tstzrange(now()-interval '7 hours',now()-interval '6 hours','[)'))),
 ('ac000000-0000-0000-0000-0000000000e4','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000c1','ac000000-0000-0000-0000-0000000000d1','awaiting_payment',now()-interval '5 hours',now()-interval '4 hours',now()-interval '5 hours',tstzmultirange(tstzrange(now()-interval '5 hours',now()-interval '4 hours','[)'))),
 ('ac000000-0000-0000-0000-0000000000e5','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000c1','ac000000-0000-0000-0000-0000000000d1','cancelled',now()-interval '3 hours',now()-interval '2 hours',null,tstzmultirange(tstzrange(now()-interval '3 hours',now()-interval '2 hours','[)'))),
 ('ac000000-0000-0000-0000-0000000000e6','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000c1','ac000000-0000-0000-0000-0000000000d1','no_show',now()-interval '2 days',now()-interval '2 days'+interval '1 hour',null,tstzmultirange(tstzrange(now()-interval '2 days',now()-interval '2 days'+interval '1 hour','[)'))),
 ('ac000000-0000-0000-0000-0000000000e7','ac000000-0000-0000-0000-000000000002','ac000000-0000-0000-0000-0000000000a3','ac000000-0000-0000-0000-0000000000c2','ac000000-0000-0000-0000-0000000000d9','checked_in',now()-interval '9 hours',now()-interval '8 hours',now()-interval '9 hours',tstzmultirange(tstzrange(now()-interval '9 hours',now()-interval '8 hours','[)'))),
 ('ac000000-0000-0000-0000-0000000000e9','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000c1','ac000000-0000-0000-0000-0000000000d1','checked_in',now()-interval '12 hours',now()-interval '11 hours',now()-interval '12 hours',tstzmultirange(tstzrange(now()-interval '12 hours',now()-interval '11 hours','[)')));

update booking.appointments set completed_at = now()-interval '4 hours' where id='ac000000-0000-0000-0000-0000000000e4';

insert into booking.appointment_services (id,business_id,location_id,appointment_id,service_id,assigned_staff_profile_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status) values
 ('ac000000-0000-0000-0000-000000000011','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e1','ac000000-0000-0000-0000-0000000000b1','ac000000-0000-0000-0000-0000000000d1',1,'Full Head Colour',60,100.00,'scheduled'),
 ('ac000000-0000-0000-0000-000000000012','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e1','ac000000-0000-0000-0000-0000000000b2','ac000000-0000-0000-0000-0000000000d1',2,'Cut & Finish',45,50.00,'scheduled'),
 ('ac000000-0000-0000-0000-000000000021','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e2','ac000000-0000-0000-0000-0000000000b1','ac000000-0000-0000-0000-0000000000d1',1,'Full Head Colour',60,100.00,'scheduled'),
 ('ac000000-0000-0000-0000-000000000031','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e3','ac000000-0000-0000-0000-0000000000b1','ac000000-0000-0000-0000-0000000000d1',1,'Full Head Colour',60,100.00,'completed'),
 ('ac000000-0000-0000-0000-000000000041','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e4','ac000000-0000-0000-0000-0000000000b1','ac000000-0000-0000-0000-0000000000d1',1,'Full Head Colour',60,100.00,'completed'),
 ('ac000000-0000-0000-0000-000000000051','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e5','ac000000-0000-0000-0000-0000000000b1','ac000000-0000-0000-0000-0000000000d1',1,'Full Head Colour',60,100.00,'scheduled'),
 ('ac000000-0000-0000-0000-000000000061','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e6','ac000000-0000-0000-0000-0000000000b1','ac000000-0000-0000-0000-0000000000d1',1,'Full Head Colour',60,100.00,'scheduled'),
 ('ac000000-0000-0000-0000-000000000071','ac000000-0000-0000-0000-000000000002','ac000000-0000-0000-0000-0000000000a3','ac000000-0000-0000-0000-0000000000e7','ac000000-0000-0000-0000-0000000000b9','ac000000-0000-0000-0000-0000000000d9',1,'Rival Colour',60,90.00,'scheduled'),
 ('ac000000-0000-0000-0000-000000000091','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e9','ac000000-0000-0000-0000-0000000000b2','ac000000-0000-0000-0000-0000000000d1',1,'Cut & Finish',45,50.00,'scheduled');

insert into booking.visits (id,business_id,location_id,appointment_id,client_profile_id,primary_staff_profile_id,status,checked_in_at,started_at,completed_at,checkout_status,checkout_ready_at,source) values
 ('ac000000-0000-0000-0000-0000000000e4','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e4','ac000000-0000-0000-0000-0000000000c1','ac000000-0000-0000-0000-0000000000d1','awaiting_payment',now()-interval '5 hours',now()-interval '5 hours',now()-interval '4 hours','awaiting_payment',now()-interval '4 hours','appointment_completion');

-- A convenience for the calls below: every payload is the same shape.
create temporary table probe_state (key text primary key, value text) on commit drop;

-- ===========================================================================
-- 1. EXISTING LINES ARE THE BOOKED BASELINE. The new provenance column defaults
--    to 'booked' for every row that predates 0110.
-- ===========================================================================
select '01_EXISTING_LINES_ARE_BOOKED' as case,
       case when (select count(*) from booking.appointment_services where origin <> 'booked') = 0
             and (select count(*) from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000e1') = 2
       then 'PASS' else 'FAIL: pre-existing lines did not default to origin=booked' end as result;

-- ===========================================================================
-- 2. ADD A TONER AFTER CHECK-IN. The new line snapshots the catalogue price,
--    defaults to the appointment's stylist, gets the next sequence number and
--    NO diary window.
-- ===========================================================================
do $$
declare v jsonb;
begin
  v := booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e1','businessId','ac000000-0000-0000-0000-000000000001',
    'action','add','serviceId','ac000000-0000-0000-0000-0000000000b3',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorStaffProfileId','ac000000-0000-0000-0000-0000000000d1','actorRole','stylist',
    'idempotencyKey','ac-add-toner-1'));
  insert into probe_state values ('toner_line', v->>'lineId'), ('toner_change', v->>'changeId'), ('toner_replayed', v->>'replayed');
exception when others then
  insert into probe_results values ('02_ADD_TONER_AFTER_CHECKIN','FAIL: '||sqlerrm);
end $$;
insert into probe_results
select '02_ADD_TONER_AFTER_CHECKIN',
       case when exists (
         select 1 from booking.appointment_services l
         where l.id = (select value::uuid from probe_state where key='toner_line')
           and l.appointment_id='ac000000-0000-0000-0000-0000000000e1'
           and l.service_id='ac000000-0000-0000-0000-0000000000b3'
           and l.service_name_snapshot='Toner' and l.price_amount=30.00
           and l.origin='post_checkin_add' and l.status='scheduled'
           and l.assigned_staff_profile_id='ac000000-0000-0000-0000-0000000000d1'
           and l.sequence_no=3 and l.scheduled_start_at is null and l.scheduled_end_at is null
           and l.added_at is not null and l.added_by_user_profile_id='ac000000-0000-0000-0000-0000000000f2'
       ) then 'PASS' else 'FAIL: the added line is missing or wrongly shaped' end
where not exists (select 1 from probe_results where case_name='02_ADD_TONER_AFTER_CHECKIN');
select case_name as case, result from probe_results where case_name='02_ADD_TONER_AFTER_CHECKIN';

-- ===========================================================================
-- 3. THE HISTORY ROW IS WRITTEN WITH THE ADD: actor, status at the time, price.
-- ===========================================================================
select '03_HISTORY_ROW_FOR_ADD' as case,
       case when exists (
         select 1 from booking.appointment_service_changes c
         where c.id = (select value::uuid from probe_state where key='toner_change')
           and c.appointment_id='ac000000-0000-0000-0000-0000000000e1'
           and c.action='added' and c.appointment_status_at_change='checked_in'
           and c.actor_user_profile_id='ac000000-0000-0000-0000-0000000000f2'
           and c.actor_staff_profile_id='ac000000-0000-0000-0000-0000000000d1'
           and c.actor_role='stylist'
           and c.before is null
           and c.after->>'serviceName'='Toner' and (c.after->>'priceAmount')::numeric=30.00
           and c.after->>'staffProfileId'='ac000000-0000-0000-0000-0000000000d1'
           and c.idempotency_key='ac-add-toner-1'
       ) then 'PASS' else 'FAIL: history row missing or incomplete' end as result;

-- ===========================================================================
-- 4. A RETRIED REQUEST WITH THE SAME KEY ADDS NOTHING. Same change id back,
--    replayed=true, still exactly one Toner line.
-- ===========================================================================
do $$
declare v jsonb;
begin
  v := booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e1','businessId','ac000000-0000-0000-0000-000000000001',
    'action','add','serviceId','ac000000-0000-0000-0000-0000000000b3',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorRole','stylist',
    'idempotencyKey','ac-add-toner-1'));
  insert into probe_results values ('04_RETRY_IS_IDEMPOTENT',
    case when (v->>'replayed')::boolean and v->>'changeId' = (select value from probe_state where key='toner_change')
          and (select count(*) from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000e1' and service_id='ac000000-0000-0000-0000-0000000000b3') = 1
          and (select count(*) from booking.appointment_service_changes where appointment_id='ac000000-0000-0000-0000-0000000000e1') = 1
     then 'PASS' else 'FAIL: replay added a second line or a second change: '||v::text end);
exception when others then
  insert into probe_results values ('04_RETRY_IS_IDEMPOTENT','FAIL: '||sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='04_RETRY_IS_IDEMPOTENT';

-- ===========================================================================
-- 5. REMOVE THE BOOKED CUT. The row is KEPT, marked cancelled with who/when/why.
-- ===========================================================================
do $$
declare v jsonb;
begin
  v := booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e1','businessId','ac000000-0000-0000-0000-000000000001',
    'action','remove','lineId','ac000000-0000-0000-0000-000000000012',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f3','actorStaffProfileId','ac000000-0000-0000-0000-0000000000d2','actorRole','stylist',
    'reason','Client decided against a cut today'));
  insert into probe_state values ('cut_change', v->>'changeId');
exception when others then
  insert into probe_results values ('05_REMOVE_KEEPS_THE_ROW','FAIL: '||sqlerrm);
end $$;
insert into probe_results
select '05_REMOVE_KEEPS_THE_ROW',
       case when exists (
         select 1 from booking.appointment_services l
         where l.id='ac000000-0000-0000-0000-000000000012'
           and l.status='cancelled' and l.origin='booked'
           and l.removed_at is not null
           and l.removed_by_user_profile_id='ac000000-0000-0000-0000-0000000000f3'
           and l.removal_reason='Client decided against a cut today'
       ) and exists (
         select 1 from booking.appointment_service_changes c
         where c.id=(select value::uuid from probe_state where key='cut_change')
           and c.action='removed' and c.appointment_service_id='ac000000-0000-0000-0000-000000000012'
           and c.before->>'serviceName'='Cut & Finish' and (c.before->>'priceAmount')::numeric=50.00
           and c.after is null and c.reason='Client decided against a cut today'
           and c.actor_user_profile_id='ac000000-0000-0000-0000-0000000000f3'
       ) then 'PASS' else 'FAIL: removed line was deleted, or the history is incomplete' end
where not exists (select 1 from probe_results where case_name='05_REMOVE_KEEPS_THE_ROW');
select case_name as case, result from probe_results where case_name='05_REMOVE_KEEPS_THE_ROW';

-- ===========================================================================
-- 6. BOTH QUESTIONS ARE PLAIN QUERIES. "What was booked?" = origin='booked'.
--    "What was performed?" = status<>'cancelled'. No log parsing.
-- ===========================================================================
select '06_BOOKED_VS_PERFORMED_QUERYABLE' as case,
       case when (select string_agg(service_name_snapshot, ', ' order by sequence_no)
                  from booking.appointment_services
                  where appointment_id='ac000000-0000-0000-0000-0000000000e1' and origin='booked') = 'Full Head Colour, Cut & Finish'
             and (select string_agg(service_name_snapshot, ', ' order by sequence_no)
                  from booking.appointment_services
                  where appointment_id='ac000000-0000-0000-0000-0000000000e1' and status<>'cancelled') = 'Full Head Colour, Toner'
             and (select sum(price_amount) from booking.appointment_services
                  where appointment_id='ac000000-0000-0000-0000-0000000000e1' and status<>'cancelled') = 130.00
             and (select sum(price_amount) from booking.appointment_services
                  where appointment_id='ac000000-0000-0000-0000-0000000000e1' and origin='booked') = 150.00
       then 'PASS' else 'FAIL: booked/performed sets do not reconstruct' end as result;

-- ===========================================================================
-- 7. REMOVING AN ALREADY-REMOVED LINE IS A NO-OP, not a second removal.
-- ===========================================================================
do $$
declare v jsonb;
begin
  v := booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e1','businessId','ac000000-0000-0000-0000-000000000001',
    'action','remove','lineId','ac000000-0000-0000-0000-000000000012',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f3','actorRole','stylist'));
  insert into probe_results values ('07_DOUBLE_REMOVE_IS_NOOP',
    case when (v->>'alreadyApplied')::boolean
          and (select count(*) from booking.appointment_service_changes where appointment_id='ac000000-0000-0000-0000-0000000000e1' and action='removed') = 1
     then 'PASS' else 'FAIL: '||v::text end);
exception when others then
  insert into probe_results values ('07_DOUBLE_REMOVE_IS_NOOP','FAIL: '||sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='07_DOUBLE_REMOVE_IS_NOOP';

-- ===========================================================================
-- 8. REPLACE: Full Head Colour becomes Half Head Highlights in ONE atomic call.
--    The booked line stays (cancelled, removed_at), the new line points back at
--    it, and one 'replaced' history row carries before AND after.
-- ===========================================================================
do $$
declare v jsonb;
begin
  v := booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e1','businessId','ac000000-0000-0000-0000-000000000001',
    'action','replace','lineId','ac000000-0000-0000-0000-000000000011','serviceId','ac000000-0000-0000-0000-0000000000b5',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorStaffProfileId','ac000000-0000-0000-0000-0000000000d1','actorRole','stylist',
    'reason','Consultation: half head is enough'));
  insert into probe_state values ('hhh_line', v->>'lineId'), ('hhh_change', v->>'changeId');
exception when others then
  insert into probe_results values ('08_REPLACE_IS_ATOMIC_AND_TRACEABLE','FAIL: '||sqlerrm);
end $$;
insert into probe_results
select '08_REPLACE_IS_ATOMIC_AND_TRACEABLE',
       case when exists (
         select 1 from booking.appointment_services old
         where old.id='ac000000-0000-0000-0000-000000000011' and old.status='cancelled' and old.removed_at is not null
       ) and exists (
         select 1 from booking.appointment_services l
         where l.id=(select value::uuid from probe_state where key='hhh_line')
           and l.service_name_snapshot='Half Head Highlights' and l.price_amount=100.00
           and l.origin='post_checkin_replace'
           and l.replaces_appointment_service_id='ac000000-0000-0000-0000-000000000011'
           and l.status='scheduled'
       ) and exists (
         select 1 from booking.appointment_service_changes c
         where c.id=(select value::uuid from probe_state where key='hhh_change')
           and c.action='replaced'
           and c.replaced_appointment_service_id='ac000000-0000-0000-0000-000000000011'
           and c.before->>'serviceName'='Full Head Colour' and c.after->>'serviceName'='Half Head Highlights'
       ) then 'PASS' else 'FAIL: replacement did not keep the booked line, link the new one, or record before/after' end
where not exists (select 1 from probe_results where case_name='08_REPLACE_IS_ATOMIC_AND_TRACEABLE');
select case_name as case, result from probe_results where case_name='08_REPLACE_IS_ATOMIC_AND_TRACEABLE';

-- After 2/5/8 the performed set is Toner + Half Head Highlights (£130); booked
-- is still Full Head Colour + Cut & Finish (£150).
select '09_PERFORMED_AFTER_REPLACE' as case,
       case when (select string_agg(service_name_snapshot, ', ' order by sequence_no)
                  from booking.appointment_services
                  where appointment_id='ac000000-0000-0000-0000-0000000000e1' and status<>'cancelled') = 'Toner, Half Head Highlights'
             and (select sum(price_amount) from booking.appointment_services
                  where appointment_id='ac000000-0000-0000-0000-0000000000e1' and status<>'cancelled') = 130.00
             and (select string_agg(service_name_snapshot, ', ' order by sequence_no)
                  from booking.appointment_services
                  where appointment_id='ac000000-0000-0000-0000-0000000000e1' and origin='booked') = 'Full Head Colour, Cut & Finish'
       then 'PASS' else 'FAIL' end as result;

-- ===========================================================================
-- 10. THE LAST PERFORMED SERVICE CANNOT BE REMOVED (replace it instead).
-- ===========================================================================
do $$
begin
  perform booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e9','businessId','ac000000-0000-0000-0000-000000000001',
    'action','remove','lineId','ac000000-0000-0000-0000-000000000091',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorRole','stylist'));
  insert into probe_results values ('10_LAST_SERVICE_GUARD','FAIL: the only performed service was removed');
exception when others then
  insert into probe_results values ('10_LAST_SERVICE_GUARD',
    case when sqlerrm like 'LAST_PERFORMED_SERVICE%'
          and (select status from booking.appointment_services where id='ac000000-0000-0000-0000-000000000091') = 'scheduled'
     then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
select case_name as case, result from probe_results where case_name='10_LAST_SERVICE_GUARD';

-- ===========================================================================
-- 11-14. LIFECYCLE MATRIX. accepted / cancelled / no_show refuse; paid refuses
--    (tested with the trigger in 20-22 too); awaiting_payment allows and the new
--    line is born 'completed'.
-- ===========================================================================
do $$
declare
  r record;
  msg text;
begin
  for r in select * from (values
      ('11_ACCEPTED_REFUSED','ac000000-0000-0000-0000-0000000000e2','accepted'),
      ('12_CANCELLED_REFUSED','ac000000-0000-0000-0000-0000000000e5','cancelled'),
      ('13_NO_SHOW_REFUSED','ac000000-0000-0000-0000-0000000000e6','no_show')
    ) as t(case_name, appt, expected) loop
    begin
      perform booking.amend_appointment_services(jsonb_build_object(
        'appointmentId',r.appt,'businessId','ac000000-0000-0000-0000-000000000001',
        'action','add','serviceId','ac000000-0000-0000-0000-0000000000b3',
        'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorRole','stylist'));
      insert into probe_results values (r.case_name,'FAIL: a service was added to a '||r.expected||' appointment');
    exception when others then
      msg := sqlerrm;
      insert into probe_results values (r.case_name,
        case when msg = 'APPOINTMENT_NOT_AMENDABLE:'||r.expected then 'PASS' else 'FAIL: '||msg end);
    end;
  end loop;
end $$;
select case_name as case, result from probe_results where case_name in ('11_ACCEPTED_REFUSED','12_CANCELLED_REFUSED','13_NO_SHOW_REFUSED') order by 1;

do $$
declare v jsonb;
begin
  v := booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e4','businessId','ac000000-0000-0000-0000-000000000001',
    'action','add','serviceId','ac000000-0000-0000-0000-0000000000b3',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f3','actorStaffProfileId','ac000000-0000-0000-0000-0000000000d2','actorRole','stylist',
    'staffProfileId','ac000000-0000-0000-0000-0000000000d2'));
  insert into probe_state values ('ap4_toner_line', v->>'lineId');
  insert into probe_results values ('14_AWAITING_PAYMENT_ALLOWED_LINE_COMPLETED',
    case when exists (select 1 from booking.appointment_services l where l.id=(v->>'lineId')::uuid
                        and l.status='completed' and l.origin='post_checkin_add'
                        and l.assigned_staff_profile_id='ac000000-0000-0000-0000-0000000000d2')
          and exists (select 1 from booking.appointment_service_changes c where c.id=(v->>'changeId')::uuid
                        and c.appointment_status_at_change='awaiting_payment')
     then 'PASS' else 'FAIL: line not completed / not attributed to Sarah' end);
exception when others then
  insert into probe_results values ('14_AWAITING_PAYMENT_ALLOWED_LINE_COMPLETED','FAIL: '||sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='14_AWAITING_PAYMENT_ALLOWED_LINE_COMPLETED';

-- ===========================================================================
-- 15-19. TENANCY AND AVAILABILITY.
-- ===========================================================================
do $$
declare
  r record;
  msg text;
begin
  for r in select * from (values
      -- Business B calling with its own id against Business A's appointment.
      ('15_CROSS_BUSINESS_APPOINTMENT','ac000000-0000-0000-0000-0000000000e1','ac000000-0000-0000-0000-000000000002','ac000000-0000-0000-0000-0000000000b9',null::text,'APPOINTMENT_NOT_FOUND'),
      -- Business B's service on Business A's visit.
      ('16_RIVAL_SERVICE_REFUSED','ac000000-0000-0000-0000-0000000000e1','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000b9',null,'SERVICE_NOT_AVAILABLE'),
      -- A Primrose Hill-only service on a Pinner visit.
      ('17_WRONG_LOCATION_SERVICE_REFUSED','ac000000-0000-0000-0000-0000000000e1','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000b7',null,'SERVICE_NOT_AVAILABLE'),
      -- An inactive service.
      ('18_INACTIVE_SERVICE_REFUSED','ac000000-0000-0000-0000-0000000000e1','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000b8',null,'SERVICE_NOT_AVAILABLE'),
      -- Attribution to a stylist from another business.
      ('19_FOREIGN_STAFF_REFUSED','ac000000-0000-0000-0000-0000000000e1','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000b4','ac000000-0000-0000-0000-0000000000d9','STAFF_NOT_IN_BUSINESS')
    ) as t(case_name, appt, biz, svc, staff, expected) loop
    begin
      perform booking.amend_appointment_services(jsonb_build_object(
        'appointmentId',r.appt,'businessId',r.biz,'action','add','serviceId',r.svc,'staffProfileId',r.staff,
        'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorRole','stylist'));
      insert into probe_results values (r.case_name,'FAIL: the change was accepted');
    exception when others then
      msg := sqlerrm;
      insert into probe_results values (r.case_name, case when msg like r.expected||'%' then 'PASS' else 'FAIL: '||msg end);
    end;
  end loop;
end $$;
select case_name as case, result from probe_results where case_name ~ '^1[5-9]_' order by 1;

-- ===========================================================================
-- 20-23. PAID = IMMUTABLE. ap3 gets a post-check-in line (so it has history),
--    is then paid, and from that moment no insert/update/delete of its lines
--    and no edit of its history succeeds. Paid history still reads back.
-- ===========================================================================
do $$
begin
  perform booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e3','businessId','ac000000-0000-0000-0000-000000000001',
    'action','add','serviceId','ac000000-0000-0000-0000-0000000000b4',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorRole','stylist'));
end $$;
update booking.appointments set status='paid' where id='ac000000-0000-0000-0000-0000000000e3';

do $$
begin
  update booking.appointment_services set price_amount = 1.00 where id='ac000000-0000-0000-0000-000000000031';
  insert into probe_results values ('20_PAID_LINE_UPDATE_REFUSED','FAIL: a paid line was repriced');
exception when others then
  insert into probe_results values ('20_PAID_LINE_UPDATE_REFUSED', case when sqlerrm like 'APPOINTMENT_PAID_IMMUTABLE%' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
do $$
begin
  delete from booking.appointment_services where id='ac000000-0000-0000-0000-000000000031';
  insert into probe_results values ('21_PAID_LINE_DELETE_REFUSED','FAIL: a paid line was deleted');
exception when others then
  insert into probe_results values ('21_PAID_LINE_DELETE_REFUSED', case when sqlerrm like 'APPOINTMENT_PAID_IMMUTABLE%' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
do $$
begin
  perform booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e3','businessId','ac000000-0000-0000-0000-000000000001',
    'action','add','serviceId','ac000000-0000-0000-0000-0000000000b3',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorRole','stylist'));
  insert into probe_results values ('22_PAID_ADD_REFUSED','FAIL: a service was added to a paid appointment');
exception when others then
  insert into probe_results values ('22_PAID_ADD_REFUSED', case when sqlerrm = 'APPOINTMENT_NOT_AMENDABLE:paid' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
select case_name as case, result from probe_results where case_name ~ '^2[0-2]_' order by 1;

select '23_PAID_HISTORY_STILL_READABLE' as case,
       case when (select count(*) from booking.appointment_service_changes where appointment_id='ac000000-0000-0000-0000-0000000000e3' and action='added') = 1
             and (select price_amount from booking.appointment_services where id='ac000000-0000-0000-0000-000000000031') = 100.00
       then 'PASS' else 'FAIL' end as result;

-- ===========================================================================
-- 24-25. HISTORY IS APPEND-ONLY. Neither an update nor a delete gets through.
-- ===========================================================================
do $$
begin
  update booking.appointment_service_changes set reason='rewritten' where id=(select value::uuid from probe_state where key='toner_change');
  insert into probe_results values ('24_HISTORY_UPDATE_REFUSED','FAIL: history was edited');
exception when others then
  insert into probe_results values ('24_HISTORY_UPDATE_REFUSED', case when sqlerrm like 'APPOINTMENT_SERVICE_HISTORY_APPEND_ONLY%' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
do $$
begin
  delete from booking.appointment_service_changes where id=(select value::uuid from probe_state where key='toner_change');
  insert into probe_results values ('25_HISTORY_DELETE_REFUSED','FAIL: history was deleted');
exception when others then
  insert into probe_results values ('25_HISTORY_DELETE_REFUSED', case when sqlerrm like 'APPOINTMENT_SERVICE_HISTORY_APPEND_ONLY%' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
select case_name as case, result from probe_results where case_name ~ '^2[4-5]_' order by 1;

-- ===========================================================================
-- 26. A CASCADE DELETE OF THE APPOINTMENT ITSELF STILL WORKS (demo seeds and
--     account deletion), even for a paid one with history.
-- ===========================================================================
do $$
begin
  delete from booking.appointments where id='ac000000-0000-0000-0000-0000000000e3';
  insert into probe_results values ('26_CASCADE_DELETE_ALLOWED',
    case when (select count(*) from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000e3') = 0
          and (select count(*) from booking.appointment_service_changes where appointment_id='ac000000-0000-0000-0000-0000000000e3') = 0
     then 'PASS' else 'FAIL: children survived the cascade' end);
exception when others then
  insert into probe_results values ('26_CASCADE_DELETE_ALLOWED','FAIL: '||sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='26_CASCADE_DELETE_ALLOWED';

-- ===========================================================================
-- 27. TWO STAFF, TWO ADDITIONS, BOTH SURVIVE. Sarah adds a Treatment to ap1
--     after Jane's Toner: distinct sequence numbers, nothing overwritten. (True
--     simultaneity is serialised by the FOR UPDATE lock in the function; this
--     proves the line-level semantics that make that lock sufficient — there is
--     no array to clobber.)
-- ===========================================================================
do $$
declare v jsonb;
begin
  v := booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e1','businessId','ac000000-0000-0000-0000-000000000001',
    'action','add','serviceId','ac000000-0000-0000-0000-0000000000b4','staffProfileId','ac000000-0000-0000-0000-0000000000d2',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f3','actorStaffProfileId','ac000000-0000-0000-0000-0000000000d2','actorRole','stylist'));
  insert into probe_state values ('treatment_line', v->>'lineId');
  insert into probe_results values ('27_TWO_STAFF_BOTH_ADDITIONS_SURVIVE',
    case when (select count(*) from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000e1' and status<>'cancelled') = 3
          and (select count(distinct sequence_no) from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000e1') = 5
          and (select assigned_staff_profile_id from booking.appointment_services where id=(v->>'lineId')::uuid) = 'ac000000-0000-0000-0000-0000000000d2'
          and (select count(distinct actor_user_profile_id) from booking.appointment_service_changes where appointment_id='ac000000-0000-0000-0000-0000000000e1') = 2
     then 'PASS' else 'FAIL' end);
exception when others then
  insert into probe_results values ('27_TWO_STAFF_BOTH_ADDITIONS_SURVIVE','FAIL: '||sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='27_TWO_STAFF_BOTH_ADDITIONS_SURVIVE';

-- ===========================================================================
-- 28-29. REASSIGN attribution; reassigning to the same stylist is a no-op.
-- ===========================================================================
do $$
declare v jsonb;
begin
  v := booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e1','businessId','ac000000-0000-0000-0000-000000000001',
    'action','reassign','lineId',(select value from probe_state where key='toner_line'),'staffProfileId','ac000000-0000-0000-0000-0000000000d2',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f1','actorRole','owner'));
  insert into probe_results values ('28_REASSIGN_RECORDED',
    case when (select assigned_staff_profile_id from booking.appointment_services where id=(select value::uuid from probe_state where key='toner_line')) = 'ac000000-0000-0000-0000-0000000000d2'
          and exists (select 1 from booking.appointment_service_changes c where c.id=(v->>'changeId')::uuid and c.action='reassigned'
                        and c.before->>'staffProfileId'='ac000000-0000-0000-0000-0000000000d1'
                        and c.after->>'staffProfileId'='ac000000-0000-0000-0000-0000000000d2'
                        and c.actor_role='owner')
     then 'PASS' else 'FAIL' end);
exception when others then
  insert into probe_results values ('28_REASSIGN_RECORDED','FAIL: '||sqlerrm);
end $$;
do $$
declare v jsonb;
begin
  v := booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e1','businessId','ac000000-0000-0000-0000-000000000001',
    'action','reassign','lineId',(select value from probe_state where key='toner_line'),'staffProfileId','ac000000-0000-0000-0000-0000000000d2',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f1','actorRole','owner'));
  insert into probe_results values ('29_REASSIGN_SAME_IS_NOOP',
    case when (v->>'alreadyApplied')::boolean
          and (select count(*) from booking.appointment_service_changes where appointment_id='ac000000-0000-0000-0000-0000000000e1' and action='reassigned') = 1
     then 'PASS' else 'FAIL: '||v::text end);
exception when others then
  insert into probe_results values ('29_REASSIGN_SAME_IS_NOOP','FAIL: '||sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name ~ '^2[8-9]_' order by 1;

-- ===========================================================================
-- 30. THE CHANGE HISTORY RECONSTRUCTS THE VISIT, in order, with actors.
-- ===========================================================================
select '30_HISTORY_RECONSTRUCTS_THE_VISIT' as case,
       case when (select string_agg(action, '>' order by created_at, change_no)
                  from booking.appointment_service_changes
                  where appointment_id='ac000000-0000-0000-0000-0000000000e1') = 'added>removed>replaced>added>reassigned'
       then 'PASS' else 'FAIL: '||coalesce((select string_agg(action, '>' order by created_at, change_no) from booking.appointment_service_changes where appointment_id='ac000000-0000-0000-0000-0000000000e1'),'<none>') end as result;

-- ===========================================================================
-- 31-34. RLS THROUGH POSTGREST'S EYES. Jane (assigned stylist) reads ap1's
--     history; Sarah (a stylist NOT on ap1) cannot; the anonymous role sees
--     nothing; and no authenticated token can write history or call the
--     amend function directly.
-- ===========================================================================
do $$
declare n integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','ac000000-0000-0000-0000-0000000000f2',true);
  select count(*) into n from booking.appointment_service_changes where appointment_id='ac000000-0000-0000-0000-0000000000e1';
  reset role;
  insert into probe_results values ('31_ASSIGNED_STYLIST_READS_HISTORY', case when n = 5 then 'PASS' else 'FAIL: saw '||n end);
exception when others then
  reset role;
  insert into probe_results values ('31_ASSIGNED_STYLIST_READS_HISTORY','FAIL: '||sqlerrm);
end $$;
do $$
declare n integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','ac000000-0000-0000-0000-0000000000f3',true);
  select count(*) into n from booking.appointment_service_changes where appointment_id='ac000000-0000-0000-0000-0000000000e1';
  reset role;
  insert into probe_results values ('32_OTHER_STYLIST_SEES_NOTHING', case when n = 0 then 'PASS' else 'FAIL: saw '||n end);
exception when others then
  reset role;
  insert into probe_results values ('32_OTHER_STYLIST_SEES_NOTHING','FAIL: '||sqlerrm);
end $$;
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','ac000000-0000-0000-0000-0000000000f1',true);
  insert into booking.appointment_service_changes (business_id,location_id,appointment_id,action,appointment_status_at_change)
  values ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e1','added','checked_in');
  reset role;
  insert into probe_results values ('33_AUTHENTICATED_CANNOT_WRITE_HISTORY','FAIL: an owner token inserted history directly');
exception when others then
  reset role;
  insert into probe_results values ('33_AUTHENTICATED_CANNOT_WRITE_HISTORY', case when sqlerrm ilike '%permission denied%' or sqlerrm ilike '%row-level security%' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','ac000000-0000-0000-0000-0000000000f1',true);
  perform booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e1','businessId','ac000000-0000-0000-0000-000000000001',
    'action','add','serviceId','ac000000-0000-0000-0000-0000000000b3','actorUserProfileId','ac000000-0000-0000-0000-0000000000f1','actorRole','owner'));
  reset role;
  insert into probe_results values ('34_AUTHENTICATED_CANNOT_CALL_AMEND','FAIL: the function ran under an authenticated token');
exception when others then
  reset role;
  insert into probe_results values ('34_AUTHENTICATED_CANNOT_CALL_AMEND', case when sqlerrm ilike '%permission denied%' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
select case_name as case, result from probe_results where case_name ~ '^3[1-4]_' order by 1;

select '35_FUNCTION_ACL' as case,
       case when not has_function_privilege('anon','booking.amend_appointment_services(jsonb)','execute')
             and not has_function_privilege('authenticated','booking.amend_appointment_services(jsonb)','execute')
             and has_function_privilege('service_role','booking.amend_appointment_services(jsonb)','execute')
             and not has_table_privilege('authenticated','booking.appointment_service_changes','insert')
             and not has_table_privilege('authenticated','booking.appointment_service_changes','update')
             and not has_table_privilege('authenticated','booking.appointment_service_changes','delete')
             and has_table_privilege('authenticated','booking.appointment_service_changes','select')
       then 'PASS' else 'FAIL' end as result;

-- ===========================================================================
-- 36. LAPSE INTELLIGENCE FOLLOWS THE PERFORMED SET. ap4's visit had Full Head
--     Colour booked; consultation replaced it with Half Head Highlights and
--     added a Toner. crm.client_service_history must report Half Head + Toner
--     — not the Full Head Colour the client never had.
-- ===========================================================================
do $$
begin
  perform booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000e4','businessId','ac000000-0000-0000-0000-000000000001',
    'action','replace','lineId','ac000000-0000-0000-0000-000000000041','serviceId','ac000000-0000-0000-0000-0000000000b5',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorRole','stylist'));
end $$;
select '36_LAPSE_HISTORY_IS_PERFORMED_ONLY' as case,
       case when (
         select string_agg(s->>'serviceName', ', ' order by s->>'serviceName')
         from crm.client_service_history('ac000000-0000-0000-0000-000000000001','Europe/London',array['ac000000-0000-0000-0000-0000000000c1']::uuid[]) h,
              jsonb_array_elements(h.visits) v,
              jsonb_array_elements(v->'services') s
       ) = 'Half Head Highlights, Toner'
       and (
         select service_rebooking_interval_days
         from crm.client_service_history('ac000000-0000-0000-0000-000000000001','Europe/London',array['ac000000-0000-0000-0000-0000000000c1']::uuid[])
       ) = 56
       then 'PASS' else 'FAIL: '||coalesce((
         select string_agg(s->>'serviceName', ', ' order by s->>'serviceName')
         from crm.client_service_history('ac000000-0000-0000-0000-000000000001','Europe/London',array['ac000000-0000-0000-0000-0000000000c1']::uuid[]) h,
              jsonb_array_elements(h.visits) v,
              jsonb_array_elements(v->'services') s),'<none>') end as result;

-- ===========================================================================
-- 37. UPSELL CO-OCCURRENCE (0103) ALREADY SKIPS status='cancelled' — a removed
--     line is not evidence that two services go together.
-- ===========================================================================
select '37_COOCCURRENCE_IGNORES_REMOVED_LINES' as case,
       case when not exists (
         select 1 from booking.appointment_services
         where appointment_id='ac000000-0000-0000-0000-0000000000e4' and status='cancelled'
       ) then 'FAIL: fixture has no removed line'
       when (select count(*) from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000e4' and status<>'cancelled') = 2
       then 'PASS' else 'FAIL' end as result;

-- ===========================================================================
-- 38. CONSTRAINTS. A post-check-in origin without added_at, and a removed_at on
--     a non-cancelled line, are both refused at the table.
-- ===========================================================================
do $$
begin
  insert into booking.appointment_services (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,origin)
  values ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e1','ac000000-0000-0000-0000-0000000000b3',99,'Toner',20,30,'post_checkin_add');
  insert into probe_results values ('38_ORIGIN_WITHOUT_ADDED_AT_REFUSED','FAIL: stored');
exception when check_violation then
  insert into probe_results values ('38_ORIGIN_WITHOUT_ADDED_AT_REFUSED','PASS');
when others then
  insert into probe_results values ('38_ORIGIN_WITHOUT_ADDED_AT_REFUSED','FAIL: '||sqlerrm);
end $$;
do $$
begin
  update booking.appointment_services set removed_at = now() where id=(select value::uuid from probe_state where key='treatment_line');
  insert into probe_results values ('39_REMOVED_AT_ON_LIVE_LINE_REFUSED','FAIL: stored');
exception when check_violation then
  insert into probe_results values ('39_REMOVED_AT_ON_LIVE_LINE_REFUSED','PASS');
when others then
  insert into probe_results values ('39_REMOVED_AT_ON_LIVE_LINE_REFUSED','FAIL: '||sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name ~ '^3[8-9]_' order by 1;

-- ===========================================================================
-- 40. THE PERMISSION REACHES EXISTING SYSTEM LEVELS, IDEMPOTENTLY. Businesses
--     that exist when 0110 runs are updated by its UPDATE; businesses created
--     afterwards receive the key from SYSTEM_SECURITY_LEVELS in @sheer/domain
--     (owner-security-levels.service ensures the system rows from that list).
--     Here a pre-0110-shaped level is seeded for the fixture business and the
--     migration's own statement is applied twice: the key appears once.
-- ===========================================================================
insert into core.security_levels (business_id, key, name, description, base_role, is_system, permissions)
values ('ac000000-0000-0000-0000-000000000001','stylist','Stylist','fixture','stylist',true,
        '["bookings.manage","crm.view","retail.record"]'::jsonb);
update core.security_levels
set permissions = permissions || '["bookings.services.modify_after_checkin"]'::jsonb
where is_system = true
  and key in ('owner', 'group_admin', 'manager', 'receptionist', 'stylist')
  and not (permissions ? 'bookings.services.modify_after_checkin');
update core.security_levels
set permissions = permissions || '["bookings.services.modify_after_checkin"]'::jsonb
where is_system = true
  and key in ('owner', 'group_admin', 'manager', 'receptionist', 'stylist')
  and not (permissions ? 'bookings.services.modify_after_checkin');
select '40_PERMISSION_SEED_IDEMPOTENT' as case,
       case when (select count(*) from core.security_levels sl, jsonb_array_elements_text(sl.permissions) p
                  where sl.business_id='ac000000-0000-0000-0000-000000000001' and sl.key='stylist'
                    and p = 'bookings.services.modify_after_checkin') = 1
       then 'PASS' else 'FAIL' end as result;

-- ===========================================================================
-- 41-42. THE TWO HALVES OF PAID-INSERT. ap4 is paid off after its history
--     exists. A signed-in OWNER posting a line straight at the table through
--     PostgREST is refused (0002's default privileges plus the owner ALL policy
--     would otherwise let a paid visit claim more than the frozen bill charged).
--     The trusted path is still open, because that is how a demo seed or a
--     backfill CONSTRUCTS an already-paid historical visit — the pattern
--     seed-upsell-demo.ts and friends use: insert the appointment as 'paid',
--     then its lines.
-- ===========================================================================
update booking.appointments set status='paid' where id='ac000000-0000-0000-0000-0000000000e4';

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','ac000000-0000-0000-0000-0000000000f1',true);
  insert into booking.appointment_services (business_id,location_id,appointment_id,service_id,assigned_staff_profile_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status,origin,added_at)
  values ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e4','ac000000-0000-0000-0000-0000000000b3','ac000000-0000-0000-0000-0000000000d1',9,'Sneaky Toner',20,30.00,'completed','post_checkin_add',now());
  reset role;
  insert into probe_results values ('41_PAID_INSERT_BY_CLIENT_ROLE_REFUSED','FAIL: an owner added a line to a paid visit');
exception when others then
  reset role;
  insert into probe_results values ('41_PAID_INSERT_BY_CLIENT_ROLE_REFUSED',
    case when sqlerrm like 'APPOINTMENT_PAID_IMMUTABLE%'
              or sqlerrm like '%row-level security%'
              -- Since the write boundary (0110 §4b) a client role has no INSERT
              -- privilege at all, so the refusal now lands one layer earlier.
              or sqlerrm like '%permission denied%'
         then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;

do $$
begin
  insert into booking.appointment_services (business_id,location_id,appointment_id,service_id,assigned_staff_profile_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status)
  values ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e4','ac000000-0000-0000-0000-0000000000b2','ac000000-0000-0000-0000-0000000000d1',8,'Backfilled Cut',45,50.00,'completed');
  insert into probe_results values ('42_PAID_INSERT_BY_TRUSTED_ROLE_ALLOWED','PASS');
exception when others then
  insert into probe_results values ('42_PAID_INSERT_BY_TRUSTED_ROLE_ALLOWED','FAIL: seeds and backfills cannot build a paid visit — '||sqlerrm);
end $$;

do $$
begin
  update booking.appointment_services set price_amount = 1.00 where id='ac000000-0000-0000-0000-000000000041';
  insert into probe_results values ('43_PAID_UPDATE_REFUSED_FOR_TRUSTED_ROLE_TOO','FAIL: a paid line was repriced');
exception when others then
  insert into probe_results values ('43_PAID_UPDATE_REFUSED_FOR_TRUSTED_ROLE_TOO',
    case when sqlerrm like 'APPOINTMENT_PAID_IMMUTABLE%' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
select case_name as case, result from probe_results where case_name ~ '^4[1-3]_' order by 1;

-- ===========================================================================
-- 44-47. THE MONEY QUESTION: performed services ARE the commission input.
--
--     ap10 is its own scenario so these cases do not depend on what earlier
--     cases did to ap1/ap4. It reproduces the brief's arithmetic exactly:
--
--       booked            Full Head Colour £100 (Jane) + Cut & Finish £50 (Jane)
--       consultation      remove the Cut, add a Toner £50 performed by SARAH
--       performed         Full Head Colour £100 (Jane) + Toner £50 (Sarah) = £150
--
--     The query below is the one payroll-inputs.service runs to build an
--     engine revenue line: appointment_services for the period's visits,
--     `status <> 'cancelled'`, attributed per line and falling back to the
--     appointment's stylist. There is no second revenue source to reconcile —
--     this is the same table the bill's roll-up is rebuilt from.
-- ===========================================================================
insert into booking.appointments (id,business_id,location_id,client_profile_id,assigned_staff_profile_id,status,scheduled_start_at,scheduled_end_at,check_in_at,occupied_ranges) values
 ('ac000000-0000-0000-0000-0000000000ea','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000c1','ac000000-0000-0000-0000-0000000000d1','checked_in',now()-interval '15 hours',now()-interval '14 hours',now()-interval '15 hours',tstzmultirange(tstzrange(now()-interval '15 hours',now()-interval '14 hours','[)')));

insert into booking.appointment_services (id,business_id,location_id,appointment_id,service_id,assigned_staff_profile_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status) values
 ('ac000000-0000-0000-0000-000000000101','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000ea','ac000000-0000-0000-0000-0000000000b1','ac000000-0000-0000-0000-0000000000d1',1,'Full Head Colour',60,100.00,'scheduled'),
 ('ac000000-0000-0000-0000-000000000102','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000ea','ac000000-0000-0000-0000-0000000000b2','ac000000-0000-0000-0000-0000000000d1',2,'Cut & Finish',45,50.00,'scheduled');

do $$
declare v jsonb;
begin
  -- Consultation: the cut is not happening, and Sarah does a toner instead.
  perform booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000ea','businessId','ac000000-0000-0000-0000-000000000001',
    'action','remove','lineId','ac000000-0000-0000-0000-000000000102',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorStaffProfileId','ac000000-0000-0000-0000-0000000000d1','actorRole','stylist',
    'reason','Not doing the cut today'));
  v := booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000ea','businessId','ac000000-0000-0000-0000-000000000001',
    'action','add','serviceId','ac000000-0000-0000-0000-0000000000b3',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f3','actorStaffProfileId','ac000000-0000-0000-0000-0000000000d2','actorRole','stylist',
    'staffProfileId','ac000000-0000-0000-0000-0000000000d2'));
  -- The toner is £30 in the catalogue; the brief's scenario prices it at £50.
  -- Repricing the LINE (not the catalogue) is what a price override would do,
  -- and keeps the arithmetic below the brief's own numbers.
  update booking.appointment_services set price_amount = 50.00 where id = (v->>'lineId')::uuid;
  insert into probe_state values ('ap10_toner_line', v->>'lineId');
end $$;

-- 44. Performed revenue = £150, so a stylist sitting on £1,700 before this
--     visit reaches £1,850 — not the £1,800 the booked list would have given.
select '44_PERFORMED_REVENUE_IS_THE_COMMISSION_INPUT' as case,
       case when (
         select coalesce(sum(l.price_amount),0)
         from booking.appointment_services l
         where l.appointment_id='ac000000-0000-0000-0000-0000000000ea' and l.status <> 'cancelled'
       ) = 150.00
       and 1700.00 + (
         select coalesce(sum(l.price_amount),0)
         from booking.appointment_services l
         where l.appointment_id='ac000000-0000-0000-0000-0000000000ea' and l.status <> 'cancelled'
       ) = 1850.00
       then 'PASS' else 'FAIL: performed total is '||(
         select coalesce(sum(l.price_amount),0) from booking.appointment_services l
         where l.appointment_id='ac000000-0000-0000-0000-0000000000ea' and l.status <> 'cancelled')::text end as result;

-- 45. Attribution is LINE-LEVEL: Jane keeps the colour, Sarah earns the toner.
select '45_REVENUE_ATTRIBUTION_IS_LINE_LEVEL' as case,
       case when (
         select string_agg(sp.display_name||'='||t.revenue::text, ', ' order by sp.display_name)
         from (
           select coalesce(l.assigned_staff_profile_id, a.assigned_staff_profile_id) as staff_profile_id,
                  sum(l.price_amount) as revenue
           from booking.appointment_services l
           join booking.appointments a on a.id = l.appointment_id
           where l.appointment_id='ac000000-0000-0000-0000-0000000000ea' and l.status <> 'cancelled'
           group by 1
         ) t
         join core.staff_profiles sp on sp.id = t.staff_profile_id
       ) = 'Jane=100.00, Sarah=50.00'
       then 'PASS' else 'FAIL: '||coalesce((
         select string_agg(sp.display_name||'='||t.revenue::text, ', ' order by sp.display_name)
         from (
           select coalesce(l.assigned_staff_profile_id, a.assigned_staff_profile_id) as staff_profile_id,
                  sum(l.price_amount) as revenue
           from booking.appointment_services l
           join booking.appointments a on a.id = l.appointment_id
           where l.appointment_id='ac000000-0000-0000-0000-0000000000ea' and l.status <> 'cancelled'
           group by 1
         ) t
         join core.staff_profiles sp on sp.id = t.staff_profile_id),'<none>') end as result;

-- 46. A line added and then taken off again earns nobody anything, and leaves
--     the totals exactly where they were.
do $$
declare v jsonb;
begin
  v := booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000ea','businessId','ac000000-0000-0000-0000-000000000001',
    'action','add','serviceId','ac000000-0000-0000-0000-0000000000b4',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorStaffProfileId','ac000000-0000-0000-0000-0000000000d1','actorRole','stylist'));
  perform booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000ea','businessId','ac000000-0000-0000-0000-000000000001',
    'action','remove','lineId',v->>'lineId',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorStaffProfileId','ac000000-0000-0000-0000-0000000000d1','actorRole','stylist',
    'reason','Client declined'));
end $$;
select '46_REMOVED_LINE_EARNS_NOBODY' as case,
       case when (
         select coalesce(sum(l.price_amount),0)
         from booking.appointment_services l
         where l.appointment_id='ac000000-0000-0000-0000-0000000000ea' and l.status <> 'cancelled'
       ) = 150.00
       -- ...while the row itself is still there, with its provenance intact.
       and exists (
         select 1 from booking.appointment_services l
         where l.appointment_id='ac000000-0000-0000-0000-0000000000ea'
           and l.service_name_snapshot='Treatment' and l.status='cancelled'
           and l.origin='post_checkin_add' and l.removal_reason='Client declined'
       )
       then 'PASS' else 'FAIL' end as result;

-- 47. Both questions, as structured data, after everything above: what was
--     booked, and what was performed.
select '47_BOOKED_AND_PERFORMED_BOTH_QUERYABLE' as case,
       case when (
         select string_agg(l.service_name_snapshot, ', ' order by l.sequence_no)
         from booking.appointment_services l
         where l.appointment_id='ac000000-0000-0000-0000-0000000000ea' and l.origin = 'booked'
       ) = 'Full Head Colour, Cut & Finish'
       and (
         select string_agg(l.service_name_snapshot, ', ' order by l.sequence_no)
         from booking.appointment_services l
         where l.appointment_id='ac000000-0000-0000-0000-0000000000ea' and l.status <> 'cancelled'
       ) = 'Full Head Colour, Toner'
       then 'PASS' else 'FAIL: booked=['||coalesce((
         select string_agg(l.service_name_snapshot, ', ' order by l.sequence_no)
         from booking.appointment_services l
         where l.appointment_id='ac000000-0000-0000-0000-0000000000ea' and l.origin='booked'),'')||'] performed=['||coalesce((
         select string_agg(l.service_name_snapshot, ', ' order by l.sequence_no)
         from booking.appointment_services l
         where l.appointment_id='ac000000-0000-0000-0000-0000000000ea' and l.status <> 'cancelled'),'')||']' end as result;

-- ===========================================================================
-- 48-53. T0 — THE ORIGINAL BOOKING SURVIVES A PRE-CHECK-IN EDIT.
--
--     The exact scenario Luke's requirement names:
--       T0  booked            Full Head Colour + Cut
--       T1  before check-in   Full Head Colour replaced by Half Head Colour
--       T2  after check-in    Cut removed, Toner added
--     After payment all three must be answerable from structured data.
-- ===========================================================================
insert into booking.appointments (id,business_id,location_id,client_profile_id,assigned_staff_profile_id,status,scheduled_start_at,scheduled_end_at,occupied_ranges) values
 ('ac000000-0000-0000-0000-0000000000eb','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000c1','ac000000-0000-0000-0000-0000000000d1','accepted',now()-interval '20 hours',now()-interval '19 hours',tstzmultirange(tstzrange(now()-interval '20 hours',now()-interval '19 hours','[)')));

-- T0: the booking as first created. One statement, so one snapshot.
insert into booking.appointment_services (business_id,location_id,appointment_id,service_id,assigned_staff_profile_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status) values
 ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000eb','ac000000-0000-0000-0000-0000000000b1','ac000000-0000-0000-0000-0000000000d1',1,'Full Head Colour',60,100.00,'scheduled'),
 ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000eb','ac000000-0000-0000-0000-0000000000b2','ac000000-0000-0000-0000-0000000000d1',2,'Cut & Finish',45,50.00,'scheduled');

select '48_T0_CAPTURED_AT_CREATION' as case,
       case when (select string_agg(e->>'serviceName', ', ' order by (e->>'sequenceNo')::int)
                  from booking.appointments a, jsonb_array_elements(a.original_services_snapshot) e
                  where a.id='ac000000-0000-0000-0000-0000000000eb') = 'Full Head Colour, Cut & Finish'
       then 'PASS' else 'FAIL: '||coalesce((select original_services_snapshot::text from booking.appointments where id='ac000000-0000-0000-0000-0000000000eb'),'<null>') end as result;

-- T1: the pre-check-in editor's delete + re-insert (replaceAppointmentServices).
delete from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000eb';
insert into booking.appointment_services (business_id,location_id,appointment_id,service_id,assigned_staff_profile_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status) values
 ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000eb','ac000000-0000-0000-0000-0000000000b5','ac000000-0000-0000-0000-0000000000d1',1,'Half Head Highlights',75,100.00,'scheduled'),
 ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000eb','ac000000-0000-0000-0000-0000000000b2','ac000000-0000-0000-0000-0000000000d1',2,'Cut & Finish',45,50.00,'scheduled');

select '49_T0_SURVIVES_THE_PRE_CHECKIN_EDIT' as case,
       case when (select string_agg(e->>'serviceName', ', ' order by (e->>'sequenceNo')::int)
                  from booking.appointments a, jsonb_array_elements(a.original_services_snapshot) e
                  where a.id='ac000000-0000-0000-0000-0000000000eb') = 'Full Head Colour, Cut & Finish'
       then 'PASS' else 'FAIL: the edit overwrote T0' end as result;

-- T2: arrive, then the consultation changes.
update booking.appointments set status='checked_in', check_in_at=now() where id='ac000000-0000-0000-0000-0000000000eb';
do $$
declare v jsonb;
begin
  perform booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000eb','businessId','ac000000-0000-0000-0000-000000000001',
    'action','remove','lineId',(select id from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000eb' and service_name_snapshot='Cut & Finish'),
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorRole','stylist'));
  v := booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000eb','businessId','ac000000-0000-0000-0000-000000000001',
    'action','add','serviceId','ac000000-0000-0000-0000-0000000000b3',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorRole','stylist'));
end $$;
-- ...and pay, which freezes everything.
update booking.appointments set status='paid' where id='ac000000-0000-0000-0000-0000000000eb';

select '50_ALL_THREE_ANSWERABLE_AFTER_PAYMENT' as case,
       case when (select string_agg(e->>'serviceName', ', ' order by (e->>'sequenceNo')::int)
                  from booking.appointments a, jsonb_array_elements(a.original_services_snapshot) e
                  where a.id='ac000000-0000-0000-0000-0000000000eb') = 'Full Head Colour, Cut & Finish'
        and (select string_agg(l.service_name_snapshot, ', ' order by l.sequence_no)
             from booking.appointment_services l
             where l.appointment_id='ac000000-0000-0000-0000-0000000000eb' and l.origin='booked') = 'Half Head Highlights, Cut & Finish'
        and (select string_agg(l.service_name_snapshot, ', ' order by l.sequence_no)
             from booking.appointment_services l
             where l.appointment_id='ac000000-0000-0000-0000-0000000000eb' and l.status <> 'cancelled') = 'Half Head Highlights, Toner'
       then 'PASS' else 'FAIL: original=['||coalesce((select string_agg(e->>'serviceName', ', ' order by (e->>'sequenceNo')::int) from booking.appointments a, jsonb_array_elements(a.original_services_snapshot) e where a.id='ac000000-0000-0000-0000-0000000000eb'),'')
                        ||'] booked=['||coalesce((select string_agg(l.service_name_snapshot, ', ' order by l.sequence_no) from booking.appointment_services l where l.appointment_id='ac000000-0000-0000-0000-0000000000eb' and l.origin='booked'),'')
                        ||'] performed=['||coalesce((select string_agg(l.service_name_snapshot, ', ' order by l.sequence_no) from booking.appointment_services l where l.appointment_id='ac000000-0000-0000-0000-0000000000eb' and l.status <> 'cancelled'),'')||']' end as result;

-- 51. The snapshot is write-once: not by the editor, not by an amendment, not by payment.
do $$
begin
  update booking.appointments set original_services_snapshot='[]'::jsonb where id='ac000000-0000-0000-0000-0000000000eb';
  insert into probe_results values ('51_T0_IS_WRITE_ONCE','FAIL: the original booking was rewritten');
exception when others then
  insert into probe_results values ('51_T0_IS_WRITE_ONCE',
    case when sqlerrm like 'ORIGINAL_BOOKING_IMMUTABLE%' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
select case_name as case, result from probe_results where case_name='51_T0_IS_WRITE_ONCE';

-- 52. NO FABRICATION. ap1 was created before the snapshot existed (its lines were
--     seeded straight in at 'checked_in'), so its original booking is unknown and
--     must stay unknown rather than being filled from the current set.
select '52_NO_FABRICATED_ORIGINAL' as case,
       case when (select original_services_snapshot is null from booking.appointments where id='ac000000-0000-0000-0000-0000000000e1')
       then 'PASS' else 'FAIL: an original booking was invented for a pre-0110 appointment' end as result;

-- 53. A line added AFTER arrival never becomes "the original booking".
select '53_POST_CHECKIN_ADD_IS_NOT_AN_ORIGINAL' as case,
       case when (select original_services_snapshot is null from booking.appointments from_appt where from_appt.id='ac000000-0000-0000-0000-0000000000e9')
       then 'PASS' else 'FAIL' end as result;

-- ===========================================================================
-- 54-58. PAID IMMUTABILITY, THE FULL MATRIX (the audit's fail-open).
--
--     A location-scoped manager used to be able to INSERT onto a PAID
--     appointment at ANOTHER location, because the guard's parent lookup was
--     SECURITY INVOKER and therefore RLS-filtered: an invisible parent read as
--     "no parent" and the guard fell through its cascade-delete branch. The
--     lookup now goes through the definer helper, and the client role has no
--     INSERT privilege at all — refused twice over.
-- ===========================================================================
insert into booking.appointments (id,business_id,location_id,client_profile_id,status,scheduled_start_at,scheduled_end_at,occupied_ranges) values
 ('ac000000-0000-0000-0000-0000000000ec','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a2','ac000000-0000-0000-0000-0000000000c1','paid',now()-interval '30 hours',now()-interval '29 hours',tstzmultirange(tstzrange(now()-interval '30 hours',now()-interval '29 hours','[)')));
-- Sarah manages Pinner (a1) only.
update core.user_memberships set role='manager' where user_profile_id='ac000000-0000-0000-0000-0000000000f3';

do $$
declare
  r record;
  msg text;
begin
  for r in select * from (values
      ('54_PAID_INSERT_SAME_LOCATION_REFUSED',  'ac000000-0000-0000-0000-0000000000e4','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-000000000001'),
      ('55_PAID_INSERT_CROSS_LOCATION_REFUSED', 'ac000000-0000-0000-0000-0000000000ec','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-000000000001'),
      ('56_PAID_INSERT_CROSS_BUSINESS_REFUSED', 'ac000000-0000-0000-0000-0000000000e7','ac000000-0000-0000-0000-0000000000a3','ac000000-0000-0000-0000-000000000002')
    ) as t(case_name, appt, loc, biz) loop
    begin
      set local role authenticated;
      perform set_config('request.jwt.claim.sub','ac000000-0000-0000-0000-0000000000f3',true);
      insert into booking.appointment_services (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status,origin,added_at)
      values (r.biz::uuid, r.loc::uuid, r.appt::uuid,'ac000000-0000-0000-0000-0000000000b3',77,'Injected',20,999.00,'completed','post_checkin_add',now());
      reset role;
      insert into probe_results values (r.case_name,'FAIL: a client role wrote onto a paid appointment');
    exception when others then
      reset role;
      msg := sqlerrm;
      insert into probe_results values (r.case_name,
        case when msg like 'APPOINTMENT_PAID_IMMUTABLE%' or msg like '%permission denied%' or msg like '%row-level security%'
             then 'PASS' else 'FAIL: '||msg end);
    end;
  end loop;
end $$;
select case_name as case, result from probe_results where case_name ~ '^5[4-6]_' order by 1;

-- 57. The TRIGGER alone still refuses the cross-location case, with the table
--     grant temporarily restored — so the guard does not depend on the grant.
grant insert on booking.appointment_services to authenticated;
grant execute on function booking.appointment_status_for_guard(uuid) to authenticated;
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','ac000000-0000-0000-0000-0000000000f3',true);
  insert into booking.appointment_services (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status,origin,added_at)
  values ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000ec','ac000000-0000-0000-0000-0000000000b3',78,'Injected',20,999.00,'completed','post_checkin_add',now());
  reset role;
  insert into probe_results values ('57_TRIGGER_ALONE_CLOSES_THE_FAIL_OPEN','FAIL: the trigger let an invisible-parent paid insert through');
exception when others then
  reset role;
  insert into probe_results values ('57_TRIGGER_ALONE_CLOSES_THE_FAIL_OPEN',
    case when sqlerrm like 'APPOINTMENT_PAID_IMMUTABLE%' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
revoke insert on booking.appointment_services from authenticated;
revoke execute on function booking.appointment_status_for_guard(uuid) from authenticated;
select case_name as case, result from probe_results where case_name='57_TRIGGER_ALONE_CLOSES_THE_FAIL_OPEN';

-- 58. The deliberate carve-out survives: a trusted seed still builds a paid visit.
do $$
begin
  insert into booking.appointment_services (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status)
  values ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a2','ac000000-0000-0000-0000-0000000000ec','ac000000-0000-0000-0000-0000000000b1',1,'Backfilled Colour',60,100.00,'completed');
  insert into probe_results values ('58_TRUSTED_SEED_INSERT_STILL_ALLOWED','PASS');
exception when others then
  insert into probe_results values ('58_TRUSTED_SEED_INSERT_STILL_ALLOWED','FAIL: seeds and backfills cannot build a paid visit — '||sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='58_TRUSTED_SEED_INSERT_STILL_ALLOWED';

-- ===========================================================================
-- 59-64. THE WRITE BOUNDARY. A signed-in user has no DML on the line table at
--     all, so every service change necessarily goes through the canonical
--     function — and therefore necessarily writes structured history. SELECT is
--     untouched.
-- ===========================================================================
do $$
declare
  r record;
  msg text;
begin
  for r in select * from (values
      ('59_DIRECT_INSERT_OWNER_DENIED',   'ac000000-0000-0000-0000-0000000000f1'),
      ('60_DIRECT_INSERT_MANAGER_DENIED', 'ac000000-0000-0000-0000-0000000000f3'),
      ('61_DIRECT_INSERT_STYLIST_DENIED', 'ac000000-0000-0000-0000-0000000000f2')
    ) as t(case_name, actor) loop
    begin
      set local role authenticated;
      perform set_config('request.jwt.claim.sub', r.actor, true);
      insert into booking.appointment_services (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status)
      values ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000e1','ac000000-0000-0000-0000-0000000000b3',79,'Bypass',20,250.00,'scheduled');
      reset role;
      insert into probe_results values (r.case_name,'FAIL: a signed-in user wrote the line table directly');
    exception when others then
      reset role;
      msg := sqlerrm;
      insert into probe_results values (r.case_name,
        case when msg like '%permission denied%' then 'PASS' else 'FAIL: '||msg end);
    end;
  end loop;
end $$;
select case_name as case, result from probe_results where case_name ~ '^(59|60|61)_' order by 1;

do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','ac000000-0000-0000-0000-0000000000f1',true);
  update booking.appointment_services set price_amount = 1.00 where appointment_id='ac000000-0000-0000-0000-0000000000e1';
  reset role;
  insert into probe_results values ('62_DIRECT_UPDATE_DENIED','FAIL: a signed-in owner repriced a line directly');
exception when others then
  reset role;
  insert into probe_results values ('62_DIRECT_UPDATE_DENIED',
    case when sqlerrm like '%permission denied%' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','ac000000-0000-0000-0000-0000000000f1',true);
  delete from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000e1';
  reset role;
  insert into probe_results values ('63_DIRECT_DELETE_DENIED','FAIL: a signed-in owner deleted a line directly');
exception when others then
  reset role;
  insert into probe_results values ('63_DIRECT_DELETE_DENIED',
    case when sqlerrm like '%permission denied%' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
select case_name as case, result from probe_results where case_name in ('62_DIRECT_UPDATE_DENIED','63_DIRECT_DELETE_DENIED') order by 1;

-- 64. Reads are untouched — the diary and the history endpoint still work.
do $$
declare v_count integer;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','ac000000-0000-0000-0000-0000000000f2',true);
  select count(*) into v_count from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000e1';
  reset role;
  insert into probe_results values ('64_SELECT_STILL_PERMITTED',
    case when v_count > 0 then 'PASS' else 'FAIL: RLS reads broke' end);
exception when others then
  reset role;
  insert into probe_results values ('64_SELECT_STILL_PERMITTED','FAIL: '||sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='64_SELECT_STILL_PERMITTED';

-- 65. AUDIT COMPLETENESS. Every line on the amended appointment that arrived
--     after check-in has a matching history row: a service change with no
--     structured history is now unreachable.
select '65_NO_CHANGE_WITHOUT_HISTORY' as case,
       case when not exists (
         select 1
         from booking.appointment_services l
         where l.appointment_id='ac000000-0000-0000-0000-0000000000eb'
           and l.origin <> 'booked'
           and not exists (
             select 1 from booking.appointment_service_changes c
             where c.appointment_service_id = l.id
           )
       )
       and (select count(*) from booking.appointment_service_changes where appointment_id='ac000000-0000-0000-0000-0000000000eb') = 2
       then 'PASS' else 'FAIL' end as result;

-- ===========================================================================
-- 66-75. FINAL ACCEPTANCE — one end-to-end scenario at the brief's own prices.
--
--     T0  created            Full Head Colour £95 + Cut & Finish £45
--     T1  before check-in    Full Head Colour replaced by Half Head Colour £75
--     check in
--     T2  after check-in     Cut removed; Toner £35 (Jane); Treatment £25 (Sarah)
--     complete, then pay
--
--     Expected: ORIGINAL = FHC + Cut · CHECK-IN = HHC + Cut ·
--     PERFORMED = HHC + Toner + Treatment · BILL = £135 · Jane £110 / Sarah £25.
--     A dedicated client (c9) keeps the lapse-history assertion unambiguous.
-- ===========================================================================
insert into core.client_profiles (id,business_id,primary_location_id,first_name,last_name) values
 ('ac000000-0000-0000-0000-0000000000c9','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','Acceptance','Client');

-- Catalogue at the brief's prices. bA is colour work (a category QLAB reads).
insert into booking.services (id,business_id,location_id,slug,name,estimated_duration_minutes,base_price,is_active,rebooking_nudge_enabled,rebooking_nudge_interval_days) values
 ('ac000000-0000-0000-0000-0000000000ba','ac000000-0000-0000-0000-000000000001',null,'ac-acc-fhc','Acceptance Full Head Colour',60,95.00,true,true,42),
 ('ac000000-0000-0000-0000-0000000000bb','ac000000-0000-0000-0000-000000000001',null,'ac-acc-cut','Acceptance Cut & Finish',45,45.00,true,true,35),
 ('ac000000-0000-0000-0000-0000000000bc','ac000000-0000-0000-0000-000000000001',null,'ac-acc-hhc','Acceptance Half Head Colour',75,75.00,true,true,56),
 ('ac000000-0000-0000-0000-0000000000bd','ac000000-0000-0000-0000-000000000001',null,'ac-acc-toner','Acceptance Toner',30,35.00,true,false,35),
 ('ac000000-0000-0000-0000-0000000000be','ac000000-0000-0000-0000-000000000001',null,'ac-acc-treat','Acceptance Treatment',20,25.00,true,false,35);

insert into booking.appointments (id,business_id,location_id,client_profile_id,assigned_staff_profile_id,status,scheduled_start_at,scheduled_end_at,occupied_ranges) values
 ('ac000000-0000-0000-0000-0000000000ed','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000c9','ac000000-0000-0000-0000-0000000000d1','accepted',now()-interval '30 hours',now()-interval '29 hours',tstzmultirange(tstzrange(now()-interval '30 hours',now()-interval '29 hours','[)')));

-- T0 — one statement, so one snapshot.
insert into booking.appointment_services (business_id,location_id,appointment_id,service_id,assigned_staff_profile_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status) values
 ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000ed','ac000000-0000-0000-0000-0000000000ba','ac000000-0000-0000-0000-0000000000d1',1,'Acceptance Full Head Colour',60,95.00,'scheduled'),
 ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000ed','ac000000-0000-0000-0000-0000000000bb','ac000000-0000-0000-0000-0000000000d1',2,'Acceptance Cut & Finish',45,45.00,'scheduled');

select '66_ACCEPTANCE_T0_CAPTURED' as case,
       case when (select string_agg(e->>'serviceName', ' + ' order by (e->>'sequenceNo')::int)
                  from booking.appointments a, jsonb_array_elements(a.original_services_snapshot) e
                  where a.id='ac000000-0000-0000-0000-0000000000ed') = 'Acceptance Full Head Colour + Acceptance Cut & Finish'
        and (select sum((e->>'priceAmount')::numeric)
             from booking.appointments a, jsonb_array_elements(a.original_services_snapshot) e
             where a.id='ac000000-0000-0000-0000-0000000000ed') = 140.00
       then 'PASS' else 'FAIL' end as result;

-- T1 — the pre-check-in editor replaces the whole list (delete + re-insert).
delete from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000ed';
insert into booking.appointment_services (business_id,location_id,appointment_id,service_id,assigned_staff_profile_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status) values
 ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000ed','ac000000-0000-0000-0000-0000000000bc','ac000000-0000-0000-0000-0000000000d1',1,'Acceptance Half Head Colour',75,75.00,'scheduled'),
 ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000ed','ac000000-0000-0000-0000-0000000000bb','ac000000-0000-0000-0000-0000000000d1',2,'Acceptance Cut & Finish',45,45.00,'scheduled');

update booking.appointments set status='checked_in', check_in_at=now() where id='ac000000-0000-0000-0000-0000000000ed';

-- T2 — consultation. Remove the cut, add a toner, add a treatment for Sarah.
do $$
declare v jsonb; v_cut uuid;
begin
  select id into v_cut from booking.appointment_services
   where appointment_id='ac000000-0000-0000-0000-0000000000ed' and service_name_snapshot='Acceptance Cut & Finish' and status <> 'cancelled';
  perform booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000ed','businessId','ac000000-0000-0000-0000-000000000001','action','remove','lineId',v_cut,
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorStaffProfileId','ac000000-0000-0000-0000-0000000000d1','actorRole','stylist','reason','Not today'));
  perform booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000ed','businessId','ac000000-0000-0000-0000-000000000001','action','add','serviceId','ac000000-0000-0000-0000-0000000000bd',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorStaffProfileId','ac000000-0000-0000-0000-0000000000d1','actorRole','stylist'));
  perform booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000ed','businessId','ac000000-0000-0000-0000-000000000001','action','add','serviceId','ac000000-0000-0000-0000-0000000000be',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f3','actorStaffProfileId','ac000000-0000-0000-0000-0000000000d2','actorRole','stylist','staffProfileId','ac000000-0000-0000-0000-0000000000d2'));
end $$;

-- Complete, then pay. A visit carries the client history.
update booking.appointments set status='awaiting_payment', completed_at=now() where id='ac000000-0000-0000-0000-0000000000ed';
insert into booking.visits (id,business_id,location_id,appointment_id,client_profile_id,primary_staff_profile_id,status,checked_in_at,started_at,completed_at,checkout_status,checkout_ready_at,source) values
 ('ac000000-0000-0000-0000-0000000000ee','ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000ed','ac000000-0000-0000-0000-0000000000c9','ac000000-0000-0000-0000-0000000000d1','awaiting_payment',now()-interval '30 hours',now()-interval '30 hours',now(),'awaiting_payment',now(),'appointment_completion');
update booking.appointments set status='paid' where id='ac000000-0000-0000-0000-0000000000ed';
update booking.visits set status='paid', paid_at=now(), checkout_status='paid' where id='ac000000-0000-0000-0000-0000000000ee';

-- 66-68. The three questions, from structured data only.
select '67_ACCEPTANCE_CHECKIN_BOOKED' as case,
       case when (select string_agg(service_name_snapshot,' + ' order by sequence_no)
                  from booking.appointment_services
                  where appointment_id='ac000000-0000-0000-0000-0000000000ed' and origin='booked')
                 = 'Acceptance Half Head Colour + Acceptance Cut & Finish'
       then 'PASS' else 'FAIL' end as result;

select '68_ACCEPTANCE_PERFORMED' as case,
       case when (select string_agg(service_name_snapshot,' + ' order by sequence_no)
                  from booking.appointment_services
                  where appointment_id='ac000000-0000-0000-0000-0000000000ed' and status <> 'cancelled')
                 = 'Acceptance Half Head Colour + Acceptance Toner + Acceptance Treatment'
       then 'PASS' else 'FAIL' end as result;

-- 69. The bill: the performed set totals £135 (the roll-up the API upserts).
select '69_ACCEPTANCE_BILL_135' as case,
       case when (select sum(price_amount) from booking.appointment_services
                  where appointment_id='ac000000-0000-0000-0000-0000000000ed' and status <> 'cancelled') = 135.00
       then 'PASS' else 'FAIL: '||(select coalesce(sum(price_amount),0) from booking.appointment_services
                  where appointment_id='ac000000-0000-0000-0000-0000000000ed' and status <> 'cancelled')::text end as result;

-- 70. Staff attribution and the commission input: Jane £110, Sarah £25, total £135.
select '70_ACCEPTANCE_ATTRIBUTION' as case,
       case when (
         select string_agg(sp.display_name||'='||t.rev::text, ', ' order by sp.display_name)
         from (select coalesce(l.assigned_staff_profile_id,a.assigned_staff_profile_id) sid, sum(l.price_amount) rev
               from booking.appointment_services l join booking.appointments a on a.id=l.appointment_id
               where l.appointment_id='ac000000-0000-0000-0000-0000000000ed' and l.status <> 'cancelled' group by 1) t
         join core.staff_profiles sp on sp.id=t.sid) = 'Jane=110.00, Sarah=25.00'
       then 'PASS' else 'FAIL: '||coalesce((
         select string_agg(sp.display_name||'='||t.rev::text, ', ' order by sp.display_name)
         from (select coalesce(l.assigned_staff_profile_id,a.assigned_staff_profile_id) sid, sum(l.price_amount) rev
               from booking.appointment_services l join booking.appointments a on a.id=l.appointment_id
               where l.appointment_id='ac000000-0000-0000-0000-0000000000ed' and l.status <> 'cancelled' group by 1) t
         join core.staff_profiles sp on sp.id=t.sid),'<none>') end as result;

-- 71. Client history is the PERFORMED set — the cut the client did not have is absent.
select '71_ACCEPTANCE_CLIENT_HISTORY' as case,
       case when (
         select string_agg(s->>'serviceName', ' + ' order by s->>'serviceName')
         from crm.client_service_history('ac000000-0000-0000-0000-000000000001','Europe/London',array['ac000000-0000-0000-0000-0000000000c9']::uuid[]) h,
              jsonb_array_elements(h.visits) v, jsonb_array_elements(v->'services') s
       ) = 'Acceptance Half Head Colour + Acceptance Toner + Acceptance Treatment'
       then 'PASS' else 'FAIL: '||coalesce((
         select string_agg(s->>'serviceName', ' + ' order by s->>'serviceName')
         from crm.client_service_history('ac000000-0000-0000-0000-000000000001','Europe/London',array['ac000000-0000-0000-0000-0000000000c9']::uuid[]) h,
              jsonb_array_elements(h.visits) v, jsonb_array_elements(v->'services') s),'<none>') end as result;

-- 72. QLAB context: the colour work actually performed is visible, the removed
--     cut is not. This is the same non-cancelled join colour-prep / formula use.
select '72_ACCEPTANCE_QLAB_SEES_PERFORMED_COLOUR' as case,
       case when exists (
              select 1 from booking.appointment_services l join booking.services s on s.id=l.service_id
              where l.appointment_id='ac000000-0000-0000-0000-0000000000ed' and l.status <> 'cancelled' and s.slug='ac-acc-hhc')
        and not exists (
              select 1 from booking.appointment_services l join booking.services s on s.id=l.service_id
              where l.appointment_id='ac000000-0000-0000-0000-0000000000ed' and l.status <> 'cancelled' and s.slug='ac-acc-cut')
       then 'PASS' else 'FAIL' end as result;

-- 73. Provenance is structured end to end: T0 snapshot, T1 origins, T2 origins,
--     the removed line with its actor, and one history row per post-arrival change.
select '73_ACCEPTANCE_PROVENANCE_STRUCTURED' as case,
       case when (select original_services_snapshot is not null from booking.appointments where id='ac000000-0000-0000-0000-0000000000ed')
        and (select count(*) from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000ed' and origin='booked') = 2
        and (select count(*) from booking.appointment_services where appointment_id='ac000000-0000-0000-0000-0000000000ed' and origin='post_checkin_add') = 2
        and (select count(*) from booking.appointment_services
             where appointment_id='ac000000-0000-0000-0000-0000000000ed' and status='cancelled' and removed_by_user_profile_id='ac000000-0000-0000-0000-0000000000f2') = 1
        and (select count(*) from booking.appointment_service_changes where appointment_id='ac000000-0000-0000-0000-0000000000ed') = 3
       then 'PASS' else 'FAIL' end as result;

-- 74. PAID: a further normal service mutation is refused.
do $$
begin
  perform booking.amend_appointment_services(jsonb_build_object(
    'appointmentId','ac000000-0000-0000-0000-0000000000ed','businessId','ac000000-0000-0000-0000-000000000001','action','add','serviceId','ac000000-0000-0000-0000-0000000000bd',
    'actorUserProfileId','ac000000-0000-0000-0000-0000000000f2','actorRole','stylist'));
  insert into probe_results values ('74_ACCEPTANCE_PAID_MUTATION_REFUSED','FAIL: a paid visit accepted another service');
exception when others then
  insert into probe_results values ('74_ACCEPTANCE_PAID_MUTATION_REFUSED',
    case when sqlerrm like 'APPOINTMENT_NOT_AMENDABLE:paid%' then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
select case_name as case, result from probe_results where case_name='74_ACCEPTANCE_PAID_MUTATION_REFUSED';

-- 75. DIRECT POSTGREST: a signed-in user cannot touch the line table at all.
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','ac000000-0000-0000-0000-0000000000f2',true);
  insert into booking.appointment_services (business_id,location_id,appointment_id,service_id,sequence_no,service_name_snapshot,duration_minutes,price_amount,status)
  values ('ac000000-0000-0000-0000-000000000001','ac000000-0000-0000-0000-0000000000a1','ac000000-0000-0000-0000-0000000000ed','ac000000-0000-0000-0000-0000000000bd',9,'Sneak',30,35.00,'completed');
  reset role;
  insert into probe_results values ('75_ACCEPTANCE_DIRECT_WRITE_REFUSED','FAIL: a signed-in user inserted a line');
exception when others then
  reset role;
  insert into probe_results values ('75_ACCEPTANCE_DIRECT_WRITE_REFUSED',
    case when sqlerrm like '%permission denied%' or sqlerrm like '%row-level security%' or sqlerrm like 'APPOINTMENT_PAID_IMMUTABLE%'
    then 'PASS' else 'FAIL: '||sqlerrm end);
end $$;
select case_name as case, result from probe_results where case_name='75_ACCEPTANCE_DIRECT_WRITE_REFUSED';

select 'SUMMARY' as case,
       (select count(*) from probe_results where result = 'PASS')||' recorded PASS, '||
       (select count(*) from probe_results where result <> 'PASS')||' recorded FAIL (plus the inline cases above)' as result;

rollback;
