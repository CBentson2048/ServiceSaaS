# Day 4 — Value Created and Cost per Intelligence Model

> **Status: Documentation only — NOT implemented.**
> This document records the Day 4 architecture decisions for ZAC inside QLOOQO so they can be referenced and integrated later. **No application source code, NestJS modules, database migrations, environment files, package manifests, or Supabase data have been created or changed.** Every metric, table, category, dashboard, report section, cost figure, and permission named below is a *proposed future design* or a *configurable planning assumption*, not an existing artifact or a committed price.
>
> Date: 2026-07-21 · Phase: 0 (Discovery & Architecture) · Follows: [Day 1 Discovery Report](QLOOQO/ZAC%20Phase%200%20Discovery%20Report.md), [Day 2 Core Architecture](phase-0-day-2-core-architecture.md), [Day 3 Knowledge, Tools & Outcome Memory](phase-0-day-3-knowledge-tools-outcome-memory.md).

---

## 1. Purpose

Day 4 connects ZAC's **measurement architecture** (Day 3) to **commercial value** and **operating cost**.

Days 1–3 established *what ZAC knows*, *what ZAC can safely access*, *what ZAC remembers*, and *how ZAC links recommendations to real business outcomes*. Day 4 answers the two questions that make ZAC a defensible commercial product rather than a feature:

1. **"What value has ZAC created for my business?"** — and how ZAC *explains* that value honestly, with evidence, attribution, and confidence.
2. **"What does ZAC cost to run?"** — per conversation, per insight, per report, per salon, and at 100 → 100,000 salons — so subscription pricing keeps a healthy gross margin.

ZAC is not a chatbot or a generic AI feature. ZAC is a **trusted AI team member inside QLOOQO** whose purpose is to improve people and businesses every day. Day 4 defines how that improvement is measured, reported, and costed.

Day 4 remains **architecture-only. No implementation should begin yet.** Phase 1 remains **read-only** (Day 2 §4).

---

## 2. Core Day 4 Principles

1. **ZAC should not only report value. ZAC should explain value.** A number with no explanation is a claim; a number with source, method, attribution, confidence, and limitations is *evidence* (extends Day 2 §9–§10, Day 3 §17).
2. **Value Created is a report, not a single metric.** It is a multi-section dashboard/report, never one headline figure (Luke, Day 3 §22 Q3).
3. **Value is separated into Observed, Influenced, and Directly Attributable.** ZAC never over-claims causation (Day 3 §12.3, §17).
4. **Every value claim carries confidence and assumptions.** Especially important insights, value estimates, and opportunities.
5. **Cost is a first-class, measured quantity** — captured from Phase 1 alongside value, so gross margin is always answerable (Day 2 §12, Day 3 §20).
6. **Cost figures are configurable planning assumptions, not vendor commitments.** No live provider prices are hardcoded; provider pricing must be re-read from official pricing pages before commercial sign-off (§17).
7. **Phase 0 is a proof-of-architecture, not a production build.** Day 4 delivers a documented, scenario-based validation package — no live tables, UI, LLM, or Sunday-report integration (§23).

---

## 3. User-Facing Language Update

Luke's Day 3 product decision (Day 3 §22 Q1): the word **"recommendation"** feels transactional and should be avoided as the primary user-facing term.

ZAC should use **context-aware language**:

| User-facing term | Used when… | Example |
|---|---|---|
| **Insight** | ZAC is explaining something important. | "Your Friday afternoons run at 61% utilisation — the lowest of the week." |
| **Coaching Point** | ZAC is helping a person improve. | "You rebook 48% of colour clients; the salon average is 63%. Try booking the next visit at the basin." |
| **Opportunity** | there is business upside to capture. | "Twelve regulars are overdue. Reaching out could recover ~£840 this month." |
| **Risk** / **Watch Point** | something may negatively affect the business. | "Colour waste is up 18% vs last month — watch this before it hits margin." |

> **"Recommendation" remains an internal technical term only** — the object name in the recommendation lifecycle (Day 3 §13–§14), the `zac.recommendations` table (Day 3 §19), and event vocabulary (`zac.recommendation.created`, Day 2 §12). Internally the lifecycle is unchanged; only the *presentation layer* renames it to Insight / Coaching Point / Opportunity / Risk / Watch Point based on `type` and `role_relevance`.

**Mapping (internal `type` → user-facing surface):**

| Internal `type` (Day 3 §14) | Default user-facing surface |
|---|---|
| `revenue`, `profit`, `retail`, `utilisation` | Opportunity (upside) or Insight (explanatory) |
| `rebooking`, `retention` | Opportunity or Coaching Point |
| `coaching` | Coaching Point |
| `waste`, `stock` | Watch Point / Risk (downside) or Opportunity (saving) |

---

## 4. Value Attribution Model

Every value figure ZAC reports must declare **how strongly ZAC is claiming credit.** Three attribution types (formalising Day 3 §12.3, §17):

### 4.1 Observed Value
A positive business outcome happened, but **ZAC does not claim direct influence.** ZAC records the improvement as business reality and reports it as context, not as credit.
*Example:* Retail revenue rose 9% this month. ZAC did not surface a retail opportunity to the stylist who made those sales. → **Observed.**

### 4.2 Influenced Value
ZAC **helped awareness, coaching, or decision-making**, but other factors also contributed. Reported as a contribution, not sole causation, usually with a discount factor (§8).
*Example:* ZAC raised a Watch Point about weak Saturday utilisation; the manager also ran a manual promotion; bookings improved. → **Influenced.**

### 4.3 Directly Attributable Value
There is a **clear, evidenced link** between a specific ZAC Insight / Coaching Point / Opportunity and the business outcome — the surfaced item was shown, acknowledged/accepted, and the measured outcome occurred within the measurement window on the same target entity.
*Example:* ZAC surfaced an Opportunity to follow up Client A (not rebooked in 10 weeks). The stylist acted; Client A booked within the 14-day window; the appointment carries `rebooking_outcomes.rebook_source = 'zac'`. → **Directly Attributable.**

