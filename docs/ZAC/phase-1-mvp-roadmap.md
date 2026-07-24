# ZAC — Phase 1 MVP Roadmap

> **Status: Documentation only — NOT implemented, NOT authorised to build.**
> This roadmap describes what a future, explicitly authorised Phase 1 build would deliver. It is a plan, not a work order: **no application source code, NestJS modules, database migrations, frontend UI, authentication logic, environment files, package manifests, or Supabase data have been created or changed** to produce it. Phase 1 begins only after the Phase 0 package is reviewed and accepted ([Day 5 §21](phase-0-day-5-final-package-acceptance-roadmap.md)).
>
> Date: 2026-07-22 · Companion to the Phase 0 set: [Day 1](QLOOQO/ZAC%20Phase%200%20Discovery%20Report.md) · [Day 2](phase-0-day-2-core-architecture.md) · [Day 3](phase-0-day-3-knowledge-tools-outcome-memory.md) · [Day 4](phase-0-day-4-value-created-cost-per-intelligence.md) · [Day 5](phase-0-day-5-final-package-acceptance-roadmap.md) · [Acceptance Criteria](phase-0-acceptance-criteria.md) · [Future Integration Notes](phase-0-future-integration-notes.md).

---

## 1. Phase 1 Goal

Deliver ZAC as a **controlled, read-only MVP inside QLOOQO**: a role-aware, permission-aware, evidence-grounded intelligence layer that answers questions, coaches, and surfaces Insights / Coaching Points / Opportunities / Risks / Watch Points — while capturing the measurement and cost data that makes "value created" answerable forever after.

> **Phase 1 proves trust before autonomy** (Day 2 §17). ZAC can recommend; ZAC cannot act. **No production autonomous actions are promised or planned for Phase 1.**

## 2. Phase 1 Scope

**In scope:** read-only intelligence for Owners, Managers, and Stylists over existing guarded QLOOQO data; conversation, memory, insight, outcome, and cost logging; evidence/confidence output contracts; the Value Created foundation.

**Out of scope:** everything in §12 (deferred features), all write/action capability, all channels beyond the primary in-product surface, and anything not explicitly listed as a Phase 1 capability.

## 3. User Roles

| Role | Phase 1 experience |
|---|---|
| **Owner** | Business-level answers: health, revenue, rebooking, utilisation, waste, team themes, Value Created foundation (Day 5 §8). |
| **Manager** | Team/location operations: focus lists, performance signals, basic coaching points from performance data, measurable targets (Day 5 §9). |
| **Stylist** | Private personal coaching: own KPIs only, one supportive focus at a time, private coaching memory (Day 5 §10). |

Same core intelligence; role-differentiated context, permissions, tools, and visibility (Day 2 §4–§5). Stylist coaching privacy and manager/owner theme-only visibility are hard requirements (Decision Log D25–D26).

## 4. Backend Architecture Tasks

*(All under `apps/api/src/zac/` per Day 2 §6 — when authorised.)*

- ZAC module + **ask endpoint** (`zac.controller.ts`) behind the existing `SupabaseAuthGuard` / `AuthService.resolveAuthUser` — acting-user JWT only, never a service-role key (Decision Log D2).
- **Context Assembler** — minimal relevant context from `AuthUser` (user/business/conversation/tool/constitution/measurement context — Day 2 §7).
- **Role Profile Selector** — role-differentiated prompts and behaviour.
- **Model Router** behind `model-provider.interface.ts` — provider-agnostic; default to the latest Claude models; fast tier by default, reasoning escalation only when needed (Day 2 §11; Day 4 §21).
- Response/recommendation **contracts** — evidence-grounded JSON shapes (Day 2 §9), rendered with Day 4 §3 user-facing terminology.

## 5. Tool Architecture Tasks

- **Permission-Aware Tool Registry** — tool set derived from `AuthUser.permissions[]` before model execution; the platform decides, never the model (Day 2 §8).
- **Typed read-only tool contracts** per Day 3 §6 (tool_id, required_permissions, allowed_roles, schemas, pii_level, cache_policy, read_or_write=read).
- Wire the Phase 1 tool groups over existing guarded endpoints (Day 1 §8; Future Integration Notes §2):
  - **Report/KPI tools** — dashboard KPIs, top services, performance (`report.*` permissions).
  - **QLab summary tools where stable** — colour cost/waste analytics (`report.lab_analytics.view`).
  - **Booking/rebooking summary tools** — trends, no-shows, overdue-client signals.
  - **Stylist personal KPI tools** — `GET /api/kpi/me`-style own-data reads.
