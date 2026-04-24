-- 0011_comms_notifications_message_logs.sql

create type comms.channel_enum as enum (
  'sms',
  'email',
  'push',
  'whatsapp'
);

create type comms.notification_status_enum as enum (
  'queued',
  'sent',
  'delivered',
  'failed',
  'cancelled'
);

create type comms.preference_value_enum as enum (
  'allow',
  'deny',
  'essential_only'
);

create table comms.message_templates (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete cascade,
  template_key text not null,
  channel comms.channel_enum not null,
  name text not null,
  subject text,
  body text not null,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (business_id, location_id, template_key, channel)
);

create table comms.notification_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  client_profile_id uuid references core.client_profiles(id) on delete set null,
  user_profile_id uuid references core.user_profiles(id) on delete set null,
  appointment_id uuid references booking.appointments(id) on delete set null,
  visit_id uuid references booking.visits(id) on delete set null,
  template_id uuid references comms.message_templates(id) on delete set null,
  channel comms.channel_enum not null,
  event_key text not null,
  status comms.notification_status_enum not null default 'queued',
  payload_json jsonb not null default '{}'::jsonb,
  scheduled_for timestamptz,
  sent_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table comms.message_logs (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete cascade,
  client_profile_id uuid references core.client_profiles(id) on delete set null,
  user_profile_id uuid references core.user_profiles(id) on delete set null,
  notification_event_id uuid references comms.notification_events(id) on delete set null,
  appointment_id uuid references booking.appointments(id) on delete set null,
  visit_id uuid references booking.visits(id) on delete set null,
  channel comms.channel_enum not null,
  provider text,
  provider_message_id text,
  delivery_status comms.notification_status_enum not null default 'queued',
  content_preview text,
  error_message text,
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table comms.communication_preferences_history (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  client_profile_id uuid not null references core.client_profiles(id) on delete cascade,
  changed_by_user_profile_id uuid references core.user_profiles(id) on delete set null,
  channel comms.channel_enum not null,
  preference_value comms.preference_value_enum not null,
  source text not null default 'app',
  reason text,
  effective_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
