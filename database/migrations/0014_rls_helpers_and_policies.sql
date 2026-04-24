-- 0014_rls_helpers_and_policies.sql
-- The API is expected to orchestrate most writes. RLS focuses on strict tenant isolation
-- and realistic read visibility, with a few self-service exceptions.

create or replace function public.is_business_owner_or_admin(p_business_id uuid)
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
      and um.role in ('owner', 'admin')
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
        um.role in ('owner', 'admin')
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
        um.role in ('owner', 'admin')
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
        um.role in ('owner', 'admin')
        or (um.role in ('manager', 'front_desk') and p_location_id is not null and um.location_id = p_location_id)
      )
  )
$$;

create or replace function public.has_location_operational_access(p_business_id uuid, p_location_id uuid)
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
        um.role in ('owner', 'admin')
        or (um.role in ('manager', 'front_desk', 'stylist', 'assistant') and p_location_id is not null and um.location_id = p_location_id)
      )
  )
$$;

create or replace function public.can_view_financials(p_business_id uuid, p_location_id uuid)
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
        um.role in ('owner', 'admin')
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

create or replace function public.can_access_client_profile(
  p_client_profile_id uuid,
  p_business_id uuid,
  p_location_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, core, booking, lab
as $$
  with me as (
    select public.current_staff_profile_id(p_business_id) as staff_profile_id
  )
  select
    public.is_client_profile_owner(p_client_profile_id)
    or public.is_business_owner_or_admin(p_business_id)
    or public.has_location_desk_access(p_business_id, p_location_id)
    or exists (
      select 1
      from me
      where me.staff_profile_id is not null
        and (
          exists (
            select 1
            from booking.appointments a
            where a.business_id = p_business_id
              and a.client_profile_id = p_client_profile_id
              and (
                a.assigned_staff_profile_id = me.staff_profile_id
                or a.requested_staff_profile_id = me.staff_profile_id
                or exists (
                  select 1
                  from booking.appointment_services aps
                  where aps.appointment_id = a.id
                    and aps.assigned_staff_profile_id = me.staff_profile_id
                )
              )
          )
          or exists (
            select 1
            from booking.visits v
            where v.business_id = p_business_id
              and v.client_profile_id = p_client_profile_id
              and v.primary_staff_profile_id = me.staff_profile_id
          )
          or exists (
            select 1
            from lab.formulas f
            where f.business_id = p_business_id
              and f.client_profile_id = p_client_profile_id
              and (
                f.created_by_staff_profile_id = me.staff_profile_id
                or f.last_edited_by_staff_profile_id = me.staff_profile_id
              )
          )
        )
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
            or exists (
              select 1
              from booking.appointment_services aps
              where aps.appointment_id = a.id
                and aps.assigned_staff_profile_id = public.current_staff_profile_id(a.business_id)
            )
          )
        )
      )
  )
$$;

