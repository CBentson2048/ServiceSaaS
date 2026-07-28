# ZAC Phase 1 Week 1 Backend Foundation Task Breakdown

> **Nature of this document.** A practical, Wrike/GitHub-convertible Week 1 task breakdown for building the ZAC Phase 1 backend foundation. Derived from [`phase-1-backend-foundation-architecture-analysis.md`](phase-1-backend-foundation-architecture-analysis.md) and [`phase-1-backend-foundation-technical-approach.md`](phase-1-backend-foundation-technical-approach.md) (the `phase-1-mvp-implementation-plan.md` referenced by the task does not exist in the repo). **This planning file changes no source code, migrations, env, or packages, and stages/commits nothing.**
>
> Date: 2026-07-24 · Phase 1 is **read-only** end-to-end. Week 1 is a **design + skeleton** week: module skeleton, contracts, and a feasibility pass — **no write tools, no unrestricted DB access, no autonomous actions**. Any DB schema is *authored for review, not applied*.
>
> ⚠️ **Migration-number note:** `0071`–`0074` are already taken by the in-flight payroll work (`0071_payroll_foundation` … `0074_payroll_permissions`), so ZAC's migrations are **`0075+`** — take the actual next-free number at authoring time.
>
> **Owners:** Cosan (technical lead — backend/auth/DB/service mapping/V1.1 review) · Oleksandr (ZAC contracts — role profiles/response/tools/memory/telemetry/eval).

---

## 1. Week 1 Goal

Create the **safe server-side foundation** for ZAC inside QLOOQO — the first, correct-on-the-irreversibles slice, not the full agent.

Week 1 delivers:
- ZAC module skeleton (`apps/api/src/zac/`).
- Ask endpoint design + request/response contract.
- Acting-user context resolver design.
- Role profile selector design (Owner/Manager/Stylist).
- Permission-aware tool registry skeleton.
- Model provider abstraction (provider-agnostic; first provider = latest Claude).
- Response builder + evidence/confidence/limitations format.
- Logging / memory / outcome / cost telemetry design.
- QLAB/stock feasibility review plan.
- **No write actions. No unrestricted database access.**

---

## 2. Week 1 Acceptance Criteria

Week 1 is complete when all of the following are confirmed (design + skeleton, not full implementation):

- [ ] **ZAC backend module location confirmed** — `apps/api/src/zac/`, registered in `app.module.ts`; auto-compiled (no build-config change).
- [ ] **Ask endpoint design confirmed** — `POST /api/zac/ask` behind `SupabaseAuthGuard, RolesGuard, PermissionsGuard` + `@RequirePermissions('zac.access')`, class `@RequireRoles('owner','manager')`.
- [ ] **Acting-user context fields confirmed** — `actor_user_id (=AuthUser.id)`, `business_id`, `location_id?`/`accessible_location_ids`, `role`/`roles[]`, `permissions`, `feature_flags`, `request_source`, `timezone`, `locale`.
- [ ] **Owner/Manager/Stylist role contexts supported** — role profile selector maps each to behaviour + terminology (Insight / Coaching Point / Opportunity / Risk / Watch Point).
- [ ] **`zac.access` permission approach confirmed** — first-class catalogue key; owner+manager default, not stylist; owners auto-hold it (so a feature flag is the dark switch).
- [ ] **Underlying tool permission rule confirmed** — every tool independently re-checks its endpoint permission (services skip the permission-key check); `zac.access` never overrides underlying permissions.
- [ ] **No unrestricted DB access path** — ZAC composes guarded `*Service` methods with the acting `AuthUser`; no service-role client for reads.
- [ ] **No write tools** — the tool registry registers zero write tools; read-only is structural.
- [ ] **Initial ZAC data model confirmed** — `zac` schema table set (or `zac_*` prefixed fallback), FORCE-RLS, `business_id` on every table; authored for review, **not applied**.
- [ ] **Model provider abstraction confirmed** — `zac-model-provider.interface.ts` + stub provider + latest-Claude scaffold; configurable pricing constants (no hardcoded prices).
- [ ] **QLAB/stock feasibility pass started** — applied-schema + prod-parity check and data-population probe run; documented go/no-go (no QLAB tool exposed).
- [ ] **V1.1 disruption-control rules respected** — additive-only, web-only, flag-gated; no writes; no touching in-flight lab/split-tender/payroll work; migrations authored for review only.

---

## 3. Task List

Task IDs are `ZAC-W1-<letter>`. Format per the requested template. Hours are per-task estimates for a two-person week (design/skeleton, not full build).

---

