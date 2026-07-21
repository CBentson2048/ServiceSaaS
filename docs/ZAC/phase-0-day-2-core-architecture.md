# ZAC — Phase 0, Day 2: Core Architecture

> **Status: Documentation only — NOT implemented.**
> This document records the Day 2 architecture decisions for ZAC inside QLOOQO so they can be referenced and integrated later. **No application source code, NestJS modules, database migrations, environment files, package manifests, or Supabase data have been created or changed.** Every code path, module, file, schema, and permission named below is a *proposed future design*, not an existing artifact.
>
> Date: 2026-07-20 · Phase: 0 (Discovery & Architecture) · Follows: [`QLOOQO/ZAC Phase 0 Discovery Report.md`](QLOOQO/ZAC%20Phase%200%20Discovery%20Report.md) (Day 1).

---

## 1. Purpose

Day 2 defines the **core technical architecture** for ZAC inside QLOOQO.

ZAC is to be built as a **server-side intelligence layer inside QLOOQO** — not as:

- a frontend chatbot,
- a separate external AI product,
- a direct database agent, or
- an unrestricted automation system.

**Phase 1 remains read-only.** ZAC can explain, coach, recommend, and surface business intelligence, but it must **not perform autonomous actions**.

This builds directly on the Day 1 Discovery Report, which established that (a) tenant isolation in QLOOQO is application-layer only (RLS is dormant on the live path), so ZAC must ride the existing guarded API and never hold a service-role key; and (b) ZAC is 100% greenfield. Day 2 turns those constraints into a concrete architecture shape.

---

## 2. Core Architecture Decision

**ZAC should live as a backend intelligence module inside the QLOOQO API.**

Recommended future location:

```
apps/api/src/zac/
```

> This location is for **future implementation only. Do not create it now.**

Placing ZAC inside the existing NestJS API means it inherits, rather than re-implements, the platform's authentication guards, the `AuthUser` identity/scope resolver, the audit service, and — critically — the single place where tenant `business_id`/`location_id` scoping is centralized. (See Day 1 §11, §13.)

---

## 3. Recommended Architecture Flow

```
Authenticated QLOOQO user
  → ZAC API endpoint
  → Auth and role resolution
  → Business, location, role and permission context
  → ZAC Context Assembler
  → Role Profile Selector
  → Permission-Aware Tool Registry
  → Model Router
  → Evidence-Grounded Answer or Recommendation
  → Memory, Audit, Measurement and Cost Logging
```

Each stage is described in the sections below. The key property of this flow is that **permission and scope are resolved before the model is ever invoked**, and every result is logged for measurement.

---

## 4. Confirmed Phase 1 Product Direction

Phase 1 should support three roles:

- **Owners**
- **Managers**
- **Stylists**

ZAC uses the **same core intelligence** but **different role-based context, permissions, available tools, and data visibility** per role.

**Phase 1 remains read-only.**

### ZAC can:

- coach
- explain
- recommend
- summarise
- surface insights
- provide business intelligence
- provide proactive recommendations

### ZAC cannot:

- create bookings
- cancel bookings
- send WhatsApp, SMS, or email
- change stock
- update staff settings
- edit client records
- alter prices
- approve payments
- take autonomous actions

> In architecture terms, the "cannot" list is enforced **structurally**: no write tools are registered in the Phase 1 tool registry, so ZAC has no mechanism to perform these actions even if asked (Day 1 §12C).

---

## 5. Key Role Experiences

ZAC presents a different experience per role, driven by role-scoped context, tools, and data visibility.

### Owner
- business health
- revenue
- profit
- ROI
- value created by ZAC
- team performance
- strategic coaching

### Manager
- location operations
- staff performance
- utilisation
- rebooking
- stock
- client flow
- operational recommendations

### Stylist
- personal coaching
- rebooking habits
- retail confidence
- colour usage
- client experience
- personal performance improvement

---

## 6. Core Components for Future Implementation

The structure below is a **proposed future module layout**. It maps each architectural stage from §3 onto files.

> **Important: this is a proposed future structure only. Do NOT create these source files now.**

```
apps/api/src/zac/
  zac.module.ts
  zac.controller.ts
  zac.service.ts

  context/
    zac-context.service.ts
    role-profile.service.ts
    scope-resolver.service.ts

  tools/
    zac-tool-registry.ts
    report.tools.ts
    kpi.tools.ts
    qlab.tools.ts
    crm.tools.ts
    booking.tools.ts
    inventory.tools.ts

  models/
    model-router.service.ts
    model-provider.interface.ts
    openai-provider.ts
    anthropic-provider.ts

  memory/
    zac-memory.service.ts
    conversation-memory.service.ts
    business-memory.service.ts

  recommendations/
    recommendation.service.ts
    recommendation-lifecycle.ts
    recommendation-types.ts

  measurement/
    zac-events.service.ts
    outcome-attribution.service.ts
    kpi-snapshot.service.ts
    cost-telemetry.service.ts

  prompts/
    constitution-policy.ts
    role-prompts.ts
    response-contracts.ts

  dto/
    ask-zac.dto.ts
    zac-response.dto.ts
    recommendation.dto.ts
```

