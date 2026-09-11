# ZAC Phase 2 — Workstream 3 (QLab & Stock) — Close-out Report

> **Status:** engineering complete, backend only (`apps/api`). No web change was required — see §7.
> **Authoritative scope reference:** `ZAC_Phase_2_Incremental_Plan_UPDATED.pdf`, Workstream 3 (46 h).
> **Companion:** [`phase-2-ws3-data-evidence.md`](phase-2-ws3-data-evidence.md) — the W1 evidence pass every
> default, threshold and cap in this workstream is justified from.
> **Date:** 2026-09-11 · **Branch:** `develop`

---

## 1. What Workstream 3 delivers

The authoritative plan's WS3 line, and where each clause landed:

| Clause | Delivered as | Reads |
|---|---|---|
| Colour / waste / margin analytics | `qlab.colour_analytics` | `LabAnalyticsService.summary` |
| Stock risk, shortage, dead-stock intelligence | `inventory.stock_status` | `InventoryService.listStock` / `listDeadStock` / `listLowStock` / `listMovements` |
| Planned appointment / stock correlation | `inventory.colour_prep_risk` | `ColourPrepService.getPlan` |
| Production-safe permissions **and tests** | ports, projectors, boundary sweep, 61 new tool tests | — |
| *(client decision, 2026-09-11)* order-recommendation context | `inventory.reorder_advisory` | `OrdersService.previewReorder` (**new, read-only**) |

**Nothing is recomputed.** Every figure comes from the guarded QLOOQO service that already owns it, called
with the resolved actor. The client plan's rule — *"QLOOQO 10 must remain the source of truth; ZAC should not
introduce competing formulas"* — is honoured structurally: ZAC has no second implementation of colour margin,
dead-stock classification, colour-prep requirements or reorder arithmetic.

---

## 2. The decisive finding: the data is thin, and that is the engineering work

Of 11 businesses on the working database, **two** have any saved colour formula and **one** has meaningful
stock. Every headline percentage WS3 could compute is empty, stale, or an artefact of configuration:

- **Colour waste has no numerator anywhere.** All 20 `lab.formula_items` record `waste_grams = 0` and
  `waste_cost_cents = 0`; `inventory.waste_events` holds 0 rows and is SELECTed nowhere in the platform.
- **One tenant's colour margin is `0/0`** — four saved formulas with neither charge nor cost.
- **The stock ledger's newest entry is 2026-08-26**, and the newest costed formula is 2026-07-21 (52 days
  before this report).
- **6 of 6 Kensington products read as dead stock** — against a 30-day threshold *that location deliberately
  set*, where the platform default is 90.

Under naive arithmetic each of those renders as a confident, wrong, plausible number: "0% waste" tells an
owner they run a perfect colour bar; "0% margin" fabricates a trading result; "75% of your stock is dead"
reads as a purchasing failure rather than a threshold choice.

So the first three subtasks built firewalls, before any tool existed:

**`ZacCoverageReading`** ([`coverage/zac-coverage.ts`](../../apps/api/src/zac/tools/coverage/zac-coverage.ts))
is the only route from two numbers to a rendered figure, and its constructors demand the denominator, the
sample unit and an as-of timestamp. A zero denominator yields `zero_denominator`, whose value is `null` and
whose `limitationsFor()` says why. The boundary sweep fails any WS3 tool containing bare percentage
arithmetic, so there is no way around it.

**Feasibility probes** ([`coverage/zac-feasibility-probe.ts`](../../apps/api/src/zac/tools/coverage/zac-feasibility-probe.ts))
run *before* every reporting read and branch the answer four ways — `ready`, `not_configured`, `stale`,
`unreadable`. The colour probe runs a second 365-day baseline read alongside the window, which is what lets
"no colour work in 90 days" be reported as **staleness** rather than **absence**; without it the two are
indistinguishable and need opposite answers.

**Result:** on this data ZAC produces four true, useful, non-zero answers — and the configuration findings
behind them are genuinely actionable. No data was seeded to make any of it look busier.

---

## 3. The read-only boundary, in five independent layers

