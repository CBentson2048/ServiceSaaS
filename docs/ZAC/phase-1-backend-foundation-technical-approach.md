# ZAC Phase 1 Backend Foundation Technical Approach

> **Nature of this document.** A concrete, buildable technical solution for the ZAC Phase 1 backend foundation, derived from the code-grounded [`phase-1-backend-foundation-architecture-analysis.md`](phase-1-backend-foundation-architecture-analysis.md) and consistent with the Phase 0 decision set ([Decision Log](phase-0-decision-log.md) D1–D53, [Day 2](phase-0-day-2-core-architecture.md), [Future Integration Notes](phase-0-future-integration-notes.md), [Phase 1 MVP Roadmap](phase-1-mvp-roadmap.md)). **Documentation only** — this file creates no source code, no migrations, no env or package changes, and stages/commits nothing. Every architectural claim traces to a verified `path:line` in the analysis document.
>
> Date: 2026-07-24 · Phase 1 is **read-only** end-to-end (D4/D11/D43). No write tools, no autonomous actions, no unrestricted DB access.

---

## 1. Goal

The goal of Phase 1 is to build the **first safe backend foundation** for ZAC inside QLOOQO — **not** the full future agent system.

Concretely, Phase 1 delivers a role-aware, permission-aware, evidence-grounded **read-only** intelligence layer that:

- Answers owner/manager questions grounded in QLOOQO's own deterministic data (never invented numbers).
- Authenticates as the **acting user's JWT** and can see **only** what that user could already see through the normal API.
- Registers **zero write tools** — ZAC has no mechanism to mutate business data even if asked.
- Captures the **measurement + cost spine from day one** so "what value has ZAC created?" becomes answerable later (unrecoverable if not captured).
- Runs behind a **feature flag** so it can ship dark and be enabled per-environment without disrupting the V1.1 roadmap.

**Explicitly NOT in Phase 1:** autonomous actions; any business write; the full Value-Created ROI engine; vector/semantic retrieval; multi-channel adapters (voice/WhatsApp/phone); QLAB forecasting/ordering; the stylist mobile surface; a durable scheduler. These are deferred by design. Phase 1 **proves trust before autonomy**.

The foundation is deliberately thin but *correct*: the hard, irreversible decisions (module location, acting-user JWT, permission-aware guarded tools, measurement spine, tenant-privacy) are locked now so later phases build on solid ground.

---

## 2. Backend Placement

**Confirmed location: `apps/api/src/zac/`** — a new NestJS feature module inside the existing API (Decision Log **D1 / QC1**).

Rationale, grounded in the repo analysis:

- The API is a single NestJS 10 app with ~38 feature modules following a uniform `module → controller → service → dto` shape; ZAC becomes one more module. Registration is a single line added to `app.module.ts` imports (`app.module.ts:41-82`).
- `nest-cli.json` sets `sourceRoot: src` with `deleteOutDir`, so any new `src/zac/` folder is auto-compiled by `nest build` — **no build-config, workspace, or tsconfig change is needed**.
- Placing ZAC inside the API means it **inherits** the auth guards, the `AuthUser` identity/scope resolver, the audit service, and the single point where tenant `business_id`/`location_id` scoping is centralised — rather than re-implementing any of it.
- ZAC is greenfield: there is no existing `zac`/`Zac` code anywhere in `apps/` or `packages/` (grep-confirmed) — no collision.

