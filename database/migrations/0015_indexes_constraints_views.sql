-- 0015_indexes_constraints_views.sql
-- Final pass for performance, integrity, and client-safe read models.

alter table lab.formula_items
  add constraint formula_items_product_id_fkey
  foreign key (product_id)
  references inventory.products(id)
  on delete set null;

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
create index idx_booking_stylist_service_assignments_staff_profile_id on booking.stylist_service_assignments (staff_profile_id);
create index idx_booking_stylist_service_assignments_service_id on booking.stylist_service_assignments (service_id);
create index idx_booking_appointments_business_location_start on booking.appointments (business_id, location_id, scheduled_start_at);
create index idx_booking_appointments_client_profile_id on booking.appointments (client_profile_id);
create index idx_booking_appointments_assigned_staff_profile_id on booking.appointments (assigned_staff_profile_id);
create index idx_booking_appointment_services_appointment_id on booking.appointment_services (appointment_id);
create index idx_booking_appointment_services_service_id on booking.appointment_services (service_id);
create index idx_booking_appointment_services_staff_profile_id on booking.appointment_services (assigned_staff_profile_id);
create index idx_booking_deposits_appointment_id on booking.deposits (appointment_id);
create index idx_booking_waitlist_entries_client_profile_id on booking.waitlist_entries (client_profile_id);
create index idx_booking_waitlist_entries_location_status on booking.waitlist_entries (location_id, status);
create index idx_booking_visits_client_profile_id on booking.visits (client_profile_id);
create index idx_booking_visits_primary_staff_profile_id on booking.visits (primary_staff_profile_id);

create index idx_crm_client_notes_client_profile_id on crm.client_notes (client_profile_id);
create index idx_crm_patch_tests_client_profile_id on crm.patch_tests (client_profile_id);
create index idx_crm_allergy_records_client_profile_id on crm.allergy_records (client_profile_id);
create index idx_crm_visit_summaries_visit_id on crm.visit_summaries (visit_id);
create index idx_crm_visit_photos_visit_id on crm.visit_photos (visit_id);

create index idx_rota_shifts_location_start on rota.shifts (location_id, scheduled_start_at);
create index idx_rota_shifts_staff_profile_id on rota.shifts (staff_profile_id);
create index idx_rota_shift_breaks_shift_id on rota.shift_breaks (shift_id);
create index idx_rota_leave_requests_staff_profile_id on rota.leave_requests (staff_profile_id);
create index idx_rota_absence_events_staff_profile_id on rota.absence_events (staff_profile_id);
create index idx_rota_availability_overrides_staff_profile_id on rota.availability_overrides (staff_profile_id);

create index idx_lab_formulas_client_profile_id on lab.formulas (client_profile_id);
create index idx_lab_formulas_visit_id on lab.formulas (visit_id);
create index idx_lab_formulas_location_id on lab.formulas (location_id);
create index idx_lab_formula_items_formula_id on lab.formula_items (formula_id);
create index idx_lab_formula_items_product_id on lab.formula_items (product_id);
create index idx_lab_formula_events_formula_id on lab.formula_events (formula_id);
create index idx_lab_formula_versions_formula_id on lab.formula_versions (formula_id);

create index idx_inventory_products_business_id on inventory.products (business_id);
create index idx_inventory_location_stock_location_id on inventory.location_stock (location_id);
create index idx_inventory_location_stock_product_id on inventory.location_stock (product_id);
create index idx_inventory_stock_movements_product_id on inventory.stock_movements (product_id);
create index idx_inventory_stock_movements_formula_id on inventory.stock_movements (formula_id);
create index idx_inventory_stock_movements_visit_id on inventory.stock_movements (visit_id);
create index idx_inventory_waste_events_product_id on inventory.waste_events (product_id);
create index idx_inventory_low_stock_alerts_location_product on inventory.low_stock_alerts (location_id, product_id);

create index idx_billing_tax_settings_business_location on billing.tax_settings (business_id, location_id);
create index idx_billing_visit_charges_visit_id on billing.visit_charges (visit_id);
create index idx_billing_visit_charges_formula_id on billing.visit_charges (formula_id);
create index idx_billing_visit_totals_visit_id on billing.visit_totals (visit_id);
create index idx_billing_payments_visit_id on billing.payments (visit_id);
create index idx_billing_payments_client_profile_id on billing.payments (client_profile_id);
create index idx_billing_refunds_payment_id on billing.refunds (payment_id);

