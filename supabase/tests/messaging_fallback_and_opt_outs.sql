-- messaging_fallback_and_opt_outs.sql — behavioural suite for migration 0098.
--
-- WHY THIS FILE EXISTS. The two things 0098 adds are enforced by the DATABASE,
-- not by the API: the campaign idempotency guard is a partial unique index, and
-- the "one opt-out per client per channel" rule is a unique constraint. The Jest
-- suite stubs the Supabase client, so it proves that MessagingService TREATS a
-- 23505 as an idempotent no-op — it can never prove that a second identical
-- campaign row actually raises one, nor that a fallback on a different channel
-- does not. This file is that proof.
--
-- 12 numbered cases. Read the RESULT column of each; every one must read PASS.
--
-- Run against a SCRATCH database that has every migration through 0098 applied:
--   psql -d <scratch> -f supabase/tests/messaging_fallback_and_opt_outs.sql

-- The whole suite runs inside one transaction that is rolled back at the end, so
-- it leaves no fixture rows behind and is re-runnable. Every expected failure runs
-- inside a plpgsql block whose exception handler records the verdict, so the
-- rejected write is undone while the evidence that it WAS rejected survives.

\set ON_ERROR_STOP off
\pset pager off

begin;

-- ---------------------------------------------------------------------------
-- Fixtures. 'ee' prefix, hex-only UUIDs, distinct from the other suites.
-- ---------------------------------------------------------------------------
insert into core.businesses (id,name,slug) values
 ('ee000000-0000-0000-0000-000000000001','Fallback Salon','fallback-salon');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('ee000000-0000-0000-0000-0000000000a1','ee000000-0000-0000-0000-000000000001','E1','Main','ee-main','1 St','Leeds','LS3 1AA','Europe/London');

insert into core.client_profiles (id,business_id,client_code,first_name,last_name,phone,email) values
 ('ee000000-0000-0000-0000-0000000000c1','ee000000-0000-0000-0000-000000000001','EEAAAA01','Sam','Stone','+447700900001','sam.ee@example.com'),
 ('ee000000-0000-0000-0000-0000000000c2','ee000000-0000-0000-0000-000000000001','EEAAAA02','Alex','Reed','+447700900002','alex.ee@example.com');

-- An OWNER identity, so cases 13-15 can prove what a real browser session can
-- and cannot do to a client's consent record.
insert into auth.users (id,email) values
 ('ee000000-0000-0000-0000-0000000000f1'::uuid,'owner@ee.example');
insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name,is_active) values
 ('ee000000-0000-0000-0000-0000000000f1','owner@ee.example','Olive Owner','Olive','Owner','Olive',true);
insert into core.user_memberships (business_id,location_id,user_profile_id,role,status,activated_at) values
 ('ee000000-0000-0000-0000-000000000001',null,'ee000000-0000-0000-0000-0000000000f1','owner','active',now());

-- ---------------------------------------------------------------------------
-- How the negative cases are proved.
--
-- "Insert inside a savepoint, roll back, then count the rows" does NOT prove a
-- constraint exists: the rollback removes the row whether the insert was rejected
-- or accepted, so the count comes out the same either way and the case passes
-- against a database with no constraint at all. Every negative case below instead
-- runs its probe inside a plpgsql block and records which branch was taken. The
-- exception handler opens an implicit subtransaction, so the rejected write is
-- undone while the recorded verdict survives — the verdict IS the evidence.
-- ---------------------------------------------------------------------------
create temporary table probe_results (case_name text primary key, result text) on commit drop;

-- ===========================================================================
-- 1. FALLBACK_PENDING IS A REAL STATE — the dispatcher writes it when a channel
--    has handed over to the next one. If the enum value were missing the write
--    would fail at runtime, which is exactly what happened before 0098's
--    counterpart code started using it.
-- ===========================================================================
insert into comms.notification_events
  (id,business_id,location_id,client_profile_id,channel,event_key,status,scheduled_for)
values
  ('ee000000-0000-0000-0000-0000000000e1','ee000000-0000-0000-0000-000000000001',
   'ee000000-0000-0000-0000-0000000000a1','ee000000-0000-0000-0000-0000000000c1',
   'whatsapp','campaign:winback','fallback_pending',now());