create or replace function public.can_access_visit(p_visit_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, booking
as $$
  select exists (
    select 1
    from booking.visits v
    where v.id = p_visit_id
      and (
        public.has_location_desk_access(v.business_id, v.location_id)
        or public.is_client_profile_owner(v.client_profile_id)
        or (
          public.current_staff_profile_id(v.business_id) is not null
          and v.primary_staff_profile_id = public.current_staff_profile_id(v.business_id)
        )
      )
  )
$$;

create or replace function public.can_access_formula(p_formula_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, lab, booking
as $$
  select exists (
    select 1
    from lab.formulas f
    where f.id = p_formula_id
      and (
        public.has_location_management_scope(f.business_id, f.location_id)
        or (
          public.current_staff_profile_id(f.business_id) is not null
          and (
            f.created_by_staff_profile_id = public.current_staff_profile_id(f.business_id)
            or f.last_edited_by_staff_profile_id = public.current_staff_profile_id(f.business_id)
            or exists (
              select 1
              from booking.visits v
              where v.id = f.visit_id
                and v.primary_staff_profile_id = public.current_staff_profile_id(f.business_id)
            )
            or exists (
              select 1
              from booking.appointments a
              where a.id = f.appointment_id
                and (
                  a.assigned_staff_profile_id = public.current_staff_profile_id(f.business_id)
                  or exists (
                    select 1
                    from booking.appointment_services aps
                    where aps.appointment_id = a.id
                      and aps.assigned_staff_profile_id = public.current_staff_profile_id(f.business_id)
                  )
                )
            )
          )
        )
      )
  )
$$;

grant execute on function public.current_user_id() to authenticated, service_role;
grant execute on function public.is_business_owner_or_admin(uuid) to authenticated, service_role;
grant execute on function public.has_location_membership(uuid, uuid) to authenticated, service_role;
grant execute on function public.has_location_management_scope(uuid, uuid) to authenticated, service_role;
grant execute on function public.has_location_desk_access(uuid, uuid) to authenticated, service_role;
grant execute on function public.has_location_operational_access(uuid, uuid) to authenticated, service_role;
grant execute on function public.can_view_financials(uuid, uuid) to authenticated, service_role;
grant execute on function public.current_staff_profile_id(uuid) to authenticated, service_role;
grant execute on function public.is_staff_profile_owner(uuid) to authenticated, service_role;
grant execute on function public.is_client_profile_owner(uuid) to authenticated, service_role;
grant execute on function public.can_access_client_profile(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function public.can_access_appointment(uuid) to authenticated, service_role;
grant execute on function public.can_access_visit(uuid) to authenticated, service_role;
grant execute on function public.can_access_formula(uuid) to authenticated, service_role;

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
    'booking.appointment_status_events',
    'booking.deposits',
    'booking.reschedule_events',
    'booking.waitlist_entries',
    'booking.visits',
    'crm.client_notes',
    'crm.patch_tests',
    'crm.allergy_records',
    'crm.visit_summaries',
    'crm.visit_photos',
    'rota.shifts',
    'rota.shift_breaks',
    'rota.leave_requests',
    'rota.absence_events',
    'rota.availability_overrides',
    'lab.device_pairings',
    'lab.formulas',
    'lab.formula_items',
    'lab.formula_events',
    'lab.formula_versions',
    'lab.formula_costs',
    'inventory.products',
    'inventory.location_stock',
    'inventory.stock_movements',
    'inventory.waste_events',
    'inventory.low_stock_alerts',
    'inventory.product_costs',
    'billing.tax_settings',
    'billing.billing_rules',
    'billing.visit_charges',
    'billing.visit_totals',
    'billing.payments',
    'billing.refunds',
    'analytics.commission_plans',
    'analytics.stylist_target_snapshots',
    'analytics.kpi_snapshots',
    'analytics.commission_runs',
    'analytics.commission_run_lines',
    'analytics.location_daily_metrics',
    'analytics.sheer_lab_metrics',
    'analytics.client_retention_metrics',
    'comms.message_templates',
    'comms.notification_events',
    'comms.message_logs',
    'comms.communication_preferences_history',
    'audit.audit_events',
    'audit.webhook_events',
    'audit.login_events',
    'audit.export_events'
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
    'core.feature_flags',
    'booking.services',
    'booking.stylist_service_assignments',
    'booking.appointments',
    'booking.appointment_services',
    'booking.appointment_status_events',
    'booking.deposits',
    'booking.reschedule_events',
    'booking.waitlist_entries',
    'booking.visits',
    'crm.client_notes',
    'crm.patch_tests',
    'crm.allergy_records',
    'crm.visit_summaries',
    'crm.visit_photos',
    'rota.shifts',
    'rota.shift_breaks',
    'rota.leave_requests',
    'rota.absence_events',
    'rota.availability_overrides',
    'lab.device_pairings',
    'lab.formulas',
    'lab.formula_items',
    'lab.formula_events',
    'lab.formula_versions',
    'lab.formula_costs',
    'inventory.products',
    'inventory.location_stock',
    'inventory.stock_movements',
    'inventory.waste_events',
    'inventory.low_stock_alerts',
    'inventory.product_costs',
    'billing.tax_settings',
    'billing.billing_rules',
    'billing.visit_charges',
    'billing.visit_totals',
    'billing.payments',
    'billing.refunds',
    'analytics.commission_plans',
    'analytics.stylist_target_snapshots',
    'analytics.kpi_snapshots',
    'analytics.commission_runs',
    'analytics.commission_run_lines',
    'analytics.location_daily_metrics',
    'analytics.sheer_lab_metrics',
    'analytics.client_retention_metrics',
    'comms.message_templates',
    'comms.notification_events',
    'comms.message_logs',
    'comms.communication_preferences_history',
    'audit.audit_events',
    'audit.export_events'
  ] loop
    execute format(
      'create policy %I on %s for all using (public.is_business_owner_or_admin(business_id)) with check (public.is_business_owner_or_admin(business_id))',
      replace(t, '.', '_') || '_owner_admin_all',
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
    'booking.services',
    'booking.stylist_service_assignments',
    'booking.appointments',
    'booking.appointment_services',
    'booking.appointment_status_events',
    'booking.deposits',
    'booking.reschedule_events',
    'booking.waitlist_entries',
    'booking.visits',
    'crm.client_notes',
    'crm.patch_tests',
    'crm.allergy_records',
    'crm.visit_summaries',
    'crm.visit_photos',
    'rota.shifts',
    'rota.shift_breaks',
    'rota.leave_requests',
    'rota.absence_events',
    'rota.availability_overrides',
    'lab.device_pairings',
    'lab.formulas',
    'lab.formula_items',
    'lab.formula_events',
    'lab.formula_versions',
    'lab.formula_costs',
    'inventory.location_stock',
    'inventory.stock_movements',
    'inventory.waste_events',
    'inventory.low_stock_alerts',
    'billing.billing_rules',
    'billing.visit_charges',
    'billing.visit_totals',
    'billing.payments',
    'billing.refunds',
    'analytics.stylist_target_snapshots',
    'analytics.kpi_snapshots',
    'analytics.commission_runs',
    'analytics.commission_run_lines',
    'analytics.location_daily_metrics',
    'analytics.sheer_lab_metrics',
    'analytics.client_retention_metrics',
    'comms.message_templates',
    'comms.notification_events',
    'comms.message_logs',
    'comms.communication_preferences_history',
    'audit.audit_events',
    'audit.login_events',
    'audit.export_events'
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
  public.is_business_owner_or_admin(id)
  or exists (
    select 1
    from core.user_memberships um
    where um.business_id = core.businesses.id
      and um.user_profile_id = public.current_user_id()
      and um.status = 'active'
  )
);

create policy core_businesses_owner_admin_manage
on core.businesses
for all
using (public.is_business_owner_or_admin(id))
with check (public.is_business_owner_or_admin(id));

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

create policy core_staff_profiles_team_select
on core.staff_profiles
for select
using (public.has_location_operational_access(business_id, primary_location_id));

create policy core_client_profiles_client_self_select
on core.client_profiles
for select
using (public.is_client_profile_owner(id));

create policy core_client_profiles_staff_access_select
on core.client_profiles
for select
using (public.can_access_client_profile(id, business_id, primary_location_id));

create policy core_location_settings_manager_select
on core.location_settings
for select
using (public.has_location_management_scope(business_id, location_id));

create policy core_feature_flags_manager_select
on core.feature_flags
for select
using (
  public.is_business_owner_or_admin(business_id)
  or (location_id is not null and public.has_location_management_scope(business_id, location_id))
);

do $$
declare
  t text;
begin
  foreach t in array array[
    'booking.services',
    'booking.stylist_service_assignments',
    'booking.appointments',
    'booking.appointment_services',
    'booking.appointment_status_events',
    'booking.deposits',
    'booking.reschedule_events',
    'booking.waitlist_entries',
    'booking.visits',
    'crm.client_notes',
    'crm.patch_tests',
    'crm.allergy_records',
    'crm.visit_summaries',
    'crm.visit_photos',
    'comms.message_templates',
    'comms.notification_events',
    'comms.message_logs',
    'comms.communication_preferences_history'
  ] loop
    execute format(
      'create policy %I on %s for select using (public.has_location_desk_access(business_id, location_id))',
      replace(t, '.', '_') || '_desk_select',
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
    'booking.services',
    'booking.stylist_service_assignments',
    'inventory.location_stock',
    'inventory.stock_movements',
    'inventory.waste_events',
    'inventory.low_stock_alerts'
  ] loop
    execute format(
      'create policy %I on %s for select using (public.has_location_operational_access(business_id, location_id))',
      replace(t, '.', '_') || '_team_select',
      t
    );
  end loop;
end
$$;

create policy inventory_products_team_select
on inventory.products
for select
using (
  public.is_business_owner_or_admin(business_id)
  or exists (
    select 1
    from core.user_memberships um
    where um.business_id = inventory.products.business_id
      and um.user_profile_id = public.current_user_id()
      and um.status = 'active'
      and um.role in ('manager', 'front_desk', 'stylist', 'assistant')
  )
);

create policy booking_services_business_scope_select
on booking.services
for select
using (
  location_id is null
  and (
    public.is_business_owner_or_admin(business_id)
    or exists (
      select 1
      from core.user_memberships um
      where um.business_id = booking.services.business_id
        and um.user_profile_id = public.current_user_id()
        and um.status = 'active'
        and um.role in ('manager', 'front_desk', 'stylist', 'assistant')
    )
  )
);

create policy booking_appointments_client_select
on booking.appointments
for select
using (public.is_client_profile_owner(client_profile_id));

create policy booking_appointments_staff_select
on booking.appointments
for select
using (public.can_access_appointment(id));

create policy booking_appointment_services_related_select
on booking.appointment_services
for select
using (public.can_access_appointment(appointment_id));

create policy booking_appointment_status_events_related_select
on booking.appointment_status_events
for select
using (public.can_access_appointment(appointment_id));

create policy booking_deposits_client_select
on booking.deposits
for select
using (public.is_client_profile_owner(client_profile_id));

create policy booking_reschedule_events_client_select
on booking.reschedule_events
for select
using (public.can_access_appointment(appointment_id));

create policy booking_waitlist_client_select
on booking.waitlist_entries
for select
using (public.is_client_profile_owner(client_profile_id));

create policy booking_visits_client_select
on booking.visits
for select
using (public.is_client_profile_owner(client_profile_id));

create policy booking_visits_staff_select
on booking.visits
for select
using (public.can_access_visit(id));

create policy crm_client_notes_staff_context_select
on crm.client_notes
for select
using (public.can_access_client_profile(client_profile_id, business_id, location_id));

create policy crm_patch_tests_staff_context_select
on crm.patch_tests
for select
using (public.can_access_client_profile(client_profile_id, business_id, location_id));

create policy crm_allergy_records_staff_context_select
on crm.allergy_records
for select
using (public.can_access_client_profile(client_profile_id, business_id, location_id));

create policy crm_visit_summaries_staff_context_select
on crm.visit_summaries
for select
using (public.can_access_client_profile(client_profile_id, business_id, location_id));

create policy crm_visit_summaries_client_visible_select
on crm.visit_summaries
for select
using (public.is_client_profile_owner(client_profile_id) and is_client_visible);

create policy crm_visit_photos_staff_context_select
on crm.visit_photos
for select
using (public.can_access_client_profile(client_profile_id, business_id, location_id));

create policy crm_visit_photos_client_visible_select
on crm.visit_photos
for select
using (public.is_client_profile_owner(client_profile_id) and is_client_visible);

create policy rota_shifts_own_select
on rota.shifts
for select
using (public.is_staff_profile_owner(staff_profile_id));

create policy rota_shift_breaks_own_select
on rota.shift_breaks
for select
using (
  exists (
    select 1
    from rota.shifts s
    where s.id = rota.shift_breaks.shift_id
      and public.is_staff_profile_owner(s.staff_profile_id)
  )
);

create policy rota_leave_requests_own_select
on rota.leave_requests
for select
using (public.is_staff_profile_owner(staff_profile_id));

create policy rota_absence_events_own_select
on rota.absence_events
for select
using (public.is_staff_profile_owner(staff_profile_id));

create policy rota_availability_overrides_own_select
on rota.availability_overrides
for select
using (public.is_staff_profile_owner(staff_profile_id));

create policy lab_formulas_access_select
on lab.formulas
for select
using (public.can_access_formula(id));

create policy lab_formula_items_access_select
on lab.formula_items
for select
using (public.can_access_formula(formula_id));

create policy lab_formula_events_access_select
on lab.formula_events
for select
using (public.can_access_formula(formula_id));

create policy lab_formula_versions_access_select
on lab.formula_versions
for select
using (public.can_access_formula(formula_id));

create policy lab_formula_costs_financial_select
on lab.formula_costs
for select
using (public.can_view_financials(business_id, location_id));

create policy inventory_product_costs_financial_select
on inventory.product_costs
for select
using (public.can_view_financials(business_id, location_id));

create policy billing_tax_settings_financial_select
on billing.tax_settings
for select
using (public.can_view_financials(business_id, location_id));

create policy billing_rules_financial_select
on billing.billing_rules
for select
using (public.can_view_financials(business_id, location_id));

create policy billing_visit_charges_financial_select
on billing.visit_charges
for select
using (public.can_view_financials(business_id, location_id));

create policy billing_visit_charges_client_visible_select
on billing.visit_charges
for select
using (
  is_client_visible
  and exists (
    select 1
    from booking.visits v
    where v.id = billing.visit_charges.visit_id
      and public.is_client_profile_owner(v.client_profile_id)
  )
);

create policy billing_visit_totals_financial_select
on billing.visit_totals
for select
using (public.can_view_financials(business_id, location_id));

create policy billing_visit_totals_client_select
on billing.visit_totals
for select
using (
  exists (
    select 1
    from booking.visits v
    where v.id = billing.visit_totals.visit_id
      and public.is_client_profile_owner(v.client_profile_id)
  )
);

create policy billing_payments_financial_select
on billing.payments
for select
using (public.can_view_financials(business_id, location_id));

create policy billing_payments_client_select
on billing.payments
for select
using (client_profile_id is not null and public.is_client_profile_owner(client_profile_id));

create policy billing_refunds_financial_select
on billing.refunds
for select
using (public.can_view_financials(business_id, location_id));

create policy billing_refunds_client_select
on billing.refunds
for select
using (
  exists (
    select 1
    from billing.payments p
    where p.id = billing.refunds.payment_id
      and p.client_profile_id is not null
      and public.is_client_profile_owner(p.client_profile_id)
  )
);

create policy analytics_commission_plans_financial_select
on analytics.commission_plans
for select
using (
  public.is_business_owner_or_admin(business_id)
  or (location_id is not null and public.can_view_financials(business_id, location_id))
);

create policy analytics_commission_tiers_owner_admin_all
on analytics.commission_tiers
for all
using (
  exists (
    select 1
    from analytics.commission_plans cp
    where cp.id = analytics.commission_tiers.plan_id
      and public.is_business_owner_or_admin(cp.business_id)
  )
)
with check (
  exists (
    select 1
    from analytics.commission_plans cp
    where cp.id = analytics.commission_tiers.plan_id
      and public.is_business_owner_or_admin(cp.business_id)
  )
);

create policy analytics_commission_tiers_financial_select
on analytics.commission_tiers
for select
using (
  exists (
    select 1
    from analytics.commission_plans cp
    where cp.id = analytics.commission_tiers.plan_id
      and (
        public.is_business_owner_or_admin(cp.business_id)
        or (cp.location_id is not null and public.can_view_financials(cp.business_id, cp.location_id))
      )
  )
);

create policy analytics_stylist_targets_self_select
on analytics.stylist_target_snapshots
for select
using (public.is_staff_profile_owner(staff_profile_id));

create policy analytics_kpi_self_select
on analytics.kpi_snapshots
for select
using (staff_profile_id is not null and public.is_staff_profile_owner(staff_profile_id));

create policy analytics_commission_run_lines_self_select
on analytics.commission_run_lines
for select
using (public.is_staff_profile_owner(staff_profile_id));

create policy comms_notification_events_client_select
on comms.notification_events
for select
using (client_profile_id is not null and public.is_client_profile_owner(client_profile_id));

create policy comms_message_logs_client_select
on comms.message_logs
for select
using (client_profile_id is not null and public.is_client_profile_owner(client_profile_id));

create policy comms_preferences_client_select
on comms.communication_preferences_history
for select
using (public.is_client_profile_owner(client_profile_id));

create policy audit_login_events_self_select
on audit.login_events
for select
using (user_profile_id = public.current_user_id());

create policy audit_webhook_events_owner_admin_select
on audit.webhook_events
for select
using (business_id is not null and public.is_business_owner_or_admin(business_id));
