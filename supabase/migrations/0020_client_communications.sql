-- 0020_client_communications.sql

alter type comms.notification_status_enum add value if not exists 'undelivered';
alter type comms.notification_status_enum add value if not exists 'read';

alter table comms.notification_events
  add column if not exists message_log_id uuid references comms.message_logs(id) on delete set null,
  add column if not exists processing_started_at timestamptz,
  add column if not exists attempts integer not null default 0 check (attempts >= 0),
  add column if not exists last_error_message text,
  add column if not exists locked_until timestamptz;

alter table comms.message_logs
  add column if not exists message_type text,
  add column if not exists template_key text,
  add column if not exists scheduled_for timestamptz,
  add column if not exists payload_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists provider_status text,
  add column if not exists recipient text,
  add column if not exists updated_at timestamptz not null default now();

drop trigger if exists message_logs_set_updated_at on comms.message_logs;
create trigger message_logs_set_updated_at
before update on comms.message_logs
for each row execute function public.set_updated_at();

create index if not exists notification_events_due_queue_idx
on comms.notification_events (scheduled_for, created_at)
where status = 'queued';

create unique index if not exists notification_events_booking_event_unique_idx
on comms.notification_events (appointment_id, event_key, channel)
where appointment_id is not null and status <> 'cancelled';

create index if not exists message_logs_provider_message_id_idx
on comms.message_logs (provider, provider_message_id)
where provider_message_id is not null;

create index if not exists message_logs_client_created_idx
on comms.message_logs (business_id, client_profile_id, created_at desc);

create index if not exists message_logs_location_created_idx
on comms.message_logs (business_id, location_id, created_at desc);

comment on column core.location_settings.metadata is
  'General location settings JSON. Communication settings live under communication: { enabled, enabledChannels, reminderOffsetsHours, sendBookingConfirmation, sendCancellationNotice, sendWaitlistNotifications }.';