- **No write tools registered** — the "cannot act" list is enforced structurally (Day 2 §4).

## 6. Memory Tasks

- **Context Memory** — scoped memory records (`private_user_memory`, `role_scoped_memory`, `business_shared_memory`, `location_scoped_memory` — Day 3 §9–§10); always `business_id`-scoped; stylist private coaching memory never visible to owners/managers (Day 5 §13).
- **Outcome Memory** — observed outcomes and recommendation outcomes, with honest attribution types (Day 3 §11–§15; Day 5 §14).
- **Conversation logging** — conversations + messages with sources and token counts (Day 3 §19).
- Summary memory over raw transcripts; PII redacted/tokenised per the rules Cosan defines (§15.5; Decision Log D32).

## 7. Measurement Tasks

- Implement the **minimum measurement spine** from day one (Day 3 §20): conversation/question/answer/source events; insight created/shown/accepted/dismissed/ignored; observed outcomes; KPI snapshots.
- **KPI snapshots** — periodic captures from the deterministic KPI engine into `zac.kpi_snapshots` (or `analytics.*` — open decision QC5); existing reporting stays the source of truth (Decision Log D30).
- **Attribution classification** — Observed / Influenced / Directly Attributable, using existing hooks (`rebooking_outcomes.rebook_source='zac'`, `booking_channel='api'` — Day 4 §4).
- **Manual feedback capture** — owner/manager "did this help?" as a learning signal (Decision Log D24).
- ZAC events **separate from `audit.activity_log`**; only critical events mirrored (Decision Log D27).

## 8. Value-Created Foundation

- Per-category value estimation for the categories that are **Ready** at launch (Day 4 §7): rebooking, bookings recovered, utilisation, time saved, management hours saved; others as their source data begins to be captured.
- Every value line carries the **seven-part evidence rule** (Day 4 §6): source, metric changed, evidence, attribution, confidence, method, limitations.
- A first **Value Created summary** (report-shaped, per Day 5 §15) — dashboard vs report-only per Luke's decision (QL4). Sunday-report integration itself is **deferred** (Day 4 §11).

## 9. Cost Telemetry

- Log every model call to `zac.cost_events` (Day 4 §15): tokens, model, task type, cache hit, estimated cost, latency, unit_type.
- Configurable pricing constants per Day 4 §17 — **no hardcoded vendor prices**; refresh from official pricing pages.
- Per-tenant budgets and the Day 4 §21 optimisation triggers/controls from launch; per-tenant cache keys only (Day 1 §12D).

## 10. UI Surface Assumptions

- Phase 1 assumes **one primary in-product surface per existing app**: the web dashboard (owners/managers) and the mobile app (stylists) — exact UI design is a Phase 1 task; **Phase 0 built no UI**.
- The surface renders the evidence-grounded contract (answer, evidence, confidence, limitations) and the Day 4 §3 terminology; it adds no intelligence of its own — channels are thin adapters over the one core (Decision Log D8).
- Voice, WhatsApp, phone, and website surfaces are **not** in Phase 1 (§12).

## 11. Read-Only Restrictions

- **No write tools registered** — structurally enforced (Day 2 §4).
- ZAC **cannot**: create/cancel bookings, send WhatsApp/SMS/email, change stock, update staff settings, edit client records, alter prices, approve payments, take autonomous actions.
- ZAC authenticates as the **acting user's JWT**; every read passes the existing guards and `business_id` scoping (Decision Log D2–D3).
- A dedicated **`zac.access`** permission gates ZAC itself; what ZAC can *see* follows the user's normal report/CRM/QLab permissions (Decision Log D28).

## 12. Deferred Features (not in Phase 1)

Autonomous booking creation · SMS/WhatsApp sending · email campaigns · stock ordering · service price changes · staff setting changes · client profile edits · **automated HR/performance decisions** · **full disciplinary workflow** · full vector RAG (rule-based/metadata retrieval first — Day 3 §4) · voice/phone/WhatsApp channels · autonomous actions of any kind.

