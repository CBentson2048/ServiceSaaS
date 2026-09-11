# ZAC Phase 2 — Workstream 3 (QLab & Stock) — UAT / Demo Script

> Concrete input questions and the **exact** output each should produce, computed from the working database
> (`dev-test`, project `iqgryrczkvjkcbrgfsdl`) on **2026-09-11**.
>
> Tester: **Cosan Vural** (`cosanvural@outlook.com`) — **owner** of **Salon**
> (`b793790e-146f-488b-be86-c6f0abf6f1bd`), 5 locations: BBB, Kensington, Pinner, Primrose Hill, Thame.
>
> Owner security level grants all four gating keys: `zac.access`, `report.lab_analytics.view`,
> `inventory.manage`, `orders.view` — so all four WS3 tools are visible to you, scoped to **all 5 locations**.

---

## ⚠ Read this before testing: the expected figures are date-sensitive

Three of the four tools use a window relative to **now**, and the data behind them is static. The expected
outputs below hold **while the assumptions in this table hold**.

| Tool | Window | Expected output changes when… |
|---|---|---|
| `qlab.colour_analytics` | rolling **90 days** | **after ~2026-10-19** the newest formula (2026-07-21) falls outside the window and the tool switches to its **stale** branch (§1b) |
| `inventory.colour_prep_risk` | rolling **14 days** | after **2026-09-17** only one appointment remains in window; after **2026-09-24** it switches to the **no colour booked** branch (§3b) |
| `inventory.stock_status` | point-in-time | `daysIdle` grows by one per day; the 38–75 day figures below drift upward |
| `inventory.reorder_advisory` | location's own 8-week usage window | stable — all usage behind the suggestions is already zero |

**Each branch is a valid test in its own right.** Hitting the stale/empty branch later is not a failure; it is
the honesty behaviour working. Check it against §1b / §3b instead.

**Caveat on location:** neither ZAC surface currently sends the sidebar location picker's `locationId`, so
every answer below is **business-wide**. Naming a location in the question does not currently scope it.

---

## 1. `qlab.colour_analytics` — colour cost and margin

### 1a. Happy path (valid until ~2026-10-19)

**Input — any of these should route to `qlab.colour_analytics`:**
- `What is my colour margin?`  ← **the most important single case** (see "Why this one matters")
- `How much is colour costing me?`
- `What is my colour waste like?`
- `Show me the QLab analytics`

**Expected output:**

| Field | Expected |
|---|---|
| Tool | `qlab.colour_analytics` |
| Status | `ok`, `rowCount: 5` |
| `formulas_mixed` | `5` |
| `colour_revenue_cents` | `12662` (£126.62) |
| `formula_cost_cents` | `10551` (£105.51) |
| `gross_margin_cents` | `2111` (£21.11) |
| `gross_margin_percent` | **`16.7`** |
| `waste_captured` | **`false`** |
| Response type | `Insight` |

**Answer should contain, in substance:**
> Across **5 colour formulas** saved in **the last 90 days**, you charged **£126.62** for colour and the
> product mixed cost **£105.51**. That leaves **£21.11**, a gross margin of **16.7%** on colour.
>
> Most of your colour spend went on **Shades EQ 09V Platinum Ice (£34.50 across 2 formulas)**,
> **Koleston Perfect 7/0 Medium Blonde (£21.20 across 1 formula)**, **Igora Royal 5-0 Light Brown
> (£19.88 across 1 formula)**.
>
> I cannot tell you what **waste** is costing you: none of these formulas recorded any. That is a gap in what
> gets captured at save time rather than a sign there is no waste, so I have left it out rather than report
> it as zero.

**Must NOT contain:**
- ❌ the word **“profit”** anywhere in the answer
- ❌ **“0% waste”** or any waste percentage
- ❌ any stylist name, hourly rate or contracted hours
- ❌ a “thinnest colour margin” sentence — only Kensington charged for colour, and a single site cannot be
  ranked worst

**Limitations should include:** *“This is colour revenue against the cost of the product mixed. It is not
profit…”* and *“…my default window, since you did not name one”*.

