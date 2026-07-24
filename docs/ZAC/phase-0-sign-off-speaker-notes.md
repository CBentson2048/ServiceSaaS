# Phase 0 Sign-Off Meeting Speaker Notes

> **Status: Documentation only.** Speaking script for Oleksandr for the live Phase 0 sign-off walkthrough with Luke and Cosan. The meeting walks through [`phase-0-sign-off-walkthrough.md`](phase-0-sign-off-walkthrough.md), [`phase-0-acceptance-criteria.md`](phase-0-acceptance-criteria.md) and [`phase-1-mvp-roadmap.md`](phase-1-mvp-roadmap.md). It is **not a live production ZAC demo** — it is a proof-of-architecture walkthrough on realistic test data and documented expected behaviour.
>
> Date: 2026-07-22 · All figures are from the walkthrough test dataset ("The Colour Room"). Text in quote blocks is what to say; text outside is guidance.

---

## 1. Opening Statement

> "Thanks for making time, both of you. Phase 0 is complete — as architecture and proof-of-architecture documentation. Today my goal is to walk you through the full package, step by step.
>
> One thing to set clearly up front: this is not a live production ZAC implementation yet. Nothing you'll see today is running software. What you'll see is the completed architecture, realistic test data, and exactly how ZAC is designed to behave — so we can validate the foundation before we invest in the Phase 1 MVP.
>
> Luke — your job today is to validate the product value and the acceptance criteria: does this feel like something that helps a salon owner, and does it meet what we agreed?
>
> Cosan — your job is the technical side: does this architecture fit the QLOOQO platform we actually have, and is it solid enough to scope Phase 1 from?
>
> At the end, we'll record a decision together."

---

## 2. Phase 0 Boundary Statement

> "Let me be precise about what's in and out of Phase 0, so there are no surprises.
>
> Phase 0 **includes**: the full architecture, the Owner, Manager and Stylist proof-of-architecture scenarios, the acceptance criteria, the Value Created model, the Cost per Intelligence model, and the Phase 1 roadmap.
>
> Phase 0 does **not** include: a live ZAC UI, real LLM integration, database migrations, live memory tables, or any autonomous actions. None of that exists yet — deliberately.
>
> Phase 1 MVP is where the controlled, read-only production foundation begins — and only after today's sign-off."

---

## 3. Meeting Flow Summary

> "Here's how the next ninety minutes or so will run. First, a quick scope recap and the architecture overview. Then I'll introduce the test salon data we use everywhere. After that, the three role scenarios — Owner, Manager, Stylist — followed by the Manager Coaching Journey, which is a future capability we've validated on paper.
>
> Then memory, lifecycle and attribution — how ZAC remembers and how we keep value honest. Then the Value Created report and ROI, and the Cost per Intelligence model — what ZAC is worth and what it costs.
>
> Near the end there's one scenario I've deliberately saved: the Hidden Profit Leak — something the owner wouldn't think to ask. Then free interaction — Luke, you ask anything, in your own words.
>
> We close with Cosan's technical confirmation, Luke's approval checklist, and the final sign-off decision."

The fifteen steps, in order: 1 scope recap · 2 architecture overview · 3 test data · 4 Owner scenario · 5 Manager scenario · 6 Stylist scenario · 7 Manager Coaching Journey · 8 memory, lifecycle and attribution · 9 Value Created report and ROI · 10 Cost per Intelligence · 11 Hidden Profit Leak surprise scenario · 12 free interaction Q&A · 13 Cosan technical confirmation · 14 Luke approval checklist · 15 final sign-off decision.

---

## 4. Architecture Overview Speaking Notes

> "ZAC is a server-side intelligence layer that lives **inside** QLOOQO — not a chatbot bolted onto the front end.
>
> He's role-aware and permission-aware: an owner's ZAC, a manager's ZAC and a stylist's ZAC draw on the same intelligence but can each only see what that person is allowed to see. That's enforced by the platform before the AI model ever runs — not by trusting the model.
>
> QLOOQO remains the source of truth. ZAC never invents numbers and never touches the database directly with unrestricted access — everything goes through guarded, service-style tools that carry the user's own permissions.
>
> Every answer comes with evidence, a confidence level, and honest limitations. And every meaningful interaction is recorded — memory, outcomes, attribution and cost telemetry — so from day one we can answer both 'what value has ZAC created?' and 'what does ZAC cost to run?'"

The flow, in one spoken line:

