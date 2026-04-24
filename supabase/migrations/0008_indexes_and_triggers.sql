-- 0008_indexes_and_triggers.sql

alter table rota.shifts
  add constraint rota_shifts_no_overlap
  exclude using gist (
    staff_profile_id with =,
    tstzrange(scheduled_start_at, scheduled_end_at, '[)') with &&
  )
  where (status <> 'cancelled');

create index idx_core_locations_business_id on core.locations (business_id);
create index idx_core_user_memberships_business_id on core.user_memberships (business_id);
create index idx_core_user_memberships_location_id on core.user_memberships (location_id);
create index idx_core_user_memberships_user_profile_id on core.user_memberships (user_profile_id);
create index idx_core_staff_profiles_business_id on core.staff_profiles (business_id);
create index idx_core_staff_profiles_primary_location_id on core.staff_profiles (primary_location_id);
create index idx_core_client_profiles_business_id on core.client_profiles (business_id);
create index idx_core_client_profiles_primary_location_id on core.client_profiles (primary_location_id);

create index idx_booking_services_business_location on booking.services (business_id, location_id);
create index idx_booking_appointments_business_location_start on booking.appointments (business_id, location_id, scheduled_start_at);
create index idx_booking_appointments_client_profile_id on booking.appointments (client_profile_id);
create index idx_booking_appointments_assigned_staff_profile_id on booking.appointments (assigned_staff_profile_id);
create index idx_booking_appointment_services_appointment_id on booking.appointment_services (appointment_id);
create index idx_booking_appointment_services_service_id on booking.appointment_services (service_id);
create index idx_booking_appointment_services_staff_profile_id on booking.appointment_services (assigned_staff_profile_id);
create index idx_booking_deposits_appointment_id on booking.deposits (appointment_id);
create index idx_booking_deposits_client_profile_id on booking.deposits (client_profile_id);
create index idx_booking_visits_client_profile_id on booking.visits (client_profile_id);
create index idx_booking_visits_primary_staff_profile_id on booking.visits (primary_staff_profile_id);

create index idx_rota_shifts_location_start on rota.shifts (location_id, scheduled_start_at);
create index idx_rota_shifts_staff_profile_id on rota.shifts (staff_profile_id);
create index idx_rota_shift_breaks_shift_id on rota.shift_breaks (shift_id);
create index idx_rota_leave_requests_staff_profile_id on rota.leave_requests (staff_profile_id);
create index idx_rota_absence_events_staff_profile_id on rota.absence_events (staff_profile_id);

create index idx_billing_tax_settings_business_location on billing.tax_settings (business_id, location_id);
create index idx_comms_notification_events_client_profile_id on comms.notification_events (client_profile_id);
create index idx_comms_notification_events_appointment_id on comms.notification_events (appointment_id);
create index idx_comms_message_logs_client_profile_id on comms.message_logs (client_profile_id);

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
    'rota.leave_requests',
    'rota.absence_events'
  ] loop
    execute format(
      'create trigger %I before update on %s for each row execute function public.set_updated_at()',
      replace(t, '.', '_') || '_set_updated_at',
      t
    );
  end loop;
end
$$;

grant select, insert, update, delete on all tables in schema
  core,
  booking,
  crm,
  rota,
  lab,
  inventory,
  billing,
  analytics,
  comms,
  audit
to authenticated, service_role;
