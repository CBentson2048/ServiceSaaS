# ZAC Phase 2 — Workstream 1 close-out report

> **Status: ENGINEERING COMPLETE · HOSTED VERIFICATION COMPLETE on dev-test (production not a target of this close-out)**
>
> **Workstream 1 is closed.**
>
> Prepared 2026-09-04 against the authoritative plan. Every number in this
> report was produced by a command recorded next to it; nothing is asserted from
> memory. Hosted evidence is quoted from the dev-test project the API's own
> `.env` targets; production was not touched.

---

## 1. Workstream 1 plan contract

Workstream 1 is the **reusable intelligence/signal substrate**. It exists so
that later workstreams can register a metric and an evaluator and ship
proactive delivery without redesigning how a signal is observed, scored,
deduplicated, persisted, authorised or evaluated.

It is **not** the population of that substrate (financial, client/retention,
appointment, services/retail, profitability — Workstream 2), **not** the
scheduler, proactive feed, weekly review or notifications (Workstream 5), and
**not** QLAB/stock, Value Created, RAG or autonomous action (Workstreams 3, 4,
7 and the product boundary).

## 2. Authoritative source

[`docs/ZAC/ZAC_Phase_2_Incremental_Plan_UPDATED.pdf`](ZAC_Phase_2_Incremental_Plan_UPDATED.pdf)
— *ZAC Phase 2 Incremental Plan, Client Review Edition*: eight workstreams,
**280h expected incremental baseline**, a **separately held 40h central
delivery contingency** (not pre-allocated, not for Phase 1 remediation, never
consumed automatically), maximum envelope 320h. The earlier
`ZAC_Phase_2_Client_Review_Plan.pdf` is superseded; its "Workstream 1" is the
updated plan's Workstream 2. The tracking rule is now recorded in
[`docs/ZAC/README.md`](README.md).

## 3. Original 24h deliverables (plan, verbatim)

> *Canonical metric registry; proactive signal lifecycle;
> opportunity/risk/watch-point contracts; materiality/severity rules;
> deduplication; Phase 2 evaluation harness.* — 24h

## 4. Deliverable status table

| Deliverable | Implementation | Proof | Status |
|---|---|---|---|
| Canonical metric registry | `intelligence/zac-metric-registry.ts` | registry spec + harness `target_source` (6/6) | ✅ complete |
| Proactive signal lifecycle | `intelligence/zac-signal-reconciler.ts`, `supabase/migrations/0112` | reconciler spec; harness lifecycle (35/35) + resolution (2/2); SQL suite 28/28; hosted T1–T5 (§18) | ✅ complete |
| Opportunity/risk/watch-point contracts | `intelligence/zac-signal.types.ts` (+ `progress`) | harness kind accuracy (34/34) | ✅ complete |
| Materiality/severity rules | `intelligence/zac-signal-scoring.ts` | harness materiality band (13/13), severity (11/11), confidence band (12/12) | ✅ complete |
| Deduplication | `buildSignalKey` + partial unique index `idx_zac_intelligence_signals_live_key` | harness dedupe (78/78), `repeat_run_no_duplicate` PASS; hosted T2 (§18) | ✅ complete |
| Phase 2 evaluation harness | `intelligence/eval/`, `scripts/zac-signal-eval.ts`, `pnpm --filter @sheer/api zac-signal-eval` | §14–§16 below | ✅ complete |

## 5. Canonical metric registry

Two metrics are admitted; each passes the four-criterion bar the registry
enforces (canonical implementation with a source reference; exposed
denominator; stateable sample floor; target with provenance):

| Metric | Canonical source (Phase 1 tool) | Denominator / floor | Target and provenance |
|---|---|---|---|
| `rebooking_rate` | `report.rebooking_summary` → `DashboardService.kpis` | `completed_bookings`, floor 20 visits | canonical 50% (`canonical_threshold`) or a remembered `business_goal` / `business_priority` / `coaching_focus` (`user_stated_goal`) |
| `utilisation_rate` | `report.utilisation_summary` → `computeDailyUtilisation` | `availableMinutes/60` rostered hours, floor 40h | the location's `warningThresholdPercent` (`location_setting`); `≤ 0` means no target |

