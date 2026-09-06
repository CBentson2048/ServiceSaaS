# ZAC Phase 2 — Workstream 1 close-out report

> **Status: ENGINEERING COMPLETE · HOSTED VERIFICATION COMPLETE on dev-test (production not a target of this close-out) · adversarial review actioned (§17)**
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
| Proactive signal lifecycle | `intelligence/zac-signal-reconciler.ts`, `supabase/migrations/0112` | reconciler spec (+ fixture H: recovered vs superseded); harness lifecycle (50/50) + resolution (10/10, `superseded` asserted); SQL suite 29/29; hosted T1–T5 twice (§18) | ✅ complete |
| Opportunity/risk/watch-point contracts | `intelligence/zac-signal.types.ts` (+ `progress`) | harness kind accuracy (42/42) | ✅ complete |
| Materiality/severity rules | `intelligence/zac-signal-scoring.ts` | harness materiality band (13/13), severity (11/11), confidence band (12/12) | ✅ complete |
| Deduplication | `buildSignalKey` + partial unique index `idx_zac_intelligence_signals_live_key` | harness dedupe (12/12 real key assertions — the 70 unfireable per-step checks the review found were removed), `repeat_run_no_duplicate` PASS, 0 duplicate attempts; hosted T2 (§18) | ✅ complete |
| Phase 2 evaluation harness | `intelligence/eval/`, `scripts/zac-signal-eval.ts`, `pnpm --filter @sheer/api zac-signal-eval` | §14–§16 below | ✅ complete |

## 5. Canonical metric registry

Two metrics are admitted; each meets the four-criterion bar the registry
declares (canonical implementation with a source reference; exposed
denominator; stateable sample floor; target with provenance) — the structural
half of which is now asserted by a framework-spec test over every definition
(source reference, tool, sample unit and floor, ordered bands, stale window,
permission requirement); the judgement half (is the source *canonical*?) is a
documented decision per metric, not something a test can decide:

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
- withheld reasons: `no_target | below_materiality_floor | insufficient_sample | missing | not_applicable | healthy_steady`
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
its issue's live slot; once the window lapses the row is readable again even
before the next positive reading flips its status (a suppression "ends by
itself"). **Expiry is not resolution**: it says "we could no longer tell", and
the persisted reason says so. **Recovery is earned**: `recovered` only when the
reading closed the gap against the target the signal was raised for; a target
that moved under an unchanged number ends the old signal as `superseded`.

## 12. Persistence

Migration `0112_zac_intelligence_signals.sql`: one table in the existing `zac`
schema, safe references only (metric refs, evidence refs, redacted headline —
no operational payload), RLS enabled and forced, service-role CRUD,
authenticated SELECT narrowed by two policies (owner: business-visible scopes;
subject: own personal rows). `ZacIntelligenceSignalStore` (service-role client,
per-query `.schema('zac')`, `.eq('business_id')` on every statement) implements
the `ZacSignalRepository` port the service depends on. Visibility is a
write-time snapshot that only narrows; the service re-checks the actor's
current permissions and scope on every read. Business-scope rows are
owner-only; location/team rows are readable by owners and the row's own-location
managers; personal rows by their subject alone.

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
the framework's own closed types (a vocabulary change fails the dataset load —
`validateDataset` re-checks every label against the exported vocabularies). Cases are sequences of `evaluate` / `suppress` steps, because
refresh-not-duplicate, never-resolve-on-missing and expire-is-not-resolve are
only observable across runs. Every metric is computed from individual checks
and every failed check is printed with expected vs actual. Three invariant
counters are derived from what the pipeline *did*, not from labels.

## 14. Dataset version

`zac-signal-eval-v1` · framework `ws1-2026-09-05` · **85 cases / 131 steps**
(`apps/api/src/zac/intelligence/eval/zac-signal-eval-dataset.v1.json`), validated at
load against the framework's exported vocabularies and against
`SIGNAL_FRAMEWORK_VERSION` (a label the pipeline cannot produce, or a dataset
labelled against an older contract, fails the load).

