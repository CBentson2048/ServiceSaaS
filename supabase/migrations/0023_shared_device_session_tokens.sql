-- 0023_shared_device_session_tokens.sql
-- Store only hashed shared-device session tokens for the separate Sheer Lab app.

alter table core.shared_devices
  add column if not exists device_session_token_hash text,
  add column if not exists device_session_issued_at timestamptz,
  add column if not exists device_session_revoked_at timestamptz;

create unique index if not exists idx_shared_devices_session_token_hash
on core.shared_devices (device_session_token_hash)
where device_session_token_hash is not null
  and device_session_revoked_at is null;

comment on column core.shared_devices.device_session_token_hash is
  'SHA-256 hash of the backend-issued shared-device session token. Raw tokens live only in platform secure storage on the device.';

comment on column core.shared_devices.device_session_issued_at is
  'Timestamp the current shared-device session token was issued.';

comment on column core.shared_devices.device_session_revoked_at is
  'Set when the shared-device session token is no longer accepted.';