### 4.4 Attribution decision rule

```
Was a ZAC item shown for this outcome's target entity within the window?
  ├─ No  → Observed Value        (report as business reality, ZAC claims no credit)
  └─ Yes → Was there a clear, evidenced link (shown → acknowledged → same entity → in window)?
             ├─ Strong, single-cause link      → Directly Attributable Value
             └─ Contributory / multi-cause link → Influenced Value (apply discount factor)
```

> Attribution must be **honest and confidence-based** (Day 3 §15, §17). The goal is not to prove ZAC was right; it is to **learn what actually improves the business.** Negative and unexpected outcomes are recorded too (Day 3 §17.4) and *lower* confidence in similar future items.

**Attribution hooks already in the schema** (reuse, do not invent — Day 1 §15, Future Integration Notes §3): `booking.rebooking_outcomes.rebook_source` (text, can be `'zac'`) and `booking.appointments.booking_channel = 'api'`.

---

## 5. Confidence Model

Confidence is shown to users where it matters — **important insights, value estimates, and opportunities** (Luke, Day 3 §22 Q5). ZAC uses a simple, explainable three-level scale (consistent with the Day 2 §9 / Day 3 §14 contracts), with defined drivers so confidence is derived, not guessed.

| Level | Meaning | Typical drivers |
|---|---|---|
| **High** | Strong evidence; source data present and complete; clear attribution link. | Directly Attributable; complete source tables; large sample; short measurement window met. |
| **Medium** | Reasonable evidence; some assumptions or partial data; contributory attribution. | Influenced; some imputed inputs; moderate sample. |
| **Low** | Indicative only; sparse data, proxy metric, or weak link. | Observed with proxy value; empty/partial source table; small sample; long or open window. |

**Confidence drivers (what moves the level):**
- **Data completeness** — is the source table populated for this business/period? (Day 1 §8 data-readiness caveat.)
- **Attribution strength** — Directly Attributable > Influenced > Observed.
- **Sample size** — one client vs a cohort.
- **Window fit** — outcome fell inside the declared `measurement_window_days`.
- **Prior outcome history** — repeated negative outcomes for a pattern lower confidence (Day 3 §17.4).

> **Rule:** Confidence is **presented alongside value estimates and important items**, never hidden inside them. A value figure with no confidence level is incomplete.

---

## 6. Evidence Model

Every value claim must be **traceable to a source**. ZAC never computes KPIs itself; it quotes QLOOQO's deterministic engine and report endpoints (Day 1 §12A, Day 2 §10). Each value line carries an `evidence[]` block (extends the Day 2 §9 response contract).

A value-claim evidence record should include:

- `source_type` — `tool` | `kpi_snapshot` | `report_endpoint` | `observed_outcome`
- `source_ref` — tool name / endpoint / `zac.kpi_snapshots` id / `zac.observed_outcomes` id
- `metric_changed` — which business metric moved (e.g. `rebooking_rate`, `colour_waste_grams`)
- `as_of` — timestamp / period the evidence covers
- `entities_used` — target entity type/ids (never raw PII — §on privacy)
- `calculation_method` — the named method from §8
- `attribution_type` — Observed | Influenced | Directly Attributable (§4)
- `confidence` — High | Medium | Low (§5)
- `assumptions` / `limitations` — imputed inputs, missing tables, discount factors applied

> **The Day 4 evidence rule.** Every value-created claim must show: **(1) where the value came from, (2) which business metric changed, (3) what evidence was used, (4) whether it was Observed / Influenced / Directly Attributable, (5) confidence level, (6) calculation method, (7) limitations or assumptions.** A claim missing any of these seven is not "value created" — it is an unsupported number and must be flagged or withheld (reinforces Day 2 §10 Truth & Safety).

---

## 7. Value Created Categories

Value Created is a **report/dashboard with many sections**, not one metric (Luke, Day 3 §22 Q3). The categories below extend the Day 3 §16 value measurement categories with commercial framing.

For **each** category this document defines: **business definition · source data · calculation method · attribution method · confidence level · limitations · Phase 1 readiness.** The overview is below; full per-category definitions are in §8.

| # | Category | Business definition (short) | Default attribution | Default confidence | Phase 1 readiness |
|---|---|---|---|---|---|
| 1 | **Revenue Influenced** | Additional booked/served revenue ZAC helped surface. | Influenced | Medium | **Ready** (bookings/appointments populated) |
| 2 | **Estimated Profit Impact** | Revenue impact adjusted for cost/margin. | Influenced | Low–Medium | **Partial** — needs cost/margin inputs |
| 3 | **Retail Growth** | Uplift in retail product sales. | Influenced/Observed | Low–Medium | **Blocked** — `retail_sales` empty in inspected dataset |
| 4 | **Rebooking Improvement** | More clients rebooking their next visit. | Directly Attributable / Influenced | Medium–High | **Ready** — `rebooking_outcomes.rebook_source` hook exists |
| 5 | **Bookings Recovered** | Lapsed/overdue clients returned after a ZAC opportunity. | Directly Attributable | Medium–High | **Ready** |
| 6 | **Colour Waste Reduced** | Fewer grams / less cost of colour wasted. | Influenced | Low–Medium | **Partial** — QLab formulas populated; `waste_events` empty in inspected dataset |
| 7 | **Stock Savings** | Avoided over-order / dead-stock / stock-out losses. | Influenced/Observed | Low | **Partial** — inventory alerts exist; `product_usage` empty in inspected dataset |
| 8 | **Utilisation Improvement** | Higher chair/stylist utilisation. | Influenced | Medium | **Ready** |
| 9 | **Client Retention** | More clients retained / fewer lost. | Influenced/Observed | Low–Medium | **Ready (proxy)** — via rebooking/return signals |
| 10 | **Staff Development** | Measurable improvement in a stylist's KPIs after coaching. | Directly Attributable / Influenced | Medium | **Ready** — `GET /api/kpi/me` |
| 11 | **Time Saved** | Analyst/lookup time replaced by instant answers. | Directly Attributable | Medium | **Ready** — from ZAC event counts |
| 12 | **Management Hours Saved** | Owner/manager reporting & review time saved. | Directly Attributable | Medium | **Ready** — from report/review counts |
| 13 | **Training Time Reduced** | Faster onboarding/upskilling via in-context coaching. | Influenced | Low | **Partial** |
| 14 | **Business Health Improvement** | Movement in a composite health score. | Observed/Influenced | Low–Medium | **Partial** — needs health-score definition |
| 15 | **Subscription ROI** | Total value created ÷ ZAC subscription cost. | Composite | Medium | **Ready** — once §12 model runs |

