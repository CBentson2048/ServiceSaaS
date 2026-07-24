# ZAC — Phase 0 Decision Log

> **Status: Documentation only — NOT implemented.**
> This log records architecture decisions and open questions captured during Phase 0. Decisions marked **Recommended-lock** are proposals awaiting sign-off; nothing here has been applied to code, schema, config, or data.
>
> Last updated: 2026-07-22 · Sources: Day 1 Discovery Report + Day 2 Core Architecture + Day 3 Knowledge/Tools/Outcome Memory + Day 4 Value Created & Cost per Intelligence + Day 5 Final Package, Acceptance & Roadmap + Phase 0 Sign-Off Walkthrough.

Status legend:
- **Recommended-lock** — proposed as a hard, expensive-to-reverse decision; awaiting confirmation from Cosan/Luke.
- **Open** — genuinely undecided; needs an answer before or during Phase 1 planning.
- **Deferred** — intentionally out of Phase 1 scope.

---

## 1. Decisions recommended to lock

These are the eight Day 2 "hard decisions". Each is expensive to reverse once ZAC memory, tools, and audit vocabulary accumulate around it (see Day 1 §13).

| # | Decision | Status | Rationale / linkage |
|---|---|---|---|
| D1 | **ZAC lives inside the QLOOQO backend** (`apps/api/src/zac/`). | Recommended-lock | Inherits guards, `AuthUser` resolver, audit service, and the single centralized tenant-scoping point. Moving later is a deployment + auth + network re-architecture (Day 1 §11, §13). |
| D2 | **ZAC uses acting-user context** — authenticates as the acting user's JWT and resolves via `AuthService.resolveAuthUser`. Never a service-role key. | Recommended-lock | DB-level tenant isolation is dormant (service-role bypasses RLS), so service-role to ZAC is a guaranteed cross-tenant leak (Day 1 §6, §12D, §18). |
| D3 | **ZAC accesses data through permission-aware tools/APIs** — the platform (not the model) decides permission; tools are gated before model execution. | Recommended-lock | A stylist's ZAC structurally cannot call owner-only financial tools; role scoping is enforced by construction, not by prompt (Day 2 §8; Day 1 §11, §12D/E). |
| D4 | **Phase 1 is read-only** — no write tools registered; no autonomous actions. | Recommended-lock | Prove trust before autonomy. The "cannot" list (create/cancel bookings, send messages, change stock, edit records, alter prices, approve payments) is enforced by the absence of write tools (Day 2 §4; Day 1 §12C, §16). |
| D5 | **Every answer must be evidence-grounded** — answers carry `evidence[]`, `as_of`, `confidence`, `limitations`; no un-sourced factual claims. | Recommended-lock | ZAC never computes KPIs itself; it quotes the deterministic engine / report endpoints. Answers with no source are blocked/flagged (Day 2 §9–§10; Day 1 §12A). |
| D6 | **Every recommendation must include reason, evidence, and expected outcome** — plus `metric_to_measure`, `confidence`, `role_relevance`, `requires_action`. | Recommended-lock | Makes recommendations measurable and honest; feeds outcome attribution (Day 2 §9, §13; Day 1 §15). |
| D7 | **Every meaningful ZAC interaction must be measurable** — capture conversations, recommendations, acceptance/dismissal, KPI snapshots, and cost from Phase 1. | Recommended-lock | "What value has ZAC created?" is permanently unanswerable for any un-captured window. This is the single most important thing to get right early (Day 2 §12; Day 1 §13, §15). |
| D8 | **Future channels are adapters, not separate intelligence systems** — in-app/website/voice/WhatsApp/phone all attach to one core, permission model, memory, recommendation lifecycle, measurement, and cost telemetry. | Recommended-lock | Prevents divergent per-channel logic; channels become thin transport adapters (Day 2 §14; Day 1 §14). |

---

## 2. Product-direction decisions (confirmed for Phase 1)

| # | Decision | Status |
|---|---|---|
| P1 | Phase 1 supports **owners, managers, and stylists** with the same core intelligence but role-differentiated context, permissions, tools, and data visibility. | Confirmed (Day 2 §4–§5) |
| P2 | ZAC **can**: coach, explain, recommend, summarise, surface insights, provide business intelligence, provide proactive recommendations. | Confirmed (Day 2 §4) |
| P3 | ZAC **cannot**: create/cancel bookings, send WhatsApp/SMS/email, change stock, update staff settings, edit client records, alter prices, approve payments, take autonomous actions. | Confirmed (Day 2 §4) |
| P4 | Proactive recommendations in Phase 1 mean **surface, not execute**. | Confirmed (Day 2 §13) |