select '01_FALLBACK_PENDING_STATE' as case,
       case when exists (
         select 1 from comms.notification_events
         where id = 'ee000000-0000-0000-0000-0000000000e1' and status = 'fallback_pending')
       then 'PASS' else 'FAIL: fallback_pending could not be stored' end as result;

-- ===========================================================================
-- 2. DEDUPE KEY BLOCKS A REPEATED CAMPAIGN — the same key, same channel, same
--    business must not queue twice. Without this index a campaign re-run sent
--    every client the same message again.
-- ===========================================================================
insert into comms.notification_events
  (id,business_id,location_id,client_profile_id,channel,event_key,status,scheduled_for,dedupe_key)
values
  ('ee000000-0000-0000-0000-0000000000e2','ee000000-0000-0000-0000-000000000001',
   'ee000000-0000-0000-0000-0000000000a1','ee000000-0000-0000-0000-0000000000c1',
   'whatsapp','campaign:winback','queued',now(),'campaign:winback:c1');

do $probe$
begin
  insert into comms.notification_events
    (business_id,location_id,client_profile_id,channel,event_key,status,scheduled_for,dedupe_key)
  values
    ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000a1',
     'ee000000-0000-0000-0000-0000000000c1','whatsapp','campaign:winback','queued',now(),
     'campaign:winback:c1');
  insert into probe_results values
    ('02_DEDUPE_BLOCKS_REPEAT','FAIL: a duplicate campaign row was accepted');
exception when unique_violation then
  insert into probe_results values ('02_DEDUPE_BLOCKS_REPEAT','PASS');
end
$probe$;

select case_name as case, result from probe_results where case_name = '02_DEDUPE_BLOCKS_REPEAT';

-- ===========================================================================
-- 3. THE FALLBACK IS NOT A DUPLICATE — the index includes `channel`, so the SMS
--    hop of the same message is a legitimate second row. If `channel` were left
--    out, WhatsApp → SMS escalation would be silently swallowed as a duplicate
--    and the message would never be delivered.
-- ===========================================================================
insert into comms.notification_events
  (business_id,location_id,client_profile_id,channel,event_key,status,scheduled_for,dedupe_key,payload_json)
values
  ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000a1',
   'ee000000-0000-0000-0000-0000000000c1','sms','campaign:winback','queued',now(),
   'campaign:winback:c1','{"fallback": true, "primary_channel": "whatsapp"}'::jsonb);

select '03_FALLBACK_IS_NOT_A_DUPLICATE' as case,
       case when (select count(*) from comms.notification_events
                  where dedupe_key = 'campaign:winback:c1') = 2
       then 'PASS' else 'FAIL: the SMS fallback was rejected as a duplicate' end as result;

-- ===========================================================================
-- 4. A CANCELLED ATTEMPT DOES NOT BLOCK A RE-SEND — the index is partial on
--    `status <> 'cancelled'`, mirroring the booking-event index. A campaign that
--    was cancelled (consent withdrawn, no eligible channel) must be re-sendable
--    once the reason goes away.
-- ===========================================================================
update comms.notification_events set status = 'cancelled'
where dedupe_key = 'campaign:winback:c1' and channel = 'whatsapp';

insert into comms.notification_events
  (business_id,location_id,client_profile_id,channel,event_key,status,scheduled_for,dedupe_key)
values
  ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000a1',
   'ee000000-0000-0000-0000-0000000000c1','whatsapp','campaign:winback','queued',now(),
   'campaign:winback:c1');

select '04_CANCELLED_DOES_NOT_BLOCK' as case,
       case when (select count(*) from comms.notification_events
                  where dedupe_key = 'campaign:winback:c1'
                    and channel = 'whatsapp' and status = 'queued') = 1
       then 'PASS' else 'FAIL: a cancelled attempt blocked the re-send' end as result;

-- ===========================================================================
-- 5. A DIFFERENT CLIENT IS A DIFFERENT MESSAGE — the key is caller-supplied and
--    includes the client, so one campaign fans out to many clients freely.
-- ===========================================================================
insert into comms.notification_events
  (business_id,location_id,client_profile_id,channel,event_key,status,scheduled_for,dedupe_key)