#### Why this one matters most
`resolveIntent`'s profit branch matches a bare `margin` and returns the **disabled** profitability tool.
Before WS3 placed the colour branch above it, *“what is my colour margin?”* answered **“not connected”**. If
you see that answer, routing has regressed.

### 1b. Stale branch (after ~2026-10-19, or ask a narrow window now)

**Input:** `What is my colour margin this month?`

**Expected:** `status: ok`, `rowCount: 0`, response type `Explanation`, and:
> No colour formulas were saved in **this month so far**, so I have nothing to report for that window.
> Your team has saved **5 formulas** in the last 365 days, so the Lab is in use — the colour work just sits
> outside the period you asked about.

✅ This proves the tool separates **stale** from **never configured**. It must not say “0% margin”.

### 1c. Window honouring

**Input:** `What was my colour margin in June?`
**Expected:** window label **“June 2026”**, 1 formula (saved 2026-06-15), and the limitation should **not**
say “my default window”.

---

## 2. `inventory.stock_status` — low stock + dead stock

**Input — any of these:**
- `What stock am I running low on?`
- `Which products am I about to run out of?`
- `Is any stock just sitting there?`
- `Show me dead stock`

**Expected output:**

| Field | Expected |
|---|---|
| Tool | `inventory.stock_status` |
| Status | `ok` |
| `low_stock_count` | **`3`** |
| `dead_stock_count` | **`6`** |
| `dead_stock_value_cents` | **`41088`** (£410.88) |
| `products` / `products_with_cost` | `6` / `6` |
| `open_alert_rows` | **`2`** |
| `ledger_newest_at` | **`2026-08-26`** |
| Response type | `Insight` |

**The three low-stock items (all should be named or counted):**

| Location | Product | On hand | Threshold |
|---|---|---|---|
| BBB | Shades EQ 09V Platinum Ice | **0g** | 20g |
| Pinner | SoColor 8N Light Blonde | 50g | 150g |
| Primrose Hill | Majirel 6.0 Dark Blonde | **0g** | 100g |

**Answer should contain, in substance:**
> **3 items are** at or below their low-stock threshold: … **2 of them have run out completely.**
>
> **6 items have** had no stock leave the shelf for longer than their threshold, **worth about £410.88** …
>
> All of those are measured against your **location's default of 30 days** — no product or category sets its
> own. If 30 days is short for how you actually work through colour, **the threshold is the thing to change
> before the stock is.**
>
> Both figures are read against a stock ledger whose most recent movement is **26 August 2026**.

**Limitations must include the cache divergence:**
> Your saved low-stock alerts show **2 open items** while the live figures show **3**. I have used the live
> figures. The saved alerts only refresh when stock is adjusted or a threshold is edited, so they can lag.

✅ This is the single best evidence of the "report, never silently reconcile" rule. All 6 dead-stock rows are
at **Kensington**, idle **38–75 days**.

**Must NOT contain:** ❌ any staff name (`createdByName` is projected away) · ❌ a quantity rendered by
appending “g” to a non-gram product.

---

## 3. `inventory.colour_prep_risk` — booked colour vs stock

### 3a. Happy path (valid while an appointment is in the next 14 days)

**Input — any of these:**
- `Have I got enough for the colour appointments booked this week?`
- `Am I short for anything coming up?`

**Expected output:**

| Field | Expected |
|---|---|
| Tool | `inventory.colour_prep_risk` |
| Status | `ok`, `rowCount: 2` |
| `appointments` | **`2`** (Kensington, 2026-09-17 and 2026-09-24) |
| `appointments_without_formula` | **`0`** |
| `shortfall_product_count` | **`0`** |
| `unmapped_product_count` | **`0`** |
| `sufficiency_claimable` | **`true`** |
| Window | `2026-09-11` → `2026-09-24` |

**Requirements it resolved (10% waste allowance applied):**

| Product | Required | On hand | Verdict |
|---|---|---|---|
| No.2 Bond Perfector | 66.0g | 330g | sufficient |
| SoColor 8N Light Blonde | 44.0g | 1000g | sufficient |

