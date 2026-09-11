# ZAC Phase 2 — Workstream 3 (QLab & Stock) — Data Evidence & Scope Trace

> **Nature of this document.** The W1 evidence pass for Workstream 3: *measure the data before designing a
> figure*. Every default window, sample floor and `MAX_*` cap used by the WS3 tools is set here from observed
> data rather than guessed. Analysis only — no source file, migration, env or package is changed by this
> subtask.
>
> **Database:** Supabase project **`iqgryrczkvjkcbrgfsdl`** (the `dev-test` branch). This is the working
> database. The parent project `cdjtsqcrcgywjdwvbxyf` is **stale at migration `0045`** — it has no
> `inventory.suppliers`, no `inventory.purchase_orders` and no `zac` schema at all — and must not be used to
> judge data readiness.
>
> **Date of pass:** 2026-09-11. All "days ago" figures are relative to that date.

---

## 0. Scope trace — what Workstream 3 is, and which document says so

`docs/ZAC/README.md:10-13` fixes precedence: **`ZAC_Phase_2_Incremental_Plan_UPDATED.pdf` is authoritative**;
`ZAC_Phase_2_Client_Review_Plan.pdf` is the earlier draft it supersedes and "must not be used to judge scope".
The README also records that the draft's workstream **numbering differs** — *its* "Workstream 1" is the updated
plan's Workstream 2 — and that this has already caused one incorrect progress assessment.

Applying that mapping to the work in hand:

| | Draft (Client Review Plan) | UPDATED plan (authoritative) | Status |
|---|---|---|---|
| Expanded QLOOQO 10 / cross-domain | Workstream 1 | **Workstream 2** | Complete (commit `76ba0c2`) |
| **QLab & Stock** | Workstream 2 | **Workstream 3** | **This workstream — 46h** |

**The authoritative WS3 line**, verbatim from the UPDATED plan's workstream reconciliation table:

> **3. QLab & stock intelligence** — *Phase 1 foundation already delivered:* "Permission-aware tool registry,
> evidence/grounding and measurement spine; QLab/stock left as deferred skeletons in Phase 1."
> *Incremental Phase 2 development:* "**Colour/waste/margin analytics; stock risk, shortage and dead-stock
> intelligence; planned appointment/stock correlation; production-safe permissions and tests.**" — **46 h**

### 0.1 Recorded scope deltas

**Delta 1 — reorder advisory.** The authoritative WS3 line does **not** contain the word "reorder". The
superseded draft did (*"stock risk, shortages and reorder recommendations, advisory only"*), and its week-3
demo outcome named "order-recommendation context". A strict reading of the authoritative plan excludes it.

> **Decision (client, 2026-09-11): INCLUDE, sequenced last** as subtasks W9–W10 (~6 h), so it is the
> designated cut line if hours run over. Delivered as a new **read-only** `OrdersService.previewReorder()`
> gated on `orders.view`, reusing `reorder-math.ts` verbatim. No write, no new permission key, no migration.

**Delta 2 — intelligence-framework metric registration.** `phase-2-intelligence-signal-framework.md:940`
assigns "QLAB and stock metrics + evaluators" to **Workstream 3**, qualified *"(probe-gated on V1.1
stability)"*. This pass is that probe, and it returns a negative — see §7. WS3 therefore registers **no**
metric and publishes the criterion-by-criterion assessment instead (subtask W15).

> **Decision (client, 2026-09-11):** confirmed — register no metric.

### 0.2 Clause-to-subtask map

| Authoritative clause | Tool | Guarded method it reads | Subtask |
|---|---|---|---|
| Colour / waste / margin analytics | `qlab.colour_analytics` | `LabAnalyticsService.summary` | W5 |
| Stock risk, shortage, dead-stock intelligence | `inventory.stock_status` | `InventoryService.listStock` / `listDeadStock` / `listLowStock` | W6 |
| Planned appointment / stock correlation | `inventory.colour_prep_risk` | `ColourPrepService.getPlan` | W7 |
| Production-safe permissions **and tests** | — | — | W3, W13, W14 |
| *(delta 1)* order-recommendation context | `inventory.reorder_advisory` | `OrdersService.previewReorder` (new) | W9–W10 |

---

## 1. Headline: the platform is ready, the data is thin, and the thinness is the finding

`docs/ZAC/phase-1-qlab-stock-feasibility-report.md` concluded in July 2026 that there is **"no `supplier`,
`purchase_order`, `reorder`, `lead_time`, `expiry`, `shelf_life`, or `forecast` entity anywhere"** and that
QLOOQO has "a colour + stock-deduction model, not a purchasing/forecasting model".

