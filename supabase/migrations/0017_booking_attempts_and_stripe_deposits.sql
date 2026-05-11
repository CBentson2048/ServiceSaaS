-- 0017_booking_attempts_and_stripe_deposits.sql
--
-- Adds a pending booking-attempt layer so public deposits can be collected
-- before confirmed appointments are written to the calendar.

create type booking.booking_attempt_status_enum as enum (
  'pending_payment',
  'confirmed',
  'payment_failed',
  'cancelled',
  'expired'
);

create table booking.booking_attempts (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  service_id uuid not null references booking.services(id) on delete restrict,
  stylist_profile_id uuid not null references core.staff_profiles(id) on delete restrict,
  client_profile_id uuid not null references core.client_profiles(id) on delete restrict,
  user_profile_id uuid not null references core.user_profiles(id) on delete restrict,
  appointment_id uuid unique references booking.appointments(id) on delete set null,
  staff_request_mode booking.staff_request_mode_enum not null default 'specific_staff',
  selected_start_at timestamptz not null,
  selected_end_at timestamptz not null,
  communication_preference text not null,
  client_note text,
  deposit_amount numeric(12,2) not null check (deposit_amount >= 0),
  currency_code char(3) not null default 'GBP',
  stripe_payment_intent_id text,
  status booking.booking_attempt_status_enum not null default 'pending_payment',
  expires_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (selected_end_at > selected_start_at)
);

comment on table booking.booking_attempts is
  'Payment-backed public booking attempts. Confirmed appointments are created only after verified Stripe payment success.';

alter table booking.deposits
  alter column appointment_id drop not null,
  add column booking_attempt_id uuid references booking.booking_attempts(id) on delete set null;

create index idx_booking_attempts_business_location_start
  on booking.booking_attempts (business_id, location_id, selected_start_at);

create index idx_booking_attempts_client_profile_id
  on booking.booking_attempts (client_profile_id);

create index idx_booking_attempts_status_expires_at
  on booking.booking_attempts (status, expires_at);

create unique index idx_booking_attempts_stripe_payment_intent_id
  on booking.booking_attempts (stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

create index idx_booking_deposits_booking_attempt_id
  on booking.deposits (booking_attempt_id);

create unique index idx_booking_deposits_provider_payment_intent_id
  on booking.deposits (provider_payment_intent_id)
  where provider_payment_intent_id is not null;

create trigger booking_booking_attempts_set_updated_at
before update on booking.booking_attempts
for each row execute function public.set_updated_at();

do $$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgname = 'booking_deposits_set_updated_at'
      and tgrelid = 'booking.deposits'::regclass
  ) then
    create trigger booking_deposits_set_updated_at
    before update on booking.deposits
    for each row execute function public.set_updated_at();
  end if;
end
$$;

alter table booking.booking_attempts enable row level security;

create policy booking_booking_attempts_owner_all
on booking.booking_attempts
for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

create policy booking_booking_attempts_manager_all
on booking.booking_attempts
for all
using (public.has_location_management_scope(business_id, location_id))
with check (public.has_location_management_scope(business_id, location_id));

create policy booking_booking_attempts_client_select
on booking.booking_attempts
for select
using (public.is_client_profile_owner(client_profile_id));

grant select, insert, update, delete on booking.booking_attempts to authenticated, service_role;
