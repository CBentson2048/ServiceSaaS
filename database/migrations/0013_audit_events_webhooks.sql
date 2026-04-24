-- 0013_audit_events_webhooks.sql

create type audit.webhook_status_enum as enum (
  'received',
  'processing',
  'processed',
  'failed',
  'ignored'
);

create type audit.login_event_status_enum as enum (
  'success',
  'failure',
  'mfa_challenge',
  'locked_out'
);

create type audit.export_event_status_enum as enum (
  'queued',
  'running',
  'completed',
  'failed',
  'expired'
);

create table audit.audit_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  actor_user_profile_id uuid references core.user_profiles(id) on delete set null,
  entity_schema text not null,
  entity_table text not null,
  entity_id uuid,
  action text not null,
  request_id text,
  ip_address inet,
  user_agent text,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table audit.webhook_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid references core.businesses(id) on delete set null,
  location_id uuid references core.locations(id) on delete set null,
  provider text not null,
  event_type text not null,
  external_event_id text,
  status audit.webhook_status_enum not null default 'received',
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  payload_json jsonb not null,
  response_json jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  unique nulls not distinct (provider, external_event_id)
);

create table audit.login_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid references core.businesses(id) on delete set null,
  location_id uuid references core.locations(id) on delete set null,
  user_profile_id uuid references core.user_profiles(id) on delete set null,
  auth_user_id uuid references auth.users(id) on delete set null,
  status audit.login_event_status_enum not null,
  ip_address inet,
  user_agent text,
  failure_reason text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create table audit.export_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  requested_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  export_type text not null,
  filters_json jsonb not null default '{}'::jsonb,
  status audit.export_event_status_enum not null default 'queued',
  storage_bucket text,
  storage_path text,
  expires_at timestamptz,
  completed_at timestamptz,
  error_message text,
  created_at timestamptz not null default now()
);