---

## 7. Context Assembler

Future ZAC requests should resolve and assemble a **minimal, relevant** context object. The Context Assembler is the component that turns the acting user's identity into everything the model and tools are allowed to see.

### `user_context`
- `user_id`
- `role`
- `permissions`
- `allowed_locations`

### `business_context`
- `business_id`
- `business_tier`
- `active_location`
- `business_goals`

### `conversation_context`
- `topic`
- `prior summary`
- `relevant memory`

### `tool_context`
- allowed tools only
- role-specific tool permissions

### `constitution_context`
- truth
- loyalty
- integrity
- privacy
- humanity

### `measurement_context`
- current objective
- expected outcome
- tracking rules

> **Rule:** The Context Assembler **must not dump the full database or full knowledge base into the model.** It should pass only the **minimum relevant context**. (Reinforces Day 1 §12D privacy + per-tenant cache boundaries.)

---

## 8. Permission-Aware Tool Registry

ZAC tools must be **permission-gated before model execution**.

> **The model must not decide whether a user has permission. The platform decides.**

Example future rules:

| Condition | Effect |
|---|---|
| User has `report.dashboard.view` | allow dashboard KPI tool |
| User has `report.performance.view` | allow stylist/team performance tool |
| User has `report.lab_analytics.view` | allow QLab analytics tool |
| User **lacks** `report.financials.view` | do **not** expose financial detail tools |
| User is a **stylist** | allow own-KPI tool; deny owner-wide financial tools |

> **ZAC should never receive tools the user is not allowed to use.** Because tool availability is derived from `AuthUser.permissions[]`, a stylist's ZAC structurally *cannot* surface owner-only financials even if explicitly asked (Day 1 §11, §12D/E).

---

## 9. Evidence-Grounded Response Contract

Future ZAC **business answers** should conform to:

```json
{
  "answer": "Human-readable explanation",
  "evidence": [
    {
      "source_type": "tool",
      "tool_name": "dashboard_kpis",
      "as_of": "timestamp",
      "entities_used": []
    }
  ],
  "recommendations": [],
  "confidence": "high | medium | low",
  "limitations": [],
  "expected_outcome": null
}
```

Future **recommendations** should conform to:

```json
{
  "recommendation": "Suggested action",
  "why": "Reason this recommendation was made",
  "evidence": ["Data sources used"],
  "expected_outcome": "Expected business result",
  "metric_to_measure": "rebooking | revenue | waste | retail | utilisation",
  "confidence": "high | medium | low",
  "role_relevance": "owner | manager | stylist",
  "requires_action": false
}
```

> `requires_action` is `false` in Phase 1 by design — recommendations are surfaced, never executed (§13). The `evidence` + `as_of` fields are what make Day 1's "Truth" constitution principle enforceable rather than aspirational.

---

## 10. Truth and Safety Rules

- ZAC must **not invent metrics**.
- ZAC must **not calculate important KPIs from raw memory**.
- ZAC must use **QLOOQO platform data as the source of truth**.
- ZAC must **clearly say when data is missing**.
- ZAC must **not expose data outside the user's permission scope**.
- ZAC must **not promise guaranteed outcomes**.
- ZAC must **explain recommendations with evidence**.
- ZAC must **separate fact, interpretation, and recommendation**.

> These map directly onto Day 1's finding that KPIs are computed by the deterministic engine (`apps/api/src/kpi/kpi.calc.ts`) and report endpoints. ZAC narrates those results — the LLM does not do arithmetic (Day 1 §12A). Several input tables are empty in the inspected dataset (`retail_sales`, `location_fixed_costs`, `product_usage`, `waste_events`), so "clearly say when data is missing" is a live, near-term requirement, not a hypothetical.

---

## 11. Model Router

Future ZAC architecture should include a **provider-agnostic model router**.

### Purpose
- reduce cost
- support future model switching
- use the right model for the right task
- collect cost-per-intelligence metrics

### Example routing
- simple help / navigation → fast, low-cost model
- workflow explanation → fast or mid model
- KPI explanation → mid model with tool grounding
- complex business reasoning → stronger reasoning model
- value-created report → stronger model + structured data
- recommendation generation → mid/strong model depending on complexity

> The QLOOQO architecture **should not depend directly on one provider's API format.** Providers sit behind a `model-provider.interface.ts` so they can be swapped without touching tools, auth, or audit (Day 1 §14). When implemented, default to the latest and most capable Claude models unless a task-specific reason dictates otherwise.

---

## 12. Measurement and Cost Telemetry

Future ZAC model calls should record:

