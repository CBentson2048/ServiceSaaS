# Luke Ormsby Hair — Pay Template & Validation Cases

**Status:** Confirmed by Luke, 2026-07-27. These are the rules the Week 3 engine is built and tested against.
**Scope note:** LOH is *one configurable template*, not QLOOQO's default behaviour. Every value below is rule data.

---

## 1. Service commission — marginal bands

Confirmed: commission is **marginal**, never retroactive. Crossing a threshold must not re-price revenue below it.

| Band | From | Rate | Accelerator rate |
|---|---|---|---|
| 1 | 0 | 0% | — |
| 2 | 3× base pay | 10% | — |
| 3 | 3.5× base pay | 15% | **30%** |

The 30% **replaces** the 15% on the portion above 3.5× only. It never stacks and never reaches back over lower bands.

Stored as: `tier_semantics = 'marginal'`, `threshold_basis = 'multiple_of_base_pay'`, three rows in `payroll.pay_structure_bands`, with `accelerator_rate_percent = 30` on band 3.

**Worked example** — base pay £488.40, service revenue £1,800:

| | |
|---|---|
| 3× threshold | £1,465.20 |
| 3.5× threshold | £1,709.40 |
| Band 2: (£1,709.40 − £1,465.20) × 10% | £24.42 |
| Band 3: (£1,800 − £1,709.40) × 15% | £13.59 |
| **Total (accelerator not met)** | **£38.01** |
| Band 3 at 30% instead | £27.18 |
| **Total (accelerator met)** | **£51.60** |

> ⚠️ For contrast, the **current live** `kpi.calc.ts` applies 15% to the *whole* £1,800 = **£270** — roughly 7× the intended figure, and up to 14× when the accelerator fires. Luke has confirmed the live behaviour is not the intended model.

## 2. Accelerator — all three KPIs

Confirmed: **all three** conditions required. Miss any one and the normal 15% applies.

1. Rebooking ≥ 50%
2. Retail target achieved
3. Average bill ≥ individual benchmark

Stored as `evaluation_mode = 'all'` with three rows in `payroll.accelerator_conditions`.

**Other businesses** can configure `any`, `at_least_n` (e.g. any two of three, via `required_condition_count`), `weighted` (per-condition `weight` summed against `required_score`), or `custom`.

## 3. Retail

Confirmed for LOH:
- Retail target = **10% of the weekly Service Revenue Target**
- Retail commission = **10% of retail sales above that target**
- Retail target achievement is also accelerator condition #2

Stored as `threshold_basis = 'percent_of_service_target'` with bands using `from_percent` (0% → 0%, 10% → 10%).

**Worked example:**

| | |
|---|---|
| Weekly Service Revenue Target | £1,500 |
| Retail target (10%) | £150 |
| Actual retail sales | £220 |
| Retail above target | £70 |
| **Retail commission (10%)** | **£7.00** |

**Configurable elsewhere:** fixed amount (`absolute`), % of service revenue (`percent_of_service_revenue`), % of Service Revenue Target, per client (`per_client`), or no target at all (`absolute` with a zero threshold = commission on all retail). "Only above the target" versus "on everything" is the existing marginal/retroactive setting.

> Retail capture does not exist in QLOOQO yet — `billing.retail_sales` has no UI writing to it. Retail rules therefore render as **"source not captured"**, never as £0.

## 4. Service Revenue Target hours

Confirmed: the target is built from hours where the stylist is *reasonably available to produce salon revenue*.

| Category | Counts toward target | Payable |
|---|---|---|
| Worked | ✅ | ✅ |
| Additional worked | ✅ | ✅ |
| Manual adjustment | ✅ (only if authorised) | ✅ |
| Paid holiday | ❌ | ✅ |
| Training | ❌ (configurable) | ✅ |
| Sickness | ❌ | ❌ |
| Authorised absence | ❌ | ❌ |
| Unpaid leave | ❌ | ❌ |

The key principle: **paid holiday, sickness and authorised absence still create wage pay but must not raise the target.**

**Manual adjustments** require a reason, the actor, a timestamp, the original target and the adjusted target — all mandatory columns on `payroll.target_adjustments`, which is append-only. A correction means raising another adjustment, never editing one.

## 5. Example A1 — base wage plus commission

Additive; no greater-of comparison.

| | |
|---|---|
| Base pay (£12.21 × 40h) | £488.40 |
| Target (2.5× base) | £1,221.00 |
| Service commission — 30% of £579 above target | £173.70 |
| Retail commission — 10% of £180 | £18.00 |
| **Total gross pay** | **£680.10** |

## 6. Example A2 — guarantee or commission, whichever is higher

| | |
|---|---|
| Guaranteed minimum wage | £488.40 |
| Commission-only — **30% of all** £1,800 service revenue | £540.00 |
| **Higher of the two** | **£540.00** |
| Then add retail commission | on top |
| Then add tips / separately payable items | on top |
| Then apply configured lawful deductions | — |

Note A2's commission-only leg is **retroactive** (30% of everything), unlike LOH's marginal bands — both are expressible.

Stored via `in_greater_of_comparison`: the guarantee and the commission-only stage are `true`; retail is `false` so it is paid on top. A business that wants retail *inside* the comparison simply flips that flag.

## 7. Tips

Structural only. QLOOQO captures no tips today, so tips must not be relied on in the first live calculation. The settlement model splits `tips_paid_out_cents` (cash at the chair, direct card tips) from `tips_owed_cents` (terminal tips, pooled tips the salon still owes).

Future-facing but not built: cash vs card vs terminal tips, tips direct to stylist, tips split between people, team pools, already-paid vs still-owed.

## 8. Missing-source principle

Applies to every source, not just tips:

> If a configured rule depends on a source that is not captured, the engine warns clearly and never shows a misleading £0.
> *"This rule uses tips, but tips capture has not yet been enabled."*

Implemented as `payroll.business_data_sources` (per-business capture matrix), `payroll.missing_data_sources(version_id)` (activation warning), and `pay_summary_lines.source_unavailable` + `unavailable_source`, with a CHECK that forbids an unavailable line from carrying a figure.

Current capture state: service revenue ✅, product cost ✅ (actual QLAB usage), retail ❌, tips ❌, refunds ❌, cancellation fees ❌.

## 9. Terminology

**Service Revenue Target** throughout — never "Performance Target". Renamed across database, domain package and web UI in migration 0075.

## 10. Open architectural note

Luke asked for hour categories to be configurable at **business, location, role or individual** level. Current implementation is per pay-rule-version, which covers business-default and per-individual (via structure assignment). Location- and role-level overrides would need a small override table; the design does not preclude it, and it is deliberately deferred to keep Week 3 focused on payroll, commission and settlement outputs.
