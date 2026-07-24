# Phase 0 Sign-Off Walkthrough

> **Status: Documentation only — NOT implemented.**
> This is the live-review script for the Phase 0 sign-off session with **Luke, Cosan and Oleksandr**. It is a **proof-of-architecture walkthrough using realistic test data and documented scenarios** — it is **not** a production ZAC demo inside the live app, real ZAC UI, live LLM integration, live memory-table execution, live tool execution, real database migrations, or autonomous actions. **No application source code, NestJS modules, migrations, environment files, package manifests, or Supabase data have been created or changed** to produce it.
>
> Date: 2026-07-22 · Phase: 0 (Discovery & Architecture) · Companion to: [Day 1](QLOOQO/ZAC%20Phase%200%20Discovery%20Report.md) · [Day 2](phase-0-day-2-core-architecture.md) · [Day 3](phase-0-day-3-knowledge-tools-outcome-memory.md) · [Day 4](phase-0-day-4-value-created-cost-per-intelligence.md) · [Day 5](phase-0-day-5-final-package-acceptance-roadmap.md) · [Acceptance Criteria](phase-0-acceptance-criteria.md) · [Phase 1 MVP Roadmap](phase-1-mvp-roadmap.md).

---

## 1. Purpose of the Walkthrough

- This walkthrough **demonstrates the completed Phase 0 package** — the architecture, scenarios, value/cost models and roadmap produced across Days 1–5.
- It **validates the architecture and the proof-of-architecture scenarios** item by item, on realistic test data.
- It **supports formal review before Phase 0 acceptance and payment.**
- It **confirms whether the foundation is sufficient for Phase 1 MVP planning.**
- It is **not a production implementation demo** — nothing shown is running code; everything shown is the documented design behaving as specified.

The session goes **checklist item by checklist item**, captures remaining questions, and ends with a recorded decision: approved, approved with minor clarifications, or not yet approved (§24).

---

## 2. Review Participants and Roles

### Luke — product owner / founder review
- Validates **product value** — does ZAC deliver what a salon owner actually needs?
- Validates the **First-Time Value Clarity Test** (Day 5 §5) against each scenario.
- Checks the **acceptance criteria** ([`phase-0-acceptance-criteria.md`](phase-0-acceptance-criteria.md)).
- **Approves or requests clarification** (§23–§24).

### Cosan — platform and implementation feasibility review
- Validates **fit with the existing QLOOQO backend, Supabase structure, permissions and architecture.**
- Confirms **feasibility for Phase 1 MVP scoping** — can Phase 1 be accurately scoped and implemented from this Phase 0? (§22.)

### Oleksandr — presenter
- **Presents the Phase 0 architecture.**
- **Walks through the proof-of-architecture scenarios** (§9–§12).
- **Explains** the ZAC architecture, memory, attribution, value and cost models.
- **Captures open questions and clarifications** into §24 and the [decision log](phase-0-decision-log.md).

---

## 3. Walkthrough Agenda

1. Phase 0 scope recap — §4
2. What Phase 0 includes and excludes — §5–§6
3. ZAC architecture overview — §7
4. Realistic test salon data — §8
5. Owner scenario — §9
6. Manager scenario — §10
7. Stylist scenario — §11
8. Manager Coaching Journey future scenario — §12
9. Role and permission boundaries — §13
10. Context Memory examples — §14
11. Outcome Memory examples — §15
12. Insight / Coaching Point / Opportunity lifecycle — §16
13. Attribution model — §17
14. Sample Value Created by ZAC report — §18
15. ROI calculation — §19
16. Cost per Intelligence model — §20
17. Phase 1 MVP roadmap — §21
18. Deferred production scope — §21 (excludes list)
19. Free Interaction Validation — §26
20. Surprise scenario: hidden profit leak — §27
21. Cosan technical confirmation checklist — §22
22. Luke approval checklist — §23
23. Final acceptance decision — §24

Suggested timings are in §25.

---

## 4. Phase 0 Scope Recap

| Day | Delivered |
|---|---|
| **Day 1** | **Platform and Vision Review** — read-only discovery of the QLOOQO repo + Supabase; constitution→architecture mapping; the two design-dominating findings (application-layer tenant isolation; ZAC 100% greenfield). |
| **Day 2** | **Core ZAC Architecture** — server-side module, acting-user context, permission-aware tool registry, evidence-grounded contracts, model router, measurement & cost telemetry. |
| **Day 3** | **Knowledge, Tools and Outcome Memory** — knowledge categories, typed read-only tools, Context vs Outcome Memory, recommendation lifecycle, honest attribution, privacy boundaries. |
| **Day 4** | **Value Created and Cost per Intelligence** — user-facing language, Observed/Influenced/Directly Attributable value, confidence & evidence models, 15 value categories, cost units, usage profiles, scaling, margin bands. |
| **Day 5** | **Final Package, Acceptance Criteria and Phase 1 Roadmap** — First-Time Value Clarity Test, proof-of-architecture scenarios, Manager Coaching Journey (future), Phase 1 MVP roadmap, sign-off checklist. |

