-- client_search.sql — hand-run verification for migration 0083.
-- Run with psql against a database that has 0083 applied and some client data.
-- Graded by a human: each section prints what to look for.

\echo '=== 0083 client search verification ==='

\echo ''
\echo '--- 1. Extension and indexes exist ---'
select extname, extnamespace::regnamespace as schema
from pg_extension where extname = 'pg_trgm';

select indexname
from pg_indexes
where schemaname = 'core' and tablename = 'client_profiles'
  and indexname in (
    'idx_client_profiles_fullname_trgm',
    'idx_client_profiles_email_trgm',
    'idx_client_profiles_phone_digits_trgm'
  );
\echo 'EXPECT: pg_trgm in schema extensions, and all three indexes listed.'

\echo ''
\echo '--- 2. Name search uses the trigram index ---'
explain (costs off)
select id from core.client_profiles
where lower(first_name || ' ' || last_name) like '%smith%';
\echo 'EXPECT: Bitmap Index Scan on idx_client_profiles_fullname_trgm.'
\echo '(On tiny tables the planner may still choose Seq Scan; re-check with'
\echo ' `set enable_seqscan = off;` if so.)'

\echo ''
\echo '--- 3. Email search uses the trigram index ---'
explain (costs off)
select id from core.client_profiles
where email is not null and lower(email::text) like '%@example.com%';
\echo 'EXPECT: Bitmap Index Scan on idx_client_profiles_email_trgm.'

\echo ''
\echo '--- 4. Phone search matches regardless of typed format ---'
explain (costs off)
select id from core.client_profiles
where phone is not null
  and regexp_replace(phone, '\D', '', 'g') like '%7725485160%';
\echo 'EXPECT: Bitmap Index Scan on idx_client_profiles_phone_digits_trgm.'

\echo ''
\echo '--- 5. RPC smoke test (uses the first business found) ---'
select id, client_code, first_name, last_name, rank, total_count
from crm.search_clients(
  (select id from core.businesses limit 1),
  null,
  'test',
  5,
  0
);
\echo 'EXPECT: rows ranked desc (or zero rows on an empty database); no error.'

\echo ''
\echo '--- 6. RPC is not callable by end-user roles ---'
select grantee, privilege_type
from information_schema.routine_privileges
where routine_schema = 'crm' and routine_name = 'search_clients';
\echo 'EXPECT: service_role (and postgres) only — no anon, no authenticated.'
