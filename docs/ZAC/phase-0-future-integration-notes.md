# ZAC — Phase 0 Future Integration Notes

> **Status: Documentation only — NOT implemented.**
> This document is the bridge between the Day 2 architecture design and the actual QLOOQO codebase. It exists so that when implementation is **later authorised**, a future team can integrate ZAC quickly and safely. **Nothing here has been built.** No module, migration, permission, schema, env var, or package change described below exists yet.
>
> Date: 2026-07-20 · Companion to [`phase-0-day-2-core-architecture.md`](phase-0-day-2-core-architecture.md) and the Day 1 [Discovery Report](QLOOQO/ZAC%20Phase%200%20Discovery%20Report.md).

---

## 0. Guardrails for whoever picks this up

Before writing any code against this design, confirm the following are still true and still authorised:

- **Do not implement from this document alone.** These are Phase 0 proposals. Implementation requires explicit go-ahead and the open questions (decision log §4–§5) answered.
- **Never give ZAC a service-role key.** DB-level tenant isolation is dormant (RLS defined but `FORCE RLS` off; every service uses the service-role key). ZAC must authenticate as the acting user's JWT and read through the guarded API. This is the single most consequential constraint (Day 1 §6, §12D, §18).
- **Re-verify production parity first.** All Day 1 data-readiness findings (empty tables, row counts, RLS state) come from the **dev-test** Supabase branch, not prod "Sheer V1". Confirm before planning (Day 1 §18, §20 Q10).
- **Migrations are files, not MCP.** When schema work is eventually authorised, it must be added as sequential migration files under `supabase/migrations/` and applied via the CLI — never applied ad-hoc through the Supabase MCP. (Project convention.)

---

## 1. Where ZAC attaches to the existing codebase

| Design element (Day 2) | Existing QLOOQO anchor (Day 1) | Integration note |
|---|---|---|
| ZAC module in `apps/api/src/zac/` | NestJS monolith, controller→service, ~40 domain modules under `apps/api/src/` | ZAC becomes one more domain module; wire it into `app.module.ts` when built. |
| Auth & role resolution | `SupabaseAuthGuard` + `AuthService.resolveAuthUser` (`apps/api/src/auth/`) → `AuthUser{roles[], businessId, businessTier, allowedLocationIds, locationScope, permissions[]}` | ZAC's controller reuses these guards; the assembled `AuthUser` *is* the `user_context`/`business_context` source. |
| Permission-aware tool registry | `RolesGuard`, `PermissionsGuard`, `LocationScopeGuard`; `Permission` catalogue + `DEFAULT_ROLE_PERMISSIONS` in `packages/domain/src/index.ts` | Derive the per-request tool set from `AuthUser.permissions[]`; gate each tool on the same `report.*` / `crm.view` / `audit.read` keys the guards already use. |
| Data tools (report/kpi/qlab/crm/booking/inventory) | Existing guarded read endpoints (Day 1 §8): `/api/dashboard/*`, `/api/kpi/*`, `/api/lab/analytics/summary`, CRM reads, availability reads | Tools should be thin wrappers over these guarded endpoints/services so guards + `business_id` filters always run. (Confirm direct-service vs guarded-HTTP with Cosan — decision log QC2.) |
| Model router | No AI/LLM provider anywhere today (greenfield) | New; provider-agnostic behind `model-provider.interface.ts`. Default to latest Claude models when implemented. |
| Memory / conversations / recommendations / snapshots | No agent/memory/conversation infra exists; `analytics` schema is empty; `audit.activity_log` is thin with no `agent` actor | New `zac` schema proposed (see §3), FORCE-RLS'd — stronger than the rest of the platform. |
| Measurement & cost telemetry | KPIs computed live in `apps/api/src/kpi/kpi.calc.ts`; no historical snapshot store | Capture events + KPI snapshots from Phase 1; snapshots are the "1% better" longitudinal spine. |
| Audit events | `AuditService.record` → `audit.activity_log` (fail-soft, free-text `action`) | Reuse for `zac.*` events; consider a dedicated high-volume table so interaction telemetry doesn't pollute the tamper-evident audit log (Day 1 §11). Add alerting since audit is fail-soft. |