> Manager Coaching Journey: Phase 1 includes only **basic manager coaching points from performance data**; structured journeys are Phase 2+ (Day 5 §18). The human boundary (no employment decisions, no HR/legal authority) is permanent.

## 13. Phase 1 Acceptance Criteria

Phase 1 MVP is successful when:

1. An **owner** gets evidence-backed business answers.
2. A **manager** gets practical coaching/operational guidance.
3. A **stylist** gets private personal coaching.
4. **Permissions are respected** — verified per role (a stylist structurally cannot reach owner financials).
5. **Private stylist coaching memory is protected** — never visible to owners/managers.
6. **Evidence is attached** to every factual answer; missing data is stated, never invented.
7. **Outputs and outcomes are logged** — the full measurement spine records from day one.
8. **Cost telemetry is recorded** for every model call.
9. **Users understand why ZAC is valuable** — the First-Time Value Clarity Test (Day 5 §5) passes with real users.

## 14. Implementation Risks

| Risk | Why it's real | Mitigation |
|---|---|---|
| **Tenant isolation is application-layer only** | RLS dormant on the live path; service-role key bypasses it (Day 1 §6) | Acting-user JWT only; ride guarded API; FORCE-RLS on new `zac` tables; per-tenant caches |
| **Prod schema parity unverified** | All Day 1 findings are from the dev-test branch (Day 1 §18) | Re-verify against prod "Sheer V1" before build (QC8) |
| **Empty source tables** | `retail_sales`, `location_fixed_costs`, `product_usage`, `waste_events` empty in inspected dataset | Honest "no data captured yet"; readiness flags per category (Day 4 §7) |
| **No durable scheduler** | Snapshots/reconcilers/reports need periodic jobs (Day 1 §17) | Decide job infra early (QC/Day 4 §26 Q3); batch background work |
| **Audit is fail-soft, no `agent` actor** | ZAC events could silently drop; actor attribution unclear (Day 1 §11) | Separate ZAC event tables + alerting; define agent-actor convention |
| **PII in prompts/logs** | Request logger already logs full URLs; LLM context adds risk (Day 3 §23 Q7) | Redaction/tokenisation rules before launch; summaries over raw text (D32) |
| **Unmeasured window is unrecoverable** | Value/cost for any uncaptured period can never be reconstructed (Day 1 §15) | Measurement + cost spine ships **with** the first answer, not after |
| **Cost drift at scale** | Reasoning-tier overuse or context bloat erodes margin (Day 4 §20–§21) | Budgets, routing, caching, triggers from day one |
| **One-primary-business collapse** | Cross-business/enterprise rollups blocked today (Day 1) | Keep enterprise features out of Phase 1; single-business scope |

## 15. Required Decisions Before Build

From the [decision log](phase-0-decision-log.md) and Day 5 §20 — to be answered before Phase 1 starts:

1. **Confirm all Recommended-lock decisions** (D1–D34 + Day 5 additions) with Luke and Cosan.
2. **Tool boundary** — internal services vs guarded controller equivalents (QC2), and the final endpoint list per tool (Day 5 §20 Cosan 1).
3. **Schema locations** — `zac.*` table placement, KPI snapshot home, cost event schema (QC5; Day 5 §20 Cosan 2–4).
4. **`zac.access` implementation** and role-permission wiring (D28; Day 5 §20 Cosan 6).
5. **PII redaction rules** (QC7; Day 5 §20 Cosan 5).
6. **Internal demo harness vs backend-first MVP** (Day 5 §20 Cosan 7).
7. **Product decisions** — terminology per surface, dashboard vs report, cadence, headline, feedback wording, coaching assertiveness (Day 5 §20 Luke 1–7).
8. **Production schema parity** re-verified (QC8).
9. **Provider pricing** refreshed from official pricing pages into the Day 4 §17 constants; subscription prices plugged into the margin model (Day 4 §20).

> When authorised, follow the build order in [Future Integration Notes §5](phase-0-future-integration-notes.md): confirm decisions → freeze tool contracts → read path → model router + cost telemetry → measurement spine → role prompts/contracts → only then anything deferred. Schema changes go through **sequential migration files, never ad-hoc** (project convention).

---

*Documentation only. This roadmap authorises nothing; it exists so that an authorised Phase 1 can start quickly on locked foundations. Phase 1 is read-only end-to-end — no autonomous actions are planned or promised.*
