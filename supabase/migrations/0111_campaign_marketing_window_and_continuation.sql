-- 0111_campaign_marketing_window_and_continuation.sql
-- Week 7 product decisions for proactive marketing (approved by Luke).
--
-- TWO CHANGES, both about WHEN a campaign is allowed to talk to a client and
-- how it finishes a large audience without shouting at anyone twice.
--
--   1. THE MARKETING WINDOW — 09:00-19:00 SALON-LOCAL.
--      Proactive marketing only. Confirmations, reminders and operational
--      alerts are transactional and are deliberately NOT governed by it: a
--      client whose appointment is at 08:00 still gets their reminder.
--      The window lives in @sheer/domain (CAMPAIGN_MARKETING_WINDOW) because
--      the evaluator, the "would this run today?" preview and the owner-facing
--      copy must all agree on one definition; this migration adds only the
--      durable state the rule needs.
--
--   2. CONTINUATION ACROSS TICKS.
--      A run stops at the per-run recipient bound. Until now the remainder
--      waited for TOMORROW, because a run is claimed once per
--      (campaign, salon-local date) and `shouldEvaluateToday` refused a second
--      pass. For an audience past the bound that silently stretched one send
--      over days. Now a run that stopped on the bound is marked
--      `audience_exhausted = false` and the next tick INSIDE THE WINDOW picks
--      it up again, from a durable position: the recipient claim rows
--      (comms.campaign_recipients, unique on the send identity) already
--      guarantee nobody is offered twice, so continuation needs no cursor of
--      its own and cannot resend.
--
--      When the window closes the run simply stops being eligible and resumes
--      at the next window opening — it does not wait a whole day, and it does
--      not keep sending after 19:00.
--
-- WHAT THIS DELIBERATELY DOES NOT DO
--   - No change to the recipient dedupe model. Send identity is still the
--     campaign's own dedupe key; this migration adds no second source of truth.
--   - No new scheduler. Continuation is the SAME tick loop, re-entering.

-- =============================================================================
-- 1. A run knows whether it finished its audience
-- =============================================================================

alter table comms.campaign_runs
  add column if not exists audience_exhausted boolean not null default true;

comment on column comms.campaign_runs.audience_exhausted is
  'False when the run stopped on the per-run recipient bound with candidates still unprocessed (0111). The next evaluator tick inside the salon-local marketing window re-claims this row and continues; true means the day''s audience was worked to the end.';

-- Continuation claim: exactly one worker may re-open an unfinished run. The
-- status flip IS the latch — a second worker''s UPDATE matches no row.
create index if not exists idx_comms_campaign_runs_unfinished
  on comms.campaign_runs (campaign_id, run_local_date)
  where audience_exhausted = false;

-- =============================================================================
-- 2. "Run now" outside the window is a deferral, not a refusal
-- =============================================================================
--
-- The owner presses Run now at 21:30. The audience is evaluated immediately so
-- they see who it would reach, but nothing is sent: the request is recorded
-- against the salon-local date whose window will next open, and the first tick
-- inside that window runs the campaign regardless of its configured send hour.
-- One date, so a second press is idempotent, and the flag is cleared by the run
-- it triggers.

alter table comms.campaigns
  add column if not exists run_now_requested_local_date date;

comment on column comms.campaigns.run_now_requested_local_date is
  'Set when an owner asked for an immediate run outside the salon-local marketing window (0111): the salon-local date whose window should pick it up. Cleared by the run it triggers. NULL means no pending manual request.';

