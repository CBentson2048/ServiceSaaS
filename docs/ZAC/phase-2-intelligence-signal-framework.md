# ZAC — Phase 2 Workstream 1: Intelligence & Signal Framework (implemented)

> **Status: ENGINEERING COMPLETE — hosted verification recorded separately (§23).**
> Workstream 1 of the approved Phase 2 plan is delivered: the canonical metric
> registry, the proactive signal lifecycle, the opportunity/risk/watch-point
> contracts, deterministic materiality/severity rules, deduplication, and the
> Phase 2 evaluation harness. **This is the reusable intelligence/signal
> substrate, not the intelligence itself** — see §0 for what Workstream 1 is
> and, just as importantly, what it is not.

> **Authoritative plan.** The commercial/scope reference for Phase 2 is
> [`ZAC_Phase_2_Incremental_Plan_UPDATED.pdf`](ZAC_Phase_2_Incremental_Plan_UPDATED.pdf)
> (Client Review Edition, August 2026, 280h baseline + 40h central reserve).
> It defines **Workstream 1 — Intelligence & signal framework (24h)** as:
> *"Canonical metric registry; proactive signal lifecycle;
> opportunity/risk/watch-point contracts; materiality/severity rules;
> deduplication; Phase 2 evaluation harness."* An earlier draft of this
> document judged the build against the superseded
> `ZAC_Phase_2_Client_Review_Plan.pdf`, whose "Workstream 1" was *Expanded
> Intelligence* — a different, larger scope that the updated plan numbers as
> Workstream 2. That note was wrong and has been removed.

---

## 0. Workstream 1 — contract and definition of done

**Workstream 1 builds the reusable intelligence/signal substrate.** It exists
so that Workstreams 2, 3 and 5 can register metrics and evaluators and ship
proactive delivery without redesigning how a signal is observed, scored,
deduplicated, persisted, authorised or evaluated.

| Deliverable (plan, 24h) | Where | Status |
|---|---|---|
| Canonical metric registry | `zac-metric-registry.ts` — two admitted metrics, four-criterion bar (§4) | ✅ |
| Proactive signal lifecycle | `zac-signal-reconciler.ts`, migration `0112` — active/resolved/suppressed/expired (§9–§11) | ✅ |
| Opportunity/risk/watch-point contracts | `zac-signal.types.ts` — closed model (+ `progress`) (§6) | ✅ |
| Materiality/severity rules | `zac-signal-scoring.ts` — deterministic, no LLM (§7) | ✅ |
| Deduplication | `buildSignalKey` + partial unique index (§8) | ✅ |
| Phase 2 evaluation harness | `intelligence/eval/` + `pnpm --filter @sheer/api zac-signal-eval` (§15b) | ✅ |

**Workstream 1 does NOT require the full population of** financial, client/
retention, appointment, services/retail or profitability intelligence. Those are
**Workstream 2 — Expanded QLOOQO 10 & cross-domain intelligence (40h)**. Two
proven metrics is a correct Workstream 1 registry: the registry is the
deliverable, not its population.

**Workstream 1 does NOT include** scheduled evaluation, a proactive priority
feed, the weekly/Sunday review or proactive notifications. Those are
**Workstream 5 — Proactive intelligence & weekly business review (38h)**. The
framework is invoked on demand by design, and nothing here is wired into a
scheduler or the live `/zac/ask` turn (§17).

**Workstream 1 does NOT include** QLAB intelligence, stock intelligence, Value
Created, RAG or autonomous actions (Workstreams 3, 4, 7 and the Phase 2 product
boundary respectively).

**Definition of done for Workstream 1**, all asserted by test:

1. The registry admits only metrics with a canonical implementation, an
   exposed denominator, a stateable sample floor and a target with provenance.
2. Every signal carries a closed kind, a severity in the Phase 1 vocabulary, and
   materiality/confidence computed deterministically from domain rules alone.
3. Repeated evaluation of one logical issue refreshes one live row; the
   database refuses a second.
4. A missing, failed, insufficient or zero-denominator observation **never**
   resolves a signal; resolution requires positive evidence.
5. Persisted visibility narrows retrieval and never grants it; current
   permissions and business/location scope are re-checked on every read.
6. The Phase 2 evaluation harness runs the real pipeline over a versioned
   labelled dataset and passes every case and every hard invariant.

---

## 1. The pipeline

```
CANONICAL METRIC DEFINITION      zac-metric-registry.ts        (2 metrics, declarative)
        │                          names the QLOOQO tool; never a formula
        ▼
METRIC OBSERVATION               zac-metric-observation.service.ts
        │                          valid | zero | missing | insufficient_sample | not_applicable
        ▼
SIGNAL EVALUATOR                 evaluators/*.evaluator.ts     (pure, no clock, no model)
        │                          + zac-signal-evaluator.registry.ts
        ▼
SIGNAL CANDIDATE                 zac-signal.types.ts           (+ withheld, with reasons)
        │
        ▼
SIGNAL RECONCILER                zac-signal-reconciler.ts      (pure; open/refresh/resolve/expire/retain)
        │
        ▼
PERSISTED INTELLIGENCE SIGNAL    zac.intelligence_signals      (migration 0112)
        │                          zac-intelligence-signal.store.ts
        ▼
EXISTING PRIORITY ENGINE         zac-signal-priority.adapter.ts
                                   → ZacPriorityService.consolidate()  [Phase 1, unchanged]
```

