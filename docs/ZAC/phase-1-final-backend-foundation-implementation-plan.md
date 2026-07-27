# ZAC Phase 1 Final Backend Foundation Implementation Plan

> **Status: the definitive, build-ready backend plan for ZAC Phase 1.** Consolidates the four prior analysis documents into one source of truth. **Documentation only** — creates no source code, migrations, env, or package changes, and stages/commits nothing.
>
> **Consolidates:** [`phase-1-backend-foundation-architecture-analysis.md`](phase-1-backend-foundation-architecture-analysis.md) (code-grounded repo analysis) · [`phase-1-backend-foundation-technical-approach.md`](phase-1-backend-foundation-technical-approach.md) (concrete solution) · [`phase-1-week-1-backend-foundation-task-breakdown.md`](phase-1-week-1-backend-foundation-task-breakdown.md) (Wrike-ready tasks) · [`phase-1-qlab-stock-feasibility-report.md`](phase-1-qlab-stock-feasibility-report.md) (QLAB/stock go/no-go). `phase-1-mvp-implementation-plan.md` does not exist. Anchored to the Phase 0 decision set (D1–D53, QC1–QC8).
>
> Date: 2026-07-24 · Phase 1 is **read-only** end-to-end. No write tools, no unrestricted DB access, no autonomous actions.
>
> ⚠️ **Migration numbering:** the parallel payroll work currently holds `0071`–`0075`, and more may land. This plan uses **`NNNN`** for ZAC migrations — **take the actual next-free number at authoring time.** No ZAC migration is applied in Week 1 (authored for review only).

---

## 1. Approved Backend Goal

Build the **first safe server-side foundation** for ZAC inside QLOOQO — not the full agent. It is a role-aware, permission-aware, evidence-grounded **read-only** intelligence layer that:

- authenticates as the **acting user's JWT** and can see **only** what that user could already see through the normal API;
- registers **zero write tools** (read-only is structural, not prompt-based);
- **narrates** numbers from QLOOQO's deterministic engines — never invents or recomputes them;
- captures the **measurement + cost spine from day one** (unrecoverable if not captured);
- ships **behind a feature flag**, web-only, **without disrupting the V1.1 (or payroll) roadmap**.

Phase 1 proves **trust before autonomy**.

---

## 2. Confirmed Scope Boundary

**In scope (Week 1 = design + skeleton):** `apps/api/src/zac/` module; `POST /zac/ask` + request/response contract; acting-user context resolver; role profile selector (Owner/Manager/Stylist); permission-aware tool registry skeleton; provider-agnostic model router (first provider = latest Claude) + a stub provider; evidence-grounded response builder; memory/outcome/cost telemetry design; ZAC table plan (authored for review, not applied); QLAB/stock feasibility pass.

**Out of scope (deferred):** any write tool or business mutation; autonomous actions; WhatsApp/SMS/voice/phone channels; full RAG/vector retrieval; full Value-Created ROI automation; advanced QLAB/stock prediction, ordering forecasts, over-ordering detection, stock-holding optimisation, automated ordering, supplier workflows; the stylist mobile surface; the lab (PIN-session) app; a durable scheduler / periodic snapshot job / attribution reconciler runtime; per-tenant enablement store; polished UI.

---

## 3. Repository Architecture Findings

The load-bearing, code-verified facts that shape every decision below:

1. **NestJS 10 monorepo, uniform module shape.** `module → controller → service → dto`, ~38 feature modules registered in `app.module.ts`. `nest-cli.json` auto-compiles `src/zac/` — no build-config change. **`apps/api/src/zac/` confirmed** (D1/QC1).
2. **No JWT/RLS data path.** All ~38 services open their own `SUPABASE_SERVICE_ROLE_KEY` client and enforce tenant/location scope in **application TypeScript**. RLS exists but is **enabled-not-forced** and keyed on `auth.uid()` (null under service-role) → **the database provides no tenant backstop.** → ZAC **never opens its own reasoning-read DB client**; it composes the guarded services with the resolved `AuthUser`.
3. **Services re-check role + location but NOT the permission key** (that is controller-guard-only). → **every ZAC tool must independently re-check the exact permission its endpoint requires** (`userHasAllPermissions`). This is the single most important tool-safety rule.
4. **`AuthUser` shape** (`packages/domain/src/index.ts:154-199`): `id` (not `userId`), `roles[]`, `primaryRole`, `businessId` (`''` = salon-less → reject), `businessTier`, `allowedLocationIds`, `locationScope`, `staffProfileId?`, `permissions`, `timezone`. **There is no single "active location"** — a set + `locationScope.kind`.
5. **Global logging middleware dumps full request/response bodies** to stdout, redacting only 8 fixed auth key-names → **ZAC prompts/answers (PII) would leak**. Must exclude/redact ZAC routes **before the first endpoint ships** (D32).
6. **Owners auto-resolve `[...ALL_PERMISSIONS]`** → the instant `zac.access` enters the catalogue every owner holds it → **a feature flag, not the permission, is the dark switch.**
7. **Deterministic KPI engine** (`kpi.calc.ts`) — arithmetic in code, never the DB or an LLM. **Utilisation has no server endpoint** (browser-only) → build-work, not a wrapper.
8. **Migration numbering churn** — payroll holds `0071`–`0075`; ZAC migrations are `NNNN` (next-free at authoring time), authored for review only.

---

## 4. Backend Module Structure

At `apps/api/src/zac/` (register `ZacModule` in `app.module.ts`; gate the controller behind `ZAC_ENABLED`). Follows house conventions; sub-folders are a justified deviation for ZAC's scope.

```
apps/api/src/zac/
  zac.module.ts        // imports: [AuthModule, KpiModule, DashboardModule*, CrmModule,
                       //           LabAnalyticsModule, InventoryModule, RotaModule]
  zac.controller.ts    // @Controller('zac') + 3-guard chain + @RequirePermissions('zac.access')
  zac.service.ts       // orchestrator; NO service-role client for reads
  dto/                 // zac-ask-request/response, zac-feedback
  context/             // zac-context.service (assembler), scope-resolver, zac-context.types
  roles/               // zac-role-profile.service + types
  tools/               // zac-tool-registry.service, zac-tool.types, tools/*.tool.ts
  models/              // zac-model-provider.interface, zac-model-router, providers/{anthropic,stub}, pricing.config
  responses/           // zac-response-builder.service + zac-response.types
  memory/              // zac-memory.service + types
  measurement/         // zac-output-logger, zac-cost-telemetry, zac-outcome-event
  prompts/             // constitution-policy, {owner,manager,stylist}.profile
  qlab/                // qlab-feasibility.service (Week-1 probe)
  zac.service.spec.ts
```
`*` `DashboardService` needs a one-line `exports:` add if injected (`KpiService`/`CrmService`/`LabAnalyticsService`/`InventoryService`/`RotaService` are already exported).

Shared cross-app types (the `zac.access` key, response contract) live in `@sheer/domain` (rebuild dist after editing).

---

## 5. API Endpoint Plan

All under the global `api` prefix; guard chain `SupabaseAuthGuard, RolesGuard, PermissionsGuard` + class `@RequireRoles('owner','manager')` + `@RequirePermissions('zac.access')`; behind `ZAC_ENABLED`. Only ZAC's own telemetry/feedback tables are written — no business writes.

| Method + path | Phase 1 | Purpose |
|---|---|---|
| `POST /zac/ask` | **Required** | Main Q&A. `{ question(@MaxLength), conversationId?, requestSource?, locationId? }` → the evidence-grounded response contract. Creates conversation/message, logs spine + cost events. |
| `POST /zac/feedback` | **Required** | "Did this help?" (D24) → `zac.feedback`. A learning signal, not a business write. |
| `GET /zac/health` | **Required** | Subsystem liveness (provider reachable, flag state). No model call. |
| `GET /zac/conversations(/:id)` | Optional | The actor's own history (business + `actor_user_id` scoped). |
| `GET /zac/suggested-prompts` | Optional | Role-appropriate starters + capability probe for the UI. |

Stylist-facing endpoints are deferred with the stylist mobile surface.

---

## 6. Acting-User Context Plan

`ZacContextService` maps the guard-resolved `AuthUser` to `ZacActingContext`; ZAC never re-derives identity.

