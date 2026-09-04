-- 0112_zac_intelligence_signals.sql
-- ZAC Phase 2 Workstream 1 — persisted intelligence signals.
--
-- ONE new table in the existing `zac` schema. Nothing else in the platform
-- changes; no operational table is touched and no Phase 1 policy is altered.
--
-- WHY A TABLE AT ALL — this reverses a precedent, so it is argued rather than
-- assumed. 0106 states QLOOQO's established intelligence pattern plainly: "NO
-- signal/flag table … computed on read", and 0097 (client lapse) and 0105
-- (formula change) both honour it. That pattern is right for a signal whose
-- whole truth is derivable from current data every time you look. It cannot
-- express the three things this workstream exists to provide:
--
--   1. A LIFECYCLE. "This rebooking gap is the same one you saw last week"
--      is not derivable from a snapshot; it needs a row that persists between
--      evaluations. Compute-on-read has no way to say `resolved`.
--   2. NON-RESOLUTION ON MISSING DATA. The core invariant — a failed or absent
--      observation must never retire a signal — is only meaningful if the
--      signal survives the observation that failed. Under compute-on-read an
--      outage makes a problem vanish, silently, which is the exact failure this
--      framework is built to prevent.
--   3. DEDUPE ACROSS TIME. Compute-on-read dedupes within one read. Refreshing
--      one logical issue instead of stacking a new one every evaluation needs a
--      stable identity that outlives the read.
--
-- Everything that CAN be computed on read still is: no metric value is stored
-- as a source of truth, only as the reading that justified the signal, with a
-- reference back to the canonical QLOOQO implementation that produced it.
--
-- WHAT IS STORED. Safe references only, matching zac.outputs: metric references
-- (which metric, which canonical source, which window) and evidence references
-- (source_type / source_ref / as_of / safe entity handles). No operational
-- payload, no client identifiers, no prompt or answer text. `headline_redacted`
-- passes through the same redactForStorage gate as every other ZAC write.
--
-- VISIBILITY. `visibility_scope` is a write-time snapshot exactly as on
-- zac.outputs, and it NARROWS retrieval — it never authorises it. The API
-- re-evaluates the actor's CURRENT permissions on every read (a permission
-- removed after a signal was written hides the signal), which is why the RLS
-- policies here are defence-in-depth for direct PostgREST access rather than
-- the enforcement layer.
--
-- OPERATIONAL PREREQUISITE (unchanged from 0080, and not solvable in SQL): the
-- `zac` schema must be on the hosted project's PostgREST Exposed Schemas list.
-- supabase/config.toml covers local dev only. Until that is done every read and
-- write here returns PGRST106, and because ZAC persistence is fail-soft the
-- failure is silent.

-- ---------------------------------------------------------------------------
-- The table
-- ---------------------------------------------------------------------------

