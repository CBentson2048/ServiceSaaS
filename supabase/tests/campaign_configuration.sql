-- campaign_configuration.sql — behavioural suite for migration 0104.
--
-- WHY THIS FILE EXISTS. The Jest suites stub the Supabase client, so they prove
-- only that the SERVICES ask for the right things. They cannot prove that the
-- database itself refuses a second run of a campaign on the same salon-local day,
-- that comms.claim_campaign_recipient really is atomic (that a second claimer of a
-- queued identity gets NOTHING back), that a cancelled appointment cannot inflate
-- a loyalty milestone, that a VOIDED bill is excluded from spend, that the leap-day
-- rule in SQL agrees with the one in TypeScript, or that a manager querying
-- comms.campaigns directly through PostgREST with their own token sees nothing.
-- This file is that proof, and it runs the constraints, the functions and the
-- policies for real.
--
-- 32 numbered cases. Read the RESULT column of each; every one must read PASS.
--
-- Run against a SCRATCH database that has every migration through 0104 applied:
--   psql -d <scratch> -f supabase/tests/campaign_configuration.sql
--
-- The whole suite runs inside one transaction that is rolled back at the end, so
-- it leaves no fixture rows behind and is re-runnable. Every expected failure runs
-- inside a plpgsql block whose exception handler records the verdict, so the
-- rejected write is undone while the evidence that it WAS rejected survives. A
-- savepoint/rollback probe would prove nothing here: the rollback removes the row
-- whether the constraint rejected it or accepted it happily.
--
-- HOW THE RLS CASES WORK. `set local role authenticated` plus
-- `set_config('request.jwt.claim.sub', <user id>, true)` is exactly what PostgREST
-- does per request, and public.current_user_id() reads auth.uid() which reads that
-- claim. So these cases exercise the real policies as the real role. Role is always
-- reset before recording a verdict, because the temp results table is not readable
-- by `authenticated`.

\set ON_ERROR_STOP off
\pset pager off

begin;

-- ---------------------------------------------------------------------------
-- Fixtures. 'ca' prefix, hex-only UUIDs, distinct from every other suite.
--
-- Two businesses so cross-tenant leakage has something to leak to.
-- ---------------------------------------------------------------------------
insert into core.businesses (id,name,slug,timezone) values
 ('ca000000-0000-0000-0000-000000000001','Campaign Salon','campaign-salon','Europe/London'),
 ('ca000000-0000-0000-0000-000000000002','Rival Campaigns','rival-campaigns','Europe/London');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('ca000000-0000-0000-0000-0000000000a1','ca000000-0000-0000-0000-000000000001','K1','Primrose Hill','ca-primrose','1 Regents Park Rd','London','NW1 8UG','Europe/London'),
 ('ca000000-0000-0000-0000-0000000000a2','ca000000-0000-0000-0000-000000000001','K2','Pinner','ca-pinner','2 High St','Pinner','HA5 1AA','Europe/London'),
 ('ca000000-0000-0000-0000-0000000000a3','ca000000-0000-0000-0000-000000000002','K3','Rival','ca-rival','3 High St','Watford','WD1 1AA','Europe/London');

insert into auth.users (id,email) values
 ('ca000000-0000-0000-0000-0000000000f1'::uuid,'owner@ca.example'),
 ('ca000000-0000-0000-0000-0000000000f2'::uuid,'manager@ca.example'),
 ('ca000000-0000-0000-0000-0000000000f3'::uuid,'rival@ca.example');

insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name,is_active) values
 ('ca000000-0000-0000-0000-0000000000f1','owner@ca.example','Olive Owner','Olive','Owner','Olive',true),
 ('ca000000-0000-0000-0000-0000000000f2','manager@ca.example','Mo Manager','Mo','Manager','Mo',true),
 ('ca000000-0000-0000-0000-0000000000f3','rival@ca.example','Ray Rival','Ray','Rival','Ray',true);

insert into core.user_memberships (business_id,location_id,user_profile_id,role,status,activated_at) values
 ('ca000000-0000-0000-0000-000000000001',null,'ca000000-0000-0000-0000-0000000000f1','owner','active',now()),
 ('ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1','ca000000-0000-0000-0000-0000000000f2','manager','active',now()),
 ('ca000000-0000-0000-0000-000000000002',null,'ca000000-0000-0000-0000-0000000000f3','owner','active',now());

