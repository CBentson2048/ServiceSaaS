# ZAC — Phase 0 Acceptance Criteria

> **Status: Documentation only — NOT implemented.**
> This document defines what "Phase 0 complete" means for ZAC. Phase 0 is a **discovery + architecture + proof-of-architecture** effort. **No application source code, NestJS modules, database migrations, frontend UI, authentication logic, environment files, package manifests, or Supabase data have been created or changed.** The acceptance package is **non-production** — documentation and scenario based — unless a production prototype/spike is **separately agreed**.
>
> Date: 2026-07-22 (updated for Day 5 and the sign-off walkthrough) · Sources: [Day 1 Discovery Report](QLOOQO/ZAC%20Phase%200%20Discovery%20Report.md), [Day 2 Core Architecture](phase-0-day-2-core-architecture.md), [Day 3 Knowledge, Tools & Outcome Memory](phase-0-day-3-knowledge-tools-outcome-memory.md), [Day 4 Value Created & Cost per Intelligence](phase-0-day-4-value-created-cost-per-intelligence.md), [Day 5 Final Package, Acceptance & Roadmap](phase-0-day-5-final-package-acceptance-roadmap.md), [Phase 0 Sign-Off Walkthrough](phase-0-sign-off-walkthrough.md).

---

## 1. Purpose

Phase 0 exists to make ZAC's **irreversible decisions** well and to **prove the architecture is trustworthy and valuable** before Phase 1 investment. This checklist is the sign-off gate: Phase 0 is "done" when every item below is satisfied by documentation and scenario evidence — **not** by production code.

ZAC is a **trusted AI team member inside QLOOQO** whose purpose is to improve people and businesses every day. **Phase 1 remains read-only** (Day 2 §4): ZAC can coach, explain, surface insights, identify opportunities, and produce evidence-grounded business intelligence, but performs **no autonomous actions**. ZAC never replaces human managers, never makes employment decisions, and never acts as HR/legal authority (Day 5 §3, §11).

---

## 2. Phase 0 Core Acceptance Checklist

**Phase 0 is complete when:**

