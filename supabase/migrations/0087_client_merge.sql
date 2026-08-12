-- 0087_client_merge.sql
-- Duplicate-client remediation (Client Hub): tombstone column + merge RPC.
--
-- Why: core.client_profiles has no hard uniqueness on email/phone (deliberate —
-- family members legitimately share an inbox), and the soft duplicate checks
-- only landed in July, so real businesses carry duplicate profiles that split
-- a client's history (visits, bills, allergies, patch tests, colour formulas)
-- across rows. The API gains a merge endpoint; this migration provides:
--
--   1. core.client_profiles.merged_into_id — the tombstone pointer. A merged
--      row keeps existing (audit, provenance) but is hidden from lists and
--      search, and points at the profile that absorbed it.
--   2. crm.search_clients — re-created with a `merged_into_id is null` filter
--      so tombstones never surface in the palette/Client Hub/bill finder.
--   3. crm.merge_clients — the atomic merge: repoints EVERY foreign key that
--      references core.client_profiles(id) (discovered from the catalog, so
--      tables added later are covered automatically), moves the client-account
--      link, fills contact gaps on the survivor, and tombstones the duplicate.
--
-- Access model: service-role only, like every other crm.* RPC — the API is
-- the gatekeeper (role/permission/location checks + audit trail).

alter table core.client_profiles
  add column if not exists merged_into_id uuid references core.client_profiles(id) on delete set null;

comment on column core.client_profiles.merged_into_id is
  'Tombstone pointer (0087): set when this profile was merged into another. '
  'Merged rows are hidden from lists/search but kept for audit and provenance.';

create index if not exists idx_client_profiles_merged_into
  on core.client_profiles (merged_into_id)
  where merged_into_id is not null;

