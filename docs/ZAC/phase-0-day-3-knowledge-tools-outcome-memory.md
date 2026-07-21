# ZAC — Phase 0, Day 3: Knowledge, Tools and Outcome Memory

> **Status: Documentation only — NOT implemented.**
> This document records the Day 3 architecture decisions for ZAC inside QLOOQO so they can be referenced and integrated later. **No application source code, NestJS modules, database migrations, environment files, package manifests, or Supabase data have been created or changed.** Every schema, table, tool, field, and permission named below is a *proposed future design*, not an existing artifact.
>
> Date: 2026-07-20 · Phase: 0 (Discovery & Architecture) · Follows: [Day 1 Discovery Report](QLOOQO/ZAC%20Phase%200%20Discovery%20Report.md) and [Day 2 Core Architecture](phase-0-day-2-core-architecture.md).

---

## 1. Purpose

Day 3 defines the architecture for **what ZAC knows**, **what ZAC can safely access**, **what ZAC remembers**, and **how ZAC connects recommendations to real business outcomes**.

The goal is to ensure ZAC does not become a generic chatbot or a feature wrapper. ZAC should become a **trusted intelligence layer** that understands QLOOQO, understands each role, remembers meaningful context, observes business outcomes, and improves over time.

Day 3 remains **architecture-only. No implementation should begin yet.**

---

## 2. Core Day 3 Principle

ZAC should not only remember conversations.

ZAC should remember:

- what was discussed
- why it mattered
- what was recommended
- what evidence supported it
- what the user did next
- what actually happened in the business
- whether the outcome created value
- what can be learned from that outcome

This creates the foundation for ZAC to answer:

> **"What value has ZAC created for my business this month?"**

This is the same target question established in Day 1 §15 and Day 2 §12 — Day 3 defines the knowledge, memory, and outcome structures that make it answerable.

---

## 3. Knowledge Architecture

ZAC's knowledge should be split into **controlled knowledge categories**.

### 3.1 Constitution Knowledge

**Purpose:** To keep ZAC aligned with why he exists.

Includes:
- ZAC is a trusted AI team member
- ZAC improves businesses by improving people
- Truth, Loyalty, Integrity, Privacy, Humanity
- Progress over perfection
- Coach by default, business partner when needed
- Influence, never manipulation
- Human control before sensitive action

**Usage:** Constitution knowledge should influence ZAC's behaviour, tone, recommendations, and safety boundaries. It should **not** be treated as optional prompt text only. It should be reflected in **system rules, response contracts, memory rules, and recommendation logic** (reinforces Day 1 §12, the constitution→architecture mapping).

### 3.2 QLOOQO Platform Knowledge

**Purpose:** To help ZAC explain and support the QLOOQO product.

Includes: user roles · business/location structure · bookings · appointments · CRM · staff management · QLab · inventory · reports · KPIs · billing · notifications · Sunday reports · Salon Suite · security/permissions.

**Usage:** Powers platform help, onboarding, workflow explanations, and feature guidance.

### 3.3 QLab and Colour Knowledge

**Purpose:** To make ZAC valuable around colour usage, formulas, waste, and margin.

Includes: formula history · colour product usage · waste grams · waste cost · formula billing rules · product usage patterns · client colour history where permitted · stock risk from colour usage.

**Usage:** Supports stylist coaching, manager oversight, owner insights, and future waste-reduction recommendations. (Aligns with Day 1 §9 — colour history is the moat in `lab.formulas`/`formula_items`; client view is cost-stripped.)

### 3.4 Reports and KPI Knowledge

**Purpose:** To allow ZAC to explain business performance and coach improvement.

Includes: revenue · profit where available · appointments · no-shows · cancellations · rebooking · retail · utilisation · stylist performance · commission readiness · colour waste · inventory alerts · client retention · business health.

**Usage:** ZAC should **not invent these metrics. QLOOQO remains the source of truth.** ZAC explains, contextualises, and recommends based on **sourced** report/KPI data (Day 1 §8, §12A; Day 2 §10).

### 3.5 Role-Specific Coaching Knowledge

**Purpose:** To support Owners, Managers, and Stylists differently.

| Role | Coaching knowledge |
|---|---|
| **Owner** | business health · revenue/profit · ROI · value created · team performance · retention · utilisation · strategic decisions |
| **Manager** | location operations · staffing pressure · team performance · utilisation gaps · stock issues · rebooking patterns · service delivery |
| **Stylist** | personal performance · rebooking habits · retail confidence · colour usage · client experience · personal improvement |

