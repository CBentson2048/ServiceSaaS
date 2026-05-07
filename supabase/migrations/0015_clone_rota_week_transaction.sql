-- 0015_clone_rota_week_transaction.sql
--
-- Transactional helper for the manager "Clone last week" flow. The API
-- performs role/location authorization before calling this function; this
-- function keeps the actual shift + break clone atomic so callers cannot end
-- up with a partially-created target week if a later insert fails.

create or replace function rota.clone_previous_week(
  p_actor_user_profile_id uuid,
  p_actor_role core.membership_role_enum,
  p_business_id uuid,
  p_location_id uuid,
  p_target_week_start timestamptz
)
returns table (
  shifts_created integer,
  breaks_created integer
)
language plpgsql
security definer
set search_path = rota, core, audit, public, extensions
as $$
declare
  v_target_start timestamptz := date_trunc('day', p_target_week_start);
  v_previous_start timestamptz := date_trunc('day', p_target_week_start) - interval '7 days';
  v_previous_end timestamptz := date_trunc('day', p_target_week_start);
  v_old_shift rota.shifts%rowtype;
  v_new_shift_id uuid;
  v_shift_count integer := 0;
  v_break_count integer := 0;
begin
  if exists (
    select 1
    from rota.shifts s
    where s.business_id = p_business_id
      and s.location_id = p_location_id
      and s.scheduled_start_at >= v_target_start
      and s.scheduled_start_at < v_target_start + interval '7 days'
  ) then
    raise exception 'Target week already has shifts'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1
    from rota.shifts s
    where s.business_id = p_business_id
      and s.location_id = p_location_id
      and s.scheduled_start_at >= v_previous_start
      and s.scheduled_start_at < v_previous_end
  ) then
    raise exception 'No shifts found in the previous week'
      using errcode = 'P0001';
  end if;

  for v_old_shift in
    select s.*
    from rota.shifts s
    where s.business_id = p_business_id
      and s.location_id = p_location_id
      and s.scheduled_start_at >= v_previous_start
      and s.scheduled_start_at < v_previous_end
    order by s.scheduled_start_at, s.id
  loop
    insert into rota.shifts (
      business_id,
      location_id,
      staff_profile_id,
      status,
      scheduled_start_at,
      scheduled_end_at,
      source,
      notes,
      metadata
    )
    values (
      v_old_shift.business_id,
      v_old_shift.location_id,
      v_old_shift.staff_profile_id,
      'published',
      v_old_shift.scheduled_start_at + interval '7 days',
      v_old_shift.scheduled_end_at + interval '7 days',
      v_old_shift.source,
      v_old_shift.notes,
      coalesce(v_old_shift.metadata, '{}'::jsonb)
        || jsonb_build_object('cloned_from_shift_id', v_old_shift.id)
    )
    returning id into v_new_shift_id;

    v_shift_count := v_shift_count + 1;

    insert into rota.shift_breaks (
      business_id,
      location_id,
      shift_id,
      started_at,
      ended_at,
      is_paid,
      notes
    )
    select
      b.business_id,
      b.location_id,
      v_new_shift_id,
      b.started_at + interval '7 days',
      b.ended_at + interval '7 days',
      b.is_paid,
      b.notes
    from rota.shift_breaks b
    where b.business_id = p_business_id
      and b.location_id = p_location_id
      and b.shift_id = v_old_shift.id;

    get diagnostics breaks_created = row_count;
    v_break_count := v_break_count + breaks_created;

    insert into audit.rota_audit_events (
      business_id,
      location_id,
      actor_user_profile_id,
      actor_role,
      entity_type,
      entity_id,
      action,
      metadata
    )
    values (
      p_business_id,
      p_location_id,
      p_actor_user_profile_id,
      p_actor_role,
      'shift',
      v_new_shift_id,
      'create',
      jsonb_build_object(
        'source', 'clone_last_week',
        'cloned_from_shift_id', v_old_shift.id,
        'target_week_start', v_target_start
      )
    );
  end loop;

  shifts_created := v_shift_count;
  breaks_created := v_break_count;
  return next;
end;
$$;

revoke all on function rota.clone_previous_week(uuid, core.membership_role_enum, uuid, uuid, timestamptz) from public;
grant execute on function rota.clone_previous_week(uuid, core.membership_role_enum, uuid, uuid, timestamptz) to service_role;

create or replace function rota.create_week_from_draft(
  p_actor_user_profile_id uuid,
  p_actor_role core.membership_role_enum,
  p_business_id uuid,
  p_location_id uuid,
  p_target_week_start timestamptz,
  p_shifts jsonb
)
returns table (
  shifts_created integer,
  breaks_created integer
)
language plpgsql
security definer
set search_path = rota, core, audit, public, extensions
as $$
declare
  v_target_start timestamptz := date_trunc('day', p_target_week_start);
  v_shift jsonb;
  v_break jsonb;
  v_new_shift_id uuid;
  v_shift_count integer := 0;
  v_break_count integer := 0;
begin
  if exists (
    select 1
    from rota.shifts s
    where s.business_id = p_business_id
      and s.location_id = p_location_id
      and s.scheduled_start_at >= v_target_start
      and s.scheduled_start_at < v_target_start + interval '7 days'
  ) then
    raise exception 'Target week already has shifts'
      using errcode = 'P0001';
  end if;

  for v_shift in
    select value
    from jsonb_array_elements(coalesce(p_shifts, '[]'::jsonb))
  loop
    insert into rota.shifts (
      business_id,
      location_id,
      staff_profile_id,
      status,
      scheduled_start_at,
      scheduled_end_at,
      source,
      notes,
      metadata
    )
    values (
      p_business_id,
      p_location_id,
      (v_shift ->> 'staffProfileId')::uuid,
      'published',
      (v_shift ->> 'scheduledStartAt')::timestamptz,
      (v_shift ->> 'scheduledEndAt')::timestamptz,
      'rota',
      nullif(v_shift ->> 'notes', ''),
      jsonb_build_object('source', 'new_week_draft')
    )
    returning id into v_new_shift_id;

    v_shift_count := v_shift_count + 1;

    for v_break in
      select value
      from jsonb_array_elements(coalesce(v_shift -> 'breaks', '[]'::jsonb))
    loop
      insert into rota.shift_breaks (
        business_id,
        location_id,
        shift_id,
        started_at,
        ended_at,
        is_paid,
        notes
      )
      values (
        p_business_id,
        p_location_id,
        v_new_shift_id,
        (v_break ->> 'startedAt')::timestamptz,
        (v_break ->> 'endedAt')::timestamptz,
        coalesce((v_break ->> 'isPaid')::boolean, false),
        nullif(v_break ->> 'notes', '')
      );

      v_break_count := v_break_count + 1;
    end loop;

    insert into audit.rota_audit_events (
      business_id,
      location_id,
      actor_user_profile_id,
      actor_role,
      entity_type,
      entity_id,
      action,
      metadata
    )
    values (
      p_business_id,
      p_location_id,
      p_actor_user_profile_id,
      p_actor_role,
      'shift',
      v_new_shift_id,
      'create',
      jsonb_build_object(
        'source', 'new_week_draft',
        'target_week_start', v_target_start
      )
    );
  end loop;

  shifts_created := v_shift_count;
  breaks_created := v_break_count;
  return next;
end;
$$;

revoke all on function rota.create_week_from_draft(uuid, core.membership_role_enum, uuid, uuid, timestamptz, jsonb) from public;
grant execute on function rota.create_week_from_draft(uuid, core.membership_role_enum, uuid, uuid, timestamptz, jsonb) to service_role;
