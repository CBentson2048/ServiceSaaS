-- in_app_notifications.sql — behavioural suite for migration 0099.
--
-- WHY THIS FILE EXISTS. Almost everything that makes the in-app notification layer
-- SAFE is enforced by the database, not by the API: atomic notification+recipient
-- creation, recipient eligibility, dedupe, the per-recipient read state, the
-- push-token uniqueness that stops duplicate delivery, and — most importantly —
-- the RLS that keeps one user's feed out of another user's hands. The Jest suite
-- stubs the Supabase client, so it can only prove that the SERVICE asks for the
-- right things; it can never prove that a stylist querying comms.notifications
-- directly through PostgREST with their own token sees nothing. This file is that
-- proof, and it runs the policies for real against the authenticated role.
--
-- 52 numbered cases. Read the RESULT column of each; every one must read PASS.
--
-- Run against a SCRATCH database that has every migration through 0099 applied:
--   psql -d <scratch> -f supabase/tests/in_app_notifications.sql
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
-- Fixtures. 'fa' prefix, hex-only UUIDs, distinct from the other suites.
--
-- Two businesses so cross-tenant leakage has something to leak to; two locations
-- inside the first so location scoping has something to exclude.
-- ---------------------------------------------------------------------------
insert into core.businesses (id,name,slug) values
 ('fa000000-0000-0000-0000-000000000001','Notify Salon','notify-salon'),
 ('fa000000-0000-0000-0000-000000000002','Rival Salon','rival-salon');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('fa000000-0000-0000-0000-0000000000a1','fa000000-0000-0000-0000-000000000001','F1','Pinner','fa-pinner','1 High St','Pinner','HA5 1AA','Europe/London'),
 ('fa000000-0000-0000-0000-0000000000a2','fa000000-0000-0000-0000-000000000001','F2','Harrow','fa-harrow','2 High St','Harrow','HA1 1AA','Europe/London'),
 ('fa000000-0000-0000-0000-0000000000a3','fa000000-0000-0000-0000-000000000002','F3','Rival','fa-rival','3 High St','Watford','WD1 1AA','Europe/London');

-- core.user_profiles.id references auth.users(id), so the auth rows come first.
insert into auth.users (id,email) values
 ('fa000000-0000-0000-0000-0000000000f1'::uuid,'owner@fa.example'),
 ('fa000000-0000-0000-0000-0000000000f2'::uuid,'manager@fa.example'),
 ('fa000000-0000-0000-0000-0000000000f3'::uuid,'stylist1@fa.example'),
 ('fa000000-0000-0000-0000-0000000000f4'::uuid,'stylist2@fa.example'),
 ('fa000000-0000-0000-0000-0000000000f5'::uuid,'inactive@fa.example'),
 ('fa000000-0000-0000-0000-0000000000f6'::uuid,'rival@fa.example'),
 ('fa000000-0000-0000-0000-0000000000f7'::uuid,'revoked@fa.example');

insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name,is_active) values
 ('fa000000-0000-0000-0000-0000000000f1','owner@fa.example','Olive Owner','Olive','Owner','Olive',true),
 ('fa000000-0000-0000-0000-0000000000f2','manager@fa.example','Mo Manager','Mo','Manager','Mo',true),
 ('fa000000-0000-0000-0000-0000000000f3','stylist1@fa.example','Sam Stylist','Sam','Stylist','Sam',true),
 ('fa000000-0000-0000-0000-0000000000f4','stylist2@fa.example','Sky Stylist','Sky','Stylist','Sky',true),
 ('fa000000-0000-0000-0000-0000000000f5','inactive@fa.example','Ira Inactive','Ira','Inactive','Ira',false),
 ('fa000000-0000-0000-0000-0000000000f6','rival@fa.example','Rex Rival','Rex','Rival','Rex',true),
 ('fa000000-0000-0000-0000-0000000000f7','revoked@fa.example','Rob Revoked','Rob','Revoked','Rob',true);

insert into core.user_memberships (business_id,location_id,user_profile_id,role,status) values
 -- Owner: business-wide, no location. Location-scoped notifications still reach them.
 ('fa000000-0000-0000-0000-000000000001',null,'fa000000-0000-0000-0000-0000000000f1','owner','active'),
 ('fa000000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-0000000000a1','fa000000-0000-0000-0000-0000000000f2','manager','active'),
 ('fa000000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-0000000000a1','fa000000-0000-0000-0000-0000000000f3','stylist','active'),
 -- Stylist at the OTHER location: must not receive a Pinner-scoped notification.
 ('fa000000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-0000000000a2','fa000000-0000-0000-0000-0000000000f4','stylist','active'),
 -- Active membership but a deactivated profile.
 ('fa000000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-0000000000a1','fa000000-0000-0000-0000-0000000000f5','stylist','active'),
 -- Different business entirely.
 ('fa000000-0000-0000-0000-000000000002','fa000000-0000-0000-0000-0000000000a3','fa000000-0000-0000-0000-0000000000f6','stylist','active'),
 -- Revoked membership.
 ('fa000000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-0000000000a1','fa000000-0000-0000-0000-0000000000f7','stylist','revoked');

create temporary table probe_results (case_name text primary key, result text) on commit drop;
-- Scratch space for ids produced by the function under test.
create temporary table ids (k text primary key, v uuid) on commit drop;

-- ===========================================================================
-- 1-3. CREATION PERSISTS BOTH HALVES, AND A NEW NOTIFICATION IS UNREAD.
--      The notification and its recipient row are written by one function call,
--      which is one transaction — there is no window in which a notification
--      exists with no recipients.
-- ===========================================================================
insert into ids (k, v)
select 'n1', notification_id from comms.create_notification(
  p_business_id => 'fa000000-0000-0000-0000-000000000001',
  p_type => 'client_arrived',
  p_title => 'Client arrived',
  p_body => 'Your next client has arrived.',
  p_recipient_user_profile_ids => array['fa000000-0000-0000-0000-0000000000f3']::uuid[],
  p_location_id => 'fa000000-0000-0000-0000-0000000000a1',
  p_entity_type => 'appointment',
  p_entity_id => 'fa000000-0000-0000-0000-0000000000b1',
  p_action_path => '/appointments/fa000000-0000-0000-0000-0000000000b1'
);

