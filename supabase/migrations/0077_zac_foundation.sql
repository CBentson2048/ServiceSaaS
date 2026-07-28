-- 0077_zac_foundation.sql
-- ZAC Phase 1 Week 1 — dedicated `zac` schema and foundation tables.
--
-- NOTE: authored for review in Week 1; apply via the normal Supabase CLI flow.
-- Numbered 0077: 0071–0075 are taken by the payroll / financial-rules
-- migrations already merged to develop.
--
-- The `zac` schema is deliberately NOT exposed through PostgREST yet (not in
-- supabase/config.toml `schemas`, and it must not be added to any hosted
-- project's Exposed Schemas for now): Phase 1 has no frontend or supabase-js
-- access to these tables — the Week 1 API writes nothing and reads nothing
-- here. When Week 2+ adds persistence, either expose the schema then (config
-- + hosted Exposed Schemas, since supabase-js routes through PostgREST even
-- with the service role) or reach it over a direct Postgres connection.
-- Backend-only first.
--
-- Design decisions (see docs/ZAC/phase-1-final-backend-foundation-implementation-plan.md):
-- * ZAC storage is fully separated from operational V1.1 schemas and from
--   audit.activity_log; no core table changes are needed.
-- * RLS is ENABLED **and FORCED** on every table — deliberately stronger than
--   the platform's dormant RLS. All writes flow through the API service role
--   (which bypasses RLS); authenticated users get narrow SELECT policies only.
-- * No raw prompt/answer storage by default: content columns are `*_redacted`
--   and hold redacted/summary text only. Telemetry tables (tool_calls,
--   cost_events) carry safe operational metadata, never free text from users.
-- * Every row is tenant-scoped by business_id and snapshots role_context /
--   visibility_scope at creation time.

create schema if not exists zac;

comment on schema zac is
  'ZAC assistant: conversations, tool telemetry, memory, outputs, feedback, outcomes and cost events. Isolated from operational V1.1 schemas; RLS forced; all writes via the API service role.';

grant usage on schema zac to authenticated, service_role;

alter default privileges in schema zac
  grant select, insert, update, delete on tables to authenticated, service_role;

alter default privileges in schema zac
  grant usage on sequences to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Conversations
-- ---------------------------------------------------------------------------

create table if not exists zac.conversations (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  actor_user_id uuid references core.user_profiles(id) on delete set null,
  -- Snapshot of the actor's primary role when the conversation started.
  role_context text not null,
  visibility_scope text not null default 'user_private',
  title text,
  status text not null default 'active',
  started_at timestamptz not null default now(),
  ttl_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table zac.conversations is
  'One ZAC conversation per actor. Scoping snapshot (role_context, visibility_scope) is taken at creation.';

create index if not exists idx_zac_conversations_business_actor_created
  on zac.conversations (business_id, actor_user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Messages (redacted content only — never verbatim prompts/answers)
-- ---------------------------------------------------------------------------

create table if not exists zac.messages (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  conversation_id uuid not null references zac.conversations(id) on delete cascade,
  actor_user_id uuid references core.user_profiles(id) on delete set null,
  role text not null check (role in ('user', 'assistant', 'system', 'tool')),
  -- Redacted/summary content only. Verbatim capture would require an explicit
  -- per-business opt-in and a separate short-retention table (not in Phase 1).
  content_redacted text,
  response_type text,
  token_count integer,
  model text,
  created_at timestamptz not null default now()
);

comment on table zac.messages is
  'ZAC message events. content_redacted holds redacted/summary text only — raw prompt/answer bodies are never stored by default (D32).';

create index if not exists idx_zac_messages_conversation_created
  on zac.messages (conversation_id, created_at);

create index if not exists idx_zac_messages_business_created
  on zac.messages (business_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Tool calls (metadata only)
-- ---------------------------------------------------------------------------

create table if not exists zac.tool_calls (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  conversation_id uuid references zac.conversations(id) on delete set null,
  message_id uuid references zac.messages(id) on delete set null,
  actor_user_id uuid references core.user_profiles(id) on delete set null,
  role_context text not null,
  tool_name text not null,
  -- Parameter summary (e.g. { "period": "week", "location_scoped": true }) —
  -- never full argument dumps and never free-text user content.
  args_meta jsonb not null default '{}'::jsonb,
  result_status text not null,
  result_row_count integer,
  latency_ms integer,
  error_code text,
  created_at timestamptz not null default now()
);

comment on table zac.tool_calls is
  'Per-dispatch tool telemetry: names, statuses, latency and row counts only — no arguments, results or user content.';

create index if not exists idx_zac_tool_calls_business_created
  on zac.tool_calls (business_id, created_at desc);

create index if not exists idx_zac_tool_calls_conversation
  on zac.tool_calls (conversation_id);

-- ---------------------------------------------------------------------------
-- Memory items (redacted summaries, scoped)
-- ---------------------------------------------------------------------------

create table if not exists zac.memory_items (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  actor_user_id uuid references core.user_profiles(id) on delete set null,
  role_context text not null,
  -- Memory scope vocabulary (TA §10): user_private | business_owner |
  -- manager_team_theme | stylist_private | system_safe_summary.
  visibility_scope text not null,
  kind text not null,
  content_redacted text not null,
  source text not null default 'zac',
  source_conversation_id uuid references zac.conversations(id) on delete set null,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table zac.memory_items is
  'ZAC memory: redacted summaries only, scoped by visibility_scope. Broader-scope surfacing rules live in the API, not policies.';

create index if not exists idx_zac_memory_items_business_actor_scope
  on zac.memory_items (business_id, actor_user_id, visibility_scope);

-- ---------------------------------------------------------------------------
-- Outputs (insights/recommendations seed)
-- ---------------------------------------------------------------------------

create table if not exists zac.outputs (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  actor_user_id uuid references core.user_profiles(id) on delete set null,
  role_context text not null,
  visibility_scope text not null default 'business_owner',
  -- One of the seven ZAC response types (Insight, Coaching Point, Opportunity,
  -- Risk, Watch Point, Explanation, Refusal / Insufficient Data).
  response_type text not null,
  title text,
  body_redacted text,
  -- Evidence references (source ids, as-of timestamps, safe entity handles like
  -- client_code) — never raw PII.
  evidence jsonb not null default '[]'::jsonb,
  confidence text,
  status text not null default 'created',
  metric_to_measure text,
  measurement_window_days integer,
  source_conversation_id uuid references zac.conversations(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table zac.outputs is
  'Durable ZAC outputs (insights/recommendations seed) with evidence references and a measurement hook for later attribution.';

create index if not exists idx_zac_outputs_business_status_created
  on zac.outputs (business_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Feedback
-- ---------------------------------------------------------------------------

create table if not exists zac.feedback (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  actor_user_id uuid references core.user_profiles(id) on delete set null,
  role_context text not null,
  message_id uuid references zac.messages(id) on delete set null,
  output_id uuid references zac.outputs(id) on delete set null,
  rating text not null check (rating in ('up', 'down')),
  comment_redacted text,
  created_at timestamptz not null default now()
);

comment on table zac.feedback is
  'Thumbs up/down on ZAC messages/outputs. Free-text comments are stored redacted.';

create index if not exists idx_zac_feedback_business_created
  on zac.feedback (business_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Outcome events (measurement spine / attribution)
-- ---------------------------------------------------------------------------

create table if not exists zac.outcome_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  actor_user_id uuid references core.user_profiles(id) on delete set null,
  role_context text,
  -- Nullable by design: observed outcomes can exist before any recommendation.
  output_id uuid references zac.outputs(id) on delete set null,
  outcome_type text not null,
  target_entity_type text,
  target_entity_id text,
  observed_value numeric,
  estimated_financial_value_cents bigint,
  confidence text,
  attribution_type text check (
    attribution_type in ('observed', 'influenced', 'directly_attributable')
  ),
  evidence jsonb not null default '[]'::jsonb,
  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

comment on table zac.outcome_events is
  'Observed outcomes for the Value Created spine, attributable (Observed / Influenced / Directly Attributable) to ZAC outputs when linked.';

create index if not exists idx_zac_outcome_events_business_observed
  on zac.outcome_events (business_id, observed_at desc);

-- ---------------------------------------------------------------------------
-- Cost events (safe metadata only — never prompt/response text)
-- ---------------------------------------------------------------------------

create table if not exists zac.cost_events (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid references core.locations(id) on delete set null,
  actor_user_id uuid references core.user_profiles(id) on delete set null,
  role_context text not null,
  conversation_id uuid references zac.conversations(id) on delete set null,
  trace_id uuid,
  provider text not null,
  model text not null,
  task_type text not null,
  input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_tokens integer not null default 0,
  -- USD cost of the model call; GBP business values stay separate with an
  -- explicit FX assumption wherever they are compared.
  estimated_cost_usd numeric(12, 6) not null default 0,
  latency_ms integer,
  tool_calls_used integer not null default 0,
  cache_hit boolean not null default false,
  created_at timestamptz not null default now()
);

comment on table zac.cost_events is
  'One row per ZAC model call: token counts, cost, latency and tool usage — no prompt or response text, ever.';

create index if not exists idx_zac_cost_events_business_created
  on zac.cost_events (business_id, created_at desc);

-- ---------------------------------------------------------------------------
-- updated_at triggers (shared helper from 0001)
-- ---------------------------------------------------------------------------

drop trigger if exists set_zac_conversations_updated_at on zac.conversations;
create trigger set_zac_conversations_updated_at
  before update on zac.conversations
  for each row execute function public.set_updated_at();

drop trigger if exists set_zac_memory_items_updated_at on zac.memory_items;
create trigger set_zac_memory_items_updated_at
  before update on zac.memory_items
  for each row execute function public.set_updated_at();

drop trigger if exists set_zac_outputs_updated_at on zac.outputs;
create trigger set_zac_outputs_updated_at
  before update on zac.outputs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: enabled AND forced on every table. Writes flow exclusively through the
-- API service role; authenticated users get narrow SELECTs (defense-in-depth —
-- the API additionally gates on `zac.access` plus per-tool permissions).
-- ---------------------------------------------------------------------------

alter table zac.conversations enable row level security;
alter table zac.conversations force row level security;
alter table zac.messages enable row level security;
alter table zac.messages force row level security;
alter table zac.tool_calls enable row level security;
alter table zac.tool_calls force row level security;
alter table zac.memory_items enable row level security;
alter table zac.memory_items force row level security;
alter table zac.outputs enable row level security;
alter table zac.outputs force row level security;
alter table zac.feedback enable row level security;
alter table zac.feedback force row level security;
alter table zac.outcome_events enable row level security;
alter table zac.outcome_events force row level security;
alter table zac.cost_events enable row level security;
alter table zac.cost_events force row level security;

-- Actors can read their own conversations/messages/feedback.
drop policy if exists zac_conversations_actor_select on zac.conversations;
create policy zac_conversations_actor_select
  on zac.conversations
  for select
  to authenticated
  using (actor_user_id = public.current_user_id());

drop policy if exists zac_messages_actor_select on zac.messages;
create policy zac_messages_actor_select
  on zac.messages
  for select
  to authenticated
  using (actor_user_id = public.current_user_id());

drop policy if exists zac_feedback_actor_select on zac.feedback;
create policy zac_feedback_actor_select
  on zac.feedback
  for select
  to authenticated
  using (actor_user_id = public.current_user_id());

-- Memory is private to the actor it belongs to; broader scopes surface only
-- through the API (service role) with its own permission checks.
drop policy if exists zac_memory_items_actor_select on zac.memory_items;
create policy zac_memory_items_actor_select
  on zac.memory_items
  for select
  to authenticated
  using (actor_user_id = public.current_user_id());

-- Owners can read business-level ZAC operational data.
drop policy if exists zac_outputs_owner_select on zac.outputs;
create policy zac_outputs_owner_select
  on zac.outputs
  for select
  to authenticated
  using (public.is_business_owner(business_id));

drop policy if exists zac_tool_calls_owner_select on zac.tool_calls;
create policy zac_tool_calls_owner_select
  on zac.tool_calls
  for select
  to authenticated
  using (public.is_business_owner(business_id));

drop policy if exists zac_outcome_events_owner_select on zac.outcome_events;
create policy zac_outcome_events_owner_select
  on zac.outcome_events
  for select
  to authenticated
  using (public.is_business_owner(business_id));

drop policy if exists zac_cost_events_owner_select on zac.cost_events;
create policy zac_cost_events_owner_select
  on zac.cost_events
  for select
  to authenticated
  using (public.is_business_owner(business_id));