create table if not exists zac.intelligence_signals (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  -- Set for location- and team-scoped signals; null for a business reading.
  location_id uuid references core.locations(id) on delete set null,
  -- Set for a personal-scope signal: the person the reading is ABOUT, which is
  -- not necessarily the person who caused it to be evaluated.
  subject_user_id uuid references core.user_profiles(id) on delete set null,

  -- Deterministic dedupe identity: business | evaluator | metric | scope |
  -- location | subject | family. Deliberately excludes the period and the
  -- value, so a rolling window refreshes one signal instead of minting a new
  -- one on every evaluation.
  signal_key text not null,
  evaluator_key text not null,
  metric_key text not null,
  -- The Phase 1 business issue, so an adapted signal groups with live evidence
  -- about the same problem instead of taking a second slot for it.
  issue_key text not null,

  scope_type text not null,
  constraint zac_intelligence_signals_scope_type_check
    check (scope_type in ('business', 'location', 'team', 'personal')),
  scope_label text,

  -- Same vocabulary as zac.memory_items / zac.outputs (TA §10).
  visibility_scope text not null,
  constraint zac_intelligence_signals_visibility_scope_check
    check (visibility_scope in (
      'user_private', 'business_owner', 'manager_team_theme',
      'stylist_private', 'system_safe_summary'
    )),

  signal_type text not null,
  constraint zac_intelligence_signals_type_check
    check (signal_type in ('opportunity', 'risk', 'watch_point', 'progress')),

  -- The Phase 1 severity vocabulary, unchanged: a persisted signal converts into
  -- a priority candidate by identity, not by translation.
  severity text not null,
  constraint zac_intelligence_signals_severity_check
    check (severity in ('positive', 'watch', 'attention')),

  -- Three separate axes, never blended into one score.
  materiality numeric(6, 4) not null,
  constraint zac_intelligence_signals_materiality_check
    check (materiality >= 0 and materiality <= 1),
  confidence numeric(6, 4) not null,
  constraint zac_intelligence_signals_confidence_check
    check (confidence >= 0 and confidence <= 1),

  direction text not null default 'unknown',
  constraint zac_intelligence_signals_direction_check
    check (direction in ('improving', 'stable', 'declining', 'unknown')),

  -- The five-way observation semantics, stored so a reader can tell a real zero
  -- from an absent reading without re-running the evaluation.
  observation_status text not null,
  constraint zac_intelligence_signals_observation_status_check
    check (observation_status in (
      'valid', 'zero', 'missing', 'insufficient_sample', 'not_applicable'
    )),

  observed_value numeric(12, 4),
  comparison_value numeric(12, 4),
  target_value numeric(12, 4),
  target_source text,
  constraint zac_intelligence_signals_target_source_check
    check (target_source is null or target_source in (
      'location_setting', 'canonical_threshold', 'user_stated_goal'
    )),
  -- The denominator the reading was computed over, in the metric's sample unit.
  -- Nullable because "we do not know the denominator" is a real state and must
  -- not masquerade as zero.
  sample_size numeric(12, 2),
  period_label text,

  -- Safe references only. metric_refs: [{metricKey, sourceRef, sourceTool,
  -- windowStart, windowEnd}]. evidence_refs: the ZacEvidenceItem contract
  -- (source_type, source_ref, as_of, entities_used) — safe handles, never PII.
  metric_refs jsonb not null default '[]'::jsonb,
  evidence_refs jsonb not null default '[]'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  headline_redacted text not null,

  status text not null default 'active',
  constraint zac_intelligence_signals_status_check
    check (status in ('active', 'resolved', 'suppressed', 'expired')),
  resolution_reason text,
  constraint zac_intelligence_signals_resolution_reason_check
    check (resolution_reason is null or resolution_reason in (
      -- A gap that closed RECOVERED; a run of progress that ended because the
      -- metric fell back was SUPERSEDED. Same reconciler branch, different fact.
      'recovered', 'superseded', 'expired_unconfirmed', 'suppressed_by_actor'
    )),

  -- How many evaluations have confirmed this same logical issue.
  occurrence_count integer not null default 1 check (occurrence_count >= 1),
  first_evaluated_at timestamptz not null default now(),
  last_evaluated_at timestamptz not null default now(),
  -- The last time POSITIVE evidence confirmed the condition still held. Left
  -- untouched by a missing or failed observation, which is what makes expiry
  -- mean "we stopped being able to tell" rather than "it went away".
  last_confirmed_at timestamptz,
  resolved_at timestamptz,
  suppressed_until timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table zac.intelligence_signals is
  'Persisted ZAC intelligence signals with an explicit lifecycle (active/resolved/suppressed/expired). Safe metric and evidence references only — never operational payloads. visibility_scope narrows retrieval; the API re-checks current permissions on every read.';

comment on column zac.intelligence_signals.signal_key is
  'Deterministic dedupe identity (business|evaluator|metric|scope|location|subject|family). Excludes period and value so repeated evaluation refreshes one signal instead of duplicating it.';

comment on column zac.intelligence_signals.observation_status is
  'How the underlying metric read: valid | zero | missing | insufficient_sample | not_applicable. A signal is never RESOLVED from missing/insufficient_sample/not_applicable — resolution requires positive evidence.';

comment on column zac.intelligence_signals.materiality is
  'How far short of target the reading falls, as a fraction of target (0..1). Distinct from severity (which band) and confidence (how good the data is).';

comment on column zac.intelligence_signals.confidence is
  'Data quality only (observation status, sample vs minimum, target provenance, source caveats). Never influenced by how large the gap is.';

comment on column zac.intelligence_signals.last_confirmed_at is
  'Last time positive valid evidence confirmed the triggering condition. Not advanced by a missing or failed observation, so expiry means "unconfirmed", not "recovered".';

comment on column zac.intelligence_signals.metric_refs is
  'Safe pointers to the canonical QLOOQO implementation each number came from — never the payload itself.';

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

-- The dedupe guarantee: at most ONE live signal per logical issue. Partial, so
-- resolved/expired episodes accumulate as history and a recurrence can open a
-- new one. `suppressed` is included because a suppressed signal is still the
-- live row for its issue — a second one must not be openable behind it.
create unique index if not exists idx_zac_intelligence_signals_live_key
  on zac.intelligence_signals (business_id, signal_key)
  where status in ('active', 'suppressed');

-- Hot path: the live signals of one business, most material first.
create index if not exists idx_zac_intelligence_signals_business_live
  on zac.intelligence_signals (business_id, materiality desc, last_evaluated_at desc)
  where status in ('active', 'suppressed');

-- Location-scoped retrieval for a manager whose scope is a subset of the business.
create index if not exists idx_zac_intelligence_signals_location
  on zac.intelligence_signals (business_id, location_id)
  where location_id is not null;

-- A stylist reading their own signals.
create index if not exists idx_zac_intelligence_signals_subject
  on zac.intelligence_signals (business_id, subject_user_id)
  where subject_user_id is not null;

-- ---------------------------------------------------------------------------
-- updated_at trigger (shared helper from 0001)
-- ---------------------------------------------------------------------------

drop trigger if exists set_zac_intelligence_signals_updated_at on zac.intelligence_signals;
create trigger set_zac_intelligence_signals_updated_at
  before update on zac.intelligence_signals
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- RLS: enabled AND forced, matching every other zac table. The API service role
-- bypasses this and is the only writer; authenticated users get narrow SELECTs.
-- ---------------------------------------------------------------------------

alter table zac.intelligence_signals enable row level security;
alter table zac.intelligence_signals force row level security;

-- The 0090 scope-aware pair. An owner reads business-scope signals only:
-- user_private and stylist_private rows are a person's own, and no role widens
-- into them — the same rule 0090 had to retrofit onto zac.outputs after 0077
-- shipped an owner-wide policy.
drop policy if exists zac_intelligence_signals_owner_select on zac.intelligence_signals;
create policy zac_intelligence_signals_owner_select
  on zac.intelligence_signals
  for select
  to authenticated
  using (
    public.is_business_owner(business_id)
    and visibility_scope in ('business_owner', 'manager_team_theme', 'system_safe_summary')
  );

drop policy if exists zac_intelligence_signals_subject_select on zac.intelligence_signals;
create policy zac_intelligence_signals_subject_select
  on zac.intelligence_signals
  for select
  to authenticated
  using (subject_user_id = public.current_user_id());

-- ---------------------------------------------------------------------------
-- Grants. 0077's ALTER DEFAULT PRIVILEGES (as narrowed by 0080) would give this
-- table service_role CRUD and authenticated SELECT already, but 0080 records
-- why defaults are "load-bearing but fragile" — they never apply retroactively
-- and a table created out of band keeps an empty ACL that re-running the
-- migration cannot repair, surfacing as a misleading PGRST205. Stated
-- explicitly, per table, as 0080 established.
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on zac.intelligence_signals to service_role;
grant select on zac.intelligence_signals to authenticated;
revoke insert, update, delete on zac.intelligence_signals from authenticated;
