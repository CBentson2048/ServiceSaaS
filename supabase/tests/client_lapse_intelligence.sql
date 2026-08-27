-- client_lapse_intelligence.sql — behavioural suite for migration 0097.
--
-- Covers ONLY what 0097 adds: crm.retention_settings, crm.client_service_history
-- and crm.client_next_bookings. The cadence/median/buffer arithmetic is NOT here
-- — it lives in @sheer/domain evaluateClientLapse() and is pinned by
-- apps/api/src/client-intelligence/lapse-rule.spec.ts. What this suite proves is
-- the part only a database can: which rows count as an attended service visit,
-- which upcoming appointments protect a client, and that neither leaks across a
-- tenant boundary.
--
-- Run against a SCRATCH database that has every migration through 0097 applied:
--   psql -d <scratch> -f supabase/tests/client_lapse_intelligence.sql
--
-- Graded by a human: each section prints what to look for. Fixture rows use a
-- fixed UUID prefix (0097....) and are removed by the teardown at the end, so
-- the suite is re-runnable and does not collide with the payroll suites.

\set ON_ERROR_STOP on
\pset pager off

\echo '=== 0097 lapsed-client intelligence verification ==='

-- ---------------------------------------------------------------------------
-- 0. Fixture
-- ---------------------------------------------------------------------------
begin;

insert into core.businesses (id, name, slug, timezone)
values ('00970000-0000-0000-0000-000000000001', 'Suite Salon A', 'suite-0097-a', 'Europe/London'),
       ('00970000-0000-0000-0000-000000000002', 'Suite Salon B', 'suite-0097-b', 'Europe/London');

insert into core.locations (id, business_id, code, name, slug, address_line_1, city, postal_code, timezone)
values ('00971000-0000-0000-0000-000000000001', '00970000-0000-0000-0000-000000000001', 'S1', 'Shoreditch', 'suite-0097-shoreditch', '1 Test St', 'London', 'E1 1AA', 'Europe/London'),
       ('00971000-0000-0000-0000-000000000002', '00970000-0000-0000-0000-000000000001', 'S2', 'Soho',       'suite-0097-soho',       '2 Test St', 'London', 'W1 1AA', 'Europe/London'),
       ('00971000-0000-0000-0000-000000000003', '00970000-0000-0000-0000-000000000002', 'S3', 'Other',      'suite-0097-other',      '3 Test St', 'London', 'N1 1AA', 'Europe/London');

insert into booking.service_categories (id, business_id, name)
values ('00972000-0000-0000-0000-000000000001', '00970000-0000-0000-0000-000000000001', 'Suite 0097 Colour');

insert into booking.services
  (id, business_id, location_id, slug, name, service_category_id, estimated_duration_minutes,
   is_active, rebooking_nudge_enabled, rebooking_nudge_interval_days)
values
  ('00973000-0000-0000-0000-000000000001', '00970000-0000-0000-0000-000000000001', null, 'suite-0097-colour',  'Suite Colour',  '00972000-0000-0000-0000-000000000001', 90, true,  true,  42),
  ('00973000-0000-0000-0000-000000000002', '00970000-0000-0000-0000-000000000001', null, 'suite-0097-cut',     'Suite Cut',     '00972000-0000-0000-0000-000000000001', 45, true,  true,  56),
  ('00973000-0000-0000-0000-000000000003', '00970000-0000-0000-0000-000000000001', null, 'suite-0097-wedding', 'Suite Wedding', null,                                   180, false, false, 35);