No alternative location is warranted. (A separate microservice would have to re-solve auth, tenant isolation, and permissions from scratch — the exact things the in-API placement gives for free, and the exact things that are dangerous to get wrong given the platform's application-layer-only tenant isolation.)

Shared cross-app types (the `zac.access` permission key, chat message shapes, response contract) belong in `@sheer/domain` so a future web UI shares one contract — matching how `AuthUser` and `Permission` are already centralised there (rebuild the package dist after editing).

---

## 3. Proposed Module Structure

The structure below is adapted to the **actual house conventions** observed in the repo. Two deliberate, justified deviations from the norm are noted:

- The house norm is a **single `dto.ts` per module** (not a `dto/` folder) and **single-file services**. ZAC's scope (many contracts, several new concerns) justifies sub-folders; this is an acceptable, contained deviation. A single `dto.ts` is equally acceptable if the team prefers strict consistency.
- The first concrete model provider targets **the latest Claude models** (Phase 0 A3 / Day 2 §11 mandate "default to latest Claude"), not OpenAI. The interface is provider-agnostic; a stub/echo provider is included for local dev without an API key.

```
apps/api/src/zac/
  zac.module.ts                 // imports: [AuthModule, KpiModule, DashboardModule*, CrmModule,
                                //           LabAnalyticsModule, InventoryModule, RotaModule]
                                // controllers: [ZacController]; providers: [ZacService, ...]
  zac.controller.ts             // @Controller('zac') + 3-guard chain + @RequirePermissions('zac.access')
  zac.service.ts                // orchestrator; NO service-role Supabase client for reads

  dto/
    zac-ask-request.dto.ts      // class-validator: question (@MaxLength), conversationId?, requestSource?
    zac-ask-response.dto.ts     // the evidence-grounded response contract (§9)
    zac-feedback.dto.ts

  context/
    zac-context.service.ts      // Context Assembler — minimum relevant context from AuthUser (A2)
    zac-context.types.ts        // ZacActingContext (§6)
    scope-resolver.service.ts   // derive business/location scope from AuthUser; reject out-of-scope

  roles/
    zac-role-profile.service.ts // Role Profile Selector — owner/manager/stylist behaviour + terminology
    zac-role-profile.types.ts

  tools/
    zac-tool-registry.service.ts // permission-aware registry; filters by actor.permissions BEFORE model runs
    zac-tool.types.ts            // the standard tool contract (§8)
    tools/
      business-health.tool.ts
      kpi-summary.tool.ts
      rebooking-summary.tool.ts
      utilisation-summary.tool.ts        // registered DISABLED in Phase 1 (no server endpoint yet)
      stylist-performance.tool.ts
      personal-stylist-coaching.tool.ts  // deferred surface; wired but gated to stylist-self
      qlab-stock-feasibility.tool.ts     // Week-1 internal feasibility pass (not user-facing)

  models/
    zac-model-router.service.ts
    zac-model-provider.interface.ts
    zac-model-pricing.config.ts          // configurable pricing constants (D33) — no hardcoded vendor prices
    providers/
      anthropic-zac-provider.ts          // first concrete provider — latest Claude
      stub-zac-provider.ts               // deterministic echo/stub for local dev + tests

  responses/
    zac-response-builder.service.ts      // builds the evidence-grounded contract; enforces 7-part evidence rule
    zac-response.types.ts

  memory/
    zac-memory.service.ts                // Context Memory (scopes) + private stylist coaching read path
    zac-memory.types.ts

  measurement/
    zac-output-logger.service.ts         // conversation/message/output events (the measurement spine)
    zac-cost-telemetry.service.ts        // per-call cost events
    zac-outcome-event.service.ts         // observed-outcome / attribution-seed foundation

  prompts/
    constitution-policy.ts               // truth/loyalty/integrity/privacy/humanity + hard boundaries (D40)
    owner.profile.ts
    manager.profile.ts
    stylist.profile.ts

  qlab/
    qlab-feasibility.service.ts          // Week-1 read pass + data-population probe (go/no-go)

  zac.service.spec.ts                    // jest, mirroring kpi.calc.spec / permissions.guard.spec
```
`*` `DashboardModule` currently does **not** export `DashboardService` — a one-line `exports: [DashboardService]` addition is required if ZAC injects it (`KpiService`, `CrmService`, `LabAnalyticsService`, `InventoryService`, `RotaService` are already exported).

**Naming conventions to follow (house style):** kebab-case filenames; `PascalCase` classes suffixed `Module`/`Controller`/`Service`/`Dto`; route prefix without `api/` (global prefix adds it → `/api/zac/...`); `@CurrentUser() actor: AuthUser`; per-class `Logger(ZacService.name)`; standard `HttpException` subclasses; `NotFound`-before-`Forbidden`.

---

## 4. Request Lifecycle

The exact backend flow for `POST /api/zac/ask` (each stage cites the pattern it reuses):

1. **User asks a question in the QLOOQO UI** (web dashboard, owner/manager). The client sends `POST /api/zac/ask` with `Authorization: Bearer <jwt>` and `{ question, conversationId? }`.
2. **The API receives the request.** The global `ValidationPipe` (`main.ts:21-27`) validates the DTO (`whitelist + forbidNonWhitelisted + transform`); unknown fields are rejected. The controller has the `api` global prefix.
3. **Auth guard resolves the acting user.** `SupabaseAuthGuard` reads the bearer token, calls `AuthService.verifyAccessToken` (validates the JWT via the anon client, then `resolveAuthUser`), and attaches the fully-resolved `AuthUser` to `request.auth`. `RolesGuard` (`owner`/`manager`) and `PermissionsGuard` (`zac.access`) run next. The handler reads `@CurrentUser() actor: AuthUser`. **The actor is resolved exactly once** and threaded through the whole turn (no per-tool re-auth).
4. **ZAC context service builds scope.** `ZacContextService` assembles the acting-user context (§6) from `AuthUser`: `business_id`, `accessible_location_ids`, `role`, `permissions`, `timezone`. Rejects salon-less actors (`businessId === ''`).
5. **Role profile selector chooses behaviour.** `ZacRoleProfileService` maps `actor.primaryRole` (using the multi-role set where relevant) to the Owner/Manager/Stylist profile — system prompt, terminology (Insight / Coaching Point / Opportunity / Risk / Watch Point — D19), assertiveness, and default aggregation scope.
6. **Tool registry selects allowed read-only tools.** `ZacToolRegistry.buildFor(actor)` returns only tools whose `required_permissions` the actor holds (`userHasAllPermissions`) and whose `allowed_roles` include one of `actor.roles`. **The platform decides tool availability, not the model** (D3). No write tools exist to select.
7. **Tools call guarded QLOOQO services only.** Each selected tool, when invoked, **re-checks its own permission** (closing the service-layer permission-key gap), then calls the existing guarded `*Service` method with `actor` — inheriting its role + location + `business_id` scoping. Tools never open a Supabase client and never accept a model-supplied `business_id`/`locationId` without validating it against `actor.allowedLocationIds`.
8. **Evidence package is built.** Tool outputs (already-computed numbers from the deterministic KPI engine / report services) are collected as typed evidence with `source_ref` and `as_of`. The model performs **no arithmetic** (D5).
9. **Model router selects model/provider.** `ZacModelRouter` picks a model behind `zac-model-provider.interface.ts` — fast tier by default, reasoning escalation only on complexity signals; the first provider targets latest Claude. Context passed to the model is **minimum relevant only** (A2) — never a full DB/KB dump; caches are per-tenant only (D17).
10. **Response builder creates the answer.** `ZacResponseBuilder` produces the evidence-grounded contract (§9): `answer`, `evidence[]`, `confidence`, `limitations[]`, `suggested_next_step`, `measurement_hook`, `attribution_seed`, response type. It enforces the seven-part evidence rule — any factual claim missing a part is flagged or withheld; missing data is stated, never invented.
11. **Memory/logging layer records safe summaries.** `ZacOutputLogger` writes conversation/message/output/tool-call events; `ZacCostTelemetry` writes the cost event; `ZacMemory` writes scoped **summaries** (not raw transcripts, D32). All writes are fail-soft **with alerting** and confined to `zac.*` tables, `business_id`-scoped.
12. **API returns the ZAC response.** The response DTO is returned. **ZAC routes are excluded from / redacted in the global request/response logging middleware** so prompts and answers (which carry PII) are not dumped to stdout.

---

## 5. API Endpoint Design

All endpoints are served under the global `api` prefix, gated by `SupabaseAuthGuard, RolesGuard, PermissionsGuard` + class-level `@RequireRoles('owner','manager')` + `@RequirePermissions('zac.access')`, and behind the `ZAC_ENABLED` env kill-switch. Only ZAC's own telemetry/feedback tables are written — no business writes.

### `POST /zac/ask` — **Phase 1 REQUIRED**
- **Purpose:** the main Q&A entrypoint; runs the full lifecycle (§4) and returns the evidence-grounded answer.
- **Auth:** valid bearer JWT. **Permission:** `zac.access` (+ each invoked tool re-checks its own).
- **Request fields:** `question: string` (bounded `@MaxLength`), `conversationId?: string` (uuid), `requestSource?: 'web_dashboard' | 'mobile_app'` (defaults `web_dashboard`), `locationId?: string` (optional; validated against `actor.allowedLocationIds`).
- **Response fields:** the full ZAC response contract (§9).
- **Notes:** creates/continues `zac.conversations` + `zac.messages`; logs spine + cost events. Read-only w.r.t. business data.

### `POST /zac/feedback` — **Phase 1 REQUIRED**
- **Purpose:** capture "did this help?" as a learning signal (D24), not just UI state.
- **Auth:** JWT. **Permission:** `zac.access`.
- **Request fields:** `conversationId` or `messageId` or `outputId`, `rating: 'up' | 'down' | int`, `comment?: string` (stored redacted).
- **Response fields:** `{ ok: true }`.
- **Notes:** writes `zac.feedback`. Feeds Outcome Memory later.

### `GET /zac/health` (or `/zac/status`) — **Phase 1 REQUIRED**
- **Purpose:** liveness of the ZAC subsystem — provider reachable, flag state, model config present.
- **Auth:** JWT + `zac.access` (or excluded from the api prefix like the app health route, if used for infra probes).
- **Response fields:** `{ enabled: boolean, provider: string, model: string, ok: boolean }`.
- **Notes:** no model call; cheap.

### `GET /zac/conversations` and `GET /zac/conversations/:id` — **OPTIONAL (Phase 1)**
- **Purpose:** retrieve the acting user's own conversation history.
- **Auth:** JWT. **Permission:** `zac.access`.
- **Request fields:** list — pagination (`cursor?`, `pageSize?`); detail — `:id` (uuid).
- **Response fields:** conversation summaries; detail returns messages (redacted content refs) + outputs.
- **Notes:** hard-scoped to `business_id = actor.businessId` **and** `actor_user_id = actor.id`. Optional in Phase 1 — the UI can function without persisted history.

### `GET /zac/suggested-prompts` — **OPTIONAL (Phase 1)**
- **Purpose:** role-appropriate starter questions for the UI ("What's my biggest opportunity this month?").
- **Auth:** JWT. **Permission:** `zac.access`.
- **Response fields:** `{ prompts: { label, question }[] }`, derived from the role profile and the tools the actor can actually use.
- **Notes:** can be static per role in Phase 1; no model call required. Doubles as a lightweight capability probe (which is why `GET /zac/capabilities` is folded in here rather than being a separate required endpoint).

**Required set for Phase 1:** `POST /zac/ask`, `POST /zac/feedback`, `GET /zac/health`. **Optional/nice-to-have:** `GET /zac/conversations(/:id)`, `GET /zac/suggested-prompts`. Stylist-facing endpoints (personal coaching) are **deferred** with the stylist mobile surface.

---

## 6. Acting User Context Contract

The `ZacActingContext` is assembled **only** from the guard-resolved `AuthUser` (`packages/domain/src/index.ts:154-199`) plus a small amount of request/environment data. ZAC **never re-derives** roles/permissions/locations.

| Field | Source | Notes |
|---|---|---|
| `actor_user_id` | `AuthUser.id` | **The field is `id`, not `userId`.** The accountable actor id. |
| `business_id` | `AuthUser.businessId` | `''` ⇒ salon-less customer → **reject** the request (never query with an empty tenant key). |
| `location_id` | request `locationId?` validated against scope | **There is no single "active location."** If supplied, it must be in `accessible_location_ids` (owners excepted); if omitted, ZAC defaults to the full accessible set and **states which locations it aggregated**. |
| `role` | `AuthUser.primaryRole` (+ `roles[]`) | Gate capabilities on `roles[]` (`userHasAnyRole`), never on a single role. `primaryRole` picks the role profile / default surface only. |
| `permissions` | `AuthUser.permissions` | Effective, expanded permission keys. |
| `accessible_location_ids` | `AuthUser.allowedLocationIds` | Owner ⇒ all active locations; else the union of the user's membership locations. |
| `feature_flags` | env/flag layer | `ZAC_ENABLED` (backend) and any per-role feature toggles. **No per-tenant flag store exists** — per-tenant enablement is out of Phase 1 scope. |
| `request_source` | request DTO / header | e.g. `web_dashboard` (default) / `mobile_app`. Recorded for telemetry + channel attribution. |
| `timezone` | `AuthUser.timezone` | IANA tz; already resolved for the user. Used to render KPI windows correctly. |
| `locale` | default `en-GB` | **`AuthUser` carries no locale today** — default to `en-GB` (GBP, `*_cents`, grams) and flag as a small gap to fill if multi-locale is needed. |

**How it is resolved from existing auth patterns.** `SupabaseAuthGuard` → `AuthService.verifyAccessToken` → `resolveAuthUser(userId)` produces the full `AuthUser` on `request.auth`; the controller reads it with `@CurrentUser()`. `ZacContextService` maps the fields above and validates `businessId !== ''`. This costs one GoTrue round-trip + several DB reads **per HTTP call**, so resolve once at the controller boundary and pass the in-memory context down — do not re-authenticate per tool.

---

## 7. Permission Rules

The permission model is layered and **fail-closed**:

- **`zac.access` controls access to the ZAC feature only** — "may this user talk to ZAC at all." It is added as a first-class key in the `Permission` union + `PERMISSION_CATALOG` (`packages/domain/src/index.ts`), granted to owner+manager by default (owners auto-hold it via the `[...ALL_PERMISSIONS]` short-circuit).
- **`zac.access` does NOT override underlying QLOOQO permissions.** Because the underlying services re-check role + location but **not** the fine-grained permission key, treating `zac.access` as a data grant would be a back-door around every report/CRM restriction. Effective visibility = **`zac.access` AND the user's own per-report permission**.
- **Each tool must check its own required permission** with `userHasAllPermissions(actor, [...])` before invoking the service — this is the single most important safety rule and is enforced *inside every tool*, not only at the controller guard.
- **Stylist personal coaching must not expose peer or private data** — hard-keyed on `actor.staffProfileId`, never accepting a `staffProfileId` argument; own-data only; no peer comparison.
- **Owner/Manager see themes and permitted performance data, not private stylist coaching conversations** (D26/D42) — private coaching note bodies live in a table with no owner/manager SELECT policy; owners/managers get aggregate themes only.
- **All tools are read-only in Phase 1** — enforced structurally by registering zero write tools.

### Tool–permission matrix

| Tool | Owner | Manager | Stylist | Required underlying permission | Notes |
|---|---|---|---|---|---|
| Business Health | ✅ | ✅ (location-scoped) | ❌ | `report.dashboard.view` (+ `report.lab_analytics.view` optional) | "revenue & activity health", **not P&L** (no cost/profit line exists yet) |
| KPI Summary | ✅ | ✅ | ❌ (own via coaching) | `report.commission.view` **or** `report.performance.view` | strip commission fields unless `report.commission.view` is held |
| Rebooking Summary | ✅ | ✅ | ❌ | `report.dashboard.view` | `no_show` ≈ 0 (never written) — flag as not-captured |
| Utilisation Summary | ⚠️ | ⚠️ | ❌ | `report.performance.view` (proposed) | **No server endpoint exists** — registered **disabled** in Phase 1; needs new backend wiring |
| Stylist Performance | ✅ | ✅ (location-scoped) | ❌ | `report.performance.view` | strip commission unless `report.commission.view`; strip pay/rate unless `staff.pay.manage` |
| Personal Stylist Coaching | ❌ | ❌ | ✅ (self only) | none `report.*` (needs `zac.access` + `roles∋stylist` + `staffProfileId`) | own-data only, private; **deferred surface** in Phase 1 |
| QLAB/Stock Feasibility | ✅ | ✅ | ❌ | `report.lab_analytics.view` / `inventory.manage` | Week-1 **internal** feasibility pass, not a user-facing tool |
| QLAB/Stock Read-Only Insights *(if stable)* | ✅ | ✅ (location-scoped) | ❌ | `report.lab_analytics.view` (colour) / `inventory.manage` (stock) | Week 2/3 only; gated on the Week-1 data-population probe |

Owners pass every underlying permission automatically, so the per-tool re-checks add zero owner friction — they only correctly deny managers/stylists whatever a security level took away.

---

## 8. Tool Contract Design

Every tool is a **controlled contract, permission-gated before the model runs** (D3/D31), declared as a typed object:

```
ZacToolContract {
  name:                  string          // e.g. 'report.business_health'
  description:           string          // model-facing purpose
  allowed_roles:         UserRole[]      // 'client' never present
  required_permissions:  Permission[]    // re-checked against actor BEFORE dispatch
  input_schema:          <class-validator/zod>   // bounded; no raw business/location id trusted from the model
  output_schema:         <existing service response type>
  evidence_refs:         EvidenceRef[]   // source_type, source_ref, as_of, entities_used (no raw PII)
  read_only:             true            // Phase 1 invariant
  sensitive_fields:      string[]        // fields to redact unless an extra permission is held (e.g. commission, pay)
  error_behavior:        'fail_closed'   // deny/omit on permission or scope failure; never leak
  fallback_behavior:     'state_unavailable'  // if data missing/empty, say so honestly (never infer)
}
```

**Registry rules:** availability is derived from `actor.permissions[]`; every tool re-checks `required_permissions` at dispatch and re-asserts `zac.access`; tools call injected `*Service` methods with the acting `AuthUser`; **no write tools registered**.

### Phase 1 core tools

**1. BusinessHealthSummaryTool**
- **Purpose:** high-level revenue/activity health for owners/managers.
- **Input:** `{ period | from/to, locationId? }`.
- **Output:** `DashboardKpisResponse` (revenue, bookings mix, rebooking rate, avg booking value, low-stock count) + optional `LabAnalyticsSummary` colour block.
- **Permissions:** `report.dashboard.view` (+ `report.lab_analytics.view` for the colour block, checked separately).
- **Evidence:** `DashboardService.kpis` / `LabAnalyticsService.summary` outputs with `as_of`.
- **Unavailable-data behaviour:** label as "revenue & activity health", **not** P&L (fixed-cost/profit consumer is Week 7-8, unbuilt); render empty sub-metrics as "no data captured yet".

**2. KpiSummaryTool**
- **Purpose:** per-stylist KPI / commission summary.
- **Input:** `{ period | from/to, locationId? }`.
- **Output:** `StylistKpiListResponse` (hours/targets/rebooking/retail/avg-bill + commission).
- **Permissions:** `report.commission.view` (commission variant) or `report.performance.view` (perf variant).
- **Evidence:** `KpiService.stylistList` (deterministic `kpi.calc.ts`).
- **Unavailable-data behaviour:** strip commission fields if only `report.performance.view` is held; surface `notes` flags (`retail_attribution_approximate`, `no_hours_worked`) rather than presenting a degenerate 0 as truth.

**3. RebookingSummaryTool**
- **Purpose:** rebooking rate + stylist/client split, overdue-client signal.
- **Input:** `{ period | from/to, locationId? }`.
- **Output:** rebooking rate, rebooked visits, stylist-vs-client split; optional overdue-client list.
- **Permissions:** `report.dashboard.view`.
- **Evidence:** dashboard/KPI reducers over `rebook_source`; overdue signal reuses the `clientAlreadyRebooked` inverse + per-service nudge interval.
- **Unavailable-data behaviour:** `rebooking_outcomes` is a lower bound (single-row-per-visit); `no_show` ≈ 0 — hedge these explicitly.

**4. UtilisationSummaryTool** *(registered DISABLED in Phase 1)*
- **Purpose:** booked ÷ available time per day/location.
- **Input:** `{ from/to, locationId? }`.
- **Output:** `DailyUtilisation`.
- **Permissions:** `report.performance.view` (proposed).
- **Evidence:** would call `computeDailyUtilisation` over rota shifts − breaks − reducing book-outs vs booked appointment time.
- **Unavailable-data behaviour:** **there is no server endpoint** — the pure engine + tests exist but are browser-only. This tool is **registered but disabled** until the backend wiring is built (flagged as Week 2/3 build-work, not a wrapper).

**5. StylistPerformanceTool**
- **Purpose:** team performance for owners/managers.
- **Input:** `{ from/to, locationId? }`.
- **Output:** `DashboardStylistPerformanceResponse` (per-stylist bookings/completed/cancelled/no-show/rebooking/revenue/avg-bill).
- **Permissions:** `report.performance.view`.
- **Evidence:** `DashboardService.stylistPerformance`.
- **Unavailable-data behaviour:** strip commission unless `report.commission.view`; strip raw pay/rate/target unless `staff.pay.manage`; owner → all locations, manager → `allowedLocationIds` (reject out-of-scope `locationId`). Present the **computed** target, not the stored (unused) `performance_target_amount`.

**6. PersonalStylistCoachingTool** *(deferred surface; wired, gated)*
- **Purpose:** private, own-data coaching for a stylist.
- **Input:** `{ period? }` — **no `staffProfileId` argument accepted.**
- **Output:** `StylistKpiResponse` for the caller + own rota + own private coaching notes.
- **Permissions:** `zac.access` + `roles∋stylist` + `actor.staffProfileId` present (no `report.*` required, mirroring `/kpi/me`).
- **Evidence:** `KpiService.myKpi` (self-forced by `staffProfileId`).
- **Unavailable-data behaviour:** 403 if no `staffProfileId`; note bodies read via a path unreachable from any owner/manager tool.

**7. QlabStockFeasibilityTool** *(Week-1 internal)*
- **Purpose:** feasibility + data-population probe over lab/inventory/retail; produces go/no-go per signal.
- **Input:** `{ locationId? }`.
- **Output:** `{ hasSavedFormulas, hasInitialisedStock, hasThresholds, hasRetailRows, verdicts }`.
- **Permissions:** `report.lab_analytics.view` / `inventory.manage`.
- **Evidence:** counts from `lab.formulas` (`status='saved'`), `inventory.location_stock`, `billing.retail_sales`.
- **Unavailable-data behaviour:** this **is** the "is there data?" probe — reports emptiness honestly; not user-facing.

**8. QlabStockReadOnlyInsightTool** *(optional; Week 2/3 only, if feasible)*
- **Purpose:** colour cost/waste signals and low-stock/stock-visibility insights.
- **Input:** `{ period | from/to, locationId? }`.
- **Output:** colour revenue/cost/margin %, waste cost/%, most-used products (from `LabAnalyticsService.summary`); low-stock + stock levels (from `InventoryService`/`DashboardService.inventoryAlerts`).
- **Permissions:** `report.lab_analytics.view` (colour) / `inventory.manage` or `report.dashboard.view` (stock).
- **Evidence:** the guarded lab/inventory service outputs.
- **Unavailable-data behaviour:** gated on the Week-1 population probe — if the salon doesn't use the Lab or hasn't initialised stock, say "no data captured yet" instead of reporting zeros. Waste comes from `formulas.waste_cost_cents`, **never** from the write-only `waste_events`.

---

## 9. Response Contract

Every ZAC answer conforms to a single typed contract (A4/D5/D6):

```
ZacResponse {
  answer:             string             // human-readable, role-appropriate
  role_context:       'owner' | 'manager' | 'stylist'
  response_type:      ResponseType       // see below
  evidence:           Evidence[]         // { source_type, source_ref, as_of, entities_used (no raw PII) }
  confidence:         'high' | 'medium' | 'low'   // derived, not guessed
  limitations:        string[]           // stated gaps / assumptions; "no data captured yet" where relevant
  suggested_next_step: string | null     // surfaced, never executed (Phase 1 read-only)
  measurement_hook:   string | null      // which metric this answer relates to (rebooking/revenue/utilisation/…)
  attribution_seed:   AttributionSeed | null  // target_entity_type/id + window, for later Observed/Influenced/Directly-Attributable
  memory_updates:     MemoryUpdate[]     // scoped summaries to persist (never raw sensitive content)
  tool_calls:         ToolCallTrace[]    // tool name, status, latency, row counts (metadata only)
  cost_metadata:      CostMetadata       // model, tokens, estimated cost, latency, cache hit
  trace_id:           string             // request/correlation id
}
```

**Response types:**

- **Insight** — a factual observation grounded in evidence.
- **Coaching Point** — a supportive, single-focus improvement suggestion (stylist/manager).
- **Opportunity** — a positive action the user could take (surfaced, not executed).
- **Risk** — a negative trend/exposure that needs attention.
- **Watch Point** — something to monitor; not yet actionable.
- **Explanation** — a "why/how" answer about the business or the product.
- **Refusal / Insufficient Data** — honest decline: out of permission scope, out of Phase 1 scope (e.g. a write request), or the data does not exist / is not captured yet.

The response builder enforces the **seven-part evidence rule** (source · metric changed · evidence · attribution · confidence · method · limitations): any factual claim missing a part is flagged or withheld. `confidence` is derived from data completeness, attribution strength, sample size, window fit, and prior outcomes — and shown *alongside* the answer, never hidden inside it. `suggested_next_step` is advisory only — Phase 1 never acts.

---

## 10. Memory Design

Memory is split into two durability classes, plus strict visibility scoping.

**Business Memory** (survives with the business):
- business goals, operational trends, KPI context, business decisions, outcome summaries.

**Personal Memory** (moves with the individual later):
- user goals, coaching preferences, learning style, strengths, achievements, recurring challenges.

**Phase 1 implementation (foundation only):**
- **Safe context memory only** — scoped summaries, not raw transcripts (D32).
- **Goal-memory foundation** — capture business/personal goals as structured records.
- **`visibility_scope` required on every memory row.**
- **Raw sensitive content is not stored by default** — store redacted content or a content reference (pointer to the source report window / row ids); verbatim capture only behind an explicit per-business opt-in with short retention.
- **Stylist coaching privacy protected** — private coaching memory lives in a table with **no owner/manager read path**.

**Memory visibility scopes:**

| Scope | Who can read | Use |
|---|---|---|
| `user_private` | the owning user only | personal goals/preferences |
| `business_owner` | owner (business-wide) | business goals, decisions, outcome summaries |
| `manager_team_theme` | manager (location-scoped), owner | aggregate team themes/trends — **not** individual coaching conversations |
| `stylist_private` | the owning stylist's own user **only** | private coaching notes — owner/manager have no SELECT path |
| `system_safe_summary` | any permitted role | non-sensitive derived summaries |

Every memory row also carries `business_id`, `created_by`, `source`, and is deletable/reviewable per privacy policy. Context Memory ("what ZAC knows") and Outcome Memory ("what happened / did it create value") are kept in **separate** stores (D13).

---

## 11. Outcome and Value Logging Design

**Output lifecycle (Phase 1 logs the foundation only):**

```
question asked → tools called → response generated → feedback collected
   → outcome observed → attribution classified → value estimate recorded (later phase)
```

Phase 1 captures the **events** so the chain is reconstructable later — it does **not** run the automated ROI engine.

**Attribution types (the honesty ladder):**
- **Observed** — the outcome happened; ZAC claims no direct influence (reported as business reality).
- **Influenced** — ZAC helped awareness/coaching/decision but other factors contributed (apply a discount factor).
- **Directly Attributable** — a clear evidenced link: ZAC item shown → acknowledged → same target entity → within the measurement window.

The Day 4 §4.4 decision tree governs classification. Attribution reuses **existing** schema hooks — `booking.rebooking_outcomes.rebook_source` and `booking.appointments.booking_channel` — **read-only in Phase 1** (the `rebook_source` CHECK excludes `'zac'` and `booking_channel='api'` is already used by the public deposit flow; ZAC does not write them in Phase 1).

**Value Created — logging foundation only in Phase 1.** The `zac.outcome_events` / `zac.recommendation_outcomes` and `zac.kpi_snapshots` tables capture the raw material; the full Value-Created dashboard/ROI computation and the Sunday-report integration are **deferred**. Scope Phase 1 value events to the nine "Ready" categories (Revenue Influenced, Rebooking, Bookings Recovered, Utilisation, Client Retention proxy, Staff Development, Time Saved, Management Hours Saved, Subscription ROI); Blocked/Partial categories (Retail — empty table; Profit/Waste/Stock/Health) render "no data captured yet". Periodic KPI snapshots need a scheduler decision (no durable scheduler exists) and are a design item, not day-one runtime.

---

## 12. Cost Telemetry Design

Every model call logs one `zac.cost_events` record via `ZacCostTelemetry`, so cost-per-intelligence and gross margin are reconstructable (unrecoverable if not captured):

| Field | Notes |
|---|---|
| `provider` | e.g. `anthropic` |
| `model` | e.g. `claude-...` |
| `task_type` | `qa` / `report` / `coaching` / etc. |
| `role_context` | `owner` / `manager` / `stylist` |
| `input_tokens` (prompt) | |
| `output_tokens` (completion) | |
| `reasoning_tokens` | when the reasoning tier is used |
| `estimated_cost` | from configurable pricing constants (D33) — **no hardcoded vendor prices** |
| `latency_ms` | |
| `tool_calls_used` | count |
| `cache_hit` | per-tenant cache only (D17) |
| `business_id` | tenant scope |
| `actor_user_id` | `AuthUser.id` |
| `conversation_id` | links to the conversation |

**Controls from launch:** fast-tier default with reasoning escalation only on complexity signals (log `zac.model.escalated`), per-tenant prompt/tool caching only, summary memory over transcripts, per-tenant budgets, and the Day 4 §21 optimisation triggers (report generated-not-opened, input-tokens-per-call trending up, token growth outpacing active users). Pricing constants live in `zac-model-pricing.config.ts`, refreshed from official pricing pages before commercial sign-off. Cost envelopes are in USD; business value in GBP `*_cents` — keep separated and record the FX assumption.

---

## 13. Proposed ZAC Database Tables

**Recommendation:** a dedicated **`zac` schema** with RLS **ENABLED and FORCED** (stronger than the rest of the platform, whose RLS is dormant). This matches the platform's domain-schema convention and isolates ZAC's higher-sensitivity content. The task's `zac_*` names map to `zac.*` schema tables (e.g. `zac_conversations` ≡ `zac.conversations`); a `public.zac_*`-prefixed variant is the fallback if a new schema is undesired. **No SQL is generated here** (per the task) — tables are described in field/index form only, to be authored as the **next free migration files at build time**. ⚠️ **Migration-number note:** `0071`–`0074` are already claimed by the in-flight payroll work (`0071_payroll_foundation` … `0074_payroll_permissions`), so ZAC's migrations would be **`0075+`** — take the actual next-free number when authoring (file-based; never via MCP DDL; `zac` also added to `config.toml` + each project's Exposed Schemas).

**Common columns (every table):** `id uuid default gen_random_uuid()`; `business_id uuid not null`; `created_at timestamptz not null default now()` (+ `updated_at` with the shared `set_updated_at()` trigger where mutable); `actor_user_id uuid`; `role_context text`; `visibility_scope text` (`all|locations|self|user_private|…`). Snapshot `role_context`/`visibility_scope` at creation so a later permission change can't retroactively widen ownership. `location_id uuid null` only where genuinely location-scoped.

| Table | Purpose | Key fields (beyond common) | Indexes | Scope | Privacy / protection |
|---|---|---|---|---|---|
| **`zac.conversations`** (`zac_conversations`) | one row per Q&A thread | `title?`, `topic?`, `status`, `started_at`, `ttl_expires_at?` | `(business_id, actor_user_id, created_at desc)` | business + user | FORCE-RLS; owner/self read |
| **`zac.messages`** (`zac_messages` / split as `zac_message_events`) | per-turn message log | `conversation_id`, `role` (`user\|assistant\|system\|tool`), `content_ref`/`content_redacted`, `token_count`, `model` | `(conversation_id, created_at)`, `(business_id, created_at desc)` | business + user | **no raw prompt/response by default** (D32); store refs/redacted |
| **`zac.tool_calls`** (`zac_tool_calls`) | proof every read went through a scoped tool | `conversation_id`, `message_id`, `tool_name`, `args_meta jsonb` (param summary, not dumps), `result_status`, `result_row_count`, `latency_ms`, `error_code?` | `(business_id, tool_name, created_at desc)` | business (+ location where relevant) | metadata only; no PII |
| **`zac.memory`** (`zac_memory_items`) | scoped context/goal memory | `scope`, `kind`, `content_redacted`/`content_ref`, `source_conversation_id?`, `created_by`, `source`, `expires_at?` | `(business_id, scope)`, `(business_id, actor_user_id)` | business / user / location per `scope` | deletable/reviewable; `stylist_private` has no owner/manager read |
| **`zac.stylist_coaching_notes`** | private stylist coaching bodies | `staff_profile_id`, `author='zac'`, `body_redacted` | `(business_id, staff_profile_id)` | stylist-self only | **RLS grants SELECT only to the owning stylist's own user; NO owner/manager SELECT** |
| **`zac.recommendations`** (`zac_outputs` / `zac_insights`) | Insights/Coaching Points/Opportunities/Risks/Watch Points | `type`, `title`, `recommendation`, `why`, `evidence jsonb`, `expected_outcome`, `metric_to_measure`, `target_entity_type/id?`, `confidence`, `status`, `measurement_window_days` | `(business_id, type, created_at desc)` | business (+ location/user) | evidence refs, not raw PII |
| **`zac.recommendation_events`** | lifecycle of an output | `recommendation_id`, `event_type` (`created\|shown\|accepted\|dismissed\|ignored\|expired`) | `(recommendation_id, created_at)` | business | — |
| **`zac.feedback`** (`zac_feedback`) | "did this help?" signal | `message_id`/`recommendation_id`, `rating`, `comment_redacted?` | `(business_id, created_at desc)` | business + user | comment stored redacted |
| **`zac.observed_outcomes` + `zac.recommendation_outcomes`** (`zac_outcome_events`) | what happened + attribution join | `outcome_type`, `target_entity_type/id?`, `observed_value`, `estimated_financial_value_cents`, `confidence`, `attribution_type`, `evidence jsonb`, `observed_at`; `recommendation_id` **nullable** | `(business_id, outcome_type, observed_at desc)` | business (+ location) | outcomes tracked even when unlinked |
| **`zac.cost_events`** (`zac_cost_events`) | per-call cost telemetry | fields from §12 | `(business_id, created_at desc)`, `(business_id, model)` | business + user | **no prompt/response text** — cost metadata only |
| **`zac.kpi_snapshots`** *(design)* | longitudinal "1% better" spine | `location_id?`, `staff_profile_id?`, `period`, `metric`, `value` | `(business_id, metric, period)` | business (+ location/staff) | derived from the deterministic engine |

**Retention/privacy notes:** telemetry tables (`tool_calls`, `cost_events`, `message_events`) hold metadata only and are prunable on independent retention. Any table that could hold raw content stores redacted content or references by default; verbatim capture is opt-in, short-retention, and in a separate FORCE-RLS table. Because the platform's RLS is otherwise dormant, `FORCE`-RLS on the `zac` schema is defence-in-depth on top of the application-layer `business_id` scoping — the one place DB-level isolation is worth paying for.

---

## 14. QLAB / Stock Read-Only Foundation

**Phase 1 boundary:**

**Included:**
- A **technical feasibility + read-only foundation pass** (Week 1) over the existing QLOOQO Lab, product, stock, formula, and inventory data/services.
- Expose to ZAC **only** the stable, applied, permission-aware parts.

**Possible limited insights (Week 2/3, only if the Week-1 probe says the data exists):**
- colour waste trends and basic colour cost/waste signals (from `lab.formulas.waste_cost_cents` via `LabAnalyticsService.summary` — **not** the write-only `waste_events`);
- low-stock items and simple current stock visibility (live from `inventory.location_stock`);
- slow-moving / fast-moving products as a **descriptive ranking over a window** (from most-used products + `stock_movements`), not a trend/prediction.

**Deferred (no data model and/or predictive):**
- advanced prediction; ordering forecasts; over-ordering detection; stock-holding optimisation; automated ordering; supplier purchasing workflows; expiry/shelf-life; retail performance (table effectively empty); formula version/draft/reapply analytics (the `0063/0068/0069` chain is unapplied V1.1 work).

**Acceptance condition:** a QLAB/stock capability is included in Phase 1 **only if** it is read-only, backed by applied and populated schema, permission-aware (`report.lab_analytics.view` / `inventory.manage`), and **non-disruptive to the V1.1 roadmap**. Week 1 is feasibility-only (no user-facing tool); Week 2/3 exposes at most the two read tools above, each gated on the data-population probe. Production schema parity must be re-verified (the analysis found `0063+` unapplied on the inspected dev-test branch).

---

## 15. Week 1 Implementation Plan

**Day 1 — foundations & contracts**
- Confirm the module pattern against `kpi`/`dashboard`/`crm` exemplars; confirm `apps/api/src/zac/` location and `AuthModule` wiring.
- Draft the `ZacModule` skeleton plan (module/controller/service + folders per §3).
- Define the DTO + response contract (`zac-ask-request.dto.ts`, the `ZacResponse` shape §9).
- Confirm auth / acting-user integration (`SupabaseAuthGuard`, `@CurrentUser()`, `ZacActingContext` mapping §6). Design the `zac.access` catalogue addition (owner analysis of the domain package).

**Day 2 — context, roles, tool registry skeleton**
- Build `ZacContextService` + `scope-resolver` (reject salon-less; default aggregation to accessible locations).
- Build `ZacRoleProfileService` (owner/manager/stylist profiles + terminology).
- Build the `ZacToolRegistry` skeleton with permission-derived availability and per-tool re-check; register the first 1–2 read tools (Business Health, KPI Summary) — no model call yet, return raw evidence.

**Day 3 — model provider abstraction, response builder, error/uncertainty handling**
- Define `zac-model-provider.interface.ts` + a `stub-zac-provider` (deterministic, no API key) and the `anthropic-zac-provider` scaffold; `ZacModelRouter` (fast-tier default).
- Build `ZacResponseBuilder` producing the evidence-grounded contract; enforce the seven-part evidence rule and honest "insufficient data" refusals.
- Error/uncertainty handling: standard `HttpException` subclasses, `fail_closed` on permission/scope, `state_unavailable` on missing data.

**Day 4 — logging/data-model design**
- Design the `zac` schema tables (§13) as a **migration plan** (`0076_zac_access_permission.sql`, `0077_zac_foundation.sql` — next free numbers; `0071`–`0075` are the merged payroll migrations) authored **for review, not applied**.
- Define the memory/outcome/cost telemetry contracts (`ZacOutputLogger`, `ZacCostTelemetry`, `ZacOutcomeEvent`) and wire the measurement-spine events + cost event into the ask path (writing to a table if applied, else structured log).
- Define the PII-redaction plan for the global logging middleware (exclude/redact ZAC routes) **before** any endpoint is exposed.

**Day 5 — QLAB feasibility & acceptance**
- Run the QLAB/stock feasibility pass (`QlabFeasibilityService`): confirm applied schema + prod parity, run the data-population probe, produce a documented go/no-go. **No QLAB tool exposed.**
- Week 1 acceptance review against §15 criteria below.
- Prepare the Week 2 tools implementation plan (wire remaining read tools; apply migrations after review; add the two QLAB/stock read tools if the probe passed).

**Week 1 acceptance criteria:** `POST /zac/ask` behind the three-guard chain + `zac.access`; actor resolved once and threaded; role profile selection working; tool registry permission-filtered with per-tool re-check and **zero write tools**; commission stripped without the permission; provider abstraction returns a contract-shaped response (stub is fine); measurement + cost events emitted from the first interaction; ZAC routes excluded/redacted in the logging middleware; the whole controller dark behind `ZAC_ENABLED`; QLAB feasibility go/no-go documented. **No code was implemented in this document** — this is the plan the build follows.

---

## 16. Implementation Risks

| Risk | Mitigation |
|---|---|
| **Unstable / in-flight reporting services** | Wrap only STABLE, applied endpoints (dashboard, KPI, lab-analytics summary, inventory low-stock); treat lab-formula/split-tender surfaces as moving targets; re-verify prod parity (QC8). |
| **Permission complexity** (services re-check role+location, not the permission key) | Every tool independently re-checks its endpoint permission via `userHasAllPermissions`; encode required permissions in each tool contract; honour method-level `@RequirePermissions` overrides. |
| **Service-role DB risk** (RLS dormant; service-role bypasses it) | ZAC opens no reasoning-read DB client — it composes guarded services with the acting `AuthUser`; ZAC's own `zac.*` tables are ENABLE+FORCE RLS with a narrow service-role writer that hard-pins `business_id`. |
| **Raw data retention / privacy** (prompts/responses carry PII) | Store redacted content/refs by default; exclude/redact ZAC routes from the global logging middleware; verbatim capture opt-in, short-retention, separate table (D32). |
| **QLAB/stock instability** (unapplied `0063/0068/0069/0070`; empty retail; write-only waste_events) | Week-1 feasibility-only; expose at most two read tools in Week 2/3 gated on a population probe; take waste from `lab-analytics`, never `waste_events`; no retail insights. |
| **UI scope creep** | Web-only, one additive nav entry + one route, both flag-gated; defer stylist mobile + lab app; no reorder of V1.1 nav. |
| **LLM cost visibility** | Log `zac.cost_events` per call from day one; fast-tier default; per-tenant caching/budgets; configurable pricing constants (no hardcoded prices). |
| **V1.1 disruption** | Additive-only changes; no writes; migrations authored-for-review; no touching in-flight lab/split-tender modules; owners auto-hold `zac.access` so the feature flag is the true dark switch. |

---

## 17. Required Decisions Before Coding

Decisions Cosan (technical, blocking) and Oleksandr need locked before/at build start:

- **Final backend module location** — confirm `apps/api/src/zac/` (QC1). *(Recommended: yes.)*
- **Exact acting-user context object** — confirm the §6 field set and that tools call **injected services + re-check the permission** rather than loopback controllers (QC2). *(Recommended: services + re-check.)*
- **Permission list** — confirm `zac.access` shape, default grants (owner+manager, not stylist), and the data migration (next free number — `0075+`, since payroll holds `0071`–`0074`) to back-patch existing security levels (QC4).
- **Table naming / schema approach** — confirm the dedicated `zac` schema with FORCE-RLS vs `public.zac_*` prefixed tables; confirm `zac.kpi_snapshots` vs `analytics` for snapshots (QC5).
- **Which services are stable enough** — confirm dashboard/KPI/lab-analytics summary/inventory low-stock as the Phase-1 tool sources; confirm Utilisation is build-work (no endpoint).
- **LLM provider / env strategy** — confirm latest-Claude first provider, `ANTHROPIC_API_KEY` in `EnvConfig` + Railway, and the provider-agnostic interface; confirm a stub provider for local/tests.
- **Feature-flag strategy** — confirm `ZAC_ENABLED` (backend) + `VITE_ZAC_ENABLED` (web) as the dark switch (permission alone can't be, since owners auto-hold it).
- **QLAB/stock data readiness** — accept the Week-1 feasibility gate and the two-tool Week-2/3 boundary; re-verify prod parity.
- **Logging retention policy** — confirm no raw prompts/responses by default; confirm the middleware exclude/redact change; set retention windows for telemetry tables (QC7).
- **Audit-event naming / actor** — confirm `zac.*` telemetry stays out of `audit.activity_log`, and any mirrored critical event is human-attributed via `metadata.via='zac'` (no enum change) (QC6).

Luke's product decisions (terminology, assertiveness, dashboard-vs-report, first-priority metric) resolve in parallel and do **not** block scaffolding.

---

## 18. Final Recommendation

- **Start Phase 1 with the backend foundation first** — the `apps/api/src/zac/` module, ask endpoint, acting-user context, role-profile selector, permission-aware tool registry, model-provider abstraction, evidence-grounded response contract, and the memory/outcome/cost logging spine — before any UI polish or additional channels.
- **Keep the core tools stable** — wrap only applied, deterministic services (dashboard/KPI/lab-analytics/inventory); the model narrates, never computes; every tool re-checks its own permission and is read-only.
- **Keep QLAB/stock feasibility controlled** — Week-1 feasibility pass, at most two read tools in Week 2/3 gated on a data-population probe; defer all forecasting/ordering/expiry.
- **No write actions. No autonomous actions. No advanced prediction.** Read-only is structural (zero write tools registered); recommendations are surfaced, never executed.
- **Protect the V1.1 roadmap** — additive-only, web-only, flag-gated; migrations authored for review; no touching in-flight lab/split-tender work; production parity re-verified before freezing tool contracts.

This is the smallest foundation that is *correct on the irreversible decisions* (in-API module, acting-user JWT, permission-aware guarded tools, measurement + cost spine, absolute tenant privacy) — proving trust before autonomy, exactly as Phase 1 requires.

---

*Documentation only. This file created no application source code, migrations, environment files, package manifests, or Supabase data, and stages/commits nothing. It operationalises [`phase-1-backend-foundation-architecture-analysis.md`](phase-1-backend-foundation-architecture-analysis.md) and the Phase 0 decision set into a concrete build plan.*