select '01_NOTIFICATION_PERSISTS' as case,
       case when exists (
         select 1 from comms.notifications n
         join ids on ids.k='n1' and ids.v = n.id
         where n.type='client_arrived'
           and n.business_id='fa000000-0000-0000-0000-000000000001'
           and n.location_id='fa000000-0000-0000-0000-0000000000a1'
           and n.entity_type='appointment'
           and n.action_path='/appointments/fa000000-0000-0000-0000-0000000000b1')
       then 'PASS' else 'FAIL: notification row not stored as supplied' end as result;

select '02_RECIPIENT_PERSISTS' as case,
       case when (select count(*) from comms.notification_recipients r
                  join ids on ids.k='n1' and ids.v = r.notification_id) = 1
       then 'PASS' else 'FAIL: expected exactly one recipient row' end as result;

select '03_NEW_NOTIFICATION_IS_UNREAD' as case,
       case when exists (
         select 1 from comms.notification_recipients r
         join ids on ids.k='n1' and ids.v = r.notification_id
         where r.user_profile_id='fa000000-0000-0000-0000-0000000000f3'
           and r.read_at is null and r.seen_at is null)
       then 'PASS' else 'FAIL: a new notification must start unread' end as result;

-- ===========================================================================
-- 4-5. FAN-OUT. One notification, many recipients — and a caller that repeats a
--      recipient id (or a user holding two memberships) gets ONE row, not two
--      unread badges for the same event.
-- ===========================================================================
insert into ids (k, v)
select 'n2', notification_id from comms.create_notification(
  p_business_id => 'fa000000-0000-0000-0000-000000000001',
  p_type => 'system',
  p_title => 'Business-wide notice',
  p_body => 'Everyone sees this.',
  p_recipient_user_profile_ids => array[
    'fa000000-0000-0000-0000-0000000000f1',
    'fa000000-0000-0000-0000-0000000000f2',
    'fa000000-0000-0000-0000-0000000000f3',
    'fa000000-0000-0000-0000-0000000000f3'
  ]::uuid[]
);

select '04_MULTI_RECIPIENT_FAN_OUT' as case,
       case when (select count(*) from comms.notification_recipients r
                  join ids on ids.k='n2' and ids.v = r.notification_id) = 3
             and (select count(*) from comms.notifications n
                  join ids on ids.k='n2' and ids.v = n.id) = 1
       then 'PASS' else 'FAIL: one notification should fan out to three recipient rows' end as result;

select '05_DUPLICATE_RECIPIENT_IDS_COLLAPSE' as case,
       case when (select count(*) from comms.notification_recipients r
                  join ids on ids.k='n2' and ids.v = r.notification_id
                  where r.user_profile_id='fa000000-0000-0000-0000-0000000000f3') = 1
       then 'PASS' else 'FAIL: a repeated recipient id must not create a second row' end as result;

-- ===========================================================================
-- 6-9. RECIPIENT ELIGIBILITY. Cross-tenant targeting is impossible; revoked
--      members and deactivated profiles are dropped; and a call with nobody
--      eligible creates NOTHING rather than an unreachable orphan notification.
-- ===========================================================================
insert into ids (k, v)
select 'n3', notification_id from comms.create_notification(
  p_business_id => 'fa000000-0000-0000-0000-000000000001',
  p_type => 'system',
  p_title => 'Eligibility probe',
  p_body => 'Only the valid stylist should receive this.',
  p_recipient_user_profile_ids => array[
    'fa000000-0000-0000-0000-0000000000f3',  -- valid
    'fa000000-0000-0000-0000-0000000000f6',  -- other business
    'fa000000-0000-0000-0000-0000000000f7',  -- revoked membership
    'fa000000-0000-0000-0000-0000000000f5'   -- deactivated profile
  ]::uuid[]
);

select '06_CROSS_BUSINESS_RECIPIENT_EXCLUDED' as case,
       case when not exists (
         select 1 from comms.notification_recipients r
         join ids on ids.k='n3' and ids.v = r.notification_id
         where r.user_profile_id='fa000000-0000-0000-0000-0000000000f6')
       then 'PASS' else 'FAIL: a user from another business was targeted' end as result;

select '07_REVOKED_MEMBERSHIP_EXCLUDED' as case,
       case when not exists (
         select 1 from comms.notification_recipients r
         join ids on ids.k='n3' and ids.v = r.notification_id
         where r.user_profile_id='fa000000-0000-0000-0000-0000000000f7')
       then 'PASS' else 'FAIL: a revoked member was targeted' end as result;

select '08_DEACTIVATED_PROFILE_EXCLUDED' as case,
       case when not exists (
         select 1 from comms.notification_recipients r
         join ids on ids.k='n3' and ids.v = r.notification_id
         where r.user_profile_id='fa000000-0000-0000-0000-0000000000f5')
       then 'PASS' else 'FAIL: a deactivated user was targeted' end as result;

-- The caller can detect the drop: requested 4, delivered 1.
select '09_INELIGIBLE_RECIPIENTS_ARE_REPORTED' as case,
       case when (select recipient_count from comms.create_notification(
                    p_business_id => 'fa000000-0000-0000-0000-000000000001',
                    p_type => 'system', p_title => 'counts', p_body => 'b',
                    p_recipient_user_profile_ids => array[
                      'fa000000-0000-0000-0000-0000000000f3',
                      'fa000000-0000-0000-0000-0000000000f6']::uuid[])) = 1
             and (select requested_count from comms.create_notification(
                    p_business_id => 'fa000000-0000-0000-0000-000000000001',
                    p_type => 'system', p_title => 'counts2', p_body => 'b',
                    p_recipient_user_profile_ids => array[
                      'fa000000-0000-0000-0000-0000000000f3',
                      'fa000000-0000-0000-0000-0000000000f6']::uuid[])) = 2
       then 'PASS' else 'FAIL: requested_count/recipient_count must expose dropped recipients' end as result;

-- ===========================================================================
-- 10. NOBODY ELIGIBLE => NO ROW AT ALL. An orphan notification with no recipients
--     is unreachable data that would sit in the table forever.
-- ===========================================================================
select '10_NO_ELIGIBLE_RECIPIENT_CREATES_NOTHING' as case,
       case when (select notification_id from comms.create_notification(
                    p_business_id => 'fa000000-0000-0000-0000-000000000001',
                    p_type => 'system', p_title => 'orphan', p_body => 'b',
                    p_recipient_user_profile_ids => array[
                      'fa000000-0000-0000-0000-0000000000f6']::uuid[])) is null
             and not exists (select 1 from comms.notifications where title='orphan')
       then 'PASS' else 'FAIL: an unreachable notification was created' end as result;

