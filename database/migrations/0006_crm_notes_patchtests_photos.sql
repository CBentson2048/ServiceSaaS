-- 0006_crm_notes_patchtests_photos.sql

create type crm.note_type_enum as enum (
  'general',
  'consultation',
  'medical',
  'internal'
);

create type crm.patch_test_result_enum as enum (
  'pending',
  'clear',
  'reaction',
  'waived'
);

create type crm.allergy_severity_enum as enum (
  'low',
  'medium',
  'high'
);

create type crm.photo_category_enum as enum (
  'before',
  'after',
  'reference',
  'patch_test',
  'other'
);

create table crm.client_notes (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  author_user_profile_id uuid references core.user_profiles(id) on delete set null,
  author_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  note_type crm.note_type_enum not null default 'general',
  note_body text not null,
  is_pinned boolean not null default false,
  is_client_visible boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table crm.patch_tests (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  service_id uuid references booking.services(id) on delete set null,
  performed_by_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  performed_at timestamptz not null,
  expires_at timestamptz,
  result crm.patch_test_result_enum not null default 'pending',
  notes text,
  attachment_metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table crm.allergy_records (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  recorded_by_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  allergen_name text not null,
  severity crm.allergy_severity_enum not null default 'medium',
  reaction_details text,
  notes text,
  is_active boolean not null default true,
  recorded_at timestamptz not null default now(),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table crm.visit_summaries (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  visit_id uuid not null unique references booking.visits(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  author_staff_profile_id uuid references core.staff_profiles(id) on delete set null,
  summary_text text not null,
  homecare_advice text,
  next_visit_recommendation text,
  is_client_visible boolean not null default true,
  contains_sensitive_detail boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table crm.visit_summaries is
  'Client-safe visit summary is kept separate from formula detail so customer access can stay conservative.';

create table crm.visit_photos (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  visit_id uuid not null references booking.visits(id) on delete cascade,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  uploaded_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  category crm.photo_category_enum not null default 'other',
  storage_bucket text not null,
  storage_path text not null,
  filename text,
  mime_type text,
  byte_size bigint,
  captured_at timestamptz,
  is_client_visible boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