insert into core.client_profiles (id, business_id, primary_location_id, first_name, last_name)
values ('00974000-0000-0000-0000-000000000001', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', 'Jane',  'Suite'),
       ('00974000-0000-0000-0000-000000000002', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000002', 'Sarah', 'Suite'),
       ('00974000-0000-0000-0000-000000000003', '00970000-0000-0000-0000-000000000001', null,                                   'Walk',  'Suite'),
       ('00974000-0000-0000-0000-000000000004', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', 'Dupe',  'Suite'),
       ('00974000-0000-0000-0000-000000000005', '00970000-0000-0000-0000-000000000002', '00971000-0000-0000-0000-000000000003', 'Other', 'Tenant');

-- The duplicate is merged away — a tombstone must never surface anywhere.
update core.client_profiles
   set merged_into_id = '00974000-0000-0000-0000-000000000001'
 where id = '00974000-0000-0000-0000-000000000004';

-- Jane: a clean 42-day colour cadence (paid appointment + paid visit each time),
-- plus a one-off wedding styling after the last colour.
insert into booking.appointments
  (id, business_id, location_id, client_profile_id, status, scheduled_start_at, scheduled_end_at, completed_at, occupied_ranges)
values
  ('00975000-0000-0000-0000-000000000001', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'paid', '2026-01-05 10:00+00', '2026-01-05 11:30+00', '2026-01-05 11:30+00', tstzmultirange(tstzrange('2026-01-05 10:00+00','2026-01-05 11:30+00','[)'))),
  ('00975000-0000-0000-0000-000000000002', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'paid', '2026-02-16 10:00+00', '2026-02-16 11:30+00', '2026-02-16 11:30+00', tstzmultirange(tstzrange('2026-02-16 10:00+00','2026-02-16 11:30+00','[)'))),
  ('00975000-0000-0000-0000-000000000003', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'paid', '2026-03-30 10:00+00', '2026-03-30 11:30+00', '2026-03-30 11:30+00', tstzmultirange(tstzrange('2026-03-30 10:00+00','2026-03-30 11:30+00','[)'))),
  ('00975000-0000-0000-0000-000000000004', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'paid', '2026-05-11 10:00+00', '2026-05-11 11:30+00', '2026-05-11 11:30+00', tstzmultirange(tstzrange('2026-05-11 10:00+00','2026-05-11 11:30+00','[)'))),
  ('00975000-0000-0000-0000-000000000005', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'paid', '2026-05-21 09:00+00', '2026-05-21 12:00+00', '2026-05-21 12:00+00', tstzmultirange(tstzrange('2026-05-21 09:00+00','2026-05-21 12:00+00','[)'))),
  -- Rows that must NEVER count as an attended service visit.
  ('00975000-0000-0000-0000-000000000010', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'cancelled',  '2026-04-01 10:00+00', '2026-04-01 11:00+00', null, tstzmultirange(tstzrange('2026-04-01 10:00+00','2026-04-01 11:00+00','[)'))),
  ('00975000-0000-0000-0000-000000000011', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'no_show',    '2026-04-08 10:00+00', '2026-04-08 11:00+00', null, tstzmultirange(tstzrange('2026-04-08 10:00+00','2026-04-08 11:00+00','[)'))),
  ('00975000-0000-0000-0000-000000000012', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'rejected',   '2026-04-15 10:00+00', '2026-04-15 11:00+00', null, tstzmultirange(tstzrange('2026-04-15 10:00+00','2026-04-15 11:00+00','[)'))),
  ('00975000-0000-0000-0000-000000000013', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'accepted',   '2026-04-22 10:00+00', '2026-04-22 11:00+00', null, tstzmultirange(tstzrange('2026-04-22 10:00+00','2026-04-22 11:00+00','[)'))),
  ('00975000-0000-0000-0000-000000000014', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'checked_in', '2026-04-29 10:00+00', '2026-04-29 11:00+00', null, tstzmultirange(tstzrange('2026-04-29 10:00+00','2026-04-29 11:00+00','[)'))),
  -- A completed_at in the FUTURE (bad data) must not become a visit.
  ('00975000-0000-0000-0000-000000000015', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'paid', '2099-01-01 10:00+00', '2099-01-01 11:00+00', '2099-01-01 11:00+00', tstzmultirange(tstzrange('2099-01-01 10:00+00','2099-01-01 11:00+00','[)')));

insert into booking.appointment_services
  (business_id, location_id, appointment_id, service_id, sequence_no, service_name_snapshot, duration_minutes)
values
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000001', '00973000-0000-0000-0000-000000000001', 1, 'Suite Colour (2025 menu)', 90),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000002', '00973000-0000-0000-0000-000000000001', 1, 'Suite Colour (2025 menu)', 90),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000003', '00973000-0000-0000-0000-000000000001', 1, 'Suite Colour (2025 menu)', 90),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000004', '00973000-0000-0000-0000-000000000001', 1, 'Suite Colour (2025 menu)', 90),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000005', '00973000-0000-0000-0000-000000000003', 1, 'Suite Wedding', 180);

insert into booking.visits
  (business_id, location_id, appointment_id, client_profile_id, status, completed_at)
values
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'paid', '2026-01-05 11:30+00'),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000002', '00974000-0000-0000-0000-000000000001', 'paid', '2026-02-16 11:30+00'),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000003', '00974000-0000-0000-0000-000000000001', 'paid', '2026-03-30 11:30+00'),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000004', '00974000-0000-0000-0000-000000000001', 'paid', '2026-05-11 11:30+00'),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000005', '00974000-0000-0000-0000-000000000001', 'paid', '2026-05-21 12:00+00');