-- ===========================================================================
-- 11-13. LOCATION TARGETING. A Pinner notification reaches Pinner staff and the
--        owner (who is business-wide), never the Harrow stylist. A location from
--        another business is a tenancy breach and is refused outright.
-- ===========================================================================
insert into ids (k, v)
select 'n4', notification_id from comms.create_notification(
  p_business_id => 'fa000000-0000-0000-0000-000000000001',
  p_type => 'client_arrived',
  p_title => 'Pinner arrival',
  p_body => 'Client arrived at Pinner.',
  p_recipient_user_profile_ids => array[
    'fa000000-0000-0000-0000-0000000000f3',  -- Pinner stylist
    'fa000000-0000-0000-0000-0000000000f4',  -- Harrow stylist
    'fa000000-0000-0000-0000-0000000000f1'   -- owner, no location
  ]::uuid[],
  p_location_id => 'fa000000-0000-0000-0000-0000000000a1'
);

select '11_LOCATION_SCOPE_INCLUDES_LOCATION_STAFF' as case,
       case when exists (
         select 1 from comms.notification_recipients r
         join ids on ids.k='n4' and ids.v = r.notification_id
         where r.user_profile_id='fa000000-0000-0000-0000-0000000000f3')
       then 'PASS' else 'FAIL: the location''s own stylist was not targeted' end as result;

select '12_LOCATION_SCOPE_EXCLUDES_OTHER_LOCATION' as case,
       case when not exists (
         select 1 from comms.notification_recipients r
         join ids on ids.k='n4' and ids.v = r.notification_id
         where r.user_profile_id='fa000000-0000-0000-0000-0000000000f4')
       then 'PASS' else 'FAIL: a stylist from another location received a location-scoped alert' end as result;

select '13_LOCATION_SCOPE_INCLUDES_OWNER' as case,
       case when exists (
         select 1 from comms.notification_recipients r
         join ids on ids.k='n4' and ids.v = r.notification_id
         where r.user_profile_id='fa000000-0000-0000-0000-0000000000f1')
       then 'PASS' else 'FAIL: the business-wide owner should still receive a location alert' end as result;

do $probe$
begin
  perform comms.create_notification(
    p_business_id => 'fa000000-0000-0000-0000-000000000001',
    p_type => 'system', p_title => 'cross-tenant location', p_body => 'b',
    p_recipient_user_profile_ids => array['fa000000-0000-0000-0000-0000000000f3']::uuid[],
    p_location_id => 'fa000000-0000-0000-0000-0000000000a3');
  insert into probe_results values ('14_CROSS_BUSINESS_LOCATION_REJECTED','FAIL: a location from another business was accepted');
exception when others then
  insert into probe_results values ('14_CROSS_BUSINESS_LOCATION_REJECTED','PASS');
end
$probe$;
select case_name as case, result from probe_results where case_name='14_CROSS_BUSINESS_LOCATION_REJECTED';

-- ===========================================================================
-- 15-17. IDEMPOTENCY. A retried business event (a double-tapped check-in) must
--        resolve to the FIRST notification — not a second copy, and not a second
--        set of unread badges.
-- ===========================================================================
insert into ids (k, v)
select 'd1', notification_id from comms.create_notification(
  p_business_id => 'fa000000-0000-0000-0000-000000000001',
  p_type => 'client_arrived', p_title => 'Arrived', p_body => 'b',
  p_recipient_user_profile_ids => array['fa000000-0000-0000-0000-0000000000f3']::uuid[],
  p_dedupe_key => 'client_arrived:fa000000-0000-0000-0000-0000000000b9');

insert into ids (k, v)
select 'd2', notification_id from comms.create_notification(
  p_business_id => 'fa000000-0000-0000-0000-000000000001',
  p_type => 'client_arrived', p_title => 'Arrived', p_body => 'b',
  p_recipient_user_profile_ids => array['fa000000-0000-0000-0000-0000000000f3']::uuid[],
  p_dedupe_key => 'client_arrived:fa000000-0000-0000-0000-0000000000b9');

select '15_DEDUPE_RETURNS_THE_SAME_NOTIFICATION' as case,
       case when (select v from ids where k='d1') = (select v from ids where k='d2')
             and (select count(*) from comms.notifications
                  where dedupe_key='client_arrived:fa000000-0000-0000-0000-0000000000b9') = 1
       then 'PASS' else 'FAIL: a retried event created a second notification' end as result;

select '16_DEDUPE_DOES_NOT_REFAN_OUT' as case,
       case when (select count(*) from comms.notification_recipients r
                  join ids on ids.k='d1' and ids.v = r.notification_id) = 1
       then 'PASS' else 'FAIL: the retry added a duplicate recipient row' end as result;

select '17_DEDUPE_FLAG_IS_REPORTED' as case,
       case when (select deduplicated from comms.create_notification(
                    p_business_id => 'fa000000-0000-0000-0000-000000000001',
                    p_type => 'client_arrived', p_title => 'Arrived', p_body => 'b',
                    p_recipient_user_profile_ids => array['fa000000-0000-0000-0000-0000000000f3']::uuid[],
                    p_dedupe_key => 'client_arrived:fa000000-0000-0000-0000-0000000000b9'))
       then 'PASS' else 'FAIL: a deduplicated call must report deduplicated = true' end as result;

-- NULL dedupe keys are "no dedupe" and must never collide with each other.
select '18_NULL_DEDUPE_KEYS_DO_NOT_COLLIDE' as case,
       case when (select notification_id from comms.create_notification(
                    p_business_id => 'fa000000-0000-0000-0000-000000000001',
                    p_type => 'system', p_title => 'nodedupe', p_body => 'b',
                    p_recipient_user_profile_ids => array['fa000000-0000-0000-0000-0000000000f3']::uuid[]))
                 is distinct from
                 (select notification_id from comms.create_notification(
                    p_business_id => 'fa000000-0000-0000-0000-000000000001',
                    p_type => 'system', p_title => 'nodedupe', p_body => 'b',
                    p_recipient_user_profile_ids => array['fa000000-0000-0000-0000-0000000000f3']::uuid[]))
       then 'PASS' else 'FAIL: two NULL-key notifications collapsed into one' end as result;