**Usage:** The **same intelligence** should power every role, but **permissions and context must be different** (Day 2 §4–§5).

### 3.6 Salon-Specific Business Knowledge

**Purpose:** To make ZAC specific to each salon, not generic.

Includes: salon goals · owner priorities · business targets · location configuration · preferred operating model · team structure · active issues · recurring risks · important decisions · historical performance patterns.

**Usage:** This should live in **permission-aware business memory** (see §9–§10).

---

## 4. Knowledge Storage Recommendation

Future knowledge storage should include the table **`zac.knowledge_documents`** (proposed; do not create now).

Recommended fields:

- `id`
- `business_id`
- `location_id` *(nullable)*
- `title`
- `document_type`
- `content`
- `source_uri` *(nullable)*
- `tags`
- `visibility_scope`
- `role_scope`
- `created_by`
- `created_at`
- `updated_at`
- `effective_from`
- `expires_at` *(nullable)*
- `confidence_level`
- `status`

Document types may include:
`constitution` · `platform_help` · `workflow_guide` · `qlab_guide` · `report_definition` · `business_goal` · `salon_policy` · `coaching_framework` · `system_rule`.

**Phase 1 recommendation:** Start with **structured / rule-based retrieval and metadata filtering**. Semantic/vector retrieval can come later once the knowledge structure is stable (matches Day 1 §11, §17 — vector deferred).

---

## 5. Role-Based Knowledge Access

Knowledge access should be filtered by: `business_id` · `location_id` · user role · permissions · visibility scope · document type · active/inactive status.

Example rules:

| Role | Can access | Cannot access (unless explicitly allowed) |
|---|---|---|
| **Owner** | business-wide knowledge · owner-level reports · value-created summaries · team-level insights | — |
| **Manager** | assigned location/team knowledge · operational reports · staff performance where permitted | restricted owner-only financial data |
| **Stylist** | own performance coaching · permitted client/QLab context · platform guidance | business-wide financials · other stylists' private coaching context |

> Access is derived from `AuthUser.permissions[]` and scope — the platform decides, not the model (Day 2 §8).

---

## 6. Phase 1 Read-Only Tool Architecture

ZAC tools should be **explicit, typed, and permission-gated**.

> A tool is **not** simply a function call. It is a **controlled contract** between ZAC and QLOOQO.

Each tool should define:

- `tool_id`
- `domain`
- `purpose`
- `required_permissions`
- `allowed_roles`
- `input_schema`
- `output_schema`
- `evidence_schema`
- `pii_level`
- `cache_policy`
- `rate_limit`
- `source_of_truth`
- `read_or_write`
- `phase_allowed`

**Phase 1 tools must be read-only.**

---

## 7. Recommended Phase 1 Tool Groups

> All tools below are **read-only** and **proposed** for Phase 1. Names are illustrative contracts, not implemented functions. Where possible they wrap the existing guarded read endpoints inventoried in Day 1 §8.

### 7.1 Business Intelligence Tools
**Purpose:** Provide owner/manager business visibility.
Possible tools: `dashboard_kpis_tool` · `business_health_summary_tool` · `top_services_tool` · `revenue_trend_tool` · `utilisation_summary_tool`.
Used for: instant business intelligence · owner summaries · manager operational insight · Sunday report context.

### 7.2 Performance Coaching Tools
**Purpose:** Coach owners, managers, and stylists based on role-specific performance.
Possible tools: `stylist_performance_tool` · `personal_kpi_tool` · `team_performance_tool` · `commission_readiness_tool` · `staff_development_signal_tool`.
Used for: daily coaching · personal improvement · team management · "1% better" progress.

### 7.3 QLab and Colour Tools
**Purpose:** Support colour waste, formula history, and product usage insights.
Possible tools: `qlab_analytics_summary_tool` · `colour_waste_trend_tool` · `client_formula_history_tool` · `product_usage_pattern_tool`.
Used for: colour waste reduction · stylist coaching · stock planning · margin protection.

### 7.4 Booking and Rebooking Tools
**Purpose:** Identify missed opportunities and client retention patterns.
Possible tools: `booking_trend_tool` · `rebooking_rate_tool` · `missed_appointment_tool` · `no_show_summary_tool` · `client_retention_signal_tool` · `utilisation_gap_tool`.
Used for: rebooking improvement · recovered bookings · client retention · utilisation improvement.