### ZAC-W1-A · Repository and backend module confirmation
- **Owner:** Cosan
- **Goal:** Confirm ZAC's home and that it slots into the existing NestJS conventions with zero build-config/workspace change.
- **Implementation notes:** Verify the module pattern against `kpi`/`dashboard`/`crm` exemplars; confirm `nest-cli.json` `sourceRoot:src` auto-compiles `src/zac/`; confirm `AuthModule` exports every guard + `AuthService`; confirm `DashboardService` needs a one-line `exports` add if injected. Re-verify prod schema parity (QC8) since the analysis was against dev-test.
- **Files likely involved:** `apps/api/src/app.module.ts`, `apps/api/nest-cli.json`, `apps/api/tsconfig.json`, `apps/api/src/kpi/*`, `apps/api/src/auth/auth.module.ts`.
- **Dependencies:** none (entry task).
- **Acceptance criteria:** Written confirmation that `apps/api/src/zac/` is the location; registration = one import line; prod-parity check logged.
- **Risk level:** Low
- **Estimated hours:** 3

---

### ZAC-W1-B · ZAC module skeleton
- **Owner:** Oleksandr (Cosan reviews structure)
- **Goal:** Scaffold the empty `ZacModule` (module/controller/service/dto folders) following house conventions.
- **Implementation notes:** Create the folder tree from technical-approach §3 (context/, roles/, tools/, models/, responses/, memory/, measurement/, prompts/, qlab/). Controller with the three-guard chain + `@RequirePermissions('zac.access')`, `@CurrentUser() actor: AuthUser`. Per-class `Logger`. No business logic yet — wiring only. Gate the whole controller behind a `ZAC_ENABLED` env check.
- **Files likely involved (new):** `apps/api/src/zac/zac.module.ts`, `zac.controller.ts`, `zac.service.ts`, `dto/*`.
- **Dependencies:** ZAC-W1-A.
- **Acceptance criteria:** `nest build` compiles; a guarded `POST /api/zac/ask` stub returns a placeholder; a user without `zac.access` gets 403; a `client`-role user is denied; controller dark when `ZAC_ENABLED=false`.
- **Risk level:** Low
- **Estimated hours:** 5

---

### ZAC-W1-C · ZAC ask endpoint contract
- **Owner:** Joint (Oleksandr drafts contract; Cosan confirms auth integration)
- **Goal:** Lock the `POST /api/zac/ask` request/response DTOs and the endpoint set (required vs optional).
- **Implementation notes:** Request: `question (@MaxLength)`, `conversationId?`, `requestSource?`, `locationId?` (validated against scope). Response: the full ZAC response contract (§ technical-approach 9). Confirm Phase-1 **required** (`/ask`, `/feedback`, `/health`) vs **optional** (`/conversations(/:id)`, `/suggested-prompts`). Global `ValidationPipe` enforces DTOs (`forbidNonWhitelisted`).
- **Files likely involved:** `apps/api/src/zac/dto/zac-ask-request.dto.ts`, `zac-ask-response.dto.ts`; shared types candidate in `packages/domain`.
- **Dependencies:** ZAC-W1-B, ZAC-W1-I.
- **Acceptance criteria:** DTOs defined with `class-validator`; endpoint list agreed and documented; unknown fields rejected by the pipe.
- **Risk level:** Low
- **Estimated hours:** 4

---

### ZAC-W1-D · Acting-user context resolver
- **Owner:** Cosan
- **Goal:** Design `ZacContextService` that maps the guard-resolved `AuthUser` into `ZacActingContext` and rejects invalid actors.
- **Implementation notes:** Map every §6 field (note `actor_user_id ← AuthUser.id`, not `userId`). Reject `businessId === ''` (salon-less). **No single active location** — default to `accessible_location_ids` and record which locations were aggregated; validate any supplied `locationId` against `allowedLocationIds` (owners excepted). Resolve the actor once at the controller boundary and thread it through the turn (avoid per-tool re-auth cost). `locale` defaults to `en-GB` (gap — `AuthUser` has no locale).
- **Files likely involved:** `apps/api/src/zac/context/zac-context.service.ts`, `zac-context.types.ts`, `scope-resolver.service.ts`; reads `apps/api/src/auth/*`, `packages/domain/src/index.ts`.
- **Dependencies:** ZAC-W1-B.
- **Acceptance criteria:** `ZacActingContext` type + resolver design signed off; salon-less rejection and location-scope validation specified; single-resolve pattern confirmed.
- **Risk level:** Medium
- **Estimated hours:** 5

---