---

## 3. Architecture-shape decisions

| # | Decision | Status |
|---|---|---|
| A1 | Request flow: user → ZAC endpoint → auth/role resolution → context → Context Assembler → Role Profile Selector → Permission-Aware Tool Registry → Model Router → evidence-grounded answer → memory/audit/measurement/cost logging. | Recommended (Day 2 §3) |
| A2 | **Context Assembler passes only the minimum relevant context** — never dumps the full DB or knowledge base into the model. | Recommended (Day 2 §7; Day 1 §12D) |
| A3 | **Provider-agnostic Model Router** — QLOOQO must not depend on one provider's API format; providers sit behind an interface and are swappable. | Recommended (Day 2 §11; Day 1 §14) |
| A4 | Standard **evidence-grounded response contract** and **recommendation contract** (see Day 2 §9 for the JSON shapes). | Recommended (Day 2 §9) |

---

## 4. Open questions — for Cosan (technical)

These require confirmation before Phase 1 build. They extend Day 1 §20.

| # | Question | Status |
|---|---|---|
| QC1 | Confirm `apps/api/src/zac/` as the future module location. | Open |
| QC2 | Should ZAC tools call **internal services directly** or **guarded API/controller equivalents**? (Day 1 recommends riding the guarded controllers so guards + `business_id` filters always run.) | Open |
| QC3 | Are existing **report / CRM / audit permissions sufficient** for Phase 1? | Open |
| QC4 | Is a dedicated **`zac.access` permission** needed? | Open |
| QC5 | Do **KPI snapshots** belong in `zac.kpi_snapshots` or in `analytics`? (Day 1 notes the empty `analytics` schema appears reserved for this.) | Open |
| QC6 | Confirm **audit event naming conventions** (e.g. `zac.answer.delivered`) and human-vs-`agent` actor attribution (`audit.activity_log` has no `agent` actor today). | Open |
| QC7 | How should **prompt/response PII be logged or redacted**? (The request logger currently logs full URLs incl. lab `sessionId`.) | Open |
| QC8 | Confirm **production schema parity** before Phase 1 planning (Day 1 findings are from the dev-test branch). | Open |

---

## 5. Open questions — for Luke (product)

These extend Day 1 §19.

| # | Question | Status |
|---|---|---|
| QL1 | First role-specific **coaching examples** for owner, manager, and stylist. | Open |
| QL2 | Product term: **"recommendation", "nudge", "coaching point"**, or another? | Open |
| QL3 | How **assertive** should ZAC be when presenting underperformance? | Open |
| QL4 | Should owners see a separate **"Value Created by ZAC" dashboard** in Phase 1, or only reports? | Open |
| QL5 | Which **outcome metric has highest priority** for first measurement: revenue, profit, rebooking, retail, waste, utilisation, retention, staff development, or time saved? | Open |

---

## 6. Deferred (explicitly out of Phase 1)

Reproduced from Day 1 §17 for continuity; confirmed unchanged by Day 2.

- Voice, WhatsApp, and phone reception channels (core is designed to accept them later as adapters — Day 2 §14).
- Autonomous actions / write tools (need approval workflow + agent audit identity + audit backfill + sign-off).
- Advanced business coaching (needs longitudinal KPI snapshots to exist first).
- Scheduled digests / reporting automation (no durable scheduler today).
- Ordering / stock actions (no PO model; ordering is email-not-API).
- Cross-business intelligence (blocked by one-primary-business collapse).
- Financials / P&L / retail / margin answers (input tables empty in the inspected dataset).
- Semantic / vector KB retrieval (start rule-based).

---

## 7. Day 3 decisions — Knowledge, Tools and Outcome Memory

Added 2026-07-20 from [`phase-0-day-3-knowledge-tools-outcome-memory.md`](phase-0-day-3-knowledge-tools-outcome-memory.md). These extend the Day 2 decisions above; none is implemented.