### 7.5 Inventory and Stock Tools
**Purpose:** Surface stock risks and operational savings.
Possible tools: `inventory_alerts_tool` · `low_stock_risk_tool` · `stock_movement_summary_tool` · `dead_stock_signal_tool`.
Used for: stock savings · waste reduction · order planning · manager awareness.

### 7.6 Value Created Tools
**Purpose:** Estimate and explain ZAC's business value.
Possible tools: `zac_value_created_summary_tool` · `recommendation_outcome_summary_tool` · `roi_against_subscription_tool` · `time_saved_estimate_tool`.
Used for: weekly ZAC value summary · monthly value-created report · ROI reporting · retention storytelling.

---

## 8. Deferred Tools

The following tools **must not** be available in Phase 1:

`create_booking_tool` · `cancel_booking_tool` · `send_whatsapp_tool` · `send_sms_tool` · `send_email_tool` · `update_stock_tool` · `create_stock_order_tool` · `edit_client_profile_tool` · `change_staff_settings_tool` · `change_service_price_tool` · `approve_refund_tool` · `create_campaign_tool`.

**Reason:** These are write/action tools. They require an approval flow, stronger audit, human confirmation, agent-actor design, and additional testing.

> **Phase 1 rule: ZAC can recommend. ZAC cannot act.** (Day 2 §4; Day 1 §12C, §17.)

---

## 9. Context Memory Model

**Context Memory** is what ZAC remembers to understand the **person, role, and business**. It should **not store everything** — it should store **meaningful, structured context**.

### 9.1 Memory Types
`user_preference_memory` · `role_context_memory` · `business_goal_memory` · `location_context_memory` · `conversation_summary_memory` · `coaching_theme_memory` · `decision_memory` · `risk_memory`.

### 9.2 Example Context Memories

**Owner:**
- The owner wants to reduce colour waste this quarter.
- The owner cares most about rebooking and retail growth.
- The owner prefers direct but supportive business coaching.

**Manager:**
- The manager is focused on improving Friday utilisation.
- The manager is monitoring two stylists with declining rebooking.
- The manager prefers weekly operational summaries.

**Stylist:**
- The stylist is working on improving retail confidence.
- The stylist struggles with rebooking conversations.
- The stylist prefers short practical coaching prompts.

---

## 10. Context Memory Scope

Each memory should have a **scope**.

Recommended scopes: `private_user_memory` · `role_scoped_memory` · `business_shared_memory` · `location_scoped_memory` · `system_memory`.

**Rules:**
- Stylist private coaching memory should **not** be visible to owners by default, unless product policy says otherwise.
- Owner business memory **may** influence business-level recommendations.
- Location-scoped memory should **not** leak across locations unless the user has group-level permission.
- Memory should **always** include `business_id`.
- Memory should include `created_by` / `source`.
- Memory should be **deletable or reviewable** according to privacy policy.

> These mirror Day 1 §12D privacy boundaries and the proposed FORCE-RLS `zac` schema.

---

## 11. Outcome Memory Model

**Outcome Memory** records what actually happened after signals, recommendations, actions, or business changes. This is **different from Context Memory**.

| | Answers |
|---|---|
| **Context Memory** | What does ZAC know about this person/business? |
| **Outcome Memory** | What actually happened, and did it create value? |

---

## 12. Observed Outcomes vs ZAC Recommendations

ZAC should **measure business reality first**. Observed outcomes should be tracked **even when ZAC did not directly cause them**.

Three separate layers are required:

### 12.1 Observed Business Outcomes
Examples: client rebooked · retail product purchased · colour waste reduced · appointment recovered · utilisation improved · staff KPI improved · client returned · stock risk avoided · management time saved.

### 12.2 ZAC Recommendations
Examples:
- Recommend follow-up with clients who have not rebooked.
- Recommend retail product based on service/client history.
- Recommend reducing formula overmixing.
- Recommend adjusting rota coverage.
- Recommend reviewing underperforming utilisation.

### 12.3 Attribution / Influence
ZAC should classify whether he influenced the outcome. Attribution types:

- `direct_influence`
- `assisted_influence`
- `observed_positive_outcome`
- `recommendation_followed_no_positive_result`
- `recommendation_ignored_positive_outcome`
- `no_measurable_impact`
- `negative_or_unexpected_outcome`
- `unattributed`