> **Phase 0 is complete when the documented architecture, scenarios, acceptance criteria and roadmap are reviewed and accepted.** That acceptance is what this walkthrough produces.

---

## 5. What Phase 0 Includes

- **Architecture documentation** (Days 1–5).
- **Proof-of-architecture scenarios** (Owner / Manager / Stylist / Manager Coaching Journey).
- **Realistic test data** (§8 — mock; no real client PII).
- **Acceptance criteria** ([`phase-0-acceptance-criteria.md`](phase-0-acceptance-criteria.md)).
- **Value Created report sample** (§18).
- **Cost per Intelligence model** (§20; Day 4 §13–§22).
- **Phase 1 MVP roadmap** ([`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md)).
- **Future capability mapping** (Manager Coaching Journey, channels, Sunday-report integration).
- **Sign-off checklist** (§22–§24; Day 5 §19).

---

## 6. What Phase 0 Excludes

- Production ZAC implementation.
- Live app UI.
- Real login/user-switching implementation.
- Real LLM API calls.
- Real database migrations.
- Live memory tables.
- Live tool execution.
- Live Sunday report integration.
- Autonomous actions.
- HR/legal decision automation.

> Everything above belongs to **Phase 1** or a **separately agreed prototype/spike** (Decision Log D37). If any of it is expected in *this* review, stop and recalibrate before continuing.

---

## 7. Core ZAC Architecture Summary

> **ZAC is a server-side, role-aware, permission-aware intelligence layer inside QLOOQO that uses QLOOQO data as the source of truth, explains insights with evidence, remembers meaningful context and outcomes, measures value created, and helps owners, managers and stylists improve over time.**

Architecture flow (Day 2 §3):

```
Authenticated QLOOQO user
  → ZAC API endpoint
  → Auth and role resolution
  → Business / location / role / permission context
  → Context Assembler
  → Role Profile Selector
  → Permission-Aware Tool Registry
  → Model Router
  → Evidence-Grounded Answer / Insight / Coaching Point / Opportunity
  → Memory, Audit, Measurement and Cost Logging
```

Key properties to point out live: permission and scope are resolved **before the model runs**; ZAC authenticates as the **acting user** (never a service-role key); every answer carries **evidence**; every meaningful interaction is **measured and costed** from day one.

---

## 8. Realistic Test Salon Data

> **Walkthrough dataset.** All figures are mock data for the live session. This dataset is the **current walkthrough edition** of "The Colour Room" and **supersedes the earlier illustrative draft figures in Day 5 §7** for review purposes — same salon and cast, refreshed numbers. Present *these* numbers in the session.

### The salon

| | |
|---|---|
| **Salon** | The Colour Room |
| **Business** | 1 salon business |
| **Location** | 1 location |
| **Owner** | Emma |
| **Manager** | Sarah |
| **Stylists** | Mia, Olivia, Jade |
| **Subscription cost** | **£399 / month** |

### Business metrics

| Metric | Value |
|---|---|
| Revenue this month | £42,000 |
| Revenue last month | £39,500 |
| Retail revenue this month | £3,600 |
| Retail revenue last month | £2,900 |
| Average rebooking rate | **51%** |
| Target rebooking rate | **60%** |
| Colour waste this month | £780 |
| Colour waste last month | £1,050 |
| Average utilisation | 72% |
| Saturday utilisation | 94% |
| **Tuesday utilisation** | **48%** |
| Client retention risk | **18 clients overdue for rebooking** |

### Stylist metrics

| Metric | **Mia** | **Olivia** | **Jade** |
|---|---|---|---|
| Rebooking rate | 44% | 62% | **39%** |
| Retail attach rate | 12% | 21% | 8% |
| Colour waste trend | improving | stable | **worsening** |
| Utilisation | 76% | 81% | **58%** |

> *Note for reviewers:* the salon's 51% average rebooking rate is **client-weighted**, so it sits above the simple mean of the three stylist rates — busier columns weigh more. Olivia is the benchmark; Mia is mid-recovery; Jade is the seed for the Manager Coaching Journey scenario (§12).

---

## 9. Owner Scenario Walkthrough

**Emma asks:** *"ZAC, what is the biggest opportunity in my business this month?"*

**Expected ZAC behaviour:**
- Identifies **Owner** role; uses **business-wide permissions**.
- Checks revenue, rebooking, utilisation, retail and colour waste through permission-gated read tools.
- Provides a **business-level insight** with evidence, confidence, and an estimated value.
- **Avoids exposing private stylist coaching memory** (themes only).
- Creates an **outcome-measurement-ready** insight (expected outcome + measurement window defined).

**Sample answer (present live):**

> **Opportunity — your biggest lever this month is rebooking.**
>
> **Evidence:**
> - Current rebooking rate: **51%** · Target: **60%**
> - **18 clients overdue** for rebooking
> - Estimated average future visit value: **£90**
> - Potential recovered booking value: **18 × £90 = £1,620**
>
> **Why this first:** revenue is up (£42,000 vs £39,500) and Saturday runs at 94%, so growth isn't the constraint — retaining booked clients is. Retail (+£700) and colour waste (−£270) are both already moving the right way.
>
> **Attribution:** Observed opportunity — **not yet directly attributable**; no value is claimed until outcomes are measured within the window.
> **Confidence:** **Medium–high** (complete booking data; visit value is an average-based estimate).
> **Suggested focus:** prioritise the overdue **colour** clients first — highest visit value and strongest relationships.
>
> *(Private stylist coaching conversations are not part of this view — Emma sees themes and metrics only.)*

**Acceptance check (Luke, live):**
- ☐ Does the Owner understand why this matters?
- ☐ Is value clear?
- ☐ Is evidence visible?
- ☐ Is confidence visible?
- ☐ Are private stylist coaching memories protected?

---

## 10. Manager Scenario Walkthrough

**Sarah asks:** *"ZAC, what should I focus on with the team this week?"*

**Expected ZAC behaviour:**
- Identifies **Manager** role; applies **location/team permissions**.
- Checks operational and staff-level signals; shows **team themes and performance signals**.
- **Avoids exposing private stylist coaching conversations.**
- Suggests **practical next steps** with **measurable targets and a review cadence**.

**Sample answer (present live):**

> **Coaching Point — two focuses this week: rebooking consistency and Tuesday utilisation.**
>
> **Evidence:**
> - Rebooking rate **51%** vs target **60%** · **18 overdue clients**
> - **Tuesday utilisation 48%** vs 72% average (Saturday 94% — the demand exists, the spread doesn't)
>
> **Practical steps:** make the next-visit question a standard part of checkout this week; split the 18 overdue clients across the team for follow-up; move training or a colour offer onto Tuesdays.
>
> **Expected improvement:**
> - Rebooking from **51% toward 55% within two weeks**
> - Tuesday utilisation up **5–8 percentage points**
> - Overdue clients reduced from **18 to below 10**
>
> **Review date: 14 days** — I'll track the numbers and what support was offered.
>
> *(Individual coaching themes are flagged where relevant — e.g. one stylist is working on rebooking confidence — but private coaching conversations are never shown.)*

**Acceptance check (Luke, live):**
- ☐ Does the Manager understand what to do next?
- ☐ Is it practical?
- ☐ Is evidence visible?
- ☐ Are private stylist conversations protected?
- ☐ Are measurable improvement targets defined?

---

## 11. Stylist Scenario Walkthrough

**Mia asks:** *"ZAC, how can I improve this week?"*

**Expected ZAC behaviour:**
- Identifies **Stylist** role; uses **only personal/permitted data**.
- Gives **supportive personal coaching** — a coach, not surveillance.
- **Does not expose other stylists' data** (no peer comparison).
- Provides **one measurable improvement focus**.
- **Respects private coaching memory** — the conversation stays between Mia and ZAC.

**Sample answer (present live):**

> **Coaching Point — one thing this week: rebooking confidence.**
>
> **Evidence:** your rebooking rate is **44%**; the salon target is **60%**. Your colour clients love the results — they just aren't booking the next visit before they leave.
>
> **A script that works:** *"Your colour should stay fresh for around 6–8 weeks. Shall we book your next refresh now so you get the time that suits you?"* You're looking after their hair, not selling.
>
> **This week's target:** aim to rebook **2 more clients** than usual — small and doable.
> **Confidence: Medium** (your data is complete; the improvement estimate is a coaching expectation, not a promise).
>
> *This conversation is between us. Your manager sees your performance numbers as usual, but not what we talk about here.*

**Acceptance check (Luke, live):**
- ☐ Does the Stylist feel coached, not monitored?
- ☐ Is the tone supportive?
- ☐ Is only permitted/personal data used?
- ☐ Is the improvement target small and measurable?

---

## 12. Manager Coaching Journey Scenario

> **Clarify before presenting:** this is a **future strategic capability** (Day 5 §18), **not a Phase 1 full implementation requirement**. It is walked through now to validate the boundary and the structure on paper.

**Sarah asks:** *"ZAC, Jade has been underperforming for several weeks. What should I do?"*

**Expected ZAC behaviour:**
- Detects a **sensitive people-management request**; uses **manager permissions**.
- Reviews performance evidence; **avoids exposing private stylist coaching memory**.
- Identifies patterns; suggests **supportive first steps**; provides a **structured coaching journey**.
- Recommends a **review timeline**; tracks support and outcomes **conceptually** (live tracking is a future build).
- Keeps the **human decision boundary** explicit.

**Sample response (present live):**

> **This is a coaching situation, and you lead it — I'll bring the evidence and a structure.**
>
> **Evidence:** rebooking **39%**, retail attach **8%**, utilisation **58%**, colour waste trend **worsening** — a simultaneous multi-metric dip against her own baseline.
>
> **Possible causes** *(patterns to explore, not conclusions)*: rebooking confidence · consultation structure · diary gaps · retail confidence · a personal support need. A dip across several metrics at once usually points to something a conversation can uncover — not a skills verdict.
>
> **Recommended first coaching focus:** rebooking and client follow-up — the highest-impact, most coachable area.
>
> **Suggested conversation wording:** *"You've seemed less yourself these past few weeks and I'd like to help — how are things going? I'd love to work out together what would make this easier."* Lead with support; bring numbers only if she asks.
>
> **Support plan:** a quieter column for two weeks · pairing on rebooking conversations · a short Friday check-in.
>
> **Expected improvement:** rebooking back **above 45% within 4 weeks**, agreed *with* Jade, not handed down.
>
> **Review timeline:** check in weekly; review together at **2 weeks** and **4 weeks**. Support offered and outcomes will be tracked so the review is evidence-based.
>
> **Human decision boundary:** I don't make employment decisions and this is not a disciplinary recommendation. Jade's private coaching conversations with me stay between her and me. If, after fair support and time, you're considering any formal step, that decision belongs to you and The Colour Room's own company process — follow policy and take HR/legal advice where appropriate.

**The boundary (state it verbatim):** ZAC can **guide, prepare and track**. ZAC must **not** replace the manager, make employment decisions, act as HR/legal authority, or automatically recommend disciplinary action as a decision.

**Acceptance check (Luke + Cosan, live):**
- ☐ Does ZAC guide without deciding?
- ☐ Is evidence used fairly?
- ☐ Are possible causes explored?
- ☐ Is coaching structured?
- ☐ Are measurable targets included?
- ☐ Is human decision authority preserved?

---

## 13. Role and Permission Boundary Walkthrough

**Owner can see:**
- business health · Value Created report · ROI · team performance **themes** · business opportunities · location-level performance
- **not** private stylist coaching conversations by default

**Manager can see:**
- location/team performance · operational priorities · team coaching **themes** · measurable improvement targets
- **not** private stylist coaching conversations by default

**Stylist can see:**
- personal performance · permitted client/workflow context · personal coaching memory · improvement targets
- **not** other stylists' private data
- **not** owner-level financials unless permitted

> **Technical rule (state it verbatim): ZAC can only see what the acting user is allowed to see.** Tool availability is derived from the user's own permissions before the model runs (Day 2 §8) — a stylist's ZAC *structurally cannot* reach owner financials, even if asked.

---

## 14. Context Memory Walkthrough

Three examples showing the memory scopes (Day 3 §9–§10):

**1. Private stylist coaching memory** — *scope: private to the stylist and ZAC.*
> "Stylist is working on rebooking confidence and prefers short practical scripts."
Never visible to Sarah or Emma; feeds only the stylist's own coaching.

**2. Manager theme memory** — *scope: manager/owner theme only.*
> "Two stylists may need support with rebooking conversations."
The theme is visible; **no private coaching conversations are exposed.**

**3. Owner/business goal memory** — *scope: business-level, owner/manager where permitted.*
> "Owner wants to reduce colour waste and improve rebooking this quarter."
Shapes ZAC's prioritisation in business-level answers (it is why §9 leads with rebooking).

**Acceptance check (Luke, live):**
- ☐ Is memory useful?
- ☐ Is memory scoped correctly?
- ☐ Is stylist privacy protected?
- ☐ Can memory help future answers without exposing private details?

---

## 15. Outcome Memory Walkthrough

Example record (closing the loop on the §10/§11 coaching points):

| Field | Value |
|---|---|
| Outcome type | rebooking improvement |
| Related output type | Coaching Point |
| Observed value | **2 additional clients rebooked** |
| Financial value estimate | **£180** (2 × £90 average visit) |
| Attribution type | **Influenced** |
| Confidence | **Medium** |
| Measurement window | **14 days** |
| Evidence | coaching point shown · manager marked it useful · appointments booked within the review window |

**Acceptance check (Luke, live):**
- ☐ Does this show what happened *after* ZAC output?
- ☐ Is attribution honest?
- ☐ Is value evidence-backed?
- ☐ Is confidence visible?

---

## 16. Insight / Coaching Point / Opportunity Lifecycle

Every meaningful ZAC output follows one lifecycle (Day 3 §13; Day 5 §12):

1. Signal detected
2. Evidence collected
3. Insight candidate created
4. Permission check
5. ZAC output generated
6. Expected outcome defined
7. Output shown to user
8. User response recorded
9. Measurement window opened
10. Business outcome observed
11. Attribution classified
12. Value estimated
13. Learning recorded

**User-facing labels:** Insight · Coaching Point · Opportunity · Risk · Watch Point.
**Internal technical term:** *recommendation* (lifecycle objects, tables, events — never the primary user-facing word; Day 4 §3).

---

## 17. Attribution Model Walkthrough

**Observed Value** — a positive business outcome happened, but **ZAC does not claim direct influence.**
*Example:* retail revenue increased (£2,900 → £3,600) but no ZAC output was accepted. Reported as business reality; no credit claimed.

**Influenced Value** — ZAC **helped awareness, coaching or decision-making**, but other factors also contributed.
*Example:* the manager acted after ZAC highlighted the Tuesday utilisation gap; a discount factor applies to the resulting value.

**Directly Attributable Value** — there is a **clear link** between ZAC's insight/coaching point/opportunity and the business outcome.
*Example:* ZAC suggested overdue-client follow-up; the user accepted; the client rebooked within the window on the same target entity.

**Acceptance check (Luke, live):**
- ☐ Is attribution honest?
- ☐ Does ZAC avoid over-claiming value?
- ☐ Can value still be reported transparently?

---

## 18. Sample Value Created by ZAC Report

*Sample month for The Colour Room (mock data; layout per Day 4 §9).*

> ### Value Created by ZAC — The Colour Room — sample month
>
> **Subscription cost: £399**
>
> | | |
> |---|---|
> | **Estimated total value** | **£5,190** |
> | Directly attributable value | **£1,420** |
> | Influenced value | **£2,310** |
> | Observed value *(context — no credit claimed)* | **£1,460** |
>
> **Direct ROI:** **3.6×** · **Direct + Influenced ROI:** **9.3×** · **Total observed business value vs subscription:** **13.0×**
>
> **Breakdown:**
>
> | Category | Value |
> |---|---|
> | Revenue Influenced | £1,120 |
> | Rebooking Improvement | £850 |
> | Retail Growth | £620 |
> | Colour Waste Reduced | £410 |
> | Utilisation Improvement | £1,340 |
> | Management Time Saved | £550 |
> | Team Development | £300 *(estimated value)* |
> | **Total** | **£5,190** |
>
> **Confidence:** High confidence **£1,420** · Medium confidence **£2,310** · Low confidence / modelled **£1,460** *(observed and modelled value is held at low confidence by policy and excluded from the claimed ROI)*.
>
> **What ZAC learned:** rebooking coaching points had the strongest connection to measurable revenue impact this month.
>
> **Limitations:** retail attribution is partial because not all retail transactions are linked to ZAC outputs yet; time saved is estimated.

**Acceptance check (Luke, live):**
- ☐ Does the Owner understand value?
- ☐ Is ROI clear?
- ☐ Is attribution transparent?
- ☐ Are limitations clear?
- ☐ **Does this answer Luke's First-Time Value Clarity Test?**

---

## 19. ROI Calculation Walkthrough

Walk the three formulas, on the §18 numbers, live:

```
Direct ROI                        = directly attributable value / subscription cost
Direct + Influenced ROI           = (directly attributable + influenced value) / subscription cost
Total observed value vs subscription = all value categories / subscription cost
```

| Calculation | Result |
|---|---|
| £1,420 / £399 | **3.6×** |
| (£1,420 + £2,310) / £399 = £3,730 / £399 | **9.3×** |
| £5,190 / £399 | **13.0×** |

Emphasise: the **headline ROI is the Direct + Influenced figure**; Observed value is shown for context and never inflates the claim (Day 4 §12).

**Acceptance check (Luke, live):**
- ☐ Is ROI explainable?
- ☐ Are direct/influenced/observed values separated?
- ☐ Are assumptions visible?

---

## 20. Cost per Intelligence Walkthrough

Cost units the model defines (Day 4 §13; illustrative planning figures in Day 5 §16 — **configurable assumptions, no live vendor prices; provider pricing must be refreshed from official pricing pages before commercial sign-off**):

- Cost per conversation
- Cost per insight/coaching/opportunity
- Cost per report
- Cost per business review
- Cost per active user
- Cost per salon
- Cost per enterprise account
- **Cost per value-created pound**

**Target cost ratios** (ZAC operating cost as % of subscription revenue — Day 4 §20):

| Band | Ratio |
|---|---|
| **Ideal** | under 5% |
| **Acceptable early** | 5%–10% |
| **Needs optimisation** | over 10% |
| **Critical** | over 20% |

**Explain live:** **Phase 1 records cost telemetry from the beginning** — every model call logs tokens, model, task type, cache hit and estimated cost — so QLOOQO can understand margin impact as ZAC usage grows. An unmeasured month can never be reconstructed.

**Acceptance check (Luke + Cosan, live):**
- ☐ Does the model explain operating cost?
- ☐ Can QLOOQO track margin?
- ☐ Can Phase 1 capture the telemetry needed later?

---

## 21. Phase 1 MVP Roadmap Walkthrough

**Phase 1 is a controlled, read-only MVP** ([`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md)). ZAC can recommend; ZAC cannot act.