-- ---------------------------------------------------------------------------
-- Search: identical to 0083 except tombstoned rows are excluded.
-- ---------------------------------------------------------------------------
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
      replace(replace(replace(lower(trim(coalesce(p_term, ''))), '\', '\\'), '%', '\%'), '_', '\_') as term_like,
      upper(trim(coalesce(p_term, ''))) as term_code,
      replace(replace(replace(upper(trim(coalesce(p_term, ''))), '\', '\\'), '%', '\%'), '_', '\_') as term_code_like,
      regexp_replace(coalesce(p_term, ''), '\D', '', 'g') as digits
  ),
  norm as (
    select
      term,
      term_like,
      term_code,
      term_code_like,
      case
        when digits like '00%' then substring(digits from 3)
        when digits like '0%' then substring(digits from 2)
        else digits
      end as digits_alt
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
      case when c.phone is not null and (
             (length(n.digits_alt) >= 3
              and regexp_replace(c.phone, '\D', '', 'g') like '%' || n.digits_alt || '%')
             or (length(n.digits_alt) >= 9
                 and right(regexp_replace(c.phone, '\D', '', 'g'), 9) = right(n.digits_alt, 9)))
           then 0.9 else 0 end,
      case when c.client_code = n.term_code then 1.0
           when c.client_code like n.term_code_like || '%' escape '\' then 0.8
           when c.client_code like '%' || n.term_code_like || '%' escape '\' then 0.65
           else 0 end
    )::real as rank,
    count(*) over () as total_count
  from core.client_profiles c
  cross join norm n
  where n.term <> ''
    and c.business_id = p_business_id
    and c.merged_into_id is null
    and (p_location_ids is null or c.primary_location_id = any (p_location_ids))
    and (
      lower(c.first_name || ' ' || c.last_name) like '%' || n.term_like || '%' escape '\'
      or (c.email is not null
          and lower(c.email::text) like '%' || n.term_like || '%' escape '\')
      or lower(c.first_name || ' ' || c.last_name) operator(extensions.%) n.term
      or (length(n.digits_alt) >= 3 and c.phone is not null
          and regexp_replace(c.phone, '\D', '', 'g') like '%' || n.digits_alt || '%')
      or (length(n.digits_alt) >= 9 and c.phone is not null
          and right(regexp_replace(c.phone, '\D', '', 'g'), 9) = right(n.digits_alt, 9))
      or c.client_code like '%' || n.term_code_like || '%' escape '\'
    )
  order by rank desc, c.updated_at desc, c.id desc
  limit greatest(1, least(coalesce(p_limit, 20), 100))
  offset greatest(coalesce(p_offset, 0), 0)
$$;

-- ---------------------------------------------------------------------------
-- Merge: one transaction, catalog-discovered foreign keys.
-- ---------------------------------------------------------------------------
create or replace function crm.merge_clients(
  p_business_id uuid,
  p_primary_id uuid,
  p_duplicate_id uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_primary core.client_profiles%rowtype;
  v_duplicate core.client_profiles%rowtype;
  v_fk record;
  v_count integer;
  v_moved jsonb := '{}'::jsonb;
begin
  if p_primary_id = p_duplicate_id then
    raise exception 'Cannot merge a client into itself';
  end if;

  select * into v_primary from core.client_profiles
    where id = p_primary_id and business_id = p_business_id for update;
  if not found then raise exception 'Surviving client not found in this business'; end if;
  select * into v_duplicate from core.client_profiles
    where id = p_duplicate_id and business_id = p_business_id for update;
  if not found then raise exception 'Duplicate client not found in this business'; end if;
  if v_primary.merged_into_id is not null then
    raise exception 'The surviving client has itself been merged already';
  end if;
  if v_duplicate.merged_into_id is not null then
    raise exception 'This duplicate has already been merged';
  end if;
  if v_primary.user_profile_id is not null and v_duplicate.user_profile_id is not null
     and v_primary.user_profile_id <> v_duplicate.user_profile_id then
    raise exception 'Both profiles are linked to different client accounts — they cannot be auto-merged';
  end if;

  -- Move the login link to the survivor. unique(business_id, user_profile_id)
  -- forces the clear-then-set order.
  if v_duplicate.user_profile_id is not null then
    update core.client_profiles set user_profile_id = null where id = p_duplicate_id;
    if v_primary.user_profile_id is null then
      update core.client_profiles set user_profile_id = v_duplicate.user_profile_id
        where id = p_primary_id;
    end if;
  end if;

  -- Repoint every foreign key that references core.client_profiles(id).
  -- Discovered from the catalog so future tables (bills already, EOD later…)
  -- are covered without touching this function. The self-referencing
  -- merged_into_id FK is handled explicitly below, not in the loop.
  for v_fk in
    select con.conrelid::regclass as table_name, att.attname as column_name
    from pg_constraint con
    join pg_attribute att
      on att.attrelid = con.conrelid and att.attnum = con.conkey[1]
    where con.contype = 'f'
      and con.confrelid = 'core.client_profiles'::regclass
      and array_length(con.conkey, 1) = 1
      and con.conrelid <> 'core.client_profiles'::regclass
  loop
    execute format(
      'update %s set %I = $1 where %I = $2',
      v_fk.table_name, v_fk.column_name, v_fk.column_name
    ) using p_primary_id, p_duplicate_id;
    get diagnostics v_count = row_count;
    if v_count > 0 then
      v_moved := v_moved || jsonb_build_object(v_fk.table_name::text, v_count);
    end if;
  end loop;

  -- Earlier tombstones that pointed at the duplicate now follow the survivor,
  -- so chains never form.
  update core.client_profiles
    set merged_into_id = p_primary_id
    where merged_into_id = p_duplicate_id;

  -- Fill contact gaps on the survivor from the duplicate (never overwrite).
  update core.client_profiles set
    email = coalesce(email, v_duplicate.email),
    phone = coalesce(phone, v_duplicate.phone),
    date_of_birth = coalesce(date_of_birth, v_duplicate.date_of_birth),
    communication_preference = coalesce(communication_preference, v_duplicate.communication_preference)
  where id = p_primary_id;

  update core.client_profiles set merged_into_id = p_primary_id where id = p_duplicate_id;

  return jsonb_build_object('moved', v_moved);
end;
$$;

comment on function crm.merge_clients(uuid, uuid, uuid) is
  'Merges a duplicate client profile into a surviving one: repoints every '
  'catalog-discovered FK, moves the login link, fills contact gaps and '
  'tombstones the duplicate via merged_into_id. Service-role only; the API '
  'performs authorisation and writes the audit trail.';

revoke all on function crm.merge_clients(uuid, uuid, uuid) from public;
revoke all on function crm.merge_clients(uuid, uuid, uuid) from anon;
revoke all on function crm.merge_clients(uuid, uuid, uuid) from authenticated;
grant execute on function crm.merge_clients(uuid, uuid, uuid) to service_role;