### ZAC-W1-E · Role profile selector
- **Owner:** Oleksandr
- **Goal:** Design `ZacRoleProfileService` mapping role → behaviour, terminology, assertiveness, default aggregation scope.
- **Implementation notes:** Owner (business-wide), Manager (location-scoped), Stylist (self-only, deferred surface). Terminology per D19 (Insight / Coaching Point / Opportunity / Risk / Watch Point). Enforce the permanent human boundaries (D40): no employment/HR/legal decisions, no shaming. Gate capabilities on `roles[]`, not a single role; use `primaryRole` only for default profile.
- **Files likely involved:** `apps/api/src/zac/roles/zac-role-profile.service.ts`, `zac-role-profile.types.ts`, `prompts/{owner,manager,stylist}.profile.ts`, `prompts/constitution-policy.ts`.
- **Dependencies:** ZAC-W1-D.
- **Acceptance criteria:** Three role profiles defined with terminology + assertiveness + scope; boundary policy documented.
- **Risk level:** Low
- **Estimated hours:** 4

---

### ZAC-W1-F · Permission-aware tool registry skeleton
- **Owner:** Joint (Cosan permission integration; Oleksandr tool contract)
- **Goal:** Skeleton `ZacToolRegistry` that derives available tools from `actor.permissions[]` **before** the model runs, and re-checks per tool at dispatch.
- **Implementation notes:** `buildFor(actor)` returns only tools whose `required_permissions` the actor holds (`userHasAllPermissions`) and whose `allowed_roles` include one of `actor.roles`. Each tool re-checks its permission at dispatch (closes the service-layer permission-key gap) and re-asserts `zac.access`. **Register zero write tools.** No model decision on permissions — the platform decides.
- **Files likely involved:** `apps/api/src/zac/tools/zac-tool-registry.service.ts`, `zac-tool.types.ts`; reads `packages/domain` helpers.
- **Dependencies:** ZAC-W1-D, ZAC-W1-G, ZAC-W1-P.
- **Acceptance criteria:** Registry filters by permission/role; per-tool re-check enforced; zero write tools registered; unit test proves a manager without `report.commission.view` cannot receive a commission-bearing tool.
- **Risk level:** Medium
- **Estimated hours:** 5

---

### ZAC-W1-G · Read-only tool base interface
- **Owner:** Oleksandr
- **Goal:** Define the standard `ZacToolContract` (14-field) all tools implement.
- **Implementation notes:** Fields: `name`, `description`, `allowed_roles`, `required_permissions`, `input_schema`, `output_schema`, `evidence_refs`, `read_only:true`, `sensitive_fields`, `error_behavior:'fail_closed'`, `fallback_behavior:'state_unavailable'` (+ `pii_level`, `cache_policy per-tenant`, `rate_limit`). Tools call injected `*Service` methods with the acting `AuthUser`; never open a Supabase client; never trust a model-supplied `business_id`/`locationId`.
- **Files likely involved:** `apps/api/src/zac/tools/zac-tool.types.ts`; stubs under `tools/tools/*.tool.ts`.
- **Dependencies:** ZAC-W1-B.
- **Acceptance criteria:** `ZacToolContract` type defined; one reference tool stub (Business Health) implements it against `DashboardService`.
- **Risk level:** Low
- **Estimated hours:** 4

---

### ZAC-W1-H · Model provider abstraction
- **Owner:** Oleksandr (Cosan confirms env strategy)
- **Goal:** Provider-agnostic `zac-model-provider.interface.ts` + a stub provider + latest-Claude scaffold + `ZacModelRouter`.
- **Implementation notes:** Interface so providers are swappable (A3). First concrete provider targets latest Claude; a deterministic `stub-zac-provider` runs locally/tests with no API key. Router: fast-tier default, reasoning escalation only on complexity signals. Configurable pricing constants in `zac-model-pricing.config.ts` — **no hardcoded vendor prices** (D33). Add `ANTHROPIC_API_KEY` (`@IsOptional`) to `EnvConfig` design (do not commit env).
- **Files likely involved:** `apps/api/src/zac/models/zac-model-provider.interface.ts`, `zac-model-router.service.ts`, `providers/{anthropic-zac,stub-zac}-provider.ts`, `zac-model-pricing.config.ts`; design note against `apps/api/src/config/env.validation.ts`.
- **Dependencies:** ZAC-W1-B; joint env decision (§7).
- **Acceptance criteria:** Interface + stub provider return a contract-shaped response with no network call; router selects a tier; pricing is config-driven.
- **Risk level:** Medium
- **Estimated hours:** 5