- `business_id`
- `user_id`
- `role`
- `conversation_id`
- `task_type`
- `model_provider`
- `model_name`
- `input_tokens`
- `output_tokens`
- `estimated_cost`
- `latency_ms`
- `tool_calls_used`
- `cache_hit`
- `recommendation_generated`

Future ZAC **events** should include:

- `zac.conversation.started`
- `zac.question.asked`
- `zac.answer.delivered`
- `zac.recommendation.created`
- `zac.recommendation.shown`
- `zac.recommendation.accepted`
- `zac.recommendation.dismissed`
- `zac.report.viewed`
- `zac.kpi_snapshot.created`
- `zac.cost_recorded`

> **Why this must start in Phase 1:** Day 1 §15 established that Luke's target question — *"what value has ZAC created this month?"* — is permanently unanswerable for any window in which recommendations, acceptance, and KPI snapshots were not captured. Capturing these events is cheap now and impossible to reconstruct retroactively.

---

## 13. Proactive Recommendations in Phase 1

In Phase 1, "proactive recommendations" means:

> **ZAC identifies and surfaces recommendations. ZAC does not execute actions.**

### Example owner recommendations
- Revenue is down because utilisation dropped on specific days.
- Several stylists are below rebooking target.
- Colour waste increased compared with the previous period.

### Example manager recommendations
- Tomorrow has low utilisation between certain times.
- Team performance is declining in a specific area.
- Low-stock risk exists for key products.

### Example stylist recommendations
- Rebooking rate is improving but missed opportunities remain.
- Colour waste is above recent average.
- Certain clients may benefit from retail follow-up.

---

## 14. Future Channel Architecture

Future channels should be **adapters**, not separate intelligence systems:

- In-app ZAC
- Website ZAC
- Voice ZAC
- WhatsApp ZAC
- Phone ZAC

All should connect to the same:

- ZAC core service
- permission model
- memory layer
- recommendation lifecycle
- outcome measurement
- cost telemetry

> **There should not be separate ZAC systems per channel.** Each channel is a thin transport adapter over the one server-side core (Day 1 §14). Voice, WhatsApp, and phone are explicitly deferred beyond Phase 1 (Day 1 §17) — the point here is only that the core is designed so they *can* attach later without a rebuild.

---

## 15. Hard Decisions Recommended to Lock

1. ZAC lives inside the QLOOQO backend.
2. ZAC uses **acting-user context**.
3. ZAC accesses data through **permission-aware tools/APIs**.
4. **Phase 1 is read-only.**
5. Every answer must be **evidence-grounded**.
6. Every recommendation must include **reason, evidence, and expected outcome**.
7. Every meaningful ZAC interaction must be **measurable**.
8. Future channels are **adapters, not separate intelligence systems**.

> These are tracked as decisions (with rationale and status) in [`phase-0-decision-log.md`](phase-0-decision-log.md).

---

## 16. Open Questions

These are carried forward for confirmation. They are reproduced with more context in [`phase-0-decision-log.md`](phase-0-decision-log.md) and cross-referenced to the Day 1 report's own open-questions sections (Day 1 §19 Luke, §20 Cosan).

### For Cosan (technical)
1. Confirm `apps/api/src/zac/` as the future module location.
2. Confirm whether ZAC tools should call internal services directly or guarded API/controller equivalents.
3. Confirm whether existing report/CRM/audit permissions are sufficient for Phase 1.
4. Confirm whether a dedicated `zac.access` permission is needed.
5. Confirm whether KPI snapshots belong in `zac.kpi_snapshots` or `analytics`.
6. Confirm audit event naming conventions.
7. Confirm how prompt/response PII should be logged or redacted.
8. Confirm production schema parity before Phase 1 planning.

### For Luke (product)
1. Confirm first role-specific coaching examples for owner, manager, and stylist.
2. Confirm whether ZAC should use the word "recommendation", "nudge", "coaching point", or another product term.
3. Confirm how assertive ZAC should be when presenting underperformance.
4. Confirm whether owners should see a separate "Value Created by ZAC" dashboard in Phase 1 or only reports.
5. Confirm which outcome metric has highest priority for first measurement: revenue, profit, rebooking, retail, waste, utilisation, retention, staff development, or time saved.

---

## 17. Day 2 Conclusion

Day 2 establishes the core architecture direction:

> **ZAC is a server-side, permission-aware, evidence-grounded intelligence layer inside QLOOQO.**
>
> **Phase 1 should prove trust before autonomy.**

ZAC should be able to:

- understand the user role
- access only permitted data
- explain business performance
- coach owners, managers, and stylists
- make recommendations
- record evidence
- measure business outcomes
- track cost
- evolve later into voice, WhatsApp, phone, reports, and controlled actions

---

*Documentation only. Nothing in this file has been implemented. See [`phase-0-future-integration-notes.md`](phase-0-future-integration-notes.md) for how a future team should bridge this design to the codebase when implementation is authorised.*