create index idx_analytics_targets_staff_profile_id on analytics.stylist_target_snapshots (staff_profile_id);
create index idx_analytics_kpi_staff_profile_id on analytics.kpi_snapshots (staff_profile_id);
create index idx_analytics_commission_runs_location_id on analytics.commission_runs (location_id);
create index idx_analytics_commission_run_lines_staff_profile_id on analytics.commission_run_lines (staff_profile_id);
create index idx_analytics_location_daily_metrics_location_id on analytics.location_daily_metrics (location_id);
create index idx_analytics_sheer_lab_metrics_location_id on analytics.sheer_lab_metrics (location_id);
create index idx_analytics_client_retention_metrics_client_profile_id on analytics.client_retention_metrics (client_profile_id);

create index idx_comms_templates_business_location on comms.message_templates (business_id, location_id);
create index idx_comms_notification_events_client_profile_id on comms.notification_events (client_profile_id);
create index idx_comms_notification_events_appointment_id on comms.notification_events (appointment_id);
create index idx_comms_message_logs_client_profile_id on comms.message_logs (client_profile_id);

create index idx_audit_events_business_location on audit.audit_events (business_id, location_id);
create index idx_audit_webhook_events_business_id on audit.webhook_events (business_id);
create index idx_audit_login_events_user_profile_id on audit.login_events (user_profile_id);
create index idx_audit_export_events_business_id on audit.export_events (business_id);

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
    'core.feature_flags',
    'booking.services',
    'booking.stylist_service_assignments',
    'booking.appointments',
    'booking.appointment_services',
    'booking.deposits',
    'booking.waitlist_entries',
    'booking.visits',
    'crm.client_notes',
    'crm.patch_tests',
    'crm.allergy_records',
    'crm.visit_summaries',
    'rota.shifts',
    'rota.leave_requests',
    'rota.absence_events',
    'rota.availability_overrides',
    'lab.device_pairings',
    'lab.formulas',
    'lab.formula_items',
    'lab.formula_costs',
    'inventory.products',
    'inventory.location_stock',
    'inventory.product_costs',
    'billing.tax_settings',
    'billing.billing_rules',
    'billing.visit_charges',
    'billing.visit_totals',
    'billing.payments',
    'analytics.commission_plans',
    'analytics.commission_runs',
    'comms.message_templates',
    'comms.notification_events'
  ] loop
    execute format(
      'create trigger %I before update on %s for each row execute function public.set_updated_at()',
      replace(t, '.', '_') || '_set_updated_at',
      t
    );
  end loop;
end
$$;

create view booking.client_safe_appointment_summaries
with (security_invoker = true)
as
select
  a.id,
  a.business_id,
  a.location_id,
  a.client_profile_id,
  a.assigned_staff_profile_id,
  a.staff_request_mode,
  a.status,
  a.scheduled_start_at,
  a.scheduled_end_at,
  a.communication_preference,
  coalesce(
    string_agg(aps.service_name_snapshot, ', ' order by aps.sequence_no),
    ''
  ) as service_summary
from booking.appointments a
left join booking.appointment_services aps on aps.appointment_id = a.id
group by
  a.id,
  a.business_id,
  a.location_id,
  a.client_profile_id,
  a.assigned_staff_profile_id,
  a.staff_request_mode,
  a.status,
  a.scheduled_start_at,
  a.scheduled_end_at,
  a.communication_preference;

comment on view booking.client_safe_appointment_summaries is
  'Client-safe booking projection without formula or owner-only financial detail.';

create view crm.client_safe_visit_summaries
with (security_invoker = true)
as
select
  v.id as visit_id,
  v.business_id,
  v.location_id,
  v.client_profile_id,
  v.completed_at,
  v.client_visible_summary,
  s.summary_text,
  s.homecare_advice,
  s.next_visit_recommendation
from booking.visits v
join crm.visit_summaries s on s.visit_id = v.id
where s.is_client_visible = true;

comment on view crm.client_safe_visit_summaries is
  'Client-facing visit summaries separated from raw lab and billing detail.';