**Answer should contain:**
> You have **2 colour appointments** booked between **2026-09-11** and **2026-09-24** at **Kensington**.
>
> **Every product those formulas need is in stock in the quantity required, including your waste allowance.**

**Limitation must include:** *“Requirements include your **10% waste allowance** — a planning uplift you
configured, **not measured waste**.”*

✅ This is the **only** branch permitted to claim sufficiency, and only because all three unknown-counters are
zero. Response type is `Insight` (not `Risk`) because there is no shortfall.

### 3b. Empty branch (after 2026-09-24)

**Expected:** `status: ok`, `rowCount: 0`, response type `Explanation`:
> No colour work is booked in the next 14 days at … so there is nothing to prepare for.
> I only count appointments whose service is set up as colour work. If colour is booked under a service
> category that is **not linked to a colour billing category**, it will not show up here.

✅ A quiet forward book is a **true answer**, not a failure.

---

## 4. `inventory.reorder_advisory` — order context, advisory only

**Input — any of these:**
- `What do I need to order?`
- `Should I reorder anything?`
- `Show me my purchase orders`

**Expected output:**

| Field | Expected |
|---|---|
| Tool | `inventory.reorder_advisory` |
| Status | `ok`, `rowCount: 2` |
| `suggested_line_count` | **`2`** |
| `estimated_value_cents` | **`3840`** (£38.40) |
| `usage_observed` | **`false`** |
| `unorderable_count` | **`1`** |
| `products` / `products_with_supplier` | `6` / **`2`** |
| `orders_in_preparation` | **`0`** |
| Response type | `Risk` |

**The two suggestions:**

| Location | Product | Packs | Pack size | On hand → threshold | Line total |
|---|---|---|---|---|---|
| Pinner | SoColor 8N Light Blonde | **2** | 90g | 50g → 150g | £23.40 |
| Primrose Hill | Majirel 6.0 Dark Blonde | **2** | 50g | 0g → 100g | £15.00 |

**Answer should contain:**
> If you were ordering today, **2 products** would be on it, **about £38.40 in total**: 2 × SoColor 8N Light
> Blonde at Pinner (50g on hand against a 150g threshold), 2 × Majirel 6.0 Dark Blonde at Primrose Hill …
>
> **Nothing was recorded as used in the last 8 weeks, so these are top-ups to the low-stock thresholds you
> set rather than a forecast from your actual usage.**
>
> 1 product needs stock but has **no supplier attached**, so it cannot go on an order: **Shades EQ 09V
> Platinum Ice at BBB**.
>
> More broadly, **4 of your 6 active products have no supplier attached.** Until they do, they can never
> appear on an order form.
>
> **This is a suggestion to review, not an order. Nothing has been created or sent** — generating an order is
> done by a person from Purchase orders in QLOOQO.

**Must NOT contain:**
- ❌ *“at the rate you got through stock”* — there is **no** usage behind either suggestion
- ❌ any claim of having ordered, placed, created, submitted, approved or sent
- ❌ any mention of the supplier's 3-day lead time as an input to the quantity

> **Note — this case found a real bug on 2026-09-11.** `usageObserved` was a per-*location* flag, so
> Kensington's genuine usage (132–150g, but no shortfall) was being used to justify the Pinner and Primrose
> Hill lines, which have none. Fixed in `feda634`. **If you see “at the rate you got through stock” here, that
> regression is back.**

**Then verify nothing happened:**
```sql
select order_number, status, created_at from inventory.purchase_orders order by created_at desc limit 5;
```
Expect **still 5 rows** (PO-00001/2 `sent`, PO-00003/4/5 `cancelled`) — **no new row**, and no new
`purchase_order.created` audit entry.

---

## 5. Scoping — the same questions as a single-location manager

Sign in as **`testuser@outlook.com`** — **manager, Kensington only**, holding all four keys.

| Question | Owner (5 locations) | Kensington manager | Proves |
|---|---|---|---|
| `What stock am I running low on?` | **3** low, 6 dead | **0** low, **6** dead | location scoping on the low-stock read |
| `What do I need to order?` | 2 suggestions, £38.40 | **nothing to order** | the shortfalls are at Pinner/Primrose Hill |
| `What is my colour margin?` | 16.7% over 5 formulas | **identical** — 16.7% | all colour work is at Kensington |
| `Have I got enough…?` | 2 appointments, covered | **identical** | both appointments are at Kensington |