**Phase 1 includes:**
ZAC backend module · ask endpoint · acting-user context · role profile selector · permission-aware tool registry · read-only report/KPI tools · QLab summary tools where stable · booking/rebooking summary tools · personal stylist KPI tools · conversation logging · Context Memory · Outcome Memory foundation · insight/coaching/opportunity logging · confidence/evidence output · cost telemetry · Value Created foundation.

**Phase 1 excludes (deferred production scope):**
autonomous booking creation · SMS/WhatsApp sending · email campaigns · stock ordering · service price changes · staff setting changes · client profile edits · HR/legal decisions · full disciplinary workflow · voice/phone/WhatsApp channels · autonomous actions.

---

## 22. Cosan Technical Confirmation Checklist

Cosan to confirm during the session (mark each live):

- ☐ The proposed architecture **fits the existing QLOOQO backend** (NestJS monolith, controller→service, guards).
- ☐ The architecture **aligns with the current Supabase structure** (schemas, PostgREST access patterns, migration-file convention).
- ☐ The **role/permission model can support Owner/Manager/Stylist behaviour** (`AuthUser.roles[]`, permission catalogue, scope guards).
- ☐ The **data isolation model is safe for Phase 1** (acting-user JWT; application-layer `business_id` scoping; FORCE-RLS planned on new `zac` tables).
- ☐ **ZAC will not use unrestricted DB access** (no service-role key — the single most consequential constraint).
- ☐ **Guarded service/API-style tool contracts are feasible** (Day 3 §6 typed contracts over existing guarded reads).
- ☐ The **knowledge storage + metadata model is feasible** (controlled storage + `zac.knowledge_documents` metadata).
- ☐ **KPI snapshots in a ZAC area sourced from existing reporting/analytics is feasible** (existing engine stays source of truth).
- ☐ **ZAC events separate from the main audit log is feasible** (high-volume tables apart from `audit.activity_log`).
- ☐ **Critical compliance events can be mirrored into audit** where needed.
- ☐ A dedicated **`zac.access` permission is feasible** (combined with normal report/CRM/QLab permissions).
- ☐ The **PII redaction/tokenisation approach is feasible** (summaries + structured metadata; no raw prompt/response logging by default).
- ☐ **Cost telemetry can be captured safely** (`zac.cost_events` per model call).
- ☐ **Phase 1 can be accurately scoped from this architecture.**
- ☐ **Any required changes before Phase 1 are identified** (list them in §24).