-- The dedupe key is per business: the same key in another tenant is a different event.
select '19_DEDUPE_KEY_IS_PER_BUSINESS' as case,
       case when (select notification_id from comms.create_notification(
                    p_business_id => 'fa000000-0000-0000-0000-000000000002',
                    p_type => 'client_arrived', p_title => 'Arrived', p_body => 'b',
                    p_recipient_user_profile_ids => array['fa000000-0000-0000-0000-0000000000f6']::uuid[],
                    p_dedupe_key => 'client_arrived:fa000000-0000-0000-0000-0000000000b9'))
                 is distinct from (select v from ids where k='d1')
       then 'PASS' else 'FAIL: a dedupe key leaked across tenants' end as result;

-- ===========================================================================
-- 20-23. READ / UNREAD STATE, AND THE POINT OF A SEPARATE RECIPIENT TABLE:
--        the Owner reading a notification must NOT mark it read for the Manager.
-- ===========================================================================
insert into ids (k, v)
select 'n5', notification_id from comms.create_notification(
  p_business_id => 'fa000000-0000-0000-0000-000000000001',
  p_type => 'order_approval_required',
  p_title => 'Approval needed', p_body => 'A purchase order needs approval.',
  p_recipient_user_profile_ids => array[
    'fa000000-0000-0000-0000-0000000000f1',
    'fa000000-0000-0000-0000-0000000000f2']::uuid[]);

update comms.notification_recipients r
set read_at = now()
from ids
where ids.k='n5' and r.notification_id = ids.v
  and r.user_profile_id='fa000000-0000-0000-0000-0000000000f1';

select '20_MARK_READ_SETS_TIMESTAMP' as case,
       case when exists (
         select 1 from comms.notification_recipients r join ids on ids.k='n5' and ids.v=r.notification_id
         where r.user_profile_id='fa000000-0000-0000-0000-0000000000f1' and r.read_at is not null)
       then 'PASS' else 'FAIL: read_at was not set' end as result;

select '21_READ_STATE_IS_PER_RECIPIENT' as case,
       case when exists (
         select 1 from comms.notification_recipients r join ids on ids.k='n5' and ids.v=r.notification_id
         where r.user_profile_id='fa000000-0000-0000-0000-0000000000f2' and r.read_at is null)
       then 'PASS' else 'FAIL: one recipient reading it marked it read for the other' end as result;

update comms.notification_recipients r
set read_at = null
from ids
where ids.k='n5' and r.notification_id = ids.v
  and r.user_profile_id='fa000000-0000-0000-0000-0000000000f1';

select '22_MARK_UNREAD_CLEARS_TIMESTAMP' as case,
       case when exists (
         select 1 from comms.notification_recipients r join ids on ids.k='n5' and ids.v=r.notification_id
         where r.user_profile_id='fa000000-0000-0000-0000-0000000000f1' and r.read_at is null)
       then 'PASS' else 'FAIL: mark-unread did not clear read_at' end as result;

-- The unread count is a per-user, per-business figure over unread rows only.
select '23_UNREAD_COUNT_IS_PER_USER' as case,
       case when (select count(*) from comms.notification_recipients
                  where user_profile_id='fa000000-0000-0000-0000-0000000000f2'
                    and business_id='fa000000-0000-0000-0000-000000000001'
                    and read_at is null) > 0
             and (select count(*) from comms.notification_recipients
                  where user_profile_id='fa000000-0000-0000-0000-0000000000f6'
                    and business_id='fa000000-0000-0000-0000-000000000001'
                    and read_at is null) = 0
       then 'PASS' else 'FAIL: unread counts are not isolated per user' end as result;

-- ===========================================================================
-- 24-26. STRUCTURAL INVARIANTS.
-- ===========================================================================
do $probe$
declare v_nid uuid;
begin
  select v into v_nid from ids where k='n1';
  -- business_id must match the parent notification's, or the row would surface in
  -- the wrong tenant's feed (the feed query trusts this column instead of joining).
  insert into comms.notification_recipients (notification_id, business_id, user_profile_id)
  values (v_nid, 'fa000000-0000-0000-0000-000000000002', 'fa000000-0000-0000-0000-0000000000f6');
  insert into probe_results values ('24_RECIPIENT_BUSINESS_MISMATCH_REJECTED','FAIL: a mismatched business_id was accepted');
exception when others then
  insert into probe_results values ('24_RECIPIENT_BUSINESS_MISMATCH_REJECTED','PASS');
end
$probe$;
select case_name as case, result from probe_results where case_name='24_RECIPIENT_BUSINESS_MISMATCH_REJECTED';

do $probe$
begin
  insert into comms.notifications (business_id, type, title, body, entity_type)
  values ('fa000000-0000-0000-0000-000000000001','system','t','b','appointment');
  insert into probe_results values ('25_ENTITY_PAIRING_ENFORCED','FAIL: entity_type without entity_id was accepted');
exception when others then
  insert into probe_results values ('25_ENTITY_PAIRING_ENFORCED','PASS');
end
$probe$;
select case_name as case, result from probe_results where case_name='25_ENTITY_PAIRING_ENFORCED';

do $probe$
begin
  insert into comms.notifications (business_id, type, title, body, priority)
  values ('fa000000-0000-0000-0000-000000000001','system','t','b','catastrophic');
  insert into probe_results values ('26_PRIORITY_IS_CONSTRAINED','FAIL: an unknown priority was accepted');
exception when others then
  insert into probe_results values ('26_PRIORITY_IS_CONSTRAINED','PASS');
end
$probe$;
select case_name as case, result from probe_results where case_name='26_PRIORITY_IS_CONSTRAINED';

-- Deleting a notification takes its recipient rows with it (no orphan state).
do $probe$
declare v_nid uuid; v_left integer;
begin
  select notification_id into v_nid from comms.create_notification(
    p_business_id => 'fa000000-0000-0000-0000-000000000001',
    p_type => 'system', p_title => 'cascade probe', p_body => 'b',
    p_recipient_user_profile_ids => array['fa000000-0000-0000-0000-0000000000f3']::uuid[]);
  delete from comms.notifications where id = v_nid;
  select count(*) into v_left from comms.notification_recipients where notification_id = v_nid;
  insert into probe_results values ('27_RECIPIENTS_CASCADE_WITH_NOTIFICATION',
    case when v_left = 0 then 'PASS' else 'FAIL: ' || v_left || ' orphan recipient rows survived' end);