| # | Decision | Status | Linkage |
|---|---|---|---|
| D9 | ZAC should **not only remember conversations; ZAC should remember outcomes**. | Recommended-lock | Day 3 §2, §11–§12 |
| D10 | Knowledge should be **separated into** Constitution, QLOOQO platform, QLab, reports/KPIs, role coaching, and salon-specific business knowledge. | Recommended-lock | Day 3 §3 |
| D11 | **Phase 1 tools should be read-only.** | Recommended-lock | Day 3 §6; reaffirms D4 |
| D12 | **Write/action tools are deferred.** | Recommended-lock | Day 3 §8 |
| D13 | **Context Memory and Outcome Memory should be separated.** | Recommended-lock | Day 3 §9, §11 |
| D14 | ZAC should **measure business reality first**, not only whether his own recommendation was accepted. | Recommended-lock | Day 3 §12, §24 |
| D15 | **Attribution should be honest and confidence-based.** | Recommended-lock | Day 3 §12.3, §17 |
| D16 | Future ZAC tables may include conversations, messages, memory, knowledge documents, recommendations, recommendation events, observed outcomes, recommendation outcomes, KPI snapshots, and cost events. | Recommended (schema proposal) | Day 3 §19 |
| D17 | **Tenant privacy remains absolute.** | Recommended-lock | Day 3 §18; reaffirms D2 |
| D18 | Any future **cross-salon learning must be aggregated, anonymised, validated, and privacy-safe**. | Recommended-lock | Day 3 §18 |

### Day 3 open decisions

Day 3 raises further open decisions. Most reaffirm/extend the Day 2 open questions in §4 (Cosan) and §5 (Luke); the full Day 3 lists (with the net-new items — product term, memory visibility, first value headline, assertiveness, showing confidence levels, manual "did this help?" marking, and value-report cadence for Luke; knowledge-store location, snapshot location, event/audit separation, tool boundary, endpoint stability, `zac.access`, PII redaction, and snapshot/reconciler jobs for Cosan) are tracked in the Day 3 doc §22 (Luke) and §23 (Cosan).

---

## 8. Day 4 decisions — Value Created and Cost per Intelligence

Added 2026-07-21 from [`phase-0-day-4-value-created-cost-per-intelligence.md`](phase-0-day-4-value-created-cost-per-intelligence.md). These extend the Day 2/Day 3 decisions above; none is implemented. They also capture the Day 3 discussion decisions from Luke and Cosan that Day 4 formalises.

| # | Decision | Status | Linkage |
|---|---|---|---|
| D19 | **User-facing language should prefer Insight, Coaching Point, Opportunity, Risk or Watch Point** over "recommendation." "Recommendation" remains an internal technical term only. | Recommended-lock | Day 4 §3; resolves Day 3 §22 Q1 / QL2 |
| D20 | **Value Created should be a dashboard/report, not one single metric** — sections for revenue, profit, retail, rebooking, waste, time saved, team development, business health, subscription ROI, etc. | Recommended-lock | Day 4 §7, §9; Luke Day 3 §22 Q3 |
| D21 | **Value must be separated into Observed, Influenced and Directly Attributable.** ZAC never over-claims causation. | Recommended-lock | Day 4 §4; Day 3 §12.3, §17 |
| D22 | **Important value estimates should show confidence levels** — especially important insights, value estimates and opportunities. | Recommended-lock | Day 4 §5; Luke Day 3 §22 Q5 |
| D23 | **Every value claim must include evidence and assumptions** — source, metric changed, evidence, attribution, confidence, calculation method, limitations (the seven-part rule). | Recommended-lock | Day 4 §6 |
| D24 | **Manual feedback from owners/managers ("did this help?") should become part of the learning model**, not just a UI state. | Recommended-lock | Day 4 §9; Luke Day 3 §22 Q6 |
| D25 | **Stylist personal coaching memory should remain private where possible** between ZAC and the stylist. | Recommended-lock | Day 4 §9; Luke Day 3 §22 Q2; Day 3 §10 |
| D26 | **Owners/managers should see themes, trends, risks and performance signals rather than private coaching conversations.** | Recommended-lock | Day 4 §9; Luke Day 3 §22 Q2 |
| D27 | **ZAC events should be separate from core audit logs**, with only critical/compliance-relevant events mirrored into the main audit log. | Recommended-lock | Day 4 §15; Cosan Day 3 §23 Q3; Day 1 §11 |
| D28 | **ZAC should have an explicit `zac.access` permission plus normal report/CRM/QLab permissions** — access to ZAC is explicit, but what ZAC can see depends on the user's normal permissions. | Recommended (extends QC4) | Day 4 §26; Cosan Day 3 §23 Q6 |
| D29 | **Knowledge = controlled storage + structured metadata** — raw documents in controlled storage; structured metadata in `zac.knowledge_documents` (later `zac.knowledge_chunks`) supporting versioning, source, permission scope, type, module mapping, future embeddings. | Recommended (schema proposal) | Cosan Day 3 decisions; Day 3 §4 |
| D30 | **KPI snapshots live in a dedicated ZAC area (`zac.kpi_snapshots`)** sourced from existing analytics/reporting logic; existing reporting/analytics remains the source of truth; ZAC snapshots are evidence/context records. | Recommended (extends QC5) | Day 4 §12, §15; Cosan Day 3 §23 Q2 |
| D31 | **ZAC tools go through guarded service/API-style contracts**, each enforcing acting-user context, business/location scope, role permissions, allowed fields and read-only rules. | Recommended-lock (reaffirms D3) | Day 4 §13; Cosan Day 3 decisions; Day 2 §8 |
| D32 | **Do not store raw sensitive prompt/response data in logs by default** — store structured metadata, summaries, source references, tool calls, insight/opportunity IDs, confidence, attribution and outcome links; PII redacted/tokenised unless a clear product reason exists; retained memory respects tenant/user/role boundaries. | Recommended-lock | Day 4 §15, §26; Cosan Day 3 §23 Q7 |
| D33 | **Cost figures are configurable planning assumptions, not committed vendor prices** — no live provider prices are hardcoded; provider pricing must be re-read from official pricing pages before commercial sign-off. | Recommended-lock | Day 4 §17 |
| D34 | **Phase 0 validation is a non-production proof-of-architecture package**, not a production-integrated ZAC implementation (no live login, UI, migrations, LLM, tools, memory tables, Sunday-report integration, or autonomous actions). | Recommended-lock | Day 4 §23; Acceptance Criteria |

