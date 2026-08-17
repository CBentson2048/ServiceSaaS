# ZAC storage — apply & verification runbook (migrations 0076 / 0077 / 0079 / 0089)

> **Update (2026-08-17):** ZAC's conversation + context-memory build now READS
> AND WRITES these tables at runtime (`zac.conversations`, `zac.messages`,
> `zac.memory_items`) — see
> [`phase-1-conversation-memory.md`](phase-1-conversation-memory.md). Two
> consequences for this runbook:
> 1. Migration **`0089_zac_memory_lifecycle.sql`** (memory `status` /
>    `superseded_by_id` / `topic` + active-lookup index, additive) joins the
>    apply list after 0079/0081.
> 2. Step 2 (Exposed Schemas) is no longer only about silent telemetry:
>    without it, conversations degrade to stateless turns
>    (`conversation_id: null`, `persistence_failed` spine events) and
>    explicit "remember this" requests fail with a visible, honest
>    "I couldn't save that" answer. The failure mode is now user-visible.

Owner: engineering · Applies to: `dev-test`, then `develop` → `staging` → `production`

`0076_zac_access_permission.sql` and `0077_zac_foundation.sql` were applied to **dev-test**
out of band (dashboard SQL editor / MCP rather than `supabase db push`).
`0079_zac_storage_corrections.sql` fixes four defects in 0077 that only surface at
read/write time. This runbook is the safe path to a verified state, and the
verification queries double as the acceptance evidence for the ZAC storage ticket.

**Nothing in ZAC can read or write the database until step 2 is done.** The API
reaches Postgres exclusively through supabase-js → PostgREST, and PostgREST
serves only schemas on its Exposed Schemas list. `zac` is not on it.

---

## 1. Pre-flight — establish what is actually on dev-test

Run as `postgres` in the SQL editor. Read-only.

```sql
-- 1a. Roles: service_role MUST hold BYPASSRLS, or every ZAC write fails.
select rolname, rolsuper, rolbypassrls
from pg_roles
where rolname in ('postgres', 'service_role', 'authenticated', 'anon', 'authenticator')
order by rolname;
-- EXPECT: service_role.rolbypassrls = true

-- 1b. The eight tables exist, with RLS enabled AND forced.
select c.relname,
       pg_get_userbyid(c.relowner) as table_owner,
       c.relrowsecurity          as rls_enabled,
       c.relforcerowsecurity     as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'zac' and c.relkind = 'r'
order by c.relname;
-- EXPECT: exactly 8 rows (conversations, cost_events, feedback, memory_items,
--         messages, outcome_events, outputs, tool_calls), all true / true.

-- 1c. DECISIVE: does service_role actually hold write privileges?
--     A false here is the "partially applied 0077" scenario — a table that
--     already existed when 0077 ran keeps an empty ACL, and re-running 0077
--     can never repair it (create-table-if-not-exists is a no-op and default
--     privileges are never applied retroactively). 0079 repairs it.
select c.relname,
       has_table_privilege('service_role', c.oid, 'INSERT') as sr_insert,
       has_table_privilege('service_role', c.oid, 'SELECT') as sr_select
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'zac' and c.relkind = 'r'
order by c.relname;
-- Any false => 0079 is required before any writer ships (it is anyway).

-- 1d. Policies: SELECT-only, no write policy anywhere.
select tablename, policyname, cmd, roles
from pg_policies
where schemaname = 'zac'
order by tablename;
-- EXPECT: 8 rows, all cmd = 'SELECT', roles = {authenticated}.
-- EXPECT: zero rows with cmd in ('INSERT','UPDATE','DELETE','ALL').

-- 1e. What the CLI thinks is applied (drives step 3).
select version, name
from supabase_migrations.schema_migrations
order by version desc
limit 12;
-- Note the version FORMAT of existing rows; step 3 must match it exactly.
```

---

## 2. REQUIRED — expose the `zac` schema to PostgREST