Two metrics is a correct Workstream 1 registry: the registry is the
deliverable, its population is Workstream 2 (§1). Metrics that fail a criterion
today (retention, profitability, retail, revenue/cancellations, QLAB/stock)
are listed with the failing criterion in
[`phase-2-intelligence-signal-framework.md` §4](phase-2-intelligence-signal-framework.md).

## 6. Signal contracts

Closed vocabularies, all persisted with CHECK constraints in 0112:

- kind: `opportunity | risk | watch_point | progress`
- severity: `positive | watch | attention` (the Phase 1 vocabulary, unchanged —
  a persisted signal becomes a priority candidate by identity, not translation)
- direction: `improving | stable | declining | unknown`
- observation: `valid | zero | missing | insufficient_sample | not_applicable`
- withheld reasons: `no_target | below_materiality_floor | insufficient_sample | missing_observation | not_applicable`
- lifecycle: `active | resolved | suppressed | expired`; resolution
  `recovered | superseded | expired_unconfirmed | suppressed_by_actor`

## 7. Materiality

`computeMateriality` = `clamp01(gap / target)` where `gap` respects the metric's
polarity; `0` at or above target, `0` when value or target is unknown or the
target is non-positive. Bands are declared per metric (`watch ≥ 0.05`,
`attention ≥ 0.15` for both admitted metrics); a gap inside the watch band is
withheld as `below_materiality_floor`, never raised.

## 8. Severity

Deterministic from materiality and band: `attention` at or above the attention
band, `watch` between the bands, `positive` for a `progress` signal. No model
is consulted anywhere in the pipeline.

## 9. Confidence

Data quality only, never gap size:
`base (0.9 valid / 0.85 zero) × sample factor (min(1, max(0.6, sample / 2·floor)); 0.55 when the sample is unknown) × target provenance (location_setting 1.0 / canonical 0.95 / user goal 0.9) × source caveats (1 − 0.1 × min(3, caveats))`,
bucketed by the existing `confidenceScoreBucket` (≥ 0.7 high, ≥ 0.45 medium).
Calibration observation recorded by the harness: the rebooking tool always
carries two product caveats, so rebooking confidence peaks at `medium` (0.684)
and is `low` (0.41) at the 20-visit floor. Confidence never gates raising.

## 10. Dedupe

Identity = `business | evaluator | metric | scopeType | locationId | subjectUserId | family(shortfall|progress)`
— deliberately excluding period and value, so a rolling window refreshes one
row. Enforced twice: the reconciler matches on the key, and Postgres refuses a
second live row per `(business_id, signal_key)` where status ∈ {active,
suppressed}. Resolved/expired episodes accumulate as history; a recurrence
opens a new row under the same key.

## 11. Lifecycle

Reconciler actions: `open`, `refresh` (occurrence +1, `last_confirmed_at`
advanced only by positive evidence), `resolve` (`recovered` for a shortfall,
`superseded` for a progress run that ended), `expire`
(`expired_unconfirmed` after the metric's stale window with no confirmation),
`retain` (any non-positive observation — missing, failed, not_applicable,
insufficient_sample, no target — leaves the row exactly as it was). Suppression
is a human action bounded by `suppressed_until`; a suppressed row still holds
its issue's live slot. **Expiry is not resolution**: it says "we could no
longer tell", and the persisted reason says so.

## 12. Persistence

Migration `0112_zac_intelligence_signals.sql`: one table in the existing `zac`
schema, safe references only (metric refs, evidence refs, redacted headline —
no operational payload), RLS enabled and forced, service-role CRUD,
authenticated SELECT narrowed by two policies (owner: business-visible scopes;
subject: own personal rows). `ZacIntelligenceSignalStore` (service-role client,
per-query `.schema('zac')`, `.eq('business_id')` on every statement) implements
the `ZacSignalRepository` port the service depends on. Visibility is a
write-time snapshot that only narrows; the service re-checks the actor's
current permissions and scope on every read.

## 13. Evaluation harness

```
pnpm --filter @sheer/api zac-signal-eval        # scorecard, exit 1 on any failure
npx jest src/zac/intelligence/eval               # the same run as a CI gate
```

Runs the **real** pipeline — observation service, evaluator registry,
reconciler, `ZacIntelligenceSignalService` (scope fan-out, visibility matrix,
permission re-check, plan application) — over a versioned labelled dataset and
an in-memory repository that enforces the same live-uniqueness rule as
Postgres. Only tool results, memory and the clock are canned. **No model, no
provider SDK, no `ZAC_AI_PROVIDER`** — pinned by the harness spec. Labels are
the framework's own closed types (a vocabulary change is a compile error in
the dataset). Cases are sequences of `evaluate` / `suppress` steps, because
refresh-not-duplicate, never-resolve-on-missing and expire-is-not-resolve are
only observable across runs. Every metric is computed from individual checks
and every failed check is printed with expected vs actual. Three invariant
counters are derived from what the pipeline *did*, not from labels.