**That conclusion is now obsolete.** Migrations `0091` (stock + colour prep), `0092` (suppliers + ordering
metadata), `0093` (dead-stock alerts), `0094` (purchase orders + `inventory.reorder_usage`), `0095`, `0096`,
`0100` (two-step ordering) and `0101` (dead-stock category threshold) have all shipped and are applied here.
Suppliers, lead times, purchase orders, reorder maths and a dead-stock report all exist.

The report's **safety doctrine still stands in full** and WS3 is bound by it: feasibility-probe every tool,
never read the write-only `waste_events` table, re-check each permission inside each tool, and never report a
zero confidently.

**What has *not* arrived is data.** Of 11 businesses, exactly **two** have any saved colour formula and
exactly **one** has meaningful stock. Every headline percentage WS3 could compute is either empty, stale, or
an artefact of configuration. That is why the coverage/probe layer (W4) is built before any tool (W5+).

---

## 2. Tenancy overview

```sql
select b.id, b.name, count(distinct l.id) as locations
from core.businesses b left join core.locations l on l.business_id = b.id
group by 1,2 order by 3 desc;
```

11 businesses. Only two carry QLab/stock data:

| Business | id | Locations | Colour? | Stock? |
|---|---|---|---|---|
| **Salon** | `b793790e-146f-488b-be86-c6f0abf6f1bd` | 5 (BBB, Kensington, Pinner, Primrose Hill, Thame) | ✅ real, costed | ✅ 10 rows / 4 locations |
| **AndrewHair** | `0aec9f31-f62e-49ba-a27f-fc680d010654` | 1 (Location A - Andrew) | ⚠ 4 zero-cost seed rows | ❌ none |
| *other 9* | — | 1 each | ❌ | ❌ |

Every other business returns **nothing** from every WS3 tool. This is the normal case, not the edge case, and
it is why "not configured" must be a first-class answer rather than a zero.

---

## 3. Colour (QLab) — `qlab.colour_analytics`

### 3.1 Formulas by business and status

```sql
select business_id, status, count(*) n, min(saved_at)::date, max(saved_at)::date,
       sum(actual_cost_cents), sum(waste_cost_cents), sum(billable_charge_cents)
from lab.formulas group by 1,2;
```

| Business | Status | n | First | Last | Cost | Waste | Charge |
|---|---|---|---|---|---|---|---|
| AndrewHair | saved | 4 | 2026-06-16 | **2026-09-08** | 0 | 0 | 0 |
| Salon | saved | 5 | 2026-06-15 | **2026-07-21** | 10 551 | **0** | 12 662 |
| Salon | draft | 1 | 2026-07-22 | 2026-07-22 | 1 125 | 0 | 1 350 |

### 3.2 Margin per location — saved formulas only

| Business | Location | n | Cost | Charge | **Margin** |
|---|---|---|---|---|---|
| Salon | **Kensington** | 5 | £105.51 | £126.62 | **16.7 %** |
| AndrewHair | Location A - Andrew | 4 | £0.00 | £0.00 | **undefined** (zero denominator) |

> **Correction to an earlier working assumption.** Colour margin at Kensington is **16.7 %, not 0 %**, and
> AndrewHair's is **undefined**, not 0 %. There is no "charge equals cost" billing configuration here. The
> `ZacCoverageReading` union must therefore distinguish *measured 16.7 %* from *zero-denominator* — rendering
> AndrewHair as "0 % margin" would be a fabricated trading result.

### 3.3 Waste is never captured — verified at line level

```sql
select count(*) items, count(*) filter (where waste_grams > 0), count(*) filter (where waste_cost_cents > 0),
       count(*) filter (where product_id is null), sum(captured_grams)
from lab.formula_items;
```

| Items | `waste_grams > 0` | `waste_cost_cents > 0` | Unmapped product | Total captured |
|---|---|---|---|---|
| 20 | **0** | **0** | **0** | 1 079.5 g |

`inventory.waste_events` holds **0 rows** (and is write-only — never SELECTed anywhere; forbidden to WS3).

**Consequence for W5.** Colour waste has **no surviving numerator anywhere in the platform**. The tool must
say *"waste is not being captured when formulas are saved"* and **suppress the waste percentage entirely**.
Rendering "0 % waste" would tell an owner they have a perfect colour bar.

Separately, all 20 formula items **are** mapped to a catalogue product — so colour-prep's `unmapped_product`
state is currently unexercised by real data and must still be handled (§5).