-- Clients.
--   d1 Jane   — 29 Feb birthday, the leap-day case.
--   d2 Olivia — 14 July birthday, the ordinary case.
--   d3 Mia    — no birthday recorded at all; must never be inferred.
--   d4 Rhona  — the rival business's client; must be unreachable.
insert into core.client_profiles
 (id,business_id,primary_location_id,first_name,last_name,email,phone,marketing_opt_in,date_of_birth) values
 ('ca000000-0000-0000-0000-0000000000d1','ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1','Jane','Leap','jane@ca.example','+447700900101',true,'1992-02-29'),
 ('ca000000-0000-0000-0000-0000000000d2','ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1','Olivia','July','olivia@ca.example','+447700900102',true,'1990-07-14'),
 ('ca000000-0000-0000-0000-0000000000d3','ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a2','Mia','Nodob','mia@ca.example','+447700900103',false,null),
 ('ca000000-0000-0000-0000-0000000000d4','ca000000-0000-0000-0000-000000000002','ca000000-0000-0000-0000-0000000000a3','Rhona','Rival','rhona@ca.example','+447700900104',true,'1990-07-14');

create temporary table probe_results (case_name text primary key, result text) on commit drop;

-- ---------------------------------------------------------------------------
-- Visit / bill history for the loyalty metric cases.
--
-- Hand-countable on purpose:
--   Jane (d1):  6 PAID visits on 6 distinct dates      -> completed_visits = 6
--               2 visits on ONE date (colour + a cut)  -> still ONE visit
--               1 CANCELLED visit                      -> must not count
--               3 paid bills of £100 + 1 VOIDED £500   -> total_spend = 30000p
--   Olivia (d2): 2 paid visits                         -> completed_visits = 2
-- ---------------------------------------------------------------------------
do $$
declare
  i integer;
  vid uuid;
begin
  -- Jane: 6 attended visits on 6 distinct dates.
  for i in 1..6 loop
    vid := ('ca000000-0000-0000-0000-00000000' || lpad(to_hex(8192 + i), 4, '0'))::uuid;
    insert into booking.visits
      (id,business_id,location_id,client_profile_id,status,checked_in_at,started_at,completed_at)
    values
      (vid,'ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1',
       'ca000000-0000-0000-0000-0000000000d1','paid',
       now() - (i * 42 || ' days')::interval,
       now() - (i * 42 || ' days')::interval,
       now() - (i * 42 || ' days')::interval);
  end loop;

  -- A SECOND visit on the same salon-local date as the most recent one. Colour
  -- and a cut on one Tuesday is ONE visit, not two.
  insert into booking.visits
    (id,business_id,location_id,client_profile_id,status,checked_in_at,started_at,completed_at)
  values
    ('ca000000-0000-0000-0000-000000009001','ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1',
     'ca000000-0000-0000-0000-0000000000d1','paid',
     now() - interval '42 days' + interval '3 hours',
     now() - interval '42 days' + interval '3 hours',
     now() - interval '42 days' + interval '3 hours');

  -- A cancelled visit. Must not count towards any milestone.
  insert into booking.visits
    (id,business_id,location_id,client_profile_id,status,checked_in_at,completed_at)
  values
    ('ca000000-0000-0000-0000-000000009002','ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1',
     'ca000000-0000-0000-0000-0000000000d1','cancelled', now() - interval '10 days', null);

  -- Olivia: 2 attended visits.
  for i in 1..2 loop
    vid := ('ca000000-0000-0000-0000-00000000' || lpad(to_hex(9216 + i), 4, '0'))::uuid;
    insert into booking.visits
      (id,business_id,location_id,client_profile_id,status,checked_in_at,started_at,completed_at)
    values
      (vid,'ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1',
       'ca000000-0000-0000-0000-0000000000d2','paid',
       now() - (i * 30 || ' days')::interval,
       now() - (i * 30 || ' days')::interval,
       now() - (i * 30 || ' days')::interval);
  end loop;
end $$;

-- Bills. Three settled at £100 each, one VOIDED at £500.
insert into billing.bills
 (id,business_id,location_id,visit_id,client_profile_id,bill_number,status,net_cents,tax_cents,gross_cents,occurred_at) values
 ('ca000000-0000-0000-0000-00000000e001','ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1','ca000000-0000-0000-0000-000000002001','ca000000-0000-0000-0000-0000000000d1',1,'paid',10000,0,10000,now() - interval '42 days'),
 ('ca000000-0000-0000-0000-00000000e002','ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1','ca000000-0000-0000-0000-000000002002','ca000000-0000-0000-0000-0000000000d1',2,'paid',10000,0,10000,now() - interval '84 days'),
 ('ca000000-0000-0000-0000-00000000e003','ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1','ca000000-0000-0000-0000-000000002003','ca000000-0000-0000-0000-0000000000d1',3,'paid',10000,0,10000,now() - interval '126 days'),
 ('ca000000-0000-0000-0000-00000000e004','ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1','ca000000-0000-0000-0000-000000002004','ca000000-0000-0000-0000-0000000000d1',4,'voided',50000,0,50000,now() - interval '168 days');