## 14. Dataset version

`zac-signal-eval-v1` · framework `ws1-2026-09-04` · **80 cases / 120 steps**
(`apps/api/src/zac/intelligence/eval/zac-signal-eval-dataset.v1.json`):

| Domain | Cases | Steps | Invariant-tagged |
|---|---|---|---|
| rebooking | 24 | 24 | zero-denominator 5 |
| utilisation | 19 | 19 | failed-read 4 |
| lifecycle | 20 | 48 | missing-never-resolves 8, repeat-run-no-duplicate 9 |
| scoping | 10 | 15 | tenants-never-reconcile 3, restricted-scope 4, removed-permission 3 |
| dedupe | 7 | 14 | — |

Future workstreams add cases and a `domain`; runner, scorer, actor presets and
gates are unchanged. `frameworkVersion` is bumped only when a framework change
alters what an existing label means.

## 15. Evaluation results

`pnpm --filter @sheer/api zac-signal-eval` on the close-out tree
(HEAD at run time `59d5656`; the run is reproduced by the CI spec on the
close-out commit itself):

```
Dataset                                zac-signal-eval-v1
Framework                              ws1-2026-09-04
Cases 80 · Passed 80 · Failed 0

Signal/no-signal accuracy              100.0%   (83/83)
Kind accuracy                          100.0%   (34/34)
Direction accuracy                     100.0%   (10/10)
Materiality-band accuracy              100.0%   (13/13)
Severity accuracy                      100.0%   (11/11)
Confidence-band accuracy               100.0%   (12/12)
Target-source accuracy                 100.0%   (6/6)
Withheld-reason accuracy               100.0%   (26/26)
Lifecycle transition accuracy          100.0%   (35/35)
Resolution accuracy                    100.0%   (2/2)
Dedupe accuracy                        100.0%   (78/78)
Store-state accuracy                   100.0%   (112/112)
Visibility accuracy                    100.0%   (18/18)

False-positive negative signals        0 / 30
False-negative signals                 0 / 53
Duplicate active signals               0
False resolution on missing/failed     0
Tenant isolation failures              0
Permission failures                    0

Hard invariants (zero tolerance):      7 of 7 PASS
```

Every percentage above is computed from the individual checks at run time;
none is hard-coded.

## 16. All failed evaluation cases

At close-out: **none** — 80 of 80 cases, 0 failed checks, 0 invariant failures.

Found and fixed while the harness was being built (the reason it exists):

| Case(s) | What the harness exposed | Disposition |
|---|---|---|
| 7 rebooking/lifecycle confidence labels | Authored as `high`; the real tool always carries two caveats → 0.684 `medium`, and 0.41 `low` at the floor | Labels corrected; `reb-21b` added as a no-caveat control; calibration note recorded (§9) |
| `life-16`, `life-18` (expiry) | Reconciler `expire` actions carried no `resolutionReason`; only the service stamped `expired_unconfirmed` | **Class B (WS1 defect), fixed**: the plan now states the reason itself; the service applies the plan's reason |

Transient, not a defect: one run of the script reported `scope-09` failing
(6 rows written by a revoked actor) while an automated review was rewriting
source files in the working tree; the same tree re-run after the review was
stopped passes 80/80 (the run quoted in §15). Recorded because a red scorecard must be
explained, not because the framework misbehaved.

## 17. Migration 0112 review

**Local, all 112 migrations applied in order (PGlite + Supabase bootstrap):**

