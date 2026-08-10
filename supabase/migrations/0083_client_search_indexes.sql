-- 0083_client_search_indexes.sql
-- Week 5 — "Index client lookup fields for fast search performance" and the
-- server side of "Global client search by name, phone and email with instant
-- typed results".
--
-- Why: client search previously ran a five-column leading-wildcard ILIKE over
-- core.client_profiles, which has no index on any lookup field — a full scan
-- per keystroke. Phones are stored E.164 (+447725485160) but staff type local
-- formats (07725 485160), so phone search also silently missed.
--
-- What this migration adds:
--   1. pg_trgm (trigram) extension — powers substring + fuzzy name/email match
--      so search works "without requiring a space or exact spelling"
--      (Week 5 parent acceptance criterion).
--   2. GIN trigram indexes on the exact expressions the search RPC queries:
--      full name, email, and a digits-only phone rendering.
--   3. crm.search_clients(...) — the single search entry point used by the API
--      (service role only). Bound parameters, rank-ordered, paginated via
--      limit/offset, with the total match count windowed onto every row.
--
-- Access model: the function is intentionally NOT granted to authenticated —
-- tenant scoping (business_id / permitted locations) is enforced by the API,
-- which calls this with the service role and passes the actor's scope as
-- parameters. Granting it to end-user roles would allow cross-tenant probing.

create extension if not exists pg_trgm with schema extensions;

-- Full-name search: one expression index covers first, last, and "first last"
-- so "jonsmi", "smith jon" and "jon smith" all resolve without a column split.
create index if not exists idx_client_profiles_fullname_trgm
  on core.client_profiles
  using gin (lower(first_name || ' ' || last_name) extensions.gin_trgm_ops);

comment on index core.idx_client_profiles_fullname_trgm is
  'Trigram index for substring/fuzzy client name search (0083).';

-- Email search: email is citext, which has no trgm opclass — index the text
-- rendering. Partial: most lookups are for clients that do have an email.
create index if not exists idx_client_profiles_email_trgm
  on core.client_profiles
  using gin (lower(email::text) extensions.gin_trgm_ops)
  where email is not null;

comment on index core.idx_client_profiles_email_trgm is
  'Trigram index for substring client email search (0083).';

-- Phone search: index the digits-only rendering so "+447725485160",
-- "07725 485160" and "(0)7725-485160" are all the same searchable string.
-- The RPC compares digits-to-digits, so stored rows that predate E.164
-- normalisation still match without a backfill.
create index if not exists idx_client_profiles_phone_digits_trgm
  on core.client_profiles
  using gin (regexp_replace(phone, '\D', '', 'g') extensions.gin_trgm_ops)
  where phone is not null;

comment on index core.idx_client_profiles_phone_digits_trgm is
  'Trigram index over digits-only phone for format-insensitive search (0083).';

-- The search entry point. STABLE SQL (not security definer): it is executed by
-- the API''s service-role connection, which already bypasses RLS; keeping it a
-- plain function avoids search_path/definer pitfalls. All identifiers from the
-- extensions schema are qualified so resolution never depends on search_path.
create or replace function crm.search_clients(
  p_business_id uuid,
  p_location_ids uuid[] default null,
  p_term text default '',
  p_limit integer default 20,
  p_offset integer default 0
)
returns table (
  id uuid,
  client_code text,
  first_name text,
  last_name text,
  email text,
  phone text,
  primary_location_id uuid,
  rank real,
  total_count bigint
)
language sql
stable
as $$
  with input as (
    select
      lower(trim(coalesce(p_term, ''))) as term,
      -- LIKE-escaped variant of the term for the substring legs, so a typed
      -- "%", "_" or "\" is matched literally instead of acting as a wildcard.
      replace(replace(replace(lower(trim(coalesce(p_term, ''))), '\', '\\'), '%', '\%'), '_', '\_') as term_like,
      upper(trim(coalesce(p_term, ''))) as term_code,
      regexp_replace(coalesce(p_term, ''), '\D', '', 'g') as digits
  ),
  norm as (
    select
      term,
      term_like,
      term_code,
      -- Strip one leading trunk zero so a local "07725..." matches the stored
      -- "+447725..." country-code rendering by digit suffix.
      case when digits like '0%' then substring(digits from 2) else digits end as digits_alt
    from input
  )
  select
    c.id,
    c.client_code,
    c.first_name,
    c.last_name,
    c.email::text,
    c.phone,
    c.primary_location_id,
    greatest(
      extensions.similarity(lower(c.first_name || ' ' || c.last_name), n.term),
      case when c.email is not null
           then extensions.similarity(lower(c.email::text), n.term)
           else 0 end,
      case when length(n.digits_alt) >= 3 and c.phone is not null
                and regexp_replace(c.phone, '\D', '', 'g') like '%' || n.digits_alt || '%'
           then 0.9 else 0 end,
      case when c.client_code = n.term_code then 1.0
           when c.client_code like n.term_code || '%' then 0.8
           else 0 end
    )::real as rank,
    count(*) over () as total_count
  from core.client_profiles c
  cross join norm n
  where n.term <> ''
    and c.business_id = p_business_id
    and (p_location_ids is null or c.primary_location_id = any (p_location_ids))
    and (
      -- Substring on name/email (hits the trgm GIN indexes)…
      lower(c.first_name || ' ' || c.last_name) like '%' || n.term_like || '%'
      or (c.email is not null and lower(c.email::text) like '%' || n.term_like || '%')
      -- …fuzzy name for misspellings ("no exact spelling" acceptance)…
      or lower(c.first_name || ' ' || c.last_name) operator(extensions.%) n.term
      -- …digits-to-digits phone match…
      or (length(n.digits_alt) >= 3 and c.phone is not null
          and regexp_replace(c.phone, '\D', '', 'g') like '%' || n.digits_alt || '%')
      -- …and Q-code prefix.
      or c.client_code like n.term_code || '%'
    )
  order by rank desc, c.updated_at desc
  limit greatest(1, least(coalesce(p_limit, 20), 100))
  offset greatest(coalesce(p_offset, 0), 0)
$$;

comment on function crm.search_clients(uuid, uuid[], text, integer, integer) is
  'Ranked, paginated client search over name/email/phone/Q-code. Service-role '
  'only: the API passes the actor''s business and permitted locations as bound '
  'parameters (p_location_ids null = business-wide/owner). total_count is the '
  'full match count windowed onto every returned row.';

-- Functions default to EXECUTE for PUBLIC; PostgREST exposes crm.* RPCs, so an
-- end-user JWT could otherwise call this with an arbitrary business id.
revoke all on function crm.search_clients(uuid, uuid[], text, integer, integer) from public;
revoke all on function crm.search_clients(uuid, uuid[], text, integer, integer) from anon;
revoke all on function crm.search_clients(uuid, uuid[], text, integer, integer) from authenticated;
grant execute on function crm.search_clients(uuid, uuid[], text, integer, integer) to service_role;