values
  ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000a1',
   'ee000000-0000-0000-0000-0000000000c2','whatsapp','campaign:winback','queued',now(),
   'campaign:winback:c2');

select '05_FAN_OUT_ACROSS_CLIENTS' as case,
       case when (select count(*) from comms.notification_events
                  where event_key = 'campaign:winback' and status = 'queued') = 3
       then 'PASS' else 'FAIL: a second client was rejected as a duplicate' end as result;

-- ===========================================================================
-- 6. NULL KEYS NEVER COLLIDE — appointment-anchored events carry no dedupe key
--    and are guarded by their own index. Many null keys must coexist.
-- ===========================================================================
insert into comms.notification_events
  (business_id,location_id,client_profile_id,channel,event_key,status,scheduled_for)
values
  ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000a1',
   'ee000000-0000-0000-0000-0000000000c1','whatsapp','booking_confirmation','queued',now()),
  ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000a1',
   'ee000000-0000-0000-0000-0000000000c1','whatsapp','booking_confirmation','queued',now());

select '06_NULL_KEYS_DO_NOT_COLLIDE' as case,
       case when (select count(*) from comms.notification_events
                  where event_key = 'booking_confirmation' and dedupe_key is null) = 2
       then 'PASS' else 'FAIL: null dedupe keys were treated as equal' end as result;

-- ===========================================================================
-- 7. ONE OPT-OUT PER CLIENT PER CHANNEL — re-recording the same STOP must not
--    accumulate rows (a client can reply STOP many times).
-- ===========================================================================
insert into comms.channel_opt_outs (business_id,client_profile_id,channel,source,reason) values
 ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000c1','whatsapp','inbound_keyword','replied STOP');

do $probe$
begin
  insert into comms.channel_opt_outs (business_id,client_profile_id,channel,source) values
   ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000c1','whatsapp','provider_error');
  insert into probe_results values
    ('07_OPT_OUT_IS_UNIQUE_PER_CHANNEL','FAIL: duplicate opt-out rows accumulated');
exception when unique_violation then
  insert into probe_results values ('07_OPT_OUT_IS_UNIQUE_PER_CHANNEL','PASS');
end
$probe$;

select case_name as case, result from probe_results where case_name = '07_OPT_OUT_IS_UNIQUE_PER_CHANNEL';

-- ===========================================================================
-- 8. OPT-OUT IS PER CHANNEL — the same client opting out of SMS as well is a
--    second, independent row. This is the whole point of the design: a WhatsApp
--    STOP must not silence the transactional email.
-- ===========================================================================
insert into comms.channel_opt_outs (business_id,client_profile_id,channel,source) values
 ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000c1','sms','inbound_keyword');

select '08_OPT_OUT_IS_PER_CHANNEL' as case,
       case when (select count(*) from comms.channel_opt_outs
                  where client_profile_id = 'ee000000-0000-0000-0000-0000000000c1') = 2
        and not exists (select 1 from comms.channel_opt_outs
                        where client_profile_id = 'ee000000-0000-0000-0000-0000000000c1'
                          and channel = 'email')
       then 'PASS' else 'FAIL: channels are not independent' end as result;

-- ===========================================================================
-- 9. SOURCE IS CONSTRAINED — an unrecognised provenance must be rejected, so
--    "how did we learn this?" stays answerable for every row.
-- ===========================================================================
do $probe$
begin
  insert into comms.channel_opt_outs (business_id,client_profile_id,channel,source) values
   ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000c2','email','guessed');
  insert into probe_results values
    ('09_SOURCE_IS_CONSTRAINED','FAIL: an unconstrained source was accepted');
exception when check_violation then
  insert into probe_results values ('09_SOURCE_IS_CONSTRAINED','PASS');
end
$probe$;

select case_name as case, result from probe_results where case_name = '09_SOURCE_IS_CONSTRAINED';

-- ===========================================================================
-- 10. OPTING BACK IN LEAVES NO TRACE — START deletes the row, so the absence of
--     a row always means "not opted out" and no code has to interpret a flag.
-- ===========================================================================
delete from comms.channel_opt_outs
where client_profile_id = 'ee000000-0000-0000-0000-0000000000c1' and channel = 'whatsapp';