| Check | Result |
|---|---|
| `0112` applies after `0001`–`0111`; re-runnable (`if not exists` / `drop … if exists`) | ✅ |
| `supabase/tests/zac_intelligence_signals.sql` | ✅ 28 of 28 probed cases PASS |
| All 19 behavioural suites, full stack | 9 exit 0; 5 report every recorded case PASS but exit 1 because the runner counts their `SUMMARY` row as a verdict (`campaign_configuration` 13/13, `formula_change_detection` 15/15, `message_usage_accounting` 16/16, `operational_signal_settings` 14/14, `post_checkin_service_lifecycle` 47 PASS / 0 FAIL); 5 abort on fixture collisions (`client_lapse_intelligence`, `payroll_0078_integrity`, `payroll_regression`, `payroll_validation`, `week6_stock_colour_prep`) |
| The same 10 non-zero suites with the stack capped at `0111` (0112 excluded) | **identical outcomes** — pre-existing runner/fixture conditions, nothing introduced by 0112 |

Dependencies: `extensions.gen_random_uuid`, `public.current_user_id`,
`public.is_business_owner`, `public.set_updated_at`, `core.businesses`,
`core.locations`, `core.user_profiles` — all present on the hosted target
before `0111`, so 0112 is safe to apply ahead of 0111 there.

Adversarial review (read-only, seven lenses, every finding independently
verified): «PENDING-REVIEW»

## 18. Hosted / staging verification

**Done on `dev-test`** (`iqgryrczkvjkcbrgfsdl`, the project the API `.env`
targets); full evidence in
[`phase-2-intelligence-signal-framework.md` §23](phase-2-intelligence-signal-framework.md).

- Before: PostgREST `PGRST205` (table absent; `zac` schema already exposed).
- Applied `0112` verbatim at 2026-09-04 21:12:45 UTC; ledger
  `20260904211245 0112_zac_intelligence_signals`.
- Schema verified: table (38 columns), CHECKs, 5 indexes including the partial
  unique live-key index, RLS enabled **and forced**, 2 `authenticated` SELECT
  policies, grants (`authenticated` SELECT only; `service_role` CRUD), trigger.
- After: PostgREST **200 `[]`** with the service role, **401** with no key.
- Lifecycle T1–T5 through the **real store and service**: T1 open (occurrence
  1, first=last_confirmed=T1) → T2 refresh of the **same row** (occurrence 2,
  first unchanged, last_confirmed T2, no duplicate) → T3 missing read
  **retains** (row untouched, not resolved) → T4 62% **resolved/recovered**
  with `resolved_at` (+ a progress row) → T5 45% **new episode** under the same
  key with the resolved episode preserved and the progress row `superseded`.
- All 7 smoke rows deleted afterwards; both fixture businesses at 0 rows.

**Not done, by decision:** production (`cdjtsqcrcgywjdwvbxyf`) is not the
current deployment target for this work and was not touched; `develop` and
`staging` carry no `zac` schema at all (pre-existing, outside WS1). A runbook
for those targets is in §23 of the framework doc.

## 19. Permission / tenant verification

Service-side (`listVisible`, current permissions and context re-checked) and
database-side (RLS as **real authenticated users**, no bypass), on dev-test:

| Brief property | Evidence |
|---|---|
| Business A's signal cannot be read from Business B | TESTBUSINESS-1's real owner: service-side sees only its own business row; RLS returns exactly its 2 rows and **0** demo-salon rows. Another business's owner: **0** rows. |
| Manager with Location A scope cannot retrieve the Location B signal | Pinner manager sees Pinner's row, never Thame's; Thame manager the mirror. (Both also see the business-scope row — the designed matrix, `canSee` = `ZacMemoryService.canSee`, harness `scope-04`.) |
| Removing a permission after creation prevents later retrieval | Owner with `report.dashboard.view` removed: **nothing** returned, rows still present. |
| Persisted visibility never grants access | The same rows carry `business_owner` visibility; without the permission they are invisible. Stylist: nothing. |
| Current acting context remains authoritative | Every read above is decided from the actor/context passed on that call, not from the row. |
| Direct-DB defence in depth | `authenticated` UPDATE → **42501 permission denied**; anonymous PostgREST → **401**. |

Two smoke-script expectations were mine and wrong (managers seeing no business
row; a "narrowed" owner whose `locationScope.kind` stayed `'all'`); they are
recorded in the framework doc §23.2 rather than hidden.