> This prevents ZAC from becoming **self-validating**. The goal is **not** to prove ZAC was right — the goal is to **learn what actually improves the business**.

---

## 13. Recommendation Lifecycle

Every meaningful recommendation should follow this lifecycle:

1. Signal detected
2. Evidence collected
3. Recommendation candidate created
4. Permission check
5. Recommendation generated
6. Expected outcome defined
7. Recommendation shown
8. User response recorded
9. Measurement window opened
10. Business outcome observed
11. Attribution classified
12. Value estimated
13. Learning recorded

---

## 14. Recommendation Object

Recommended future structure (proposed; do not create now):

- `id`
- `business_id`
- `location_id` *(nullable)*
- `user_id`
- `role`
- `type`: `rebooking | retail | waste | utilisation | retention | coaching | stock | revenue | profit`
- `title`
- `recommendation`
- `why`
- `evidence`
- `expected_outcome`
- `metric_to_measure`
- `target_entity_type`
- `target_entity_id` *(nullable)*
- `confidence`: `high | medium | low`
- `status`: `created | shown | accepted | dismissed | ignored | expired`
- `measurement_window_days`
- `created_at`

> Extends the Day 2 §9 recommendation contract with lifecycle status + measurement window.

---

## 15. Outcome Object

Recommended future structure (proposed; do not create now):

- `id`
- `business_id`
- `recommendation_id` *(nullable)*
- `outcome_type`: `revenue | retail | rebooking | waste | utilisation | retention | training | time_saved | stock_saving`
- `target_entity_type`
- `target_entity_id` *(nullable)*
- `observed_value`
- `estimated_financial_value_cents`
- `confidence`: `high | medium | low`
- `attribution_type`
- `evidence`
- `observed_at`
- `notes`

> `recommendation_id` is nullable because observed outcomes are tracked even with no linked recommendation (§12).

---

## 16. Value Measurement Categories

Luke's requested measurable outcomes should become **first-class measurement categories**:

`revenue` · `profit` · `rebooking` · `retail` · `colour_waste` · `utilisation` · `client_retention` · `staff_development` · `time_saved` · `business_health` · `management_hours_saved` · `training_acceleration` · `subscription_roi`.

Each category should define:

- `metric_name`
- `source_data`
- `calculation_method`
- `confidence_level`
- `financial_value_method`
- `role_relevance`
- `available_in_phase_1`
- `limitations`

> **Data-readiness caveat (Day 1 §8, §15):** several source tables were empty in the inspected dataset (`retail_sales`, `location_fixed_costs`, `product_usage`, `waste_events`), so `available_in_phase_1` and `limitations` must honestly reflect which categories are measurable at launch versus blocked until capture begins.

---

## 17. Business Outcome Attribution

Outcome attribution should be **honest and confidence-based**.

### 17.1 Direct Influence
ZAC recommendation was accepted and linked to the outcome.
*Example:* ZAC recommended following up with Client A. Stylist followed up. Client booked within the measurement window.

### 17.2 Assisted Influence
ZAC supported decision-making, but the outcome had multiple causes.
*Example:* ZAC highlighted weak Saturday utilisation. Manager adjusted promotion manually. Bookings improved.

### 17.3 Observed Positive Outcome
Outcome happened even if the ZAC recommendation was ignored or unrelated.
*Example:* ZAC recommended retail focus. Stylist ignored the prompt. Client still purchased retail. ZAC records the retail improvement but does **not over-claim causation**.

### 17.4 Negative or Unexpected Outcome
Recommendation was followed but did not create the expected result.
*Example:* ZAC recommended a rota adjustment. Manager applied it. Utilisation did not improve. ZAC records the negative result and **lowers confidence in similar future recommendations**.

---

## 18. Privacy and Tenant Boundaries

Privacy remains **absolute**.

**Rules:**
- ZAC must **never** expose one salon's data to another salon.
- ZAC must **never** use one salon's raw data in another salon's recommendation.
- ZAC memory must **always** be business-scoped.
- ZAC cache keys must **always** be tenant-scoped.
- ZAC recommendations must **always** be permission-scoped.
- ZAC outcome learning must respect tenant isolation.

Future cross-salon learning, **if ever introduced**, must be: aggregated · anonymised · validated · privacy-safe · non-identifying · controlled by product policy.