-- Sarah: two SAME-DAY appointments (colour + cut), then one multi-service
-- appointment at the OTHER location.
insert into booking.appointments
  (id, business_id, location_id, client_profile_id, status, scheduled_start_at, scheduled_end_at, completed_at, occupied_ranges)
values
  ('00975000-0000-0000-0000-000000000020', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000002', '00974000-0000-0000-0000-000000000002', 'paid', '2026-03-17 09:00+00', '2026-03-17 10:00+00', '2026-03-17 10:00+00', tstzmultirange(tstzrange('2026-03-17 09:00+00','2026-03-17 10:00+00','[)'))),
  ('00975000-0000-0000-0000-000000000021', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000002', '00974000-0000-0000-0000-000000000002', 'paid', '2026-03-17 14:00+00', '2026-03-17 15:00+00', '2026-03-17 15:00+00', tstzmultirange(tstzrange('2026-03-17 14:00+00','2026-03-17 15:00+00','[)'))),
  ('00975000-0000-0000-0000-000000000022', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000002', 'paid', '2026-04-28 09:00+00', '2026-04-28 11:00+00', '2026-04-28 11:00+00', tstzmultirange(tstzrange('2026-04-28 09:00+00','2026-04-28 11:00+00','[)')));

insert into booking.appointment_services
  (business_id, location_id, appointment_id, service_id, sequence_no, service_name_snapshot, duration_minutes)
values
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000002', '00975000-0000-0000-0000-000000000020', '00973000-0000-0000-0000-000000000001', 1, 'Suite Colour', 60),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000002', '00975000-0000-0000-0000-000000000021', '00973000-0000-0000-0000-000000000002', 1, 'Suite Cut', 60),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000022', '00973000-0000-0000-0000-000000000001', 1, 'Suite Colour', 60),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000022', '00973000-0000-0000-0000-000000000002', 2, 'Suite Cut', 60);

insert into booking.visits
  (business_id, location_id, appointment_id, client_profile_id, status, completed_at)
values
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000002', '00975000-0000-0000-0000-000000000020', '00974000-0000-0000-0000-000000000002', 'paid', '2026-03-17 10:00+00'),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000002', '00975000-0000-0000-0000-000000000021', '00974000-0000-0000-0000-000000000002', 'paid', '2026-03-17 15:00+00'),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00975000-0000-0000-0000-000000000022', '00974000-0000-0000-0000-000000000002', 'paid', '2026-04-28 11:00+00');

-- Walk-in: visits with NO appointment, exercising the whole timestamp ladder,
-- plus a cancelled visit that must not count. The 23:30 UTC one is 00:30 the
-- NEXT day in Europe/London.
insert into booking.visits
  (business_id, location_id, appointment_id, client_profile_id, status, completed_at, started_at, checked_in_at)
values
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', null, '00974000-0000-0000-0000-000000000003', 'completed',        '2026-03-01 12:00+00', null,                  null),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', null, '00974000-0000-0000-0000-000000000003', 'completed',        null,                  '2026-04-12 12:00+00', null),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', null, '00974000-0000-0000-0000-000000000003', 'awaiting_payment', null,                  null,                  '2026-06-30 23:30+00'),
  ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', null, '00974000-0000-0000-0000-000000000003', 'cancelled',        '2026-05-05 12:00+00', null,                  null);

