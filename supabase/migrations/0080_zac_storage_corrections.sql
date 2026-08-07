-- 0079_zac_storage_corrections.sql
-- ZAC Phase 1 Week 3 — corrections to the 0077 storage foundation, required
-- before any ZAC persistence code is written against it.
--
-- 0077 created the `zac` schema and its eight tables but was never exercised by
-- a writer. Four defects only surface at write/read time; all four are fixed
-- here, and none of them change the shape of a decision still open for review
-- (message content policy, spine-event table) — this migration is deliberately
-- limited to things that are wrong regardless of those calls.
--
-- 1. trace_id correlation. `trace_id` is the only correlation id a ZAC response
--    returns to the client, yet only zac.cost_events could store it. Nothing
--    could be joined: a message, its tool dispatches and its cost were three
--    unrelated rows. Added to zac.messages and zac.tool_calls, and indexed on
--    all three tables.
--
-- 2. zac.messages read policy. The 0077 policy tested
--    `actor_user_id = public.current_user_id()`. Assistant, system and tool rows
--    have no human actor, so actor_user_id is null and `null = <uuid>` yields
--    null — never true. An owner reading their own conversation would have seen
--    their own questions and none of ZAC's answers. Ownership now derives from
--    the parent conversation, which is where it actually lives.
--
-- 3. Cost precision. numeric(12,6) silently rounds any model call under half a
--    microdollar to 0.000000. Cached and short calls are exactly the
--    high-volume case, so the cost spine would have under-reported without
--    error. Widened to numeric(14,8); the integer range is unchanged.
--
-- 4. Grants. 0077 relied solely on ALTER DEFAULT PRIVILEGES. That is
--    load-bearing but fragile: default privileges never apply retroactively, so
--    any table that already existed when 0077 ran (partial earlier apply,
--    hand-pasted DDL) keeps an empty ACL that re-running 0077 can never repair.
--    The symptom is a misleading PGRST205 "table not found in schema cache".
--    0071 set the belt-and-braces precedent for a new schema; 0077 omitted it.
--    The same statements narrow `authenticated` to SELECT, since the API service
--    role is ZAC's only writer.
--
-- OPERATIONAL PREREQUISITE (not solvable in SQL): the `zac` schema must be added
-- to Exposed Schemas in the Supabase dashboard for every hosted project, exactly
-- as 0071 required for `payroll`. Until then the API — which reaches Postgres
-- only through supabase-js/PostgREST — gets `PGRST106 Invalid schema: zac` on
-- every read and write, and because ZAC telemetry writes are fail-soft the
-- failure is silent. supabase/config.toml covers local dev only.

-- ---------------------------------------------------------------------------
-- 1. trace_id correlation
-- ---------------------------------------------------------------------------

alter table zac.messages
  add column if not exists trace_id uuid;

comment on column zac.messages.trace_id is
  'Correlates this message with the tool dispatches and cost event of the same ZAC turn. Returned to the client as ZacResponse.trace_id.';

alter table zac.tool_calls
  add column if not exists trace_id uuid;

comment on column zac.tool_calls.trace_id is
  'Correlates this dispatch with the message and cost event of the same ZAC turn.';

-- Partial: every lookup supplies a non-null trace id, so indexing the nulls
-- would only cost space. Plain (non-concurrent) creation is deliberate — the
-- Supabase CLI runs each migration in a transaction, where CREATE INDEX
-- CONCURRENTLY is not permitted, and these tables are empty.
create index if not exists idx_zac_messages_trace_id
  on zac.messages (trace_id) where trace_id is not null;

create index if not exists idx_zac_tool_calls_trace_id
  on zac.tool_calls (trace_id) where trace_id is not null;

create index if not exists idx_zac_cost_events_trace_id
  on zac.cost_events (trace_id) where trace_id is not null;

-- ---------------------------------------------------------------------------
-- 2. zac.messages read policy — ownership comes from the parent conversation
-- ---------------------------------------------------------------------------

-- Security definer so the check does not re-enter zac.conversations' own RLS,
-- matching the helper style established in 0007. Discloses nothing beyond
-- whether a conversation belongs to the caller. The business_id argument is
-- defence in depth: tenant scoping must not become purely transitive through
-- the conversation, since nothing constrains a message's business_id to match
-- its parent's.
create or replace function public.can_access_zac_conversation(
  p_conversation_id uuid,
  p_business_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, zac
as $$
  select exists (
    select 1
    from zac.conversations c
    where c.id = p_conversation_id
      and c.business_id = p_business_id
      and c.actor_user_id = public.current_user_id()
  )
$$;

comment on function public.can_access_zac_conversation(uuid, uuid) is
  'True when the calling user owns the given ZAC conversation within the given business. Used by zac.messages RLS so assistant/system/tool rows, which have no actor of their own, remain readable by the conversation owner.';

-- Narrow EXECUTE rather than leaving it on PUBLIC, following the convention
-- 0078 set for security-definer functions. Only `authenticated` evaluates the
-- policy that calls this; `anon` has no business holding it.
revoke all on function public.can_access_zac_conversation(uuid, uuid) from public;
grant execute on function public.can_access_zac_conversation(uuid, uuid)
  to authenticated, service_role;

-- The second disjunct preserves 0077's predicate exactly, so this policy can
-- never be NARROWER than the one it replaces: a caller keeps sight of their own
-- messages even in a conversation they do not own (multi-actor threads, which
-- zac.conversations.visibility_scope already anticipates) or one whose owner is
-- null (system-initiated conversations).
drop policy if exists zac_messages_actor_select on zac.messages;
create policy zac_messages_actor_select
  on zac.messages
  for select
  to authenticated
  using (
    public.can_access_zac_conversation(conversation_id, business_id)
    or actor_user_id = public.current_user_id()
  );

-- ---------------------------------------------------------------------------
-- 3. Cost precision
-- ---------------------------------------------------------------------------

-- numeric(12,6) -> numeric(14,8): same six integer digits, two more decimal
-- places. A pure widening, so no existing value can be truncated.
alter table zac.cost_events
  alter column estimated_cost_usd type numeric(14, 8);

comment on column zac.cost_events.estimated_cost_usd is
  'USD cost of the model call at 8 decimal places, so sub-microdollar cached/short calls are not rounded away. GBP business values stay separate with an explicit FX assumption wherever they are compared.';

-- ---------------------------------------------------------------------------
-- 4. Explicit grants (0071 precedent) — repairs any table that predates 0077's
--    ALTER DEFAULT PRIVILEGES, and narrows `authenticated` to read-only.
--
--    Note these grants expand at execution time rather than standing as a rule,
--    which is why 0077's ALTER DEFAULT PRIVILEGES is left in place for tables
--    added to the schema later.
-- ---------------------------------------------------------------------------

grant usage on schema zac to authenticated, service_role;

-- The API service role is the only writer ZAC has, or is planned to have.
grant select, insert, update, delete on all tables in schema zac
  to service_role;

grant usage, select on all sequences in schema zac
  to service_role;

-- Readers get SELECT only. 0077's default privileges also handed `authenticated`
-- INSERT/UPDATE/DELETE; those are inert today (forced RLS with no write policy)
-- but would become live the moment anyone adds a write policy for any reason.
-- Revoked here, and removed from the schema's defaults so tables added later do
-- not silently reacquire them.
grant select on all tables in schema zac to authenticated;

revoke insert, update, delete on all tables in schema zac from authenticated;

alter default privileges in schema zac
  revoke insert, update, delete on tables from authenticated;