> **Data-readiness is honest by design.** Day 1 §8/§15 found several source tables empty in the inspected dev-test dataset (`retail_sales`, `location_fixed_costs`, `product_usage`, `waste_events`). Categories that depend on them are marked **Blocked** or **Partial** and must show *"no data captured yet"* rather than infer (Day 2 §10). Production parity must be re-verified (Day 1 §18, Decision Log QC8).

---

## 8. Category Calculation Methods

Each category below states **source data**, **calculation method**, **attribution method**, **confidence**, **limitations**, and **Phase 1 readiness**. All monetary values follow QLOOQO's convention: integer `*_cents` (GBP).

> **Convention:** `Δmetric` = change vs a baseline (prior period or pre-item snapshot from `zac.kpi_snapshots`). `discount_factor` ∈ (0,1] downgrades Influenced value to avoid over-claiming. `avg_value` figures come from QLOOQO's own KPI engine, never from model memory (Day 2 §10).

### 8.1 Revenue Influenced
- **Source data:** `booking.appointments`, `GET /api/dashboard/kpis`, `zac.kpi_snapshots`.
- **Calculation:** `Σ (incremental_appointments × avg_appointment_value) × discount_factor`, where incremental = appointments linked to a ZAC opportunity above the baseline booking rate.
- **Attribution:** Influenced by default; Directly Attributable only where a specific booking links to a shown item (`booking_channel='api'` / `rebook_source='zac'`).
- **Confidence:** Medium. **Limitations:** revenue is influenced by many factors; discount factor is an assumption. **Phase 1:** Ready.

### 8.2 Estimated Profit Impact
- **Source data:** Revenue Influenced (§8.1) + service/product cost inputs (`location_fixed_costs`, cost-of-goods where available).
- **Calculation:** `Revenue Influenced × estimated_margin_rate`. If margin inputs are missing, report **range** with Low confidence and mark assumption explicitly.
- **Attribution:** Influenced. **Confidence:** Low–Medium. **Limitations:** cost tables empty in the inspected dataset (`location_fixed_costs` — Day 1 §8); margin rate is a planning assumption until captured. **Phase 1:** Partial.

### 8.3 Retail Growth
- **Source data:** `GET /api/retail-sales`, `retail_sales`. **⚠ empty in inspected dataset.**
- **Calculation:** `Δretail_revenue × discount_factor`, attributed to periods/stylists where ZAC surfaced retail opportunities.
- **Attribution:** Influenced or Observed. **Confidence:** Low–Medium. **Limitations:** blocked until `retail_sales` is captured. **Phase 1:** Blocked (report "no data captured yet").

### 8.4 Rebooking Improvement
- **Source data:** `booking.rebooking_outcomes` (incl. `rebook_source`), `GET /api/dashboard/kpis`, `GET /api/kpi/me`.
- **Calculation:** `(rebook_rate_after − rebook_rate_before) × eligible_clients × avg_next_visit_value`. Directly Attributable slice = rebookings with `rebook_source='zac'`.
- **Attribution:** Directly Attributable (tagged) + Influenced (rate lift). **Confidence:** Medium–High. **Limitations:** requires the rebook-source hook to be set at booking time. **Phase 1:** Ready.

### 8.5 Bookings Recovered
- **Source data:** `booking.appointments`, overdue/lapsed-client signals, `zac.recommendations` (opportunity items), `zac.observed_outcomes`.
- **Calculation:** `Σ recovered_clients × avg_appointment_value` where a lapsed client returned within the window after a shown "overdue client" opportunity.
- **Attribution:** Directly Attributable (window + shown item + same client). **Confidence:** Medium–High. **Limitations:** natural returns must be netted out via baseline return rate. **Phase 1:** Ready.

### 8.6 Colour Waste Reduced
- **Source data:** `lab.formulas` / `lab.formula_items` (grams), QLab analytics (`GET /api/lab/analytics/summary`), `waste_events` (empty in inspected dataset).
- **Calculation:** `(waste_grams_before − waste_grams_after) × cost_per_gram × discount_factor`. Fall back to grams-only when cost/gram missing. *(Grams are derivable from `lab.formula_items`, which is populated — hence Partial, not Blocked, even though `waste_events` is empty.)*
- **Attribution:** Influenced. **Confidence:** Low–Medium. **Limitations:** `waste_events` empty in inspected dataset; cost/gram may be assumed. **Phase 1:** Partial. *(Aligns with the colour moat — Day 1 §9.)*

### 8.7 Stock Savings
- **Source data:** `GET /api/dashboard/inventory-alerts`, stock movement, `product_usage` (empty in inspected dataset).
- **Calculation:** `avoided_overorder_value + avoided_stock_out_loss + avoided_deadstock_writeoff`, each conditioned on a ZAC stock Watch Point being shown.
- **Attribution:** Influenced/Observed. **Confidence:** Low. **Limitations:** ordering is email-not-API (no PO model, Day 1 §17); `product_usage` empty in inspected dataset. **Phase 1:** Partial.

