# QLOOQO Financial Rules Engine — Design Principles

**Status:** Agreed with Luke, 2026-07-27. Binding on Week 3 and everything built on top of it.

Week 3 is the **first implementation of a reusable Financial Rules Engine**, not a payroll-only module. Payroll, commission and settlement are its first three outputs. The engine is the product; those outputs are what it currently produces.

That framing is deliberate, and it is a framing decision rather than a scope decision — see [Scope discipline](#scope-discipline) below.

---

## 1. QLOOQO Financial Rules Engine

Payroll, commission and settlements are **outputs of a reusable rules engine**, not bespoke calculators bolted to the staff record.

**What this means concretely:**

- A pay structure is an ordered pipeline of stages (`base_pay` → `commission` → `revenue_split` → `chair_rent` → `deduction` → `bonus` → `greater_of` → `tips_payout`), not a fixed structure type with hard-coded behaviour. Employed, self-employed, chair-renter and hybrid arrangements differ only in which stages are present and in what order.
- Every rate, threshold, basis and ordering is **rule data resolved by effective date**, never a constant in code. There is no default payroll philosophy anywhere in the engine.
- The calculation is a pure function of `(inputs, resolved rule versions, period)`. It performs no I/O, reads no clock, and uses no randomness — so the same inputs always produce the same output, and the same code path can later serve simulation without being rewritten.
- Nothing in the schema is named for payroll specifically where a more general name is accurate. `payroll.pay_structure_stages` describes a calculation pipeline; it is not tied to wages as a concept.

**Why it matters:** the expensive-to-change layer is the data model. Getting the engine boundary right once means later outputs are new *configurations and consumers*, not a second engine.

---

## 2. Explainability

**Every calculated figure must be explainable and drillable.** A number an owner cannot account for is a number they will not trust, and payroll only has to be wrong once.

Each of these must be independently visible on a statement, not just the final total:

| Component | Where it lives |
|---|---|
| Base pay | `pay_summaries.base_pay_cents` + `pay_summary_hours` |
| Hours used | `pay_summary_hours` — per category, with whether each counted |
| Service revenue | `pay_summaries.service_revenue_cents` + per-transaction lines |
| Target | derived, with `target_adjustments` recording any manual change |
| Commission bands | `pay_structure_bands` — each band's slice priced separately |
| Accelerator | `accelerators` + `accelerator_conditions`, with the substitute rate recorded |
| Retail | `pay_summaries.retail_revenue_cents` + its own commission stage |
| Deductions | `pay_summaries.deductions_cents` + per-deduction lines |
| Adjustments | `pay_adjustments`, carried in from an earlier locked period |
| Final total | `pay_summaries.net_payable_cents` |
| Source transactions | `pay_summary_lines.source_type` / `source_id` |

Two supporting rules:

- **Both sides of a comparison survive.** Where a greater-of applies, the losing figure is kept and the winner recorded (`greater_of_applied`, `greater_of_winner`). When base pay wins, that record doubles as the evidence a National Minimum Wage top-up was applied.
- **Every line carries the rule version that priced it** (`pay_summary_lines.structure_version_id`), because a mid-period rule change splits a period across two versions and the statement must show which applied where.

---

## 3. Source traceability

**Every figure traces back to a source record** — an appointment, a service, a payment, a retail transaction, an adjustment, or an explicit manual entry.

- `pay_summary_lines.source_type` and `source_id` identify the originating record; `occurred_on` carries the service date, which is also what determines the period and the rule version.
- Accrual is on **work performed**, not when cash moved. A service performed on the Saturday belongs to that week even if payment settles later.
- `pay_summaries.inputs_snapshot` preserves everything the engine consumed, so a statement can be re-derived and defended months later.
- A manual figure is never anonymous: `target_adjustments` requires the original value, the adjusted value, a reason, the person responsible and a timestamp, and is append-only.

---

## 4. Uncaptured data honesty

**The system must never silently show £0.00 when the data source is unavailable.** A zero means "nothing happened". An unavailable source means "we are not recording this". Conflating the two is how an owner ends up trusting a figure that was never calculated.

- `payroll.business_data_sources` records, per business, whether each source is genuinely captured.
- `pay_summary_lines.source_unavailable` and `unavailable_source` mark a line as not-captured, and a database CHECK forbids such a line from carrying a non-zero figure.
- `payroll.missing_data_sources(version_id)` reports every source a rule depends on that the business is not capturing, so the UI can warn at configuration time:

  > "This rule uses tips, but tips capture has not yet been enabled."

**Currently uncaptured:** tips (nothing anywhere), retail sales (table exists, no UI writes to it, staff attribution nullable), refunds of in-salon takings (payments are insert-only), and retained cancellation fees (a forfeited deposit is never recorded as a fee). **Captured:** service revenue, and actual QLAB product cost.

This principle is general. It applies to any future source, not just the four above.

---

## 5. Netted settlement statement

The settlement output is a **statement of whose money is whose**, not merely a pay figure. For a chair renter taking payments through the salon till, the salon is *holding* money that belongs to the stylist — that is a liability, not salon revenue.

The statement shows:

- **Total collected** — cash flow through the salon for that stylist's work
- **Money belonging to the stylist** — their share under the agreed split
- **Money belonging to the business** — `business_retained_cents`
- **Rent** — `chair_rent_cents`, whether fixed, percentage or hybrid
- **Deductions** — agreed and itemised
- **Bonuses** — `bonus_cents`
- **Final amount payable** — `net_payable_cents`, signed, so a negative figure correctly means the stylist owes the business
- **Full source traceability** — every line drillable per §3

**Cross-week consequence to honour:** for self-employed staff, only the salon's share is business revenue. The stylist's share must not appear as salon income in the Week 7 P&L.

The competitor review found this statement is genuine market white space — most platforms route payments away rather than reconcile them, and only one bills rent at all.

---

## 6. Product philosophy

> **QLOOQO does not ask businesses to adapt to the software. The software adapts to the business.**

Applied as an engineering test rather than a slogan: if a salon's real arrangement cannot be expressed as configuration, that is an engine defect, not an unusual customer.

This is why the four reference models Luke supplied are **test fixtures proving flexibility**, not defaults. The Luke Ormsby Hair model is one saved template among many, and holds no privileged position in the code.

---

## Scope discipline

The engine framing must not become a licence to widen Week 3. Week 3 delivers, in the agreed priority order:

1. Accurate configurable calculations
2. Versioned rules with effective dates
3. Transparent calculation breakdowns
4. Source transaction drill-down
5. Approval workflow (Draft → Ready for Review → Approved → Locked → Paid)
6. Permissions (View, Approve, Edit, Lock, Export, Email)
7. Historical integrity
8. Payroll, commission and settlement as the first outputs

**Explicitly not in Week 3, and not to be started:** loyalty, memberships, QPAY, referral rewards, franchise royalties, marketplace commissions, cashback, and any generic no-code rules platform. Simulation is design-ready only — no screens, no workflow.

The architecture must not *prevent* those outputs. It must not *anticipate* them either: no speculative tables, no unused abstraction layers. Future-compatible means the engine boundary is clean, not that future features are half-built.

---

## Deferred, with reasons

| Item | Status |
|---|---|
| Hour-category overrides at location and role level | Follow-up ticket. Week 3 supports business-level defaults and individual assignment; the rule-version snapshot means adding override layers later cannot disturb historical summaries. |
| Tips capture and allocation | Structural only. Cash, card, terminal, direct-to-stylist, split, pooled, already-paid and still-owed are all anticipated in the settlement shape; `tips_paid_out_cents` and `tips_owed_cents` exist. No capture, so rules render as unavailable per §4. |
| Retail, refund/void and cancellation-fee capture | Separate tickets, in Luke's stated priority order (retail first). |
| Employer cost layer (NI, pension, total cost to business) | Reporting layer, later. Deliberately outside the employee's gross-pay calculation. |
| PDF, CSV and email | Next phase, per the agreed priority order. |