| Field | Source | Note |
|---|---|---|
| `actor_user_id` | `AuthUser.id` | **`id`, not `userId`** |
| `business_id` | `AuthUser.businessId` | `''` ⇒ **reject** |
| `location_id` | request `locationId?` validated vs scope | **no single active location** — default to the accessible set and state what was aggregated |
| `role` / `roles[]` | `AuthUser.primaryRole` / `roles` | gate on `roles[]`, not one role |
| `permissions` | `AuthUser.permissions` | effective, expanded |
| `accessible_location_ids` | `AuthUser.allowedLocationIds` | owner = all; else membership union |
| `feature_flags` | env/flag layer | `ZAC_ENABLED`; no per-tenant store in Phase 1 |
| `request_source` | request/header | `web_dashboard` default |
| `timezone` | `AuthUser.timezone` | for KPI windows |
| `locale` | default `en-GB` | `AuthUser` has no locale (small gap) |

Resolve once at the controller boundary and thread through the turn (avoid per-tool re-auth cost).

---

## 7. Permission and Tool Access Plan

- **`zac.access` gates the feature only** — add to the `Permission` union + `PERMISSION_CATALOG` (`packages/domain/src/index.ts`), `DEFAULT_ROLE_PERMISSIONS` (owner+manager), `SYSTEM_SECURITY_LEVELS`; a data migration `NNNN` back-patches existing DB `core.security_levels` rows (modelled on `0057`/`0058`); rebuild `@sheer/domain` dist. **Owners auto-hold it → the feature flag is the dark switch.**
- **`zac.access` never overrides underlying permissions.** Effective visibility = `zac.access` **AND** the user's own per-report permission.
- **Every tool re-checks its own permission** at dispatch (closes the service-layer gap) and re-asserts `zac.access`.
- **No write tools registered** — read-only is structural.

**Tool–permission matrix:**

| Tool | Owner | Manager | Stylist | Underlying permission |
|---|---|---|---|---|
| Business Health | ✅ | ✅ (loc) | ❌ | `report.dashboard.view` (+`report.lab_analytics.view` optional) |
| KPI Summary | ✅ | ✅ | ❌ | `report.commission.view` **or** `report.performance.view` (strip commission w/o the former) |
| Rebooking Summary | ✅ | ✅ | ❌ | `report.dashboard.view` |
| Utilisation Summary | ⚠️ | ⚠️ | ❌ | `report.performance.view` — **disabled (no endpoint)** |
| Stylist Performance | ✅ | ✅ (loc) | ❌ | `report.performance.view` (strip commission/pay per permission) |
| Personal Coaching | ❌ | ❌ | ✅ (self) | none `report.*` — **deferred surface** |
| QLAB colour / stock | ✅ | ✅ (loc) | ❌ | `report.lab_analytics.view` / `inventory.manage` — **Week 2/3, probe-gated** |

Grant defaults: **owner + manager**, **not stylist** (their defaults have no `report.*`), **never client**.

---

## 8. Core Read-Only Tool Plan

Tools are typed contracts (14 fields, `read_only:true`, `error_behavior:fail_closed`, `fallback_behavior:state_unavailable`); each wraps an existing guarded service with the acting `AuthUser`, re-checks its permission, and returns pre-computed numbers as evidence. **The model narrates; it never computes.**

| Tool | Wraps | Notes |
|---|---|---|
| **BusinessHealthSummary** | `DashboardService.kpis` (+ `LabAnalyticsService.summary`) | "revenue & activity health", **not P&L** (no cost/profit line exists) |
| **KpiSummary** | `KpiService.stylistList` | strip commission unless `report.commission.view` |
| **StylistPerformance** | `DashboardService.stylistPerformance` | strip pay unless `staff.pay.manage`; present computed target (stored target unused) |
| **RebookingSummary** | dashboard/KPI reducers over `rebook_source` | `no_show` ≈ 0 (never written); rebooking is a lower bound |
| **UtilisationSummary** | `computeDailyUtilisation` (**no endpoint**) | **registered disabled** — build-work Week 2/3 |
| **PersonalCoaching** | `KpiService.myKpi` | own-data only; deferred surface |

**Connect first:** `DashboardService` (Business Health, Rebooking) and `KpiService` (KPI Summary, Stylist Performance) — the richest, most stable, deterministic fuel.

---