select '10_OPT_IN_DELETES_THE_ROW' as case,
       case when not exists (
         select 1 from comms.channel_opt_outs
         where client_profile_id = 'ee000000-0000-0000-0000-0000000000c1' and channel = 'whatsapp')
       then 'PASS' else 'FAIL: the opt-out survived an opt-in' end as result;

-- ===========================================================================
-- 11. CLIENT MERGE STILL WORKS — this table is the first under crm.merge_clients'
--     catalog-driven FK loop (0087) to carry a UNIQUE on client_profile_id. That
--     loop repoints with one blanket, conflict-unaware UPDATE per table and has no
--     exception handler, so without the skip trigger a merge of two clients who had
--     each opted out of the SAME channel raises 23505 and rolls the whole merge
--     back — leaving the duplicate permanently unmergeable.
-- ===========================================================================
insert into core.client_profiles (id,business_id,client_code,first_name,last_name,phone,email) values
 ('ee000000-0000-0000-0000-0000000000c3','ee000000-0000-0000-0000-000000000001','EEAAAA03','Rae','Kerr','+447700900003','rae.ee@example.com'),
 ('ee000000-0000-0000-0000-0000000000c4','ee000000-0000-0000-0000-000000000001','EEAAAA04','Rae','Kerr','+447700900004','rae.dup@example.com');

-- Both replied STOP to email (the collision); only the duplicate opted out of SMS.
insert into comms.channel_opt_outs (business_id,client_profile_id,channel,source) values
 ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000c3','email','inbound_keyword'),
 ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000c4','email','inbound_keyword'),
 ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000c4','sms','inbound_keyword');

do $probe$
begin
  perform crm.merge_clients(
    'ee000000-0000-0000-0000-000000000001',
    'ee000000-0000-0000-0000-0000000000c3',
    'ee000000-0000-0000-0000-0000000000c4');
  insert into probe_results values ('11_MERGE_SURVIVES_DUPLICATE_OPT_OUTS','PASS');
exception when others then
  insert into probe_results values
    ('11_MERGE_SURVIVES_DUPLICATE_OPT_OUTS','FAIL: merge_clients raised ' || sqlerrm);
end
$probe$;

select case_name as case, result from probe_results
where case_name = '11_MERGE_SURVIVES_DUPLICATE_OPT_OUTS';

-- ===========================================================================
-- 12. AND THE MERGE LOSES NO CONSENT — the survivor keeps the opt-out it already
--     had and inherits the one only the duplicate had. Skipping the colliding row
--     is safe precisely because it was redundant; skipping a NON-colliding one
--     would silently re-subscribe a client who had opted out.
-- ===========================================================================
select '12_MERGE_KEEPS_EVERY_OPT_OUT' as case,
       case when (select count(*) from comms.channel_opt_outs
                  where client_profile_id = 'ee000000-0000-0000-0000-0000000000c3') = 2
             and exists (select 1 from comms.channel_opt_outs
                         where client_profile_id = 'ee000000-0000-0000-0000-0000000000c3' and channel = 'email')
             and exists (select 1 from comms.channel_opt_outs
                         where client_profile_id = 'ee000000-0000-0000-0000-0000000000c3' and channel = 'sms')
       then 'PASS' else 'FAIL: the merged client lost or duplicated an opt-out' end as result;

-- ===========================================================================
-- 13-15. OPT-OUT EVIDENCE IS NOT SALON-WRITABLE (0109).
--
-- A client's opt-out records a decision the CLIENT made. 0098 granted
-- authenticated full CRUD, so an owner could DELETE that record straight over
-- PostgREST — no route, no audit, nothing in the product to show it. These cases
-- prove 0109 took the write privileges back without taking the READ away, which
-- CRM history needs to explain a skipped message.
-- ===========================================================================

-- A consent record to attack.
insert into comms.channel_opt_outs (business_id, client_profile_id, channel, source)
values ('ee000000-0000-0000-0000-000000000001','ee000000-0000-0000-0000-0000000000c1','sms','inbound_keyword')
on conflict do nothing;