---

### ZAC-W1-I · Response builder contract
- **Owner:** Oleksandr
- **Goal:** Design `ZacResponseBuilder` producing the standard ZAC response.
- **Implementation notes:** Assemble `answer`, `role_context`, `response_type`, `evidence[]`, `confidence`, `limitations[]`, `suggested_next_step` (advisory only — never executed), `measurement_hook`, `attribution_seed`, `memory_updates[]`, `tool_calls[]`, `cost_metadata`, `trace_id`. Model narrates; **never computes** — numbers come from the deterministic KPI engine/services.
- **Files likely involved:** `apps/api/src/zac/responses/zac-response-builder.service.ts`, `zac-response.types.ts`.
- **Dependencies:** ZAC-W1-G.
- **Acceptance criteria:** Response type defined; the seven response types enumerated (Insight, Coaching Point, Opportunity, Risk, Watch Point, Explanation, Refusal/Insufficient Data); a sample response validates against the schema.
- **Risk level:** Low
- **Estimated hours:** 4

---

### ZAC-W1-J · Evidence/confidence/limitations response format
- **Owner:** Oleksandr
- **Goal:** Define the evidence contract and enforce the seven-part evidence rule.
- **Implementation notes:** Evidence item `{ source_type, source_ref, as_of, entities_used (no raw PII) }`. Confidence (High/Medium/Low) **derived** from data completeness, attribution strength, sample size, window fit, prior outcomes — shown alongside, not hidden. Any factual claim missing one of the seven parts (source · metric · evidence · attribution · confidence · method · limitations) is flagged or withheld. Missing data → "no data captured yet", never invented.
- **Files likely involved:** `apps/api/src/zac/responses/zac-response.types.ts`.
- **Dependencies:** ZAC-W1-I.
- **Acceptance criteria:** Evidence/confidence/limitations schema defined; a refusal path for insufficient data specified; rule documented with examples.
- **Risk level:** Low
- **Estimated hours:** 3

---

### ZAC-W1-K · Memory item contract
- **Owner:** Oleksandr
- **Goal:** Define the memory record contract and visibility scopes.
- **Implementation notes:** Business Memory (survives with business) vs Personal Memory (moves with individual). Every row carries `business_id`, `created_by`, `source`, `visibility_scope`, and is deletable/reviewable. Scopes: `user_private`, `business_owner`, `manager_team_theme`, `stylist_private`, `system_safe_summary`. Store redacted summaries/refs — **not raw sensitive content by default** (D32). Private stylist coaching notes live in a table with **no owner/manager read path**; owners/managers get aggregate themes only.
- **Files likely involved:** `apps/api/src/zac/memory/zac-memory.types.ts`, `zac-memory.service.ts` (design/stub).
- **Dependencies:** ZAC-W1-O.
- **Acceptance criteria:** Memory contract + five scopes defined; stylist-private isolation specified; default-redaction rule documented.
- **Risk level:** Medium
- **Estimated hours:** 4

---

### ZAC-W1-L · Output/insight logging contract
- **Owner:** Oleksandr
- **Goal:** Define the output/insight record and its lifecycle events (the measurement spine).
- **Implementation notes:** `zac.recommendations` (Insight/Coaching Point/Opportunity/Risk/Watch Point) with `type`, `title`, `why`, `evidence`, `expected_outcome`, `metric_to_measure`, `confidence`, `status`. Lifecycle events (`created/shown/accepted/dismissed/ignored/expired`). Emit the spine events (`conversation_started`, `question_asked`, `answer_delivered`, `source_used`, …) from the first interaction — unrecoverable if not captured. Separate from `audit.activity_log` (D27); fail-soft writer **with alerting**.
- **Files likely involved:** `apps/api/src/zac/measurement/zac-output-logger.service.ts` (design/stub).
- **Dependencies:** ZAC-W1-O.
- **Acceptance criteria:** Output record + event vocabulary defined; separation from audit confirmed; alerting-on-write-failure requirement noted.
- **Risk level:** Low
- **Estimated hours:** 3

---