## 9. QLAB / Stock Feasibility and Foundation Plan

**Verdict:** QLOOQO has a solid applied **colour + stock-deduction** model but **no purchasing/forecasting/expiry model** (grep-confirmed: no supplier/PO/reorder/lead-time/expiry/shelf-life fields anywhere).

- **Week 1 = feasibility-only** (`QlabFeasibilityService`): confirm applied schema + **prod parity (QC8)**; run a **data-population probe** (saved formulas? initialised stock + thresholds? retail rows — expect none). No user-facing tool.
- **Week 2/3 = at most two probe-gated read tools:** `QlabColourWasteSummaryTool` → `LabAnalyticsService.summary` (`report.lab_analytics.view`; waste from `formulas.waste_cost_cents`, **never** the write-only `waste_events`; immune to un-applied `0063` draft work); `LowStockItemsTool`/`StockVisibilitySummaryTool` → `DashboardService.inventoryAlerts` (live) / `InventoryService.listLowStock/listStock` (`inventory.manage`/`report.dashboard.view`). Optional: fast/slow-moving (descriptive derivation over `stock_movements`).
- **Deferred (no data model):** expiry, run-out prediction, over-ordering, stock-holding optimisation, predicted/automated ordering, supplier workflows, retail insights (`retail_sales` empty/no writer), formula notes/versions/drafts (in-flight `0063/0068/0069`).
- **Estimate impact:** the two safe tools wrap stable services → **no change to the 3-week estimate**; anything predictive/ordering would blow it (net-new schema).

---

## 10. Memory, Outcome and Cost Telemetry Plan

- **Memory (foundation only):** Business Memory (survives with business) vs Personal Memory (moves with individual). Scopes: `user_private`, `business_owner`, `manager_team_theme`, `stylist_private`, `system_safe_summary`. Every row carries `business_id`, `created_by`, `source`, `visibility_scope`; deletable/reviewable. **Store redacted summaries/refs, not raw content by default (D32).** **Private stylist coaching notes** live in a table with **no owner/manager read path**; owners/managers get aggregate themes only (D25/D26/D41/D42).
- **Measurement spine (from the first interaction — unrecoverable if skipped):** `conversation_started`, `question_asked`, `answer_delivered`, `source_used`, `recommendation_created/shown/accepted/dismissed/ignored`, `kpi_snapshot_created`, `observed_outcome_recorded`, `cost_recorded`. Fail-soft writer **with alerting**, separate from `audit.activity_log` (D27).
- **Outcome / Value (logging foundation only):** Observed / Influenced / Directly Attributable (Day 4 decision tree); reuse existing hooks **read-only** (`rebooking_outcomes.rebook_source`, `appointments.booking_channel`) — do not write them (CHECK excludes `'zac'`; `'api'` taken). Value computation deferred.
- **Cost telemetry (every model call):** provider, model, task_type, role_context, input/output/reasoning tokens, estimated_cost (config constants — no hardcoded prices), latency, tool_calls, cache_hit (per-tenant only), business_id, actor_user_id, conversation_id. Fast-tier default, per-tenant budgets, escalation logging.

---

## 11. Supabase / ZAC Table Plan

- **Dedicated `zac` schema, RLS ENABLED + FORCED** (stronger than the dormant platform RLS); `public.zac_*` prefixed tables are the fallback. Add `zac` to `config.toml` + each project's Exposed Schemas (else `PGRST106`).
- **Common columns:** `business_id not null`, `location_id?`, `actor_user_id`, `role_context`, `visibility_scope`, timestamps.
- **Tables:** `conversations`, `messages` (+`message_events`), `tool_calls`, `memory`, `stylist_coaching_notes` (no owner/manager SELECT), `recommendations` + `recommendation_events`, `feedback`, `observed_outcomes` + `recommendation_outcomes`, `cost_events`, `kpi_snapshots` (design).
- **Migrations:** `NNNN_zac_access_permission.sql` + `NNNN_zac_foundation.sql` (next-free numbers — payroll holds `0071`–`0075`), **file-based, never via MCP DDL, authored for review, NOT applied in Week 1.**

---

## 12. Week 1 Implementation Tasks