end
$probe$;
select case_name as case, result from probe_results where case_name='27_RECIPIENTS_CASCADE_WITH_NOTIFICATION';

-- ===========================================================================
-- 28-33. DEVICE FOUNDATION.
-- ===========================================================================
insert into ids (k, v)
select 'dev1', comms.register_user_device(
  'fa000000-0000-0000-0000-000000000001',
  'fa000000-0000-0000-0000-0000000000f3',
  'installation-aaa', 'ios', 'ExponentPushToken[AAA]');

select '28_DEVICE_REGISTERS' as case,
       case when exists (
         select 1 from comms.user_devices d join ids on ids.k='dev1' and ids.v=d.id
         where d.user_profile_id='fa000000-0000-0000-0000-0000000000f3'
           and d.platform='ios' and d.enabled and d.push_token='ExponentPushToken[AAA]'
           and d.last_seen_at is not null)
       then 'PASS' else 'FAIL: device was not registered as supplied' end as result;

-- Re-registering the SAME installation updates the row; it must not accumulate.
insert into ids (k, v)
select 'dev1b', comms.register_user_device(
  'fa000000-0000-0000-0000-000000000001',
  'fa000000-0000-0000-0000-0000000000f3',
  'installation-aaa', 'ios', 'ExponentPushToken[AAA2]');

select '29_DEVICE_REREGISTER_UPDATES_IN_PLACE' as case,
       case when (select v from ids where k='dev1') = (select v from ids where k='dev1b')
             and (select count(*) from comms.user_devices
                  where user_profile_id='fa000000-0000-0000-0000-0000000000f3'
                    and device_identifier='installation-aaa') = 1
             and (select push_token from comms.user_devices
                  where device_identifier='installation-aaa') = 'ExponentPushToken[AAA2]'
       then 'PASS' else 'FAIL: re-registration duplicated the device or lost the rotated token' end as result;

-- Omitting the token on a refresh keeps the stored one rather than clearing it.
do $probe$
declare v_id uuid; v_token text;
begin
  v_id := comms.register_user_device(
    'fa000000-0000-0000-0000-000000000001',
    'fa000000-0000-0000-0000-0000000000f3',
    'installation-aaa', 'ios', null);
  select push_token into v_token from comms.user_devices where id = v_id;
  insert into probe_results values ('30_DEVICE_OMITTED_TOKEN_IS_PRESERVED',
    case when v_token = 'ExponentPushToken[AAA2]' then 'PASS'
         else 'FAIL: a token-less refresh changed the stored token to ' || coalesce(v_token,'NULL') end);
end
$probe$;
select case_name as case, result from probe_results where case_name='30_DEVICE_OMITTED_TOKEN_IS_PRESERVED';

-- Token takeover: the same physical device handed to another user must not leave
-- two enabled rows pointing at one token, or it would be pushed to twice.
insert into ids (k, v)
select 'dev2', comms.register_user_device(
  'fa000000-0000-0000-0000-000000000001',
  'fa000000-0000-0000-0000-0000000000f2',
  'installation-bbb', 'ios', 'ExponentPushToken[AAA2]');

select '31_PUSH_TOKEN_TAKEOVER_DISABLES_PREVIOUS' as case,
       case when (select count(*) from comms.user_devices
                  where push_token='ExponentPushToken[AAA2]' and enabled) = 1
             and (select enabled from comms.user_devices where device_identifier='installation-aaa') = false
             and (select enabled from comms.user_devices where device_identifier='installation-bbb') = true
       then 'PASS' else 'FAIL: one push token is enabled on more than one device' end as result;

do $probe$
begin
  -- Direct insert of a second ENABLED row with a live token must be impossible.
  insert into comms.user_devices (business_id, user_profile_id, device_identifier, platform, push_token, enabled)
  values ('fa000000-0000-0000-0000-000000000001','fa000000-0000-0000-0000-0000000000f4',
          'installation-ccc','android','ExponentPushToken[AAA2]',true);
  insert into probe_results values ('32_DUPLICATE_ENABLED_TOKEN_BLOCKED','FAIL: a duplicate enabled push token was accepted');
exception when unique_violation then
  insert into probe_results values ('32_DUPLICATE_ENABLED_TOKEN_BLOCKED','PASS');
when others then
  insert into probe_results values ('32_DUPLICATE_ENABLED_TOKEN_BLOCKED','FAIL: unexpected ' || sqlerrm);
end
$probe$;
select case_name as case, result from probe_results where case_name='32_DUPLICATE_ENABLED_TOKEN_BLOCKED';

do $probe$
begin
  -- A user from another business cannot have a device registered against this one.
  perform comms.register_user_device(
    'fa000000-0000-0000-0000-000000000001',
    'fa000000-0000-0000-0000-0000000000f6',
    'installation-ddd', 'ios', 'ExponentPushToken[DDD]');
  insert into probe_results values ('33_DEVICE_CROSS_BUSINESS_REJECTED','FAIL: cross-business device assignment was accepted');
exception when others then
  insert into probe_results values ('33_DEVICE_CROSS_BUSINESS_REJECTED','PASS');
end
$probe$;
select case_name as case, result from probe_results where case_name='33_DEVICE_CROSS_BUSINESS_REJECTED';

-- ===========================================================================
-- 34-42. ROW-LEVEL SECURITY, exercised as the real `authenticated` role with the
--        real JWT claim PostgREST would set. comms is PostgREST-exposed, so these
--        policies are the only thing standing between a stylist's access token and
--        every other user's notifications.
-- ===========================================================================

-- 34. A recipient sees their own rows.
do $probe$
declare v_n integer;
begin
  perform set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  select count(*) into v_n from comms.notification_recipients;
  reset role;
  insert into probe_results values ('34_RECIPIENT_SEES_OWN_ROWS',
    case when v_n > 0 then 'PASS' else 'FAIL: a recipient could not read their own notifications' end);
exception when others then
  reset role;
  insert into probe_results values ('34_RECIPIENT_SEES_OWN_ROWS','FAIL: ' || sqlerrm);
end
$probe$;
select case_name as case, result from probe_results where case_name='34_RECIPIENT_SEES_OWN_ROWS';

