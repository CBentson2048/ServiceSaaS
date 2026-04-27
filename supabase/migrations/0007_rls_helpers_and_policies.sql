-- 0007_rls_helpers_and_policies.sql
-- Week 1 RLS is intentionally conservative. Most writes should flow through the API service role.

create or replace function public.is_business_owner(p_business_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, core
as $$
  select exists (
    select 1
    from core.user_memberships um
    where um.user_profile_id = public.current_user_id()
      and um.business_id = p_business_id
      and um.status = 'active'
      and um.role = 'owner'
  )
$$;

create or replace function public.has_location_membership(p_business_id uuid, p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, core
as $$
  select exists (
    select 1
    from core.user_memberships um
    where um.user_profile_id = public.current_user_id()
      and um.business_id = p_business_id
      and um.status = 'active'
      and (
        um.role = 'owner'
        or (p_location_id is not null and um.location_id = p_location_id)
      )
  )
$$;

create or replace function public.has_location_management_scope(p_business_id uuid, p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, core
as $$
  select exists (
    select 1
    from core.user_memberships um
    where um.user_profile_id = public.current_user_id()
      and um.business_id = p_business_id
      and um.status = 'active'
      and (
        um.role = 'owner'
        or (um.role = 'manager' and p_location_id is not null and um.location_id = p_location_id)
      )
  )
$$;

create or replace function public.has_location_desk_access(p_business_id uuid, p_location_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, core
as $$
  select exists (
    select 1
    from core.user_memberships um
    where um.user_profile_id = public.current_user_id()
      and um.business_id = p_business_id
      and um.status = 'active'
      and (
        um.role = 'owner'
        or (um.role = 'manager' and p_location_id is not null and um.location_id = p_location_id)
      )
  )
$$;

create or replace function public.current_staff_profile_id(p_business_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, core
as $$
  select sp.id
  from core.staff_profiles sp
  where sp.business_id = p_business_id
    and sp.user_profile_id = public.current_user_id()
  limit 1
$$;

create or replace function public.is_staff_profile_owner(p_staff_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, core
as $$
  select exists (
    select 1
    from core.staff_profiles sp
    where sp.id = p_staff_profile_id
      and sp.user_profile_id = public.current_user_id()
  )
$$;

create or replace function public.is_client_profile_owner(p_client_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, core
as $$
  select exists (
    select 1
    from core.client_profiles cp
    where cp.id = p_client_profile_id
      and cp.user_profile_id = public.current_user_id()
  )
$$;

create or replace function public.can_access_appointment(p_appointment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, booking
as $$
  select exists (
    select 1
    from booking.appointments a
    where a.id = p_appointment_id
      and (
        public.has_location_desk_access(a.business_id, a.location_id)
        or public.is_client_profile_owner(a.client_profile_id)
        or (
          public.current_staff_profile_id(a.business_id) is not null
          and (
            a.assigned_staff_profile_id = public.current_staff_profile_id(a.business_id)
            or a.requested_staff_profile_id = public.current_staff_profile_id(a.business_id)
          )
        )
      )
  )
$$;

grant execute on function public.current_user_id() to authenticated, service_role;
grant execute on function public.is_business_owner(uuid) to authenticated, service_role;
grant execute on function public.has_location_membership(uuid, uuid) to authenticated, service_role;
grant execute on function public.has_location_management_scope(uuid, uuid) to authenticated, service_role;
grant execute on function public.has_location_desk_access(uuid, uuid) to authenticated, service_role;
grant execute on function public.current_staff_profile_id(uuid) to authenticated, service_role;
grant execute on function public.is_staff_profile_owner(uuid) to authenticated, service_role;
grant execute on function public.is_client_profile_owner(uuid) to authenticated, service_role;
grant execute on function public.can_access_appointment(uuid) to authenticated, service_role;

do $$
declare
  t text;
begin
  foreach t in array array[
    'core.businesses',
    'core.locations',
    'core.user_profiles',
    'core.user_memberships',
    'core.staff_profiles',
    'core.client_profiles',
    'core.location_settings',
    'booking.services',
    'booking.appointments',
    'booking.appointment_services',
    'booking.deposits',
    'booking.visits',
    'rota.shifts',
    'rota.shift_breaks',
    'rota.leave_requests',
    'rota.absence_events',
    'billing.tax_settings',
    'billing.billing_rules',
    'comms.notification_events',
    'comms.message_logs'
  ] loop
    execute format('alter table %s enable row level security', t);
  end loop;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'core.locations',
    'core.user_memberships',
    'core.staff_profiles',
    'core.client_profiles',
    'core.location_settings',
    'booking.services',
    'booking.appointments',
    'booking.appointment_services',
    'booking.deposits',
    'booking.visits',
    'rota.shifts',
    'rota.shift_breaks',
    'rota.leave_requests',
    'rota.absence_events',
    'billing.tax_settings',
    'billing.billing_rules',
    'comms.notification_events',
    'comms.message_logs'
  ] loop
    execute format(
      'create policy %I on %s for all using (public.is_business_owner(business_id)) with check (public.is_business_owner(business_id))',
      replace(t, '.', '_') || '_owner_all',
      t
    );
  end loop;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array[
    'core.location_settings',
    'booking.appointments',
    'booking.appointment_services',
    'booking.deposits',
    'booking.visits',
    'rota.shifts',
    'rota.shift_breaks',
    'rota.leave_requests',
    'rota.absence_events',
    'billing.tax_settings',
    'billing.billing_rules',
    'comms.notification_events',
    'comms.message_logs'
  ] loop
    execute format(
      'create policy %I on %s for all using (public.has_location_management_scope(business_id, location_id)) with check (public.has_location_management_scope(business_id, location_id))',
      replace(t, '.', '_') || '_manager_all',
      t
    );
  end loop;
end
$$;

create policy core_businesses_member_select
on core.businesses
for select
using (
  public.is_business_owner(id)
  or exists (
    select 1
    from core.user_memberships um
    where um.business_id = core.businesses.id
      and um.user_profile_id = public.current_user_id()
      and um.status = 'active'
  )
);

create policy core_businesses_owner_all
on core.businesses
for all
using (public.is_business_owner(id))
with check (public.is_business_owner(id));

create policy core_user_profiles_self_select
on core.user_profiles
for select
using (id = public.current_user_id());

create policy core_user_profiles_self_insert
on core.user_profiles
for insert
with check (id = public.current_user_id());

create policy core_user_profiles_self_update
on core.user_profiles
for update
using (id = public.current_user_id())
with check (id = public.current_user_id());

create policy core_locations_member_select
on core.locations
for select
using (public.has_location_membership(business_id, id));

create policy core_user_memberships_self_select
on core.user_memberships
for select
using (user_profile_id = public.current_user_id());

create policy core_staff_profiles_team_select
on core.staff_profiles
for select
using (
  public.has_location_desk_access(business_id, primary_location_id)
  or public.is_staff_profile_owner(id)
);

create policy core_client_profiles_client_self_select
on core.client_profiles
for select
using (public.is_client_profile_owner(id));

create policy core_client_profiles_location_select
on core.client_profiles
for select
using (
  primary_location_id is not null
  and public.has_location_desk_access(business_id, primary_location_id)
);

create policy core_location_settings_select
on core.location_settings
for select
using (public.has_location_management_scope(business_id, location_id));

create policy booking_services_location_select
on booking.services
for select
using (
  (location_id is not null and public.has_location_membership(business_id, location_id))
  or (
    location_id is null
    and exists (
      select 1
      from core.user_memberships um
      where um.business_id = booking.services.business_id
        and um.user_profile_id = public.current_user_id()
        and um.status = 'active'
    )
  )
);

create policy booking_appointments_select
on booking.appointments
for select
using (public.can_access_appointment(id));

create policy booking_appointment_services_select
on booking.appointment_services
for select
using (public.can_access_appointment(appointment_id));

create policy booking_deposits_select
on booking.deposits
for select
using (
  public.is_client_profile_owner(client_profile_id)
  or public.has_location_management_scope(business_id, location_id)
);

create policy booking_visits_select
on booking.visits
for select
using (
  public.is_client_profile_owner(client_profile_id)
  or public.has_location_desk_access(business_id, location_id)
  or (
    primary_staff_profile_id is not null
    and public.is_staff_profile_owner(primary_staff_profile_id)
  )
);

create policy rota_shifts_select
on rota.shifts
for select
using (
  public.has_location_management_scope(business_id, location_id)
  or public.is_staff_profile_owner(staff_profile_id)
);

create policy rota_shift_breaks_select
on rota.shift_breaks
for select
using (
  public.has_location_management_scope(business_id, location_id)
  or exists (
    select 1
    from rota.shifts s
    where s.id = rota.shift_breaks.shift_id
      and public.is_staff_profile_owner(s.staff_profile_id)
  )
);

create policy rota_leave_requests_select
on rota.leave_requests
for select
using (
  public.has_location_management_scope(business_id, location_id)
  or public.is_staff_profile_owner(staff_profile_id)
);

create policy rota_absence_events_select
on rota.absence_events
for select
using (
  public.has_location_management_scope(business_id, location_id)
  or public.is_staff_profile_owner(staff_profile_id)
);

create policy billing_tax_settings_select
on billing.tax_settings
for select
using (
  public.is_business_owner(business_id)
  or (location_id is not null and public.has_location_management_scope(business_id, location_id))
);

create policy billing_billing_rules_select
on billing.billing_rules
for select
using (public.has_location_management_scope(business_id, location_id));

create policy comms_notification_events_location_select
on comms.notification_events
for select
using (
  public.has_location_desk_access(business_id, location_id)
  or (client_profile_id is not null and public.is_client_profile_owner(client_profile_id))
);

create policy comms_message_logs_location_select
on comms.message_logs
for select
using (
  public.has_location_desk_access(business_id, location_id)
  or (client_profile_id is not null and public.is_client_profile_owner(client_profile_id))
);
