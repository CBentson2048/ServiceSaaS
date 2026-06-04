-- 0032_whatsapp_content_templates_and_callbacks.sql
--
-- Production WhatsApp messaging hardening:
--  * `skipped` delivery status so the message log can truthfully record sends that were
--    intentionally not delivered (client ineligible for WhatsApp) rather than faking success
--    or silently cancelling. Mirrors `CrmMessageDeliveryStatus` in @sheer/domain.
--  * `direction` on message_logs to distinguish outbound notifications from inbound
--    WhatsApp replies received via the Twilio inbound webhook.
--
-- NOTE: `alter type ... add value` cannot be used within the same transaction that
-- references the new value, so this migration only *declares* the value; the application
-- (notification dispatcher) is what later writes it.

alter type comms.notification_status_enum add value if not exists 'skipped';

alter table comms.message_logs
  add column if not exists direction text not null default 'outbound'
    check (direction in ('outbound', 'inbound'));

comment on column comms.message_logs.direction is
  'outbound = notification we sent; inbound = WhatsApp/SMS reply received via Twilio inbound webhook.';

-- Inbound replies and status callbacks are matched to a log row by provider message SID.
-- `message_logs_provider_message_id_idx (provider, provider_message_id)` (0020) already
-- backs that lookup; no new index required.