-- 35. …and ONLY their own. This is the core isolation guarantee.
do $probe$
declare v_other integer;
begin
  perform set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  select count(*) into v_other from comms.notification_recipients
   where user_profile_id <> 'fa000000-0000-0000-0000-0000000000f3';
  reset role;
  insert into probe_results values ('35_RECIPIENT_CANNOT_SEE_OTHERS',
    case when v_other = 0 then 'PASS'
         else 'FAIL: ' || v_other || ' other users'' recipient rows were visible' end);
exception when others then
  reset role;
  insert into probe_results values ('35_RECIPIENT_CANNOT_SEE_OTHERS','FAIL: ' || sqlerrm);
end
$probe$;
select case_name as case, result from probe_results where case_name='35_RECIPIENT_CANNOT_SEE_OTHERS';

-- 36. The OWNER does not inherit a stylist's personal feed. Notification n1 was
--     addressed to the stylist alone; the owner holds every management permission
--     in the business and must still not see it.
do $probe$
declare v_seen integer; v_n1 uuid;
begin
  -- Resolve the id BEFORE switching role: the temp results/ids tables belong to the
  -- suite, not to `authenticated`, and reading them mid-probe would fail for the
  -- wrong reason and mask the real verdict.
  select v into v_n1 from ids where k='n1';
  perform set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-0000000000f1',true);
  set local role authenticated;
  select count(*) into v_seen from comms.notifications n where n.id = v_n1;
  reset role;
  insert into probe_results values ('36_OWNER_CANNOT_READ_STAFF_NOTIFICATION',
    case when v_seen = 0 then 'PASS'
         else 'FAIL: the owner could read a notification addressed only to a stylist' end);
exception when others then
  reset role;
  insert into probe_results values ('36_OWNER_CANNOT_READ_STAFF_NOTIFICATION','FAIL: ' || sqlerrm);
end
$probe$;
select case_name as case, result from probe_results where case_name='36_OWNER_CANNOT_READ_STAFF_NOTIFICATION';

-- 37. A recipient CAN read the notification body addressed to them.
do $probe$
declare v_seen integer; v_n1 uuid;
begin
  select v into v_n1 from ids where k='n1';
  perform set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  select count(*) into v_seen from comms.notifications n where n.id = v_n1;
  reset role;
  insert into probe_results values ('37_RECIPIENT_CAN_READ_ITS_NOTIFICATION',
    case when v_seen = 1 then 'PASS' else 'FAIL: a recipient could not read their own notification' end);
exception when others then
  reset role;
  insert into probe_results values ('37_RECIPIENT_CAN_READ_ITS_NOTIFICATION','FAIL: ' || sqlerrm);
end
$probe$;
select case_name as case, result from probe_results where case_name='37_RECIPIENT_CAN_READ_ITS_NOTIFICATION';

-- 38. A user in ANOTHER business sees nothing of this one.
do $probe$
declare v_seen integer;
begin
  perform set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-0000000000f6',true);
  set local role authenticated;
  select count(*) into v_seen from comms.notification_recipients
   where business_id = 'fa000000-0000-0000-0000-000000000001';
  reset role;
  insert into probe_results values ('38_CROSS_BUSINESS_USER_SEES_NOTHING',
    case when v_seen = 0 then 'PASS' else 'FAIL: a rival business''s user read our notifications' end);
exception when others then
  reset role;
  insert into probe_results values ('38_CROSS_BUSINESS_USER_SEES_NOTHING','FAIL: ' || sqlerrm);
end
$probe$;
select case_name as case, result from probe_results where case_name='38_CROSS_BUSINESS_USER_SEES_NOTHING';

-- 39. A browser cannot FABRICATE a notification — for anyone, including itself.
--     This is what makes targeting server-controlled at the database, not just in
--     the API.
do $probe$
begin
  perform set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  insert into comms.notifications (business_id, type, title, body)
  values ('fa000000-0000-0000-0000-000000000001','system','forged','forged');
  reset role;
  insert into probe_results values ('39_AUTHENTICATED_CANNOT_CREATE_NOTIFICATION','FAIL: a normal user inserted a notification');
exception when others then
  reset role;
  insert into probe_results values ('39_AUTHENTICATED_CANNOT_CREATE_NOTIFICATION',
    case when sqlstate = '42501' then 'PASS' else 'FAIL: blocked, but by ' || sqlstate || ' (' || sqlerrm || ')' end);
end
$probe$;
select case_name as case, result from probe_results where case_name='39_AUTHENTICATED_CANNOT_CREATE_NOTIFICATION';

-- 40. …and cannot mark ANOTHER user's notification read.
do $probe$
declare v_rows integer;
begin
  perform set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  update comms.notification_recipients
     set read_at = now()
   where user_profile_id = 'fa000000-0000-0000-0000-0000000000f2';
  get diagnostics v_rows = row_count;
  reset role;
  -- RLS filters the row out rather than raising, so zero rows updated is the pass.
  insert into probe_results values ('40_CANNOT_MARK_ANOTHER_USERS_ROW_READ',
    case when v_rows = 0 then 'PASS' else 'FAIL: updated ' || v_rows || ' of another user''s rows' end);
exception when others then
  reset role;
  insert into probe_results values ('40_CANNOT_MARK_ANOTHER_USERS_ROW_READ',
    case when sqlstate = '42501' then 'PASS' else 'FAIL: ' || sqlerrm end);
end
$probe$;
select case_name as case, result from probe_results where case_name='40_CANNOT_MARK_ANOTHER_USERS_ROW_READ';

-- 41. The column-level grant is what stops a user REPOINTING their own recipient
--     row at someone else — RLS alone cannot restrict which columns an update
--     touches, so read/seen state is the only thing granted.
do $probe$
begin
  perform set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  update comms.notification_recipients
     set user_profile_id = 'fa000000-0000-0000-0000-0000000000f2'
   where user_profile_id = 'fa000000-0000-0000-0000-0000000000f3';
  reset role;
  insert into probe_results values ('41_CANNOT_REPOINT_OWN_RECIPIENT_ROW','FAIL: a user reassigned their recipient row');
exception when others then
  reset role;
  insert into probe_results values ('41_CANNOT_REPOINT_OWN_RECIPIENT_ROW',
    case when sqlstate = '42501' then 'PASS' else 'FAIL: blocked by ' || sqlstate || ' (' || sqlerrm || ')' end);
