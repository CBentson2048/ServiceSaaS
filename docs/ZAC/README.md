# ZAC — Phase 0 & Phase 1 Documentation

**ZAC** is the **server-side, permission-aware, evidence-grounded intelligence layer inside QLOOQO** — an assistant that explains, coaches, and recommends for owners, managers, and stylists, grounded in QLOOQO's own data.

> ### ℹ️ Phase 0 = planning · Phase 1 = built
> The **`phase-0-*` documents are discovery and architecture planning**: they describe proposed designs, and some details in them were superseded during the build.
>
> **Phase 1 is implemented** and lives behind the `ZAC_ENABLED` kill-switch: `apps/api/src/zac/` (module, guarded `POST /zac/ask` + `GET /zac/health`, permission-aware tool registry, live model provider, **persisted conversations + scoped context memory** — see [`phase-1-conversation-memory.md`](phase-1-conversation-memory.md)), the `zac.access` permission, migrations `0076`/`0077`/`0080`/`0081`/`0089` (**authored — apply status tracked in the storage runbook**), the web console at `/zac` plus the floating assistant, and the mobile ZAC screen. Where a Phase 0 document and the code disagree, **the code is the source of truth**.

---

## Contents

| Document | What it is |
|---|---|
| [`QLOOQO/ZAC Phase 0 Discovery Report.md`](QLOOQO/ZAC%20Phase%200%20Discovery%20Report.md) | **Day 1** — read-only discovery of the QLOOQO repo + Supabase (dev-test branch): repo map, data model, tenant/role/permission model, reporting/KPI surface, constitution→architecture mapping, measurement architecture, and the risks/unknowns that shape ZAC. |
| [`phase-0-day-2-core-architecture.md`](phase-0-day-2-core-architecture.md) | **Day 2** — the core technical architecture: request flow, Phase 1 product direction (read-only), role experiences, proposed module layout, Context Assembler, Permission-Aware Tool Registry, response/recommendation contracts, model router, measurement & cost telemetry, channel architecture, and hard decisions to lock. |
| [`phase-0-day-3-knowledge-tools-outcome-memory.md`](phase-0-day-3-knowledge-tools-outcome-memory.md) | **Day 3** — defines ZAC's knowledge architecture, Phase 1 read-only tool structure, Context Memory, Outcome Memory, recommendation lifecycle, attribution model, privacy boundaries, and minimum measurement spine. |
| [`phase-0-day-4-value-created-cost-per-intelligence.md`](phase-0-day-4-value-created-cost-per-intelligence.md) | **Day 4** — defines ZAC's Value Created model, commercial attribution model, confidence/evidence model, Sunday report integration, Cost per Intelligence model, usage profiles, scaling projections, gross margin thresholds and Phase 0 proof-of-architecture scope. |
| [`phase-0-day-5-final-package-acceptance-roadmap.md`](phase-0-day-5-final-package-acceptance-roadmap.md) | **Day 5** — defines the final Phase 0 package, sign-off criteria, proof-of-architecture validation, First-Time Value Clarity Test, Owner/Manager/Stylist scenarios, Manager Coaching Journey future capability and Phase 1 MVP roadmap. |
| [`phase-0-decision-log.md`](phase-0-decision-log.md) | The recommended-to-lock decisions (Days 2–5), product-direction decisions, and the open questions for Cosan (technical) and Luke (product), each with status. |
| [`phase-0-acceptance-criteria.md`](phase-0-acceptance-criteria.md) | The Phase 0 sign-off checklist: what "Phase 0 complete" means — including the First-Time Value Clarity Test and validation scenarios — kept non-production and documentation/scenario based unless separately agreed. |
| [`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md) | The standalone Phase 1 MVP roadmap: read-only scope, roles, architecture/tool/memory/measurement tasks, deferred features, risks, and the decisions required before build. **A plan, not an authorisation.** |
| [`phase-0-sign-off-walkthrough.md`](phase-0-sign-off-walkthrough.md) | **Phase 0 Sign-Off Walkthrough** provides the live review agenda, proof-of-architecture scenarios, realistic test data, acceptance checklist, Cosan technical confirmation checklist and Luke approval checklist for Phase 0 approval before Phase 1 MVP planning. |
| [`phase-0-sign-off-speaker-notes.md`](phase-0-sign-off-speaker-notes.md) | Speaker notes for Oleksandr to use during the live Phase 0 sign-off walkthrough, including opening script, scenario narration, Value Created explanation, Cost per Intelligence explanation, Cosan technical confirmation prompt and Luke approval prompt. |
| [`phase-0-future-integration-notes.md`](phase-0-future-integration-notes.md) | The bridge to the codebase: where ZAC attaches to existing modules/guards/endpoints, the proposed `zac` schema, and a suggested integration sequence — **for a future authorised phase, not now.** |
| [`phase-1-conversation-memory.md`](phase-1-conversation-memory.md) | **Implemented** — persisted conversations, the ask-API conversation contract, the typed/scoped context-memory system (capture, supersession, retrieval, privacy rules), grounding of memory vs evidence, and the required Supabase configuration. |
| [`phase-1-request-modes.md`](phase-1-request-modes.md) | **Implemented** — request-mode classification (data vs general advice vs hypothetical vs conversational vs permissions), explicit instruction precedence ("forget my data" / "use my actual data"), tool-free advisory reasoning, provenance-aware grounding, and effective-permission explainability. |
| [`phase-1-measurement-spine.md`](phase-1-measurement-spine.md) | **Implemented** — persistent outputs, tool-call records, cost events, useful/not-useful feedback (API + web/mobile UI) and the conservative outcome-event foundation, linked by conversation/trace/output ids. Not the Value Created engine. |
| [`phase-1-utilisation-summary.md`](phase-1-utilisation-summary.md) | **Implemented** — the final Core MVP tool: server-side utilisation over rota availability vs booked appointment time via the canonical `computeDailyUtilisation`, with diary gaps, weekday patterns, the warning-threshold benchmark, and honest no-rota behaviour. |

**Suggested reading order:** Day 1 Discovery Report → Day 2 Core Architecture → Day 3 Knowledge, Tools & Outcome Memory → Day 4 Value Created & Cost per Intelligence → Day 5 Final Package & Roadmap → Decision Log → Acceptance Criteria → Phase 1 MVP Roadmap → Future Integration Notes.

---

## The one-paragraph summary

ZAC lives inside the QLOOQO backend (`apps/api/src/zac/`, *future*), authenticates as the **acting user's JWT** (never a service-role key, because DB-level tenant isolation is dormant), and reads only through the **existing guarded API** with tools gated by the user's own permissions. **Phase 1 is read-only** — ZAC coaches, explains, and recommends but takes no autonomous actions. Every answer is **evidence-grounded** (it quotes QLOOQO's deterministic KPI engine and report endpoints rather than inventing numbers) and every recommendation carries reason, evidence, and expected outcome. Every meaningful interaction is **measured from Phase 1** — conversations, recommendations, acceptance, and KPI snapshots — so the question *"what value has ZAC created this month?"* becomes answerable later. Future channels (in-app, website, voice, WhatsApp, phone) are **adapters over one core**, not separate systems.

---

## Phase 0 status

- **Day 1 (Discovery):** complete — see the Discovery Report.
- **Day 2 (Core Architecture):** captured in the Day 2 document above.
- **Day 3 (Knowledge, Tools & Outcome Memory):** captured in the Day 3 document above.
- **Day 4 (Value Created & Cost per Intelligence):** captured in the Day 4 document above.
- **Day 5 (Final Package, Acceptance & Roadmap):** complete — Day 5 is the **final Phase 0 package**: acceptance criteria, First-Time Value Clarity Test, proof-of-architecture scenarios, Manager Coaching Journey (future), and the Phase 1 MVP roadmap.
- **Phase 0 documentation: complete.** The **sign-off walkthrough is prepared** ([`phase-0-sign-off-walkthrough.md`](phase-0-sign-off-walkthrough.md)).
- **Next: the live review and acceptance decision** — Luke, Cosan and Oleksandr run the walkthrough checklist item by checklist item (scenarios, permissions, memory, attribution, Value Created report, ROI, Cost per Intelligence, acceptance checklist), Cosan completes the technical confirmation checklist, Luke completes the approval checklist, and the final decision is recorded (approved / approved with minor clarifications / changes required) **before** payment/acceptance and any Phase 1 build. Implementation remains out of scope until explicitly authorised.

---

*This folder is planning documentation. No application source code, migrations, environment files, package manifests, or Supabase data have been created or changed to produce it.*
