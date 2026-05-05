-- 0012_staff_invitations_function_fix.sql
--
-- 0011 introduced core.accept_staff_invitation and core.update_staff_member
-- with a RETURNS TABLE clause whose column names (business_id, location_id,
-- user_profile_id, role, status, ...) collide with the real table columns
-- referenced inside ON CONFLICT (...) and WHERE (...) clauses inside the
-- function body. PostgreSQL surfaces this as:
--
--   ERROR: column reference "business_id" is ambiguous
--
-- Surgical fix: re-create both functions with the PL/pgSQL directive
-- `#variable_conflict use_column`, which tells PL/pgSQL that bare
-- identifiers in embedded SQL bind to the table column rather than the
-- OUT-parameter variable of the same name. Function-local variables we
-- actually use are all v_-prefixed or p_-prefixed, so they stay
-- unambiguous regardless of the directive.

create or replace function core.accept_staff_invitation(
  p_invitation_id uuid,
  p_user_id uuid,
  p_email text,
  p_first_name text,
  p_last_name text,
  p_phone text,
  p_display_name text
)
returns table (
  user_profile_id uuid,
  business_id uuid,
  location_id uuid,
  membership_id uuid,
  staff_profile_id uuid
)
language plpgsql
security definer
set search_path = public, core, extensions
as $$
#variable_conflict use_column
declare
  v_invitation core.staff_invitations%rowtype;
  v_full_name text;
  v_membership_id uuid;
  v_staff_profile_id uuid;
begin
  select * into v_invitation
  from core.staff_invitations
  where id = p_invitation_id
  for update;

  if v_invitation.id is null then
    raise exception 'invitation_not_found';
  end if;
  if v_invitation.status <> 'pending' then
    raise exception 'invitation_status_%', v_invitation.status using errcode = 'P0001';
  end if;
  if v_invitation.expires_at < now() then
    update core.staff_invitations set status = 'expired', updated_at = now() where id = v_invitation.id;
    raise exception 'invitation_expired';
  end if;

  v_full_name := trim(both ' ' from coalesce(p_first_name, '') || ' ' || coalesce(p_last_name, ''));
  if v_full_name = '' then
    v_full_name := split_part(p_email, '@', 1);
  end if;

  insert into core.user_profiles (id, email, full_name, phone)
  values (p_user_id, lower(p_email), v_full_name, nullif(p_phone, ''))
  on conflict (id) do update
    set email = excluded.email,
        full_name = coalesce(excluded.full_name, core.user_profiles.full_name),
        phone = coalesce(excluded.phone, core.user_profiles.phone),
        updated_at = now();

  insert into core.user_memberships (
    business_id,
    location_id,
    user_profile_id,
    role,
    status,
    invited_by_user_profile_id,
    activated_at
  ) values (
    v_invitation.business_id,
    v_invitation.location_id,
    p_user_id,
    v_invitation.role,
    'active',
    v_invitation.invited_by_user_profile_id,
    now()
  )
  on conflict (business_id, location_id, user_profile_id, role)
  do update set
    status = 'active',
    activated_at = coalesce(core.user_memberships.activated_at, now()),
    suspended_at = null,
    revoked_at = null,
    updated_at = now()
  returning id into v_membership_id;

  if v_invitation.role = 'stylist' then
    insert into core.staff_profiles (
      business_id,
      user_profile_id,
      primary_location_id,
      display_name,
      employment_status,
      is_bookable
    ) values (
      v_invitation.business_id,
      p_user_id,
      v_invitation.location_id,
      coalesce(nullif(p_display_name, ''), v_full_name),
      'active',
      true
    )
    on conflict (business_id, user_profile_id) do update set
      primary_location_id = excluded.primary_location_id,
      display_name = coalesce(excluded.display_name, core.staff_profiles.display_name),
      employment_status = 'active',
      is_bookable = true,
      updated_at = now()
    returning id into v_staff_profile_id;
  end if;

  update core.staff_invitations
  set status = 'accepted',
      accepted_at = now(),
      accepted_by_user_profile_id = p_user_id,
      updated_at = now()
  where id = v_invitation.id;

  return query select
    p_user_id,
    v_invitation.business_id,
    v_invitation.location_id,
    v_membership_id,
    v_staff_profile_id;
end;
$$;

create or replace function core.update_staff_member(
  p_actor_user_id uuid,
  p_business_id uuid,
  p_user_profile_id uuid,
  p_new_role text,
  p_new_location_id uuid,
  p_new_status text,
  p_display_name text,
  p_color_hex text,
  p_bio text,
  p_is_bookable boolean
)
returns table (
  user_profile_id uuid,
  membership_id uuid,
  staff_profile_id uuid,
  role text,
  status text,
  location_id uuid
)
language plpgsql
security definer
set search_path = public, core
as $$
#variable_conflict use_column
declare
  v_actor_membership core.user_memberships%rowtype;
  v_target_membership core.user_memberships%rowtype;
  v_new_role core.membership_role_enum;
  v_new_status core.membership_status_enum;
  v_membership_id uuid;
  v_staff_profile_id uuid;