Everything from the registry to the reconciler is **pure and synchronous** —
no I/O, no clock read, no model call. `evaluatedAt` is a parameter. That is
what makes every acceptance fixture a unit test, including the two that would
normally need an integration environment ("the dashboard went down", "the
permission was revoked").

---

## 2. Architecture discovered

Read before writing anything: the priority engine, the evidence service, the
measurement spine, memory, policy/permissions, the utilisation and rebooking
metrics, the tool catalogue, the `zac` schema and the Phase 0/1 planning corpus.

| Discovery | Consequence for this build |
|---|---|
| **`ZacPriorityService.consolidate(signals)`** already dedupes identical readings, groups by **business issue**, scores the issue once and ranks — the fix for a hosted defect where one rebooking problem filled three slots and printed twice. | No Phase 2 priority engine. The adapter feeds `consolidate()`. |
| `ZacEvidenceSignal.sourceTool` is a **closed union of Phase 1 tool names**; widening it ripples into the model-provider contract. | Every metric definition names its canonical `ZacToolName`. **Zero Phase 1 type changes.** |
| Phase 1's `identityKey` = `issueKey\|metric\|scope\|period\|current\|target` — correct for deduping *within one turn*. | A persisted signal spans turns, so its key excludes period and value (§8). |
| `ZacEvidenceService.normalise()` is the only signal producer, called from exactly one line (`zac-orchestrator.service.ts:286`), which sits **outside every intent conditional**. | Wiring persisted signals in there would change comparison/explanation/health answers too — deliberately not done (§17). |
| Severity `'positive' \| 'watch' \| 'attention'` (ZAC) already collides with `'info' \| 'attention' \| 'high'` (`packages/domain/src/operational-signals.ts`), where `attention` means something different. `IntelligenceSignalType` is also **already taken** there. | Severity is **reused verbatim**; nothing in this build is named `IntelligenceSignalType`. |
| `packages/domain` has **no test runner** (no `test` script, no `*.spec.ts` anywhere). `ZacEvidenceService`/`ZacPriorityService` are pure, `new`-able and live in `apps/api`. | Deterministic evaluation lives in `apps/api/src/zac/intelligence/`. |
| Migration `0106` states QLOOQO's intelligence pattern is **compute-on-read, with deliberately no signal/flag table**. | A persisted table reverses a documented precedent, so `0112`'s header argues the case rather than assuming it (§11). |
| `zac` is **not** in `0002`'s default-privileges list; `0077` granted `authenticated` full CRUD and `0080` revoked write. A new `zac` table is born `authenticated`=SELECT, `service_role`=ALL — but `0080` calls defaults "load-bearing but fragile". | `0112` states its grants explicitly per table. |
| No scheduler exists (`@nestjs/schedule` is not a dependency; the only periodic precedent is an unref'd `setInterval` in campaigns). | Evaluation is on demand, by construction (§18). |

---

## 3. Phase 1 components reused

Reused **as-is**, not reimplemented:

| Component | How |
|---|---|
| `ZacPriorityService.consolidate / rank / selectTop` | The adapter's whole output goes here. Dedupe, issue grouping, candidate scoring, `positive`-filtering and ranking are Phase 1's, untouched. |
| `scoreEvidenceSignal()` (`zac-evidence.service.ts`) | Exported (renamed from the private `scoreSignal`) so a persisted signal and a live reading of the same thing **rank identically**. A private re-implementation would drift on the first change to either. |
| `rebookingGoalFromMemory()` (`zac-evidence.service.ts`) | Extracted from a private method and exported, so a user-stated rebooking target is resolved by exactly one rule. |
| `REBOOKING_THRESHOLD_PERCENT` (`kpi.calc.ts`) | Re-exported as the canonical rebooking target. A literal `50` in the registry would be a second source of truth. |
| `ZacToolRegistryService.dispatch()` | Every metric is read through it, so each read re-checks `zac.access`, role, permissions and `requiresStaffSelf`, and the guarded QLOOQO service re-resolves location scope. **ZAC opens no business-data client.** |
| `ZacEvidenceSignal` / `ZacEvidenceItem` | The adapter's output type and the evidence-reference contract. |
| `redactForStorage()` (`zac-redaction.ts`) | Every persisted headline, at the same 300-char cap a memory summary uses. |
| `ZacCostTelemetryService.recordSpineEvent` | Two new closed event names, `signal_evaluated` and `signal_retrieved`. |
| `ZacMemoryService.canSee` semantics | The visibility matrix is mirrored, **including** the manager-location check that the outputs store omits (§19). |
| Migration house style | `0077`'s table shape, `0089`'s additive/idempotent pattern, `0090`'s scope-aware policy pair, `0080`'s explicit grant block. |
| `createSupabaseFake` | The shared test fake, no new mocking convention. |

---

## 4. The canonical metric registry

`apps/api/src/zac/intelligence/zac-metric-registry.ts` — **two metrics, and
deliberately only two.** A metric is registered only when **all four** hold:

1. A canonical QLOOQO implementation computes it, and ZAC already calls it
   through a guarded Phase 1 tool.
2. The reading exposes its **denominator**, so "nothing happened" and "nothing
   was measured" are distinguishable.
3. A minimum sample can be stated in the metric's own units.
4. A target exists with real provenance.

| Key | Source tool → canonical implementation | Target | Sample floor | Shortfall means | Stale after |
|---|---|---|---|---|---|
| `rebooking_rate` | `report.rebooking_summary` → `DashboardService.kpis` | user-stated goal › `REBOOKING_THRESHOLD_PERCENT` (50) | 20 completed visits | **opportunity** | 21 days |
| `utilisation_rate` | `report.utilisation_summary` → `UtilisationService.summary` (`computeDailyUtilisation`) | `core.location_settings.utilisation_warning_threshold_percent` | 40 rostered hours | **risk** | 14 days |

**What the bar excludes, and why — these are not oversights:**

- **QLAB colour analytics and stock** — their tools are registered but disabled
  skeletons returning `not_connected`, and the Phase 1 feasibility report
  records that no supplier / purchase-order / lead-time / expiry entity exists
  and that `inventory.waste_events` is written but never read.
- **Profitability** — a margin needs cost inputs. `billing.location_fixed_costs`
  now has a full CRUD path (`owner-location-settings.service.ts`), so this is
  closer than the Phase 1 feasibility report recorded; what is still missing is
  a **canonical profitability computation** that ZAC could read rather than
  recreate (criterion 1), which is Workstream 2 work. *(An earlier draft here
  said the table was "applied but empty" — stale; corrected.)*
- **Retention** — only a proxy over rebooking exists; lapsed-client detection
  (`0097`) answers a different question and produces no rate. Workstream 2.
- **Services/retail** — `billing.retail_sales` has a live `RetailSalesModule`
  (`record`, `list`, `listSellable`) and the payroll engine reads it, so a retail
  reading is **proven**. It fails criterion 4 today: no retail target with
  provenance exists. Workstream 2. *(An earlier draft said retail was "applied
  but empty with no UI writer" — stale; corrected.)*
- **Revenue and cancellations** — proven readings, but neither has a target
  with provenance. They fail criterion **4**, not criterion 1: every signal
  would be a watch point forever.

Registering any of them now would produce confident zeros.

**Why rebooking is an opportunity and utilisation is a risk.** The visit
happened and was paid for; only the follow-up was not asked for — recoverable
behaviour. Rostered hours, by contrast, were already bought and are gone.

**Why utilisation's sample unit is rostered hours, not staff-days.** The
canonical payload reports `staffDayCount` only for the aggregate, but
`availableMinutes` at both the aggregate and per-location level. Hours is the
denominator that actually exists everywhere the metric does.

---

## 5. The observation model

`ZacMetricObservation` carries the value **and its denominator**, because every
honesty rule below is decidable only when the denominator survives the trip
from the tool.

| Status | Meaning | Can it raise a signal? | Can it resolve one? |
|---|---|---|---|
| `valid` | A real reading over a sufficient denominator | ✅ | ✅ |
| `zero` | A real reading that happens to be zero — measured, not absent | ✅ | ✅ |
| `missing` | The source did not answer (unavailable, denied, errored, empty payload) | ❌ | ❌ |
| `insufficient_sample` | Measured, but over too small a denominator to mean anything | ❌ | ❌ |
| `not_applicable` | The denominator is zero, so the metric does not exist here | ❌ | ❌ |

Two distinctions carry the design:

- **`zero` vs `not_applicable`.** The dashboard reports
  `completedBookings > 0 ? round(...) : 0`, so an empty week arrives as a flat
  0% — indistinguishable from a real collapse and far more alarming. Phase 1's
  evidence service already fought this in code ("a rate over a zero denominator
  is not a rate"); here it is a first-class status.
- **The utilisation tool answers `unavailable` TWO ways**, and they are not
  interchangeable: no available working time to measure against (a zero
  denominator → `not_applicable`) or the guarded service threw (`missing`). It
  distinguishes them itself by `rowCount` — the no-time branch returns the
  staff-day count, the catch branch returns `null` — and so do we. Collapsing
  them would let a permission or infrastructure failure present itself as an
  empty rota, which is a state the reconciler treats as *covered*.
- **A non-positive target is not a target.**
  `utilisation_warning_threshold_percent` permits `0`, and a 0% threshold would
  make every reading "meet" it — minting a false `progress` signal and, worse,
  resolving the real risk signal it replaced. Read as "none configured".
- **`missing` vs everything else.** This is what makes resolution safe (§10).

Sub-slices of an aggregate payload (`by_location`, `byLocation`) are used only
to enrich limitations, **never** to mint extra observations: those rows carry
no denominator (rebooking) or no target (utilisation).

---

## 6. The signal model

Closed, four values:

| Type | Meaning |
|---|---|
| `opportunity` | An unrealised upside: the work happened, the follow-through did not. Recoverable by doing something differently. |
| `risk` | A condition costing the business now and continuing to: capacity already paid for and lost. |
| `watch_point` | A real gap that is not yet material. Worth knowing, not worth acting on today. |
| `progress` | Movement toward or past a target. Raised only on positive evidence, and only where a comparison or a cleared target supports it. |

Type is **not** severity. It answers *what kind of thing is this*; severity
answers *how far outside the acceptable band*.

---

## 7. Materiality, severity, confidence — three axes, kept apart

`zac-signal-scoring.ts`. All deterministic and domain-driven. **No LLM is
involved in any of it**; a model may narrate the conclusion, never reach it.

### Materiality — "how big is this?"

```
gap         = higher_is_better ? target - value : value - target
materiality = gap <= 0 ? 0 : min(1, gap / target)
```

Relative, not absolute: a 10-point miss against a 20% target is most of the
target gone; the same 10 points against 80% is a rounding error. This mirrors
Phase 1's `shortfallOf`, which replaced a **binary** materiality precisely
because binary let a two-point miss outrank a metric at a third of its
threshold. Zero when there is no target, when the target is not positive, or
when the reading is on the healthy side of it.

### Severity — "how bad is that?"

Reuses the Phase 1 vocabulary **exactly**: `positive | watch | attention`.
Bands live on the metric definition (`watch: 0.05`, `attention: 0.15` for both
registered metrics), so "what counts as bad" is a per-domain product decision
stated once in the registry. `positive` is reserved for readings that are not
short of target — which is what keeps `watch_point` distinguishable from
`progress`.

A fourth severity scale was rejected: three already exist in this repo and
`attention` already means two different things across two of them. Reuse makes
the persisted-signal → priority-candidate conversion an **identity**, not a
translation.

### Confidence — "how sure are you?"

A product of four **data-quality** factors, bounded `[0.2, 0.95]`:

```
base          valid 0.9 · zero 0.85 (a genuine zero rate is more often a capture gap
                                     than a true collapse — the tools say so themselves)
sampleFactor  min(1, max(0.6, sample / (2 × minimumSample))); an UNKNOWN
              denominator scores 0.55 — below the floor a known-but-minimal one
              gets, because "we do not know how much this rests on" must never
              outrank "we know, and it is barely enough"
targetFactor  location_setting 1.0 · canonical_threshold 0.95 · user_stated_goal 0.9
              (a settings screen beats a regex over remembered prose)
coverageFactor 1 − 0.1 × min(3, source caveats)
```

**Confidence never reads materiality, severity or the signal type.** A
catastrophic reading over a thin sample must come out as a big gap we are
unsure about — not a medium-sized certainty, which is what a blended score
silently produces. The fixture `A` asserts this: a worse reading is more
material with **identical** confidence.

---

## 8. Dedupe design

```
signalKey = businessId | evaluatorKey | metricKey | scopeType | locationId | subjectUserId | family
```

- **`businessId` leads**, so cross-tenant collision is impossible by
  construction rather than by a `WHERE` clause.
- **Period, value and severity are deliberately out.** Phase 1's per-turn
  `identityKey` includes all three, correctly — it is deduping two readings
  inside one turn, where a different value really is a different reading. A
  persisted signal spans turns and rolling windows, so including any of them
  would mint a brand-new row on every evaluation and the whole lifecycle would
  be unreachable.
- **`family`** is `shortfall` or `progress`. "Your rebooking gap has closed"
  and "your rebooking improved" are two different messages: the first should
  leave the owner's list, the second may enter it. One shared key would make a
  recovery indistinguishable from a relabelled problem.

Enforced twice: in the reconciler, and by a partial unique index
`(business_id, signal_key) where status in ('active','suppressed')`. Suppressed
rows are included so a suppression cannot become a licence to raise the same
issue again behind it.

A separate **coverage key** (`metricKey | scopeType | locationId |
subjectUserId`) records *what was looked at*, independent of what was found —
the only safe way to tell "the gap closed" from "the tool did not answer".

---

## 9. Reconciliation logic

`ZacSignalReconciler.reconcile(existing, evaluations, evaluatedAt)` → a plan of
actions. Pure; the store applies it.

| Situation | Action |
|---|---|
| Candidate, no live signal for its key | `open` |
| Candidate, live signal exists | `refresh` (occurrence++, reading updated, `last_confirmed_at` advanced, expiry reset) |
| Candidate, signal is under an **open** suppression window | `refresh` with `keepSuppressed` — the reading updates, the person's decision stands |
| Candidate, suppression window has passed | `refresh` back to `active` |
| No candidate, coverage carries **positive evidence about the business** | `resolve` (`recovered`) |
| No candidate, coverage is `missing` / `insufficient_sample` / `not_applicable` / `no_target`, and `expires_at` has passed | `expire` (`expired_unconfirmed`) |
| …and `expires_at` has **not** passed | `retain` (`unconfirmed_observation`) — no write at all |
| No candidate, metric/scope not evaluated at all, `expires_at` passed | `expire` — a metric that stops being evaluated (a permission removed, a location dropped, a metric deregistered) must not leave its signals asserting themselves forever |
| …and `expires_at` has **not** passed | `retain` (`not_evaluated`) |

A resolution records **why** the episode ended: a gap that closed is
`recovered`; a run of `progress` that ended because the metric fell back is
`superseded`. Both leave `active` through the same branch, and calling the
second one "recovered" would put the most reassuring word in the audit trail on
the least reassuring event.

**Positive evidence about the business** means the observation status is
`valid` or `zero` **and** the evaluator either raised a candidate or withheld
for a *business* reason (`below_materiality_floor`, `healthy_steady`).
`no_target` is pointedly **not** one: a threshold being cleared, or a scope
widening past the single location QLOOQO resolves a threshold for, says nothing
about whether the gap closed. Treating it as recovery would let a settings
change silently retire every utilisation signal in a business.

`retain` writes nothing at all — deliberately. The expiry clock is **not**
extended by an unconfirmed reading, so a persistent outage eventually expires
the signal rather than being silently re-confirmed by the act of looking.

---

## 10. The invariant

> **A missing or failed observation NEVER resolves a signal.**
> Resolution requires positive evidence that the triggering condition is gone.

Everything else — the tool errored, the rota was empty, the sample was thin,
the target vanished — leaves the signal exactly where it was. The failure mode
this prevents is the worst one available to a system like this: **an outage
that reads as good news.**

Its mirror stops the framework lying in the other direction: an active signal
that goes unconfirmed long enough **expires** rather than standing forever.
`resolved` and `expired` are deliberately different states, because "it got
better" and "we stopped being able to tell" are different facts.

The same invariant is applied one layer down: a **failed store read aborts the
run** rather than reconciling against an empty `existing` set, which would make
every candidate look new and silently reopen every problem the business
already has.

---

## 11. Lifecycle

`active → resolved` (`recovered` or `superseded`) · `active → expired` (aged
out unconfirmed, whether the reading failed or nothing looked at all) ·
`active ↔ suppressed` (explicit human decision only).

**Suppression is bounded, always.** The window is a required, future instant,
capped at the metric's own `staleAfterDays`. This workstream ships no
unsuppress path — adding one would be a new surface — so an open-ended
suppression would silence a real business problem permanently. Bounding it
means every suppression ends by itself and the next evaluation says whether the
problem is still there. Returning to `active` also clears `suppressed_until`,
so an active signal never reads as one somebody had silenced.

A recurrence after `resolved`/`expired` **opens a new episode**: the partial
unique index covers only live rows, so the closed episode survives as history
and `occurrence_count` measures the current run rather than all time.

Expiry is evaluated **lazily**, at reconcile time, from the metric's
`staleAfterDays`. There is no cron.

---

## 12. Persistence — migration `0112_zac_intelligence_signals.sql`

**One additive table**, `zac.intelligence_signals`. No operational table is
touched and no Phase 1 policy is altered.

**Why a table at all** — this reverses `0106`'s stated precedent
("**NO** signal/flag table … computed on read"), so `0112`'s header argues it.
Compute-on-read is right when a signal's whole truth is re-derivable every time
you look. It cannot express three things this workstream exists to provide:

1. **A lifecycle.** "This is the same gap you saw last week" is not derivable
   from a snapshot; compute-on-read has no way to say `resolved`.
2. **Non-resolution on missing data.** §10 is only meaningful if the signal
   survives the observation that failed. Under compute-on-read an outage makes
   a problem vanish, silently.
3. **Dedupe across time.** Compute-on-read dedupes within one read.

Everything that *can* be computed on read still is: no metric value is stored
as a source of truth, only as the reading that justified the signal.

**What is stored (requirement: safe references, not raw payloads):**

- `metric_refs` — `[{metricKey, sourceRef, sourceTool, windowStart, windowEnd}]`
- `evidence_refs` — the `ZacEvidenceItem` contract (`source_type`,
  `source_ref`, `as_of`, `entities_used`) — safe handles, never PII
- `headline_redacted` — one sentence, through `redactForStorage(…, 300)`
- `limitations` — safe text the source itself reported

No operational payload, no client identifiers, no prompt or answer text.

**Constraints.** Seven closed vocabularies as named `CHECK`s (`signal_type`,
`severity`, `status`, `observation_status`, `scope_type`, `visibility_scope`,
`resolution_reason`),
plus `[0,1]` bounds on `materiality` and `confidence`. This deliberately does
**not** repeat the Phase 1 gap where most `zac` text columns are unconstrained:
only four `CHECK`s exist across `0077`/`0089`/`0090`. No Postgres `enum` — the
platform has used `text` + named `CHECK` since `0096`.

**Indexes.** The partial unique key; a `(business_id, materiality desc,
last_evaluated_at desc)` live-signal hot path; location and subject indexes for
scoped retrieval.

**RLS** enabled **and forced**, with `0090`'s scope-aware policy pair —
owner-reads-business-scope plus subject-reads-own — so a stylist's private
signal is never owner-readable through PostgREST. That rule had to be
retrofitted onto `zac.outputs` by `0090`; it is built in here from the start.

**Grants** stated explicitly per table (`service_role` CRUD, `authenticated`
SELECT, write revoked) rather than relying on schema defaults, per `0080`.

> **Operational prerequisite, unchanged from `0080` and not solvable in SQL:**
> `zac` must be on each hosted project's PostgREST **Exposed Schemas** list.
> `supabase/config.toml` covers local dev only. Until that is done every read
> and write returns `PGRST106`, and ZAC persistence is fail-soft, so the failure
> is silent.

**Apply status: authored, not applied to any hosted project.** Verified locally
against a real Postgres (see §15).

---

## 13. Visibility and permission model

**Which scope a reading may claim.** Only an **owner's** reading may be filed
as the business's. `AuthService.resolveAllowedLocationIds` gives owners every
active location and everyone else the union of their own memberships — so a
manager restricted to one site asking about "the business" is reading one site.
Filing that under the business-scope signal key would silently overwrite the
owner's business-wide signal with one branch's number, and later resolve it on
that branch's recovery. Everyone else's readings are location readings, always.

Beyond that the fan-out avoids saying the same thing twice: a single-location
owner gets ONE business scope whether or not the turn carried a location filter
(both readings are the same fact, and two keys for one fact is exactly the
duplication this framework prevents), and a multi-location owner gets the
business view plus each site.

**Write time** — `visibility_scope` is derived from the scope the signal is
*about*, never from who triggered the evaluation:

| Scope | Visibility | Notes |
|---|---|---|
| `business` | `business_owner` | |
| `location`, `team` | `manager_team_theme` | keyed on `location_id` |
| `personal` | `stylist_private` | keyed on `subject_user_id` |

`team` is expressed as a location because **there is no team entity in this
platform** — no teams table, no `team_id`. A team is the staff at a location,
exactly as Phase 1 already expresses it.

**Retrieval time** — two independent gates, re-evaluated on **every** read:

1. **The visibility matrix** against the actor's *current* role and location
   scope. Deny by default. `stylist_private`/`user_private` admit only the
   subject — no role widens into them. `manager_team_theme` requires the
   manager's current location scope to contain the signal's location, and
   **fails closed** when the location is unresolvable.
2. **The metric's `requiredPermissions`** against the actor's *current*
   effective permission set, plus `zac.access`. A row whose metric is no longer
   registered has no resolvable permission requirement, so it is hidden rather
   than throwing — deny by default, and an unreadable row must not take the
   whole retrieval down with it (which would also make it impossible to
   suppress away).

`zac.access` gates the **write** path too: an actor who can no longer be shown
a signal must not be able to open, refresh or resolve one.

> **Persisted visibility is not authorization.** It narrows retrieval; it never
> grants it. A signal written while someone held `report.dashboard.view`
> disappears the moment that permission is removed — fixture **K**.

**Business isolation** is enforced a layer down: the store filters
`.eq('business_id', …)` on every query, so another tenant's row never reaches
the visibility filter to be judged by it. The API bypasses RLS with the service
role, so this is the real boundary; `0112`'s policies are defence-in-depth for
direct PostgREST access, and the SQL suite proves both.

Suppression uses **existence hiding** (`false`, not a 403), matching
`requireAccessibleOutput`.

---

## 14. Priority-engine integration

`ZacSignalPriorityAdapter.toEvidenceSignals(signals)` → `ZacEvidenceSignal[]` →
`ZacPriorityService.consolidate()`.

**No competing engine.** Phase 1 already solved the hard part; a second engine
ranking the same issues from a second table would recreate the exact defect
Phase 1 fixed, at a larger scale.

| Persisted signal | Phase 1 evidence signal |
|---|---|
| `metricDefinition(metricKey).sourceTool` | `sourceTool` — a **real** `ZacToolName`, so the closed union is untouched |
| `issueKey` (unchanged) | `issueKey` — a persisted rebooking signal and a live rebooking reading land in the **same** candidate |
| `scopeType` | `scope`: `business` / `team` / `self`; a location becomes `location:<id>` and does **not** masquerade as `business` — a two-location salon's worst branch must not look like the whole company. The **id** rides in the string because Phase 1's `identityKey` uses `scope` to decide whether two readings are the same reading: two sites both at 44% for the same window are two facts, and a bare `location` would make the second an "exact duplicate" — silently dropped, and counted as corroboration that raises confidence. `scopeRank` only tests `business`/`team`, so the suffix changes identity without changing ranking, and nothing renders it. |
| `severity` | `severity` — identical vocabulary |
| `target_source` | `location_setting`/`canonical_threshold` → `tool_threshold`; `user_stated_goal` → `user_memory_goal`, so a remembered goal is never presented as a QLOOQO measurement |
| `occurrence_count`, `last_confirmed_at`, `scope_label` | appended to `limitations` — a signal refreshed four times is a standing problem, not a bad week |

`priorityScore` is computed with the **exported Phase 1 scorer**, so persisted
and live readings rank identically.

`progress` signals convert too; Phase 1's `selectTop` already filters
`severity === 'positive'` out of a priority list unless nothing else is
available, so good news never displaces a problem and needs no special case.

---

## 15. Tests and exact pass counts

| Suite | Command | Result |
|---|---|---|
| Framework acceptance fixtures A–L | `npx jest src/zac/intelligence/zac-signal-framework.spec.ts` | **70 passed** |
| **Phase 2 evaluation harness gate** | `npx jest src/zac/intelligence/eval/signal-eval.spec.ts` | **4 passed** (80/80 cases, 7/7 invariants) |
| Service: persistence, scope attribution, visibility, isolation | `npx jest src/zac/intelligence/zac-intelligence-signal.service.spec.ts` | **33 passed** |
| **Full API suite** | `pnpm --filter @sheer/api test` | **2458 passed, 226 todo, 2684 total; 116 suites, 0 failed** |
| Typecheck | `pnpm --filter @sheer/api typecheck` | clean |
| Lint | `pnpm --filter @sheer/api lint` | clean |
| SQL behavioural suite | `supabase/tests/zac_intelligence_signals.sql` | **28 of 28 PASS** |
| All 19 SQL behavioural suites | PGlite, all 112 migrations | see §23 |

The SQL suite was run for real: all **112 migrations** (through `0112`) applied
into a fresh PGlite Postgres, then the suite executed inside one rolled-back
transaction. It proves what the Jest suites structurally cannot — the partial
unique index, the six `CHECK` vocabularies, the bounds, the FK, the
`updated_at` trigger, the four indexes, the grants, and the RLS policies under
PostgREST-shaped sessions (`set local role authenticated` +
`request.jwt.claim.sub`).

### The acceptance fixtures

| # | Fixture | Behaviour |
|---|---|---|
| **A** | Rebooking materially below target, sufficient sample | One `opportunity`, `severity: attention`, materiality `0.32`, `open` action with a 21-day expiry |
| **B** | Same gap, insufficient sample | **No signal.** `withheld: insufficient_sample`, with the note naming the shortfall (`12 completed visits`, `below the 20 needed`). Crosses at exactly 20, not 19. Never resolves an existing signal |
| **C** | `denominator = 0` | `not_applicable`, no signal. A **real** zero over a real denominator still raises one (materiality `1`) and carries slightly lower confidence |
| **D** | Healthy metric | No negative signal. At target with no movement → `withheld: healthy_steady`. A gap inside the 5% floor → `withheld: below_materiality_floor` |
| **E** | Improvement | Clearing the target having improved → `progress`, `positive`, headline "up from 58%". Improving but **still short** → `watch_point`, not progress |
| **F** | Repeated evaluation | Same key across different values/samples/windows → `refresh`, never `open`. One action per logical issue. Suppression respected while its window is open |
| **G** | Valid recovery | `resolve` (`recovered`) — both when the reading clears the target and when the gap merely closes inside the noise floor. **Not** resolved when the target itself disappears |
| **H** | Missing/failed observation | Errored, denied, not-connected, empty payload and not-evaluated all → `retain`, `resolved: 0`, expiry clock not extended. Once aged out → `expire`, still not `resolve` |
| **I** | Two businesses | Separate keys; Business B's identical problem `open`s rather than refreshing A's. Store never reads the other tenant's row |
| **J** | Two locations | Separate keys and separate rows; resolving one leaves the other refreshed. Location scope carried into `manager_team_theme` |
| **K** | Permission removed after creation | Visible with the permission, invisible without it — from `listVisible`, from `priorityCandidates`, and from `suppress`. Also covers `zac.access` revocation, manager location scope, team fail-closed, stylist-private, and stylist-vs-business |
| **L** | Conversion to a priority candidate | Valid `ZacEvidenceSignal` with a real tool name → `cand_rebooking`, domain `rebooking`, title `Rebooking`, materiality `0.32`. Merges with a live reading of the same issue into **one** candidate. Remembered goal raises Phase 1 `relevance` |

---

## 15b. The Phase 2 evaluation harness

```
pnpm --filter @sheer/api zac-signal-eval
```

The last Workstream 1 deliverable, and the one the A–L unit fixtures could not
stand in for. It runs a **versioned labelled dataset** (`zac-signal-eval-v1`,
80 cases / 120 steps) through the **real** pipeline — the real observation
service, evaluator registry, reconciler and `ZacIntelligenceSignalService`
(scope fan-out, visibility matrix, permission re-check, plan application) —
over an in-memory repository that enforces the same live-uniqueness rule as the
database. Only inputs are faked: canned Phase 1 tool results in the exact shape
the tools emit, and the clock.

**It calls no model and imports no provider SDK.** Signal intelligence is
deterministic business logic; `ZAC_AI_PROVIDER` is irrelevant to it, and the
harness spec pins that.

**Label contract** — every expected value is one of the framework's own closed
types (`ZacSignalType`, `ZacSignalSeverity`, `ZacSignalDirection`,
`ZacSignalActionKind`, `ZacSignalResolutionReason`, `ZacWithheldSignal['reason']`),
so a vocabulary change is a compile error in the dataset, not a stale label. The
two band labels are projections of framework numbers onto framework thresholds
(materiality onto the metric's own bands; confidence onto the existing
`confidenceScoreBucket`).

**A case is a sequence** of `evaluate` and `suppress` steps against one store,
because the properties Workstream 1 exists for — refresh-not-duplicate,
never-resolve-on-missing, expire-is-not-resolve — are only observable across
runs.

**Coverage** (`zac-signal-eval-dataset.v1.json`): rebooking (24 cases — material,
slight and severe shortfall, valid 0%, denominator 0, missing denominator,
insufficient sample, sample at/below floor, canonical vs memory-goal vs
non-goal-memory target, above target, at target, inside noise floor, missing/
denied/empty/corrupt observations, caveat and multi-location limitations);
utilisation (19 — including threshold 0, no threshold, no rota vs read failure,
improving/declining/steady/above-but-declining, data-quality notes);
lifecycle (20 — create, refresh on same/changed value, retain on missing/denied/
zero-denominator/insufficient/vanished-target, recovery, recovery inside the
floor, recurrence as a new episode, progress superseded, suppression preserved
and bounded, expiry on persistent failure, expired-then-recurs, expiry when no
longer evaluated, confirmation resetting expiry); scoping (10 — tenants,
locations, manager scope, permission removal for each metric, revoked actor,
partial-scope manager, single-location focus); dedupe (7).

**Scorecard** — every metric is computed from individual checks and every failed
check is printed with expected vs actual; an aggregate never hides a failure.
The three invariant counters that matter most are derived from what the
pipeline **actually did**, not from labels: a resolve on a non-positive
observation, an insert the unique index would reject, a refresh across tenants.

**Result at close-out** (commit recorded in §23): 80/80 cases, 100% on every
asserted category, 0/30 false-positive negative signals, 0/53 false negatives,
0 duplicate active signals, 0 false resolutions on missing data, 0 tenant
isolation failures, 0 permission failures, all seven hard invariants PASS.

**What the harness found while being built** — the reason it exists:
- Seven authored confidence labels were wrong: the canonical rebooking tool
  always reports two caveats, so rebooking confidence peaks at `medium`
  (0.9 × 0.95 × 0.8 = 0.684) and sits at `low` (0.41) at the 20-visit floor.
  The labels assumed no caveats. **Calibration observation, not a defect**:
  confidence never gates raising; it is recorded for the Workstream 2/5
  calibration pass, since static product caveats and genuine data-quality notes
  currently weigh the same.
- The reconciler's `expire` action carried no `resolutionReason` (the persisted
  row did). Fixed: the plan now states `expired_unconfirmed` itself.

**Extensibility** — Workstreams 2, 3 and 5 add cases (and a `domain`) for new
metrics; the runner, scorer, actor presets and invariant gates are unchanged.
The dataset is versioned so later regressions are measurable against this
baseline; `frameworkVersion` is bumped only when a framework change alters what
an existing label means.

---

## 16. What the adversarial review changed

The implementation was reviewed by six independent lenses (the invariant,
dedupe/scoping, permissions, scoring correctness, the migration and its SQL
suite, and scope boundaries/test quality), and every candidate finding was then
handed to a verifier told to **refute** it. Thirty-one findings were checked;
**26 were refuted** and five confirmed. Everything below was fixed and is
covered by a test.

**Found by review, and the most serious of them:**

1. **A partial-scope actor could speak for the whole business.** The scope
   fan-out treated "one accessible location" as "this is the business", so a
   manager restricted to one site would write that site's number under the
   *business* signal key — overwriting the owner's business-wide signal and
   later resolving it on one branch's recovery. Fixed by gating the business
   scope on `roles.includes('owner')`, which mirrors
   `resolveAllowedLocationIds` exactly. (§13)
2. **A signal nothing looked at could never expire.** The `not_evaluated`
   branch retained forever, so a deregistered metric or a dropped location left
   its signals asserting themselves indefinitely — the same lie as resolving
   them, pointing the other way. (§9)
3. **A 0% utilisation threshold produced false progress.**
   `utilisation_warning_threshold_percent` permits `0`; every reading "met" it,
   minting a `progress` signal *and* resolving the genuine risk signal it
   replaced. A non-positive target is now no target. (§5)
4. **A failed utilisation read looked like an empty rota.** Both surface as
   `unavailable`; only `rowCount` separates them, and conflating them handed the
   reconciler a *covered* state for what was actually an outage. (§5)
5. **Two headline statements the numbers did not support.** A `progress`
   headline said "up from" for stable and declining comparisons; the utilisation
   headline called the shortfall-to-target "unbooked hours", understating idle
   capacity roughly threefold while sounding more precise.
6. **The priority adapter erased location identity.** Two sites with the same
   reading collapsed into one "exact duplicate" in Phase 1's `identityKey` —
   silently dropped, and counted as corroboration that *raised* confidence. (§14)
7. **An unbounded suppression was irreversible.** `until: null` silenced an
   issue permanently and this workstream ships no unsuppress path. The window is
   now required, future-dated and capped at the metric's own credibility
   window. (§11)
8. **An unregistered metric key made every retrieval throw**, which would also
   have made the offending row impossible to suppress away. Now hidden, deny by
   default. (§13)
9. **`evaluate()` had no `zac.access` gate**, so a revoked actor could still
   drive lifecycle transitions on signals they could no longer read. (§13)
10. **A progress episode ending was recorded as `recovered`.** It is now
    `superseded` — calling it recovery would put the most reassuring word in the
    audit trail on the least reassuring event. (§9)
11. Smaller: the coverage key carried no tenant (making the key's guarantee a
    caller's promise); an unknown denominator out-scored a known minimal one;
    a stale `suppressed_until` survived a return to `active`; a negative
    denominator was read as `not_applicable` rather than corrupt; the base
    headline computed a negative gap for a `lower_is_better` metric.

**One test was strengthened rather than added.** Fixture D asserted that a
positive candidate does not occupy a priority slot using a *single* positive
candidate — which proves nothing, because Phase 1's `selectTop` falls back to
the full pool when filtering would empty it, so the assertion passes even with
the filter removed entirely. It now asserts against a competing problem and
with more slots than problems, which is the only shape that can tell a real
filter from a lucky sort.

**Deliberately not changed:** `rebookingGoalFromMemory` treats any remembered
sentence mentioning rebooking and a percentage as a goal. That is shipped Phase 1
behaviour and narrowing it would change live ZAC answers, so the helper is
reused unchanged (§3) and the *observation* layer filters to goal-shaped memory
kinds before calling it — a persisted target is a durable claim about what the
business is aiming at, and "rebooking was 40% last spring" is not one. The
underlying looseness is reported as a Phase 1 defect (§19.11).

---

## 17. Deliberately not wired into the live `/zac/ask` turn

The adapter is built, tested and callable through
`ZacIntelligenceSignalService.priorityCandidates()`, which composes it with the
existing `ZacPriorityService`. It is **not** injected at
`zac-orchestrator.service.ts:286`.

That line sits outside every intent conditional, so injecting there would
change `comparison`, `explanation`, `diagnostic` and `business_health` answers
— not just priority ones — and would add a database round trip to every live
data turn. Changing Phase 1 answer behaviour is a product decision, not a
foundation decision, and it belongs to the workstream that ships the feed.
`ZacIntelligenceSignalService` is exported from `ZacModule` for that purpose.

---

## 18. Out of scope, honoured

| Not built | Evidence |
|---|---|
| Scheduler / cron / background scan | No `onModuleInit`, no `onApplicationBootstrap`, no timer. Asserted by test. `@nestjs/schedule` remains absent. |
| Notifications / proactive ZAC feed | No notification call, no feed endpoint. |
| RAG / vector retrieval | No embedding, no vector store, no retrieval layer. |
| Value Created | No financial value, no attribution upgrade. `zac.outcome_events` untouched. |
| Autonomous actions | The framework returns values and writes only to its own table. Suppression is the only state change a person can cause, and only explicitly. |
| Workstream 2 (Expanded QLOOQO 10 & cross-domain intelligence) | Not started — no domain beyond the two reference metrics is registered. |
| QLAB / stock / profitability / retention | Not registered, not evaluated — §4. Asserted by test. |

---

## 19. Phase 1 defects found (reported, not fixed here)

Found while reading; **none is fixed in this build** — each is a separate change
with its own blast radius.

1. **`kpi-summary` drops the rebooking denominator.**
   `RebookingKpiResult.completedVisits` exists, but `toRow()` in
   `kpi-summary.tool.ts` emits `rebooking_rate_percent` and
   `rebooking_threshold_percent` without it. A per-stylist rebooking signal is
   therefore **impossible to build honestly** — which is why no personal-scope
   reference evaluator ships. *Impact: blocks a Phase 2 domain.*

2. **`rebooking-summary`'s `by_location` rows carry no denominator.**
   `location_name`, `rebooking_rate_percent`, `rebooked_visits` — no completed
   count, so a per-location rebooking rate cannot be told from an empty week.
   *Impact: same class as (1).*

3. **`fromUtilisation` never sets `period`.** `periodOf()` reads
   `range_start`/`period_start` (snake_case) while the utilisation payload is
   camelCase `rangeStart`. Utilisation signals always have `period: null`, and
   `period` is part of Phase 1's `identityKey` — so two utilisation readings of
   *different* windows dedupe as one. *Impact: a real dedupe defect in Phase 1.*

4. **No `tool_threshold` rebooking target ever reaches a signal.**
   `REBOOKING_THRESHOLD_PERCENT` is never passed into `rebookingSignal()`, so a
   rebooking candidate scores `materiality = 0` unless a memory-goal regex
   matches. Separately, `core.location_settings.rebook_rate_benchmark_percent`
   is **dead configuration** — read by the settings CRUD and nothing else.
   *Impact: rebooking is systematically under-prioritised in Phase 1.*

5. **`ZacPriorityCandidate.materiality`'s doc comment is stale.** It says
   "1 when a threshold or stated goal is actually being missed, else 0"; the
   implementation assigns the continuous `shortfallOf(primary)`, under a comment
   recording binary materiality as the defect that was fixed. *Impact: doc only.*

6. **`requireAccessibleOutput` omits the manager location check.**
   `ZacMemoryService.canSee` checks a manager's location for
   `manager_team_theme`; `ZacMeasurementStore.requireAccessibleOutput` does not,
   so any manager in the business could read a `manager_team_theme` output
   authored at another site. Latent only because `persistTurn` currently writes
   `user_private` or `business_owner`. **Not replicated here** — §13 mirrors the
   memory semantics. *Impact: latent privacy divergence.*

7. **`utilisation.service.ts:683-685` justifies skipping a tenant re-filter
   with a false claim** — "location_settings has no business_id column of its
   own to re-filter on", followed by `void businessId`.
   `0003_core_foundation.sql` declares `business_id uuid not null references
   core.businesses(id)`. The code is safe today because `resolveScope` validates
   the location first, but the stated reason is wrong. *Impact: comment + a
   missed defence-in-depth filter.*

8. **`zac.outputs.metric_to_measure` / `measurement_window_days` are dead
   columns.** Declared in `0077`, never written; `attribution_seed` and
   `measurement_hook` are hard-coded `null` at every response-builder site.
   *Impact: the Value Created hook is unreached — Workstream 4's problem.*

9. **Spine events are structured logs only.** `recordSpineEvent` writes to the
   logger; the class comment still describes a DB switch that was never built.
   Anything Phase 2 needs to query over time must be a real table — it cannot be
   recovered from spine events. *Impact: shaped this build's decision to persist.*

10. **Most `zac` text columns are unconstrained.** Only four `CHECK`s exist
    across `0077`/`0089`/`0090` (`messages.role`, `feedback.rating`,
    `outcome_events.attribution_type`, `memory_items.status`); `role_context`,
    `visibility_scope`, `status`, `confidence`, `request_mode` and others accept
    anything. *Impact: vocabulary enforced in TypeScript only. `0112` does not
    repeat it.*

11. **`rebookingGoalFromMemory` accepts any remembered sentence.** It matches on
    `/rebook/i` plus `/(\d{1,3})\s?%/` with no check on the memory's `kind` or
    `topic`, and takes the FIRST match in an unordered list. So
    "rebooking was 40% last spring" — a `recurring_problem` or a
    `prior_decision` — becomes the user's stated rebooking *goal*, and a live
    answer will attribute it as one. *Impact: a wrong target on a live Phase 1
    answer, and (before this build filtered for goal-shaped kinds) a wrong
    persisted target too.*

---

## 20. Deferred Phase 2 scope

| Deferred | Where it belongs |
|---|---|
| Financial, client/retention, appointment, services/retail, profitability metrics + evaluators | **Workstream 2** — a registry entry plus an evaluator each, **no redesign** |
| QLAB and stock metrics + evaluators | **Workstream 3** (probe-gated on V1.1 stability) |
| Per-stylist / personal-scope evaluators | Blocked on defect (1) |
| Per-location rebooking | Blocked on defect (2) |
| Scheduled evaluation, proactive priority feed, weekly/Sunday review, proactive notifications | **Workstream 5** — depends on notification/scheduler infrastructure that does not yet exist |
| Wiring persisted signals into the live `/zac/ask` priority path | §17 |
| Value Created / outcome attribution | Workstream 4 |
| Knowledge / RAG, model routing, cost controls | Workstream 7 |
| Coaching journeys | Workstream 6 |
| An HTTP surface for signals (list / suppress) | Deliberately none — no route means no proactive surface |
| Ending a suppression EARLY | No unsuppress path ships; suppression is bounded instead (§11), so every window closes by itself. An explicit unsuppress is a new surface and belongs with the feed |
| `occurrence_count` under concurrency | The refresh is read-then-write, so two simultaneous evaluations of one business would lose an increment. Harmless while evaluation is on demand and single-flight per actor; a scheduled evaluator would need an atomic increment |
| Hosted apply of `0112` + the `zac` Exposed-Schemas step | Operator task, §12 |

---

## 21. Extension recipe

To add a domain in a later workstream, with **no change** to the observation,
evaluation, reconciliation, persistence, visibility or adapter layers:

1. Add a `ZacMetricDefinition` to `zac-metric-registry.ts` (must pass all four
   criteria in §4) and its key to `ZacMetricKey`.
2. Add a reader branch to `ZacMetricObservationService` for that metric's
   canonical payload.
3. Either subclass `MetricShortfallEvaluator` (two lines, if the domain is
   shortfall-shaped) or implement `ZacSignalEvaluator` directly.
4. Register it in `ZacSignalEvaluatorRegistry` — boot asserts the metric exists,
   the issue key matches and the evaluator key is unique.
5. If the metric's issue is not one of Phase 1's eight, extend
   `ZacPriorityDomain` **and** the `ISSUE_DOMAIN` / `ISSUE_TITLE` maps together,
   or it lands in `other`.

---

## 22. Files

**New**

```
apps/api/src/zac/intelligence/zac-metric.types.ts
apps/api/src/zac/intelligence/zac-metric-registry.ts
apps/api/src/zac/intelligence/zac-metric-observation.service.ts
apps/api/src/zac/intelligence/zac-signal.types.ts
apps/api/src/zac/intelligence/zac-signal-scoring.ts
apps/api/src/zac/intelligence/zac-signal-evaluator.registry.ts
apps/api/src/zac/intelligence/zac-signal-reconciler.ts
apps/api/src/zac/intelligence/zac-signal-priority.adapter.ts
apps/api/src/zac/intelligence/zac-intelligence-signal.service.ts
apps/api/src/zac/intelligence/evaluators/metric-shortfall.evaluator.ts
apps/api/src/zac/intelligence/evaluators/rebooking-shortfall.evaluator.ts
apps/api/src/zac/intelligence/evaluators/utilisation-shortfall.evaluator.ts
apps/api/src/zac/intelligence/zac-signal-framework.spec.ts
apps/api/src/zac/intelligence/zac-intelligence-signal.service.spec.ts
apps/api/src/zac/persistence/zac-intelligence-signal.store.ts
supabase/migrations/0112_zac_intelligence_signals.sql
supabase/tests/zac_intelligence_signals.sql
docs/ZAC/phase-2-intelligence-signal-framework.md
```

**Commit:** `d6173238c87904e635629523ede98a56646c5768` on
`feature/zac-phase2-intelligence-signals`.

**Changed** (additive only)

```
apps/api/src/zac/analysis/zac-evidence.service.ts   exported scoreEvidenceSignal + rebookingGoalFromMemory
apps/api/src/zac/measurement/zac-cost-telemetry.service.ts   +2 spine event names
apps/api/src/zac/zac.module.ts                      providers + exports
```

---

## 23. Hosted verification (dev-test, 2026-09-04)

**Target.** Supabase branch `dev-test` (`iqgryrczkvjkcbrgfsdl`) — the project
`apps/api/.env` `SUPABASE_URL` points at, and the only hosted project with the
`zac` schema applied and exposed. Production (`cdjtsqcrcgywjdwvbxyf`),
`develop` and `staging` were **not** touched: production is not the current
deployment target for this work, and the other two branches carry no `zac`
schema at all (the 0077–0112 ZAC stack has never been applied there — a
pre-existing deployment gap, outside Workstream 1).

**Before.** `GET /rest/v1/intelligence_signals?select=id&limit=1` with
`Accept-Profile: zac` and the service-role key → **PGRST205** ("Could not
find the table 'zac.intelligence_signals' in the schema cache"). The `zac`
schema itself was already on the Exposed Schemas list (the 0080 prerequisite),
so this was the table's absence, not the schema's.

**Apply.** `0112_zac_intelligence_signals.sql` applied verbatim through the
Supabase management API at 2026-09-04 21:12:45 UTC. Ledger:
`20260904211245 0112_zac_intelligence_signals`. (0111 remains unapplied on
this branch — pre-existing and independent; 0112 depends on nothing in it.)

| Schema evidence (`information_schema` / `pg_catalog`) | Value |
|---|---|
| `zac.intelligence_signals` | present, 38 columns |
| CHECK constraints (as reported by `information_schema`, NOT NULL included) | 36 |
| Indexes | `intelligence_signals_pkey`, `idx_zac_intelligence_signals_live_key` (partial unique), `_business_live`, `_location`, `_subject` |
| RLS | enabled **and forced** |
| Policies | `zac_intelligence_signals_owner_select`, `zac_intelligence_signals_subject_select` — both `authenticated` |
| Grants | `authenticated`: SELECT only; `service_role`: SELECT/INSERT/UPDATE/DELETE |
| Trigger | `set_zac_intelligence_signals_updated_at` |

**After.** Same PostgREST request → **200 `[]`**; the same request with no
key → **401**.

### 23.1 Lifecycle smoke test (brief T1–T5), real store, real service

Run from the API workspace with the **production `ZacIntelligenceSignalStore`**
(service-role client, per-query `.schema('zac')`, `.eq('business_id')`) driven
by the **real `ZacIntelligenceSignalService`**; only the tool result, the
memory list and the clock were canned. Fixture business: *Sheer Demo Salon*
(`10000000-…-0001`, no real members; locations Pinner/Thame/Abingdon). The
brief's 60% target was supplied the one way Workstream 1 admits — a remembered
`business_goal` ("Increase rebooking to 60% this quarter.") attributed as
`user_stated_goal` — because the configured KPI threshold does not reach the
signal today (Phase 1 defect triage, close-out report §21 #5). Sample 240.

| Step | Input | Reconciler | Row evidence (as read back through the store) |
|---|---|---|---|
| T1 | rebooking 49 | `open` | 1 row `ac677488…`: active · opportunity · attention · materiality **0.1833** · confidence 0.648 · observed 49 · target 60 (`user_stated_goal`) · sample 240 · occurrence 1 · first_evaluated **T1** · last_confirmed **T1** |
| T2 | rebooking 51 | `refresh` | **same id**, still 1 row: observed 51 · materiality 0.15 · occurrence **2** · first_evaluated **unchanged (T1)** · last_confirmed **T2** — no duplicate active row |
| T3 | read `unavailable` (rowCount null → `missing`) | `retain` | row **untouched**: active · observed 51 · occurrence 2 · last_confirmed still T2 · resolution_reason null — **not resolved** |
| T4 | rebooking 62 | `resolve:recovered` + `open` | `ac677488…` → **resolved / recovered / resolved_at T4**; a `progress` row `3dce755c…` opened (62 ≥ 60) |
| T5 | rebooking 45 | `open` + `resolve:superseded` | **new** opportunity `96101231…` (active, observed 45, occurrence 1, first_evaluated T5) under the **same signal_key**; `ac677488…` still resolved/recovered (history preserved); the progress row resolved `superseded` |

Every field above is what the brief's expected outcomes describe, including
the documented recurrence semantics (historical resolved occurrence preserved
+ new occurrence). `numeric(6,4)` rounding is visible (0.18333… → 0.1833) and
is immaterial: reconciliation is key-based, never value-based.

### 23.2 Permission / tenant smoke test (brief §16)

Service-side (`listVisible`, current permissions and acting context re-checked
on every read), after adding a Pinner-manager row (M1, 40%), a Thame-manager
row (M2, 41%), a business row for *TESTBUSINESS-1* evaluated by its **real
owner membership** (B1, 30%), and a `user_private` probe row for that owner
written through the store's normal insert path (B2):

| Actor (current context) | Saw | Property |
|---|---|---|
| Demo owner, all locations, full permissions | business + Pinner + Thame | baseline |
| Demo owner with `report.dashboard.view` **removed after creation** | **nothing** | removing a permission hides existing rows; persisted `business_owner` visibility granted nothing |
| Pinner manager | business + **Pinner only** | a manager with Location A scope cannot retrieve the Location B signal |
| Thame manager | business + **Thame only** | same, mirrored |
| Demo stylist (`zac.access` only) | nothing | no report permission → no signals |
| TESTBUSINESS-1 owner | its own business row (+ the personal row it is the subject of) — **no demo-salon row** | Business A's signals are not readable from Business B |

Managers seeing the business-scope row is the designed matrix (`canSee`
mirrors `ZacMemoryService.canSee`: `business_owner` rows are readable by
owners and managers; `manager_team_theme` rows only by owners and the row's
own-location managers) and is what harness case `scope-04` asserts. Two
expectations in the smoke script were mine and wrong, not the framework's: it
expected managers to see no business row, and it "narrowed" an owner's context
while leaving the actor's `locationScope.kind = 'all'` — an owner's scope is
all locations by definition.

Database-side, through RLS as **real authenticated users** (`set local role
authenticated` + `request.jwt.claim.sub`; no bypass):

| User | Result |
|---|---|
| TESTBUSINESS-1 owner `9b1c0bf6…` | exactly 2 rows: its `business_owner` row (owner policy) and the `user_private` row it is the subject of (subject policy); **0** demo-salon rows |
| Owner of a different business (`bf09e3e5…`, 1 active owner membership elsewhere) | **0** rows |
| Stylist (`62ae54ca…`) | **0** rows |
| TESTBUSINESS-1 owner, `UPDATE zac.intelligence_signals` | **42501 permission denied** (authenticated has SELECT only) |
| No key, PostgREST | **401** |

**Cleanup.** The 7 rows created by the smoke test were deleted by id (both
fixture businesses back to 0; table total 0). Nothing else on dev-test was
written.

**Runbook for staging / production** (when either becomes the deployment
target): (1) confirm the `zac` schema is on Exposed Schemas — a 200 from
`GET /rest/v1/memory_items?limit=1` with `Accept-Profile: zac` proves it;
(2) apply `0112` verbatim; (3) expect PGRST205 to become `200 []`; (4) run the
§23.1 sequence against a test business and delete the rows. No production
apply is authorised by this close-out.
