-- 0018_crm_foundation.sql
-- CRM V1 foundation: staff-visible salon client records.

create type crm.client_note_type_enum as enum (
  'general',
  'consultation',
  'formula_note',
  'service_note',
  'gdpr'
);

create type crm.allergy_severity_enum as enum (
  'unknown',
  'mild',
  'moderate',
  'severe'
);

create type crm.patch_test_status_enum as enum (
  'pending',
  'passed',
  'failed',
  'expired'
);

create type crm.visit_photo_type_enum as enum (
  'before',
  'after',
  'inspiration',
  'condition',
  'other'
);

create type crm.gdpr_request_type_enum as enum (
  'export',
  'delete',
  'rectify',
  'restrict_processing'
);

create type crm.gdpr_request_status_enum as enum (
  'requested',
  'in_review',
  'completed',
  'rejected'
);

create table crm.client_notes (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  visit_id uuid references booking.visits(id) on delete set null,
  note_type crm.client_note_type_enum not null default 'general',
  content text not null,
  created_by_user_id uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (length(btrim(content)) > 0)
);

comment on table crm.client_notes is
  'Staff-side CRM notes. Do not expose formula ingredients, product costs, or Sheer Lab internals to clients.';

create table crm.allergy_records (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  allergen_name text not null,
  severity crm.allergy_severity_enum not null default 'unknown',
  notes text,
  is_active boolean not null default true,
  recorded_at timestamptz not null default now(),
  recorded_by_user_id uuid references core.user_profiles(id) on delete set null,
  check (length(btrim(allergen_name)) > 0)
);

create table crm.patch_tests (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  performed_at timestamptz not null,
  expires_at timestamptz,
  status crm.patch_test_status_enum not null default 'pending',
  notes text,
  recorded_by_user_id uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (expires_at is null or expires_at >= performed_at)
);

comment on table crm.patch_tests is
  'Patch test records are intentionally alert-ready via status and expires_at.';

create table crm.visit_photos (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  visit_id uuid not null references booking.visits(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  photo_type crm.visit_photo_type_enum not null default 'other',
  storage_bucket text not null,
  storage_path text not null,
  mime_type text,
  uploaded_by_user_id uuid references core.user_profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (storage_bucket, storage_path),
  check (length(btrim(storage_bucket)) > 0),
  check (length(btrim(storage_path)) > 0)
);

create table crm.gdpr_requests (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  request_type crm.gdpr_request_type_enum not null,
  status crm.gdpr_request_status_enum not null default 'requested',
  requested_by_user_id uuid references core.user_profiles(id) on delete set null,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  notes text,
  metadata jsonb not null default '{}'::jsonb
);

alter table crm.client_notes enable row level security;
alter table crm.allergy_records enable row level security;
alter table crm.patch_tests enable row level security;
alter table crm.visit_photos enable row level security;
alter table crm.gdpr_requests enable row level security;

create policy crm_client_notes_owner_all
on crm.client_notes
for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

create policy crm_client_notes_staff_location_all
on crm.client_notes
for all
using (location_id is not null and public.has_location_desk_access(business_id, location_id))
with check (location_id is not null and public.has_location_desk_access(business_id, location_id));

create policy crm_allergy_records_owner_all
on crm.allergy_records
for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

create policy crm_allergy_records_staff_select
on crm.allergy_records
for select
using (
  exists (
    select 1
    from core.client_profiles cp
    where cp.id = crm.allergy_records.client_profile_id
      and cp.primary_location_id is not null
      and public.has_location_desk_access(crm.allergy_records.business_id, cp.primary_location_id)
  )
);

create policy crm_patch_tests_owner_all
on crm.patch_tests
for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

create policy crm_patch_tests_staff_location_all
on crm.patch_tests
for all
using (location_id is not null and public.has_location_desk_access(business_id, location_id))
with check (location_id is not null and public.has_location_desk_access(business_id, location_id));

create policy crm_visit_photos_owner_all
on crm.visit_photos
for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

create policy crm_visit_photos_staff_location_all
on crm.visit_photos
for all
using (public.has_location_desk_access(business_id, location_id))
with check (public.has_location_desk_access(business_id, location_id));

create policy crm_gdpr_requests_owner_all
on crm.gdpr_requests
for all
using (public.is_business_owner(business_id))
with check (public.is_business_owner(business_id));

create policy crm_gdpr_requests_staff_select
on crm.gdpr_requests
for select
using (
  exists (
    select 1
    from core.client_profiles cp
    where cp.id = crm.gdpr_requests.client_profile_id
      and cp.primary_location_id is not null
      and public.has_location_desk_access(crm.gdpr_requests.business_id, cp.primary_location_id)
  )
);

create index idx_crm_client_notes_client_created on crm.client_notes (client_profile_id, created_at desc);
create index idx_crm_client_notes_visit_id on crm.client_notes (visit_id);
create index idx_crm_allergy_records_client_active on crm.allergy_records (client_profile_id, is_active);
create index idx_crm_patch_tests_client_expires on crm.patch_tests (client_profile_id, expires_at);
create index idx_crm_visit_photos_visit_created on crm.visit_photos (visit_id, created_at desc);
create index idx_crm_visit_photos_client_created on crm.visit_photos (client_profile_id, created_at desc);
create index idx_crm_gdpr_requests_client_status on crm.gdpr_requests (client_profile_id, status);

create trigger crm_client_notes_set_updated_at
before update on crm.client_notes
for each row execute function public.set_updated_at();

grant select, insert, update, delete on all tables in schema crm to authenticated, service_role;