begin
  select * into v_actor_membership
  from core.user_memberships
  where user_profile_id = p_actor_user_id
    and business_id = p_business_id
    and role = 'owner'
    and status = 'active';
  if v_actor_membership.id is null then
    raise exception 'actor_not_owner' using errcode = 'P0001';
  end if;

  select * into v_target_membership
  from core.user_memberships
  where user_profile_id = p_user_profile_id
    and business_id = p_business_id
  order by case when role = 'owner' then 0 when role = 'manager' then 1 when role = 'stylist' then 2 else 3 end
  limit 1;
  if v_target_membership.id is null then
    raise exception 'target_membership_not_found' using errcode = 'P0001';
  end if;
  if v_target_membership.role = 'owner' then
    raise exception 'cannot_modify_owner' using errcode = 'P0001';
  end if;

  v_new_role := coalesce(nullif(p_new_role, '')::core.membership_role_enum, v_target_membership.role);
  if v_new_role not in ('manager','stylist') then
    raise exception 'invalid_role_target' using errcode = 'P0001';
  end if;

  v_new_status := coalesce(nullif(p_new_status, '')::core.membership_status_enum, v_target_membership.status);
  if v_new_status not in ('active','suspended','revoked') then
    raise exception 'invalid_status_target' using errcode = 'P0001';
  end if;

  if p_new_location_id is null then
    raise exception 'location_required' using errcode = 'P0001';
  end if;

  perform 1 from core.locations
  where id = p_new_location_id and business_id = p_business_id;
  if not found then
    raise exception 'location_outside_business' using errcode = 'P0001';
  end if;

  update core.user_memberships
  set role = v_new_role,
      location_id = p_new_location_id,
      status = v_new_status,
      activated_at = case when v_new_status = 'active' then coalesce(core.user_memberships.activated_at, now()) else core.user_memberships.activated_at end,
      suspended_at = case when v_new_status = 'suspended' then now() else null end,
      revoked_at = case when v_new_status = 'revoked' then now() else null end,
      updated_at = now()
  where id = v_target_membership.id
  returning id into v_membership_id;

  if v_new_role = 'stylist' then
    insert into core.staff_profiles (
      business_id,
      user_profile_id,
      primary_location_id,
      display_name,
      employment_status,
      color_hex,
      bio,
      is_bookable
    ) values (
      p_business_id,
      p_user_profile_id,
      p_new_location_id,
      coalesce(nullif(p_display_name, ''), (
        select full_name from core.user_profiles up where up.id = p_user_profile_id
      )),
      case when v_new_status = 'active' then 'active'::core.staff_employment_status_enum else 'on_leave'::core.staff_employment_status_enum end,
      nullif(p_color_hex, ''),
      nullif(p_bio, ''),
      coalesce(p_is_bookable, true)
    )
    on conflict (business_id, user_profile_id) do update set
      primary_location_id = excluded.primary_location_id,
      display_name = coalesce(excluded.display_name, core.staff_profiles.display_name),
      employment_status = excluded.employment_status,
      color_hex = coalesce(excluded.color_hex, core.staff_profiles.color_hex),
      bio = coalesce(excluded.bio, core.staff_profiles.bio),
      is_bookable = excluded.is_bookable,
      updated_at = now()
    returning id into v_staff_profile_id;
  else
    update core.staff_profiles sp
    set is_bookable = false,
        employment_status = case when v_new_status = 'active' then sp.employment_status else 'on_leave'::core.staff_employment_status_enum end,
        updated_at = now()
    where sp.business_id = p_business_id and sp.user_profile_id = p_user_profile_id
    returning sp.id into v_staff_profile_id;
  end if;

  return query select
    p_user_profile_id,
    v_membership_id,
    v_staff_profile_id,
    v_new_role::text,
    v_new_status::text,
    p_new_location_id;
end;
$$;

comment on function core.accept_staff_invitation is
  'Atomic invitation acceptance: upserts profile, activates membership, optionally creates staff profile, marks invitation accepted. Uses #variable_conflict use_column to disambiguate RETURNS TABLE columns from real table columns.';

comment on function core.update_staff_member is
  'Owner-driven staff update: role (manager/stylist), location, membership status, and staff profile fields. Cannot promote anyone to owner. Uses #variable_conflict use_column to disambiguate RETURNS TABLE columns.';

revoke all on function core.accept_staff_invitation(
  uuid, uuid, text, text, text, text, text
) from public;
grant execute on function core.accept_staff_invitation(
  uuid, uuid, text, text, text, text, text
) to service_role;

revoke all on function core.update_staff_member(
  uuid, uuid, uuid, text, uuid, text, text, text, text, boolean
) from public;
grant execute on function core.update_staff_member(
  uuid, uuid, uuid, text, uuid, text, text, text, text, boolean
) to service_role;