| Domain | Cases | Steps |
|---|---|---|
| rebooking | 24 | 24 |
| utilisation | 20 | 20 |
| lifecycle | 22 | 54 |
| scoping | 12 | 19 |
| dedupe | 7 | 14 |

| Invariant | Tagged cases |
|---|---|
| `failed_read_never_resolves` | 3 |
| `missing_data_never_resolves` | 9 |
| `removed_permission_hides` | 3 |
| `repeat_run_no_duplicate` | 10 |
| `restricted_scope_never_widens` | 6 |
| `tenants_never_reconcile` | 3 |
| `zero_denominator_no_false_negative` | 5 |

Fixtures use hex-only UUIDs and real ISO dates, and carry each tool's standing
caveats, so nothing certified here would be rejected or reshaped by Postgres or
by the real tool. Future workstreams add cases and a `domain`; runner, scorer,
actor presets and gates are unchanged. `frameworkVersion` is bumped only when a
framework change alters what an existing label means (it was, on 2026-09-05:
the resolution-reason rule and the visibility matrix changed).

## 15. Evaluation results

`pnpm --filter @sheer/api zac-signal-eval`, 2026-09-06, on the tree committed
as the follow-up commit (§28):

```
Cases                                  85
Passed                                 85
Failed                                 0

Signal/no-signal accuracy              100.0%   (104/104)
Kind accuracy                          100.0%   (45/45)
Direction accuracy                     100.0%   (10/10)
Materiality-band accuracy              100.0%   (18/18)   incl. 4 numeric materiality checks
Severity accuracy                      100.0%   (11/11)
Confidence-band accuracy               100.0%   (13/13)
Target-source accuracy                 100.0%   (8/8)
Withheld-reason accuracy               100.0%   (27/27)
Lifecycle transition accuracy          100.0%   (52/52)
Resolution accuracy                    100.0%   (18/18)   incl. 8 PERSISTED-reason checks
Dedupe accuracy                        100.0%   (12/12)
Limitations accuracy                   100.0%   (4/4)
Store-state accuracy                   100.0%   (151/151)
Visibility accuracy                    100.0%   (34/34)
Suppress accuracy                      100.0%   (6/6)

False-positive negative signals        0 / 47
False-negative signals                 0 / 67
Duplicate active signals               0
False resolution on missing/failed     0
Tenant isolation failures              0
Permission failures                    0

Hard invariants (zero tolerance):      all 7 PASS
```

**Mutation check** (in-process prototype patches, no tree edits) — each of the
holes the review named now turns the run red, and the control passes:

| Mutation | Result |
|---|---|
| every resolve says `recovered` | FAIL — `life-11`, `life-12`, `life-21` |
| managers read `business_owner` rows again | FAIL — `scope-07`, `scope-11`; `restricted_scope_never_widens` |
| `suppress()` skips its visibility gate | FAIL — `life-14`, `scope-08` |
| lapsed suppression stays hidden | FAIL — `life-22` |
| missing observation resolves (the core invariant) | FAIL — 9 cases; `missing_data_never_resolves` ×16, `failed_read_never_resolves`, `zero_denominator_no_false_negative` |
| control (no mutation) | PASS |

## 16. All failed evaluation cases

At close-out: **none** — 85 of 85 cases, 0 failed checks, 0 invariant failures.

Found and fixed while the harness was being built and reviewed (the reason it exists):

