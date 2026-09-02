# Week 7 hosted deployment preflight

**QLOOQO V1.1 — Wrike 4507284256 and the Week 7 migration set (0097–0109).**

Run these checks **before** applying any Week 7 migration to a hosted database.
Nothing here can be verified from the repository: there is no CI, no migration
ledger under version control, and no migration step in the Railway start command
(`node apps/api/dist/main.js`). Migrations are applied by hand, so these are the
only controls.

> **Do not apply migrations while working through this document.** Sections 1–3
> are inspection only. Section 5 is the apply order, and it runs after an
> operator has read sections 1–3 and decided.

---

## 1. The migration ledger — CHECK THIS FIRST

Three migrations were **renamed** from timestamped filenames to sequential ones
in commit `f5ce3c0` ("chore(migrations): normalize timestamped migrations to
sequential 0057-0059"):

| Old identity | Current filename |
|---|---|
| `20260710205151_security_level_read_permissions.sql` | `0057_security_level_read_permissions.sql` |
| `20260711000000_audit_activity_log.sql` | `0058_audit_activity_log.sql` |
| `20260712000000_messaging_notification_foundation.sql` | `0059_messaging_notification_foundation.sql` |

If the hosted ledger still records the **old** identities, `supabase db push`
treats all three as pending, sorts them ahead of everything numbered, and tries
to re-run them.

**They are not re-runnable.** Verified in the current tree:

```
supabase/migrations/0058_audit_activity_log.sql:49   create policy activity_log_owner_select
supabase/migrations/0058_audit_activity_log.sql:57   create policy activity_log_manager_select
supabase/migrations/0059_messaging_notification_foundation.sql:57   create trigger messaging_usage_counters_set_updated_at
supabase/migrations/0059_messaging_notification_foundation.sql:65   create policy comms_messaging_usage_counters_owner_all
supabase/migrations/0059_messaging_notification_foundation.sql:72   create policy comms_messaging_usage_counters_manager_select
```

None carry `if not exists` or a preceding `drop ... if exists`.

**0058 fails first**, not 0059 — it is the lower number, so it is attempted
first and aborts the whole push on
`policy "activity_log_owner_select" for table "activity_log" already exists`.
Nothing from 0097 onward is applied, and the failure looks like it belongs to
Week 7 rather than to a rename made weeks earlier. *(Reproduced on real
PostgreSQL. An earlier version of this document named only 0059 and would have
sent an operator looking at the wrong file.)*

### Inspect the ledger

```sql
select version, name
from supabase_migrations.schema_migrations
where version in ('20260710205151', '20260711000000', '20260712000000',
                  '0057', '0058', '0059')
   or name ilike '%security_level_read_permissions%'
   or name ilike '%audit_activity_log%'
   or name ilike '%messaging_notification_foundation%'
order by version;
```

**CASE A — ledger shows `0057` / `0058` / `0059`.** Expected. Proceed to §2.

**CASE B — ledger shows the timestamps.** **STOP.** Reconcile the ledger
metadata so those three read as already applied under their current names. Do
**not** re-run them, and do **not** edit the historical migrations to be
idempotent: the schema they create is already present, and only the bookkeeping
is stale. This is a metadata change and needs explicit operator approval.

**CASE C — anything else** (a partial set, unexpected rows, no
`supabase_migrations` schema). **STOP and inspect.** Do not push.

---

## 2. The superseded counter table must be empty

`0107` drops `comms.messaging_usage_counters`. The justification is that `0059`
created it empty and nothing ever wrote it — verified in the repository (no
reader, no writer, no seed, no backfill; `git log -S` finds no writer that was
later removed). What the repository cannot tell you is what is in the hosted
table:

```sql
select count(*) from comms.messaging_usage_counters;
```

- **0** — expected. Proceed.
- **Non-zero** — **STOP.** Something outside this repository wrote to it. Export
  before doing anything else:

  ```sql
  \copy (select * from comms.messaging_usage_counters) to 'messaging_usage_counters_backup.csv' csv header
  ```

  The rows cannot be mechanically migrated. The grains are contradictory — the
  old table is keyed per **location** (`business_id, location_id, period_month`)
  while the V1.1 allowance is an **account** entitlement pooled across locations
  — and its tier names belong to the deleted `0051` model (Solo/Studio/Salon/
  Group) that `0064` replaced with spark/pulse/infinity. Carrying them across is
  a judgement about historical billing, not a transform.

---

## 3. Migration 0108 must be applied BEFORE the API is deployed

**This ordering is load-bearing, not a preference.**

The dispatcher's queue reader selects `root_event_id`
(`NOTIFICATION_EVENT_COLUMNS` in
`apps/api/src/communications/notification-subject.ts`), and that column is
created only by `0108`. Deploy the API against a database without `0108` and
every read of the notification queue fails — **all outbound messaging stops**,
silently, because the dispatcher swallows its own tick errors by design.

The same applies to `comms.find_unaccounted_sends` and
`comms.reminder_occurrence_key`, which the recovery worker calls on a timer.

> **DATABASE MIGRATION 0108 BEFORE API DEPLOY.** There is no version of the API
> in this release that works without it.

---

## 4. Post-apply verification

Immediately after applying, with no application traffic:

```sql
-- 0107: the superseded table is gone.
select to_regclass('comms.messaging_usage_counters') is null as dropped;

-- 0108: the chain-identity column and the recovery helpers exist.
select to_regclass('comms.notification_events') is not null as events_table,
       exists (select 1 from information_schema.columns
                where table_schema='comms' and table_name='notification_events'
                  and column_name='root_event_id') as has_root_event_id;
select count(*) from comms.find_unaccounted_sends(10, 300);

-- 0109: client consent is no longer browser-writable.
select has_table_privilege('authenticated','comms.channel_opt_outs','SELECT') as can_read,
       has_table_privilege('authenticated','comms.channel_opt_outs','DELETE') as can_delete;
-- expect can_read = true, can_delete = FALSE
```

A non-zero `find_unaccounted_sends` count is **not** an error — it is the number
of provider-accepted messages whose accounting write was lost, which
`MessageUsageRecoveryService` repairs within one interval (15 minutes by
default). Record the number before and after the first tick: it is the only
direct measure of how often the send path was dropping units.

---

## 5. Apply order

Only after §1 is CASE A, §2 returns 0, and §3 is understood:

```
existing hosted baseline
  → 0097   client lapse intelligence
  → 0098   messaging fallback + opt-outs
  → 0099   in-app notifications
  → 0100   ordering two-step
  → 0101   dead-stock category threshold
  → 0102   arrival push delivery
  → 0103   upsell suggestions
  → 0104   campaign configuration
  → 0105   formula change detection
  → 0106   operational signal settings
  → 0107   message usage accounting
  → 0108   message usage hardening        ← MUST precede the API deploy
  → 0109   opt-out evidence hardening
  → API deploy (Railway)
  → Web deploy (Vercel)
  → Mobile build (EAS) + physical-device UAT
```

`0102` matters for a second reason: both push flags default to **enabled**, and
nothing in `apps/api/.env` overrides them, so an API running without `0102`
error-logs from the push poller every 15 seconds indefinitely.

---

## 6. Environment

The accounting-recovery worker is **on by default** and needs no configuration.
It contacts no provider and cannot send a message, so leaving it enabled has no
client-visible effect; disabling it only means gaps go unrepaired.

```
MESSAGE_USAGE_RECOVERY_ENABLED=true          # default
MESSAGE_USAGE_RECOVERY_INTERVAL_MS=900000    # default (clamped 60000–3600000)
MESSAGE_USAGE_RECOVERY_BATCH_SIZE=200        # default (clamped 1–1000)
MESSAGE_USAGE_RECOVERY_MAX_DRAIN_BATCHES=5   # default (clamped 1–100)
MESSAGE_USAGE_RECOVERY_GRACE_SECONDS=300     # default (clamped 0–86400)
```

Set `MESSAGE_USAGE_RECOVERY_ENABLED=false` in test and CI environments, matching
the convention already used for `COMMS_DISPATCH_ENABLED`.

**Also confirm `TWILIO_STATUS_CALLBACK_URL` is publicly reachable.** When it is
not, Twilio delivery-status callbacks never arrive, and with them the entire
asynchronous failure→fallback path and the inbound opt-out record. The dispatcher
keeps working; failures simply stop being learned about.

---

## 7. V1.1 entitlement semantics (release-note wording)

> **The monthly usage period is priced by the plan it opened with.** When the
> first message of a calendar month is sent, the period records the account's
> tier, active location count and resulting allowance. Those values govern that
> period for the rest of the month — the remaining count, the overage figure, the
> near-limit warning, the cap decision, the owner's usage panel and
> reconciliation all read them.
>
> A tier change, or a location added or removed mid-month, therefore applies to
> the **next** monthly period. There is no proration, and a period's snapshot is
> never rewritten.

Before this, the allowance was resolved live on every read while the stored
overage counter derived from the snapshot, so one month could be priced two ways
at once — an owner could be shown "400 of 600, you're fine" while the stored
billing evidence for that month recorded 300 messages of overage.

---

## 8. What this document does NOT cover

- **Physical-device push UAT.** `expo-notifications` and `expo-device` are now
  dependencies of `apps/sheer-app`, but no token has ever been minted on real
  hardware. Push is CODE COMPLETE, NOT DEVICE VERIFIED.
- **Whether the deployed branch contains this work.** Railway and Vercel select
  a branch in their own dashboards, not in this repository. Confirm the deploy
  branch actually contains the Week 7 commits before deploying.