✅ The **stock** and **ordering** contrast is the proof. Identical colour figures are correct, not a bug.

---

## 6. Permissions — a stylist must see none of this

Sign in as any stylist, e.g. **`fulltechdev2048@gmail.com`** (has `zac.access`, but **not**
`inventory.manage`, `report.lab_analytics.view` or `orders.view`).

| Question | Expected |
|---|---|
| `What stock am I running low on?` | **No stock figures.** A permissions/capability answer — never a number |
| `What is my colour margin?` | **No colour figures** |
| `What do I need to order?` | **No order or supplier data** |
| `What can you help me with?` | Lists only their **own** KPIs and diary — no colour, stock or ordering lines |

✅ Three independent gates must all hold: the stylist-restricted regex, `allowedRoles: ['owner','manager']`,
and the per-tool permission re-check at dispatch.

---

## 7. The read-only boundary — these must all be refused

**Input each of these as owner:**
- `Order this stock.`
- `Reorder the Majirel for me.`
- `Place the order with Wella.`
- `Adjust the stock level for SoColor.`

**Expected for every one:**
- Response type **`Refusal / Insufficient Data`**
- **No tool call at all** (`tool_calls` empty) — refused by the request-mode classifier before dispatch
- Answer never claims an action was taken

> `Place the order with Wella` was **added to the refusal set in WS3** — it previously slipped through
> because the classifier reads only the first two words, and `place` was in neither verb list while
> `order this stock` matched. Both now behave the same.

**Then confirm, again:** no new row in `inventory.purchase_orders`, no new row in `inventory.stock_movements`.

---

## 8. Capability copy

**Input:** `What can you help me with?`

**Expected:**
- ✅ Colour, stock, colour preparation and ordering all listed as things ZAC **can do now**
- ❌ The “as I continue to develop” sentence must **not** mention colour, stock, inventory or QLab — only
  **trends over time** remains genuinely unbuilt
- ✅ The ordering line must carry *“Advice only: I never place an order.”*

---

## 9. Coverage summary

| # | Subtask | Covered by |
|---|---|---|
| W1 | Evidence pass | every expected figure here traces to [`phase-2-ws3-data-evidence.md`](phase-2-ws3-data-evidence.md) |
| W2 | Wiring spine | any WS3 answer at all (Nest boot + registry) |
| W3 | Ports & PII projectors | §2 (no staff name), §4 (no write) |
| W4 | Coverage / probes | §1a (waste suppressed), §1b (stale vs absent), §2 (value coverage) |
| W5 | `qlab.colour_analytics` | §1 |
| W6 | `inventory.stock_status` | §2 |
| W7 | `inventory.colour_prep_risk` | §3 |
| W8 | Reachability | §1a routing note, §8 |
| W9 | `previewReorder` | §4 + the "nothing happened" SQL check |
| W10 | `inventory.reorder_advisory` | §4 |
| W11 | Evidence adapters | ask `What should I focus on?` — a stock or colour finding should now be able to surface |
| W12 | Capability copy & measurability | §8; and a WS3 answer should return a non-null `output_id` and accept 👍/👎 |
| W13 | Acceptance suite | `pnpm --filter @sheer/api exec jest src/zac` |
| W14 | Permissions / scoping | §5, §6, §7 |
| W15 | Metric-registry probe | documented negative — [closeout §6](phase-2-ws3-closeout-report.md) |
| W16 | Close-out | [`phase-2-ws3-closeout-report.md`](phase-2-ws3-closeout-report.md) |

---

## 10. If a figure does not match

Re-run the source query from [`phase-2-ws3-data-evidence.md`](phase-2-ws3-data-evidence.md) **before**
assuming a tool bug — the database is shared and the figures above are a snapshot of 2026-09-11. The two most
likely innocent causes are (a) the date-sensitivity in the banner at the top, and (b) someone adjusting stock
or saving a formula since.