| # | Criterion | Where it lives | Status |
|---|---|---|---|
| 1 | **Constitution-to-Architecture mapping is documented.** | Day 1 §12 | ✅ Documented |
| 2 | **Current platform discovery is documented.** | Day 1 Discovery Report | ✅ Documented |
| 3 | **Core ZAC architecture is documented.** | Day 2 | ✅ Documented |
| 4 | **Knowledge, tools and memory architecture is documented.** | Day 3 §3–§10 | ✅ Documented |
| 5 | **Outcome Memory and lifecycle model are documented.** | Day 3 §11–§17 | ✅ Documented |
| 6 | **Value Created model is documented.** | Day 4 §4–§10 | ✅ Documented |
| 7 | **Cost per Intelligence model is documented.** | Day 4 §13–§22; Day 5 §16 | ✅ Documented |
| 8 | **Role-based Owner/Manager/Stylist proof-of-architecture scenarios are documented.** | Day 5 §7–§11 | ✅ Documented (Day 5) |
| 9 | **Evidence-attached sample answers are documented.** | Day 5 §8–§11; Day 4 §10 | ✅ Documented (Day 5) |
| 10 | **Context Memory and Outcome Memory examples are documented.** | Day 5 §13–§14; Day 3 §9, §11 | ✅ Documented (Day 5) |
| 11 | **Observed / Influenced / Directly Attributable attribution examples are documented.** | Day 5 §14–§15; Day 4 §4, §10 | ✅ Documented (Day 5) |
| 12 | **Sample Value Created report/dashboard is documented.** | Day 5 §15; Day 4 §9–§10 | ✅ Documented (Day 5) |
| 13 | **Phase 1 MVP roadmap is ready.** | [`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md); Day 5 §17 | ✅ Documented (Day 5) |
| 14 | **Open decisions are listed.** | Decision Log §4–§5, §8–§9; Day 5 §20 | ✅ Documented |
| 15 | **Out-of-scope production implementation is clearly separated.** | Day 5 §6.2; Day 4 §23; this doc §6 | ✅ Documented |

> With Day 5, every core checklist item is satisfied **as documentation**. What remains is human review: Luke and Cosan accepting the package (§7).

---

## 3. First-Time Value Clarity Test *(Day 5 addition — core criterion)*

Luke's final acceptance criterion, verbatim:

> **"If I were a salon owner seeing ZAC for the first time, would I immediately understand why this is valuable?"**

This is a **first-class Phase 0 validation criterion** (Day 5 §5). The proof-of-architecture must demonstrate, per role:

- **Owner** — immediately understands **business value, evidence, ROI, and business priorities**, across revenue / profit / rebooking / retail / waste / utilisation / team performance (validated by the Day 5 §8 scenario).
- **Manager** — immediately understands **what needs attention, what to do next, why it matters, what evidence supports it, and what measurable improvement is expected** (Day 5 §9).
- **Stylist** — immediately understands **how to improve**, receives **one practical improvement focus**, experiences ZAC as **a coach, not surveillance**, and sees the **private coaching boundary** stated (Day 5 §10).

**Pass condition:** a first-time reader of each scenario can answer *"why is this valuable to me?"* without additional explanation. Technical correctness that fails this test fails Phase 0 — **the proof-of-architecture validates business value, not only technical design** (Decision Log D35–D36).

---

## 4. Validation Scenarios *(Day 5 addition)*

The proof-of-architecture package must contain, on realistic mock test data (Day 5 §7 — "The Colour Room"; no real client PII):

| Scenario | Validates | Where |
|---|---|---|
| **Owner scenario** — *"What is the biggest opportunity in my business this month?"* | Business-level permissions; evidence + confidence + value estimate; coaching privacy (themes only). | Day 5 §8 |
| **Manager scenario** — *"What should I focus on with the team this week?"* | Team/location scope; practical ordered steps; measurable targets; no private coaching exposure. | Day 5 §9 |
| **Stylist scenario** — *"How can I improve this week?"* | Own-data-only access; supportive single-focus coaching; no peer comparison; explicit privacy promise. | Day 5 §10 |
| **Manager Coaching Journey scenario** — *"Jade has been underperforming for several weeks. What should I do?"* *(future capability, validated on paper)* | Sensitive-request handling; evidence → causes → supportive first steps → support plan → targets → review timeline; **human decision boundary** (no employment decisions, no HR/legal authority, follow company policy). | Day 5 §11, §18 |

Each scenario must show **why ZAC produced its Insight/Coaching Point** (signal → evidence → conclusion) and pass the §3 clarity test for its role.

---

## 5. Phase 0 Sign-Off Checklist *(Day 5 addition)*

The full sign-off list reviewed at acceptance (Day 5 §19):

1. ZAC vision and Constitution alignment
2. Current QLOOQO platform discovery
3. Core ZAC architecture
4. Role and permission model
5. Knowledge architecture
6. Context Memory
7. Outcome Memory
8. Insight/Coaching/Opportunity lifecycle
9. Value Created model
10. Cost per Intelligence model
11. Proof-of-architecture scenarios
12. First-Time Value Clarity Test
13. Manager Coaching Journey future scenario
14. Phase 1 MVP roadmap
15. Deferred scope list
16. Open decisions list

---

## 6. Nature of the Acceptance Package — and explicit exclusions

The acceptance package must be **non-production and documentation/scenario based unless separately agreed.** Concretely:

### 6.1 Phase 0 CAN include (Day 4 §23.1; Day 5 §6.1)
- Scenario-based validation on realistic test salon data (mock; no real client PII).
- Sample Owner / Manager / Stylist conversations, plus the Manager Coaching Journey scenario.
- Sample evidence-attached insights (source · metric · evidence · attribution · confidence · method · limitations — Day 4 §6).
- Sample Context Memory and Outcome Memory records (Day 5 §13–§14).
- Lifecycle and Observed / Influenced / Directly Attributable attribution examples (Day 5 §12, §14).
- Sample Value Created dashboard/report with ROI vs subscription cost (Day 5 §15).
- Cost per Intelligence model (Day 4 §13–§22; Day 5 §16).
- First-time value clarity checklist (§3) and Phase 1 readiness checklist ([`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md)).
- This acceptance criteria checklist.