---

## 23. Luke Approval Checklist

Luke to confirm during the session (mark each live):

- ☐ The ZAC vision **matches the product direction**.
- ☐ ZAC feels like a **trusted AI team member, not a chatbot**.
- ☐ The **Owner scenario shows clear business value**.
- ☐ The **Manager scenario shows what to do next**.
- ☐ The **Stylist scenario feels supportive and private**.
- ☐ The **First-Time Value Clarity Test passes** (per role, §9–§11 acceptance checks).
- ☐ The **Value Created report is understandable**.
- ☐ The **ROI calculation is transparent**.
- ☐ The **confidence and evidence model builds trust**.
- ☐ The **Manager Coaching Journey direction is aligned** (including the human decision boundary).
- ☐ The **Phase 1 MVP scope is acceptable**.
- ☐ The **deferred scope is clear**.
- ☐ **Phase 0 can be formally accepted — or the needed clarifications are named** (§24).

---

## 24. Final Sign-Off Decision Section

Complete at the end of the session:

**Review outcome** *(select one)*:
- ☐ **Approved**
- ☐ **Approved with minor clarifications** *(list below; clarifications do not block Phase 1 planning)*
- ☐ **Not approved yet — changes required** *(list below; re-review needed)*

| Field | Record |
|---|---|
| **Luke decision** | |
| **Cosan technical confirmation** | |
| **Remaining open questions** | |
| **Required clarifications** | |
| **Phase 1 planning approved** | yes / no |
| **Payment / acceptance status** | pending / approved |