Phase 2 is read-only and human-led. WS3 is the first workstream to read services whose surface is mostly
*writes* — `InventoryService` has 14, `OrdersService` 5, one of which allocates a gapless purchase-order
number **and emails a supplier**. Convention is not a boundary when the write is one autocomplete away.

1. **Type-level ports.** [`ports/zac-service-ports.ts`](../../apps/api/src/zac/tools/ports/zac-service-ports.ts)
   narrows each service to a `Pick<>` of its reads. `generate`, `submit`, `send`, `adjustStock`,
   `recordConsumption` and the rest are not members, so calling one is a **compile error**. The registry
   injects the full provider and narrows once, at a single reviewable boundary.
2. **PII projectors**, in the same file, whose *return types* have no `hourlyRate`, `contractedHours`,
   `averageBillBenchmark`, `stylistName`, `clientName` or `createdByName`. There is deliberately **no stylist
   projector at all**. (`ZacReadOnlyTool.sensitiveFields` strips nothing — its own doc comment says so — so
   masking has to be executable code. This makes it a type error instead.)
3. **A source sweep**, [`zac-ws3-boundary.spec.ts`](../../apps/api/src/zac/tools/zac-ws3-boundary.spec.ts):
   42 assertions over every WS3 tool file for write methods, write RPCs, PostgREST verbs, a self-opened
   Supabase client, `waste_events`, pay/identity fields, `plan.appointments`, and inline percentage
   arithmetic — with a strict completeness check so it cannot pass on a partial scan. **Mutation-verified:**
   adding `s.adjustStock({})` to a tool turns it red.
4. **A separate, differently-named read method.** `previewReorder` is *not* a `dryRun` flag on `generate()` —
   a boolean separating "tell me" from "do it", on a method named for doing it, is one default-argument
   change from ZAC creating real orders. Its firewall spec asserts no insert/update/upsert/delete, only the
   `reorder_usage` RPC and never `create_purchase_order`, no audit row and no email.
5. **Output vocabulary.** Every reorder answer is framed as a recommendation and closes by handing the act
   back to a person; a negative regex forbids any claim of having ordered, placed, created, submitted,
   approved or sent.

Upstream of all of it, the request-mode classifier still refuses imperative write requests before any tool is
chosen. WS3 added one verb to that list — see §5.

---

## 4. Reachability — the part that fails silently

A tool that dispatches correctly but is never *chosen* is invisible, and nothing errors to say so. Twelve
enumeration sites were edited; none of them is a compile error:

| Site | Consequence of omission |
|---|---|
| `TOOL_DESCRIPTORS` (`zac-tool-planner.service.ts`) | `catalogueFor` filters on presence — the tool can never be planned |
| `resolveIntent` (`zac.service.ts`) | — see below |
| `PERIOD_AWARE_TOOLS` (`zac.service.ts`) | "colour margin last month" silently answers on the default window |
| `ZacDataDomain` (`zac-analysis.types.ts`) | domain-scoped planning cannot address it |
| `ZacEvidenceService.normalise` | tool runs perfectly and contributes **zero** signals |
| `ISSUE_DOMAIN` / `ISSUE_TITLE` (`zac-priority.service.ts`) | findings rank as `other` with a raw metric name |
| `ZacPriorityDomain` + `ZAC_PRIORITY_DOMAINS` | as above |
| `TOOL_AREA` (`zac-orchestrator.service.ts`) | a failure reads "one area could not be assessed" |
| `TOOL_AREA_LABELS` (`zac-response-builder.service.ts`) | permission explainability names the tool id |
| `CAPABILITY_LINES` + `PLANNED_AREAS` (`zac-capability-summary.tool.ts`) | ZAC keeps advertising the capability as coming |
| `isMeaningfulOutput` (`zac-measurement.service.ts`) | no `zac.outputs` row, no feedback, no attribution |
| `ZacToolName` union (`zac-tool.types.ts`) | the only one the compiler catches |

**The one that would have been a silent wrong answer:** `resolveIntent`'s profit branch matches a bare
`\bmargins?\b` and returns the **disabled** `report.profitability`. Without placing the colour branch above
it, *"what is my colour margin?"* answers "not connected" — while a tool that can answer it sits registered
and live. That ordering is pinned by a test, alongside the inverse guard that a plain profit question still
reaches profitability and a retail question still reaches retail.