### 8.8 Utilisation Improvement
- **Source data:** `GET /api/dashboard/kpis`, utilisation KPIs, rota/availability reads.
- **Calculation:** `(utilisation_after − utilisation_before) × available_hours × avg_hourly_value × discount_factor`.
- **Attribution:** Influenced. **Confidence:** Medium. **Limitations:** utilisation shifts have many drivers; discount factor assumed. **Phase 1:** Ready.

### 8.9 Client Retention
- **Source data:** repeat-visit / return signals from `booking.appointments`, `rebooking_outcomes`.
- **Calculation:** `Δretained_clients × avg_client_annual_value × attribution_share`. Use rebooking/return as a **proxy** until a retention definition is fixed.
- **Attribution:** Influenced/Observed. **Confidence:** Low–Medium. **Limitations:** retention is proxied; annual-value assumption. **Phase 1:** Ready (proxy).

### 8.10 Staff Development
- **Source data:** `GET /api/kpi/me` (per-stylist), `zac.recommendations` (coaching points), `zac.kpi_snapshots`.
- **Calculation:** `Σ per-stylist Δ(coached KPI)` (e.g. rebooking, retail attach) after a coaching point, valued via the relevant category method.
- **Attribution:** Directly Attributable (coached KPI moved after a coaching point) / Influenced. **Confidence:** Medium. **Limitations:** confounded by seasonality/experience. **Phase 1:** Ready. *(Constitution: "improve businesses by improving people" — Day 3 §3.1.)*

### 8.11 Time Saved
- **Source data:** ZAC event counts (`answer_delivered`, `report.viewed` — Day 2 §12, Day 3 §20).
- **Calculation:** `answers_delivered × avg_minutes_saved_per_lookup × loaded_hourly_rate`. `avg_minutes_saved` is a configurable planning assumption.
- **Attribution:** Directly Attributable (the answer replaced a manual lookup). **Confidence:** Medium. **Limitations:** minutes-saved is assumed; not all answers replace work. **Phase 1:** Ready.

### 8.12 Management Hours Saved
- **Source data:** report/review generation counts, Sunday-report sends (§11).
- **Calculation:** `(reports + reviews) × avg_hours_saved_per_report × manager_hourly_rate`.
- **Attribution:** Directly Attributable. **Confidence:** Medium. **Limitations:** hours-saved assumption; only counts opened reports (§21 optimisation trigger). **Phase 1:** Ready.

### 8.13 Training Time Reduced
- **Source data:** onboarding coaching-point counts, new-staff KPI ramp curves.
- **Calculation:** `Δ(days_to_competency) × daily_cost_of_ramp`, valued where in-context coaching shortened ramp.
- **Attribution:** Influenced. **Confidence:** Low. **Limitations:** hardest to isolate; needs ramp baseline. **Phase 1:** Partial.

### 8.14 Business Health Improvement
- **Source data:** composite of revenue, rebooking, utilisation, retention, waste (weighted health score — definition TBD).
- **Calculation:** `Δhealth_score`, with the underlying category deltas shown as the evidence.
- **Attribution:** Observed/Influenced. **Confidence:** Low–Medium. **Limitations:** needs an agreed health-score formula (Open Decision, §25). **Phase 1:** Partial.

### 8.15 Subscription ROI
- **Source data:** Σ of categories 1–14 (with attribution + confidence) ÷ ZAC subscription price for the business.
- **Calculation:** `ROI = total_value_created / zac_subscription_cost`; also expressed as a multiple ("£X value per £1 of subscription"). See §12.
- **Attribution:** Composite (inherits per-category attribution). **Confidence:** Medium (bounded by weakest inputs). **Limitations:** only as strong as the categories feeding it; Observed value should be shown separately from Influenced/Directly Attributable so ROI is not inflated. **Phase 1:** Ready once §12 runs.

---

## 9. Value Created Dashboard / Report Structure

The **Value Created by ZAC** surface is a structured report (and, if Luke confirms QL4, a live dashboard). Proposed layout:

1. **Headline band** — Total Estimated Value Created (this period), split into three chips: **Directly Attributable · Influenced · Observed** (never a single blended number).
2. **Subscription ROI** — value-per-£1 and payback statement, with the Observed portion visibly excluded from the "hard" ROI figure.
3. **Top categories** — the 3–5 highest-value categories this period, each with its attribution + confidence badge.
4. **Best item of the period** — the single most valuable Insight / Coaching Point / Opportunity, with its evidence.
5. **Category detail** — all 15 categories (§7) with value, attribution, confidence, method, and limitations, collapsible.
6. **What ZAC learned** — outcome-attribution feedback, including negative/unexpected outcomes (Day 3 §17.4).
7. **Confidence & assumptions footer** — global assumptions (discount factors, minutes-saved, margin rate) and data-readiness caveats.
8. **Owner/Manager feedback control** — a "Did this help? (helped / did not help / partly)" marker on items (Luke, Day 3 §22 Q6), captured into the learning model (see "Manual feedback" below).

> **Manual feedback becomes part of the learning model.** Owners and managers can mark whether an Insight / Coaching Point / Opportunity helped. This is stored as an outcome/feedback signal (not just a UI state) and feeds attribution confidence over time (Day 3 §17). It is *not* a write action on the business — it is feedback on ZAC.

**Privacy in the dashboard.** Owners and managers see **themes, trends, risks, and performance metrics — not private stylist coaching conversations** (Luke, Day 3 §22 Q2, §10 scopes). Stylist personal coaching memory stays private between ZAC and the stylist wherever possible; owner/manager views aggregate to themes and signals.

---

## 10. Example Monthly Value Created Report

