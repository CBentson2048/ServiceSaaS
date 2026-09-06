-- zac_intelligence_signals.sql — behavioural suite for migration 0112.
--
-- WHY THIS FILE EXISTS. The Jest suites stub the Supabase client, so they prove
-- the SERVICE asks the database for the right things. They cannot prove that the
-- database KEEPS ITS PROMISES: that only one live signal can exist per logical
-- issue, that a resolved episode leaves room for a recurrence, that a closed
-- vocabulary really is closed, that a stylist's private signal is invisible to
-- the owner through PostgREST, that another business's signals cannot be read,
-- and that `authenticated` cannot write. This file is that proof — the
-- constraints, the partial unique index, the policies and the grants run for
-- real.
--
-- 30 numbered cases. Every RESULT must read PASS.
--
-- Run against a SCRATCH database with every migration through 0112 applied:
--   psql -d <scratch> -f supabase/tests/zac_intelligence_signals.sql
--
-- The whole suite runs inside one transaction rolled back at the end. Every
-- expected failure runs inside a plpgsql block whose exception handler records
-- the verdict, so the rejected write is undone while the evidence survives. A
-- savepoint/rollback probe would prove nothing: the rollback removes the row
-- whether the constraint rejected it or accepted it.
--
-- HOW THE RLS CASES WORK. `set local role authenticated` plus
-- `set_config('request.jwt.claim.sub', <user id>, true)` is exactly what
-- PostgREST does per request. Role is always reset before recording a verdict.

\set ON_ERROR_STOP off
\pset pager off

begin;

create temporary table probe_results (case_name text primary key, result text) on commit drop;

-- ---------------------------------------------------------------------------
-- Fixtures. '1a' prefix, hex-only UUIDs, distinct from every other suite.
-- ---------------------------------------------------------------------------
insert into core.businesses (id,name,slug,timezone) values
 ('1a000000-0000-0000-0000-000000000001','Signal Salon','zis-signal-salon','Europe/London'),
 ('1a000000-0000-0000-0000-000000000002','Rival Salon','zis-rival-salon','Europe/London');

insert into core.locations (id,business_id,code,name,slug,address_line_1,city,postal_code,timezone) values
 ('1a000000-0000-0000-0000-0000000000a1','1a000000-0000-0000-0000-000000000001','Z1','Pinner','zis-pinner','1 High St','Pinner','HA5 1AA','Europe/London'),
 ('1a000000-0000-0000-0000-0000000000a2','1a000000-0000-0000-0000-000000000001','Z2','Primrose Hill','zis-primrose','2 Regents Park Rd','London','NW1 8UG','Europe/London'),
 ('1a000000-0000-0000-0000-0000000000a3','1a000000-0000-0000-0000-000000000002','Z3','Rival','zis-rival','3 High St','Watford','WD1 1AA','Europe/London');

insert into auth.users (id,email) values
 ('1a000000-0000-0000-0000-0000000000f1'::uuid,'owner@zis.example'),
 ('1a000000-0000-0000-0000-0000000000f2'::uuid,'manager@zis.example'),
 ('1a000000-0000-0000-0000-0000000000f3'::uuid,'stylist@zis.example'),
 ('1a000000-0000-0000-0000-0000000000f4'::uuid,'rival@zis.example');

insert into core.user_profiles (id,email,full_name,first_name,last_name,display_name,is_active) values
 ('1a000000-0000-0000-0000-0000000000f1','owner@zis.example','Olive Owner','Olive','Owner','Olive',true),
 ('1a000000-0000-0000-0000-0000000000f2','manager@zis.example','Mo Manager','Mo','Manager','Mo',true),
 ('1a000000-0000-0000-0000-0000000000f3','stylist@zis.example','Jane Stylist','Jane','Stylist','Jane',true),
 ('1a000000-0000-0000-0000-0000000000f4','rival@zis.example','Ray Rival','Ray','Rival','Ray',true);

insert into core.user_memberships (business_id,location_id,user_profile_id,role,status,activated_at) values
 ('1a000000-0000-0000-0000-000000000001',null,'1a000000-0000-0000-0000-0000000000f1','owner','active',now()),
 ('1a000000-0000-0000-0000-000000000001','1a000000-0000-0000-0000-0000000000a1','1a000000-0000-0000-0000-0000000000f2','manager','active',now()),
 ('1a000000-0000-0000-0000-000000000001','1a000000-0000-0000-0000-0000000000a1','1a000000-0000-0000-0000-0000000000f3','stylist','active',now()),
 ('1a000000-0000-0000-0000-000000000002',null,'1a000000-0000-0000-0000-0000000000f4','owner','active',now());