### 3.4 Evidenced defaults for W5

| Setting | Value | Evidence |
|---|---|---|
| Default window | **90 days** | Newest Salon formula is 2026-07-21 = **52 days ago**. A 30-day default returns nothing on the only tenant with costed colour. |
| Window cap | **366 days** | `fetchFormulas` has no `.limit()`; an unbounded window is an unbounded read. |
| Baseline probe window | **365 days** | Answers "has this salon *ever* mixed a formula / ever recorded waste", so an empty window is reported as staleness, not absence. |
| Range argument | **always explicit `custom` + from/to** | The service's presets resolve in the **API host's local timezone**; ZAC works in UTC. Passing a preset would silently shift the window. |
| `byStylist` | **never read** | See §8. |

---

## 4. Stock — `inventory.stock_status`

### 4.1 Product catalogue coverage

| Business | Products | Active | Has cost | Has supplier | Has pack | `dead_stock_days` override | MOQ ≠ 1 | Multiple ≠ 1 | Units |
|---|---|---|---|---|---|---|---|---|---|
| Salon | 6 | 6 | **6** | **2** | 6 | 0 | 0 | 0 | `gram` |
| AndrewHair | 4 | 4 | **0** | **0** | 0 | 0 | 0 | 0 | `gram` |

**8 of 10 products have no supplier attached** — which is itself the actionable finding for W10, not a defect
in the tool. **No product overrides `dead_stock_days`**, and **no product changes MOQ or order multiple from
1**, so those rounding steps must only be cited when they actually altered a number.

Every product is `stock_unit = 'gram'`, so the unit-formatting path is real but currently untested by data —
quantities must still render through `formatStockQuantity(value, stockUnit)`, never by appending `g` to a
column named `*_grams`.

### 4.2 Shelf state, live low stock, and the split-brain

| Location | Rows | Active | Thresholds set | **Live low** | Zero on hand |
|---|---|---|---|---|---|
| BBB | 1 | 1 | 1 | **1** | 1 |
| Kensington | 6 | 6 | 6 | 0 | 0 |
| Pinner | 2 | 2 | 2 | **1** | 0 |
| Primrose Hill | 1 | 1 | 1 | **1** | 1 |

`inventory.low_stock_alerts`: **2 open**, 5 resolved.

> **Split-brain confirmed: 3 live-low rows vs 2 open alerts.** The materialised cache is maintained only by
> `adjust_location_stock` and `updateStockThreshold`; `initializeStock` and `setProductAvailability` write
> thresholds without touching it.
>
> **W6 rule:** `listStock({lowStockOnly: true})` — the live computation — is **authoritative**.
> `listLowStock` is read for **reconciliation only**, and a divergence is *reported*, never silently
> reconciled. Repairing the cache is an inventory-module write and is out of WS3 scope.

### 4.3 Dead stock — `inventory.dead_stock_report`

All six Kensington shelf rows classify as dead. No other location returns a row.

| Product | On hand | Last outbound | Days idle | Threshold | Source |
|---|---|---|---|---|---|
| SoColor 8N Light Blonde | 1 000 g | 2026-06-28 | 74 | 30 | `location_default` |
| No.2 Bond Perfector | 330 g | 2026-06-28 | 74 | 30 | `location_default` |
| Koleston Perfect 7/0 | 367.5 g | 2026-07-21 | 51 | 30 | `location_default` |
| Igora Royal 5-0 | 307.5 g | 2026-07-21 | 51 | 30 | `location_default` |
| Shades EQ 09V | 277.5 g | 2026-07-21 | 51 | 30 | `location_default` |
| Majirel 6.0 Dark Blonde | 319 g | 2026-08-04 | 38 | 30 | `location_default` |

### 4.4 Location settings

| Location | `dead_stock_days_default` | `reorder_usage_window_weeks` | `reorder_coverage_weeks` | `waste_allowance_percent` |
|---|---|---|---|---|
| **Kensington** | **30** | 8 | 4 | 10.00 |
| BBB, Pinner, Primrose Hill, Thame | 90 | 8 | 4 | 10.00 |

> **Correction to an earlier working assumption.** Kensington's 30-day threshold is **deliberately tuned**,
> not an untouched platform default (which is 90). So "6 of 6 products are dead" is *not* "nobody configured
> this" — it is "this location chose an aggressive threshold, and against a colour-restock cadence of 6–8
> weeks that threshold flags essentially the whole shelf".
>
> **W6 rule:** report `threshold_source` and the threshold value alongside every dead-stock claim, so the
> owner can see the verdict is a function of a setting they control.