do $$ begin
  perform set_config('request.jwt.claim.sub','ee000000-0000-0000-0000-0000000000f1',true);
  set local role authenticated;
  delete from comms.channel_opt_outs
   where business_id='ee000000-0000-0000-0000-000000000001'
     and client_profile_id='ee000000-0000-0000-0000-0000000000c1' and channel='sms';
  reset role;
  -- If we got here the DELETE was permitted; the row count decides the verdict.
  insert into probe_results values ('13_OWNER_CANNOT_DELETE_OPT_OUT',
    case when exists (select 1 from comms.channel_opt_outs
                       where client_profile_id='ee000000-0000-0000-0000-0000000000c1' and channel='sms')
         then 'PASS' else 'FAIL: an owner erased a client''s opt-out from a browser session' end);
exception when insufficient_privilege then
  reset role;
  insert into probe_results values ('13_OWNER_CANNOT_DELETE_OPT_OUT','PASS');
when others then
  reset role;
  insert into probe_results values ('13_OWNER_CANNOT_DELETE_OPT_OUT','FAIL: unexpected ' || sqlstate || ' ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='13_OWNER_CANNOT_DELETE_OPT_OUT';

do $$ begin
  perform set_config('request.jwt.claim.sub','ee000000-0000-0000-0000-0000000000f1',true);
  set local role authenticated;
  -- Re-subscribing by UPDATE would be the same erasure by another verb.
  update comms.channel_opt_outs set channel='email'
   where client_profile_id='ee000000-0000-0000-0000-0000000000c1' and channel='sms';
  reset role;
  insert into probe_results values ('14_OWNER_CANNOT_REWRITE_OPT_OUT',
    case when exists (select 1 from comms.channel_opt_outs
                       where client_profile_id='ee000000-0000-0000-0000-0000000000c1' and channel='sms')
         then 'PASS' else 'FAIL: an owner rewrote a client''s opt-out from a browser session' end);
exception when insufficient_privilege then
  reset role;
  insert into probe_results values ('14_OWNER_CANNOT_REWRITE_OPT_OUT','PASS');
when others then
  reset role;
  insert into probe_results values ('14_OWNER_CANNOT_REWRITE_OPT_OUT','FAIL: unexpected ' || sqlstate || ' ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='14_OWNER_CANNOT_REWRITE_OPT_OUT';

do $$
declare visible integer;
begin
  perform set_config('request.jwt.claim.sub','ee000000-0000-0000-0000-0000000000f1',true);
  set local role authenticated;
  -- READ must survive: CRM history explains a skipped message with this.
  select count(*) into visible from comms.channel_opt_outs
   where business_id='ee000000-0000-0000-0000-000000000001';
  reset role;
  insert into probe_results values ('15_OWNER_CAN_STILL_READ_OPT_OUTS',
    case when visible >= 1 then 'PASS' else 'FAIL: the owner lost read access to their own opt-outs' end);
exception when others then
  reset role;
  insert into probe_results values ('15_OWNER_CAN_STILL_READ_OPT_OUTS','FAIL: unexpected ' || sqlstate || ' ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='15_OWNER_CAN_STILL_READ_OPT_OUTS';

-- The service role — the ONLY writer — must still be able to record and clear
-- consent, or a START reply could never re-subscribe anyone.
select '16_SERVICE_ROLE_STILL_WRITES' as case,
       case when has_table_privilege('service_role','comms.channel_opt_outs','INSERT')
             and has_table_privilege('service_role','comms.channel_opt_outs','DELETE')
             and not has_table_privilege('authenticated','comms.channel_opt_outs','DELETE')
             and not has_table_privilege('authenticated','comms.channel_opt_outs','INSERT')
             and not has_table_privilege('authenticated','comms.channel_opt_outs','UPDATE')
             and has_table_privilege('authenticated','comms.channel_opt_outs','SELECT')
            then 'PASS' else 'FAIL: opt-out grants are not server-write / browser-read' end as result;

select '17_ANON_HAS_NO_OPT_OUT_REACH' as case,
       case when not has_table_privilege('anon','comms.channel_opt_outs','SELECT')
             and not has_table_privilege('anon','comms.channel_opt_outs','DELETE')
            then 'PASS' else 'FAIL: anon can reach client consent records' end as result;

-- ---------------------------------------------------------------------------
-- Teardown — nothing this suite created survives.
-- ---------------------------------------------------------------------------
rollback;
