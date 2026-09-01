-- arrival_push_delivery.sql — behavioural suite for migration 0102.
--
-- WHY THIS FILE EXISTS. The Jest suites stub the Supabase client, so they can only
-- prove the SERVICES ask for the right things. Everything that makes push
-- targeting correct lives in the database: which devices a notification expands
-- to, that a disabled or token-less device is never targeted, that a repeated
-- enqueue cannot double-push, and that the function refuses to reach outside the
-- notification's own tenant. This file proves those for real.
--
-- 14 numbered cases. Read the RESULT column of each; every one must read PASS.
--
-- Run against a SCRATCH database with every migration through 0102 applied:
--   psql -d <scratch> -f supabase/tests/arrival_push_delivery.sql
--
-- The whole suite runs in one transaction that is rolled back at the end, so it
-- leaves no fixture rows behind and is re-runnable.

\set ON_ERROR_STOP off
\pset pager off

begin;

-- ---------------------------------------------------------------------------
-- Fixtures. 'fc' prefix, distinct from the 'fa' suite in in_app_notifications.sql.
--
-- Sam is the assigned stylist and carries two handsets. Sky is a second stylist
-- with no device at all (the "push not supported" case). Mo has a device that is
-- disabled. Rex belongs to a different business entirely.
-- ---------------------------------------------------------------------------
insert into core.businesses (id,name,slug) values
 ('fc000000-0000-0000-0000-000000000001','Push Salon','push-salon'),
 ('fc000000-0000-0000-0000-000000000002','Rival Push','rival-push');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('fc000000-0000-0000-0000-0000000000a1','fc000000-0000-0000-0000-000000000001','P1','Primrose Hill','fc-primrose','1 Regent Rd','London','NW1 8XL','Europe/London'),
 ('fc000000-0000-0000-0000-0000000000a2','fc000000-0000-0000-0000-000000000002','P2','Rival','fc-rival','9 Other St','Watford','WD1 1AA','Europe/London');

insert into auth.users (id,email) values
 ('fc000000-0000-0000-0000-0000000000f1'::uuid,'sam@fc.example'),
 ('fc000000-0000-0000-0000-0000000000f2'::uuid,'sky@fc.example'),
 ('fc000000-0000-0000-0000-0000000000f3'::uuid,'mo@fc.example'),
 ('fc000000-0000-0000-0000-0000000000f4'::uuid,'rex@fc.example');

insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name,is_active) values
 ('fc000000-0000-0000-0000-0000000000f1','sam@fc.example','Sam Stylist','Sam','Stylist','Sam',true),
 ('fc000000-0000-0000-0000-0000000000f2','sky@fc.example','Sky Stylist','Sky','Stylist','Sky',true),
 ('fc000000-0000-0000-0000-0000000000f3','mo@fc.example','Mo Manager','Mo','Manager','Mo',true),
 ('fc000000-0000-0000-0000-0000000000f4','rex@fc.example','Rex Rival','Rex','Rival','Rex',true);

insert into core.user_memberships (business_id,location_id,user_profile_id,role,status) values
 ('fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000a1','fc000000-0000-0000-0000-0000000000f1','stylist','active'),
 ('fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000a1','fc000000-0000-0000-0000-0000000000f2','stylist','active'),
 ('fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000a1','fc000000-0000-0000-0000-0000000000f3','manager','active'),
 ('fc000000-0000-0000-0000-000000000002','fc000000-0000-0000-0000-0000000000a2','fc000000-0000-0000-0000-0000000000f4','stylist','active');

-- Sam: phone + tablet, both live. Mo: disabled handset. A token-less row for Sam
-- covers the "registered but permission declined" state.
insert into comms.user_devices (id,business_id,user_profile_id,device_identifier,platform,push_token,enabled) values
 ('fc000000-0000-0000-0000-0000000000d1','fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000f1','sam-phone-0001','ios','ExponentPushToken[sam-phone]',true),
 ('fc000000-0000-0000-0000-0000000000d2','fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000f1','sam-tablet-001','android','ExponentPushToken[sam-tablet]',true),
 ('fc000000-0000-0000-0000-0000000000d3','fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000f1','sam-nopush-001','ios',null,true),
 ('fc000000-0000-0000-0000-0000000000d4','fc000000-0000-0000-0000-000000000001','fc000000-0000-0000-0000-0000000000f3','mo-phone-0001','ios','ExponentPushToken[mo-phone]',false),
 ('fc000000-0000-0000-0000-0000000000d5','fc000000-0000-0000-0000-000000000002','fc000000-0000-0000-0000-0000000000f4','rex-phone-001','ios','ExponentPushToken[rex-phone]',true);