end
$probe$;
select case_name as case, result from probe_results where case_name='41_CANNOT_REPOINT_OWN_RECIPIENT_ROW';

-- 41b. THE ESCALATION THIS SUITE EXISTS TO CATCH. The comms schema carries
--      ALTER DEFAULT PRIVILEGES from 0002 that grant `authenticated` full
--      SELECT/INSERT/UPDATE/DELETE on every new table automatically. With that
--      table-wide UPDATE still in place, the RLS policy alone is NOT enough: its
--      WITH CHECK only pins user_profile_id, so a stylist could repoint their own
--      recipient row at the OWNER's notification and then read its content through
--      the recipient-based SELECT policy. 0099 revokes first and re-grants UPDATE
--      on (seen_at, read_at) only. If someone ever drops that revoke, this case
--      fails and says why.
do $probe$
declare v_owner_only uuid; v_leaked integer := 0;
begin
  -- A notification addressed to the OWNER alone.
  select notification_id into v_owner_only from comms.create_notification(
    p_business_id => 'fa000000-0000-0000-0000-000000000001',
    p_type => 'system', p_title => 'owner eyes only', p_body => 'confidential',
    p_recipient_user_profile_ids => array['fa000000-0000-0000-0000-0000000000f1']::uuid[]);

  perform set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  begin
    update comms.notification_recipients
       set notification_id = v_owner_only
     where user_profile_id = 'fa000000-0000-0000-0000-0000000000f3';
    -- If the update were permitted, the stylist would now read the owner's body.
    select count(*) into v_leaked from comms.notifications where id = v_owner_only;
    reset role;
    insert into probe_results values ('41B_CANNOT_REPOINT_ROW_AT_ANOTHERS_NOTIFICATION',
      case when v_leaked = 0 then 'PASS'
           else 'FAIL: a stylist repointed their row and read the owner''s notification' end);
  exception when others then
    reset role;
    insert into probe_results values ('41B_CANNOT_REPOINT_ROW_AT_ANOTHERS_NOTIFICATION',
      case when sqlstate = '42501' then 'PASS'
           else 'FAIL: blocked by ' || sqlstate || ' (' || sqlerrm || ')' end);
  end;
end
$probe$;
select case_name as case, result from probe_results where case_name='41B_CANNOT_REPOINT_ROW_AT_ANOTHERS_NOTIFICATION';

-- 41c. The same default-privileges trap applied to DELETE: a user must not be able
--      to delete notifications or their own recipient rows out from under the audit
--      trail.
do $probe$
declare v_deleted integer := -1;
begin
  perform set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  begin
    delete from comms.notification_recipients
     where user_profile_id = 'fa000000-0000-0000-0000-0000000000f3';
    get diagnostics v_deleted = row_count;
    reset role;
    insert into probe_results values ('41C_CANNOT_DELETE_OWN_RECIPIENT_ROWS',
      case when v_deleted = 0 then 'PASS'
           else 'FAIL: a user deleted ' || v_deleted || ' of their recipient rows' end);
  exception when others then
    reset role;
    insert into probe_results values ('41C_CANNOT_DELETE_OWN_RECIPIENT_ROWS',
      case when sqlstate = '42501' then 'PASS'
           else 'FAIL: blocked by ' || sqlstate || ' (' || sqlerrm || ')' end);
  end;
end
$probe$;
select case_name as case, result from probe_results where case_name='41C_CANNOT_DELETE_OWN_RECIPIENT_ROWS';

-- 42. A push token is a delivery address; it is excluded from the authenticated
--     column grant so it cannot be read back over PostgREST even by its owner.
do $probe$
begin
  perform set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  perform push_token from comms.user_devices
   where user_profile_id = 'fa000000-0000-0000-0000-0000000000f3';
  reset role;
  insert into probe_results values ('42_PUSH_TOKEN_NOT_READABLE','FAIL: push_token was readable by authenticated');
exception when others then
  reset role;
  insert into probe_results values ('42_PUSH_TOKEN_NOT_READABLE',
    case when sqlstate = '42501' then 'PASS' else 'FAIL: blocked by ' || sqlstate || ' (' || sqlerrm || ')' end);
end
$probe$;
select case_name as case, result from probe_results where case_name='42_PUSH_TOKEN_NOT_READABLE';

-- 43. The creation functions are service-role only. A leaked anon/authenticated
--     key must not be able to call them directly (the 0071 -> 0078 precedent:
--     every new function needs its PUBLIC execute revoked).
select '43_FUNCTIONS_ARE_SERVICE_ROLE_ONLY' as case,
       case when not has_function_privilege('authenticated',
              'comms.create_notification(uuid,text,text,text,uuid[],uuid,text,text,uuid,text,jsonb,text,uuid,timestamptz)','execute')
             and not has_function_privilege('anon',
              'comms.create_notification(uuid,text,text,text,uuid[],uuid,text,text,uuid,text,jsonb,text,uuid,timestamptz)','execute')
             and not has_function_privilege('authenticated',
              'comms.register_user_device(uuid,uuid,text,text,text)','execute')
             and not has_function_privilege('anon',
              'comms.register_user_device(uuid,uuid,text,text,text)','execute')
             and has_function_privilege('service_role',
              'comms.create_notification(uuid,text,text,text,uuid[],uuid,text,text,uuid,text,jsonb,text,uuid,timestamptz)','execute')
       then 'PASS' else 'FAIL: notification functions are callable by a non-service role' end as result;

-- 44. anon gets nothing at all.
select '44_ANON_HAS_NO_TABLE_ACCESS' as case,
       case when not has_table_privilege('anon','comms.notifications','select')
             and not has_table_privilege('anon','comms.notification_recipients','select')
             and not has_table_privilege('anon','comms.user_devices','select')
       then 'PASS' else 'FAIL: anon can read the notification tables' end as result;

-- 45. RLS is actually switched on (a policy on a table without RLS enabled is
--     decoration).
select '45_RLS_IS_ENABLED_ON_ALL_THREE' as case,
       case when (select bool_and(relrowsecurity) from pg_class
                  where oid in ('comms.notifications'::regclass,
                                'comms.notification_recipients'::regclass,
                                'comms.user_devices'::regclass))
       then 'PASS' else 'FAIL: RLS is not enabled on every notification table' end as result;

