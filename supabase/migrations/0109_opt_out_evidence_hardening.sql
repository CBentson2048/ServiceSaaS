-- 0109_opt_out_evidence_hardening.sql
-- Make a client's opt-out un-erasable from a browser session (QLOOQO V1.1 Week 7
-- stabilization, following the Week 7 security audit).
--
-- THE PROBLEM. 0098 created comms.channel_opt_outs and closed with:
--
--     grant select, insert, update, delete on comms.channel_opt_outs
--       to authenticated, service_role;
--
-- alongside an owner policy written `for all`. Between them, a salon owner could
-- DELETE a client's opt-out record straight over PostgREST — no API route
-- required, no audit trail, nothing in the product to show it happened. The
-- record that a client asked to stop being messaged is exactly the record a
-- salon has the strongest incentive to remove, and it is evidence of a consent
-- decision the client made, not salon-owned configuration.
--
-- The UI never offered this, but "the UI does not expose it" is not a control:
-- PostgREST exposes the table directly to any authenticated session.
--
-- WHAT THIS CHANGES. Reads stay exactly as they were — an owner and any active
-- member can still SEE that a client opted out, which is what explains a skipped
-- message in CRM history. Every WRITE now belongs to the service role, which is
-- how the messaging layer already records them: OptOutService runs with the
-- service-role client from inside the API, so no working code path changes.
--
-- RE-CONSENT REMAINS POSSIBLE, and stays explicit. A client replying START is
-- handled by TwilioCallbackService -> OptOutService.clearOptOut() under the
-- service role. What is no longer possible is a salon quietly deleting the
-- record without the client having asked.
--
-- NOTE THE REVOKE. Migration 0002 grants `authenticated` full CRUD by default on
-- new tables in core and comms, so a narrowing GRANT alone is a no-op: the broad
-- grant must be revoked first. That is why 0098's own narrowing grant did not
-- help — it re-granted the same set it was trying to bound.
--
-- EVERY STATEMENT IS IDEMPOTENT. Re-applying is a no-op.

-- =============================================================================
-- 1. Take the write privileges back
-- =============================================================================

revoke all on comms.channel_opt_outs from authenticated;

-- Reads only. INSERT/UPDATE/DELETE are deliberately absent: there is no
-- browser-side write path to this table any more.
grant select on comms.channel_opt_outs to authenticated;

-- The messaging layer keeps full access; it is the only thing that writes here.
grant select, insert, update, delete on comms.channel_opt_outs to service_role;

-- =============================================================================
-- 2. Narrow the policy to match the grant
-- =============================================================================
--
-- Defence in depth. The grant above is already decisive — PostgreSQL checks
-- table privileges before RLS, so a revoked DELETE can never reach a policy —
-- but leaving a policy that reads `for all` would tell the next engineer that
-- owners may write here, which is no longer true.

drop policy if exists comms_channel_opt_outs_owner_all on comms.channel_opt_outs;

drop policy if exists comms_channel_opt_outs_owner_select on comms.channel_opt_outs;
create policy comms_channel_opt_outs_owner_select
on comms.channel_opt_outs for select
to authenticated
using (public.is_business_owner(business_id));

comment on table comms.channel_opt_outs is
  'Client consent evidence: which channels a client has asked not to be messaged on (0098), with '
  'browser-side writes removed in 0109. Readable by the business''s owner and active members so CRM '
  'history can explain a skipped message; writable ONLY by the service role, because this records a '
  'decision the CLIENT made and a salon must not be able to erase it. Re-consent is explicit and '
  'goes through the same server path (a START reply, or an operator action), never a direct delete.';