---

## 2. Existing endpoints ZAC can consume in Phase 1 (read-only)

From Day 1 §8 — these are the guarded reads that become ZAC's Phase 1 "fuel". No new permission model is required for read-only if these suffice (confirm QC3).

| Endpoint | Permission gate | Feeds ZAC tool |
|---|---|---|
| `GET /api/dashboard/kpis` | `report.dashboard.view` | dashboard KPI tool |
| `GET /api/dashboard/top-services` | `report.dashboard.view` | services tool |
| `GET /api/dashboard/stylist-performance` | `report.performance.view` | team performance tool |
| `GET /api/dashboard/inventory-alerts` | `report.dashboard.view` | inventory/low-stock tool |
| `GET /api/kpi/stylists` | `report.commission.view` | commission tool |
| `GET /api/kpi/performance` | `report.performance.view` | performance tool |
| `GET /api/kpi/me` | owner/manager/**stylist** (own) | stylist self-coaching tool |
| `GET /api/lab/analytics/summary` | `report.lab_analytics.view` | QLab colour cost/waste tool |
| `GET /api/mobile-dashboard/{client,stylist,manager,owner}` | per-role | role dashboards |
| `GET /api/retail-sales` | `report.financials.view` | retail tool (⚠ table empty today) |
| `GET /api/audit/events` | `audit.read` | audit-read tool |

> **Data-readiness caveat:** `retail_sales`, `location_fixed_costs`, `product_usage`, `waste_events` were empty in the inspected dataset, so P&L / margin / retail answers are blank until captured. ZAC must say "no data captured yet" rather than infer (Day 2 §10; Day 1 §8, §15).

---

## 3. Proposed future `zac` schema (NOT to be created now)

When measurement plumbing is authorised, a new `zac` schema is proposed, **all tables `business_id NOT NULL` with RLS ENABLED AND FORCED** (stronger than the rest of the platform). From Day 1 §15; do not create yet.

- `zac.conversations` — business, user, role, topic, started_at, ttl
- `zac.messages` — conversation_id, role, content, tool_calls, **sources jsonb**, tokens
- `zac.recommendations` — business, location, user, **type**, target_entity_type/id, expected_outcome, **confidence**, measurement_window, status
- `zac.recommendation_outcomes` — recommendation_id → attribution join to `appointment_id`/`visit_id`/`retail_sale_id`/`formula_id`, observed_value, matched_at
- `zac.memory` — business, optional user, key/value, source
- `zac.knowledge_documents` — business, title, content/uri, tags
- `zac.kpi_snapshots` — business, location, staff, period, metric, value (the longitudinal spine; alternatively `analytics.*` materialized views — decision log QC5)

**Attribution hooks already in the schema** (use these rather than inventing new ones): `booking.rebooking_outcomes.rebook_source` (text, can be `'zac'`) and `booking.appointments.booking_channel='api'` (Day 1 §15).

---

## 4. Cost-per-intelligence telemetry (what to log when built)

Per model call (Day 2 §12): `business_id`, `user_id`, `role`, `conversation_id`, `task_type`, `model_provider`, `model_name`, `input_tokens`, `output_tokens`, `estimated_cost`, `latency_ms`, `tool_calls_used`, `cache_hit`, `recommendation_generated`.

Event vocabulary (Day 2 §12): `zac.conversation.started`, `zac.question.asked`, `zac.answer.delivered`, `zac.recommendation.created`, `zac.recommendation.shown`, `zac.recommendation.accepted`, `zac.recommendation.dismissed`, `zac.report.viewed`, `zac.kpi_snapshot.created`, `zac.cost_recorded`.

> **Cache boundary (privacy-critical):** prompt-cache and context must be **per-business** — never cache one tenant's data into another tenant's call (Day 1 §12D).

---

## 5. Suggested integration sequence (when authorised — not now)

This is a proposed order of operations for a *future* implementation phase. It is **not a to-do list for this task**, which is documentation-only.

1. **Confirm the open questions** in the decision log (§4 Cosan, §5 Luke) and verify prod parity.
2. **Freeze the tool contract** — hand-extract the definitive report/KPI/CRM endpoint shapes (no Swagger exists) into typed DTOs; optionally extract shared contracts into a small `@sheer/zac-core` package.
3. **Stand up the read path** — `zac.module.ts` + controller + Context Assembler + Permission-Aware Tool Registry over the existing guarded reads (§2). Read-only, no schema changes yet.
4. **Add the model router** behind a provider interface; wire one provider (latest Claude). Add per-call cost telemetry.
5. **Add the measurement spine** — `zac` schema (§3) via migration files, FORCE-RLS; begin logging conversations, recommendations, acceptance, and periodic KPI snapshots. This is what makes "value created" answerable later.
6. **Add role-differentiated prompts** and the evidence-grounded response/recommendation contracts (Day 2 §9).
7. **Only then** consider deferred capabilities (decision log §6): write tools with approval workflow, additional channels, scheduler-driven proactive work.

Each step should be its own reviewed change; none should bundle write/action capability into a read-only phase.

---

## 6. Things this design deliberately does NOT do

- Does not give ZAC any write/mutation capability in Phase 1 (no write tools registered).
- Does not add a new permission model unless the existing `report.*` / `crm.view` / `audit.read` gates prove insufficient (open — QC3/QC4).
- Does not introduce a durable scheduler; proactive/reconciler work that needs one is deferred (Day 1 §17).
- Does not depend on any single model provider's API format (Day 2 §11).
- Does not cache or read across tenants; every context and cache key is per-business.

---

## 7. Day 3 future integration notes

Added 2026-07-20 from [`phase-0-day-3-knowledge-tools-outcome-memory.md`](phase-0-day-3-knowledge-tools-outcome-memory.md). For a future authorised phase — **not now.**

Future implementation should:

- **Create explicit typed tool contracts** — each tool declares `tool_id`, `domain`, `purpose`, `required_permissions`, `allowed_roles`, `input_schema`, `output_schema`, `evidence_schema`, `pii_level`, `cache_policy`, `rate_limit`, `source_of_truth`, `read_or_write`, `phase_allowed` (Day 3 §6).
- **Permission-gate tools before model execution** — tool availability is derived from `AuthUser.permissions[]`; the platform decides, not the model (Day 3 §5; Day 2 §8).
- **Create a dedicated knowledge document store** — `zac.knowledge_documents` with metadata filtering / rule-based retrieval first; defer semantic/vector retrieval until the structure is stable (Day 3 §4).
- **Implement Context Memory and Outcome Memory separately** — Context Memory = what ZAC knows about the person/business; Outcome Memory = what actually happened and whether it created value (Day 3 §9, §11).
- **Log recommendation and outcome events from Phase 1** — the minimum measurement spine (Day 3 §20) so "value created" is reconstructable later. Consider keeping these events separate from `audit.activity_log` to avoid high-volume audit noise (Day 3 §23 Q3).
- **Support attribution confidence levels** — record honest, confidence-based attribution (`direct_influence`, `assisted_influence`, `observed_positive_outcome`, `negative_or_unexpected_outcome`, `unattributed`, etc.) so ZAC learns rather than self-validates (Day 3 §12.3, §17).
- **Keep Phase 1 read-only.**
- **Defer write/action tools** until approval, audit, and safety models are ready (Day 3 §8).

### Day 3 additions to the proposed `zac` schema

Day 3 refines the §3 schema proposal by splitting outcome tracking into two tables and adding event/cost tables (still FORCE-RLS, `business_id NOT NULL`, **do not create now**): `zac.conversations`, `zac.messages`, `zac.memory`, `zac.knowledge_documents`, `zac.recommendations`, `zac.recommendation_events`, `zac.observed_outcomes`, `zac.recommendation_outcomes`, `zac.kpi_snapshots`, `zac.cost_events` (Day 3 §19). Observed outcomes are tracked even when unlinked to a recommendation, so `recommendation_id` is nullable on the outcome record (Day 3 §15).

---

*Documentation only. This file describes how ZAC could be integrated later; it is not an instruction to integrate now. No source code, modules, migrations, permissions, env files, package manifests, or Supabase data have been created or modified.*