-- 46. The feed and badge indexes exist — an unindexed feed is a production
--     incident waiting for the first busy salon.
select '46_FEED_AND_UNREAD_INDEXES_EXIST' as case,
       case when exists (select 1 from pg_indexes where schemaname='comms' and indexname='idx_notification_recipients_feed')
             and exists (select 1 from pg_indexes where schemaname='comms' and indexname='idx_notification_recipients_unread')
             and exists (select 1 from pg_indexes where schemaname='comms' and indexname='idx_notifications_dedupe_unique')
       then 'PASS' else 'FAIL: a required index is missing' end as result;

-- ===========================================================================
-- 46b/46c. comms.user_devices RLS, as a MATCHED PAIR — mirroring cases 34/35.
--     Case 42 alone is not enough: it passes on the push_token COLUMN grant, so it
--     would still pass if comms_user_devices_own_select were `using (true)` or
--     dropped entirely, and case 44 only covers `anon` while case 45 only checks
--     that RLS is switched on. Without a positive control there is nothing proving
--     the policy exists at all, and without the negative one nothing proving it
--     restricts anything — a stylist could then enumerate every colleague's device
--     rows over PostgREST with their own token.
-- ===========================================================================
do $probe$
declare v_own integer; v_others integer;
begin
  perform set_config('request.jwt.claim.sub','fa000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  -- Positive control: the granted columns of my own device row ARE readable.
  select count(*) into v_own from comms.user_devices
   where user_profile_id = 'fa000000-0000-0000-0000-0000000000f3';
  -- Negative control: nobody else's are.
  select count(*) into v_others from comms.user_devices
   where user_profile_id <> 'fa000000-0000-0000-0000-0000000000f3';
  reset role;
  insert into probe_results values ('46B_USER_SEES_OWN_DEVICES',
    case when v_own > 0 then 'PASS'
         else 'FAIL: a user could not read their own device row' end);
  insert into probe_results values ('46C_USER_CANNOT_SEE_OTHERS_DEVICES',
    case when v_others = 0 then 'PASS'
         else 'FAIL: ' || v_others || ' other users'' device rows were visible' end);
exception when others then
  reset role;
  insert into probe_results values ('46B_USER_SEES_OWN_DEVICES','FAIL: ' || sqlerrm);
  insert into probe_results values ('46C_USER_CANNOT_SEE_OTHERS_DEVICES','FAIL: ' || sqlerrm);
end
$probe$;
select case_name as case, result from probe_results
where case_name in ('46B_USER_SEES_OWN_DEVICES','46C_USER_CANNOT_SEE_OTHERS_DEVICES')
order by case_name;

-- ===========================================================================
-- 47. THE ARRIVAL JOIN PATH. ArrivalNotificationService turns an appointment into
--     a recipient by walking
--       booking.appointments.assigned_staff_profile_id
--         -> core.staff_profiles.user_profile_id
--         -> core.user_profiles.id
--     and nothing else in the appointment code path does that today — every other
--     staff lookup selects display_name only. It is the one schema shape the
--     producer assumes but did not create, so it is pinned here: if a future
--     migration renames or re-points either column, this fails loudly instead of
--     the arrival alert silently going to nobody.
-- ===========================================================================
insert into core.staff_profiles
  (id, business_id, user_profile_id, primary_location_id, display_name, q_code)
values
  ('fa000000-0000-0000-0000-000000000051','fa000000-0000-0000-0000-000000000001',
   'fa000000-0000-0000-0000-0000000000f3','fa000000-0000-0000-0000-0000000000a1','Sam','FAQ00001');

insert into core.client_profiles (id,business_id,client_code,first_name,last_name)
values ('fa000000-0000-0000-0000-0000000000c1','fa000000-0000-0000-0000-000000000001','FACCCC01','Jane','Smith');

insert into booking.appointments
  (id, business_id, location_id, client_profile_id, assigned_staff_profile_id,
   status, scheduled_start_at, scheduled_end_at, occupied_ranges)
values
  ('fa000000-0000-0000-0000-0000000000b1','fa000000-0000-0000-0000-000000000001',
   'fa000000-0000-0000-0000-0000000000a1','fa000000-0000-0000-0000-0000000000c1',
   'fa000000-0000-0000-0000-000000000051','checked_in',
   now() + interval '1 hour', now() + interval '2 hours',
   tstzmultirange(tstzrange(now() + interval '1 hour', now() + interval '2 hours')));

select '47_ARRIVAL_RESOLVES_THE_STYLIST_USER' as case,
       case when (
         select sp.user_profile_id
         from booking.appointments a
         join core.staff_profiles sp
           on sp.id = a.assigned_staff_profile_id
          and sp.business_id = a.business_id
         where a.id = 'fa000000-0000-0000-0000-0000000000b1'
       ) = 'fa000000-0000-0000-0000-0000000000f3'
       then 'PASS' else 'FAIL: appointment -> staff -> user no longer resolves' end as result;

-- ===========================================================================
-- 48. AND THAT USER IS AN ELIGIBLE RECIPIENT AT THE APPOINTMENT'S LOCATION.
--     Resolving the stylist is only half of it — the arrival notification is
--     location-scoped, so the resolved user must also survive create_notification's
--     eligibility filter for that location. This is the end-to-end arrival contract.
-- ===========================================================================
select '48_ARRIVAL_REACHES_THAT_STYLIST' as case,
       case when (
         select recipient_count from comms.create_notification(
           p_business_id => 'fa000000-0000-0000-0000-000000000001',
           p_type => 'client_arrived',
           p_title => 'Client arrived',
           p_body => 'Jane has arrived.',
           p_recipient_user_profile_ids => array[(
             select sp.user_profile_id
             from booking.appointments a
             join core.staff_profiles sp on sp.id = a.assigned_staff_profile_id
             where a.id = 'fa000000-0000-0000-0000-0000000000b1'
           )]::uuid[],
           p_location_id => 'fa000000-0000-0000-0000-0000000000a1',
           p_entity_type => 'appointment',
           p_entity_id => 'fa000000-0000-0000-0000-0000000000b1',
           p_dedupe_key => 'client_arrived:fa000000-0000-0000-0000-0000000000b1')
       ) = 1
       then 'PASS' else 'FAIL: the assigned stylist was not an eligible recipient' end as result;

-- ---------------------------------------------------------------------------
-- Teardown — nothing this suite created survives.
-- ---------------------------------------------------------------------------
rollback;
