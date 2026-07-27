# Salon Payroll, Commission & Settlement — Competitor Review

**Prepared for:** Luke Ormsby
**Scope:** How eleven leading salon platforms handle staff pay, commission, chair rental and settlement
**Method:** Official documentation and help centres for each platform, reviewed independently, then compared
**Purpose:** Not to copy anyone — to confirm we are not missing real-world scenarios, and to identify where QLOOQO can lead

---

## 1. What each competitor supports

**Phorest** — Commission as a reporting layer. Named tiered levels assigned per staff member, a toggle for whether product cost is deducted before or after commission, and staff goals for tracking. Self-employed stylists are handled by routing their card takings straight to their own merchant account. Commission on courses accrues when the session is performed, not when sold.

**Fresha** — The most complete pay-run product outside the US. Their Team Pay add-on runs approved, irreversible pay runs funded from a wallet. Tiers can be Progressive or Retroactive with their own accumulation window. Notably, they model a "cash advance": cash a stylist pockets at the till is treated as an early payout, producing an explicit Earnings / Paid / To-pay statement with a stylist-owes-salon balance.

**Timely** — Effectively nothing. Their official guidance is to export a CSV and calculate commission in a spreadsheet. Their higher plan offers targets expressed per rostered hour, and self-employed contractors are handled with permission flags rather than pay logic.

**Vagaro** — The deepest US stack. Revenue tiers, a "only pay whichever is larger" toggle between wage and commission, business-cost deductions with a floor so commission can never go negative, and — uniquely — a genuine rent-collection engine with scheduled charges, failed-payment retries, and the ability to offset a renter's earned commission against the rent they owe.

**Boulevard** — Effective-dated pay rates, retroactive tiers, and per-service, per-location "Business Service Charges" for backbar. Multi-Merchant splits a client's payment between the salon and an independent renter at the moment of capture. Every timecard edit requires a reason, which surfaces in a report.

**Mangomint** — Gives the calculation engine away free and charges only for moving money. Zero-based versus Progressive tiers, a greater-of comparison configurable at daily or period granularity, and backbar deduction as either a flat amount or a percentage, before or after commission.

**SalonIQ** — The closest UK analogue and the most directly relevant. Per-member banded commission tables with a "Linear bands" toggle for marginal versus retroactive, a per-member setting for whether VAT is included in the commission base, and a per-service flat default deduction. Their report deliberately ends at "Total Pay before tax, NI & pension".

**Shortcuts** — Their Extended Commissions report offers Target versus Cumulative banding, a "Fallback Wage" greater-of guarantee, and unusually rich cost controls (per-service percentage or fixed, per-bill fees, markup basis).

**Kitomba** — Commission Groups containing tiered Plans. Their standout feature is approval-snapshot timesheets: once hours are approved they are frozen, so a later roster edit cannot silently change a historical pay figure. Each plan maps to an external payroll pay code so commission itemises correctly on a payslip.

**Rosy** — Effective-dated commission scales where backdating a change requires explicit acknowledgement. A Product Charge with a before/after toggle applied at report time, and a House Fee with per-ticket split logic. Their BoothRunner product makes each renter a separate linked business.

**Meevo** — The deepest engine overall. A first-class "commissionable amount" concept distinct from the register price, three pay modes including an auditable greater-of that shows which side won, and a period lifecycle of Current → Previous → Archived with Conflict flags raised when an upstream edit invalidates a computed period.

---

## 2. What they do not support

This section matters more than the first, because it shows where the market genuinely stops.

**Almost nobody bills chair rent.** Only Vagaro has a real rent-collection engine. Mangomint improvises by repurposing its membership billing. Meevo treats booth rent as a flat deduction at the end of payroll. **Phorest, Fresha, Timely, Boulevard, SalonIQ, Shortcuts, Kitomba and Rosy have nothing at all.**

**Nobody produces a proper netted settlement statement.** The industry solves self-employed staff by *routing payments away* — the renter's card takings go to their own merchant account, so no reconciliation is ever needed. That is elegant until reality intrudes: cash, split tender, refunds, gift cards, deposits and voucher redemptions all leak back to the salon and have to be settled manually.

**No non-US platform does statutory payroll.** Every UK, Australian and New Zealand product stops at a gross figure handed to an external payroll provider. Actual money movement and tax filing exist only in US-centric products (Vagaro, Fresha, Mangomint, and Meevo via ADP).

**Locking is inconsistent.** Fresha and Meevo have proper period lifecycles. Boulevard deliberately has no locking at all. Shortcuts produces a PDF and nothing else. Timely is the cautionary tale: editing a roster silently rewrites historical timesheets.

**Tips are largely excluded from payroll entirely**, and targets are almost universally tracking-only — no platform pays a bonus automatically for hitting a target. Tier thresholds are the only place a target actually affects pay.

---

## 3. Common industry patterns

Ten of the eleven have tiered commission keyed to revenue thresholds; only Timely has no engine at all.

Six platforms expose **marginal versus retroactive** as an explicit named setting — Phorest, Fresha, Mangomint, SalonIQ, Shortcuts and Meevo. This is the single most repeated design decision in the market, and it is precisely the discrepancy we found in QLOOQO's existing calculation.