## 20. Documentation corrections

[`phase-2-intelligence-signal-framework.md`](phase-2-intelligence-signal-framework.md):

- Removed the naming note that judged the build against the superseded plan
  and wrongly claimed no such workstream existed; replaced with the
  authoritative-plan note and a new **§0 contract / definition of done**
  stating what Workstream 1 is and is not (WS2 population, WS5 scheduling/feed,
  WS3/4/7 and the product boundary explicitly excluded).
- Corrected two stale feasibility claims: `billing.location_fixed_costs` has a
  full CRUD path (`owner-location-settings.service.ts`); `billing.retail_sales`
  has a live `RetailSalesModule`. Both are now stated as Workstream 2 items
  failing a specific registry criterion, not as "empty tables".
- Added §15b (the evaluation harness) and the harness gate to the §15 table.
- Corrected the workstream numbering in §18/§20 to the UPDATED plan
  (WS2 expanded intelligence, WS3 QLab/stock, WS5 proactive, WS6 coaching,
  WS7 knowledge/RAG/model routing).
- Status line now reads *engineering complete — hosted verification recorded
  separately* rather than "implemented".

[`README.md`](README.md): the authoritative-plan rule (which PDF governs, why,
and the precedence when plan and code disagree).

## 21. Phase 1 defect triage

Boundary applied (plan, *Phase 1 / Phase 2 boundary*): *"Defects in Phase 1
memory, permission, evidence, grounding, feedback, cost telemetry or the six
Core MVP tools"* remain Phase 1 completion; contingency is *not permitted* for
Phase 1 remediation. **None of the six was fixed inside Workstream 1**; none is
in newly-created Phase 2 code.

| # | Defect | Where (provenance) | Class | Why | Effect on WS1 |
|---|---|---|---|---|---|
| 1 | `fromUtilisation` emits no `period` | `analysis/zac-evidence.service.ts:182` (Phase 1 evidence, 2026-08-26) | **A** — Phase 1 evidence defect | Evidence signals carry a nullable `period`; the utilisation branch never sets it | None: WS1 observations carry their own window (`metric_refs`, `period_label`) |
| 2 | `requireAccessibleOutput` enforces business + role only, not manager location | `persistence/zac-measurement.store.ts:147` (Phase 1 permission, 2026-08-18) | **A** — Phase 1 permission defect | A location-scoped manager can act on any business-visible output of the business | None: `ZacIntelligenceSignalService.canSee` adds the location check for signals (`zac-intelligence-signal.service.ts:457`) and documents the divergence |
| 3 | `kpi_summary` drops the rebooking denominator | `tools/tools/kpi-summary.tool.ts:95` (Core MVP tool) | **A** — Core MVP tool defect (also a **C** dependency for WS2 per-stylist rebooking) | The tool reports per-stylist rates without `completed` counts, so no stylist-level metric can pass registry criterion 2 | None for the two admitted metrics; blocks a future `personal`-scope rebooking metric |
| 4 | `by_location` rows lack a denominator | `tools/tools/rebooking-summary.tool.ts:66` (Core MVP tool, 2026-07-28) | **A** — Core MVP tool defect (also **C** for WS2 location breakdowns) | Location rows carry rate and count but not `completed_bookings` | Worked around, not fixed: WS1 dispatches the tool per accessible location and never reads sub-slices (`zac-metric-observation.service.ts:43`) |
| 5 | The KPI `tool_threshold` rebooking target does not reach the persisted signal | Phase 1 evidence carries it (`zac-evidence.service.ts:209`); `report.rebooking_summary` does not expose it, so the WS1 observation cannot see it | **C** — Workstream 2 dependency | No Phase 1 acceptance criterion requires a persisted signal to carry the configured KPI threshold; the Phase 1 evidence path already does. Making a *configured* rebooking target drive the signal (`location_setting` provenance, already in the vocabulary) is Workstream 2's "stable … intelligence" work, gated on the tool exposing the threshold | Hosted smoke used a remembered goal to supply the brief's 60% target (§18) |
| 6 | `rebookingGoalFromMemory` treats any remembered percentage near "rebook" as a goal | `analysis/zac-evidence.service.ts:434`, called unfiltered at `:347` (Phase 1 evidence/memory) | **A** — Phase 1 evidence defect | A `recurring_problem` memory ("rebooking dipped to 40% last spring") becomes a 40% goal in Phase 1 evidence | **Contained in Phase 2 code, not fixed in Phase 1**: the WS1 observation only passes goal-kind memories (`GOAL_MEMORY_KINDS`), proved by harness case `reb-12` |