> Whatever is captured here should be appended to the [decision log](phase-0-decision-log.md) after the session, and any "changes required" items become the pre-Phase-1 clarification list.

---

## 25. Suggested Meeting Flow

| Duration | Item |
|---|---|
| 5 min | Phase 0 scope recap (§4–§6) |
| 10 min | Architecture overview (§7) |
| 20 min | Owner / Manager / Stylist scenarios (§8–§11) |
| 10 min | Memory / lifecycle / attribution (§14–§17, incl. §12 coaching journey) |
| 10 min | Value Created / ROI / Cost per Intelligence (§18–§20) |
| 10 min | Phase 1 MVP roadmap (§21) |
| 15 min | Free interaction validation + surprise scenario (§26–§27) |
| 10 min | Cosan technical confirmation (§22) |
| 10 min | Luke acceptance checklist (§23) |
| 5 min | Sign-off decision and next steps (§24) |

*Total: ~105 minutes.*

---

## 26. Free Interaction Validation

**After the structured walkthrough, Luke can ask natural Owner, Manager and Stylist questions using realistic salon scenarios** — off-script, in his own words, against the §8 test data. The structured agenda proves the architecture is *documented*; free interaction validates whether ZAC **feels genuinely valuable**. Both must pass.

> **This remains proof-of-architecture, not production implementation** — answers are walked through against the documented design and mock data, not generated by a live system (Decision Log D47, D52).

