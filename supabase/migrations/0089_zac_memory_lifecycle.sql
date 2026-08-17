-- 0089_zac_memory_lifecycle.sql
-- ZAC Phase 1 — memory lifecycle for conversation + context memory persistence.
--
-- 0077 created zac.memory_items as an append-only redacted-summary table. The
-- conversation/memory build needs three things it cannot express:
--
-- 1. An active/superseded lifecycle. "My rebooking goal is 55%" followed by
--    "make it 60%" must leave ONE active goal, with the old row auditable but
--    never returned as current. Enforced in the API by superseding on capture;
--    `status` + `superseded_by_id` record it.
-- 2. A dedup key. Two goals about different subjects (rebooking vs colour
--    waste) must coexist, so supersession matches on `kind` + `topic`, not
--    kind alone. `topic` is a server-derived slug (e.g. 'rebooking',
--    'communication_style') — never free text from the user.
-- 3. A retrieval index for the hot path: active memories for a business.
--
-- Additive only; existing rows (there are none outside dev experiments) default
-- to active/general. RLS, grants and the 0080 corrections are untouched — the
-- API service role remains the only writer, and the actor-only SELECT policy
-- from 0077 still governs direct reads. Broader-scope surfacing (business_owner,
-- manager_team_theme) happens exclusively in the API, which re-checks the
-- acting user's current role and location scope on every request.

alter table zac.memory_items
  add column if not exists status text not null default 'active';

alter table zac.memory_items
  drop constraint if exists zac_memory_items_status_check;

alter table zac.memory_items
  add constraint zac_memory_items_status_check
  check (status in ('active', 'superseded', 'archived'));

comment on column zac.memory_items.status is
  'Lifecycle: active (returned by retrieval) | superseded (replaced by a newer memory) | archived (retired without replacement). Only active rows are ever surfaced.';

alter table zac.memory_items
  add column if not exists superseded_by_id uuid references zac.memory_items(id) on delete set null;

comment on column zac.memory_items.superseded_by_id is
  'The memory that replaced this one (set when status becomes superseded). Keeps goal changes auditable without two active contradictory rows.';

-- FK helper: without it, deleting a memory row scans the table to find
-- referencing superseded rows (ON DELETE SET NULL).
create index if not exists idx_zac_memory_items_superseded_by
  on zac.memory_items (superseded_by_id)
  where superseded_by_id is not null;

alter table zac.memory_items
  add column if not exists topic text not null default 'general';

comment on column zac.memory_items.topic is
  'Server-derived subject slug (rebooking, revenue, colour_waste, communication_style, ...). Supersession and relevance retrieval match on (kind, topic); never user free text.';

-- Hot path (ZacMemoryStore.listActiveForBusiness): active memories for a
-- business, newest first; visibility/kind/topic narrowing happens in the API
-- over this bounded set. Partial: superseded/archived rows are audit trail only.
create index if not exists idx_zac_memory_items_business_active_updated
  on zac.memory_items (business_id, updated_at desc)
  where status = 'active';