> "An authenticated user asks a question → we resolve their role and permissions → the context assembler gathers only what's relevant and allowed → the tool registry exposes only permitted tools → the model router picks the right model → ZAC returns an evidence-backed answer → and memory, outcomes and cost are logged."

---

## 5. Test Data Introduction

> "Everything today runs on one realistic test salon: **The Colour Room**. One location. Emma is the owner, Sarah is the manager, and three stylists — Mia, Olivia and Jade. The QLOOQO subscription is **£399 a month** — that number matters later, when we get to ROI.
>
> The dataset covers revenue, retail, rebooking, utilisation, colour waste and individual stylist performance.
>
> And here's the important part: it's the **same data** across every scenario. When you see the owner, the manager and a stylist each ask ZAC a question, the differences in what comes back are purely role and permissions — that's the proof of role-specific behaviour."

---

## 6. Owner Scenario Speaking Notes

**Question (Emma):** *"How healthy is my business today?"* — or — *"What is the biggest opportunity in my business this month?"*

> "As the owner, Emma sees business-wide data. ZAC's answer: the business is healthy and growing — but rebooking and weekday utilisation are the biggest opportunities.
>
> The evidence: revenue is **£42,000** against **£39,500** last month, so growth is there. Retail is up from **£2,900 to £3,600**. Colour waste is down from **£1,050 to £780** — the waste coaching is working. But rebooking sits at **51%** against a **60% target**, and Tuesday utilisation is **48%** against a **72%** average.
>
> So the conclusion ZAC gives Emma is honest and specific: *the business is growing, but repeat-client retention and weekday utilisation are limiting profit.*
>
> Suggested focus: recover the overdue colour clients, and fix Tuesdays.
>
> And because every insight is measurement-ready, ZAC defines upfront how we'd know it worked: rebooking rate, recovered bookings, utilisation lift, and the additional revenue that follows."

---

## 7. Manager Scenario Speaking Notes

**Question (Sarah):** *"What should I focus on with the team this week?"*

> "Sarah sees team and location performance — but not private stylist coaching conversations. That boundary holds everywhere.
>
> ZAC's focus for her week: rebooking consistency and Tuesday utilisation. Evidence: rebooking **51%** against the **60%** target, **18 overdue clients**, Tuesday at **48%**.
>
> Suggested actions: a team conversation about rebooking language at checkout — and private, supportive follow-up with the stylists who need help. Notice ZAC frames it as support, never as naming and shaming.
>
> Success is defined in numbers: rebooking moving toward **55%**, overdue clients from **18 to below 10**, Tuesday utilisation up **5 to 8 percentage points**. And a review date: **14 days**. ZAC will check back with her."

---

## 8. Stylist Scenario Speaking Notes

**Question (Mia):** *"How can I improve this week?"*

> "Mia only sees her own permitted data — and the tone changes completely. This is coaching, not surveillance.
>
> ZAC suggests one focus: rebooking confidence. The evidence is personal — her rebooking rate is **44%** against the salon target of **60%**.
>
> The action is practical: a simple script after colour appointments — *'your colour should stay fresh for six to eight weeks; shall we book your next refresh now so you get the time that suits you?'*
>
> The target is small and human: rebook **two more clients this week**. Not a league table, not a dashboard of everything she's doing wrong — one achievable thing.
>
> And privacy: ZAC never compares her against colleagues or exposes team data she isn't permitted to see. Her coaching conversation stays between her and ZAC."

---

## 9. Manager Coaching Journey Speaking Notes

**Question (Sarah):** *"Jade has been underperforming for several weeks. What should I do?"*

> "First, framing: this is a **future capability** — we've validated it on paper in Phase 0, and it is not a full Phase 1 implementation. But it shows where ZAC is going: not just spotting underperformance, but helping a manager know **what to do next**.
>
> And the hard rule before anything else: ZAC must never replace the manager or make employment decisions. He guides; the human decides.
>
> The evidence on Jade: rebooking **39%**, retail attach **8%**, utilisation **58%**, and her colour waste trend is worsening — a dip across several metrics at once.
>
> ZAC explores possible causes rather than jumping to conclusions: rebooking confidence, consultation structure, diary gaps, retail confidence, or a support and training need. A multi-metric dip usually means something a conversation will uncover — not a skills verdict.
>
> The suggested path: start with a supportive conversation — how is she doing, before any numbers. Focus first on rebooking. Set a measurable target agreed *with* her. Review in **14 days**. If there's no improvement, offer additional support. And if consistent, fair support still doesn't work — ZAC's guidance is to follow the salon's own internal company process. Not ZAC's call.
>
> That's the boundary in one line: **ZAC guides and tracks; the human manager decides.**"