*Illustrative, using mock figures — not real salon data. Shows the shape and the mandatory evidence discipline.*

> **Value Created by ZAC — "Willow & Co" — June 2026**
>
> **Total Estimated Value Created: £2,180**
> · Directly Attributable **£640** · Influenced **£1,090** · Observed **£450**
>
> **Subscription ROI:** ZAC subscription £49/mo → **~£35 value per £1** on hard (Directly Attributable + Influenced) value; Observed value shown separately and excluded from the ROI figure.
>
> **Top categories this month**
> | Category | Value | Attribution | Confidence | Method |
> |---|---|---|---|---|
> | Bookings Recovered | £520 | Directly Attributable | High | §8.5 — 8 lapsed clients returned within 14-day window after "overdue client" opportunities; `rebook_source='zac'` on 6 of 8. |
> | Rebooking Improvement | £610 | Influenced | Medium | §8.4 — rebooking rate 55%→61% after coaching points; discount factor 0.6 applied. |
> | Colour Waste Reduced | £180 | Influenced | Low–Medium | §8.6 — waste grams down 12% for 2 coached stylists; cost/gram assumed (flagged). |
> | Time Saved | £320 | Directly Attributable | Medium | §8.11 — 214 answers × 6 min × £15/h loaded rate. |
> | Retail Growth | — | — | — | §8.3 — **no data captured yet** (`retail_sales` empty). |
>
> **Best item of the period:** *Opportunity* — "12 colour regulars overdue by >8 weeks." Shown to 3 stylists; 8 booked. Evidence: `booking.appointments`, overdue-client signal, `zac.observed_outcomes`. Confidence: High.
>
> **What ZAC learned:** A Saturday rota Watch Point was actioned but utilisation did not move → recorded as a negative outcome (Day 3 §17.4); confidence in similar rota items lowered.
>
> **Assumptions & limitations:** minutes-saved = 6 (planning assumption); Influenced discount factor 0.6; margin rate not available (Profit Impact shown as range only); Retail & Stock partially blocked pending data capture.

---

## 11. Sunday Evening Report Integration

QLOOQO already has a **Sunday Night Report** feature at the location level — `sunday_report_enabled`, `sunday_report_recipients`, `sunday_report_send_hour` in `owner-location-settings` (`apps/api/src/owner-location-settings/`). Day 4 proposes a **future "Value Created by ZAC" section** inside weekly / monthly / yearly reporting that rides this existing scheduled surface rather than inventing a new one.

> **Deferred for Phase 0.** Live Sunday-report integration is **not** part of Phase 0 (§23). This section defines the *future* content contract only.

Proposed **"Value Created by ZAC"** report section (weekly / monthly / yearly):

- **Estimated value created** (period total)
- **Directly attributable value**
- **Influenced value**
- **Observed value**
- **Top value categories** (3–5, with confidence badges)
- **Best Insight / Coaching Point / Opportunity** of the period
- **Evidence used** (sources behind the headline figures)
- **Confidence level** (overall + per top category)
- **What ZAC learned** (including negative/unexpected outcomes)
- **Next week's focus** (the leading Opportunity / Watch Point to carry forward)

**Cadence.** Luke's Day 3 §22 Q7 (weekly/monthly/yearly/all three) remains open (§25). The architecture supports all three: weekly rides the Sunday Night Report; monthly is the full Value Created report (§9–§10); yearly is a rollup. **Report frequency is itself a cost control** (§21) — generating reports that are never opened is an optimisation trigger.

---

## 12. Subscription ROI Model

**Subscription ROI** answers "is ZAC worth the subscription?" honestly.

```
zac_value_created(period)  = Σ category_value × attribution_weight × confidence_weight
zac_operating_cost(period) = Σ cost_events(period)                       // §13–§15
subscription_price(period) = plan price paid by the business

Subscription ROI  = zac_value_created / subscription_price          // value per £1 of price
Gross margin      = (subscription_price − zac_operating_cost) / subscription_price   // §20
```

Design rules:
- **Show Observed value separately.** Headline ROI uses Directly Attributable + Influenced (discounted); Observed is reported but excluded from the "hard" ROI number so ROI is never inflated.
- **Confidence-weight the total.** Low-confidence categories contribute less; the report always shows the un-weighted and weighted figures.
- **ROI vs price, margin vs cost.** ROI (§12) is the *customer's* view (value ÷ price); gross margin (§20) is *QLOOQO's* view (price − cost). Both must stay healthy: high ROI proves the product; healthy margin proves the business.

---

## 13. Cost per Intelligence Model

ZAC's operating cost must be understood **per unit of intelligence**, from Phase 1, so pricing keeps margin at scale. This model is built entirely on **configurable planning assumptions** (§17) — no live vendor prices.

**Cost-per units to compute:**

| Unit | Definition | Roughly driven by |
|---|---|---|
| **Cost per conversation** | Full cost of one ZAC conversation (all model calls + tools + retrieval). | tokens in/out, tool calls, cache hit rate |
| **Cost per Insight / Coaching Point / Opportunity** | Cost to produce one surfaced item (internally, one recommendation). | reasoning-model use, evidence assembly |
| **Cost per report** | Cost to generate one report (e.g. Value Created, KPI summary). | context size, model tier, structured output |
| **Cost per business review** | Cost of a full weekly/monthly business review (multiple reports + reasoning). | reports bundled + reasoning-model escalation |
| **Cost per active user** | Monthly ZAC cost ÷ active users. | conversations/user/day |
| **Cost per salon** | Monthly ZAC cost for one salon (all users, reports, background jobs). | usage profile (§18) |
| **Cost per enterprise account** | Monthly ZAC cost for a multi-location group. | Σ locations + enterprise rollup reports |

Each is a **derived quantity**: `unit_cost = Σ cost_events attributable to the unit / count of units` over the period, using the token/price assumptions in §17.