create temporary table ids (k text primary key, v uuid) on commit drop;
create temporary table counts (k text primary key, v integer) on commit drop;

-- ===========================================================================
-- 1-4. THE ARRIVAL CASE. One notification for Sam expands to exactly his two
--      token-carrying, enabled devices — and to nobody else's.
-- ===========================================================================
insert into ids (k, v)
select 'n1', notification_id from comms.create_notification(
  p_business_id => 'fc000000-0000-0000-0000-000000000001',
  p_type => 'client_arrived',
  p_title => 'Client arrived',
  p_body => 'Jane has arrived.',
  p_recipient_user_profile_ids => array['fc000000-0000-0000-0000-0000000000f1']::uuid[],
  p_location_id => 'fc000000-0000-0000-0000-0000000000a1',
  p_entity_type => 'appointment',
  p_entity_id => 'fc000000-0000-0000-0000-0000000000b1',
  p_action_path => '/bookings?appointmentId=fc000000-0000-0000-0000-0000000000b1',
  p_dedupe_key => 'client_arrived:fc000000-0000-0000-0000-0000000000b1'
);

insert into counts (k, v)
select 'enq1', comms.enqueue_push_for_notification((select v from ids where k='n1'));

select '01_ENQUEUE_RETURNS_DEVICE_COUNT' as case,
       case when (select v from counts where k='enq1') = 2
       then 'PASS' else 'FAIL: expected 2 queued rows, got ' ||
            coalesce((select v::text from counts where k='enq1'),'null') end as result;

select '02_TARGETS_BOTH_ENABLED_DEVICES' as case,
       case when (select count(*) from comms.push_deliveries d
                  join ids on ids.k='n1' and ids.v = d.notification_id
                  where d.user_device_id in ('fc000000-0000-0000-0000-0000000000d1',
                                             'fc000000-0000-0000-0000-0000000000d2')) = 2
       then 'PASS' else 'FAIL: both of Sam''s live handsets must be targeted' end as result;

select '03_SKIPS_DEVICE_WITH_NO_TOKEN' as case,
       case when not exists (
         select 1 from comms.push_deliveries d
         join ids on ids.k='n1' and ids.v = d.notification_id
         where d.user_device_id='fc000000-0000-0000-0000-0000000000d3')
       -- Permission declined: the device is known but has no delivery address.
       then 'PASS' else 'FAIL: a device with no push token must never be queued' end as result;

select '04_QUEUED_ROWS_START_QUEUED_WITH_NO_ATTEMPTS' as case,
       case when (select count(*) from comms.push_deliveries d
                  join ids on ids.k='n1' and ids.v = d.notification_id
                  where d.status='queued' and d.attempts=0 and d.locked_until is null
                    and d.sent_at is null) = 2
       then 'PASS' else 'FAIL: new deliveries must start unclaimed' end as result;

-- ===========================================================================
-- 5-7. NON-RECIPIENTS. Push follows the notification's EXISTING recipients; it
--      never re-derives who should be told, so it cannot reach further.
-- ===========================================================================
select '05_OTHER_STYLIST_NOT_TARGETED' as case,
       case when not exists (
         select 1 from comms.push_deliveries d
         join ids on ids.k='n1' and ids.v = d.notification_id
         where d.user_profile_id='fc000000-0000-0000-0000-0000000000f2')
       then 'PASS' else 'FAIL: a colleague who was not a recipient got a push' end as result;

select '06_MANAGER_NOT_TARGETED_BY_DEFAULT' as case,
       case when not exists (
         select 1 from comms.push_deliveries d
         join ids on ids.k='n1' and ids.v = d.notification_id
         where d.user_profile_id='fc000000-0000-0000-0000-0000000000f3')
       -- Arrival goes to the assigned stylist. A manager is not a default recipient.
       then 'PASS' else 'FAIL: the manager must not be pushed by default' end as result;