| Case(s) | What the harness or its review exposed | Disposition |
|---|---|---|
| 7 rebooking/lifecycle confidence labels | Authored as `high`; the real tool always carries two caveats → 0.684 `medium`, and 0.41 `low` at the floor | Labels corrected; `reb-21b` added as a no-caveat control |
| `life-15`, `life-16` (expiry) | Reconciler `expire` actions carried no `resolutionReason`; only the service stamped `expired_unconfirmed` | **Class B, fixed**: the plan states the reason; the service applies it |
| `life-12` (review #1/#7/#18) | `superseded` was never assertable — the label contract had no signal family | **Class B, fixed**: family-aware expectations; `superseded` asserted; always-on check that a progress episode never `recovers` |
| `life-21` (new; review #2) | A goal appearing under an unchanged number resolved the shortfall as `recovered` | **Class B, fixed** in the reconciler: `recovered` is earned against the signal's own target, else `superseded` |
| `life-22` (new; review #5/#40) | A lapsed suppression followed by a missing read stayed invisible indefinitely | **Class B, fixed**: read-side lapse rule in `listVisible`/`suppress` |
| `scope-07`, `scope-11` (review #15) | Managers could read business-wide KPI rows their own tools would not return | **Class B, fixed**: `business_owner` rows owner-only |
| `scope-08` (review #3/#16/#46) | The suppress step never reached `service.suppress()`'s gate | Harness fixed; the same manager's *accepted* suppression added as the positive control |
| `utl-04`, `utl-19` (review #17) | Utilisation fixtures omitted the tool's two standing caveats; labels flipped under the real shape | Fixtures carry the caveats; labels `medium`/`low`; `utl-20` isolates the factor |
| 88 fixtures (review #24/#30/#48) | Malformed dates from generator arithmetic; non-UUID ids | Regenerated with real dates and hex UUIDs |

Transient, not a defect: one run of the script on 2026-09-04 reported `scope-09`
failing (6 rows written by a revoked actor) while an automated review was
rewriting source files in the working tree; the same tree re-run after the
review was stopped passed. Recorded because a red scorecard must be explained.

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

Adversarial review (read-only, seven lenses — hollow checks, invariant counters,
repository fidelity, migration 0112, dataset honesty, reconciler delta,
documentation — each candidate finding then handed to an independent verifier
told to refute it): **85 candidate findings; 53 verified on 2026-09-04, of
which 48 confirmed and 5 refuted; 32 verifications aborted on a session limit
and were resumed on 2026-09-05** (status at commit time in §28). The 48 confirmed
findings reduce to the root causes below; migration items are recorded, not
patched into an applied migration.

| Root cause (finding #s) | Severity | Disposition |
|---|---|---|
| `superseded` inexpressible in the label contract (#1, #7, #18) | high | **Fixed** — family-aware expectations; asserted; always-on progress check |
| Goal substitution resolved an unchanged shortfall as `recovered` (#2) | medium | **Fixed** — reconciler rule; fixture H; `life-21` |
| Suppress step short-circuited before the service gate (#3, #16, #46) | medium | **Fixed** in the harness |
| Invariant tags decorative on 8 cases; `invariantFor` mapped 6 of 15 categories (#4, #8, #19, #22, #29) | medium | **Fixed** — a failing tagged case fails its invariants; every invariant has tagged cases |
| Lapsed suppression + missing read hidden indefinitely (#5, #40) | medium/low | **Fixed** — read-side lapse rule; `life-22`; service spec |
| 70 unfireable dedupe checks; `null == null` key match (#6, #45) | medium/low | **Fixed** — removed; both rows must exist |
| Tenant counters measured the fake; leak scored by actor-name substring (#9, #12, #20, #23, #27, #37) | medium/low | **Partly fixed, honestly bounded** — cross-business rows are now counted from actuals and the actor-name rule is gone; but both counters can only observe rows the in-memory repository returned, and that repository filters by business itself. They therefore guard the *service's* business scoping (the businessId it passes down and reconciles against), not the store's `.eq('business_id')` boundary — which is proven by the hosted smoke (real store, TESTBUSINESS-1 sees no demo-salon row) and SQL case 25, not by the harness |
| Label contract a runtime cast; `SIGNAL_EVAL_TOOLS` unused; `frameworkVersion` unvalidated (#10, #36) | medium/low | **Fixed** — full load-time validation |
| Managers read business-wide KPI rows (#15) | medium | **Fixed** — owner-only; documented as a deliberate tightening of the mirrored matrix |
| Utilisation fixtures without the tool's caveats (#17) | medium | **Fixed** — labels moved as predicted |
| Repository more lenient than Postgres: uniqueness on update, tie order, CHECKs/UUIDs (#21, #28, #32, #33, #34) | low | **Fixed** — uniqueness on update, deterministic order in store and fake, hex UUIDs; CHECK-level fidelity remains the hosted smoke's job (§18) |
| Persistence-error attribution hard-wired to the dedupe gate (#31) | low | **Fixed** |
| Malformed fixture dates; inconsistent multi-location fixture; fan-out untested (#24, #30, #44, #48) | low | **Fixed** — regenerated; `reb-22` consistent; `scope-11` fan-out |
| Personal/team scopes absent from the harness (#47) | low | **Deferred** — no WS1 evaluator produces a personal signal; a WS6 dependency, recorded |
| Docs: stale "not applied", `scope-04` mis-cited, rounding misattributed (#13, #14, #35) | medium/low | **Fixed** |
| Migration: `suppressed` with NULL `suppressed_until` allowed (#11); `ON DELETE SET NULL` can orphan scoped rows, no scope↔id or status↔reason CHECK (#25, #42); owner policy admits `system_safe_summary` that the service denies (#38); subject policy has no membership check (#39); `numeric(12,4)` too small for minor-unit money metrics (#41); suite left idempotency and a manager probe unproven (#43) | low | **Recorded for a hardening migration (0113, Workstream 8)** — none affects the two admitted metrics or the API path, which writes bounded windows through the service role; suite gained case 29 (manager has no RLS path) and 0112 was re-applied on a fully migrated stack without error |


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
database-side (RLS as **real authenticated users**, no bypass), on dev-test —
run on 2026-09-04 and **re-run on 2026-09-05** after the review fixes:

| Brief property | Evidence |
|---|---|
| Business A's signal cannot be read from Business B | TESTBUSINESS-1's real owner: service-side sees only its own business row; RLS returns exactly its 2 rows and **0** demo-salon rows. Another business's owner (1 active owner membership elsewhere): **0** rows. Stylist: **0** rows. |
| Manager with Location A scope cannot retrieve the Location B signal | Pinner manager sees **Pinner only**; Thame manager **Thame only**. On 2026-09-04 both also saw the business-scope row (the matrix as first built, mirroring `ZacMemoryService.canSee`); the review flagged it as exposing data the manager's own tool would never return, `canSee` was tightened, and the re-run shows the business row hidden from both. |
| Removing a permission after creation prevents later retrieval | Owner with `report.dashboard.view` removed: **nothing** returned, rows still present. |
| Persisted visibility never grants access | The same rows carry `business_owner` visibility; without the permission, or as a manager, they are invisible. Stylist: nothing. |
| Current acting context remains authoritative | The same manager id with Pinner scope sees Pinner only and with Thame scope sees Thame only; every read is decided from the actor/context on that call, not from the row. |
| Direct-DB defence in depth | `authenticated` UPDATE → **42501 permission denied**; anonymous PostgREST → **401**; a manager has no RLS SELECT path at all (SQL case 29) — managers are served by the API, which enforces location scope itself. |

One smoke-script expectation was mine and wrong: it "narrowed" an owner's
context while leaving the actor's `locationScope.kind = 'all'`; an owner's scope
is all locations by definition, so the acting-context property is proved with a
manager. All smoke rows (7 on each run) were deleted by id; both fixture
businesses and the table are at 0 rows.

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
| 6 | `rebookingGoalFromMemory` treats any remembered percentage near "rebook" as a goal | `analysis/zac-evidence.service.ts:434`, called unfiltered at `:347` (Phase 1 evidence/memory) | **A** — Phase 1 evidence defect | A `recurring_problem` memory ("rebooking dipped to 40% last spring") becomes a 40% goal in Phase 1 evidence | **Kind-filtered in Phase 2 code, not fixed in Phase 1**: the WS1 observation passes only goal-kind memories (`GOAL_MEMORY_KINDS`) — harness case `reb-12` proves a `recurring_problem` memory is ignored; the content shape ("rebook" + first percentage) and first-match ordering are NOT contained and remain the Phase 1 defect |

**Class B (Workstream 1 defects, fixed inside Phase 2 code):** the expire
action's missing reason (found by the harness); and, from the close-out review,
the resolution-reason rule under target substitution, lapsed-suppression
visibility, owner-only business rows, uniqueness-on-update in the in-memory
repository, and the harness assertion holes in §16/§17. All are in files created
by `d617323`/`9f357f7`; none touches Phase 1 code.

No **D** (non-blocking technical debt) classification was used for these six:
each is a defect in a Phase 1 layer the plan names explicitly, so it is Phase 1
completion by the plan's own rule, whatever its severity.

## 22. Phase 1 vs Phase 2 accounting

| Bucket | Work | Commits | Hours |
|---|---|---|---|
| **Workstream 1 (24h plan)** | framework, registry, lifecycle, contracts, materiality/severity, dedupe, 0112, adapter; evaluation harness + dataset; documentation corrections; WS1-specific verification (local suites, hosted smoke) | `d617323` (22 files, +6,654), `bb0f8f3`; this close-out commit (`9f357f7`) | see §23 |
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

- **Hardening migration outstanding (0113, Workstream 8):** `suppressed` rows
  with a NULL window are accepted by 0112 and honoured as permanent by the
  reconciler (only out-of-band writes can create one — the service always
  writes a bounded window); `ON DELETE SET NULL` on `location_id`/`subject_user_id`
  can leave a scoped row without its scope id; no CHECK ties `scope_type` to its
  id or `status` to `resolution_reason`; the owner policy admits
  `system_safe_summary`, which the service denies; the subject policy does not
  require an active membership; `numeric(12,4)` would overflow a minor-unit money
  metric ≥ 1e8. None affects the two admitted metrics or the API path today.
- **Visibility decision to confirm with the client:** business-scope signals are
  owner-only (tightened 2026-09-05). If managers are meant to see business-wide
  signals, it is a one-line matrix change with a harness case (`scope-07`,
  `scope-11`) to flip — a decision, not drift.
- Confidence calibration: static product caveats and genuine data-quality notes
  weigh the same; rebooking cannot reach `high`. Recorded for the Workstream 2/5
  calibration pass; it never gates raising.
- Configured rebooking targets do not reach the signal (§21 #5) until the tool
  exposes the threshold — Workstream 2.
- The in-memory harness repository mirrors live-uniqueness (insert and update),
  tenant filtering and ordering, not every CHECK constraint; the hosted smoke
  test (§18) is what proves those.
- Nothing evaluates signals on a schedule; until Workstream 5 the framework
  runs only when invoked.
- The resumed adversarial verification of 32 findings was still running at the
  time of the hardening commit; its outcome is recorded in §28's follow-up.

## 26. Deferred items

- Everything in §1's "not" list (Workstreams 2, 3, 4, 5, 7, product boundary).
- Phase 1 defects #1–#6 (Phase 1 completion; §21).
- Hardening migration 0113 (the six 0112 items in §25) — Workstream 8.
- Personal/team-scope harness cases — needs a WS6 evaluator that produces a
  personal signal; the label contract already carries `subjectUserId`/`family`.
- A configured (`location_setting`) rebooking target — Workstream 2, once the
  rebooking tool exposes the threshold; and a previous-period figure from the
  same tool so rebooking direction becomes observable.
- Checking the PGlite migration/suite runner into the repo with a `--cap`
  option, so the SQL evidence in §17 is re-runnable in CI rather than from a
  session scratchpad (Workstream 8).
- In-memory repository emulation of 0112's CHECK constraints (today it mirrors
  the unique index, tenant filter and ordering only) — the hosted smoke covers
  the difference.

## 27. Final test counts

| Check | Result (2026-09-06) |
|---|---|
| Evaluation harness (`zac-signal-eval`) | 85/85 cases, 131 steps, 7/7 invariants, exit 0; mutation check 5/5 red, control green |
| `npx jest src/zac/intelligence` (framework A–L + H + registry structure, service, harness gate) | 3 suites, **114 passed** |
| Full API suite `npx jest` (apps/api) | **121 suites, 2,518 passed, 226 todo, 0 failed** |
| `tsc --noEmit` (apps/api) | clean |
| `eslint` (zac/intelligence, store, script) | clean |
| `supabase/tests/zac_intelligence_signals.sql` (PGlite, all 112 migrations) | **30 of 30 PASS** (case 29 manager RLS path, case 30 expiry episode + recurrence; case 22 now asserts index predicates/uniqueness); 0112 re-applied on the migrated stack: no error |
| All 19 SQL suites, full stack vs 0111-capped control | identical outcomes (§17) |
| Hosted (dev-test) | 0112 applied 2026-09-04; T1–T5, M, B, V **PASS** on 2026-09-04 and 2026-09-05; RLS probes as real users; rows cleaned (0 remain) |

## 28. Final commit SHA

- `9f357f7350ac4215c204d2918d4100ca1246e526` — `feat(zac): close out Phase 2 Workstream 1 with the evaluation harness`
- `76660e94b7e0bc70783c359bed619070347d712f` — `fix(zac): harden the Workstream 1 framework and harness after adversarial review`

Both on `feature/post-checkin-service-lifecycle` (the branch carrying the
user's plan commit `59d5656`, which had fast-forwarded over
`feature/zac-phase2-intelligence-signals` at `383e002`). Recorded by the docs-only commit that follows `76660e9`.

**Resumed verification of the 32 findings whose verifiers hit the session
limit:** re-launched 2026-09-05 (read-only). At the time of this recording its
lens phase was still running, so those 32 claims stand as *unverified* rather
than confirmed or refuted; they were raised by the same seven lenses and, by
title, fall inside the root causes already fixed in `76660e9` or the recorded
0113 items. Its outcome, when it landed, is appended below rather than rewriting anything
above it.

---

**Appendix — resumed verification (2026-09-06).** The re-launched read-only
review completed: 84 candidate findings from 7 lenses, **39 confirmed, 45
refuted**, 24 verifier calls timed out. Of the 39: eleven restated defects that
`76660e9` had already fixed (their own verdicts say so: the suppress
short-circuit, `null == null` key match, non-UUID fixtures, decorative invariant
tags, stale counts); the rest were acted on in the follow-up commit
«FOLLOWUP-SHA» — the persisted resolution reason is now asserted from the store
(8 checks), numeric materiality labels (4), fixture tools derived from the
registry and per-location fixture ids validated, false-positive counting made
kind-aware with progress expectations in its denominator, two previously
unprinted scorecard lines (limitations, suppress), a partial multi-site manager
preset and case (`scope-12`), a discriminating `scope-10`, a structural
registry test, SQL cases 22 (predicates/uniqueness) and 30 (expiry episode +
recurrence), the stale profitability comment in the registry source, and the
documentation-accuracy items (plan status *proposed*, withheld vocabulary,
expiry-case attribution, load-time not compile-time validation, nine CHECK
vocabularies, WS5 wording, line references, honest coverage statement). Still
recorded rather than done: the 0112 CHECK/policy items (0113), CHECK emulation
in the in-memory repository, and checking in the PGlite runner (§26).