### Day 4 open decisions

Day 4 raises further open decisions, tracked in the Day 4 doc: **Luke** (§25) — Value Created surface (dashboard vs reports), report cadence, first value headline, confidence display, Observed-value visibility, manual-feedback learning, stylist coaching privacy, business-health score formula. **Cosan** (§26) — cost-events store, KPI-snapshot store, attribution reconciler infra, pricing config, per-tenant budgets/routing, PII in cost/outcome telemetry, USD↔GBP FX handling, report/review generation infra. These extend §4 (Cosan) and §5 (Luke) above.

---

## 9. Day 5 decisions — Final Package, Acceptance and Roadmap

Added 2026-07-22 from [`phase-0-day-5-final-package-acceptance-roadmap.md`](phase-0-day-5-final-package-acceptance-roadmap.md). These close out Phase 0; none is implemented. They capture Luke's final acceptance decision (the First-Time Value Clarity Test) and Cosan's agreement on the proof-of-architecture contents and the future Manager Coaching Journey capability.

| # | Decision | Status | Linkage |
|---|---|---|---|
| D35 | **The First-Time Value Clarity Test becomes a core Phase 0 acceptance criterion** — Luke's question: *"If I were a salon owner seeing ZAC for the first time, would I immediately understand why this is valuable?"* — applied per role (Owner / Manager / Stylist clarity). | Recommended-lock (Luke's decision) | Day 5 §5 |
| D36 | **The Phase 0 proof-of-architecture should validate business value, not only technical design** — role scenarios, evidence-backed answers, memory examples, lifecycle, attribution, sample Value Created report, ROI vs subscription, and *why* each insight/coaching point was made. | Recommended-lock | Day 5 §6; Luke + Cosan agreement |
| D37 | **The proof-of-architecture remains non-production and scenario/test-data based unless separately agreed** — no production login, real UI, migrations, live tools, real LLM, live memory tables, live Sunday-report integration, or autonomous actions. | Recommended-lock (reaffirms D34) | Day 5 §6.2; Day 4 §23 |
| D38 | **Manager Coaching Journey is captured as a future strategic capability** — one proof-of-architecture scenario now (underperformance coaching); phased delivery later (Phase 1 basic coaching points → Phase 2 structured journeys → Phase 3 policy-aware workflows → HR integration only if approved). | Recommended-lock (Cosan agreement) | Day 5 §11, §18 |
| D39 | **ZAC may guide managers through evidence, coaching steps, support history and measurable improvement targets** — the ten-question journey, connected to Outcome Memory and Value Created reporting. | Recommended | Day 5 §11, §14 |
| D40 | **ZAC must not replace managers, make employment decisions, or act as HR/legal authority** — never auto-recommend disciplinary action as a decision, never shame a stylist; final decisions rest with the human manager and company process. | Recommended-lock (permanent boundary) | Day 5 §3, §11, §18 |
| D41 | **Stylist private coaching memory remains protected.** | Recommended-lock (reaffirms D25) | Day 5 §10, §13.1 |
| D42 | **Manager/owner visibility should focus on themes, trends and performance signals** — never private coaching conversations. | Recommended-lock (reaffirms D26) | Day 5 §13.2 |
| D43 | **Phase 1 remains read-only.** | Recommended-lock (reaffirms D4/D11) | Day 5 §17; Roadmap §11 |
| D44 | **The Phase 1 MVP should prioritise role-aware, permission-aware, evidence-backed intelligence** — with the measurement and cost spine from day one; autonomy and channels deferred. | Recommended-lock | Day 5 §17; [`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md) |

### Day 5 open decisions

The remaining open decisions for Phase 0 sign-off are consolidated in Day 5 §20: **Luke** — final terminology per surface, dashboard display order, low-confidence value visibility, cadence, first headline, feedback UX wording, manager-coaching assertiveness. **Cosan** — final tool source endpoints, ZAC table locations, KPI snapshot schema, cost event schema, PII redaction rules, `zac.access` implementation, demo harness vs backend-first MVP, Sunday-report integration path. These supersede-and-consolidate the corresponding items in §4–§5 and the Day 3/Day 4 open lists.

---

## 10. Sign-off process decisions

Added 2026-07-22 from [`phase-0-sign-off-walkthrough.md`](phase-0-sign-off-walkthrough.md). These define **how** Phase 0 is accepted; agreed by Luke (review request) and Cosan (review structure confirmation).

| # | Decision | Status | Linkage |
|---|---|---|---|
| D45 | **Phase 0 sign-off will be completed through a live walkthrough** with Luke, Cosan and Oleksandr, run checklist item by checklist item, before payment and acceptance. | Agreed (Luke + Cosan) | Walkthrough §1–§3, §25 |
| D46 | **The walkthrough uses realistic test data and documented proof-of-architecture scenarios** ("The Colour Room" walkthrough dataset; Owner/Manager/Stylist + Manager Coaching Journey scenarios). | Agreed | Walkthrough §8–§12 |
| D47 | **The walkthrough is not a production ZAC implementation demo** — no live app UI, real login/user switching, real LLM calls, migrations, live memory tables, live tool execution, live Sunday-report integration, or autonomous actions. | Agreed (reaffirms D37) | Walkthrough §1, §6 |
| D48 | **Luke will validate product value, the acceptance criteria and First-Time Value Clarity** during the session, via the approval checklist. | Agreed | Walkthrough §23; Acceptance Criteria §3, §8 |
| D49 | **Cosan will validate technical fit, feasibility, data isolation, permissions and Phase 1 scope readiness** during the session, via the technical confirmation checklist. | Agreed | Walkthrough §22 |
| D50 | **Formal acceptance depends on the checklist review and any required clarifications** — recorded as approved / approved with minor clarifications / changes required, with remaining questions captured. | Agreed | Walkthrough §24; Acceptance Criteria §8 |
| D51 | **Phase 0 sign-off will include both the structured walkthrough and free interaction validation** using realistic salon test data — Luke asks natural Owner/Manager/Stylist questions off-script; passes if Luke feels ZAC would help him run and improve a salon better than reports alone. | Agreed (Luke's request) | Walkthrough §26 |
| D52 | **Free interaction remains proof-of-architecture, not production implementation** — answers are walked through against the documented design and mock data, not a live system. | Agreed (reaffirms D37/D47) | Walkthrough §26 |
| D53 | **A surprise hidden-value scenario will be included to demonstrate ZAC's proactive business value** — the Hidden Profit Leak: correlated Tuesday-utilisation / colour-rebooking / waste / coaching signals surfaced unprompted, with honest value-at-risk and overlap declarations. | Agreed | Walkthrough §27 |

---

*Documentation only. No decision in this log has been implemented in code, schema, configuration, or data. "Recommended-lock" items await explicit sign-off from Cosan (technical) and Luke (product) before any Phase 1 build begins.*