select '07_CROSS_BUSINESS_DEVICE_NEVER_TARGETED' as case,
       case when not exists (
         select 1 from comms.push_deliveries d
         join ids on ids.k='n1' and ids.v = d.notification_id
         where d.user_device_id='fc000000-0000-0000-0000-0000000000d5')
       then 'PASS' else 'FAIL: a device in another business was targeted' end as result;

-- ===========================================================================
-- 8-9. DISABLED DEVICE. A stylist who signed out must stop receiving push, and
--      the row must not merely be filtered later by the sender.
-- ===========================================================================
insert into ids (k, v)
select 'n2', notification_id from comms.create_notification(
  p_business_id => 'fc000000-0000-0000-0000-000000000001',
  p_type => 'system',
  p_title => 'Notice',
  p_body => 'For the manager.',
  p_recipient_user_profile_ids => array['fc000000-0000-0000-0000-0000000000f3']::uuid[],
  p_location_id => 'fc000000-0000-0000-0000-0000000000a1'
);

insert into counts (k, v)
select 'enq2', comms.enqueue_push_for_notification((select v from ids where k='n2'));

select '08_DISABLED_DEVICE_QUEUES_NOTHING' as case,
       case when (select v from counts where k='enq2') = 0
       then 'PASS' else 'FAIL: a disabled device must never be queued' end as result;

select '09_RECIPIENT_WITH_NO_DEVICE_IS_NOT_AN_ERROR' as case,
       case when (select comms.enqueue_push_for_notification((
              select notification_id from comms.create_notification(
                p_business_id => 'fc000000-0000-0000-0000-000000000001',
                p_type => 'system',
                p_title => 'Notice',
                p_body => 'For Sky, who has no handset.',
                p_recipient_user_profile_ids => array['fc000000-0000-0000-0000-0000000000f2']::uuid[])))) = 0
       -- This is the in-app-only path, and it must return 0, not raise.
       then 'PASS' else 'FAIL: a recipient with no device must return 0 quietly' end as result;

-- ===========================================================================
-- 10-11. IDEMPOTENCY. A retried check-in, an API retry or a replayed job must
--        not buzz the stylist twice for one arrival.
-- ===========================================================================
insert into counts (k, v)
select 'enq1_again', comms.enqueue_push_for_notification((select v from ids where k='n1'));

select '10_REPEAT_ENQUEUE_CREATES_NOTHING' as case,
       case when (select v from counts where k='enq1_again') = 0
       then 'PASS' else 'FAIL: re-enqueueing must be a no-op, got ' ||
            coalesce((select v::text from counts where k='enq1_again'),'null') end as result;

select '11_STILL_EXACTLY_TWO_DELIVERIES' as case,
       case when (select count(*) from comms.push_deliveries d
                  join ids on ids.k='n1' and ids.v = d.notification_id) = 2
       then 'PASS' else 'FAIL: duplicate deliveries were created' end as result;

-- ===========================================================================
-- 12. UNKNOWN NOTIFICATION. A stale or deleted id must return 0 rather than
--     raising into the caller, whose notification has already been written.
-- ===========================================================================
select '12_UNKNOWN_NOTIFICATION_RETURNS_ZERO' as case,
       case when comms.enqueue_push_for_notification('fc000000-0000-0000-0000-0000000000ee') = 0
       then 'PASS' else 'FAIL: an unknown notification id must return 0' end as result;

-- ===========================================================================
-- 13-14. ACCESS CONTROL. The outbox is server-only: it names which handsets a
--        person carries, and nothing in any client reads it.
-- ===========================================================================
select '13_PUSH_DELIVERIES_RLS_ENABLED' as case,
       case when (select relrowsecurity from pg_class c
                  join pg_namespace n on n.oid=c.relnamespace
                  where n.nspname='comms' and c.relname='push_deliveries')
       then 'PASS' else 'FAIL: RLS must be enabled on comms.push_deliveries' end as result;

select '14_AUTHENTICATED_HAS_NO_GRANTS' as case,
       case when not exists (
         select 1 from information_schema.role_table_grants
         where table_schema='comms' and table_name='push_deliveries'
           and grantee in ('authenticated','anon'))
       -- 0002's ALTER DEFAULT PRIVILEGES grants authenticated full CRUD on every
       -- new comms table, so this passes only because 0102 revokes first.
       then 'PASS' else 'FAIL: anon/authenticated must hold no grant on the outbox' end as result;

rollback;