### ZAC-W1-M · Outcome event contract
- **Owner:** Oleksandr
- **Goal:** Define the outcome/attribution-seed record (Value Created foundation — logging only).
- **Implementation notes:** `zac.observed_outcomes` + `zac.recommendation_outcomes` with `outcome_type`, `target_entity_type/id?`, `observed_value`, `confidence`, `attribution_type` (Observed / Influenced / Directly Attributable), `evidence`, `observed_at`; `recommendation_id` **nullable**. Reuse existing hooks read-only (`booking.rebooking_outcomes.rebook_source`, `booking.appointments.booking_channel`) — do not write them in Phase 1 (`rebook_source` CHECK excludes `'zac'`; `'api'` channel already used). Value computation deferred; log foundation only.
- **Files likely involved:** `apps/api/src/zac/measurement/zac-outcome-event.service.ts` (design/stub).
- **Dependencies:** ZAC-W1-O.
- **Acceptance criteria:** Outcome record + three attribution types defined; nullable `recommendation_id`; read-only hook reuse documented; "logging foundation only" scope confirmed.
- **Risk level:** Medium
- **Estimated hours:** 3

---

### ZAC-W1-N · Cost telemetry contract
- **Owner:** Oleksandr (Cosan confirms table)
- **Goal:** Define `zac.cost_events` and the per-call telemetry captured by the model router.
- **Implementation notes:** Fields: `provider`, `model`, `task_type`, `role_context`, `input_tokens`, `output_tokens`, `reasoning_tokens`, `estimated_cost` (from config constants), `latency_ms`, `tool_calls_used`, `cache_hit`, `business_id`, `actor_user_id`, `conversation_id`. No prompt/response text. Controls from launch: fast-tier default, per-tenant caching only, per-tenant budgets, escalation logging (`zac.model.escalated`). USD cost vs GBP `*_cents` value kept separate with a recorded FX assumption.
- **Files likely involved:** `apps/api/src/zac/measurement/zac-cost-telemetry.service.ts` (design/stub); wires into `ZacModelRouter`.
- **Dependencies:** ZAC-W1-H, ZAC-W1-O.
- **Acceptance criteria:** Cost-event schema defined; router emits one cost event per call (to table or structured log); no raw content in cost rows.
- **Risk level:** Low
- **Estimated hours:** 3

---

### ZAC-W1-O · Supabase/table design review
- **Owner:** Cosan
- **Goal:** Design the `zac` schema table set as a migration plan — **authored for review, not applied**.
- **Implementation notes:** Dedicated `zac` schema (or `public.zac_*` fallback), RLS **ENABLED + FORCED** (stronger than the dormant platform RLS). Common columns: `business_id not null`, `location_id?`, `actor_user_id`, `role_context`, `visibility_scope`, timestamps. Tables: `conversations`, `messages`(+`message_events`), `tool_calls`, `memory`, `stylist_coaching_notes` (no owner/manager SELECT), `recommendations` + `recommendation_events`, `feedback`, `observed_outcomes` + `recommendation_outcomes`, `cost_events`, `kpi_snapshots` (design). Migration numbers **`0075+`** (payroll holds `0071`–`0074`). Add `zac` to `config.toml` + each project's Exposed Schemas (else `PGRST106`). File-based; **never via MCP DDL; do not apply in Week 1**.
- **Files likely involved (design only):** draft `supabase/migrations/0076_zac_access_permission.sql`, `0077_zac_foundation.sql` (authored for review, not applied); reference `supabase/config.toml`, `0057`/`0058` for the JSONB-append pattern.
- **Dependencies:** ZAC-W1-A, ZAC-W1-P.
- **Acceptance criteria:** Table list + columns + indexes + RLS posture reviewed and signed off; migration numbering set to `0075+`; explicitly not applied.
- **Risk level:** High
- **Estimated hours:** 6

---

### ZAC-W1-P · `zac.access` permission review
- **Owner:** Cosan (Joint decision on defaults)
- **Goal:** Confirm how `zac.access` is added and granted without breaking existing guards.
- **Implementation notes:** Add to the `Permission` union + `PERMISSION_CATALOG` (`packages/domain/src/index.ts`); add to `DEFAULT_ROLE_PERMISSIONS` (owner+manager) and `SYSTEM_SECURITY_LEVELS`; a data migration (`0075+`) appends `'zac.access'` to existing DB `core.security_levels` rows (modelled on `0057`/`0058`). Rebuild `@sheer/domain` dist. **Owners auto-hold it** via the `ALL_PERMISSIONS` short-circuit → the feature flag, not the permission, is the dark switch. `zac.access` must NOT override underlying report/CRM permissions.
- **Files likely involved (design/skeleton):** `packages/domain/src/index.ts`; draft migration `0076_zac_access_permission.sql`.
- **Dependencies:** ZAC-W1-A.
- **Acceptance criteria:** `zac.access` addition plan approved (union + catalogue + defaults + system levels + migration + dist rebuild); per-tool re-check rule reaffirmed; owner-auto-hold implication documented.
- **Risk level:** Medium
- **Estimated hours:** 4