> This is the hardest requirement given Day 1's finding that DB-level tenant isolation is dormant (RLS off on the live path). Per-tenant scoping and per-tenant cache keys are non-negotiable (Day 1 §12D, §18).

---

## 19. Proposed Future Tables

Day 3 recommends these future tables or equivalent structures (in the proposed FORCE-RLS `zac` schema):

- `zac.conversations`
- `zac.messages`
- `zac.memory`
- `zac.knowledge_documents`
- `zac.recommendations`
- `zac.recommendation_events`
- `zac.observed_outcomes`
- `zac.recommendation_outcomes`
- `zac.kpi_snapshots`
- `zac.cost_events`

> **These should not be implemented yet during Phase 0.** They are architectural recommendations for Phase 1 planning. (Refines the Day 1 §15 / Day 2 schema proposal by splitting `observed_outcomes` from `recommendation_outcomes` and adding `recommendation_events` + `cost_events`.)

---

## 20. Phase 1 Minimum Measurement Spine

Even though Phase 1 is read-only, ZAC should start recording:

- `conversation_started`
- `question_asked`
- `answer_delivered`
- `source_used`
- `recommendation_created`
- `recommendation_shown`
- `recommendation_accepted`
- `recommendation_dismissed`
- `recommendation_ignored`
- `kpi_snapshot_created`
- `observed_outcome_recorded`
- `cost_recorded`

> This makes later reporting possible. **Without this, ZAC's future value cannot be reconstructed accurately** (Day 1 §13, §15 — the single most important thing to get right early).

---

## 21. Example Phase 1 Use Cases

### Owner — *"What is the biggest risk in my business this week?"*
ZAC response should: check revenue · check utilisation · check rebooking · check colour waste · check staff performance · provide one or two evidence-based recommendations · record the recommendation · define expected outcome.

### Manager — *"What should I focus on tomorrow?"*
ZAC response should: check tomorrow's bookings · check utilisation gaps · check staff performance signals · check stock alerts · provide operational priorities · record recommendations.

### Stylist — *"How can I improve this week?"*
ZAC response should: check own KPI data · check rebooking performance · check retail performance · check colour usage where permitted · provide supportive coaching · define one measurable improvement goal.

---

## 22. Day 3 Open Decisions for Luke

1. Should ZAC call his recommendations "recommendations", "nudges", "coaching points", or another product term?
2. Should stylist coaching memory be private to the stylist, visible to managers, or partially visible to owners/managers?
3. Which outcome should be the first value-created headline: revenue, rebooking, retail, waste, utilisation, time saved, or overall business health?
4. How assertive should ZAC be when showing underperformance?
5. Should ZAC show confidence levels to users, or keep confidence internal?
6. Should owners be able to manually mark whether a ZAC recommendation helped?
7. Should "Value Created by ZAC" appear weekly, monthly, yearly, or all three?

---

## 23. Day 3 Open Decisions for Cosan

1. Should knowledge documents live in `zac.knowledge_documents`, storage + metadata, or both?
2. Should KPI snapshots live in `zac.kpi_snapshots` or the existing empty `analytics` schema?
3. Should recommendation and outcome events be separate from `audit.activity_log` to avoid high-volume audit noise?
4. Should ZAC tools call internal services directly or existing guarded controller/API equivalents?
5. Which report/KPI endpoints are stable enough for Phase 1 tool contracts?
6. Is a dedicated `zac.access` permission needed?
7. How should prompt, response, and memory PII be redacted in logs?
8. What is the preferred approach for periodic snapshot/reconciler jobs later?

---

## 24. Day 3 Conclusion

Day 3 establishes the **knowledge, tool, and memory foundation** for ZAC.

The key architecture decision is:

> **ZAC should measure business reality, not only his own acceptance rate.**

This means ZAC should track:
- context
- recommendations
- user response
- observed outcomes
- attribution confidence
- measurable value
- learning over time

This is how ZAC becomes different from a generic AI assistant. He does not only answer questions. He **understands the business, coaches the people inside it, observes what happens, and becomes better at helping the business improve.**

---

*Documentation only. Nothing in this file has been implemented. See [`phase-0-decision-log.md`](phase-0-decision-log.md) for tracked decisions and [`phase-0-future-integration-notes.md`](phase-0-future-integration-notes.md) for how a future team should bridge this design to the codebase when implementation is authorised.*