### 4.5 Ledger recency — the single most important honesty input

| Location | Last stock movement | Movements |
|---|---|---|
| Kensington | **2026-08-26** (16 days ago) | 97 |
| Pinner | **2026-08-26** (16 days ago) | 2 |

Movement mix across the whole database: `formula_usage` 48, `formula_reversal` 34, `opening_balance` 8,
`restock` 6, `retail_sale` 1, `formula_waste` 1, `manual_adjustment` 1.

**W6 rule:** ledger recency **prefixes** every dead-stock and shortage claim. "Six of six products idle" is
only meaningful beside "your stock ledger's newest entry is 2026-08-26".

### 4.6 Evidenced defaults for W6

| Setting | Value | Evidence |
|---|---|---|
| Shape | **point-in-time, not period-aware** | Shelf state is *now*; it is not in `PERIOD_AWARE_TOOLS` and says it describes today. |
| `MAX_DEAD_STOCK_ROWS` | **25** | 6 live rows; 25 leaves headroom while bounding the payload. Exact hits reported as a lower bound with confidence downgraded. |
| Cost-coverage floor for money totals | **50 %** | 6/10 products carry a cost; a cost-less product silently sums as zero. Below 50 %, omit the total. |
| Zero-threshold semantics | **`0` = never-low** | Not "always low". Zero configured thresholds ⇒ "I cannot tell you what is running low". |

---

## 5. Planned appointment / stock correlation — `inventory.colour_prep_risk`

`ColourPrepService.getPlan` already implements the full walk (`booking.appointments` →
`service_categories.billing_category` → latest saved `lab.formulas` → `formula_items` →
`inventory.location_stock`) and is exported by `ColourPrepModule`. **WS3 wraps it; it does not rebuild it.**

### 5.1 The live forward book (next 21 days, preparable statuses only)

| Date | Location | Service | Billing category | Client's saved formulas | Expected state |
|---|---|---|---|---|---|
| **2026-09-15** | Location A - Andrew | Full Head Colour | `permanent_colour` | **0** | `no_formula_on_file` |
| **2026-09-17** | Kensington | Full Head Colour | `permanent_colour` | 2 | `formula_on_file` |
| **2026-09-24** | Kensington | Root Colour | `permanent_colour` | 2 | `formula_on_file` |

Both the populated path **and** the honest "I cannot assess this one" path are exercisable against live data
today. The Kensington 2026-09-17 appointment resolves to real product requirements against real shelf stock.

### 5.2 The window default — a correction

`resolveColourPrepWindow` (`apps/api/src/colour-prep/date-range.ts:118-141`) makes `this_week` and `next_week`
**Monday-based calendar weeks**.

2026-09-11 is a **Friday**, so:

- `today` → 2026-09-11 → **catches nothing**
- `this_week` → Mon 2026-09-07 … Sun 2026-09-13 → **catches nothing**
- `next_week` → Mon 2026-09-14 … Sun 2026-09-20 → catches 09-15 and 09-17

> **A calendar-week preset is the wrong default for this tool.** "What colour work is coming up and am I
> short?" asked on a Friday afternoon should not answer for a week that is nearly over, and should not
> silently skip Monday because the caller asked on Sunday.
>
> **W7 rule:** default to an explicit **`range: 'custom'` rolling 14-day window** from today. The plan returns
> `fromDate`, `toDate` and `timezone`, and the tool **states the window it actually covered**, so the
> at-most-one-day timezone boundary discrepancy is disclosed rather than hidden. On today's data a 14-day
> rolling window catches the 09-15 and 09-17 appointments.

### 5.3 Honesty rules for W7

- `appointmentsWithoutFormula > 0` ⇒ those clients contribute **zero** required grams, so every shortfall
  figure is a **lower bound**. The tool may say "you are short of X" but is **forbidden** from any
  sufficiency claim ("you have enough") while that count is non-zero. Asserted by a negative regex in W13.
- `not_stocked` and `unmapped_product` mean *"I could not tell"* — reported on their own line, never folded
  into a verdict, never rendered as zero on hand.
- `wasteAllowancePercent` (10.00 at every location) is a **planning uplift**, explicitly **not** measured
  historical waste — which, per §3.3, is zero everywhere.
- Zero colour appointments ⇒ `status: 'ok'`, `rowCount: 0`, `responseType: 'Explanation'`. On a quiet forward
  book that is a **true answer**, not a failure.
