# Day 5 — Final Phase 0 Package, Acceptance Criteria and Phase 1 Roadmap

> **Status: Documentation only — NOT implemented.**
> This document assembles the final ZAC Phase 0 package: the sign-off criteria, the proof-of-architecture validation package (scenarios + realistic test data), the First-Time Value Clarity Test, the future Manager Coaching Journey capability, and the Phase 1 MVP roadmap. **No application source code, NestJS modules, database migrations, frontend UI, authentication logic, external API calls, environment files, package manifests, or Supabase data have been created or changed.** Every persona, salon, metric, conversation, table, and roadmap item below is a *proposed design or illustrative scenario on mock data*, not an existing artifact.
>
> Date: 2026-07-22 · Phase: 0 (Discovery & Architecture) · Follows: [Day 1 Discovery Report](QLOOQO/ZAC%20Phase%200%20Discovery%20Report.md), [Day 2 Core Architecture](phase-0-day-2-core-architecture.md), [Day 3 Knowledge, Tools & Outcome Memory](phase-0-day-3-knowledge-tools-outcome-memory.md), [Day 4 Value Created & Cost per Intelligence](phase-0-day-4-value-created-cost-per-intelligence.md).

---

## 1. Purpose

Day 5 brings the whole of Phase 0 together into a **final sign-off package** and defines the gate to Phase 1.

Days 1–4 answered *what QLOOQO is*, *what ZAC is*, *what ZAC knows and remembers*, and *what ZAC is worth and costs*. Day 5 answers the last three Phase 0 questions:

1. **What does "Phase 0 complete" mean?** — the acceptance criteria and sign-off checklist (§4, §19).
2. **How do we prove the architecture works before building it?** — the proof-of-architecture validation package: realistic test data, role scenarios, memory and lifecycle examples, a sample Value Created report, and Luke's **First-Time Value Clarity Test** (§5–§16).
3. **What gets built first?** — the Phase 1 MVP roadmap (§17; standalone in [`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md)) and the future **Manager Coaching Journey** capability (§11, §18).

Day 5 remains **architecture-and-validation documentation only. No implementation should begin until Phase 0 is reviewed and accepted** (§21).

---

## 2. Phase 0 Summary

| Day | Document | What it established |
|---|---|---|
| **Day 1** | [Discovery Report](QLOOQO/ZAC%20Phase%200%20Discovery%20Report.md) | **Platform and Vision Review** — repo/data/permission discovery; tenant isolation is application-layer only (ZAC must never hold a service-role key); ZAC is 100% greenfield; constitution→architecture mapping. |
| **Day 2** | [Core Architecture](phase-0-day-2-core-architecture.md) | **Core ZAC Architecture** — server-side module inside the QLOOQO API; acting-user context; permission-aware tool registry; evidence-grounded contracts; model router; measurement & cost telemetry; read-only Phase 1. |
| **Day 3** | [Knowledge, Tools & Outcome Memory](phase-0-day-3-knowledge-tools-outcome-memory.md) | **Knowledge, Tools and Outcome Memory** — knowledge categories; typed read-only tools; Context Memory vs Outcome Memory; recommendation lifecycle; honest attribution; privacy boundaries; minimum measurement spine. |
| **Day 4** | [Value Created & Cost per Intelligence](phase-0-day-4-value-created-cost-per-intelligence.md) | **Value Created and Cost per Intelligence** — user-facing language (Insight / Coaching Point / Opportunity / Risk / Watch Point); Observed / Influenced / Directly Attributable value; confidence & evidence models; 15 value categories; Sunday-report integration; cost units, usage profiles, scaling, margin bands. |
| **Day 5** | *this document* | **Final Package and Roadmap** — acceptance criteria; First-Time Value Clarity Test; proof-of-architecture scenarios on realistic test data; Manager Coaching Journey (future); Phase 1 MVP roadmap; sign-off checklist. |

---

## 3. Core Phase 0 Conclusion

Phase 0 concludes with one definition:

> **ZAC is a server-side, role-aware, permission-aware intelligence layer inside QLOOQO that uses QLOOQO data as the source of truth, explains insights with evidence, remembers meaningful context and outcomes, measures value created, and helps owners, managers and stylists improve over time.**

ZAC is a **trusted AI team member** whose purpose is to **improve people and businesses every day** — coach by default, business partner when needed (Day 3 §3.1).

**What ZAC is not:**

- **Not a generic chatbot.**
- **Not a frontend-only assistant** — the intelligence, permissions, and memory live server-side (Day 2 §1).
- **Not an unrestricted database agent** — access only through permission-aware tools as the acting user (Day 2 §8; Day 1 §6).
- **Not an autonomous action-taker in Phase 1** — read-only; no write tools exist (Day 2 §4).
- **Not an HR/legal decision-maker** — ZAC never makes employment decisions and never acts as HR or legal authority (§11, §18).
- **Not a replacement for managers or stylists** — ZAC improves people; it does not replace them.

---

## 4. Phase 0 Acceptance Criteria

Phase 0 is accepted when all four criteria groups below are satisfied **by documentation and scenario evidence** — not by production code. (The canonical tracked checklist lives in [`phase-0-acceptance-criteria.md`](phase-0-acceptance-criteria.md).)

### 4.1 Architecture criteria

| # | Criterion | Where |
|---|---|---|
| A1 | Constitution-to-Architecture mapping documented | Day 1 §12 |
| A2 | Platform discovery documented | Day 1 |
| A3 | Server-side ZAC architecture documented | Day 2 §1–§6 |
| A4 | Role/permission model documented | Day 2 §5, §8; Day 3 §5 |
| A5 | Tool access model documented | Day 3 §6–§8 |
| A6 | Read-only Phase 1 boundary documented | Day 2 §4; Day 3 §8 |
| A7 | Memory architecture documented | Day 3 §9–§10 |
| A8 | Outcome Memory documented | Day 3 §11–§17 |
| A9 | Value Created documented | Day 4 §4–§12 |
| A10 | Cost per Intelligence documented | Day 4 §13–§22 |

### 4.2 Product criteria

| # | Criterion | Where |
|---|---|---|
| P1 | ZAC defined as trusted AI team member | §3; Day 3 §3.1 |
| P2 | User-facing terminology defined (Insight / Coaching Point / Opportunity / Risk / Watch Point) | Day 4 §3 |
| P3 | Owner/Manager/Stylist behaviours defined | Day 2 §5; §8–§10 below |
| P4 | Stylist coaching privacy defined | Day 3 §10; Day 4 §9; §13 below |
| P5 | Manager/owner theme visibility defined | Day 4 §9; §13 below |
| P6 | Value Created as dashboard/report (not one metric) | Day 4 §7–§9 |
| P7 | Confidence visibility defined | Day 4 §5 |
| P8 | Manual feedback as learning signal | Day 4 §9 |

### 4.3 Validation criteria

| # | Criterion | Where |
|---|---|---|
| V1 | Owner scenario documented | §8 |
| V2 | Manager scenario documented | §9 |
| V3 | Stylist scenario documented | §10 |
| V4 | Manager Coaching Journey scenario documented | §11 |
| V5 | Evidence-attached sample answers documented | §8–§11 |
| V6 | Context Memory examples documented | §13 |
| V7 | Outcome Memory examples documented | §14 |
| V8 | Insight/Coaching Point/Opportunity lifecycle examples documented | §12 |
| V9 | Observed/Influenced/Direct attribution examples documented | §14–§15; Day 4 §4, §10 |
| V10 | Sample Value Created report documented | §15 |
| V11 | Cost per Intelligence model documented | §16; Day 4 §13–§22 |
| V12 | **First-Time Value Clarity Test documented** | §5 |

### 4.4 Scope criteria

Phase 0 validation is **documentation/scenario based and non-production**. Production implementation — login integration, real UI, migrations, live tools, real LLM, live memory tables, live Sunday-report integration, autonomous actions — is **explicitly excluded** from Phase 0 and belongs to Phase 1 or a separately agreed prototype/spike (§6.2; Day 4 §23.2).

---

## 5. First-Time Value Clarity Test

Luke's final acceptance criterion, verbatim:

> **"If I were a salon owner seeing ZAC for the first time, would I immediately understand why this is valuable?"**

This becomes a **core Phase 0 validation criterion**: the **First-Time Value Clarity Test**. Every proof-of-architecture scenario (§8–§11) must pass it for its role. Technical correctness that fails this test fails Phase 0 — **the proof-of-architecture validates business value, not only technical design.**

### 5.1 Owner value clarity

On first contact with ZAC, an **Owner** should immediately understand:

- **Business value** — what ZAC found and what it is worth.
- **Evidence** — the QLOOQO data behind every claim.
- **ROI** — value created vs the QLOOQO subscription cost.
- **Business priorities** — what matters most right now, in order.
- **Impact areas** — revenue, profit, rebooking, retail, colour waste, utilisation, and team performance.

### 5.2 Manager value clarity

A **Manager** should immediately understand:

- **What needs attention** — the specific operational and team signals.
- **What to do next** — practical, ordered next steps.
- **Why it matters** — the business consequence of each item.
- **What evidence supports it** — sourced, dated data.
- **What measurable improvement is expected** — a target and a window.

### 5.3 Stylist value clarity

A **Stylist** should immediately understand:

- **How to improve** — one clear, achievable focus.
- **That ZAC is a coach, not surveillance** — supportive tone, personal data only, no comparison shaming.
- **One practical improvement focus** — a single small measurable target, not a list of faults.
- **Private coaching boundaries** — their coaching conversation stays between them and ZAC (Day 3 §10; §13 below).

> **Pass condition:** for each role scenario in §8–§11, a first-time reader can answer "why is this valuable to me?" without any additional explanation. The [acceptance criteria](phase-0-acceptance-criteria.md) records this test as a first-class sign-off item.

---

## 6. Proof-of-Architecture Validation Package

The Phase 0 deliverable that gets reviewed and signed off. **Non-production; scenarios and realistic test data only.**

### 6.1 The package includes

- **Realistic test salon data** — §7 (mock; no real client PII).
- **Owner role scenario** — §8.
- **Manager role scenario** — §9.
- **Stylist role scenario** — §10.
- **Manager Coaching Journey scenario** (future capability, validated on paper now) — §11.
- **Evidence-backed answers** — every sample answer carries sources, `as_of`, confidence, limitations (Day 2 §9; Day 4 §6).
- **Context Memory examples** — §13.
- **Outcome Memory examples** — §14.
- **Insight/Coaching Point/Opportunity lifecycle examples** — §12.
- **Attribution examples** — Observed / Influenced / Directly Attributable (§14–§15; Day 4 §4).
- **Sample Value Created dashboard/report** — §15, with ROI against the QLOOQO subscription cost.
- **Cost per Intelligence model** — §16 (full model: Day 4 §13–§22).
- **First-time value clarity checklist** — §5, applied per scenario.
- **Phase 1 readiness checklist** — §19 + [`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md).
- **Clear explanation of *why* ZAC produced each Insight or Coaching Point** — every sample answer includes its reasoning trail (signal → evidence → conclusion).

### 6.2 Excluded from Phase 0

- Production login integration.
- Real ZAC UI inside QLOOQO.
- Real database migrations.
- Live tool execution.
- Real LLM implementation.
- Live memory tables.
- Live Sunday-report integration.
- Autonomous actions.

> These belong to **Phase 1** or a **separately agreed prototype/spike** (Day 4 §23.2).

---

## 7. Proof-of-Architecture Test Data

All scenarios in §8–§15 run against one realistic **mock** salon. All figures are invented for validation; GBP, consistent with QLOOQO's `*_cents` money convention.

### 7.1 The salon

| | |
|---|---|
| **Salon** | The Colour Room |
| **Locations** | 1 |
| **Owner** | Emma |
| **Manager** | Sarah |
| **Stylists** | Mia, Olivia, Jade |
| **Active ZAC users** | 5 (matches the Day 4 §18.2 small-salon usage profile) |
| **QLOOQO subscription** | **£399 / month** |

### 7.2 Business metrics (current month)

| Metric | This month | Last month | Target / note |
|---|---|---|---|
| Revenue | £42,300 | £39,750 | +6.4% month-on-month |
| Retail revenue | £2,150 | £1,880 | 5.1% of revenue — below ambition |
| Average rebooking rate | **58%** | 60% | **Target 70%** — the biggest gap |
| Colour waste | 2,400 g (~£312 est.) | 3,150 g (~£410 est.) | Improving after coaching |
| Utilisation (overall) | 78% | 76% | Healthy |
| **Tuesday utilisation** | **54%** | 57% | Lowest day — persistent |
| Client retention risk | **14 regular clients overdue >8 weeks** | 9 | ~£1,150 of potential visit value |

### 7.3 Stylist metrics (current month)

| Metric | **Mia** | **Olivia** | **Jade** |
|---|---|---|---|
| Rebooking rate | 72% | 61% | **41%** |
| Rebooking rate (6 weeks ago) | 70% | 63% | **58%** |
| Retail attach rate | 18% | 9% | 6% |
| Colour waste (month) | 600 g | 860 g | **940 g** |
| Utilisation | 85% | 80% | **68%** |
| Signal | Top performer | Solid; retail opportunity | **Declining ~5 weeks: rebooking −17 pts, waste up, utilisation down** |

> Salon average rebooking (72+61+41)/3 = 58% — consistent with §7.2. Jade's decline is the seed for the Manager Coaching Journey scenario (§11) and the private-coaching examples (§10, §13, §14).

---

## 8. Owner Scenario

**Emma asks:** *"ZAC, what is the biggest opportunity in my business this month?"*

**Expected behaviour:**
- Owner role detected via `AuthUser.roles[]`; business-level permissions applied (Day 2 §8).
- Revenue, rebooking, utilisation, retail, and colour waste checked through permission-gated read tools (Day 3 §7).
- A business-level **Opportunity** generated, with evidence, confidence, and an estimated value.
- **Private stylist coaching memory is not exposed** — Emma sees themes and metrics, never coaching conversations (Day 3 §10).

**Sample ZAC answer:**

> **Opportunity — Rebooking is your biggest lever this month.**
>
> Your salon rebooks **58%** of clients against your **70% target**. Closing that gap is worth an estimated **£1,900–£2,300/month** in retained visit revenue. Additionally, **14 regular clients are overdue by more than 8 weeks** — recovering even half of them is worth roughly **£575** in near-term bookings.
>
> **Why I'm telling you this:** revenue is up 6.4% and utilisation is healthy at 78%, so growth is not your constraint — retention of booked clients is. Rebooking is also your most *controllable* metric: it responds to coaching within weeks.
>
> **Evidence:** rebooking 58% vs 70% target (dashboard KPIs, as of this morning) · 14 overdue regulars (retention signal) · revenue £42,300 vs £39,750 (month-on-month) · utilisation 78%. **Confidence: High** on the gap itself; **Medium** on the £-value estimate (uses your average visit value and an influence discount — assumptions shown on request).
>
> **Also worth watching:** Tuesday utilisation is 54% (lowest day), and retail sits at 5.1% of revenue — both are secondary opportunities. Colour waste is *improving* (down 24% month-on-month) — the team's waste coaching is working.
>
> **Team note:** one stylist's rebooking trend needs Sarah's attention this week — I've flagged the theme to her. *(No private coaching detail is shown to you — you see themes and metrics.)*

**First-Time Value Clarity check (§5.1):** Emma immediately sees the value (£1,900–£2,300/month), the evidence, the priority order, and the connection to her subscription — without any explanation of what ZAC is.

---

## 9. Manager Scenario

**Sarah asks:** *"ZAC, what should I focus on with the team this week?"*

**Expected behaviour:**
- Manager role detected; team/location-scoped permissions applied.
- Operational and team signals checked (performance, utilisation, stock, rebooking).
- Practical, ordered coaching/operational next steps with **measurable targets**.
- **Private stylist coaching conversations are not exposed** — Sarah sees performance data she is permitted to see, and *themes*, never ZAC↔stylist coaching content.

**Sample ZAC answer:**

> **Your three focuses this week, in order:**
>
> **1. Coaching Point — Jade's rebooking needs support.** Jade's rebooking has fallen from 58% to **41%** over five weeks; her utilisation is down to 68% and colour waste is up. This pattern usually has a cause worth understanding before any conversation about numbers. Suggested first step: a supportive 1-to-1 this week focused on how she's doing, not on the metrics. **Target: rebooking back above 50% within 4 weeks.** *(Evidence: her KPI trend, weeks 1–5. What Jade discusses with me privately is not shown here.)*
>
> **2. Opportunity — Tuesday is your quiet day.** Tuesday utilisation is **54%** vs 78% overall. Options: move team training to Tuesdays, or run a Tuesday-only colour offer. **Target: 65% Tuesday utilisation within 6 weeks.** *(Evidence: utilisation by day, last 8 weeks.)*
>
> **3. Coaching Point — Olivia's retail moment.** Olivia rebooks well (61%) but her retail attach is **9%** vs Mia's 18%. She has the client trust; she may just need a routine — e.g. recommending the product she used, at the basin. **Target: 12% attach within 4 weeks.** *(Evidence: retail attach by stylist, this month.)*
>
> **Confidence: High** on all three signals (complete KPI data); the targets are suggestions — adjust them to what you know about the team.

**First-Time Value Clarity check (§5.2):** Sarah knows *what needs attention*, *what to do first*, *why*, *on what evidence*, and *what improvement to expect* — in one answer.

---

## 10. Stylist Scenario

**Jade asks:** *"ZAC, how can I improve this week?"*

**Expected behaviour:**
- Stylist role detected; **only Jade's own and permitted data** used (`GET /api/kpi/me`-style tool — Day 1 §8).
- Supportive **Coaching Point** — coach, not surveillance.
- **No other stylist's data exposed** (no "Mia does X better than you").
- **One small measurable target**, not a list of faults.
- Private coaching memory respected — this conversation stays between Jade and ZAC.

**Sample ZAC answer:**

> **Coaching Point — one small thing this week: the next-visit question.**
>
> You're strongest with your colour regulars — they come back to *you*. Right now about **4 in 10** of your clients book their next visit before leaving. Let's aim for **5 in 10 this week** — that's roughly **one extra rebooking**.
>
> **The easiest way:** while the colour develops, mention when you'd like to see them next — *"I'd love to refresh this in six weeks — shall I hold your usual Thursday slot?"* You're not selling; you're looking after their hair.
>
> **Why this one thing:** it's the single change with the biggest effect on your week-to-week column, and it's a habit, not a talent — it builds fast.
>
> This conversation is **between us**. Your manager sees your performance numbers as usual, but not what we talk about here. If things feel harder than usual at the moment, you can tell me as much or as little as you like — it helps me coach you better.

**First-Time Value Clarity check (§5.3):** Jade gets one achievable focus, a script to try, a supportive tone, no comparison with colleagues, and an explicit privacy promise — a coach, not a monitor.

---

## 11. Manager Coaching Journey Scenario

> **Future capability** — captured now as a proof-of-architecture scenario and boundary definition (Cosan's Day 5 decision; roadmap in §18). Not a Phase 1 commitment.

**Principle:** *ZAC should not only identify underperformance. ZAC should help managers understand what to do next.*

ZAC guides managers through ten questions:

1. What changed in the stylist's performance?
2. What evidence supports that?
3. What may be causing the issue?
4. What should the manager focus on first?
5. What coaching conversation should happen?
6. What measurable improvement should be expected?
7. When should progress be reviewed?
8. What support has already been offered?
9. What improved and what did not?
10. When should the manager consider formal internal company processes?

**Hard boundary — ZAC must never:** replace the manager · make employment decisions · act as HR/legal authority · automatically recommend disciplinary action as a decision · expose private stylist coaching conversations without permission · shame or punish a stylist.

**ZAC should:** provide evidence · suggest fair coaching steps · help managers prepare conversations · define measurable improvement targets · track support offered · track outcomes · remind managers to follow company policy · **keep final decisions with the human manager and company process.**

**Sarah asks:** *"ZAC, Jade has been underperforming for several weeks. What should I do?"*

**Expected behaviour:**
- Sensitive people-management request detected → coaching-journey framing, extra care in tone.
- Manager permissions used; performance evidence reviewed.
- **Private coaching memory not exposed** (what Jade tells ZAC stays private).
- Patterns identified; supportive first steps suggested; structured journey offered.
- Review timeline recommended; support and outcomes tracked (→ Outcome Memory, §14).
- **Human decision boundary kept explicit.**

**Sample ZAC answer:**

> **Let's look at this carefully — this is a coaching situation, and you're the one who leads it. I'll bring the evidence and a structure.**
>
> **1. What changed:** over the last 5 weeks Jade's rebooking fell **58% → 41%**, utilisation **~75% → 68%**, and colour waste rose to **940 g/month**. Before that, her numbers were stable for months. *(Evidence: weekly KPI trend, weeks 1–5; her prior 6-month baseline.)*
>
> **2. Possible causes** *(patterns, not conclusions)*: a simultaneous dip across rebooking, utilisation and waste usually points to something *outside* technique — confidence, wellbeing, schedule pressure, or a client-mix change. Her colour quality signals (redo rate) are unchanged, which makes a pure skill issue less likely. **Only a conversation can tell you the cause.**
>
> **3. First coaching focus:** the 1-to-1 itself — understanding before correcting. Suggested opener: *"You've seemed less yourself lately and I'd like to help — how are things going?"* Lead with support; bring numbers only if she asks.
>
> **4. Support plan to offer:** a quieter column for two weeks · pairing on rebooking conversations (she can shadow how others ask — without being compared publicly) · a check-in each Friday.
>
> **5. Expected improvement:** rebooking back **above 50% within 4 weeks**, waste trending down. These are fair, modest targets — agree them *with* her, don't hand them down.
>
> **6. Review timeline:** check in weekly; review the metrics together at **2 weeks** and **4 weeks**. I'll track the support you've offered and what improves, so your next review is evidence-based.
>
> **What I can't and won't do:** Jade's private coaching conversations with me stay between her and me — they are not part of what I've shown you, and I won't share them. I don't make employment decisions, and this is not a disciplinary recommendation. **If, after fair support and time, you're considering any formal step, that's a decision for you and your company's own process — please follow The Colour Room's policy and take HR/legal advice where appropriate.**

**First-Time Value Clarity check:** Sarah gets evidence, likely causes, a humane first step, a support plan, fair targets, a review cadence — and total clarity that the *decision* is hers, not ZAC's.

---

## 12. Insight / Coaching / Opportunity Lifecycle

Every meaningful ZAC output follows one lifecycle (refines Day 3 §13 with Day 4 §3 terminology — internally these are "recommendations"; users see Insights / Coaching Points / Opportunities / Risks / Watch Points):

1. **Signal detected** — e.g. Jade's rebooking trend crosses a threshold.
2. **Evidence collected** — KPI trend, baseline, related metrics.
3. **Insight candidate created** — internal recommendation object (Day 3 §14).
4. **Permission check** — is this user allowed to see this data/insight? (Day 2 §8.)
5. **ZAC output generated** — as Insight / Coaching Point / Opportunity / Risk / Watch Point.
6. **Expected outcome defined** — metric, target, direction.
7. **Output shown to user** — status `shown`.
8. **User response recorded** — accepted / dismissed / ignored / manual "did this help?" feedback (Day 4 §9).
9. **Measurement window opened** — `measurement_window_days`.
10. **Business outcome observed** — from QLOOQO's own data (Day 3 §12.1).
11. **Attribution classified** — Observed / Influenced / Directly Attributable (Day 4 §4).
12. **Value estimated** — category calculation method + confidence (Day 4 §8).
13. **Learning recorded** — including negative/unexpected outcomes (Day 3 §17.4).

**Worked example (from §9→§14):** signal = Jade rebooking −17 pts (step 1) → evidence weeks 1–5 (2) → candidate `coaching` type (3) → Sarah has team-performance permission (4) → Coaching Point shown to Sarah (5–7) → Sarah acts, marks "helped" (8) → 4-week window (9) → rebooking 41→49% observed (10) → **Influenced** (Sarah's coaching was the direct agent; ZAC surfaced and structured it) (11) → value ≈ retained visits × avg value × discount (12) → "supportive-first coaching pattern works for multi-metric dips" recorded (13).

---

## 13. Context Memory Examples

Context Memory = what ZAC knows about the person/business (Day 3 §9). Three examples showing the **privacy scopes** (Day 3 §10):

### 13.1 Private stylist coaching memory *(scope: `private_user_memory` — Jade + ZAC only)*

> *"Jade is working on rebooking confidence. She said asking for the next booking feels 'pushy'. Prefers short, practical prompts. Responded well to the 'holding your usual slot' phrasing. Mentioned feeling stretched lately (10 Jul) — be gentle; do not surface this to anyone."*

**Never visible to Sarah or Emma.** Feeds only Jade's own coaching.

### 13.2 Manager theme-only visibility *(scope: `role_scoped_memory` — Sarah)*

> *"Team theme: one stylist is actively working on rebooking confidence with ZAC (coaching in progress). Sarah has been shown the performance trend and a supportive-first coaching approach. Support offered: quieter column, Friday check-ins (from 15 Jul)."*

Sarah sees the **theme and the performance data she's permitted to see** — never §13.1's content.

### 13.3 Owner business goal memory *(scope: `business_shared_memory` — Emma / business level)*

> *"Emma's priorities this quarter: lift rebooking toward 70%, grow retail past 6% of revenue, keep colour waste trending down. Prefers direct, numbers-first summaries with the 'why' attached. Cares about team wellbeing — flag people-risks early as themes."*

Shapes ZAC's prioritisation for business-level answers (§8).

---

## 14. Outcome Memory Example

Outcome Memory = what actually happened, and did it create value (Day 3 §11). Example closing the loop on §9/§11:

> **Outcome record — rebooking improvement (Jade), weeks 6–9**
>
> - `outcome_type`: `rebooking` · `target`: staff/Jade · `recommendation_id`: the §9 Coaching Point (internally)
> - **Observed:** rebooking **41% → 49%** across the 4-week measurement window; utilisation 68% → 74%; waste 940 g → 810 g.
> - **Attribution: Influenced** — Sarah's coaching and support plan were the direct agents; ZAC surfaced the signal, structured the journey, and tracked support. *(Not claimed as Directly Attributable — honest attribution, Day 3 §17.)*
> - **Estimated value:** ~**£310/month** in retained visit revenue (Jade's avg visit value × recovered rebookings × 0.6 influence discount). **Confidence: Medium** (single stylist, one window, discount assumed).
> - **Support tracked:** quieter column (2 wks) · pairing sessions ×3 · Friday check-ins ×4 — all offered and taken up.
> - **Evidence:** weekly KPI snapshots wks 1–9; Sarah's "helped" feedback (manual signal, Day 4 §9).
> - **Learning recorded:** multi-metric dips + supportive-first coaching → recovery within 4 weeks; raise confidence in this pattern. Feeds §15's "What ZAC learned" and the Value Created report.

---

## 15. Sample Value Created Dashboard

*The Colour Room — sample month (mock data). Layout per Day 4 §9; attribution per Day 4 §4.*

> ### Value Created by ZAC — The Colour Room — sample month
>
> **QLOOQO subscription: £399 / month**
>
> | | |
> |---|---|
> | **Estimated total value created** | **£5,190** |
> | Directly attributable value | **£1,420** |
> | Influenced value | **£2,310** |
> | Observed value *(context — no credit claimed)* | **£1,460** |
>
> **ROI vs subscription:**
> - **Direct ROI:** £1,420 ÷ £399 ≈ **3.6×** — hard, evidenced value alone already covers the subscription.
> - **Direct + Influenced ROI:** £3,730 ÷ £399 ≈ **9.3×** — the headline "hard value" figure.
> - **Total observed business value vs subscription:** £5,190 ÷ £399 ≈ **13.0×** — shown for context; Observed value is *excluded* from the claimed ROI (Day 4 §12).
>
> **Category breakdown**
>
> | Category | Value | Attribution | Confidence |
> |---|---|---|---|
> | Bookings Recovered (overdue clients returned) | £760 | Directly Attributable | High |
> | Rebooking Improvement (salon-wide, incl. Jade §14) | £1,515 | Influenced | Medium |
> | Utilisation Improvement (Tuesday actions) | £480 | Influenced | Medium |
> | Colour Waste Reduced (2,400 g vs 3,150 g; cost/gram estimated) | £95 | Influenced | Medium |
> | Time Saved (instant answers, 5 users) | £340 | Directly Attributable | Medium |
> | Management Hours Saved (reports/reviews) | £320 | Directly Attributable | Medium |
> | Retail Growth (Olivia +£220 attach uplift) | £220 | Influenced | Medium |
> | Revenue growth (month-on-month, unclaimed) | £1,050 | Observed | Low |
> | Client Retention (returning regulars, unclaimed) | £410 | Observed | Low |
> | **Total** | **£5,190** | | |
>
> **Confidence breakdown:** High **£760** · Medium **£2,970** · Low **£1,460** *(all Observed value is held at Low by policy; Colour Waste is capped at Medium because cost-per-gram is estimated — Day 4 §8.6)*.
>
> **What ZAC learned:** supportive-first coaching resolved a multi-metric dip within 4 weeks (§14) → pattern confidence raised. A Tuesday promotion Watch Point moved utilisation only 54%→58% (below the 65% expectation) → recorded as under-performing; confidence in similar promotion suggestions lowered (Day 3 §17.4).
>
> **Limitations:** influence discount 0.6 and minutes-saved-per-lookup are planning assumptions (Day 4 §17); retail data partially captured; one month of KPI snapshots — trend confidence improves with history; value figures are estimates, not audited accounts.

---

## 16. Cost per Intelligence Summary

Full model: Day 4 §13–§22. Summary for the sign-off package, applied to the test salon (5 active users = Day 4 §18.2 small-salon profile). **All figures are configurable planning assumptions (Day 4 §17) — no live vendor prices; provider pricing must be refreshed from official pricing pages before commercial sign-off.**

| Unit | Illustrative planning figure |
|---|---|
| Cost per conversation | ~£0.01–£0.03 |
| Cost per insight / coaching point / opportunity | ~£0.02–£0.06 |
| Cost per report | ~£0.05–£0.15 |
| Cost per business review | ~£0.25–£0.75 |
| Cost per active user (month) | ~£1.50–£4.50 |
| Cost per salon (month, small-salon profile) | ~£6–£24 *(≈ Day 4 target $8–$30)* |
| Cost per enterprise account | Σ locations + rollup reviews (Day 4 §16) |
| **Cost per value-created pound** | ~£14 cost ÷ £3,730 hard value ≈ **£0.004 per £1** |

**Target cost ratios** (ZAC operating cost as % of subscription revenue — Day 4 §20):

| Band | Ratio | The Colour Room check |
|---|---|---|
| **Ideal** | **under 5%** | ~£14 ÷ £399 ≈ **3.5% → Ideal** ✔ |
| **Acceptable early** | 5%–10% | |
| **Needs optimisation** | over 10% | → apply Day 4 §21 controls |
| **Critical** | over 20% | → escalate pricing/routing before scaling |

---

## 17. Phase 1 MVP Roadmap

Phase 1 is a **controlled, read-only MVP**: prove trust before autonomy (Day 2 §17). The standalone roadmap is [`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md); summary:

**Phase 1 core goals:** ZAC safely inside QLOOQO · role-specific questions · permission-aware read-only tools · evidence-backed answers · basic memory · insights/coaching points/opportunities · measurement data capture · cost telemetry.

**Phase 1 roles:** Owner · Manager · Stylist.

**Phase 1 capabilities:** ZAC ask endpoint · context assembler · permission-aware tool registry · read-only report/KPI tools · QLab summary tools where stable · booking/rebooking summary tools · stylist personal KPI tools · conversation logging · Context Memory · Outcome Memory · insight/coaching/opportunity logging · confidence/evidence output · cost telemetry · Value Created foundation.

**Phase 1 deferred:** autonomous booking creation · SMS/WhatsApp sending · email campaigns · stock ordering · service price changes · staff setting changes · client profile edits · automated HR/performance decisions · full disciplinary workflow · full vector RAG · voice/phone/WhatsApp channels · autonomous actions.

**Phase 1 success criteria:** owner gets evidence-backed business answers · manager gets practical coaching/operational guidance · stylist gets private personal coaching · permissions respected · private stylist coaching memory protected · evidence attached · outputs and outcomes logged · cost telemetry recorded · **users understand why ZAC is valuable** (the First-Time Value Clarity Test, carried into Phase 1).

---

## 18. Future Manager Coaching Journey Roadmap

**Why it matters:** managers are the multiplier — ZAC improves businesses fastest by making every manager a better coach. Underperformance handled early, fairly, and supportively is retained talent and recovered revenue (§11, §14). This is the constitution made operational: *improve businesses by improving people.*

**Future capability:** the structured ten-question journey (§11) — evidence → causes → first focus → conversation prep → support plan → measurable targets → review cadence → support history → outcome review → (only if fair support fails) a reminder to follow company process.

**Human boundary (permanent):** ZAC never replaces the manager, never makes employment decisions, never acts as HR/legal authority, never auto-recommends disciplinary action as a decision, never exposes private coaching conversations without permission, never shames a stylist. Final decisions always rest with the human manager and company process.

**Roadmap placement:**

| Phase | Manager Coaching Journey scope |
|---|---|
| **Phase 0** | Document the scenario and the boundary (this document, §11). |
| **Phase 1** | Basic manager coaching points from performance data (read-only signals, e.g. §9). |
| **Phase 2** | Structured manager coaching journeys — guided steps, support tracking, review cadences. |
| **Phase 3** | Policy-aware support history and review workflows. |
| **Later** | HR / internal-process integration **only if explicitly approved** — never by default. |

---

## 19. Phase 0 Sign-Off Checklist

Phase 0 is signed off when each item is reviewed and accepted:

1. **ZAC vision and Constitution alignment** — Day 1 §12; §3.
2. **Current QLOOQO platform discovery** — Day 1.
3. **Core ZAC architecture** — Day 2.
4. **Role and permission model** — Day 2 §5, §8; Day 3 §5.
5. **Knowledge architecture** — Day 3 §3–§5.
6. **Context Memory** — Day 3 §9–§10; §13.
7. **Outcome Memory** — Day 3 §11–§17; §14.
8. **Insight/Coaching/Opportunity lifecycle** — Day 3 §13; §12.
9. **Value Created model** — Day 4 §4–§12; §15.
10. **Cost per Intelligence model** — Day 4 §13–§22; §16.
11. **Proof-of-architecture scenarios** — §7–§11.
12. **First-Time Value Clarity Test** — §5.
13. **Manager Coaching Journey future scenario** — §11, §18.
14. **Phase 1 MVP roadmap** — §17; [`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md).
15. **Deferred scope list** — §6.2, §17; Decision Log §6.
16. **Open decisions list** — §20; Decision Log.

---

## 20. Remaining Open Decisions

### For Luke (product)

1. Final user-facing terminology per surface (which of Insight / Coaching Point / Opportunity / Risk / Watch Point appears where).
2. Value Created dashboard display order (category ranking, §15 layout).
3. Whether to show low-confidence value to owners, or hold it back.
4. Weekly / monthly / yearly Value Created cadence (Day 4 §25 Q2).
5. First dashboard headline (which category leads — Day 4 §25 Q3).
6. Manual feedback UX wording ("did this help?" phrasing and options).
7. Preferred assertiveness level for manager coaching (§11 tone calibration).

### For Cosan (technical)

1. Final source endpoints for each read-only tool (Day 1 §8 inventory → tool contracts).
2. Exact location of future ZAC tables (`zac` schema — Day 3 §19; Decision Log QC5).
3. KPI snapshot schema (`zac.kpi_snapshots` fields and cadence).
4. Cost event schema (`zac.cost_events` fields — Day 4 §15).
5. PII redaction rules (prompts/responses/memory — Day 3 §23 Q7).
6. `zac.access` implementation (permission catalogue + `DEFAULT_ROLE_PERMISSIONS` wiring — Decision Log D28).
7. Internal demo harness vs backend-first MVP (how the proof-of-architecture becomes a Phase 1 spike, if agreed).
8. Future Sunday report integration path (Day 4 §11 — riding the existing Sunday Night Report).

---

## 21. Final Phase 0 Recommendation

> **Move into Phase 1 MVP implementation only after this Phase 0 package is reviewed and accepted** by Luke (product) and Cosan (technical): the sign-off checklist (§19) confirmed, the Recommended-lock decisions in the [decision log](phase-0-decision-log.md) confirmed, production schema parity re-verified (Day 1 §18; Decision Log QC8), and the open decisions (§20) either answered or consciously carried as open.

Until that acceptance, **no ZAC code, schema, permission, or integration should be built.** Phase 0's value is precisely that Phase 1 starts on locked foundations, not assumptions.

---

## 22. Final Conclusion

ZAC's advantage is not that he answers questions. It is that he:

- **understands the salon** — its data, roles, goals, and rhythms;
- **respects permissions** — structurally, before the model ever runs;
- **coaches people** — supportively, privately, one improvement at a time;
- **explains business reality** — with evidence, confidence, and honest limits;
- **remembers context** — what matters to each person and business;
- **observes outcomes** — what actually happened, not what should have;
- **measures value** — Observed, Influenced, and Directly Attributable, never inflated;
- **improves managers and stylists** — the people who improve the business;
- **shows ROI** — value created against the subscription, every period;
- **builds trust over time** — read-only first, honest always, autonomous only if ever earned.

> **Phase 0 complete. ZAC is defined, bounded, measurable, and ready to be validated — then, and only then, built.**

---

*Documentation only. Nothing in this file has been implemented. All personas, salons, metrics, and conversations are illustrative mock data; all cost figures are configurable planning assumptions. See [`phase-0-acceptance-criteria.md`](phase-0-acceptance-criteria.md) for the sign-off checklist, [`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md) for the Phase 1 plan, [`phase-0-decision-log.md`](phase-0-decision-log.md) for tracked decisions, and [`phase-0-future-integration-notes.md`](phase-0-future-integration-notes.md) for the future codebase bridge.*