Full detail (Goal / Files / Dependencies / Acceptance / Hours) is in the [task breakdown](phase-1-week-1-backend-foundation-task-breakdown.md). Summary:

| ID | Task | Owner | Day | Risk |
|---|---|---|---|---|
| A | Repository/module confirmation (+ prod parity) | Cosan | 1 | Low |
| B | ZAC module skeleton | Oleksandr | 1 | Low |
| C | Ask endpoint contract | Joint | 1 | Low |
| D | Acting-user context resolver | Cosan | 1 | Med |
| E | Role profile selector | Oleksandr | 2 | Low |
| P | `zac.access` permission review | Cosan | 2 | Med |
| F | Permission-aware tool registry skeleton | Joint | 2 | Med |
| G | Read-only tool base interface | Oleksandr | 2 | Low |
| H | Model provider abstraction (+ stub) | Oleksandr | 3 | Med |
| I | Response builder contract | Oleksandr | 3 | Low |
| J | Evidence/confidence/limitations format | Oleksandr | 3 | Low |
| K | Memory item contract | Oleksandr | 4 | Med |
| L | Output/insight logging contract | Oleksandr | 4 | Low |
| M | Outcome event contract | Oleksandr | 4 | Med |
| N | Cost telemetry contract | Oleksandr | 4 | Low |
| O | Supabase/table design review (NNNN, not applied) | Cosan | 4 | High |
| Q | Stable reporting/KPI service mapping | Cosan | 5 | Med |
| R | Rebooking/utilisation/stylist service mapping | Cosan | 5 | Med |
| S | QLAB/stock feasibility review | Joint | 5 | High |
| T | V1.1 disruption-control review | Cosan | 5 | Med |
| U | Week 1 technical review | Joint | 5 | Low |
| V | Week 2 readiness checklist | Joint | 5 | Low |

`zac.access` (P) is pulled to Day 2 because the registry (F) and table design (O) depend on it. ~89h total across two people.

---

## 13. Week 2 Readiness Criteria

Week 2 starts **only if**:
- [ ] Backend foundation design accepted (module, endpoint, context, guards) — task U signed off.
- [ ] Core tool contracts approved (14-field contract + per-tool permission re-check; zero write tools).
- [ ] Stable services identified (Business Health, KPI, Stylist Performance, Rebooking) with required permissions.
- [ ] Table/memory/logging approach confirmed (`zac` schema + FORCE-RLS; scopes; default-redaction; `NNNN` migrations authored for review).
- [ ] QLAB/stock feasibility status clear (documented go/no-go + prod parity).
- [ ] V1.1 disruption risk acceptable (additive-only, flag-gated, no in-flight collisions, logging-middleware PII exclusion agreed).
- [ ] Joint decisions (§15) recorded; blocking Cosan questions (QC1/QC2/QC4/QC5/QC6/QC7/QC8) answered or scheduled.

---

## 14. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Application-only tenant isolation (RLS dormant; service-role bypasses it) | ZAC opens no reasoning-read client; composes guarded services with `AuthUser`; own `zac.*` tables ENABLE+FORCE RLS |
| Service-layer permission-key gap | every tool re-checks its endpoint permission (`userHasAllPermissions`) |
| PII in prompt/response logs | exclude/redact ZAC routes from the global middleware; store metadata/refs, not raw content (D32) |
| `zac.access` auto-grants owners | the feature flag, not the permission, is the dark switch |
| Unstable/in-flight services | wrap only STABLE applied endpoints; treat lab/split-tender/payroll as moving targets; re-verify prod parity |
| QLAB/stock emptiness | probe-gate the two read tools; feasibility-only Week 1; waste from `formulas`, not `waste_events`; no retail insights |
| LLM cost drift | cost events per call; fast-tier default; per-tenant caching/budgets; config pricing |
| V1.1 / payroll disruption | additive-only; web-only; flag-gated; no writes; `NNNN` migrations authored for review; no reorder of nav |

---

## 15. Decisions Required Before Coding

**Cosan (technical, blocking):** QC1 module location (confirm `apps/api/src/zac/`); QC2 tools call injected services + re-check permission (recommended) vs loopback controllers; QC4 `zac.access` shape + owner/manager defaults + `NNNN` migration; QC5 `zac` schema + snapshot home; QC6 audit-event naming/agent-actor (recommend human-attributed `metadata.via='zac'`, no enum change); QC7 PII redaction rules; QC8 prod schema parity.

