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
    'idx_client_profiles_phone_digits_trgm',
    'idx_client_profiles_phone_suffix9',
    'idx_client_profiles_client_code_trgm'
  );
\echo 'EXPECT: pg_trgm in schema extensions, and all five indexes listed.'

\echo ''
\echo '--- 2. THE REAL PREDICATE: combined OR uses BitmapOr over the indexes ---'
\echo '(This replicates the RPC WHERE shape for a >=3-char term. Every arm must'
\echo ' have an index path or the whole OR degrades to a tenant filter-scan.)'
set enable_seqscan = off;
explain (costs off)
select id from core.client_profiles c
where c.business_id = (select id from core.businesses limit 1)
  and (
    lower(c.first_name || ' ' || c.last_name) like '%smi%' escape '\'
    or (c.email is not null and lower(c.email::text) like '%smi%' escape '\')
    or lower(c.first_name || ' ' || c.last_name) operator(extensions.%) 'smi'
    or (c.phone is not null
        and regexp_replace(c.phone, '\D', '', 'g') like '%772%')
    or (c.phone is not null
        and right(regexp_replace(c.phone, '\D', '', 'g'), 9) = right('447725485160', 9))
    or c.client_code like '%SMI%' escape '\'
  );
reset enable_seqscan;
\echo 'EXPECT: a BitmapOr combining Bitmap Index Scans on the 0083 indexes —'
\echo ' NOT a lone scan on idx_core_client_profiles_business_id with a filter.'

\echo ''
\echo '--- 3. Individual legs (isolation sanity checks) ---'
explain (costs off)
select id from core.client_profiles
where lower(first_name || ' ' || last_name) like '%smith%';
explain (costs off)
select id from core.client_profiles
where email is not null and lower(email::text) like '%@example.com%';
explain (costs off)
select id from core.client_profiles
where phone is not null
  and regexp_replace(phone, '\D', '', 'g') like '%7725485160%';
\echo 'EXPECT: Bitmap Index Scan on the matching trgm index in each plan.'

\echo ''
\echo '--- 4. Phone format bridging via the RPC ---'
\echo 'Seed-dependent: pick a client with a phone, then search for it in the'
\echo 'other format. Both calls should return that client:'
\echo '  select * from crm.search_clients(<biz>, null, ''07725 485160'', 5, 0);'
\echo '  select * from crm.search_clients(<biz>, null, ''+44 7725 485160'', 5, 0);'
\echo 'Also verify wildcards are literal (should return 0 rows, not everything):'
select count(*) as wildcard_matches
from crm.search_clients((select id from core.businesses limit 1), null, '%', 5, 0);
\echo 'EXPECT: wildcard_matches = 0 unless a client is literally named "%".'

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