Without this, every ZAC read/write returns `PGRST106 Invalid schema: zac`. Because
ZAC telemetry writes are fail-soft by design, the API would return HTTP 200 and
persist nothing, indefinitely and without an error.

**Dashboard → Project Settings → API → Data API Settings**

- **Exposed schemas**: add `zac` to the existing list.
- **Extra search path**: add `zac`, for consistency with the other schemas.
- Save. PostgREST reloads within seconds; no downtime.

Repeat per project as each one receives the migrations. Then mirror it locally so
`supabase start` matches — add `"zac"` to both `schemas` and `extra_search_path`
in `supabase/config.toml`.

**Is exposing it safe?** Yes, and it is stricter than the schemas already exposed.
0077 sets RLS `enable` **and** `force` on all eight tables — the only forced RLS in
the repo — with exactly eight `for select to authenticated` policies and **no write
policies at all**. An authenticated user with the publishable key can read only
their own conversations/messages/memory/feedback (and, if owner, their business's
outputs/tool_calls/outcomes/costs), and cannot insert, update or delete anything.
Verified on PostgreSQL 16: all 8 tables reject `authenticated` writes with `42501`.

---

## 3. REQUIRED — reconcile the migration ledger

0076/0077 were applied out of band, so the CLI ledger has no rows for them. The
next `supabase db push` would therefore **replay 0077**.

That is not merely wasteful — it is destructive to the fix. 0077 recreates the
`zac_messages_actor_select` policy with `drop policy if exists … create policy …`,
so a replay silently reinstates the defect 0079 corrects. This was reproduced on a
real PostgreSQL 16 instance: after replaying 0077, the conversation owner again saw
1 of 2 messages.

Backfill the ledger so the CLI treats them as done. Match the version format
observed in step 1e (this repo uses 4-digit prefixes, so the version is `0076` /
`0077`; adjust if 1e shows otherwise):

```sql
insert into supabase_migrations.schema_migrations (version)
values ('0076'), ('0077')
on conflict (version) do nothing;
```

Then confirm the CLI's view matches reality:

```bash
supabase migration list --linked   # 0076/0077 applied; 0078/0079 pending
```

> If 0077 is ever replayed for any reason, **re-apply 0079 immediately afterwards.**

---

## 4. Apply

```bash
supabase db push          # applies 0078 (payroll) and 0079 (zac), in order
```

0078 and 0079 are disjoint — 0078 touches only `payroll.*` plus read-only lookups of
`core.staff_profiles` / `core.locations`, and contains no reference to `zac`. Either
order is safe; `db push` applies them in numeric order regardless.

On a fresh environment with none of these applied, the natural order 0076 → 0077 →
0078 → 0079 produces the correct end state. The later ZAC migrations follow the
same flow: `0081` (zac.access for manager/stylist system levels) and `0089`
(memory lifecycle columns) are both additive and apply cleanly via `db push` in
numeric order.

---

## 5. Post-apply verification