**Measurement decision (client-approved).** `isMeaningfulOutput` was widened from
`/^(report|kpi|schedule)\./` to include `qlab|inventory`. Without it every WS3 answer would persist no output
row and support no feedback — making the newest and most demonstrable answers the only unmeasured ones. The
alternative, renaming the tools into `report.*` to slip past the regex, was rejected: it would break the
meaning of the domain segment for the sake of a pattern match.

---

## 5. Changes made outside `apps/api/src/zac`

Kept to the minimum, and each was forced:

| File | Change | Why it was unavoidable |
|---|---|---|
| `inventory/inventory.module.ts` | added `exports: [InventoryService]` | Nest does not share providers via `AppModule`; without it the registry cannot be constructed and the API fails to boot |
| `lab-analytics/lab-analytics.module.ts` | added `exports: [LabAnalyticsService]` | same |
| `orders/orders.service.ts` | extracted `computeReorderSuggestions`; added `previewReorder` | there was **no pure read path** to the reorder algorithm at all |
| `orders/reorder-preview.types.ts` | new | the read-only return contract |
| `policy/zac-resource-category.service.ts` | added `place` to `WEAK_WRITE_VERB` | see below |

**On the `place` verb.** The clause check inspects only the first two words, so *"order this stock"* was
refused as a write request while *"place the order with Wella"* (opening `place the`) matched neither verb
list and was not. That gap pre-dates WS3, but WS3 makes "place the order" a far likelier phrasing than it has
ever been, so the two must behave the same. `place` was added to the **weak** list — a write only when an
operational object is present — and the interrogative guard already skips *"where does she place…"*. The
reason-eval, which asserts `falseBoundaries` is empty, passes unchanged.

`OrdersService.generate` is **behaviour-identical**: its computation moved into a shared private method that
both it and `previewReorder` call, so ZAC's advice is bit-identical to the draft the Generate button
produces. All 34 pre-existing orders tests pass untouched.

---

## 6. Metric-registry probe — a documented negative (W15)

`phase-2-intelligence-signal-framework.md:940` assigns "QLAB and stock metrics + evaluators" to Workstream 3,
qualified *"(probe-gated on V1.1 stability)"*. **This is that probe, and it returns a negative.** No metric is
registered in the WS1 intelligence framework. Criterion by criterion:

| Candidate | Verdict | Evidence |
|---|---|---|
| `colour_waste_rate` | ❌ no numerator | all 20 `formula_items` record zero waste; `waste_events` empty and unread |
| `colour_margin_rate` | ❌ no target with provenance | 16.7% is real at one location, but QLOOQO records no colour-margin benchmark to compare against |
| `dead_stock_share` | ❌ coverage + the verdict is a setting | only 6/10 products carry a cost; 6-of-6 dead is a function of a 30-day threshold |
| `stock_cover_days` | ❌ unit does not exist | `ZacMetricUnit` is `'percent'` only; `ZacSignalScope` has no product dimension |

Registering any of them would mint **confident zeros** — and because `zero` counts as *positive* evidence in
the reconciler, it would silently **resolve** live signals from other sources. WS3 publishes this assessment
instead, which is what the framework's own probe-gating language asks for.

WS3 does contribute to the **Phase 1 priority engine** via evidence adapters (four new issue keys:
`stock_shortage`, `dead_stock`, `colour_prep_shortfall`, `colour_margin`), so QLab and stock findings can
surface in "what should I focus on?". Each adapter returns `[]` rather than a signal whenever its reading is
not `measured`, so an unmeasured period can never mint a positive signal that reads as good news.

---

## 7. Web (`apps/web`) — no change required

The ZAC console and chat widget are **fully generic over tools and domains**: they render `answer`,
`evidence`, `confidence`, `limitations`, `suggestedNextStep` and the routing inspector without per-tool
branching. All four WS3 tools surface through the existing UI with no front-end work.

Two pre-existing web limitations are recorded as follow-ups, neither blocking:

- `ZacAnswer` strips anchors as a phishing defence (locked by a regression test), so a path in an answer
  renders as inert text. A clickable "open Purchase orders" CTA would need a new structured response field
  and an allow-listed internal-path renderer.