- `plan.appointments` is **never read** — `ColourPrepAppointment.clientName` is a full client name (§8).

---

## 6. Reorder — `OrdersService.previewReorder` + `inventory.reorder_advisory`

### 6.1 There is no pure read path today

`OrdersService.generate()` (`apps/api/src/orders/orders.service.ts:135`) is the **only** implementation of the
suggestion algorithm. It asserts `orders.manage`, computes every line (`:138-238`), then unconditionally calls
`rpc('create_purchase_order')` per supplier — allocating a gapless PO number — and writes a
`purchase_order.created` audit row. There is no `dryRun` flag, and `reorder-math.ts` has no caller outside
`generate()` and its own spec.

**W9 approach:** extract `:138-238` into a private `computeReorderSuggestions(businessId, locationId)` that
**both** `generate()` and a new `previewReorder(actor, locationId)` call — one arithmetic implementation, the
only difference being the write loop. `previewReorder` asserts **`orders.view`**, then `assertLocationScope`.

A `dryRun` boolean on a write-named method is **explicitly rejected**: it is one default-argument change from
ZAC creating real purchase orders.

### 6.2 Simulated suggestions at the configured 8-week / 4-week settings

`shortfall = max(0, (outbound_8w / 8) × 4 + threshold − on_hand)`

| Location | Product | On hand | Threshold | **Outbound 8w** | Shortfall | Pack | Supplier? | Outcome |
|---|---|---|---|---|---|---|---|---|
| Pinner | SoColor 8N | 50 | 150 | **0** | 100 | 90 | ✅ Wella | **2 packs** |
| Primrose Hill | Majirel 6.0 | 0 | 100 | **0** | 100 | 50 | ✅ Wella | **2 packs** |
| BBB | Shades EQ 09V | 0 | 20 | **0** | 20 | 60 | ❌ | **unorderable — `no_supplier`** |
| Kensington | Igora Royal 5-0 | 307.5 | 20 | 132.5 | 0 | 60 | ❌ | none needed |
| Kensington | Koleston Perfect 7/0 | 367.5 | 20 | 132.5 | 0 | 60 | ❌ | none needed |
| Kensington | Majirel 6.0 | 319 | 20 | 150 | 0 | 50 | ✅ | none needed |
| Kensington | Shades EQ 09V | 277.5 | 30 | 132.5 | 0 | 60 | ❌ | none needed |
| Kensington | No.2 Bond Perfector | 330 | 40 | 0 | 0 | 525 | ❌ | none needed |
| Kensington | SoColor 8N | 1 000 | 15 | 0 | 0 | 90 | ✅ | none needed |
| Pinner | Majirel 6.0 | 200 | 100 | 0 | 0 | 50 | ✅ | none needed |

> **Every single shortfall has `outbound_8w = 0`.** All three are pure **threshold top-ups**, with *no*
> recorded usage behind them. Meanwhile the location with real usage (Kensington, 132.5–150 g) has **no**
> shortfall at all.
>
> **W10 rule:** `previewReorder` returns `usageObserved`. When false, the answer must read *"this is a top-up
> to your low-stock threshold; there was no recorded usage in the 8-week window"* — **never** "based on your
> usage". On today's data that flag is false for every suggestion.

Two further limitations to state in the answer:

- `inventory.reorder_usage` sums **only negative** movements, so the 34 `formula_reversal` rows are **not**
  netted out. The figure is "what was deducted from stock", not "what was consumed".
- The supplier's `lead_time_days` (Wella Professionals = 3) is **never read by the algorithm**. It may be
  offered as separate context; ZAC must never imply the suggestion accounted for it.

### 6.3 Existing purchase orders

| PO | Status | Location | Subtotal | Created | Sent |
|---|---|---|---|---|---|
| PO-00001 | `sent` | Pinner | £23.40 | 2026-08-29 | 2026-08-29 |
| PO-00002 | `sent` | Primrose Hill | £15.00 | 2026-08-29 | 2026-08-29 |
| PO-00003/4/5 | `cancelled` | Primrose Hill / Pinner / Primrose Hill | — | 2026-08-29…31 | — |

**No `draft`, `pending_approval` or `approved` order exists.** The "an order is already in preparation" branch
of W10 is therefore currently a negative — it must still be implemented, so ZAC never advises ordering
something already drafted.

Suppliers: exactly one — **Wella Professionals**, `lead_time_days = 3`, active, 2 linked products.

---

## 7. Metric-registry bar assessment (feeds W15)

