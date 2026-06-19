-- 0045_appointment_status_rename.sql
--
-- Reshape booking.appointment_status_enum into the canonical 6-state lifecycle
-- (pending → accepted / rejected → checked_in → awaiting_payment → paid) plus the
-- retained terminal states cancelled and no_show.
--
-- Renames the real values (awaiting_acceptance→pending, confirmed→accepted), adds
-- a distinct 'rejected', and merges away the unused in_progress→checked_in,
-- completed→paid and the legacy duplicate 'pending'. booking.visits keeps its own
-- visit_status_enum and is left untouched.
--
-- Written to be IDEMPOTENT / recovery-safe: a previous attempt may have left
-- booking.appointment_status_enum_new behind (and possibly already converted the
-- column). Each step is guarded so re-running converges to the same end state.
-- It must end with exactly ONE type named appointment_status_enum holding the 8
-- values — while both the old and new types coexist, constraint literals bind to
-- the wrong type and raise "operator does not exist: ..._new = appointment_status_enum".

-- Both the exclusion constraint AND the partial index below carry status-literal
-- predicates, so they pin the column to the OLD enum. They must be dropped before
-- the column is retyped (otherwise rebuilding them mid-conversion raises
-- "operator does not exist: ..._new = appointment_status_enum"). Recreated at the end.
alter table booking.appointments
  drop constraint if exists booking_appointments_staff_no_overlap;

drop index if exists booking.idx_booking_appointments_completed_at;

-- Drop the default (re-added at the end). Always safe — no-op if already dropped.
alter table booking.appointments
  alter column status drop default;

-- Create the target type only if it doesn't already exist AND the canonical type
-- hasn't already been migrated (i.e. doesn't already carry 'accepted').
do $$
begin
  if not exists (
    select 1 from pg_type
    where typname = 'appointment_status_enum_new'
      and typnamespace = 'booking'::regnamespace
  ) and not exists (
    select 1 from pg_enum e
    join pg_type t on t.oid = e.enumtypid
    where t.typname = 'appointment_status_enum'
      and t.typnamespace = 'booking'::regnamespace
      and e.enumlabel = 'accepted'
  ) then
    create type booking.appointment_status_enum_new as enum (
      'pending',
      'accepted',
      'rejected',
      'checked_in',
      'awaiting_payment',
      'paid',
      'cancelled',
      'no_show'
    );
  end if;
end $$;

-- Convert the column to the new type only if the new type exists and the column
-- isn't already on it. Remaps every existing row in the cast.
do $$
begin
  if exists (
    select 1 from pg_type
    where typname = 'appointment_status_enum_new'
      and typnamespace = 'booking'::regnamespace
  ) and (
    select atttypid::regtype from pg_attribute
    where attrelid = 'booking.appointments'::regclass and attname = 'status'
  ) <> 'booking.appointment_status_enum_new'::regtype then
    alter table booking.appointments
      alter column status type booking.appointment_status_enum_new
      using (
        case status::text
          when 'awaiting_acceptance' then 'pending'
          when 'confirmed' then 'accepted'
          when 'in_progress' then 'checked_in'
          when 'completed' then 'paid'
          else status::text
        end::booking.appointment_status_enum_new
      );
  end if;
end $$;

-- Retire the old type and promote the new one to the canonical name. After this
-- there is exactly one type named appointment_status_enum.
do $$
begin
  if exists (
    select 1 from pg_type
    where typname = 'appointment_status_enum_new'
      and typnamespace = 'booking'::regnamespace
  ) then
    drop type if exists booking.appointment_status_enum;
    alter type booking.appointment_status_enum_new rename to appointment_status_enum;
  end if;
end $$;

-- Re-add the default and the no-overlap constraint against the single canonical
-- type. Slot-reserving (active) statuses: pending, accepted, checked_in.
alter table booking.appointments
  alter column status set default 'pending';

alter table booking.appointments
  add constraint booking_appointments_staff_no_overlap
  exclude using gist (
    business_id with =,
    location_id with =,
    assigned_staff_profile_id with =,
    tstzrange(scheduled_start_at, scheduled_end_at, '[)') with &&
  )
  where (
    assigned_staff_profile_id is not null
    and status in ('pending', 'accepted', 'checked_in')
  );

-- Recreate the "done appointments by completion time" partial index. Its old
-- predicate was status = 'completed', which has been merged into 'paid'.
create index if not exists idx_booking_appointments_completed_at
  on booking.appointments (business_id, location_id, completed_at desc)
  where status = 'paid';