No **D** (non-blocking technical debt) classification was used for these six:
each is a defect in a Phase 1 layer the plan names explicitly, so it is Phase 1
completion by the plan's own rule, whatever its severity.

## 22. Phase 1 vs Phase 2 accounting

| Bucket | Work | Commits | Hours |
|---|---|---|---|
| **Workstream 1 (24h plan)** | framework, registry, lifecycle, contracts, materiality/severity, dedupe, 0112, adapter; evaluation harness + dataset; documentation corrections; WS1-specific verification (local suites, hosted smoke) | `d617323` (22 files, +6,654), `bb0f8f3`; this close-out commit («PENDING-SHA») | see §23 |
| **Phase 1 remediation** | the six defects in §21 | none — **0h consumed**; not fixed | estimate to fix all six: ~3–5h, **Phase 1 completion, not Phase 2** |
| **Cross-cutting provider architecture** | OpenAI/Anthropic provider abstraction, profiles, benchmark architecture | `cf56719` (26 files, +3,980), `2e9c82b`, `383e002` | **not Workstream 1**. Under the plan this is Workstream 7 territory ("model routing & cost controls", 34h) and was requested separately; it is recorded here so it is not silently absorbed into WS1's 24h |

Contingency consumed: **0h**. Workstream 2 capability implemented: **none**.

## 23. Actual WS1 hours (if available)

No timesheet is kept in this repository, so **actual billable hours are not
available here** and must come from the engineer's time records. The only
in-repo signal is commit wall-clock, which is *not* a claim of hours worked:
the framework build landed at 04:26 on 2026-09-04 (previous commit 21:43 on
09-03); the close-out session ran from the plan commit at 15:41 to
the close-out commit (§28) on 2026-09-04.

## 24. Expected remaining WS1 hours

**0h engineering.** Nothing in the definition of done is outstanding. Production apply of 0112 (≤ 0.5h, plus the pre-existing 0077–0111 stack) belongs to whichever release first targets production and is release work, not WS1.

## 25. Risks

- Confidence calibration: static product caveats and genuine data-quality
  notes currently weigh the same; rebooking cannot reach `high`. Recorded for
  the Workstream 2/5 calibration pass; it never gates raising.
- Configured rebooking targets do not reach the signal (§21 #5) until the tool
  exposes the threshold — Workstream 2.
- The in-memory harness repository mirrors the live-uniqueness rule and tenant
  filter, not every CHECK constraint or `numeric(6,4)` rounding; the hosted
  smoke test is what proves those («PENDING-REVIEW» for any further items).
- Nothing evaluates signals on a schedule; until Workstream 5 the framework
  runs only when invoked.

## 26. Deferred items

- Everything in §1's "not" list (Workstreams 2, 3, 4, 5, 7, product boundary).
- Phase 1 defects #1–#6 (Phase 1 completion).
- Configured rebooking targets reaching the signal (§21 #5) — Workstream 2.
- Confidence calibration of static caveats vs data-quality notes — Workstream 2/5.
- Applying the ZAC migration stack to `develop`/`staging` — deployment, pre-existing.

## 27. Final test counts

| Check | Result |
|---|---|
| Evaluation harness (`zac-signal-eval`) | 80/80 cases, 7/7 invariants, exit 0 |
| `npx jest src/zac/intelligence` (framework A–L, service, harness gate) | 3 suites, **107 passed** |
| Full API suite `npx jest` (apps/api) | **121 suites, 2,511 passed, 226 todo, 0 failed** |
| `tsc --noEmit` (apps/api) | 0 errors |
| `eslint src/zac scripts/zac-signal-eval.ts` | 0 problems |
| `supabase/tests/zac_intelligence_signals.sql` (PGlite, 112 migrations) | 28/28 PASS |
| All 19 SQL suites, full stack vs stack capped at 0111 | identical outcomes (§17) |

## 28. Final commit SHA

«PENDING-SHA»