---

## 14. Cost Components

The cost of one intelligence unit is the sum of:

1. **Model input tokens** — prompt + assembled context + tool results fed to the model.
2. **Model output tokens** — the generated answer / structured output.
3. **Reasoning / thinking tokens** — extra tokens on stronger reasoning models (the expensive tier; routing keeps this rare — §21).
4. **Tool-call overhead** — each tool round-trip adds context (its result is fed back in as input tokens).
5. **Retrieval / context assembly** — fetching memory, knowledge, KPI snapshots (compute + tokens; kept minimal per Day 2 §7).
6. **Prompt-cache reads/writes** — caching lowers repeat input cost (per-tenant only — Day 1 §12D).
7. **Embeddings** — *future only* (semantic retrieval is deferred, Day 1 §17); zero in Phase 1's rule-based retrieval.
8. **Storage** — `zac.*` events, memory, snapshots, cost events (small per-row, grows with volume).
9. **Background jobs** — KPI snapshotting, outcome reconciliation, report generation (compute + model calls).
10. **Infra overhead** — API compute, DB, egress (largely fixed; allocated per salon).

> **Dominant driver:** model tokens (1–4), especially reasoning tokens (3). Everything in §21 optimisation exists to keep 1–4 down while preserving answer quality.

---

## 15. Cost Events to Track

Cost is measured, not estimated after the fact. Per model call, log the Day 2 §12 telemetry into `zac.cost_events` (Day 3 §19):

`business_id` · `user_id` · `role` · `conversation_id` · `task_type` · `model_provider` · `model_name` · `input_tokens` · `output_tokens` · `reasoning_tokens` · `estimated_cost` · `latency_ms` · `tool_calls_used` · `cache_hit` · `recommendation_generated` · `unit_type` (conversation | item | report | review | job) · `period`.

**Cost event vocabulary** (extends Day 2 §12 / Day 3 §20):
`zac.cost_recorded` · `zac.report.generated` · `zac.review.generated` · `zac.snapshot.job.ran` · `zac.reconciler.job.ran` · `zac.cache.hit` · `zac.cache.miss` · `zac.model.escalated` (fast → reasoning).

> **Why from Phase 1:** like value (Day 1 §15), cost-per-intelligence is **unreconstructable** for any window where cost events were not captured. Capturing them is cheap now.

---

## 16. Intelligence Unit Definitions

Precise unit definitions so cost-per figures are comparable across salons:

- **Conversation** — one bounded ZAC session (`zac.conversation.started` → last message before TTL close). May contain many model calls.
- **Insight / Coaching Point / Opportunity** — one surfaced item; internally one `zac.recommendations` row reaching `shown` (Day 3 §13–§14).
- **Report** — one generated document (Value Created, KPI summary, colour/waste summary).
- **Business review** — one full weekly/monthly review = a bundle of reports + reasoning + a "focus" synthesis.
- **Active user** — a user with ≥1 ZAC conversation in the period.
- **Salon** — one `business_id` (single or few locations).
- **Enterprise account** — one owning group spanning multiple locations/businesses (note: cross-business rollup is currently constrained by the one-primary-business collapse — Day 1; enterprise rollup is a future capability).

---

## 17. Planning Cost Assumptions

> **⚠ No live vendor prices are used or committed here.** All figures below are **configurable planning assumptions** expressed as named constants. **Provider pricing must be re-read from the official provider pricing pages and updated before any final commercial sign-off** (Day 2 §11 keeps providers swappable behind `model-provider.interface.ts`). The repository contains no committed AI provider price, so none is reproduced.

Configurable assumption constants (values are placeholders to be set in config, **not** quoted vendor rates):

| Constant | Meaning | Set from |
|---|---|---|
| `PRICE_FAST_IN` / `PRICE_FAST_OUT` | fast/cheap model price per 1M input/output tokens | official pricing page |
| `PRICE_REASON_IN` / `PRICE_REASON_OUT` | reasoning model price per 1M input/output tokens | official pricing page |
| `PRICE_CACHE_READ` / `PRICE_CACHE_WRITE` | prompt-cache read/write price per 1M tokens | official pricing page |
| `AVG_TOKENS_PER_CONVERSATION` | blended input+output tokens per conversation | telemetry (§15) |
| `REASONING_MODEL_SHARE` | % of calls routed to the reasoning tier | telemetry / target |
| `CACHE_HIT_RATE` | % of input tokens served from cache | telemetry / target |
| `AVG_MINUTES_SAVED_PER_LOOKUP` | value-side assumption for Time Saved (§8.11) | product estimate |
| `INFLUENCED_DISCOUNT_FACTOR` | downgrade applied to Influenced value (§4.2) | product policy |
| `ESTIMATED_MARGIN_RATE` | margin assumption for Profit Impact (§8.2) | finance, until captured |

**Worked formula (per conversation):**

```
cost_per_conversation ≈
    (input_tokens  × blended_input_price)
  + (output_tokens × blended_output_price)
  − (cached_input_tokens × (blended_input_price − PRICE_CACHE_READ))

where blended_*_price = REASONING_MODEL_SHARE × PRICE_REASON_*
                      + (1 − REASONING_MODEL_SHARE) × PRICE_FAST_*
```

The **usage profiles (§18)** then multiply cost-per-conversation and cost-per-report by expected volumes to reach a monthly cost per salon, which must land inside the target envelopes below. The named constants are chosen/tuned so the profiles hit those envelopes — the envelopes are the *design constraint*, the constants are *inputs to be reconciled with real pricing*.

---

## 18. Usage Profiles

Planning profiles that anchor the cost model. **Target monthly ZAC operating cost** is the design envelope the §17 constants must satisfy.

