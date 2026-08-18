-- 0090_zac_measurement_spine.sql
-- ZAC Phase 1 — the measurement spine becomes persistent.
--
-- 0077 authored zac.outputs / tool_calls / feedback / outcome_events /
-- cost_events but nothing wrote to them; the API now persists a turn's
-- output, its tool dispatches and its model costs, plus user feedback and
-- explicit outcome events. This migration closes the gaps the writers need.
-- Everything is additive; no previously deployed rows change shape.
--
-- 1. Correlation. trace_id is the one id a ZAC response returns to the client
--    and the id messages/tool_calls/cost_events already carry (0079/0080).
--    zac.outputs could not join that spine — added and indexed. cost_events
--    additionally gains a direct output_id so "cost per insight" is a plain
--    join rather than a trace reconstruction.
-- 2. Honest cost accounting. estimated_cost_usd was NOT NULL DEFAULT 0, which
--    forces unpriced deployments (ZAC_PRICE_* unset) to record real model
--    calls as $0 — indistinguishable from free. Relaxed to nullable: NULL
--    means "usage recorded, monetary estimate unavailable", and the API emits
--    a configuration warning when it writes one.
-- 3. Output metadata. request_mode records HOW the answer was produced
--    (qlooqo_data / general_advice / hypothetical ...), limitations preserves
--    the honesty statements shown with the answer.
-- 4. Outcome summaries. outcome_events had structured fields but nowhere for
--    a safe human-readable summary of what actually happened.
-- 5. Feedback idempotency. One active vote per (output, actor): changing
--    useful -> not useful updates the row instead of stacking votes.
-- 6. Output privacy. 0077's only outputs read policy was owner-wide
--    (is_business_owner). A stylist's personal coaching answer persisted as an
--    output would have been owner-readable via PostgREST despite the Phase 1
--    privacy model. Replaced: actors read their own outputs; owners read
--    business-scope outputs only — user_private rows are excluded.

-- ---------------------------------------------------------------------------
-- 1. Correlation
-- ---------------------------------------------------------------------------

alter table zac.outputs
  add column if not exists trace_id uuid;

comment on column zac.outputs.trace_id is
  'Correlates this output with the messages, tool dispatches and cost events of the same ZAC turn (ZacResponse.trace_id).';

create index if not exists idx_zac_outputs_trace_id
  on zac.outputs (trace_id) where trace_id is not null;

create index if not exists idx_zac_outputs_conversation
  on zac.outputs (source_conversation_id) where source_conversation_id is not null;

alter table zac.cost_events
  add column if not exists output_id uuid references zac.outputs(id) on delete set null;

comment on column zac.cost_events.output_id is
  'The persisted output this model spend produced, when one exists — the "cost per insight" join.';

create index if not exists idx_zac_cost_events_output
  on zac.cost_events (output_id) where output_id is not null;

create index if not exists idx_zac_outcome_events_output
  on zac.outcome_events (output_id) where output_id is not null;

-- ---------------------------------------------------------------------------
-- 2. Honest cost accounting
-- ---------------------------------------------------------------------------

alter table zac.cost_events
  alter column estimated_cost_usd drop not null,
  alter column estimated_cost_usd drop default;

comment on column zac.cost_events.estimated_cost_usd is
  'USD estimate at 8 decimal places. NULL = real usage recorded but ZAC_PRICE_* was not configured — never silently $0 (D33).';

-- ---------------------------------------------------------------------------
-- 3. Output metadata
-- ---------------------------------------------------------------------------

alter table zac.outputs
  add column if not exists request_mode text;

comment on column zac.outputs.request_mode is
  'The closed request mode that produced this output (qlooqo_data, general_advice, hypothetical, ...).';

alter table zac.outputs
  add column if not exists limitations jsonb not null default '[]'::jsonb;

comment on column zac.outputs.limitations is
  'The honesty statements shown alongside the answer (safe text array — part of what the user actually saw).';

-- ---------------------------------------------------------------------------
-- 4. Outcome summaries
-- ---------------------------------------------------------------------------

alter table zac.outcome_events
  add column if not exists summary_redacted text;

comment on column zac.outcome_events.summary_redacted is
  'Safe human-readable summary of the observed outcome (redacted before write; never raw operational records).';

-- Outcomes inherit the visibility of the output they attach to, snapshotted at
-- write time — an outcome on a stylist''s user_private coaching answer must not
-- become owner-readable through the outcome row.
alter table zac.outcome_events
  add column if not exists visibility_scope text not null default 'business_owner';

comment on column zac.outcome_events.visibility_scope is
  'Snapshot of the source output''s visibility scope. Read policies filter on it, mirroring zac.outputs.';

-- ---------------------------------------------------------------------------
-- 5. Feedback idempotency — one active vote per (output, actor)
-- ---------------------------------------------------------------------------

-- Defensive: nothing has written feedback before this migration, but if any
-- environment holds hand-inserted duplicates, keep the newest vote rather than
-- aborting the migration on the unique index build.
delete from zac.feedback a
using zac.feedback b
where a.output_id is not null
  and a.output_id = b.output_id
  and a.actor_user_id = b.actor_user_id
  and a.created_at < b.created_at;

create unique index if not exists idx_zac_feedback_output_actor
  on zac.feedback (output_id, actor_user_id)
  where output_id is not null and actor_user_id is not null;

-- ---------------------------------------------------------------------------
-- 6. Output privacy: user_private outputs are the actor's alone
-- ---------------------------------------------------------------------------

drop policy if exists zac_outputs_owner_select on zac.outputs;
create policy zac_outputs_owner_select
  on zac.outputs
  for select
  to authenticated
  using (
    public.is_business_owner(business_id)
    and visibility_scope in ('business_owner', 'manager_team_theme')
  );

drop policy if exists zac_outputs_actor_select on zac.outputs;
create policy zac_outputs_actor_select
  on zac.outputs
  for select
  to authenticated
  using (actor_user_id = public.current_user_id());

-- The same scope-aware pair for outcome events: 0077's owner-wide policy would
-- have exposed outcome summaries recorded against user_private outputs.
drop policy if exists zac_outcome_events_owner_select on zac.outcome_events;
create policy zac_outcome_events_owner_select
  on zac.outcome_events
  for select
  to authenticated
  using (
    public.is_business_owner(business_id)
    and visibility_scope in ('business_owner', 'manager_team_theme')
  );

drop policy if exists zac_outcome_events_actor_select on zac.outcome_events;
create policy zac_outcome_events_actor_select
  on zac.outcome_events
  for select
  to authenticated
  using (actor_user_id = public.current_user_id());