Other recurring patterns: separate service and retail commission streams, configurable per person; backbar or product-cost deduction with a before/after ordering choice; commission accruing when the work is performed rather than when cash arrives; a greater-of guarantee between wage and commission (Vagaro, Mangomint, Shortcuts, Meevo); granular pay permissions with self-only scoping so a stylist sees only their own figures; and PDF/CSV export with email delivery as standard.

---

## 4. Workflows worth learning from

**Kitomba's approval-snapshot timesheets.** Approved hours freeze against later roster edits. This is the clean answer to a problem every salon has, and it is exactly the opposite of Timely's silent-rewrite behaviour.

**Meevo's Conflict flags.** When a transaction is edited after a period was calculated, the period is flagged rather than silently recalculated. A human decides what to do. We have adopted this as our stale-flag plus carry-forward adjustment model.

**Meevo's auditable greater-of.** The report prints which side of the wage-versus-commission comparison won. It turns an unexplained number into a defensible one — and when the wage side wins, it is also the evidence that a National Minimum Wage top-up was applied.

**Rosy's forced backdate acknowledgement.** Changing a commission scale retroactively is possible but requires the user to confirm they understand the consequence. Friction in exactly the right place.

**Boulevard's mandatory edit reasons.** Every timecard change carries a reason that appears in a report — accountability without a heavyweight approval chain.

**The anti-pattern to design against:** Meevo's recalculation always uses the *latest* settings, so giving someone a pay rise retroactively re-prices their history. Their own documentation warns about it. This is why your effective-dating requirement is load-bearing rather than a nice-to-have, and QLOOQO now prevents it structurally — once a rule version has been used to calculate pay, the database physically refuses to let it change.

---

## 5. The gaps QLOOQO can own

**A genuine netted settlement statement.** This is the clear white space. The market either routes payments away or ignores the problem. A statement that shows total collected, what belongs to the stylist, what belongs to the business, deductions, rent owed, and a single net figure — with every line traceable to a transaction — is something no reviewed competitor produces.

**Chair rent modelled properly rather than as an afterthought.** Fixed rent, percentage split, reduced rent plus split, and the self-employed stylist who takes their own payments and uses QLOOQO only for bookings. One competitor bills rent at all; none model the range.

**Actual colour cost from QLAB.** Every platform reviewed uses a flat or percentage deduction for backbar. QLOOQO already captures the real product cost per visit, which means a deduction based on what was genuinely used is achievable — and it is a direct extension of the colour moat rather than a new product.

**Honesty about uncaptured data.** No competitor distinguishes "nothing happened" from "we are not recording this". A statement that says "retail commission — retail capture not yet enabled" rather than showing £0.00 is a small thing that builds significant trust with an owner.

**Configurability without bespoke work.** Most engines are configurable within a fixed shape. The ordered-stage model we are building lets a salon compose base pay, commission, split, rent, deductions and bonus in whatever order their business actually works — which is the substance of "adapt to the business, not the reverse".

---

## 6. Risks and complexities before positioning this commercially

**Payroll accuracy is reputational, not just technical.** Every platform that has moved into pay has had to build lifecycle, locking and audit before it was safe. If a figure is wrong once, owners stop trusting the whole product. This is why we are prioritising correctness and drill-down over exports.

**We compute gross pay — that boundary must be explicit in marketing.** No comparable UK platform performs statutory payroll, and we should not imply otherwise. SalonIQ's framing is the right one: "Total pay before tax, National Insurance and pension." Anything more is a regulated space with real liability.

**Employment status is a legal question we must not appear to answer.** Self-employed and chair-renter arrangements carry genuine HMRC risk around employment status. QLOOQO should model whatever arrangement a salon has agreed; it must never look like advice on whether that arrangement is correct. Worth a short disclaimer on settlement statements.

**Settlement without payment routing has an operational gap.** Competitors route payments so the money never mixes. We produce a statement instead, which is more flexible and more transparent — but the salon still physically holds the stylist's money until they pay it over. That is a real-world cash-flow responsibility and should be described honestly.

**Data capture is the current constraint, not the engine.** Retail, tips, refunds of in-salon takings, and retained cancellation fees are not captured today. The engine supports all four, but the features cannot be sold until the capture work lands. Retail is the most urgent, since retail commission is part of the initial model.

**Configurability has a support cost.** The most flexible engine in the market is also the easiest to misconfigure. Sensible presets, worked examples, and the activation warnings we are building are what keep that flexibility from becoming a support burden.

**Minimum wage compliance is a feature, not just arithmetic.** The greater-of model is how salons stay NMW-compliant, and rates change every April. Because our rules are effective-dated, an annual rate change is a new rule version rather than a rewrite of history — worth stating plainly, because it is genuinely useful to an owner.

---

## Sources

Phorest · Fresha · Timely · Vagaro · Boulevard · Mangomint · SalonIQ · Shortcuts · Kitomba · Rosy · Meevo — official support and documentation sites, reviewed July 2026. Full URLs held with the research notes and available on request.