-- The campaigns under test.
insert into comms.campaigns
 (id,business_id,location_id,campaign_type,name,status,channel,message_template,send_at_local_hour,config) values
 ('ca000000-0000-0000-0000-0000000000c1','ca000000-0000-0000-0000-000000000001',null,'birthday','Birthday treat','active','auto','Happy birthday {{first_name}}!',10,'{"daysBefore":0}'),
 ('ca000000-0000-0000-0000-0000000000c2','ca000000-0000-0000-0000-000000000001',null,'loyalty_milestone','Loyal 6','active','auto','Thank you {{first_name}}!',10,'{"metric":"completed_visits","threshold":6}'),
 ('ca000000-0000-0000-0000-0000000000c3','ca000000-0000-0000-0000-000000000002',null,'birthday','Rival birthday','active','auto','Hi {{first_name}}',10,'{"daysBefore":0}');

-- ===========================================================================
-- 1. NEW CAMPAIGNS DEFAULT TO DRAFT. Configuring one can never send.
-- ===========================================================================
insert into comms.campaigns (business_id,campaign_type,name,message_template)
values ('ca000000-0000-0000-0000-000000000001','promotion','Default check','Hi {{first_name}}');
select '01_DEFAULT_STATUS_IS_DRAFT' as case,
       case when (select status from comms.campaigns where name='Default check') = 'draft'
            then 'PASS' else 'FAIL: default status was not draft' end as result;

-- ===========================================================================
-- 2. DEFAULT CHANNEL IS AUTO — WhatsApp-first is preserved unless chosen otherwise.
-- ===========================================================================
select '02_DEFAULT_CHANNEL_IS_AUTO' as case,
       case when (select channel from comms.campaigns where name='Default check') = 'auto'
            then 'PASS' else 'FAIL: default channel was not auto' end as result;

-- ===========================================================================
-- 3. SEND HOUR IS BOUNDED — the quiet-hours guard. 03:00 must be refused.
-- ===========================================================================
do $$
begin
  insert into comms.campaigns (business_id,campaign_type,name,message_template,send_at_local_hour)
  values ('ca000000-0000-0000-0000-000000000001','promotion','Overnight','Hi',3);
  insert into probe_results values ('03_QUIET_HOURS_ENFORCED','FAIL: a 03:00 send hour was accepted');