---

### ZAC-W1-Q · Stable reporting/KPI service mapping
- **Owner:** Cosan
- **Goal:** Confirm which report/KPI services are stable enough to wrap and the exact permission each tool must re-check.
- **Implementation notes:** Map: Business Health → `DashboardService.kpis` (+`LabAnalyticsService.summary`), KPI Summary → `KpiService.stylistList`, Stylist Performance → `DashboardService.stylistPerformance`, Personal Coaching → `KpiService.myKpi`. Note the method-override rule and the `/kpi/performance` commission leak → strip commission unless `report.commission.view`; strip pay unless `staff.pay.manage`. Add `exports: [DashboardService]` if injected. Numbers are deterministic (`kpi.calc.ts`) — model never recomputes.
- **Files likely involved:** `apps/api/src/{kpi,dashboard,lab-analytics}/*` (read); `dashboard.module.ts` (one-line exports add).
- **Dependencies:** ZAC-W1-A.
- **Acceptance criteria:** Service→tool→permission map documented; commission/pay redaction rules confirmed; stable-vs-uncertain surfaces flagged.
- **Risk level:** Medium
- **Estimated hours:** 4

---

### ZAC-W1-R · Rebooking/utilisation/stylist service mapping
- **Owner:** Cosan
- **Goal:** Map the rebooking, utilisation, and stylist-performance data paths and flag gaps.
- **Implementation notes:** Rebooking Summary wraps dashboard/KPI reducers over `rebook_source` (the `rebooking` module has no controller). Overdue-client reuses the `clientAlreadyRebooked` inverse + per-service nudge interval. **Utilisation has NO server endpoint** — `computeDailyUtilisation` is browser-only → register the tool **disabled** (build-work, not a wrapper). `no_show` never written (≈0). Stylist self-scoping via `staffProfileId`.
- **Files likely involved:** `apps/api/src/{rebooking,rota}/*`, `apps/api/src/communications/notification-dispatch.service.ts`, `packages/domain` `computeDailyUtilisation` (read).
- **Dependencies:** ZAC-W1-Q.
- **Acceptance criteria:** Rebooking/overdue path documented; utilisation flagged as build-work (disabled tool); data-quality caveats (no_show≈0, rebooking lower-bound) captured.
- **Risk level:** Medium
- **Estimated hours:** 3

---

### ZAC-W1-S · QLAB/stock feasibility review
- **Owner:** Joint (Cosan feasibility/parity check; Oleksandr insight criteria)
- **Goal:** Run the Week-1 QLAB/stock feasibility pass and produce a documented go/no-go — **no tool exposed**.
- **Implementation notes:** Confirm applied schema in the target env (dev-test newest applied = `0062`; `0063/0068/0069/0070` not applied) and **re-verify prod parity (QC8)**. Data-population probe: saved `lab.formulas`? initialised `location_stock` + thresholds? any `retail_sales` rows (expect none)? Stable candidates: `LabAnalyticsService.summary` (immune to draft work; waste from `formulas.waste_cost_cents`, **not** write-only `waste_events`) and inventory low-stock. Defer forecasting/ordering/expiry (no data model).
- **Files likely involved:** `apps/api/src/{lab-analytics,inventory,retail-sales}/*` (read); `apps/api/src/zac/qlab/qlab-feasibility.service.ts` (design/stub).
- **Dependencies:** ZAC-W1-A.
- **Acceptance criteria:** Go/no-go per signal documented; prod-parity result logged; Week-2/3 boundary (≤2 read tools, gated on probe) confirmed; nothing exposed in Week 1.
- **Risk level:** High
- **Estimated hours:** 5

---

