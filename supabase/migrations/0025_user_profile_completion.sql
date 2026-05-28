-- 0025_user_profile_completion.sql
--
-- Complete the existing profile model without introducing a parallel profile system.

alter table core.user_profiles
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists display_name text,
  add column if not exists is_active boolean not null default true;

update core.user_profiles
set
  first_name = coalesce(
    nullif(btrim(first_name), ''),
    nullif(split_part(btrim(full_name), ' ', 1), ''),
    'User'
  ),
  last_name = coalesce(
    nullif(btrim(last_name), ''),
    nullif(btrim(regexp_replace(btrim(full_name), '^\S+\s*', '')), ''),
    'Profile'
  ),
  display_name = coalesce(nullif(btrim(display_name), ''), nullif(btrim(full_name), ''), email::text),
  full_name = coalesce(nullif(btrim(full_name), ''), email::text)
where first_name is null
   or last_name is null
   or display_name is null
   or full_name is null
   or btrim(full_name) = '';

alter table core.user_profiles
  alter column first_name set not null,
  alter column last_name set not null,
  alter column display_name set not null,
  add constraint core_user_profiles_first_name_not_blank check (length(btrim(first_name)) > 0),
  add constraint core_user_profiles_last_name_not_blank check (length(btrim(last_name)) > 0),
  add constraint core_user_profiles_display_name_not_blank check (length(btrim(display_name)) > 0),
  add constraint core_user_profiles_email_format
    check (email::text ~* '^[A-Z0-9._%+\-]+@[A-Z0-9.\-]+\.[A-Z]{2,}$');

alter table core.client_profiles
  add column if not exists notes text;

alter table core.staff_profiles
  add column if not exists contracted_hours numeric(5,2) not null default 0,
  add column if not exists average_bill_benchmark numeric(12,2) not null default 0,
  add column if not exists sheer_lab_pin_enabled boolean not null default false,
  add column if not exists leave_notes text,
  add constraint core_staff_profiles_hourly_rate_non_negative check (hourly_rate >= 0),
  add constraint core_staff_profiles_contracted_hours_range
    check (contracted_hours >= 0 and contracted_hours <= 168),
  add constraint core_staff_profiles_average_bill_benchmark_non_negative
    check (average_bill_benchmark >= 0);

comment on column core.user_profiles.first_name is 'Shared identity first name mirrored from auth-facing account details.';
comment on column core.user_profiles.last_name is 'Shared identity last name mirrored from auth-facing account details.';
comment on column core.user_profiles.display_name is 'Shared display name safe for UI surfaces.';
comment on column core.user_profiles.is_active is 'Application-level active flag; membership status remains tenant-role scoped.';
comment on column core.client_profiles.notes is 'Client profile summary notes for CRM workflows. Detailed notes remain in crm.client_notes.';
comment on column core.staff_profiles.contracted_hours is 'Business-controlled weekly contracted hours for rota/KPI calculations.';
comment on column core.staff_profiles.average_bill_benchmark is 'Business-controlled average bill benchmark for KPI/commission context.';
comment on column core.staff_profiles.sheer_lab_pin_enabled is 'Cached hook for Sheer Lab PIN readiness; credentials remain in core.stylist_pin_credentials.';
comment on column core.staff_profiles.leave_notes is 'Business-controlled leave or absence context summary. Detailed events remain in rota tables.';

create index if not exists idx_core_user_profiles_display_name
  on core.user_profiles (display_name);

create index if not exists idx_core_client_profiles_user_profile_id
  on core.client_profiles (user_profile_id)
  where user_profile_id is not null;

create index if not exists idx_core_staff_profiles_user_location
  on core.staff_profiles (user_profile_id, primary_location_id);

create or replace function core.sync_user_profile_names()
returns trigger
language plpgsql
as $$
begin
  new.first_name := coalesce(
    nullif(btrim(new.first_name), ''),
    nullif(split_part(btrim(new.full_name), ' ', 1), '')
  );
  new.last_name := coalesce(
    nullif(btrim(new.last_name), ''),
    nullif(btrim(regexp_replace(btrim(new.full_name), '^\S+\s*', '')), '')
  );

  if new.first_name is null or new.last_name is null then
    raise exception 'first_name and last_name are required';
  end if;

  new.full_name := btrim(new.first_name || ' ' || new.last_name);
  new.display_name := coalesce(nullif(btrim(new.display_name), ''), new.full_name);
  new.email := lower(new.email::text);
  return new;
end;
$$;

drop trigger if exists core_user_profiles_sync_names on core.user_profiles;
create trigger core_user_profiles_sync_names
before insert or update on core.user_profiles
for each row execute function core.sync_user_profile_names();

create or replace function core.sync_staff_profile_lab_pin_flag()
returns trigger
language plpgsql
as $$
begin
  update core.staff_profiles sp
  set sheer_lab_pin_enabled = exists (
        select 1
        from core.stylist_pin_credentials c
        where c.business_id = sp.business_id
          and c.location_id = sp.primary_location_id
          and c.user_profile_id = sp.user_profile_id
          and c.is_active = true
          and c.status = 'active'
      ),
      updated_at = now()
  where sp.business_id = new.business_id
    and sp.primary_location_id = new.location_id
    and sp.user_profile_id = new.user_profile_id;

  return new;
end;
$$;

drop trigger if exists stylist_pin_credentials_sync_staff_profile on core.stylist_pin_credentials;
create trigger stylist_pin_credentials_sync_staff_profile
after insert or update on core.stylist_pin_credentials
for each row execute function core.sync_staff_profile_lab_pin_flag();

grant execute on function core.sync_user_profile_names() to authenticated, service_role;
grant execute on function core.sync_staff_profile_lab_pin_flag() to authenticated, service_role;