---

## 10. Context Memory Speaking Notes

> "Context Memory is how ZAC remembers meaningful context about a person or a business — and I want to stress: it is not just chat history. It's structured, scoped, useful memory.
>
> An example: ZAC remembers that a stylist is working on rebooking confidence and prefers short, practical scripts. So next week's coaching builds on this week's — it doesn't start from zero.
>
> The privacy rule: private stylist coaching memory remains private wherever possible. Managers and owners see **themes and performance signals** — 'someone on the team is working on rebooking confidence' — never the private conversations themselves."

---

## 11. Outcome Memory Speaking Notes

> "Outcome Memory is the other half — it records **what actually happened** after an insight, coaching point or opportunity. This is how ZAC learns what genuinely improves a salon, instead of just generating advice into the void.
>
> A concrete example from the test data: a coaching point was shown; the manager marked it useful; within the window, **two clients rebooked**; estimated value **£180**; attribution: **influenced** — because the manager did the actual coaching; confidence: **medium**.
>
> Notice what ZAC did *not* do — he didn't claim full credit. That's deliberate, and it's the next topic."

---

## 12. Lifecycle and Attribution Speaking Notes

> "Every meaningful ZAC output follows one lifecycle. Spoken simply: a signal is detected → evidence is collected → an insight is created → permissions are checked → the output is shown → the user's response is recorded → the business outcome is observed → attribution is classified → value is estimated → and the learning is recorded.
>
> Attribution has three honest levels:
>
> **Observed** — a positive outcome happened, but ZAC does not claim credit.
> **Influenced** — ZAC helped awareness or decision-making, and other factors contributed too.
> **Directly attributable** — there's a clear link between ZAC's output and the business result.
>
> This is how we keep ZAC honest. He explains value instead of just claiming it."

---

## 13. Value Created Report Speaking Notes

> "Now the question every owner will actually ask: what is ZAC worth? Here's the sample monthly report for The Colour Room.
>
> The subscription is **£399**. The estimated total value created this month is **£5,190** — but ZAC never shows that as one inflated number. It's split three ways:
>
> **£1,420 directly attributable** — clear, evidenced links. **£2,310 influenced** — ZAC helped, others contributed. **£1,460 observed** — good things that happened that ZAC deliberately does *not* take credit for.
>
> That gives three honest ROI figures: direct ROI **3.6x**. Direct plus influenced **9.3x**. And total observed business value against the subscription, **13x** — shown for context only, never claimed.
>
> Every line in the report shows where the value came from, what evidence supports it, and how confident we are. An owner can drill from the headline to the evidence in one step. That's the difference between a value claim and a value explanation."

---

## 14. ROI Calculation Speaking Notes

Walk the maths on screen, slowly:

> "Direct ROI = **£1,420 ÷ £399 = 3.6x**.
> Direct plus influenced ROI = **(£1,420 + £2,310) ÷ £399 = 9.3x**.
> Total observed value versus subscription = **£5,190 ÷ £399 = 13.0x**.
>
> The important point is not only the number. It is that ZAC explains how the number was calculated, what evidence supports it, and what confidence level applies."

---

## 15. Cost per Intelligence Speaking Notes

> "The flip side of value is cost — QLOOQO must always know what ZAC costs to operate, per unit of intelligence.
>
> We track cost per conversation, per insight, per report, per business review, per active user, per salon — and my favourite: **cost per value-created pound**.
>
> The margin targets are explicit: **ideal is under 5%** of subscription revenue. **5 to 10%** is acceptable early. **Above 10%** triggers optimisation. **Above 20%** is critical.
>
> And the key commitment: Phase 1 captures cost telemetry from day one. A month we don't measure is a month we can never reconstruct — that's true for value and for cost."

---

## 16. Hidden Profit Leak Surprise Scenario Speaking Notes

Deliver this one with energy — it's the moment of the meeting.