**Joint:** `zac` schema vs prefixed tables; raw messages vs safe summaries; stable services for Week 2; QLAB/stock inclusion level; model provider + env strategy (`ANTHROPIC_API_KEY` in `EnvConfig`+Railway; stub for local/tests); UI feature-flag strategy (`ZAC_ENABLED` + `VITE_ZAC_ENABLED`, web-only).

**Luke (product, non-blocking for scaffolding):** terminology per surface; assertiveness on underperformance; Value-Created dashboard vs report-only; first-priority outcome metric.

---

## 16. Final Recommendation to Start Backend Foundation

Start the backend foundation now, in this exact order — practical, not theoretical:

**What to build first (Week 1):**
1. **Scaffold `apps/api/src/zac/` + `POST /zac/ask` behind the three-guard chain + `zac.access`**, resolving the actor once via `@CurrentUser()`. This proves the security boundary before any intelligence exists.
2. **Wire the acting-user context resolver and role profile selector** (Owner/Manager/Stylist) over `AuthUser`.
3. **Stand up the permission-aware tool registry skeleton** with the read-only tool base contract and **the first two tools against `DashboardService` and `KpiService`** — returning raw evidence, no model call yet.
4. **Add the model-provider interface + a stub provider** so the ask path returns a contract-shaped answer end-to-end without an API key.
5. **Design (don't apply) the `zac` schema + `zac.access` migration**, and wire the measurement/cost spine to a table-or-log so no window goes unmeasured.

**What NOT to build yet:** any write tool; the model's ability to compute KPIs (it narrates only); Utilisation (no endpoint — register disabled); QLAB/stock tools (feasibility-only Week 1); the stylist mobile surface and lab app; a scheduler / Value-Created automation / vector retrieval; any per-tenant flag store. **Do not apply any migration in Week 1.**

**How to avoid V1.1 (and payroll) disruption:** additive-only, web-only, flag-gated; no writes; no touching in-flight lab/split-tender/payroll modules; `NNNN` migrations authored for review, not applied; no new global guard/filter/interceptor; rebuild `@sheer/domain` dist after the `zac.access` add; exclude/redact ZAC routes from the global logging middleware **before** the first endpoint ships.

**Which services to connect first:** `DashboardService` (Business Health, Rebooking) and `KpiService` (KPI Summary, Stylist Performance) — the most stable, deterministic fuel. Add `LabAnalyticsService`/`InventoryService` only in Week 2/3 behind the QLAB population probe.

**How to keep permissions safe:** gate the controller on `zac.access` **and** re-check each tool's underlying permission in code (services skip the permission-key check); strip commission unless `report.commission.view` and pay unless `staff.pay.manage`; owners/managers only in Phase 1; a stylist structurally cannot reach owner financials; private stylist coaching memory has no owner/manager read path.

**How to keep QLAB/stock controlled:** feasibility-only in Week 1 (probe + prod-parity); expose at most the colour cost/waste and low-stock tools in Week 2/3, each probe-gated; defer everything predictive/ordering/expiry (no data model); take waste from `formulas.waste_cost_cents`, never `waste_events`.

**What Luke will be able to test at the end of Phase 1:** logged into the **web dashboard as an owner (or manager)**, Luke opens ZAC and asks natural questions — *"How's my business doing this month?"*, *"Which stylists are below rebooking target?"*, *"Where is my colour waste highest?"* — and gets **evidence-grounded answers** drawn from QLOOQO's real deterministic data, each with **confidence and stated limitations**, **no invented numbers**, and **honest "no data captured yet"** where a source is empty. He can confirm **permission safety** (a manager sees only their locations; a stylist structurally cannot see owner financials; private coaching stays private), and that **every interaction and its cost is being recorded** so "what value has ZAC created?" becomes answerable later. *(Week 1 alone yields the guarded skeleton with stub answers; the full evidence-grounded experience lands as the tools and model provider are wired across Phase 1.)*

---

*Documentation only. This file created no application source code, migrations, environment files, package manifests, or Supabase data, and stages/commits nothing. It is the consolidated, build-ready backend plan for ZAC Phase 1.*