### 18.1 Solo stylist
- **1** active user
- **5–15** ZAC conversations/day
- **1–3** insights/coaching points/opportunities/day
- **1** daily summary
- **1** weekly review
- **1** monthly value-created report
- **Target monthly ZAC operating cost: $2–$8**

### 18.2 Small salon
- **5** active users
- **25–60** conversations/day
- **8–20** insights/coaching points/opportunities/day
- **2–5** reports/day
- **1** weekly business review
- **1** monthly value-created report
- **Target monthly ZAC operating cost: $8–$30**

### 18.3 Large multi-location business
- **25–100** active users
- **150–500** conversations/day
- **50–200** insights/coaching points/opportunities/day
- **10–50** reports/day
- **Multi-location** weekly reviews
- **1** monthly enterprise value-created report
- **Target monthly ZAC operating cost: $50–$250+**

> Currency note: usage-profile envelopes are stated in **USD** (provider pricing is typically USD); QLOOQO value/money data is **GBP `*_cents`**. The cost model must record the FX assumption used and keep provider-cost (USD) and business-value (GBP) clearly separated.

---

## 19. Scaling Projection

Fleet-level projection using the **blended small-salon target cost** (§18.2). Linear blend for planning; real cost per salon should *fall* with scale as caching and batching improve (§21).

| Fleet size | Projected monthly ZAC operating cost (blended small-salon) |
|---|---|
| **100 salons** | **$1,000 – $3,000 / month** |
| **1,000 salons** | **$10,000 – $30,000 / month** |
| **10,000 salons** | **$100,000 – $300,000 / month** |
| **100,000 salons** | **$1,000,000 – $3,000,000 / month** |

> These are **linear planning envelopes**, not commitments. At scale, per-tenant budgets, caching, metadata-filtered retrieval, and background-job batching (§21) should bend the curve *below* linear. Any silent cap or sampling used to hit these numbers must be logged, not hidden (Day 3 measurement discipline).

---

## 20. Gross Margin Model

ZAC's operating cost must stay a small fraction of subscription revenue.

| Band | ZAC cost as % of subscription revenue | Action |
|---|---|---|
| **Ideal** | **< 5%** | Healthy — maintain. |
| **Acceptable (early)** | **5% – 10%** | Acceptable during rollout; monitor. |
| **Needs optimisation** | **> 10%** | Trigger optimisation controls (§21). |
| **Critical** | **> 20%** | Escalate — pricing and/or routing must change before scaling further. |

**Gross margin at different subscription levels** (illustrative structure — fill with real prices at sign-off):

```
gross_margin = (subscription_price − zac_operating_cost) / subscription_price
```
- Lower-priced tiers (e.g. Solo/Spark) have the **thinnest** absolute headroom → most sensitive to reasoning-model overuse; keep them mostly on the fast tier.
- Higher-priced tiers (e.g. Infinity/enterprise) can *afford* more reasoning use per user but must still respect the % bands above.

> Tier names align with the finalised Spark / Pulse / Infinity model; exact subscription prices are a **separate billing decision** and must be plugged in before margins are signed off.

---

## 21. Optimisation Triggers

**Triggers — when to act** (any of these fires optimisation):
- **Cost per salon exceeds its target margin** (§20 band breached).
- **Reasoning-model usage exceeds the expected `REASONING_MODEL_SHARE`.**
- **Reports are generated but not opened** (`zac.report.generated` without a `zac.report.viewed`).
- **Proactive insights have low engagement** (shown but rarely acknowledged/accepted).
- **Memory retrieval sends too much context** (input tokens per call trending up).
- **Token usage grows faster than active-user growth** (cost outrunning value).
- **Weekly/monthly reports become too expensive at scale.**

**Controls — how to act:**
- **Model routing** — right model for the task; fast tier by default, reasoning only when needed (Day 2 §11).
- **Prompt / result caching** — per-tenant only (Day 1 §12D).
- **Tool result caching** — reuse recent tool outputs within a conversation/window.
- **Summary memory** — store summaries, not full transcripts (Day 3 §9; also reduces PII retention).
- **Metadata-filtered retrieval** — rule-based/metadata filtering before (future) semantic search (Day 3 §4).
- **Per-tenant budgets** — cap runaway spend per business.
- **Report frequency controls** — throttle unopened/low-value reports (§11).
- **Background job batching** — batch snapshots/reconcilers/report generation.
- **Reasoning-model escalation only when needed** — escalate fast → reasoning on complexity signals, and log `zac.model.escalated`.

---

## 22. Cost per Intelligence Dashboard

An **internal** (QLOOQO operator) dashboard — not shown to salon customers — surfacing the cost side so margin is always visible. Proposed panels:

1. **Cost per unit** — conversation, item, report, review (trend over time).
2. **Cost per active user / per salon / per enterprise account.**
3. **Model mix** — % fast vs reasoning tier; `REASONING_MODEL_SHARE` vs target.
4. **Cache effectiveness** — hit rate; tokens saved.
5. **Margin by tier** — ZAC cost as % of subscription revenue per plan, against the §20 bands.
6. **Optimisation trigger board** — which §21 triggers are firing, per tenant/fleet.
7. **Value ↔ cost overlay** — value created (§9) vs operating cost, per salon — the ROI/margin reconciliation.

> This dashboard is **deferred to a future phase** (it needs live `zac.cost_events`). In Phase 0 it exists as this specification only.

---

## 23. Phase 0 Proof-of-Architecture Scope

Phase 0 delivers a **documented, scenario-based proof-of-architecture** — evidence that the design *works and is trustworthy* before Phase 1 investment. It is **non-production**.