`phase-2-intelligence-signal-framework.md:940` gates QLab/stock metrics on a probe. This is that probe.

| Candidate metric | Verdict | Evidence |
|---|---|---|
| `colour_waste_rate` | ❌ **No numerator** | Every one of 20 `formula_items` has `waste_grams = 0` and `waste_cost_cents = 0`; `waste_events` has 0 rows and is write-only. |
| `colour_margin_rate` | ❌ **No target with provenance** | 16.7 % is real at one location, but nothing in QLOOQO records what colour margin *should* be. A registered metric needs an owner-set benchmark. |
| `dead_stock_share` | ❌ **Coverage too low + verdict is a setting** | Only 6/10 products carry a cost, so any value figure has 60 % coverage; and 6/6 dead is a function of a 30-day threshold, not a trend. |
| `stock_cover_days` | ❌ **Unit does not exist** | `ZacMetricUnit` is `'percent'` only; `ZacSignalScope` has no product dimension. |

Registering any of these would mint **confident zeros** — and because `zero` counts as *positive* evidence in
the reconciler, it would silently **resolve** live signals. WS3 registers no metric and publishes this table.

---

## 8. PII and permission findings that constrain every WS3 tool

| Finding | Consequence |
|---|---|
| `SheerLabAnalyticsResponse.byStylist` carries `stylistName`, `hourlyRate`, `contractedHours`, `averageBillBenchmark` — read from `core.staff_profiles` under `report.lab_analytics.view` with **no payroll permission in the path**. | W5 **never reads `byStylist`**. Enforced by a projector whose return type has no such field, plus the W3 source sweep. |
| `ColourPrepAppointment.clientName` is a **full client name**. | W7 reads only `plan.products`, `plan.summary` and the window fields. **Never** `plan.appointments`. |
| `InventoryService.listMovements` resolves `created_by` into `createdByName`. | W6 projects it away. |
| `ZacReadOnlyTool.sensitiveFields` **strips nothing** — the type's own comment says so. | Masking must be executable code. W3 makes it a **type error** instead. |
| `LabAnalyticsService.summary` re-checks the **role only** — not `report.lab_analytics.view`. | The tool's `requiredPermissions` declaration is the **sole** enforcement of that key on the ZAC path. It must never be weakened. |
| `InventoryService.assertManagerOrOwner` **is** a real `userHasPermission(actor,'inventory.manage')` check. | A weaker tool declaration would be cosmetic — the service throws regardless. Confirms keeping `inventory.manage`. |

The two adjacent services are **asymmetric**; neither behaviour can be assumed from the other.

---

## 9. What each tool would return TODAY, on the largest live business (Salon, owner actor)

| Tool | Today's honest answer |
|---|---|
| `qlab.colour_analytics` (90 d) | 5 saved formulas at Kensington, £105.51 cost / £126.62 charge, **16.7 % margin**; *"waste is not being captured when formulas are saved"* with the percentage suppressed; newest colour work 2026-07-21. |
| `inventory.stock_status` | **3 products at or below threshold** (BBB, Pinner, Primrose Hill — 2 of them at zero on hand); **6 products idle past threshold at Kensington**, against a **30-day** threshold that location set, with the ledger's newest entry **2026-08-26**; plus a reported divergence — 3 live-low vs 2 open alert rows. |
| `inventory.colour_prep_risk` (14 d rolling) | 1 colour appointment at Kensington on 2026-09-17 with resolved formula and sufficient stock; 1 at Location A - Andrew on 2026-09-15 that **cannot be assessed** — no formula on file. |
| `inventory.reorder_advisory` | 2 orderable suggestions (2 packs SoColor 8N at Pinner, 2 packs Majirel 6.0 at Primrose Hill), both **threshold top-ups with no recorded usage**; 1 unorderable (Shades EQ 09V at BBB — no supplier); **8 of 10 products have no supplier attached**; no order currently in preparation. |

Every one of those is a true, useful, non-zero answer. **No data is to be seeded to make the demo look
busier** — that would demonstrate a capability the client's own data cannot yet support.

---

## 10. Verification status

- ✅ Read-only pass. No file under `apps/api`, `apps/web` or `supabase/` modified by this subtask.
- ✅ Every query above was executed against `iqgryrczkvjkcbrgfsdl` on 2026-09-11 and its output transcribed.
- ⚠ **Production parity unverified.** These figures describe `dev-test`. Before WS3 UAT, the same pass must be
  re-run against the production project, because every default set here is justified by *this* data.
