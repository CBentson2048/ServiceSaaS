-- 0026_appointment_completion_operational_flow.sql
-- Operational appointment completion state, actor audit, and in-salon checkout settlement.

alter type booking.appointment_status_enum add value if not exists 'awaiting_payment';
alter type booking.appointment_status_enum add value if not exists 'paid';
alter type booking.visit_status_enum add value if not exists 'awaiting_payment';
alter type booking.visit_status_enum add value if not exists 'paid';

alter table booking.appointments
  add column if not exists completed_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  add column if not exists completed_by_staff_profile_id uuid references core.staff_profiles(id) on delete set null;

alter table booking.visits
  add column if not exists completed_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  add column if not exists completed_by_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  add column if not exists checkout_status text not null default 'not_ready',
  add column if not exists checkout_ready_at timestamptz,
  add column if not exists checkout_ready_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  add column if not exists paid_at timestamptz,
  add column if not exists paid_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  add column if not exists paid_by_staff_profile_id uuid references core.staff_profiles(id) on delete set null;

alter table booking.visits
  drop constraint if exists booking_visits_checkout_status_check;

-- Normalize values from the earlier completion-only checkout model before
-- replacing the constraint with the in-salon settlement lifecycle.
update booking.visits
set checkout_status = case checkout_status
  when 'ready_for_checkout' then 'awaiting_payment'
  when 'checked_out' then 'paid'
  else 'not_ready'
end
where checkout_status not in ('not_ready', 'awaiting_payment', 'paid', 'voided');

alter table booking.visits
  add constraint booking_visits_checkout_status_check
  check (checkout_status in ('not_ready', 'awaiting_payment', 'paid', 'voided'));

create table if not exists billing.salon_payments (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  appointment_id uuid not null references booking.appointments(id) on delete cascade,
  visit_id uuid not null references booking.visits(id) on delete cascade,
  payment_method text not null check (payment_method in ('cash', 'card_reader')),
  amount_cents integer not null check (amount_cents >= 0),
  currency_code char(3) not null default 'GBP',
  paid_at timestamptz not null default now(),
  confirmed_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  confirmed_by_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (visit_id)
);

alter table billing.salon_payments enable row level security;

drop trigger if exists salon_payments_set_updated_at on billing.salon_payments;
create trigger salon_payments_set_updated_at
before update on billing.salon_payments
for each row execute function public.set_updated_at();

drop policy if exists salon_payments_management_select on billing.salon_payments;
create policy salon_payments_management_select
on billing.salon_payments for select
using (public.has_location_management_scope(business_id, location_id));

grant select, insert, update on billing.salon_payments to authenticated, service_role;

create index if not exists idx_booking_appointments_completed_at
on booking.appointments (business_id, location_id, completed_at desc)
where status = 'completed';

create index if not exists idx_booking_visits_checkout_ready
on booking.visits (business_id, location_id, checkout_status, checkout_ready_at desc)
where checkout_status = 'awaiting_payment';

create index if not exists idx_billing_salon_payments_visit
on billing.salon_payments (visit_id);