> "Everything so far answered questions someone asked. This last scenario is different — it's the one thing the owner may not think to ask.
>
> Look at four numbers we've already seen today, separately: Tuesday utilisation is **48%**. Rebooking is below target. Colour-client follow-up is weak. Jade needs coaching, and her colour waste pattern is worsening.
>
> Individually? Each one looks like a normal metric on a normal dashboard. You'd glance past all four.
>
> Together, ZAC sees something else: a **recurring hidden profit leak**. Quiet Tuesdays concentrate Jade's gaps. Gap-heavy days undermine her rebooking conversations. Irregular bookings drive her waste. It repeats every single week — a structural leak, not a bad day.
>
> ZAC would estimate the value at risk, show the evidence behind the pattern, suggest the first action — one intervention that addresses several strands at once — and define exactly how improvement will be measured.
>
> No report does that. Reports show you four separate metrics. ZAC connects them, tells you what they mean together, and what to do first.
>
> This is the moment where an owner should feel: **I would not have spotted that myself, but now I cannot imagine running the business without it.**"

---

## 17. Free Interaction Q&A Instructions

Guide for the free-interaction segment — Luke asks anything, in his own words.

**Answer every question in this format, out loud:**

- **Role:** whose seat is asking
- **What ZAC can see:** the permission boundary for that user
- **Evidence:** the specific test-data figures
- **Answer:** the conclusion, in plain language
- **Confidence:** high / medium / low, with the reason
- **Suggested action:** one practical next step
- **Outcome measurement:** which metric, what window
- **Attribution:** how the outcome would be classified — observed, influenced or directly attributable

**Reminders:**
- **Do not pretend this is live software.** Phrase it as *"In Phase 1, ZAC would…"* or *"Based on the architecture, ZAC would…"*
- Keep every answer grounded in the test data — no invented figures.
- Always explain evidence, confidence and measurement, even when the question is casual.
- If a question probes the boundary — employment decisions, private coaching — the answer is the boundary (see §21).

---

## 18. Cosan Technical Confirmation Prompt

Say directly:

> "Cosan, from your side, can you confirm whether this architecture fits the current QLOOQO backend, Supabase structure, roles and permissions, and whether it is sufficient to scope Phase 1 MVP implementation?"

Then walk his confirmation list, item by item:

- Platform fit
- Backend/Supabase alignment
- Role/permission safety
- Data isolation
- Guarded tool model
- Memory/measurement feasibility
- Audit/cost telemetry feasibility
- Phase 1 scoping readiness

Capture anything he flags into the decision section — required changes before Phase 1 are a valid outcome, not a failure.

---

## 19. Luke Approval Prompt

Say directly:

> "Luke, based on the walkthrough, does this satisfy the Phase 0 acceptance criteria, or are there any clarifications you want captured before formal approval?"

Then ask the test that matters most:

> "Did the walkthrough pass the First-Time Value Clarity Test — would a salon owner seeing ZAC for the first time immediately understand why this is valuable?"

Record both answers verbatim in the walkthrough's decision section (§24).

---

## 20. Closing Statement

> "Thank you both. If you're comfortable with what we've walked through, Phase 0 can be formally approved today, and the next step is Phase 1 MVP planning.
>
> Phase 1 stays deliberately controlled: read-only, role-aware, permission-aware, and evidence-backed — ZAC recommends, ZAC never acts. Autonomous actions, voice and WhatsApp channels, and the advanced manager coaching journeys all come later, each only when it's earned and approved.
>
> We built Phase 0 so that Phase 1 starts on locked foundations instead of assumptions. If today's answer is yes, that's exactly what happens next."

---

## 21. Quick Emergency Notes

Difficult questions, with calm answers ready:

**If Luke asks why there is no live interface:**
> "Because Phase 0 was scoped as architecture and proof-of-architecture. The live interface is Phase 1 MVP implementation."

**If Luke asks whether ZAC can really answer automatically:**
> "Yes — in Phase 1 the goal is to implement the backend and UI so ZAC can answer automatically. Today we are validating the architecture and expected behaviour before building it."

**If Luke asks whether ZAC will make employment decisions:**
> "No. ZAC can guide managers with evidence and coaching structure, but final decisions remain with the human manager and company process."

**If Luke asks whether ZAC will expose stylist private coaching:**
> "No. Private coaching memory should remain private where possible. Managers and owners see themes, trends and performance signals."

**If Luke asks why this is valuable:**
> "Because ZAC connects business data, people coaching, evidence, memory and outcome tracking in one place. It does not only show what happened — it helps the salon understand what to do next, and whether it worked."

**If Cosan raises a technical concern you can't resolve in the room:**
> "That's a fair point — let's capture it as a required clarification and resolve it before Phase 1 scoping. That's exactly what this session is for."

---

*Documentation only. These notes support the live session for [`phase-0-sign-off-walkthrough.md`](phase-0-sign-off-walkthrough.md); nothing here is implemented or authorises implementation. All figures are the walkthrough's mock test data.*