-- The other tenant's identical-looking history.
insert into booking.appointments
  (id, business_id, location_id, client_profile_id, status, scheduled_start_at, scheduled_end_at, completed_at, occupied_ranges)
values
  ('00975000-0000-0000-0000-000000000030', '00970000-0000-0000-0000-000000000002', '00971000-0000-0000-0000-000000000003', '00974000-0000-0000-0000-000000000005', 'paid', '2026-03-01 10:00+00', '2026-03-01 11:00+00', '2026-03-01 11:00+00', tstzmultirange(tstzrange('2026-03-01 10:00+00','2026-03-01 11:00+00','[)')));

insert into booking.visits (business_id, location_id, appointment_id, client_profile_id, status, completed_at)
values ('00970000-0000-0000-0000-000000000002', '00971000-0000-0000-0000-000000000003', '00975000-0000-0000-0000-000000000030', '00974000-0000-0000-0000-000000000005', 'paid', '2026-03-01 11:00+00');

-- Upcoming appointments: one valid (the later of two), plus cancelled/no_show/
-- rejected ones that must give no protection at all.
insert into booking.appointments
  (id, business_id, location_id, client_profile_id, status, scheduled_start_at, scheduled_end_at, occupied_ranges)
values
  ('00975000-0000-0000-0000-000000000040', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'accepted',  now() + interval '20 days', now() + interval '20 days 1 hour', tstzmultirange(tstzrange(now() + interval '20 days', now() + interval '20 days 1 hour','[)'))),
  ('00975000-0000-0000-0000-000000000041', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000001', 'pending',   now() + interval '10 days', now() + interval '10 days 1 hour', tstzmultirange(tstzrange(now() + interval '10 days', now() + interval '10 days 1 hour','[)'))),
  ('00975000-0000-0000-0000-000000000042', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000002', '00974000-0000-0000-0000-000000000002', 'cancelled', now() + interval '5 days',  now() + interval '5 days 1 hour',  tstzmultirange(tstzrange(now() + interval '5 days', now() + interval '5 days 1 hour','[)'))),
  ('00975000-0000-0000-0000-000000000043', '00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', '00974000-0000-0000-0000-000000000003', 'no_show',   now() + interval '5 days',  now() + interval '5 days 1 hour',  tstzmultirange(tstzrange(now() + interval '5 days', now() + interval '5 days 1 hour','[)')));

\echo ''
\echo '--- 1. Objects exist with the expected shape ---'
select column_name, data_type, column_default
from information_schema.columns
where table_schema = 'crm' and table_name = 'retention_settings'
order by ordinal_position;
\echo 'EXPECT: id, business_id, location_id, lapsed_buffer_days (default 14),'
\echo '        min_completed_visits (default 3), created_at, updated_at.'

select indexname from pg_indexes
where indexname in ('idx_booking_visits_business_attended',
                    'idx_booking_appointments_business_completed',
                    'idx_retention_settings_business')
order by indexname;
\echo 'EXPECT: all three index names listed.'

select relrowsecurity as rls_enabled from pg_class where oid = 'crm.retention_settings'::regclass;
\echo 'EXPECT: t'

\echo ''
\echo '--- 2. THE 0071/0078 TRAP: functions must not be PUBLIC-executable ---'
select p.proname, coalesce(p.proacl::text, '(default = PUBLIC EXECUTE!)') as acl
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'crm' and p.proname in ('client_service_history', 'client_next_bookings')
order by p.proname;
\echo 'EXPECT: both ACLs contain service_role=X and NOT anon=X / authenticated=X,'
\echo '        and are NOT the "(default = PUBLIC EXECUTE!)" placeholder.'

\echo ''
\echo '--- 3. Settings: 0 is a real buffer, and the business row is unique ---'
insert into crm.retention_settings (business_id, location_id, lapsed_buffer_days)
values ('00970000-0000-0000-0000-000000000001', null, 0);
insert into crm.retention_settings (business_id, location_id, lapsed_buffer_days)
values ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000001', 45);

select location_id, lapsed_buffer_days, min_completed_visits
from crm.retention_settings
where business_id = '00970000-0000-0000-0000-000000000001'
order by location_id nulls first;
\echo 'EXPECT: two rows — (null, 0, 3) then (Shoreditch, 45, 3). A stored 0 is an'
\echo '        intentional zero grace period, NOT missing configuration.'

-- Each expected failure runs inside its own savepoint: the raised error aborts
-- the subtransaction only, so the suite continues on the same fixture.
\set ON_ERROR_STOP off
\echo '(the next three statements MUST fail — a raised error is a PASS)'

savepoint expect_duplicate;
insert into crm.retention_settings (business_id, location_id) values ('00970000-0000-0000-0000-000000000001', null);
\echo 'EXPECT ABOVE: duplicate key — unique nulls not distinct blocks a 2nd business row.'
rollback to savepoint expect_duplicate;

savepoint expect_negative_buffer;
insert into crm.retention_settings (business_id, location_id, lapsed_buffer_days) values ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000002', -1);
\echo 'EXPECT ABOVE: retention_settings_buffer_days_range violation.'
rollback to savepoint expect_negative_buffer;

savepoint expect_low_minimum;
insert into crm.retention_settings (business_id, location_id, min_completed_visits) values ('00970000-0000-0000-0000-000000000001', '00971000-0000-0000-0000-000000000002', 1);
\echo 'EXPECT ABOVE: retention_settings_min_visits_range violation.'
rollback to savepoint expect_low_minimum;

\set ON_ERROR_STOP on
select count(*) as settings_rows_after_rejected_writes
from crm.retention_settings where business_id = '00970000-0000-0000-0000-000000000001';
\echo 'EXPECT: 2 — none of the three rejected writes landed.'

\echo ''
\echo '--- 4. Service history: only attended, non-future visits count ---'
select jsonb_path_query_array(visits, '$[*].visitDate') as visit_dates,
       service_rebooking_interval_days
from crm.client_service_history(
  '00970000-0000-0000-0000-000000000001', 'Europe/London',
  array['00974000-0000-0000-0000-000000000001']::uuid[]);
\echo 'EXPECT: ["2026-01-05","2026-02-16","2026-03-30","2026-05-11","2026-05-21"], interval NULL.'
\echo '        The cancelled / no_show / rejected / accepted / checked_in and the'
\echo '        year-2099 appointments are all absent. The interval is NULL because'
\echo '        the LATEST visit was the wedding styling, which has the nudge off.'

select jsonb_path_query_array(visits, '$[*].services[*].serviceName') as service_names
from crm.client_service_history(
  '00970000-0000-0000-0000-000000000001', 'Europe/London',
  array['00974000-0000-0000-0000-000000000001']::uuid[]);
\echo 'EXPECT: four "Suite Colour (2025 menu)" then "Suite Wedding" — the HISTORIC'
\echo '        snapshot names, and the inactive wedding service still resolves.'

\echo ''
\echo '--- 4b. The client''s display fields ride along on the same row ---'
select client_code is not null as has_code, first_name, last_name,
       email, phone, marketing_opt_in, primary_location_id
from crm.client_service_history(
  '00970000-0000-0000-0000-000000000001', 'Europe/London',
  array['00974000-0000-0000-0000-000000000001']::uuid[]);
\echo 'EXPECT: t, Jane, Suite, null, null, f, Shoreditch id.'
\echo '        The list endpoint therefore needs NO follow-up client query —'
\echo '        which also avoids sending a thousand ids back through a'
\echo '        PostgREST in.(...) filter (a ~40KB URL).'

\echo ''
\echo '--- 5. Same-day collapse, multi-service, and business-wide history ---'
select jsonb_path_query_array(visits, '$[*].visitDate') as visit_dates,
       service_rebooking_interval_days
from crm.client_service_history(
  '00970000-0000-0000-0000-000000000001', 'Europe/London',
  array['00974000-0000-0000-0000-000000000002']::uuid[]);
\echo 'EXPECT: ["2026-03-17","2026-04-28"] and interval 42.'
\echo '        Two same-day appointments are ONE visit (otherwise a 0-day interval'
\echo '        would drag the median down). 42 = the SHORTEST enabled interval'
\echo '        among the latest visit''s services (colour 42 vs cut 56), matching'
\echo '        the rebooking-nudge rule.'

select jsonb_array_length(visits -> 0 -> 'services') as same_day_services,
       jsonb_array_length(visits -> 1 -> 'services') as multi_service_visit
from crm.client_service_history(
  '00970000-0000-0000-0000-000000000001', 'Europe/London',
  array['00974000-0000-0000-0000-000000000002']::uuid[]);
\echo 'EXPECT: 2 and 2 — services merge across same-day appointments, and a'
\echo '        multi-service appointment yields one visit carrying both.'

\echo ''
\echo '--- 6. Walk-in visits and the completed/started/checked-in ladder ---'
select jsonb_path_query_array(visits, '$[*].visitDate') as visit_dates,
       jsonb_array_length(visits -> 0 -> 'services') as services_on_walkin
from crm.client_service_history(
  '00970000-0000-0000-0000-000000000001', 'Europe/London',
  array['00974000-0000-0000-0000-000000000003']::uuid[]);
\echo 'EXPECT: ["2026-03-01","2026-04-12","2026-07-01"] and 0 services.'
\echo '        The cancelled visit is absent. 2026-06-30 23:30 UTC is 00:30 on'
\echo '        1 JULY in Europe/London — the salon-local date, not the UTC one.'

select jsonb_path_query_array(visits, '$[*].visitDate') as new_york_dates
from crm.client_service_history(
  '00970000-0000-0000-0000-000000000001', 'America/New_York',
  array['00974000-0000-0000-0000-000000000003']::uuid[]);
\echo 'EXPECT: ["2026-03-01","2026-04-12","2026-06-30"] — a different salon'
\echo '        timezone moves the local date, proving the cast is not UTC-pinned.'

\echo ''
\echo '--- 7. Tenancy and tombstones ---'
select count(*) filter (where client_profile_id = '00974000-0000-0000-0000-000000000005') as other_tenant_rows,
       count(*) filter (where client_profile_id = '00974000-0000-0000-0000-000000000004') as tombstone_rows,
       count(*) as total_rows
from crm.client_service_history('00970000-0000-0000-0000-000000000001', 'Europe/London');
\echo 'EXPECT: other_tenant_rows = 0, tombstone_rows = 0, total_rows = 3'
\echo '        (Jane, Sarah, Walk-in and nothing else).'

select client_profile_id
from crm.client_service_history('00970000-0000-0000-0000-000000000002', 'Europe/London');
\echo 'EXPECT: only 00974000-...-005. Salon B sees Salon B.'

\echo ''
\echo '--- 8. Location filter selects CLIENTS, never truncates their history ---'
select client_profile_id, jsonb_path_query_array(visits, '$[*].locationId') as visit_locations
from crm.client_service_history(
  '00970000-0000-0000-0000-000000000001', 'Europe/London', null,
  array['00971000-0000-0000-0000-000000000002']::uuid[]);
\echo 'EXPECT: only Sarah, and her visit_locations include the SHORTEDITCH id for'
\echo '        2026-04-28. Retention is business-wide: a client seen at another'
\echo '        branch HAS returned. A null-primary-location client (Walk-in) is'
\echo '        excluded by a location filter, matching listClients.'

\echo ''
\echo '--- 9. Window and paging ---'
select jsonb_path_query_array(visits, '$[*].visitDate') as since_march
from crm.client_service_history(
  '00970000-0000-0000-0000-000000000001', 'Europe/London',
  array['00974000-0000-0000-0000-000000000001']::uuid[], null, '2026-03-01 00:00+00');
\echo 'EXPECT: ["2026-03-30","2026-05-11","2026-05-21"] — p_since bounds the scan.'

select jsonb_path_query_array(visits, '$[*].visitDate') as most_recent_two
from crm.client_service_history(
  '00970000-0000-0000-0000-000000000001', 'Europe/London',
  array['00974000-0000-0000-0000-000000000001']::uuid[], null, null, 2);
\echo 'EXPECT: ["2026-05-11","2026-05-21"] — p_max_visits keeps the MOST RECENT.'

select (select client_profile_id from crm.client_service_history('00970000-0000-0000-0000-000000000001','Europe/London',null,null,null,10,1,0)) as page_1,
       (select client_profile_id from crm.client_service_history('00970000-0000-0000-0000-000000000001','Europe/London',null,null,null,10,1,1)) as page_2;
\echo 'EXPECT: two DIFFERENT client ids — paging is stable and non-overlapping.'

\echo ''
\echo '--- 10. Upcoming bookings: only a valid one protects a client ---'
select client_profile_id, appointment_id, scheduled_start_at
from crm.client_next_bookings('00970000-0000-0000-0000-000000000001')
order by client_profile_id;
\echo 'EXPECT: exactly ONE row — Jane, appointment ...041 (the EARLIER of her two'
\echo '        valid future bookings). Sarah''s cancelled and Walk-in''s no_show'
\echo '        future appointments give NO protection, so they are absent.'

select count(*) as future_rows_for_other_tenant
from crm.client_next_bookings('00970000-0000-0000-0000-000000000002');
\echo 'EXPECT: 0 — Salon B has no upcoming appointments in this fixture.'

-- Cancels EVERY future appointment Jane holds, including the deliberately
-- contradictory year-2099 'paid' row. That row is future-dated, so the shared
-- predicate (status not in cancelled/no_show/rejected) counts it as an upcoming
-- booking — exactly as the rebooking-nudge suppression check does. The two must
-- never disagree, so the predicate is reused rather than "improved" here.
update booking.appointments set status = 'cancelled', cancelled_at = now()
where business_id = '00970000-0000-0000-0000-000000000001'
  and scheduled_start_at > now();

select count(*) as rows_after_cancelling_everything
from crm.client_next_bookings('00970000-0000-0000-0000-000000000001');
\echo 'EXPECT: 0 — cancelling the upcoming appointments removes the protection on'
\echo '        the very next read. Nothing is stored, so nothing goes stale.'

\echo ''
\echo '--- 11. The new indexes are usable by the history predicates ---'
-- NOTE ON GRADING: on this tiny fixture the planner may legitimately prefer an
-- existing wider index, because at a few dozen rows every plan costs the same.
-- The point of `enable_seqscan = off` is to prove the new indexes are USABLE by
-- these exact predicates. Their VALUE was measured separately on 40,000
-- appointments (2,000 of them completed): the history predicate becomes a Bitmap
-- Index Scan on idx_booking_appointments_business_completed, and dropping that
-- index turns the same query into a full Seq Scan. Re-run this section against a
-- realistic dataset if you want to see that rather than take it on trust.
set enable_seqscan = off;
explain (costs off)
select 1 from booking.visits
where business_id = '00970000-0000-0000-0000-000000000001'
  and coalesce(completed_at, started_at, checked_in_at) >= now() - interval '730 days';
\echo 'EXPECT: an Index/Bitmap scan on idx_booking_visits_business_attended — no'
\echo '        other index covers the coalesce ladder, so this one is decisive.'

explain (costs off)
select 1 from booking.appointments
where business_id = '00970000-0000-0000-0000-000000000001'
  and completed_at is not null
  and completed_at >= now() - interval '730 days';
\echo 'EXPECT: an index scan. On a realistic dataset it is a Bitmap Index Scan on'
\echo '        idx_booking_appointments_business_completed; on this fixture the'
\echo '        planner may pick idx_booking_appointments_business_location_start'
\echo '        (also business_id-leading) and filter. Either is acceptable HERE;'
\echo '        a Seq Scan is not.'
reset enable_seqscan;

-- ---------------------------------------------------------------------------
-- Teardown. Everything above ran inside one transaction; nothing is kept.
-- ---------------------------------------------------------------------------
rollback;

\echo ''
\echo '=== fixture rolled back — the database is unchanged ==='