-- ===========================================================================
-- 1. THE TABLE EXISTS.
-- ===========================================================================
insert into probe_results values ('01_TABLE_EXISTS',
  case when to_regclass('zac.intelligence_signals') is not null
       then 'PASS' else 'FAIL: table is missing' end);
select case_name as case, result from probe_results where case_name='01_TABLE_EXISTS';

-- ===========================================================================
-- 2-3. RLS is ENABLED **and FORCED**, matching every other zac table. Forcing
--      matters because the table owner would otherwise bypass its own policies.
-- ===========================================================================
insert into probe_results values ('02_RLS_ENABLED',
  case when (select relrowsecurity from pg_class where oid = 'zac.intelligence_signals'::regclass)
       then 'PASS' else 'FAIL: row level security is not enabled' end);

insert into probe_results values ('03_RLS_FORCED',
  case when (select relforcerowsecurity from pg_class where oid = 'zac.intelligence_signals'::regclass)
       then 'PASS' else 'FAIL: row level security is not forced' end);
select case_name as case, result from probe_results where case_name in ('02_RLS_ENABLED','03_RLS_FORCED') order by case_name;

-- ===========================================================================
-- 4-6. GRANTS. service_role writes; authenticated reads and nothing more.
--      0080 narrowed the schema defaults, but defaults are not retroactive —
--      these prove the per-table state, not the intention.
-- ===========================================================================
insert into probe_results values ('04_SERVICE_ROLE_WRITES',
  case when has_table_privilege('service_role','zac.intelligence_signals','INSERT')
        and has_table_privilege('service_role','zac.intelligence_signals','UPDATE')
        and has_table_privilege('service_role','zac.intelligence_signals','SELECT')
       then 'PASS' else 'FAIL: the API service role cannot write signals' end);

insert into probe_results values ('05_AUTHENTICATED_READS',
  case when has_table_privilege('authenticated','zac.intelligence_signals','SELECT')
       then 'PASS' else 'FAIL: authenticated cannot read signals' end);

insert into probe_results values ('06_AUTHENTICATED_CANNOT_WRITE',
  case when not has_table_privilege('authenticated','zac.intelligence_signals','INSERT')
        and not has_table_privilege('authenticated','zac.intelligence_signals','UPDATE')
        and not has_table_privilege('authenticated','zac.intelligence_signals','DELETE')
       then 'PASS' else 'FAIL: authenticated holds a write grant' end);
select case_name as case, result from probe_results
 where case_name in ('04_SERVICE_ROLE_WRITES','05_AUTHENTICATED_READS','06_AUTHENTICATED_CANNOT_WRITE')
 order by case_name;

-- ---------------------------------------------------------------------------
-- Seed one live business-scope signal.
-- ---------------------------------------------------------------------------
insert into zac.intelligence_signals (
  id, business_id, location_id, subject_user_id, signal_key, evaluator_key, metric_key, issue_key,
  scope_type, scope_label, visibility_scope, signal_type, severity, materiality, confidence,
  direction, observation_status, observed_value, target_value, target_source, sample_size,
  period_label, headline_redacted, status, expires_at
) values (
  '1a000000-0000-0000-0000-0000000000b1',
  '1a000000-0000-0000-0000-000000000001', null, null,
  'biz|rebooking_shortfall|rebooking_rate|business|-|-|shortfall',
  'rebooking_shortfall','rebooking_rate','rebooking',
  'business', 'Signal Salon', 'business_owner', 'opportunity', 'attention', 0.3200, 0.8500,
  'unknown','valid', 34, 50, 'canonical_threshold', 120,
  '2026-08-28..2026-09-04','Rebooking rate is 34% against a 50% target.','active',
  now() + interval '21 days'
);