### 23.1 Phase 0 CAN include
- Scenario-based validation.
- Mock / test data examples (realistic QLOOQO shapes; no real client PII).
- Sample **Owner / Manager / Stylist** conversations.
- Sample **evidence-attached** insights (each with source, method, attribution, confidence, limitations — §6).
- Sample **Context Memory** records (Day 3 §9).
- Sample **Outcome Memory** records (Day 3 §11).
- Sample lifecycle examples (signal → evidence → item → shown → outcome → attribution → value — Day 3 §13).
- **Observed / Influenced / Directly Attributable** attribution examples (§4).
- Sample **Value Created dashboard / report** (§9–§10).
- **Cost per Intelligence model** (§13–§22).
- **Acceptance criteria checklist** (§24; full list in [`phase-0-acceptance-criteria.md`](phase-0-acceptance-criteria.md)).

### 23.2 Phase 0 must NOT include
- Production login integration.
- Real ZAC UI inside QLOOQO.
- Real database migrations.
- Real LLM implementation.
- Live tool execution.
- Live memory tables.
- Live Sunday-report integration.
- Autonomous actions.

> Everything in §23.2 belongs to **Phase 1** or a **separately agreed prototype/spike**. Phase 0 proves the *architecture and the trust model* on paper and in scenarios — not in production.

---

## 24. Phase 0 Acceptance Criteria Additions

Day 4 adds the following to the Phase 0 acceptance checklist (the complete, canonical list lives in [`phase-0-acceptance-criteria.md`](phase-0-acceptance-criteria.md)):

- ✅ **Value Created model documented** — categories, calculation methods, dashboard/report structure (§7–§10).
- ✅ **Attribution model documented** — Observed / Influenced / Directly Attributable with a decision rule (§4).
- ✅ **Confidence model documented** — levels + drivers, shown where it matters (§5).
- ✅ **Evidence model documented** — the seven-part value-claim rule (§6).
- ✅ **Sunday-report Value Created section defined** (future content contract, §11).
- ✅ **Cost per Intelligence model documented** — cost-per units, components, events, usage profiles, scaling, margin bands, optimisation (§13–§22).
- ✅ **Configurable pricing, not hardcoded vendor costs** — with the sign-off caveat (§17).
- ✅ **Phase 0 proof-of-architecture scope clearly separated from production** (§23).

---

## 25. Open Decisions for Luke

1. **Value Created surface:** dashboard *and* reports, or reports only in Phase 1? (Reaffirms Decision Log QL4.)
2. **Report cadence:** weekly (Sunday), monthly, yearly, or all three? (Day 3 §22 Q7.)
3. **First value headline:** which category leads the launch narrative — Bookings Recovered, Rebooking, Time Saved, or Business Health? (Day 3 §22 Q3.)
4. **Confidence display:** show High/Medium/Low to users on all items, or only on important insights/value estimates? (Day 3 §22 Q5.)
5. **Observed value visibility:** show Observed value to owners at all (context), or only Influenced + Directly Attributable (credit)?
6. **Manual feedback:** confirm the "Did this help?" control on items feeds the learning model (Day 3 §22 Q6).
7. **Stylist coaching privacy:** confirm stylist coaching memory stays private from owners/managers by default (Day 3 §22 Q2).
8. **Business Health score:** agree the composite formula and weights for §8.14.

---

## 26. Open Decisions for Cosan

1. **Cost events store:** confirm `zac.cost_events` (Day 3 §19) as the cost telemetry home, separate from `audit.activity_log` (Day 3 §23 Q3).
2. **KPI snapshot store:** `zac.kpi_snapshots` vs the empty `analytics` schema for the value-baseline spine (Decision Log QC5).
3. **Attribution reconciler:** the periodic job that links observed outcomes to shown items — cadence and infra, given there is no durable scheduler today (Day 1 §17, Day 3 §23 Q8).
4. **Pricing config:** confirm the §17 constants live in configuration (per-provider, swappable) and are refreshed from official pricing before sign-off.
5. **Per-tenant budgets & routing:** confirm the model-router (Day 2 §11) enforces `REASONING_MODEL_SHARE` and per-tenant spend caps (§21).
6. **PII in cost/outcome telemetry:** confirm cost/outcome/value events store structured metadata + summaries only — no raw prompts/responses/PII by default (Day 3 §23 Q7).
7. **FX handling:** confirm how USD provider cost and GBP business value are stored and reconciled (§18 note).
8. **Report/review generation infra:** where weekly/monthly value reports are generated and how their cost is attributed (§11, §15).

---

## 27. Day 4 Conclusion

Day 4 turns ZAC's measurement architecture into a **commercial and operating model**.

> **ZAC should not only report value. ZAC should explain value — with source, metric, evidence, attribution, confidence, method, and limitations — and ZAC's cost to deliver that value must stay a small, measured fraction of subscription revenue.**

The Day 4 spine:
- **Value** is a multi-section report, split into **Observed / Influenced / Directly Attributable**, every line carrying evidence, confidence, and assumptions (§4–§10).
- **Reporting** rides QLOOQO's existing Sunday Night Report and a monthly Value Created report (§11).
- **Cost** is measured per unit of intelligence from Phase 1, projected to 100k salons, and held inside gross-margin bands by explicit optimisation triggers and controls (§13–§22).
- **Phase 0** proves all of this as a **non-production, scenario-based package** — with a clear acceptance checklist and a clean line between what Phase 0 documents and what Phase 1 builds (§23–§24).

This keeps ZAC honest (never over-claiming), trustworthy (always evidenced), and viable (always in margin) — a **trusted AI team member**, not a costly novelty.

---

*Documentation only. Nothing in this file has been implemented. All cost figures are configurable planning assumptions, not committed vendor prices — provider pricing must be re-read from official pricing pages before commercial sign-off. See [`phase-0-decision-log.md`](phase-0-decision-log.md) for tracked decisions, [`phase-0-acceptance-criteria.md`](phase-0-acceptance-criteria.md) for the Phase 0 sign-off checklist, and [`phase-0-future-integration-notes.md`](phase-0-future-integration-notes.md) for how a future team should bridge this design to the codebase when implementation is authorised.*