### 6.2 Phase 0 must NOT include (explicit production exclusions)
- Production login integration.
- Real ZAC UI inside QLOOQO.
- Real database migrations.
- Real LLM implementation.
- Live tool execution.
- Live memory tables.
- Live Sunday-report integration.
- Autonomous actions.

> Everything in §6.2 belongs to **Phase 1** or a **separately agreed prototype/spike** (Decision Log D37).

---

## 7. Sign-off

Phase 0 sign-off requires:

1. Every core checklist item in §2 satisfied (all now ✅ as documentation).
2. The **First-Time Value Clarity Test** (§3) confirmed by Luke against the Day 5 scenarios.
3. The **validation scenarios** (§4) reviewed for role behaviour, permissions, evidence, privacy, and value clarity.
4. The full **sign-off checklist** (§5) walked through and accepted by Luke (product) and Cosan (technical).
5. Open decisions (Day 5 §20; Decision Log §9) reviewed — sign-off may proceed with decisions still **Open** provided they are captured, but **Recommended-lock** items should be confirmed before the Phase 1 build.
6. Production schema parity re-verified against prod "Sheer V1" (Day 1 §18, Decision Log QC8) before any Phase 1 implementation.

> **Sign-off is on the architecture, the trust model, and the demonstrated value clarity — not on production behaviour.** No Phase 0 sign-off authorises writing application code, migrations, permissions, or live integrations. Implementation remains out of scope until explicitly authorised (Day 5 §21).

---

## 8. Live Sign-Off Walkthrough Acceptance

Phase 0 acceptance is completed through the **live sign-off walkthrough** with Luke, Cosan and Oleksandr ([`phase-0-sign-off-walkthrough.md`](phase-0-sign-off-walkthrough.md)) — a proof-of-architecture review on realistic test data, **not** a production demo. Acceptance requires each item below marked during or immediately after the session:

- ☐ Walkthrough completed (full agenda, checklist item by checklist item)
- ☐ Owner scenario reviewed (Walkthrough §9)
- ☐ Manager scenario reviewed (§10)
- ☐ Stylist scenario reviewed (§11)
- ☐ Manager Coaching Journey scenario reviewed (§12 — future capability + human decision boundary)
- ☐ Permissions reviewed (§13 — role visibility boundaries)
- ☐ Memory examples reviewed (§14–§15 — Context Memory + Outcome Memory)
- ☐ Attribution reviewed (§17 — Observed / Influenced / Directly Attributable)
- ☐ Value Created report reviewed (§18)
- ☐ ROI reviewed (§19)
- ☐ Cost per Intelligence reviewed (§20)
- ☐ Cosan technical confirmation completed (§22 — all 15 items)
- ☐ Luke approval checklist completed (§23 — all 13 items)
- ☐ **Free interaction validation completed** (Walkthrough §26 — pass condition: Luke feels ZAC would help him run and improve a salon better than reports alone)
- ☐ **Owner/Manager/Stylist natural questions reviewed** (§26.1–§26.3, incl. the manager boundary probe handled correctly)
- ☐ **Surprise hidden-value scenario reviewed** (§27 — Hidden Profit Leak)
- ☐ **First-Time Value Clarity Test passed** (§3 of this document, confirmed by Luke in session)
- ☐ Remaining questions captured (§24)
- ☐ Final decision recorded (§24 — approved / approved with minor clarifications / changes required)

---

*Documentation only. Nothing in this file has been implemented. See [`phase-0-decision-log.md`](phase-0-decision-log.md) for tracked decisions, [`phase-0-sign-off-walkthrough.md`](phase-0-sign-off-walkthrough.md) for the live review script, [`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md) for the Phase 1 plan, and [`phase-0-future-integration-notes.md`](phase-0-future-integration-notes.md) for how a future team should bridge this design to the codebase when implementation is authorised.*