### ZAC-W1-T · V1.1 disruption-control review
- **Owner:** Cosan
- **Goal:** Confirm ZAC introduces no risk to the in-flight V1.1 (and payroll) work.
- **Implementation notes:** Additive-only; web-only; flag-gated. No writes; no touching in-flight `lab-formula`/`lab-appointments`/`crm`/`mobile-dashboard`/split-tender/**payroll (`0071`–`0074`)** work. Migrations authored for review only (`0075+`). No new `APP_GUARD`/`APP_FILTER`/`APP_INTERCEPTOR`. `@sheer/domain` change requires a dist rebuild. Web nav = one additive entry, no reorder. Exclude/redact ZAC routes from the global request/response logging middleware before any endpoint ships.
- **Files likely involved:** `apps/api/src/app.module.ts`, `common/request-response-logging.middleware.ts`, `apps/web/src/components/Sidebar.tsx` (read).
- **Dependencies:** ZAC-W1-A.
- **Acceptance criteria:** Disruption-control checklist signed off; logging-middleware PII exclusion plan agreed; migration-number collision with payroll explicitly noted (`0075+`).
- **Risk level:** Medium
- **Estimated hours:** 3

---

### ZAC-W1-U · Week 1 technical review with Cosan
- **Owner:** Joint
- **Goal:** Review all Week-1 designs/skeletons against the acceptance criteria (§2) and the joint decisions (§7).
- **Implementation notes:** Walk each acceptance checkbox; confirm the Cosan technical decisions (QC1/QC2/QC4/QC5/QC6/QC7/QC8) are answered or scheduled; confirm no write tools and no service-role read path exist; confirm QLAB is feasibility-only.
- **Files likely involved:** this breakdown; both input design docs.
- **Dependencies:** ZAC-W1-A…T.
- **Acceptance criteria:** Every §2 item ticked or a follow-up logged; joint decisions (§7) recorded; sign-off captured.
- **Risk level:** Low
- **Estimated hours:** 3

---

### ZAC-W1-V · Week 2 readiness checklist
- **Owner:** Joint
- **Goal:** Produce the Week-2 entry checklist and the Week-2 tools implementation plan.
- **Implementation notes:** Confirm the §9 entry criteria are met; list Week-2 work: apply migrations `0076/0077` after review, wire the remaining read tools, add the two QLAB/stock read tools **if the probe passed**, add persistence for the measurement/cost spine, add the web feature-flag entry (`VITE_ZAC_ENABLED` + one nav entry + one route).
- **Files likely involved:** this breakdown; a new `phase-1-week-2-*.md` (later).
- **Dependencies:** ZAC-W1-U.
- **Acceptance criteria:** Week-2 entry checklist complete; Week-2 task list drafted; go/no-go for Week 2 recorded.
- **Risk level:** Low
- **Estimated hours:** 2

---

**Estimated total:** ~89 hours across two people over five days (≈44–45h each) — comfortably a design/skeleton week with slack for reviews.

---

## 4. Suggested Daily Plan

**Day 1 — foundations & contracts**
- ZAC-W1-A Repository/module confirmation (Cosan)
- ZAC-W1-B ZAC module skeleton (Oleksandr)
- ZAC-W1-C Ask endpoint contract (Joint)
- ZAC-W1-D Acting-user context resolver (Cosan)

**Day 2 — roles, registry, tool base**
- ZAC-W1-E Role profile selector (Oleksandr)
- ZAC-W1-P `zac.access` permission review (Cosan) *(pulled earlier as a dependency of F)*
- ZAC-W1-F Permission-aware tool registry skeleton (Joint)
- ZAC-W1-G Read-only tool base interface (Oleksandr)

**Day 3 — model, response, evidence**
- ZAC-W1-H Model provider abstraction (Oleksandr)
- ZAC-W1-I Response builder contract (Oleksandr)
- ZAC-W1-J Evidence/confidence/limitations format (Oleksandr)

**Day 4 — memory/outcome/cost + tables + permission**
- ZAC-W1-K Memory item contract (Oleksandr)
- ZAC-W1-L Output/insight logging contract (Oleksandr)
- ZAC-W1-M Outcome event contract (Oleksandr)
- ZAC-W1-N Cost telemetry contract (Oleksandr)
- ZAC-W1-O Supabase/table design review (Cosan)

**Day 5 — service mapping, QLAB, reviews**
- ZAC-W1-Q Stable reporting/KPI service mapping (Cosan)
- ZAC-W1-R Rebooking/utilisation/stylist service mapping (Cosan)
- ZAC-W1-S QLAB/stock feasibility review (Joint)
- ZAC-W1-T V1.1 disruption-control review (Cosan)
- ZAC-W1-U Week 1 technical review (Joint)
- ZAC-W1-V Week 2 readiness checklist (Joint)

> Note: `zac.access` review (P) is scheduled on Day 2 because the tool registry (F) and table design (O) both depend on it.

---

## 5. Cosan Responsibilities

- **Backend structure confirmation** — module location, registration, conventions (A, B-review).
- **Auth/permission integration** — acting-user context resolver, guard chain, `zac.access` addition (D, P).
- **Supabase/table approach** — `zac` schema design, FORCE-RLS, migration numbering `0075+`, exposed-schemas (O).
- **Service mapping** — which report/KPI/booking/rebooking services are stable to wrap + the permission each tool re-checks (Q, R).
- **V1.1 dependency review** — no disruption to in-flight lab/split-tender/payroll; additive-only; logging-middleware PII exclusion (T).
- **QLAB/stock feasibility check** — applied-schema + prod-parity verification, population probe (S, joint).
- **UI entry / feature-flag approach** — backend `ZAC_ENABLED` kill-switch; web additive nav entry; confirm the flag (not the permission) is the dark switch.

---

## 6. Oleksandr Responsibilities

- **Role profile design** — Owner/Manager/Stylist behaviour, terminology, assertiveness, boundaries (E).
- **Response contract** — the evidence-grounded response builder + types (I, J).
- **Prompt behaviour** — constitution/role prompts; model narrates, never computes; honest "insufficient data" refusals (E, I).
- **Tool contract design** — the 14-field `ZacToolContract`, read-only base, per-tool permission re-check (G, F-joint).
- **Memory/outcome/cost structure** — memory scopes, output/insight logging, outcome events, cost telemetry (K, L, M, N).
- **QLAB/stock insight criteria** — what colour/stock signals are trustworthy enough to surface, gated on the population probe (S, joint).
- **Evaluation scenarios** — Owner/Manager/Stylist test questions + expected evidence-grounded shapes to validate Week-1 skeleton behaviour.

---

## 7. Joint Decisions Needed

| # | Decision | Recommended default (from the design docs) |
|---|---|---|
| 1 | **`zac` schema vs prefixed tables** | Dedicated `zac` schema, FORCE-RLS (QC5). |
| 2 | **Exact `zac.access` implementation** | Catalogue key + owner/manager defaults + `0075` data migration; owners auto-hold → flag is the dark switch (QC4). |
| 3 | **Raw messages vs safe summaries** | Redacted summaries/refs by default; verbatim only opt-in, short-retention, separate table (D32/QC7). |
| 4 | **Stable services for Week 2** | Dashboard/KPI/lab-analytics summary/inventory low-stock; Utilisation is build-work. |
| 5 | **QLAB/stock inclusion level** | Week-1 feasibility-only; ≤2 read tools Week 2/3 gated on the population probe. |
| 6 | **Model provider & env strategy** | Provider-agnostic interface; latest Claude first; `ANTHROPIC_API_KEY` in `EnvConfig`+Railway; stub provider for local/tests. |
| 7 | **UI feature-flag strategy** | Backend `ZAC_ENABLED` + web `VITE_ZAC_ENABLED`; web-only, additive nav entry; defer stylist mobile + lab app. |

---

## 8. Out of Scope for Week 1

- Final UI (web-only entry mechanism only; no polished UX).
- Write actions of any kind.
- Autonomous actions.
- WhatsApp / SMS / voice / phone channels.
- Full RAG / vector/semantic retrieval (rule-based/metadata only).
- Full Value Created automation / ROI engine (logging foundation only).
- Advanced QLAB/stock prediction (forecasts, days-of-cover, over-ordering).
- Stock ordering automation / supplier purchasing workflows.
- Applying any migration (authored for review only).
- Durable scheduler / periodic KPI-snapshot job / attribution reconciler runtime.
- Stylist mobile surface and the lab (PIN-session) app.

---

## 9. Week 2 Entry Criteria

Week 2 starts **only if**:

- [ ] Backend foundation design is accepted (module, endpoint, context, guards) — ZAC-W1-U signed off.
- [ ] Core tool contracts are approved (14-field contract + per-tool permission re-check; zero write tools).
- [ ] Stable services are identified (Business Health, KPI, Stylist Performance, Rebooking) with their required permissions.
- [ ] Table/memory/logging approach is confirmed (`zac` schema + FORCE-RLS; scopes; default-redaction; migrations `0075+` authored for review).
- [ ] QLAB/stock feasibility status is clear (documented go/no-go + prod parity).
- [ ] V1.1 disruption risk is acceptable (additive-only, flag-gated, no in-flight collisions, logging-middleware PII exclusion agreed).
- [ ] Joint decisions (§7) are recorded and the blocking Cosan technical questions (QC1/QC2/QC4/QC5/QC6/QC7/QC8) are answered or scheduled.

If any box is unchecked, resolve it before starting Week 2 rather than carrying the risk forward.

---

*Documentation only. This file created no application source code, migrations, environment files, package manifests, or Supabase data, and stages/commits nothing. It converts [`phase-1-backend-foundation-architecture-analysis.md`](phase-1-backend-foundation-architecture-analysis.md) and [`phase-1-backend-foundation-technical-approach.md`](phase-1-backend-foundation-technical-approach.md) into a Week-1 task breakdown.*