- Neither ZAC surface sends the sidebar location picker's `locationId`, although `askZac` and
  `ZacAskRequestDto` both already accept one — so a WS3 answer is business-wide unless the question names a
  location.

---

## 8. Verification

| Check | Result |
|---|---|
| `pnpm --filter @sheer/api typecheck` | clean |
| `pnpm --filter @sheer/api lint` | **0 errors**, 6 warnings (all pre-existing, none in WS3 files) |
| `pnpm --filter @sheer/api exec jest` | **134 suites, 2 839 passed, 0 failed** (226 pre-existing todo) |
| WS3 boundary sweep | 42 assertions, mutation-verified red on a real violation |
| `previewReorder` firewall | 18 assertions: no write verb, no `create_purchase_order`, no audit, no email |
| Routing | 15 WS3 cases + 2 regression guards + 4 imperative-write refusals |
| Read-only boundary (reason-eval) | unchanged; `falseBoundaries` still empty after the `place` addition |

**New tests added:** 133 (42 boundary, 27 coverage, 17 probe, 18 preview-reorder, 18 colour, 14 stock,
13 colour-prep, 16 reorder advisory, 21 routing/refusal — some counted in more than one suite).

### Not verified

- **Production schema parity.** Every figure in the evidence pass describes the `dev-test` branch
  (`iqgryrczkvjkcbrgfsdl`). The defaults chosen here are justified by *that* data, so the same pass must be
  re-run against production before UAT.
- **No live end-to-end call** was made against a running API; the tools are covered by unit tests against
  hand-rolled service doubles, per the house convention.

---

## 9. Explicitly out of scope

| Deferred | Reason |
|---|---|
| An `inventory.view` read-only permission key | The gate is inside `InventoryService.assertManagerOrOwner`, not merely on the controller, so a weaker tool declaration would be cosmetic. Introducing one touches the `Permission` union, `PERMISSION_CATALOG`, `ALL_PERMISSIONS`, `DEFAULT_ROLE_PERMISSIONS`, a seed migration (the 0074 rule) **and** the service's own assertion — a permission-model change inside a read-only phase. Own CR. |
| Registering any QLab/stock metric | §6 — the probe returns a negative on today's data. |
| Repairing `inventory.low_stock_alerts` | The materialised cache provably lags the live computation (3 vs 2 rows). WS3 **reports** the divergence; fixing it is a write. |
| Stylist-attributed colour margin | `byStylist` carries pay data under a reporting key with no payroll permission in the path. |
| Expiry, shelf-life, batch tracking, over-ordering detection | No backing data model exists. The Phase 1 feasibility report's class C/D judgement on these still stands. |
| Forecasting beyond the location's configured coverage window | The reorder forecast is trailing outbound usage × coverage weeks. Anything more would be an invented model — and on this data the usage term contributes exactly zero. |
| Clickable deep links from an answer | §7 — a web change. |

---

## 10. Recommended next decision

Workstream 3 is ready for the Week 3 demo. Demo against business `b793790e` (**Salon**, 5 locations) with the
90-day colour default: it is the only tenant with real costed colour, it has a live colour-prep appointment at
Kensington on 2026-09-17 with resolved product requirements, and two genuine reorder suggestions at Pinner and
Primrose Hill.

Lead with the honesty, not around it. On this data the four answers are:

> **Colour** — £126.62 charged against £105.51 of product across 5 formulas, a 16.7% gross margin; waste is
> not being captured when formulas are saved, so that figure is withheld rather than reported as zero.
>
> **Stock** — 3 products at or below threshold, 2 of them at zero; 6 idle past a 30-day threshold Kensington
> set itself; the ledger's newest entry is 26 August.
>
> **Colour prep** — the 17 September appointment is covered; the 15 September one cannot be assessed because
> no formula is on file.
>
> **Ordering** — 2 packs of SoColor 8N at Pinner and 2 of Majirel 6.0 at Primrose Hill, both threshold
> top-ups with no recorded usage behind them; 8 of 10 products have no supplier attached, which is the real
> finding.

That last clause in each is the product. A competitor's assistant reports the number; this one reports what
the number is worth.