### 26.1 Luke's question set

**Owner (Emma's seat):**
1. How healthy is my business today?
2. Where am I losing money?
3. Which salon needs my attention first, and why?
4. Which manager is performing best?
5. What value has ZAC created this month?
6. If I only had one hour today, what should I focus on?

**Manager (Sarah's seat):**
1. Which team members need my attention this week?
2. Why is this stylist underperforming?
3. What evidence supports that?
4. What coaching conversation should I have?
5. What should success look like after that conversation?
6. If there is still no improvement after consistent coaching, what should the next management step be according to our internal process?

**Stylist (Mia's seat):**
1. What should I focus on today?
2. How can I improve my retail?
3. Which clients should I rebook?
4. What am I doing well?
5. What's the one thing that would have the biggest impact on my performance this week?

### 26.2 Response contract — every answer must show

For **each** answer walked through, ZAC must show all eight elements:

| Element | What the reviewers should see |
|---|---|
| **Role context** | Which role asked, and how the answer is shaped for that role. |
| **Permission boundary** | What data the answer could and could not draw on for this user. |
| **Evidence used** | The specific §8 metrics/sources behind every claim. |
| **Reasoning** | Why this conclusion follows from that evidence (signal → evidence → conclusion). |
| **Confidence level** | High / Medium / Low, with the driver named. |
| **Suggested action or coaching focus** | One practical next step, sized to the role. |
| **Outcome measurement method** | Which metric will move, over what window, checked how. |
| **Attribution type** | **Observed**, **Influenced** or **Directly Attributable** — declared prospectively (how the outcome would be classified). |

### 26.3 Presenter notes for specific questions

- **"Which salon needs my attention first?" / "Which manager is performing best?"** — the test business has **one location and one manager**. ZAC must answer *honestly* ("You have one location; within it, here's what needs attention" / "Sarah is your only manager; here is her location's performance") rather than inventing comparisons. This is a deliberate honesty probe — Day 2 §10's "clearly say when data is missing" rule, live.
- **"What value has ZAC created this month?"** — answer *is* the §18 sample report, walked conversationally, with attribution split and limitations intact.
- **"Where am I losing money?"** — leads naturally into the §27 surprise scenario.
- **Manager question 6 (no improvement after consistent coaching)** — this is the **boundary probe**. ZAC's answer must: acknowledge the coaching-and-support history tracked so far; state that the next step is a matter for **The Colour Room's own internal process and policy**; remind the manager to consult that policy and take HR advice where appropriate; and explicitly **decline to recommend a disciplinary step as a decision**. The decision stays with the human manager and company process (Decision Log D40). If ZAC's walked-through answer crosses that line, this section fails.
- **Stylist questions** — personal data only, supportive tone, no peer comparisons; "which clients should I rebook?" uses only the stylist's own permitted client list.

### 26.4 Pass condition

> **The free interaction section passes if Luke feels that ZAC would help him run and improve a salon better than reports alone.**

- ☐ Owner questions answered with the full §26.2 contract
- ☐ Manager questions answered — including the boundary probe handled correctly
- ☐ Stylist questions answered — supportive, private, personal-data-only
- ☐ Luke's verdict recorded: would ZAC help him run and improve a salon better than reports alone?

---

## 27. Surprise Scenario: Hidden Profit Leak

**ZAC surfaces something the owner may not know to ask.** The structured scenarios answer questions; this demonstrates **proactive** value — a Watch Point nobody requested.

**The scenario:** ZAC detects that **low Tuesday utilisation (48%)**, **weak colour-client rebooking**, **one stylist's rising colour waste** and **that stylist's coaching needs (Jade)** are not four separate issues — they are **combining into a recurring hidden profit leak**: quiet Tuesdays concentrate Jade's gaps, gap-heavy days erode her rebooking conversations, and rushed mixing between irregular bookings drives her waste trend.

**Walk through ZAC's explanation, covering all eight elements:**

| Element | Sample content (present live) |
|---|---|
| **Pattern detected** | Four correlated signals recurring weekly: Tuesday utilisation 48% vs 72% average · colour-client rebooking below target (salon 51% vs 60%; Jade 39%) · Jade's colour waste trend worsening while the salon's improves (£780 vs £1,050) · Jade's multi-metric dip (§12). |
| **Why it matters** | Each signal alone looks small; together they repeat **every week** — a structural leak, not a bad day. Left alone, it compounds into lost visits, wasted stock and a struggling team member. |
| **Evidence** | §8 metrics: Tuesday 48% · rebooking 51%/60% · Jade 39% rebooking / worsening waste / 58% utilisation · 18 overdue clients. |
| **Estimated value at risk** | **~£900–£1,400/month** (unfilled Tuesday capacity + at-risk colour rebookings + waste trend). *Honesty note: partially overlaps the §9 rebooking opportunity (£1,620) — these figures are not additive.* |
| **Confidence** | **Medium** — the signals are complete and correlated; the combined £-estimate uses average-value assumptions. |
| **What to do first** | One intervention covers several strands: build Jade's §12 support plan around Tuesdays — quieter-day pairing on rebooking conversations, plus the Tuesday training/offer from §10. Owner approves the focus; manager runs it. |
| **How improvement is measured** | Tuesday utilisation, Jade's rebooking %, Jade's waste trend, overdue-client count — 4-week window, reviewed at 2 and 4 weeks. |
| **Connection to Value Created by ZAC** | Improvements land in the §18 categories (Utilisation Improvement, Rebooking Improvement, Colour Waste Reduced), attributed honestly as Influenced/Directly Attributable per the measured outcomes — this is how a proactive Watch Point becomes reported value. |

**Acceptance check (Luke, live):**
- ☐ Would the owner have found this without ZAC?
- ☐ Is the pattern explained clearly, with evidence?
- ☐ Is the value-at-risk estimate honest (overlaps declared, confidence shown)?
- ☐ Is the first action practical and role-appropriate?
- ☐ Does the leak-to-Value-Created connection make sense?

---

*Documentation only. This walkthrough presents documented architecture and mock-data scenarios; nothing in it is implemented, and nothing in it authorises implementation. Formal acceptance is recorded in §24 and the [decision log](phase-0-decision-log.md); Phase 1 begins only after acceptance ([Day 5 §21](phase-0-day-5-final-package-acceptance-roadmap.md)).*
