# ZAC — Phase 0 Decision Log

> **Status: Documentation only — NOT implemented.**
> This log records architecture decisions and open questions captured during Phase 0. Decisions marked **Recommended-lock** are proposals awaiting sign-off; nothing here has been applied to code, schema, config, or data.
>
> Last updated: 2026-07-20 · Sources: Day 2 Core Architecture + Day 1 Discovery Report.

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

*Documentation only. No decision in this log has been implemented in code, schema, configuration, or data. "Recommended-lock" items await explicit sign-off from Cosan (technical) and Luke (product) before any Phase 1 build begins.*