-- ===========================================================================
-- 7. DEDUPE. A second LIVE signal for the same logical issue is refused. This
--    is the database half of "repeated evaluation refreshes rather than
--    duplicates" — without it, a racing evaluation could stack two.
-- ===========================================================================
do $$
begin
  insert into zac.intelligence_signals (
    business_id, signal_key, evaluator_key, metric_key, issue_key, scope_type,
    visibility_scope, signal_type, severity, materiality, confidence,
    observation_status, headline_redacted
  ) values (
    '1a000000-0000-0000-0000-000000000001',
    'biz|rebooking_shortfall|rebooking_rate|business|-|-|shortfall',
    'rebooking_shortfall','rebooking_rate','rebooking','business',
    'business_owner','opportunity','attention',0.3200,0.8500,'valid','duplicate'
  );
  insert into probe_results values ('07_LIVE_DEDUPE','FAIL: a second live signal for one issue was accepted');
exception when unique_violation then
  insert into probe_results values ('07_LIVE_DEDUPE','PASS');
when others then
  insert into probe_results values ('07_LIVE_DEDUPE','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='07_LIVE_DEDUPE';

-- ===========================================================================
-- 8. A SUPPRESSED signal still occupies the issue. Otherwise a suppression
--    would quietly become a licence to raise the same thing again.
-- ===========================================================================
do $$
begin
  update zac.intelligence_signals set status='suppressed', suppressed_until = now() + interval '30 days'
   where id = '1a000000-0000-0000-0000-0000000000b1';
  insert into zac.intelligence_signals (
    business_id, signal_key, evaluator_key, metric_key, issue_key, scope_type,
    visibility_scope, signal_type, severity, materiality, confidence,
    observation_status, headline_redacted
  ) values (
    '1a000000-0000-0000-0000-000000000001',
    'biz|rebooking_shortfall|rebooking_rate|business|-|-|shortfall',
    'rebooking_shortfall','rebooking_rate','rebooking','business',
    'business_owner','opportunity','attention',0.3200,0.8500,'valid','behind a suppression'
  );
  insert into probe_results values ('08_SUPPRESSED_HOLDS_THE_ISSUE','FAIL: a signal was opened behind a suppression');
exception when unique_violation then
  insert into probe_results values ('08_SUPPRESSED_HOLDS_THE_ISSUE','PASS');
when others then
  insert into probe_results values ('08_SUPPRESSED_HOLDS_THE_ISSUE','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='08_SUPPRESSED_HOLDS_THE_ISSUE';

update zac.intelligence_signals set status='active', suppressed_until = null
 where id = '1a000000-0000-0000-0000-0000000000b1';

-- ===========================================================================
-- 9. RECURRENCE. Once an episode is resolved, the same issue may open again —
--    and the closed episode survives as history rather than being overwritten.
-- ===========================================================================
do $$
declare episodes integer;
begin
  update zac.intelligence_signals
     set status='resolved', resolution_reason='recovered', resolved_at=now()
   where id = '1a000000-0000-0000-0000-0000000000b1';

  insert into zac.intelligence_signals (
    id, business_id, signal_key, evaluator_key, metric_key, issue_key, scope_type,
    visibility_scope, signal_type, severity, materiality, confidence,
    observation_status, headline_redacted
  ) values (
    '1a000000-0000-0000-0000-0000000000b2',
    '1a000000-0000-0000-0000-000000000001',
    'biz|rebooking_shortfall|rebooking_rate|business|-|-|shortfall',
    'rebooking_shortfall','rebooking_rate','rebooking','business',
    'business_owner','opportunity','attention',0.4000,0.8500,'valid','it came back'
  );

  select count(*) into episodes from zac.intelligence_signals
   where signal_key = 'biz|rebooking_shortfall|rebooking_rate|business|-|-|shortfall';

  insert into probe_results values ('09_RECURRENCE_OPENS_A_NEW_EPISODE',
    case when episodes = 2 then 'PASS'
         else 'FAIL: expected 2 episodes, found ' || episodes end);
exception when others then
  insert into probe_results values ('09_RECURRENCE_OPENS_A_NEW_EPISODE','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='09_RECURRENCE_OPENS_A_NEW_EPISODE';

-- ===========================================================================
-- 10. SCOPING. Two locations, one metric, two signals — the keys differ, so
--     nothing collides and a per-site problem is not merged into the business.
-- ===========================================================================
do $$
begin
  insert into zac.intelligence_signals (
    business_id, location_id, signal_key, evaluator_key, metric_key, issue_key, scope_type,
    visibility_scope, signal_type, severity, materiality, confidence, observation_status, headline_redacted
  ) values
   ('1a000000-0000-0000-0000-000000000001','1a000000-0000-0000-0000-0000000000a1',
    'biz|utilisation_shortfall|utilisation_rate|location|a1|-|shortfall',
    'utilisation_shortfall','utilisation_rate','utilisation','location',
    'manager_team_theme','risk','attention',0.3000,0.8000,'valid','Pinner utilisation'),
   ('1a000000-0000-0000-0000-000000000001','1a000000-0000-0000-0000-0000000000a2',
    'biz|utilisation_shortfall|utilisation_rate|location|a2|-|shortfall',
    'utilisation_shortfall','utilisation_rate','utilisation','location',
    'manager_team_theme','risk','attention',0.2200,0.8000,'valid','Primrose utilisation');
  insert into probe_results values ('10_LOCATION_SCOPES_COEXIST','PASS');
exception when others then
  insert into probe_results values ('10_LOCATION_SCOPES_COEXIST','FAIL: ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='10_LOCATION_SCOPES_COEXIST';

-- ===========================================================================
-- 11. TENANT ISOLATION at the key level. The identical issue in another
--     business is a different signal, and both may be live at once.
-- ===========================================================================
do $$
begin
  insert into zac.intelligence_signals (
    business_id, signal_key, evaluator_key, metric_key, issue_key, scope_type,
    visibility_scope, signal_type, severity, materiality, confidence, observation_status, headline_redacted
  ) values (
    '1a000000-0000-0000-0000-000000000002',
    'rival|rebooking_shortfall|rebooking_rate|business|-|-|shortfall',
    'rebooking_shortfall','rebooking_rate','rebooking','business',
    'business_owner','opportunity','attention',0.3200,0.8500,'valid','rival rebooking'
  );
  insert into probe_results values ('11_TENANTS_ISOLATED','PASS');
exception when others then
  insert into probe_results values ('11_TENANTS_ISOLATED','FAIL: ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='11_TENANTS_ISOLATED';

-- ===========================================================================
-- 12-17. CLOSED VOCABULARIES. Every enum-shaped column is a CHECK, so a bad
--        value written by a script or a backfill is refused by the database and
--        not merely by TypeScript. Most zac columns are unconstrained text —
--        that is a Phase 1 gap this table deliberately does not repeat.
-- ===========================================================================
do $$
declare
  cases text[][] := array[
    ['12_SIGNAL_TYPE_CLOSED','signal_type','recommendation'],
    ['13_SEVERITY_CLOSED','severity','high'],
    ['14_STATUS_CLOSED','status','dismissed'],
    ['15_OBSERVATION_STATUS_CLOSED','observation_status','unknown'],
    ['16_SCOPE_TYPE_CLOSED','scope_type','region'],
    ['17_VISIBILITY_SCOPE_CLOSED','visibility_scope','everyone']
  ];
  entry text[];
  columns text;
  values_list text;
begin
  foreach entry slice 1 in array cases loop
    begin
      columns := 'business_id, signal_key, evaluator_key, metric_key, issue_key, scope_type, '
              || 'visibility_scope, signal_type, severity, materiality, confidence, '
              || 'observation_status, headline_redacted';
      values_list := format(
        '%L, %L, %L, %L, %L, %L, %L, %L, %L, 0.3, 0.8, %L, %L',
        '1a000000-0000-0000-0000-000000000001',
        'probe|' || entry[1], 'probe', 'rebooking_rate', 'rebooking',
        case when entry[2] = 'scope_type' then entry[3] else 'business' end,
        case when entry[2] = 'visibility_scope' then entry[3] else 'business_owner' end,
        case when entry[2] = 'signal_type' then entry[3] else 'opportunity' end,
        case when entry[2] = 'severity' then entry[3] else 'attention' end,
        case when entry[2] = 'observation_status' then entry[3] else 'valid' end,
        'probe'
      );
      if entry[2] = 'status' then
        columns := columns || ', status';
        values_list := values_list || ', ' || quote_literal(entry[3]);
      end if;
      execute format('insert into zac.intelligence_signals (%s) values (%s)', columns, values_list);
      insert into probe_results values (entry[1], 'FAIL: ' || entry[2] || ' accepted ' || entry[3]);
    exception when check_violation then
      insert into probe_results values (entry[1], 'PASS');
    when others then
      insert into probe_results values (entry[1], 'FAIL: unexpected ' || sqlerrm);
    end;
  end loop;
end $$;
select case_name as case, result from probe_results where case_name like '1[234567]_%' order by case_name;

-- ===========================================================================
-- 18-19. MATERIALITY AND CONFIDENCE ARE BOUNDED. Both are fractions of 1 by
--        definition; a value outside [0,1] means a scoring bug, and storing it
--        would let the bug reach an owner's priority list.
-- ===========================================================================
do $$
begin
  insert into zac.intelligence_signals (
    business_id, signal_key, evaluator_key, metric_key, issue_key, scope_type,
    visibility_scope, signal_type, severity, materiality, confidence, observation_status, headline_redacted
  ) values ('1a000000-0000-0000-0000-000000000001','probe|materiality','probe','rebooking_rate','rebooking',
            'business','business_owner','opportunity','attention',1.5,0.8,'valid','probe');
  insert into probe_results values ('18_MATERIALITY_BOUNDED','FAIL: materiality above 1 was accepted');
exception when check_violation then
  insert into probe_results values ('18_MATERIALITY_BOUNDED','PASS');
when others then
  insert into probe_results values ('18_MATERIALITY_BOUNDED','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='18_MATERIALITY_BOUNDED';

do $$
begin
  insert into zac.intelligence_signals (
    business_id, signal_key, evaluator_key, metric_key, issue_key, scope_type,
    visibility_scope, signal_type, severity, materiality, confidence, observation_status, headline_redacted
  ) values ('1a000000-0000-0000-0000-000000000001','probe|confidence','probe','rebooking_rate','rebooking',
            'business','business_owner','opportunity','attention',0.3,-0.1,'valid','probe');
  insert into probe_results values ('19_CONFIDENCE_BOUNDED','FAIL: negative confidence was accepted');
exception when check_violation then
  insert into probe_results values ('19_CONFIDENCE_BOUNDED','PASS');
when others then
  insert into probe_results values ('19_CONFIDENCE_BOUNDED','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='19_CONFIDENCE_BOUNDED';

-- ===========================================================================
-- 20. TENANT FK. A signal cannot be filed against a location in another
--     business's... well, it can reference any location, so the app is the
--     boundary — but a signal MUST belong to a real business, or a stray row
--     would be invisible to every tenant-scoped read and impossible to audit.
-- ===========================================================================
do $$
begin
  insert into zac.intelligence_signals (
    business_id, signal_key, evaluator_key, metric_key, issue_key, scope_type,
    visibility_scope, signal_type, severity, materiality, confidence, observation_status, headline_redacted
  ) values ('1a000000-0000-0000-0000-0000000000ff','probe|orphan','probe','rebooking_rate','rebooking',
            'business','business_owner','opportunity','attention',0.3,0.8,'valid','probe');
  insert into probe_results values ('20_BUSINESS_FK_ENFORCED','FAIL: an orphan signal was accepted');
exception when foreign_key_violation then
  insert into probe_results values ('20_BUSINESS_FK_ENFORCED','PASS');
when others then
  insert into probe_results values ('20_BUSINESS_FK_ENFORCED','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='20_BUSINESS_FK_ENFORCED';

-- ===========================================================================
-- 21. updated_at is SERVER-SET on update. The probe writes a deliberately wrong
--     timestamp and checks the trigger overwrote it: `now()` is transaction-start
--     time, so a "did it move?" test inside one transaction would pass whether
--     the trigger fired or not. What matters is that the writer cannot decide
--     when a signal was last touched.
-- ===========================================================================
do $$
declare after_at timestamptz;
begin
  update zac.intelligence_signals
     set occurrence_count = occurrence_count + 1,
         updated_at = timestamptz '2000-01-01 00:00:00+00'
   where id = '1a000000-0000-0000-0000-0000000000b2';
  select updated_at into after_at from zac.intelligence_signals
   where id = '1a000000-0000-0000-0000-0000000000b2';
  insert into probe_results values ('21_UPDATED_AT_TRIGGER',
    case when after_at = now() then 'PASS'
         else 'FAIL: a client-supplied updated_at survived (' || after_at || ')' end);
exception when others then
  insert into probe_results values ('21_UPDATED_AT_TRIGGER','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='21_UPDATED_AT_TRIGGER';

-- ===========================================================================
-- 22. THE INDEXES the read path depends on exist, with their predicates. A
--     live-signal read that falls back to a sequential scan is a latency bug
--     nobody notices until a tenant has thousands of history rows.
-- ===========================================================================
insert into probe_results values ('22_INDEXES_PRESENT',
  case when (select count(*) from pg_indexes
              where schemaname = 'zac' and tablename = 'intelligence_signals'
                and (
                  -- the dedupe guarantee: UNIQUE and PARTIAL over the live statuses
                  (indexname = 'idx_zac_intelligence_signals_live_key'
                     and indexdef ilike 'create unique index%' and indexdef ilike '%where%status%active%suppressed%')
                  or (indexname = 'idx_zac_intelligence_signals_business_live'
                     and indexdef ilike '%materiality desc%' and indexdef ilike '%where%status%')
                  or (indexname = 'idx_zac_intelligence_signals_location'
                     and indexdef ilike '%where%location_id is not null%')
                  or (indexname = 'idx_zac_intelligence_signals_subject'
                     and indexdef ilike '%where%subject_user_id is not null%')
                )) = 4
       then 'PASS' else 'FAIL: an expected index is missing or has lost its predicate/uniqueness' end);
select case_name as case, result from probe_results where case_name='22_INDEXES_PRESENT';

-- ===========================================================================
-- 23-26. RLS BEHAVIOUR through PostgREST-shaped sessions.
-- ===========================================================================

-- Seed a stylist's private signal and a manager_team_theme signal at Pinner.
insert into zac.intelligence_signals (
  id, business_id, location_id, subject_user_id, signal_key, evaluator_key, metric_key, issue_key,
  scope_type, visibility_scope, signal_type, severity, materiality, confidence,
  observation_status, headline_redacted
) values (
  '1a000000-0000-0000-0000-0000000000c1',
  '1a000000-0000-0000-0000-000000000001','1a000000-0000-0000-0000-0000000000a1',
  '1a000000-0000-0000-0000-0000000000f3',
  'biz|personal_probe|rebooking_rate|personal|a1|f3|shortfall',
  'personal_probe','rebooking_rate','personal_performance','personal',
  'stylist_private','opportunity','watch',0.1800,0.7000,'valid','Jane private coaching signal'
);

-- 23. The OWNER reads business-scope signals but NOT a stylist's private one.
--     This is the rule 0090 had to retrofit onto zac.outputs after 0077 shipped
--     an owner-wide policy; it is built in here from the start.
do $$
declare business_visible integer; private_visible integer;
begin
  perform set_config('request.jwt.claim.sub','1a000000-0000-0000-0000-0000000000f1',true);
  set local role authenticated;
  select count(*) into business_visible from zac.intelligence_signals
   where business_id='1a000000-0000-0000-0000-000000000001' and visibility_scope='business_owner';
  select count(*) into private_visible from zac.intelligence_signals
   where visibility_scope='stylist_private';
  reset role;
  insert into probe_results values ('23_OWNER_READS_BUSINESS_NOT_PRIVATE',
    case when business_visible = 0 then 'FAIL: the owner could not read business signals'
         when private_visible > 0 then 'FAIL: the owner read a stylist private signal'
         else 'PASS' end);
exception when others then
  reset role;
  insert into probe_results values ('23_OWNER_READS_BUSINESS_NOT_PRIVATE','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='23_OWNER_READS_BUSINESS_NOT_PRIVATE';

-- 24. The SUBJECT reads their own private signal.
do $$
declare own integer;
begin
  perform set_config('request.jwt.claim.sub','1a000000-0000-0000-0000-0000000000f3',true);
  set local role authenticated;
  select count(*) into own from zac.intelligence_signals
   where id='1a000000-0000-0000-0000-0000000000c1';
  reset role;
  insert into probe_results values ('24_SUBJECT_READS_OWN_PRIVATE',
    case when own = 1 then 'PASS' else 'FAIL: the subject could not read their own signal' end);
exception when others then
  reset role;
  insert into probe_results values ('24_SUBJECT_READS_OWN_PRIVATE','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='24_SUBJECT_READS_OWN_PRIVATE';

-- 25. Another business's owner sees nothing at all. Business isolation is
--     mandatory, and this proves it at the database rather than in a WHERE
--     clause the API might one day forget.
do $$
declare leaked integer;
begin
  perform set_config('request.jwt.claim.sub','1a000000-0000-0000-0000-0000000000f4',true);
  set local role authenticated;
  select count(*) into leaked from zac.intelligence_signals
   where business_id='1a000000-0000-0000-0000-000000000001';
  reset role;
  insert into probe_results values ('25_CROSS_BUSINESS_HIDDEN',
    case when leaked = 0 then 'PASS'
         else 'FAIL: another business''s signals were readable' end);
exception when others then
  reset role;
  insert into probe_results values ('25_CROSS_BUSINESS_HIDDEN','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='25_CROSS_BUSINESS_HIDDEN';

-- 26. An authenticated session cannot WRITE. Signals are server-owned: a client
--     that could insert one could invent a business problem, or resolve a real
--     one.
do $$
begin
  perform set_config('request.jwt.claim.sub','1a000000-0000-0000-0000-0000000000f1',true);
  set local role authenticated;
  insert into zac.intelligence_signals (
    business_id, signal_key, evaluator_key, metric_key, issue_key, scope_type,
    visibility_scope, signal_type, severity, materiality, confidence, observation_status, headline_redacted
  ) values ('1a000000-0000-0000-0000-000000000001','probe|client-write','probe','rebooking_rate','rebooking',
            'business','business_owner','opportunity','attention',0.3,0.8,'valid','client wrote this');
  reset role;
  insert into probe_results values ('26_AUTHENTICATED_CANNOT_INSERT','FAIL: an authenticated session inserted a signal');
exception when insufficient_privilege then
  reset role;
  insert into probe_results values ('26_AUTHENTICATED_CANNOT_INSERT','PASS');
when others then
  reset role;
  insert into probe_results values ('26_AUTHENTICATED_CANNOT_INSERT','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='26_AUTHENTICATED_CANNOT_INSERT';

-- ===========================================================================
-- 27-28. RESOLUTION REASONS are a closed vocabulary, and they include
--        `superseded` — the reason a run of PROGRESS ends when the metric falls
--        back. Recording that as `recovered` would put the most reassuring word
--        in the audit trail on the least reassuring event.
-- ===========================================================================
do $$
begin
  update zac.intelligence_signals
     set status='resolved', resolution_reason='superseded', resolved_at=now()
   where id = '1a000000-0000-0000-0000-0000000000b2';
  insert into probe_results values ('27_SUPERSEDED_REASON_ACCEPTED','PASS');
exception when others then
  insert into probe_results values ('27_SUPERSEDED_REASON_ACCEPTED','FAIL: ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='27_SUPERSEDED_REASON_ACCEPTED';

do $$
begin
  update zac.intelligence_signals
     set status='resolved', resolution_reason='sorted_itself_out', resolved_at=now()
   where id = '1a000000-0000-0000-0000-0000000000b2';
  insert into probe_results values ('28_RESOLUTION_REASON_CLOSED','FAIL: an unknown resolution reason was accepted');
exception when check_violation then
  insert into probe_results values ('28_RESOLUTION_REASON_CLOSED','PASS');
when others then
  insert into probe_results values ('28_RESOLUTION_REASON_CLOSED','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='28_RESOLUTION_REASON_CLOSED';

-- ===========================================================================
-- 29. A MANAGER reads NOTHING through RLS — not even a manager_team_theme row
--     at their own location. There is deliberately no manager policy: 0090 set
--     the same owner-only pattern on zac.outputs, and managers are served by the
--     API (service role), which enforces location scope itself
--     (ZacIntelligenceSignalService.canSee). The owner reads the same row. This
--     probe exists so that adding a manager policy later is a decision, not a
--     drift.
-- ===========================================================================
insert into zac.intelligence_signals (
  id, business_id, location_id, signal_key, evaluator_key, metric_key, issue_key,
  scope_type, visibility_scope, signal_type, severity, materiality, confidence,
  observation_status, headline_redacted
) values (
  '1a000000-0000-0000-0000-0000000000c2',
  '1a000000-0000-0000-0000-000000000001','1a000000-0000-0000-0000-0000000000a1',
  'biz|team_probe|utilisation_rate|location|a1||shortfall',
  'team_probe','utilisation_rate','utilisation','location',
  'manager_team_theme','risk','attention',0.2500,0.7000,'valid','Pinner utilisation team signal'
);
do $$
declare manager_sees integer; owner_sees integer;
begin
  perform set_config('request.jwt.claim.sub','1a000000-0000-0000-0000-0000000000f2',true);
  set local role authenticated;
  select count(*) into manager_sees from zac.intelligence_signals
   where id='1a000000-0000-0000-0000-0000000000c2';
  reset role;
  perform set_config('request.jwt.claim.sub','1a000000-0000-0000-0000-0000000000f1',true);
  set local role authenticated;
  select count(*) into owner_sees from zac.intelligence_signals
   where id='1a000000-0000-0000-0000-0000000000c2';
  reset role;
  insert into probe_results values ('29_MANAGER_HAS_NO_RLS_PATH',
    case when manager_sees > 0 then 'FAIL: a manager read a signal through RLS (no manager policy is declared)'
         when owner_sees <> 1 then 'FAIL: the owner could not read the team row'
         else 'PASS' end);
exception when others then
  reset role;
  insert into probe_results values ('29_MANAGER_HAS_NO_RLS_PATH','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='29_MANAGER_HAS_NO_RLS_PATH';

-- ===========================================================================
-- 30. EXPIRY is the other way an episode closes, and it must behave like
--     resolution at the schema level: the expired row keeps its reason, and the
--     same issue can open a fresh live row beside it. Seeds its own episode
--     (b5) as a lapsed suppression that then expired, so the probe also shows
--     'suppressed_until' may legitimately remain set on history.
-- ===========================================================================
do $$
declare live_after integer; expired_kept integer;
begin
  insert into zac.intelligence_signals (
    id, business_id, signal_key, evaluator_key, metric_key, issue_key, scope_type,
    visibility_scope, signal_type, severity, materiality, confidence,
    observation_status, headline_redacted, status, resolution_reason, suppressed_until
  ) values (
    '1a000000-0000-0000-0000-0000000000b5',
    '1a000000-0000-0000-0000-000000000001',
    'biz|utilisation_shortfall|utilisation_rate|business|-|-|shortfall',
    'utilisation_shortfall','utilisation_rate','utilisation','business',
    'business_owner','risk','attention',0.3000,0.8000,'valid','first episode',
    'suppressed','suppressed_by_actor', now() - interval '1 day'
  );
  update zac.intelligence_signals
     set status='expired', resolution_reason='expired_unconfirmed', resolved_at=now()
   where id = '1a000000-0000-0000-0000-0000000000b5';

  insert into zac.intelligence_signals (
    id, business_id, signal_key, evaluator_key, metric_key, issue_key, scope_type,
    visibility_scope, signal_type, severity, materiality, confidence,
    observation_status, headline_redacted
  ) values (
    '1a000000-0000-0000-0000-0000000000b6',
    '1a000000-0000-0000-0000-000000000001',
    'biz|utilisation_shortfall|utilisation_rate|business|-|-|shortfall',
    'utilisation_shortfall','utilisation_rate','utilisation','business',
    'business_owner','risk','attention',0.3000,0.8000,'valid','back after expiry'
  );

  select count(*) into live_after from zac.intelligence_signals
   where signal_key = 'biz|utilisation_shortfall|utilisation_rate|business|-|-|shortfall'
     and status in ('active','suppressed');
  select count(*) into expired_kept from zac.intelligence_signals
   where id = '1a000000-0000-0000-0000-0000000000b5'
     and status = 'expired' and resolution_reason = 'expired_unconfirmed';

  insert into probe_results values ('30_EXPIRED_EPISODE_KEEPS_REASON_AND_RECURS',
    case when live_after = 1 and expired_kept = 1 then 'PASS'
         else 'FAIL: live=' || live_after || ' expired_kept=' || expired_kept end);
exception when others then
  insert into probe_results values ('30_EXPIRED_EPISODE_KEEPS_REASON_AND_RECURS','FAIL: unexpected ' || sqlerrm);
end $$;
select case_name as case, result from probe_results where case_name='30_EXPIRED_EPISODE_KEEPS_REASON_AND_RECURS';

-- ===========================================================================
-- SUMMARY
-- ===========================================================================
select case_name as case, result from probe_results order by case_name;

select 'SUITE' as case,
       case when count(*) filter (where result <> 'PASS') = 0
            then 'PASS: ' || count(*) || ' probed cases'
            else 'FAIL: ' || count(*) filter (where result <> 'PASS') || ' of ' || count(*) || ' failed'
       end as result
  from probe_results;

rollback;
