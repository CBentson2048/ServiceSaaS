-- 0061_book_out_types.sql
-- Configurable "Book Out Types" (a.k.a. calendar block-out / absence reasons).
--
-- Until now, calendar bookouts and rota absences used a fixed 5-value enum
-- (rota.absence_type_enum) with hard-coded behaviour. Per Wrike #4507280825
-- review feedback, each salon needs to configure — per reason — three
-- behaviours that then drive availability, utilisation and (future) payroll:
--
--   1. blocks_appointments       — can clients still be booked over it?
--   2. reduces_available_hours   — is the time removed from the utilisation
--                                  denominator (available working hours)?
--   3. counts_as_paid_time       — does it count as paid working time?
--
-- This migration adds a per-business catalog of book-out types, seeds sensible
-- system defaults for every existing business, and links absence_events to a
-- catalog row (nullable — legacy rows keep the old enum and behave as if they
-- both block appointments and reduce available hours).

-- ---------------------------------------------------------------------------
-- Catalog table
-- ---------------------------------------------------------------------------
create table if not exists rota.book_out_types (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- Stable machine key (unique per business); system rows use well-known keys.
  key text not null,
  name text not null,
  blocks_appointments boolean not null default true,
  reduces_available_hours boolean not null default true,
  counts_as_paid_time boolean not null default false,
  color_hex text,
  -- System rows are seeded by the platform and cannot be deleted (only edited).
  is_system boolean not null default false,
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint book_out_types_key_not_blank check (length(trim(key)) > 0),
  constraint book_out_types_name_not_blank check (length(trim(name)) > 0),
  constraint book_out_types_business_key_unique unique (business_id, key)
);

create index if not exists book_out_types_business_idx
  on rota.book_out_types (business_id, sort_order, name);

-- Keep updated_at fresh on edits.
create or replace function rota.touch_book_out_types_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_book_out_types_updated_at on rota.book_out_types;
create trigger trg_book_out_types_updated_at
  before update on rota.book_out_types
  for each row
  execute function rota.touch_book_out_types_updated_at();

-- ---------------------------------------------------------------------------
-- Link absence events to the catalog (nullable for legacy rows)
-- ---------------------------------------------------------------------------
alter table rota.absence_events
  add column if not exists book_out_type_id uuid
    references rota.book_out_types(id) on delete set null;

create index if not exists absence_events_book_out_type_idx
  on rota.absence_events (book_out_type_id);

-- ---------------------------------------------------------------------------
-- Seed system defaults for every existing business
-- ---------------------------------------------------------------------------
insert into rota.book_out_types (
  business_id, key, name,
  blocks_appointments, reduces_available_hours, counts_as_paid_time,
  color_hex, is_system, sort_order
)
select
  b.id, d.key, d.name,
  d.blocks_appointments, d.reduces_available_hours, d.counts_as_paid_time,
  d.color_hex, true, d.sort_order
from core.businesses b
cross join (values
  ('lunch',         'Lunch',           true,  true,  false, '#94a3b8', 10),
  ('staff_meeting', 'Staff meeting',   true,  true,  true,  '#6366f1', 20),
  ('training',      'Training',        true,  false, true,  '#8b5cf6', 30),
  ('admin',         'Admin',           true,  false, true,  '#0ea5e9', 40),
  ('marketing',     'Marketing',       true,  false, true,  '#14b8a6', 50),
  ('annual_leave',  'Annual leave',    true,  true,  false, '#22c55e', 60),
  ('sick_leave',    'Sick leave',      true,  true,  true,  '#f59e0b', 70),
  ('other',         'Other book out',  true,  true,  false, '#94a3b8', 80)
) as d(key, name, blocks_appointments, reduces_available_hours, counts_as_paid_time, color_hex, sort_order)
on conflict (business_id, key) do nothing;

-- ---------------------------------------------------------------------------
-- RLS — writes flow through the API service role; policies mirror the rota
-- house style (owner full control, managers manage, active members can read
-- so the calendar/booking clients can resolve type behaviour).
-- ---------------------------------------------------------------------------
alter table rota.book_out_types enable row level security;

create policy book_out_types_owner_all
  on rota.book_out_types
  for all
  using (public.is_business_owner(business_id))
  with check (public.is_business_owner(business_id));

create policy book_out_types_member_select
  on rota.book_out_types
  for select
  using (
    exists (
      select 1
      from core.user_memberships um
      where um.user_profile_id = public.current_user_id()
        and um.business_id = rota.book_out_types.business_id
        and um.status = 'active'
    )
  );

create policy book_out_types_manager_write
  on rota.book_out_types
  for all
  using (
    exists (
      select 1
      from core.user_memberships um
      where um.user_profile_id = public.current_user_id()
        and um.business_id = rota.book_out_types.business_id
        and um.status = 'active'
        and um.role = 'manager'
    )
  )
  with check (
    exists (
      select 1
      from core.user_memberships um
      where um.user_profile_id = public.current_user_id()
        and um.business_id = rota.book_out_types.business_id
        and um.status = 'active'
        and um.role = 'manager'
    )
  );