exception when check_violation then
  insert into probe_results values ('03_QUIET_HOURS_ENFORCED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='03_QUIET_HOURS_ENFORCED';

do $$
begin
  insert into comms.campaigns (business_id,campaign_type,name,message_template,send_at_local_hour)
  values ('ca000000-0000-0000-0000-000000000001','promotion','Late night','Hi',23);
  insert into probe_results values ('04_LATE_SEND_HOUR_REJECTED','FAIL: a 23:00 send hour was accepted');
exception when check_violation then
  insert into probe_results values ('04_LATE_SEND_HOUR_REJECTED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='04_LATE_SEND_HOUR_REJECTED';

-- ===========================================================================
-- 5. UNKNOWN CAMPAIGN TYPE REJECTED. The four approved types are the only ones.
-- ===========================================================================
do $$
begin
  insert into comms.campaigns (business_id,campaign_type,name,message_template)
  values ('ca000000-0000-0000-0000-000000000001','abandoned_cart','Bad type','Hi');
  insert into probe_results values ('05_UNKNOWN_TYPE_REJECTED','FAIL: an unapproved campaign type was accepted');
exception when check_violation then
  insert into probe_results values ('05_UNKNOWN_TYPE_REJECTED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='05_UNKNOWN_TYPE_REJECTED';

-- ===========================================================================
-- 6. EMPTY MESSAGE REJECTED at the database, not only in the DTO.
-- ===========================================================================
do $$
begin
  insert into comms.campaigns (business_id,campaign_type,name,message_template)
  values ('ca000000-0000-0000-0000-000000000001','promotion','Empty message','   ');
  insert into probe_results values ('06_EMPTY_TEMPLATE_REJECTED','FAIL: a blank template was accepted');
exception when check_violation then
  insert into probe_results values ('06_EMPTY_TEMPLATE_REJECTED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='06_EMPTY_TEMPLATE_REJECTED';

-- ===========================================================================
-- 7. DUPLICATE CAMPAIGN NAME IN SCOPE REJECTED. Two identical birthday
--    campaigns would each message the same client.
-- ===========================================================================
do $$
begin
  insert into comms.campaigns (business_id,location_id,campaign_type,name,status,message_template)
  values ('ca000000-0000-0000-0000-000000000001',null,'birthday','birthday TREAT','draft','Hi');
  insert into probe_results values ('07_DUPLICATE_NAME_REJECTED','FAIL: a duplicate campaign name was accepted');
exception when unique_violation then
  insert into probe_results values ('07_DUPLICATE_NAME_REJECTED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='07_DUPLICATE_NAME_REJECTED';

-- ===========================================================================
-- 8. A BUSINESS-WIDE AND A LOCATION-SPECIFIC CAMPAIGN MAY COEXIST.
--    NULLS NOT DISTINCT must collide the business-wide row with itself only.
-- ===========================================================================
insert into comms.campaigns (business_id,location_id,campaign_type,name,message_template)
values ('ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1','birthday','Birthday treat','Hi');
select '08_SCOPED_DUPLICATE_ALLOWED' as case,
       case when (select count(*) from comms.campaigns
                   where business_id='ca000000-0000-0000-0000-000000000001'
                     and campaign_type='birthday' and lower(btrim(name))='birthday treat') = 2
            then 'PASS' else 'FAIL: business-wide + location campaigns did not coexist' end as result;

-- ===========================================================================
-- 9. ARCHIVED CAMPAIGNS DO NOT BLOCK THE NAME. The index is partial on
--    status <> 'archived', so a retired campaign's name is reusable.
-- ===========================================================================
do $$
begin
  update comms.campaigns set status='archived'
   where business_id='ca000000-0000-0000-0000-000000000001'
     and campaign_type='birthday' and location_id='ca000000-0000-0000-0000-0000000000a1';
  insert into comms.campaigns (business_id,location_id,campaign_type,name,message_template)
  values ('ca000000-0000-0000-0000-000000000001','ca000000-0000-0000-0000-0000000000a1','birthday','Birthday treat','Hi again');
  insert into probe_results values ('09_ARCHIVED_NAME_REUSABLE','PASS');
exception when unique_violation then
  insert into probe_results values ('09_ARCHIVED_NAME_REUSABLE','FAIL: an archived campaign blocked its own name');
end $$;
select case_name as case, result from probe_results where case_name='09_ARCHIVED_NAME_REUSABLE';

-- ===========================================================================
-- 10. THE RUN GUARD. A campaign is evaluated at most ONCE per salon-local day.
--     This is the cross-instance concurrency guard: a second evaluator's insert
--     must raise 23505 rather than starting a second run.
-- ===========================================================================
insert into comms.campaign_runs (id,campaign_id,business_id,run_local_date,status)
values ('ca000000-0000-0000-0000-00000000b001','ca000000-0000-0000-0000-0000000000c1','ca000000-0000-0000-0000-000000000001','2026-09-01','running');

do $$
begin
  insert into comms.campaign_runs (campaign_id,business_id,run_local_date,status)
  values ('ca000000-0000-0000-0000-0000000000c1','ca000000-0000-0000-0000-000000000001','2026-09-01','running');
  insert into probe_results values ('10_ONE_RUN_PER_LOCAL_DAY','FAIL: a second run for the same day was accepted');
exception when unique_violation then
  insert into probe_results values ('10_ONE_RUN_PER_LOCAL_DAY','PASS');
end $$;
select case_name as case, result from probe_results where case_name='10_ONE_RUN_PER_LOCAL_DAY';

-- ===========================================================================
-- 11. A DIFFERENT DAY IS A DIFFERENT RUN.
-- ===========================================================================
do $$
begin
  insert into comms.campaign_runs (campaign_id,business_id,run_local_date,status)
  values ('ca000000-0000-0000-0000-0000000000c1','ca000000-0000-0000-0000-000000000001','2026-09-02','running');
  insert into probe_results values ('11_NEXT_DAY_RUNS_AGAIN','PASS');
exception when unique_violation then
  insert into probe_results values ('11_NEXT_DAY_RUNS_AGAIN','FAIL: the next day was blocked');
end $$;
select case_name as case, result from probe_results where case_name='11_NEXT_DAY_RUNS_AGAIN';

-- ===========================================================================
-- 12. THE ATOMIC CLAIM. The first caller owns the identity.
-- ===========================================================================
select '12_FIRST_CLAIM_WINS' as case,
       case when (select count(*) from comms.claim_campaign_recipient(
                    'ca000000-0000-0000-0000-0000000000c1',
                    'ca000000-0000-0000-0000-000000000001',
                    'ca000000-0000-0000-0000-00000000b001',
                    'ca000000-0000-0000-0000-0000000000d1',
                    'campaign:c1:birthday:d1:2026','Birthday today')) = 1
            then 'PASS' else 'FAIL: the first claim did not return a row' end as result;

-- ===========================================================================
-- 13. A CLAIMED-BUT-UNSENT IDENTITY IS STILL RE-OFFERABLE. A crash between
--     claiming and enqueueing must not retire a client forever.
-- ===========================================================================
select '13_UNSENT_CLAIM_REOFFERED' as case,
       case when (select count(*) from comms.claim_campaign_recipient(
                    'ca000000-0000-0000-0000-0000000000c1',
                    'ca000000-0000-0000-0000-000000000001',
                    'ca000000-0000-0000-0000-00000000b001',
                    'ca000000-0000-0000-0000-0000000000d1',
                    'campaign:c1:birthday:d1:2026','Birthday today')) = 1
            then 'PASS' else 'FAIL: an unsent claim was not re-offered' end as result;

-- ===========================================================================
-- 14. ONCE QUEUED, THE IDENTITY IS FINAL. This is the single most important
--     case in the file: a second claimer of a QUEUED identity gets NO ROW, and
--     that is what prevents a duplicate WhatsApp/SMS/email.
-- ===========================================================================
select comms.settle_campaign_recipient(
  (select id from comms.campaign_recipients where dedupe_key='campaign:c1:birthday:d1:2026'),
  'queued', null, null, 'whatsapp');

select '14_QUEUED_IDENTITY_IS_FINAL' as case,
       case when (select count(*) from comms.claim_campaign_recipient(
                    'ca000000-0000-0000-0000-0000000000c1',
                    'ca000000-0000-0000-0000-000000000001',
                    'ca000000-0000-0000-0000-00000000b001',
                    'ca000000-0000-0000-0000-0000000000d1',
                    'campaign:c1:birthday:d1:2026','Birthday today')) = 0
            then 'PASS' else 'FAIL: a queued identity was claimed a second time' end as result;

-- ===========================================================================
-- 15. AND STILL ONLY ONE ROW EXISTS. The claim never accumulates rows.
-- ===========================================================================
select '15_ONE_ROW_PER_IDENTITY' as case,
       case when (select count(*) from comms.campaign_recipients
                   where campaign_id='ca000000-0000-0000-0000-0000000000c1'
                     and dedupe_key='campaign:c1:birthday:d1:2026') = 1
            then 'PASS' else 'FAIL: duplicate recipient rows for one identity' end as result;

-- ===========================================================================
-- 16. THE UNIQUE INDEX IS THE BACKSTOP. Even a direct insert is refused.
-- ===========================================================================
do $$
begin
  insert into comms.campaign_recipients
    (campaign_id,business_id,client_profile_id,dedupe_key,status)
  values ('ca000000-0000-0000-0000-0000000000c1','ca000000-0000-0000-0000-000000000001',
          'ca000000-0000-0000-0000-0000000000d1','campaign:c1:birthday:d1:2026','queued');
  insert into probe_results values ('16_IDENTITY_INDEX_ENFORCED','FAIL: a duplicate identity was inserted directly');
exception when unique_violation then
  insert into probe_results values ('16_IDENTITY_INDEX_ENFORCED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='16_IDENTITY_INDEX_ENFORCED';

-- ===========================================================================
-- 17. A SUPPRESSED IDENTITY IS RE-OFFERED. Consent granted tomorrow must be
--     able to produce a send tomorrow.
-- ===========================================================================
select comms.claim_campaign_recipient(
  'ca000000-0000-0000-0000-0000000000c1','ca000000-0000-0000-0000-000000000001',
  'ca000000-0000-0000-0000-00000000b001','ca000000-0000-0000-0000-0000000000d2',
  'campaign:c1:birthday:d2:2026','Birthday today');
select comms.settle_campaign_recipient(
  (select id from comms.campaign_recipients where dedupe_key='campaign:c1:birthday:d2:2026'),
  'suppressed','client has not opted in to marketing',null,null);

select '17_SUPPRESSED_IDENTITY_REOFFERED' as case,
       case when (select count(*) from comms.claim_campaign_recipient(
                    'ca000000-0000-0000-0000-0000000000c1','ca000000-0000-0000-0000-000000000001',
                    'ca000000-0000-0000-0000-00000000b001','ca000000-0000-0000-0000-0000000000d2',
                    'campaign:c1:birthday:d2:2026','Birthday today')) = 1
            then 'PASS' else 'FAIL: a suppressed identity was not re-offered' end as result;

-- ===========================================================================
-- 18. A DIFFERENT MILESTONE IS A DIFFERENT IDENTITY. Reaching 20 visits after
--     10 must be a new, sendable message.
-- ===========================================================================
select '18_DIFFERENT_MILESTONE_IS_SENDABLE' as case,
       case when (select count(*) from comms.claim_campaign_recipient(
                    'ca000000-0000-0000-0000-0000000000c2','ca000000-0000-0000-0000-000000000001',
                    null,'ca000000-0000-0000-0000-0000000000d1',
                    'campaign:c2:loyalty:d1:completed_visits:20','Reached 20 visits')) = 1
            then 'PASS' else 'FAIL: a different milestone was blocked' end as result;

-- ===========================================================================
-- 19. A SUPPRESSED ROW MUST CARRY A REASON. "Why did Jane get nothing?" is
--     always answerable.
-- ===========================================================================
do $$
begin
  insert into comms.campaign_recipients
    (campaign_id,business_id,client_profile_id,dedupe_key,status,suppression_reason)
  values ('ca000000-0000-0000-0000-0000000000c1','ca000000-0000-0000-0000-000000000001',
          'ca000000-0000-0000-0000-0000000000d3','campaign:c1:birthday:d3:2026','suppressed',null);
  insert into probe_results values ('19_SUPPRESSION_REASON_REQUIRED','FAIL: a reasonless suppression was stored');
exception when check_violation then
  insert into probe_results values ('19_SUPPRESSION_REASON_REQUIRED','PASS');
end $$;
select case_name as case, result from probe_results where case_name='19_SUPPRESSION_REASON_REQUIRED';

-- ===========================================================================
-- 20. BIRTHDAY MATCHING — the ordinary case, in the salon's own calendar.
-- ===========================================================================
select '20_BIRTHDAY_ON_THE_DAY' as case,
       case when (select count(*) from comms.campaign_birthday_candidates(
                    'ca000000-0000-0000-0000-000000000001','2026-07-14')
                   where client_profile_id='ca000000-0000-0000-0000-0000000000d2') = 1
            then 'PASS' else 'FAIL: a 14 July birthday did not match 2026-07-14' end as result;

-- ===========================================================================
-- 21. NO MATCH ON ANY OTHER DAY.
-- ===========================================================================
select '21_BIRTHDAY_NOT_ON_OTHER_DAYS' as case,
       case when (select count(*) from comms.campaign_birthday_candidates(
                    'ca000000-0000-0000-0000-000000000001','2026-07-15')) = 0
            then 'PASS' else 'FAIL: a birthday matched the wrong day' end as result;

-- ===========================================================================
-- 22. LEAP DAY IN A LEAP YEAR — Jane gets her real birthday.
--     2028 is a leap year.
-- ===========================================================================
select '22_LEAP_DAY_IN_LEAP_YEAR' as case,
       case when (select count(*) from comms.campaign_birthday_candidates(
                    'ca000000-0000-0000-0000-000000000001','2028-02-29')
                   where client_profile_id='ca000000-0000-0000-0000-0000000000d1') = 1
            then 'PASS' else 'FAIL: 29 Feb did not match in a leap year' end as result;

-- ===========================================================================
-- 23. LEAP DAY IN A COMMON YEAR — observed on 28 February. This is the exact
--     rule birthdayOccurrence() implements in TypeScript; the two MUST agree,
--     because the preview renders from one and the send keys off the other.
--     2027 is a common year.
-- ===========================================================================
select '23_LEAP_DAY_OBSERVED_ON_28TH' as case,
       case when (select count(*) from comms.campaign_birthday_candidates(
                    'ca000000-0000-0000-0000-000000000001','2027-02-28')
                   where client_profile_id='ca000000-0000-0000-0000-0000000000d1') = 1
            then 'PASS' else 'FAIL: 29 Feb was not observed on 28 Feb in a common year' end as result;

-- ===========================================================================
-- 24. AND NOT ALSO ON 1 MARCH — exactly one observance per year.
-- ===========================================================================
select '24_LEAP_DAY_NOT_ALSO_ON_1_MARCH' as case,
       case when (select count(*) from comms.campaign_birthday_candidates(
                    'ca000000-0000-0000-0000-000000000001','2027-03-01')) = 0
            then 'PASS' else 'FAIL: a leap-day birthday also matched 1 March' end as result;

-- ===========================================================================
-- 25. IN A LEAP YEAR, 28 FEBRUARY DOES NOT SWEEP UP LEAP-DAY CLIENTS.
-- ===========================================================================
select '25_NO_EARLY_LEAP_MATCH_IN_LEAP_YEAR' as case,
       case when (select count(*) from comms.campaign_birthday_candidates(
                    'ca000000-0000-0000-0000-000000000001','2028-02-28')) = 0
            then 'PASS' else 'FAIL: a leap-day client matched 28 Feb in a leap year' end as result;

-- ===========================================================================
-- 26. A MISSING DATE OF BIRTH IS NEVER INFERRED. Mia has none, and appears on
--     no date at all.
-- ===========================================================================
select '26_NULL_DOB_NEVER_MATCHES' as case,
       case when (select count(*) from comms.campaign_birthday_candidates(
                    'ca000000-0000-0000-0000-000000000001','2026-07-14')
                   where client_profile_id='ca000000-0000-0000-0000-0000000000d3') = 0
            then 'PASS' else 'FAIL: a client with no DOB matched a birthday' end as result;

-- ===========================================================================
-- 27. BUSINESS ISOLATION. Rhona shares Olivia's birthday and belongs to the
--     rival business. Business A's campaign must not see her.
-- ===========================================================================
select '27_BIRTHDAY_BUSINESS_ISOLATION' as case,
       case when (select count(*) from comms.campaign_birthday_candidates(
                    'ca000000-0000-0000-0000-000000000001','2026-07-14')
                   where client_profile_id='ca000000-0000-0000-0000-0000000000d4') = 0
            then 'PASS' else 'FAIL: another business''s client was in the audience' end as result;

-- ===========================================================================
-- 28. LOYALTY VISIT COUNT. Jane has 6 attended visits on 6 distinct dates,
--     PLUS a second visit on one of those dates (must collapse to one) PLUS a
--     cancelled visit (must not count). The answer is 6, not 7 and not 8.
-- ===========================================================================
select '28_VISIT_COUNT_CANONICAL' as case,
       case when (select completed_visits from comms.campaign_loyalty_metrics(
                    'ca000000-0000-0000-0000-000000000001','Europe/London')
                   where client_profile_id='ca000000-0000-0000-0000-0000000000d1') = 6
            then 'PASS'
            else 'FAIL: visit count was ' ||
                 coalesce((select completed_visits::text from comms.campaign_loyalty_metrics(
                            'ca000000-0000-0000-0000-000000000001','Europe/London')
                           where client_profile_id='ca000000-0000-0000-0000-0000000000d1'),'null')
                 || ', expected 6' end as result;

-- ===========================================================================
-- 29. VOIDED BILLS ARE NOT SPEND. Three settled £100 bills and one voided
--     £500 bill mean 30000 pence, not 80000.
-- ===========================================================================
select '29_VOIDED_BILLS_EXCLUDED' as case,
       case when (select total_spend_cents from comms.campaign_loyalty_metrics(
                    'ca000000-0000-0000-0000-000000000001','Europe/London')
                   where client_profile_id='ca000000-0000-0000-0000-0000000000d1') = 30000
            then 'PASS'
            else 'FAIL: spend was ' ||
                 coalesce((select total_spend_cents::text from comms.campaign_loyalty_metrics(
                            'ca000000-0000-0000-0000-000000000001','Europe/London')
                           where client_profile_id='ca000000-0000-0000-0000-0000000000d1'),'null')
                 || ' pence, expected 30000' end as result;

-- ===========================================================================
-- 30. LOYALTY METRICS ARE BUSINESS-SCOPED.
-- ===========================================================================
select '30_LOYALTY_BUSINESS_ISOLATION' as case,
       case when (select count(*) from comms.campaign_loyalty_metrics(
                    'ca000000-0000-0000-0000-000000000002','Europe/London')) = 0
            then 'PASS' else 'FAIL: the rival business had metrics it should not' end as result;

-- ===========================================================================
-- 31. THE CAMPAIGN FUNCTIONS ARE NOT PUBLICLY EXECUTABLE.
--     Migration 0002's default privileges would otherwise leave them callable by
--     any authenticated user through PostgREST.
-- ===========================================================================
select '31_FUNCTION_GRANTS_NARROW' as case,
       case when not has_function_privilege('authenticated',
              'comms.claim_campaign_recipient(uuid,uuid,uuid,uuid,text,text)','execute')
             and not has_function_privilege('anon',
              'comms.claim_campaign_recipient(uuid,uuid,uuid,uuid,text,text)','execute')
             and not has_function_privilege('authenticated',
              'comms.campaign_loyalty_metrics(uuid,text,uuid[],integer,integer)','execute')
             and not has_function_privilege('authenticated',
              'comms.campaign_birthday_candidates(uuid,date,uuid[],integer,integer)','execute')
             and has_function_privilege('service_role',
              'comms.campaign_loyalty_metrics(uuid,text,uuid[],integer,integer)','execute')
            then 'PASS' else 'FAIL: campaign functions are executable by the wrong role' end as result;

-- ===========================================================================
-- 32. RLS — A MANAGER CANNOT READ OR EDIT CAMPAIGNS.
--     Mo is a legitimate `authenticated` user with an active manager membership
--     of THIS business. Campaign configuration is owner-only.
-- ===========================================================================
do $$
declare visible integer;
begin
  perform set_config('request.jwt.claim.sub','ca000000-0000-0000-0000-0000000000f2',true);
  set local role authenticated;
  select count(*) into visible from comms.campaigns
   where business_id='ca000000-0000-0000-0000-000000000001';
  reset role;
  insert into probe_results values ('32_MANAGER_CANNOT_READ_CAMPAIGNS',
    case when visible = 0 then 'PASS' else 'FAIL: a manager read ' || visible || ' campaigns' end);
exception when insufficient_privilege then
  reset role;
  -- The table grant itself was revoked, which is an even stronger PASS.
  insert into probe_results values ('32_MANAGER_CANNOT_READ_CAMPAIGNS','PASS');
when others then
  reset role;
  insert into probe_results values ('32_MANAGER_CANNOT_READ_CAMPAIGNS','FAIL: unexpected ' || sqlstate || ' ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='32_MANAGER_CANNOT_READ_CAMPAIGNS';

-- ===========================================================================
-- 33. RLS — ANOTHER BUSINESS'S OWNER SEES NOTHING.
-- ===========================================================================
do $$
declare leaked integer;
begin
  perform set_config('request.jwt.claim.sub','ca000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  select count(*) into leaked from comms.campaigns
   where business_id='ca000000-0000-0000-0000-000000000001';
  reset role;
  insert into probe_results values ('33_CROSS_BUSINESS_CAMPAIGNS_HIDDEN',
    case when leaked = 0 then 'PASS' else 'FAIL: another business''s campaigns were readable' end);
exception when insufficient_privilege then
  reset role;
  insert into probe_results values ('33_CROSS_BUSINESS_CAMPAIGNS_HIDDEN','PASS');
when others then
  reset role;
  insert into probe_results values ('33_CROSS_BUSINESS_CAMPAIGNS_HIDDEN','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='33_CROSS_BUSINESS_CAMPAIGNS_HIDDEN';

-- ===========================================================================
-- 34. RLS — THE SEND LEDGER IS READ-ONLY FROM A BROWSER SESSION.
--     Even the owner may not fabricate or rewrite a send record; only the
--     evaluator (service_role) writes it.
-- ===========================================================================
do $$
begin
  perform set_config('request.jwt.claim.sub','ca000000-0000-0000-0000-0000000000f1',true);
  set local role authenticated;
  insert into comms.campaign_recipients
    (campaign_id,business_id,client_profile_id,dedupe_key,status)
  values ('ca000000-0000-0000-0000-0000000000c1','ca000000-0000-0000-0000-000000000001',
          'ca000000-0000-0000-0000-0000000000d3','forged-key','queued');
  reset role;
  insert into probe_results values ('34_LEDGER_NOT_BROWSER_WRITABLE','FAIL: an owner forged a send record');
exception when insufficient_privilege or check_violation then
  reset role;
  insert into probe_results values ('34_LEDGER_NOT_BROWSER_WRITABLE','PASS');
when others then
  reset role;
  insert into probe_results values ('34_LEDGER_NOT_BROWSER_WRITABLE','FAIL: unexpected ' || sqlstate || ' ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='34_LEDGER_NOT_BROWSER_WRITABLE';

-- ---------------------------------------------------------------------------
-- Summary. Any row that is not PASS is a failure, and a count of zero means the
-- suite aborted rather than succeeded.
-- ---------------------------------------------------------------------------
select 'SUMMARY' as case,
       count(*) filter (where result = 'PASS')::text || ' of ' || count(*)::text
         || ' recorded probe cases passed' as result
from probe_results;

-- ---------------------------------------------------------------------------
-- Teardown — nothing this suite created survives.
-- ---------------------------------------------------------------------------
rollback;