```sql
-- 5a. trace_id correlation now exists on all three telemetry tables.
select table_name, column_name
from information_schema.columns
where table_schema = 'zac' and column_name = 'trace_id'
order by table_name;
-- EXPECT: cost_events, messages, tool_calls

select indexname from pg_indexes
where schemaname = 'zac' and indexname like '%trace_id%'
order by indexname;
-- EXPECT: idx_zac_cost_events_trace_id, idx_zac_messages_trace_id,
--         idx_zac_tool_calls_trace_id

-- 5b. Cost precision widened (sub-microdollar calls no longer round to zero).
select numeric_precision, numeric_scale
from information_schema.columns
where table_schema = 'zac' and table_name = 'cost_events'
  and column_name = 'estimated_cost_usd';
-- EXPECT: 14, 8

-- 5c. The messages policy now derives ownership from the parent conversation.
select policyname, qual
from pg_policies
where schemaname = 'zac' and tablename = 'messages';
-- EXPECT: qual references can_access_zac_conversation(conversation_id),
--         NOT actor_user_id = current_user_id()

-- 5d. Grants repaired, and `authenticated` narrowed to read-only.
select c.relname,
       has_table_privilege('service_role',  c.oid, 'INSERT') as sr_insert,
       has_table_privilege('authenticated', c.oid, 'SELECT') as au_select,
       has_table_privilege('authenticated', c.oid, 'INSERT') as au_insert,
       has_table_privilege('authenticated', c.oid, 'UPDATE') as au_update,
       has_table_privilege('authenticated', c.oid, 'DELETE') as au_delete
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'zac' and c.relkind = 'r'
order by c.relname;
-- EXPECT: sr_insert true, au_select true, au_insert/update/delete all FALSE.

-- 5e. Still read-only by construction.
select count(*) as write_policies
from pg_policies
where schemaname = 'zac' and cmd <> 'SELECT';
-- EXPECT: 0

-- 5f. The ownership helper is not executable by the world.
select p.proname, p.prosecdef as security_definer,
       array_to_string(p.proacl, ' ') as execute_grants
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'can_access_zac_conversation';
-- EXPECT: security_definer true; execute_grants lists authenticated and
--         service_role, and NOT "=X/" (which would mean PUBLIC can execute).
```

**End-to-end check once the API ships a writer** — from the API host, a
`.schema('zac').from('cost_events').select('id').limit(1)` must return `{ data: [],
error: null }`. An `error.code` of `PGRST106` means step 2 was missed; `PGRST205`
("table not found in schema cache") means grants are missing — re-run 0079.

---

## 6. Rollback

0079 is additive apart from the policy replacement, so rollback is partial by
design:

```sql
-- Restore 0077's original (defective) messages policy.
drop policy if exists zac_messages_actor_select on zac.messages;
create policy zac_messages_actor_select
  on zac.messages for select to authenticated
  using (actor_user_id = public.current_user_id());

drop function if exists public.can_access_zac_conversation(uuid, uuid);

drop index if exists zac.idx_zac_messages_trace_id;
drop index if exists zac.idx_zac_tool_calls_trace_id;
drop index if exists zac.idx_zac_cost_events_trace_id;

alter table zac.messages   drop column if exists trace_id;
alter table zac.tool_calls drop column if exists trace_id;

-- Only if something genuinely depended on the old, over-broad grants:
grant insert, update, delete on all tables in schema zac to authenticated;
alter default privileges in schema zac
  grant insert, update, delete on tables to authenticated;
```

**Not reversible without data loss:** narrowing `estimated_cost_usd` back to
`numeric(12,6)` would round stored values. Leave it — the wider type is
backward-compatible with every reader. The `service_role` grants should also not
be rolled back; revoking them breaks the writer, and they are what repairs a
partially-applied 0077 in the first place.

---

## 7. Still open — decisions this migration deliberately does not make

0079 is limited to defects that are wrong regardless of product direction. Three
storage questions remain and should be settled before the persistence tickets:

1. **Message content (D32).** What goes in `zac.messages.content_redacted`? The
   recommendation on the table is structured intent metadata (`{intent, route,
   question_length}`) in a new `meta jsonb` column rather than user text — it is
   derivable today and carries no re-identification risk. Storing real questions
   needs the per-business opt-in that 0077's own comment requires and that does
   not exist yet.
2. **Measurement spine.** `ZacSpineEventName` has five members but no table; each
   event currently has to be folded into a different domain table with mismatched
   fields. A single append-only `zac.spine_events` table would make
   `recordSpineEvent` a mechanical insert and keep the spine queryable as one
   stream. Roughly 15 lines, but it is an architecture call.
3. **Feedback key.** `ZacResponse` returns only `trace_id`, while `zac.feedback`
   keys on `message_id` / `output_id`. Recommendation: add `message_id` to the
   response and key on it — `trace_id` is rendered in the UI, never persisted
   anywhere checkable, and therefore forgeable, so a `trace_id`-keyed endpoint
   could not validate ownership.
