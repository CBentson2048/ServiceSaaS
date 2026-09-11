# ZAC Phase 1 — QLAB / Stock Feasibility Report

> ## ⚠ PARTLY SUPERSEDED — read this first (added 2026-09-11)
>
> **The DATA-AVAILABILITY conclusions below are obsolete.** This report states that there is "no `supplier`,
> `purchase_order`, `reorder`, `lead_time`, or `expiry` entity anywhere". That was true when it was written in
> July 2026. It is **false today**: migrations `0091` (stock + colour prep), `0092` (suppliers + ordering
> metadata), `0093` (dead-stock alerts), `0094` (purchase orders + `inventory.reorder_usage`), `0095`, `0096`,
> `0100` and `0101` have all shipped and are applied. Suppliers, lead times, purchase orders, reorder maths, a
> dead-stock report and a Colour Prep planner all exist and are read by ZAC Phase 2 Workstream 3.
>
> For current data readiness see **[`phase-2-ws3-data-evidence.md`](phase-2-ws3-data-evidence.md)**.
>
> **The SAFETY DOCTRINE below still stands in full**, and Workstream 3 is built on it:
> feasibility-probe every tool; never read the write-only `waste_events` table; re-check each permission
> inside each tool because the underlying services check role and scope but not always the permission key;
> and never report a zero confidently. Every one of those turned out to be load-bearing.

> **Nature of this document.** A code-grounded feasibility analysis of QLOOQO Lab, product, stock, formula, and inventory data/services, to decide **exactly what can safely be exposed to ZAC Phase 1 as limited read-only insights**. Analysis only — it creates no source code, no migrations, no env/package changes, and stages/commits nothing. Every claim traces to a repo-relative `path:line` on the current `develop` tree. Companion to [`phase-1-backend-foundation-architecture-analysis.md`](phase-1-backend-foundation-architecture-analysis.md) (§ QLAB/Stock Feasibility) and [`phase-1-backend-foundation-technical-approach.md`](phase-1-backend-foundation-technical-approach.md) (§14).
>
> Date: 2026-07-24 · Phase 1 is **read-only**. No write tools, no ordering, no autonomous actions.
>
> **Search terms inspected:** QLab, Lab, formula, colour/color, product, stock, inventory, supplier, usage, waste, expiry, low stock, fast/slow moving, order, purchase, retail, product usage. **Result up front:** there is **no `supplier`, `purchase_order`, `reorder`, `lead_time`, `expiry`, `shelf_life`, or `forecast` entity anywhere** in the schema or services (grep-confirmed across `supabase/migrations/` and `apps/api/src/`; the only `expires_at` hits are auth-session TTLs in `0009`). QLOOQO has a **colour + stock-deduction** model, not a **purchasing/forecasting** model.

---

## 1. Existing Data Model

Relevant schemas: **`lab`** (formulas), **`inventory`** (products/stock/movements/waste/alerts/categories), **`billing`** (retail sales, visit line items). All tables are `business_id`-scoped; most are also `location_id`-scoped.

### 1.1 Relevant tables & fields

**`inventory.products`** — product catalogue (`0021:30-44`, extended `0024:57-61`)
- `id`, `business_id` (→ `core.businesses`, cascade), `name`, `brand`, **`sku`**, `default_unit` (`'g'`), `default_cost_per_gram_cents`, `low_stock_threshold_grams`, `is_active`, `metadata jsonb`, `created_at`, `updated_at`; `unique nulls not distinct (business_id, sku)`.
- Added by `0024`: `category` (free text; later FK'd via `0038`), `size_value`, `size_unit`, `retail_price_cents`.

**`inventory.location_stock`** — per-location on-hand (`0021:46-55`, extended `0024:63-65`)
- `id`, `business_id`, `location_id`, `product_id`, **`quantity_on_hand_grams`**, `low_stock_threshold_grams` (per-location override), `updated_at`; `unique (location_id, product_id)`. Added by `0024`: `is_active`, `created_at`.

**`inventory.stock_movements`** — auditable movement ledger (`0021:104-117`, extended `0024:67-73`)
- `id`, `business_id`, `location_id`, `product_id`, `formula_id?`, `formula_item_id?`, **`movement_type`**, **`quantity_delta_grams`**, `unit_cost_cents?`, `total_cost_cents?`, `reason`, `created_at`. Added by `0024`: `location_stock_id`, `reference_type`, `reference_id`, `notes`, `created_by`, `metadata`.
- `movement_type` enum: `formula_usage`, `formula_waste`, `formula_reversal`, `manual_adjustment` (`0021:16-21`) **+** `opening_balance`, `restock`, `retail_sale`, `correction` (`0024:16-53`).

**`inventory.waste_events`** — waste ledger (`0021:119-130`)
- `id`, `business_id`, `location_id`, `product_id?`, `formula_id`, `formula_item_id?`, `waste_grams`, `waste_cost_cents`, `reason` (default `'formula_mixed_unused'`), `created_at`. **⚠ Write-only — no read layer anywhere (see §2.4).**

**`inventory.low_stock_alerts`** — materialised alerts (`0021:132-145`)
- `id`, `business_id`, `location_id`, `product_id`, `remaining_quantity_grams`, `threshold_quantity_grams`, `status` (`open|acknowledged|resolved`), `first_triggered_at`, `last_triggered_at`, `resolved_at`, `metadata`; `unique (location_id, product_id, status)`.

**`inventory.categories`** — per-business taxonomy (`0036:8-16`), seeded from free text (`0037`), linked (`0038`).

**`lab.formulas`** — saved colour formula record (`0021:57-78`, extended `0063:19-25`)
- `id`, `external_formula_id`, `business_id`, `location_id`, `lab_session_id?`, `appointment_id?`, `visit_id?`, `client_profile_id`, `source_formula_id?`, **`status`** (`draft|mixing|ready_for_review|saved|voided`), **`actual_cost_cents`**, **`waste_cost_cents`**, **`billable_charge_cents`**, `currency_code`, `metadata`, `saved_at`, `voided_at`, `created_at`, `updated_at`.
- Added by `0063` (**IN-FLIGHT, not applied — see §2.3**): `version`, `version_group_id`, `created_by_staff_profile_id`, `updated_by_staff_profile_id`, `service_name_snapshot`, `notes`.

**`lab.formula_items`** — per-ingredient lines (`0021:80-102`)
- `id`, `formula_id`, `external_item_id?`, `product_id?`, `product_name`, `brand`, **`shade`**, `developer`, `ratio`, `processing_time_minutes?`, **`captured_grams`**, **`waste_grams`**, `entry_mode` (`ble_scale|manual`), `captured_at`, `cost_per_gram_cents?`, **`cost_cents`**, **`waste_cost_cents`**, `notes`, timestamps.

**`billing.retail_sales`** — first-class retail revenue (`0031:16-41`)
- `id`, `business_id`, `location_id`, `staff_profile_id?`, `product_id`, `client_profile_id?`, `visit_id?`, `quantity`, `unit_price_cents`, `total_amount_cents`, `currency_code`, `payment_method` (`cash|card_reader|other`), `stock_movement_id?`, **`sold_at`**, `notes`, `created_by_user_profile_id`, `metadata`, timestamps. **⚠ Applied but effectively empty / no UI writer (see §2.4).**

**`billing.visit_line_items`** — billed lines incl. colour (`0021:147-160`)
- `line_type` (incl. **`product_usage`** = colour cost billed to the client), `amount_cents`, `formula_breakdown jsonb`. Read by the KPI commission base and lab-appointments checkout.

### 1.2 Field-group summary

| Group | Present? | Fields |
|---|---|---|
| **Business/location scope** | ✅ everywhere | `business_id` (all tables), `location_id` (all operational tables) |
| **Product identifiers** | ✅ | `products.id`, `products.sku`, `products.name`, `products.brand`, `category` |
| **Stock quantity fields** | ✅ | `location_stock.quantity_on_hand_grams`, `low_stock_threshold_grams` (product- and location-level), `stock_movements.quantity_delta_grams` |
| **Usage fields** | ✅ | `stock_movements` (`formula_usage`/`retail_sale` types), `formula_items.captured_grams`, `visit_line_items.line_type='product_usage'` |
| **Formula / colour fields** | ✅ | `formulas.{status,actual_cost_cents,waste_cost_cents,billable_charge_cents,saved_at}`, `formula_items.{shade,developer,ratio,captured_grams,cost_cents}` |
| **Waste / cost fields** | ✅ | `formulas.waste_cost_cents`, `formula_items.waste_cost_cents`/`waste_grams`, `waste_events.*` (write-only), `products.default_cost_per_gram_cents` |
| **Timestamps** | ✅ | `created_at`/`updated_at` throughout; `formulas.saved_at`, `retail_sales.sold_at`, `low_stock_alerts.first/last_triggered_at`, `stock_movements.created_at` |
| **Supplier / order fields** | ❌ **NONE** | no supplier, purchase-order, reorder-point, or lead-time column anywhere |
| **Expiry fields** | ❌ **NONE** | no expiry, batch/lot, or shelf-life column anywhere |

**Consequence:** any insight requiring *purchasing, delivery cadence, expiry, or consumption-rate-vs-lead-time* has **no backing data model** and cannot be built read-only in Phase 1 (or in the current V1.1 scope) — it would require net-new schema.

---

## 2. Existing Backend Services

### 2.1 Lab / QLab modules
`apps/api/src/` contains: `lab-analytics`, `lab-formula`, `lab-billing-rules`, `lab-device`, `lab-session`, `lab-pin`, `lab-appointments`. There is **no `products/` module** — product data lives entirely in `inventory/`.

**`lab-analytics` — the single cleanest intelligence surface (STABLE).**
- Controller (`lab-analytics.controller.ts:10-27`): `GET /lab/analytics/summary`, guarded `SupabaseAuthGuard, RolesGuard, PermissionsGuard` + `@RequireRoles('owner','manager')` + `@RequirePermissions('report.lab_analytics.view')` → `LabAnalyticsService.summary(actor, range, locationId?, from?, to?)`.
- A second **lab-session-token** variant (`lab-analytics.controller.ts:32-49`, `GET /lab/analytics/session/:sessionId/summary`) authenticates via a PIN lab-session and rejects stylist sessions. **ZAC Phase 1 (JWT-only) must wrap the JWT `summary`, never the session variant.**
- `LabAnalyticsService.summary` computes in-process (all arithmetic in code) from `lab.formulas` filtered `status='saved'`: colour revenue, formula cost, **gross margin + margin %**, **waste cost + waste % of revenue**, per-location / per-stylist / per-service-type breakdowns, **most-used products by weight and by cost**, and open low-stock alerts. Location scope is enforced in `resolveLocationScope` (owner = all business locations; manager bounded to `allowedLocationIds`). Because it filters `status='saved'`, it is **immune to the un-applied formula-draft work** (§2.3).

**`lab-formula` — mixed.** Durable persistence (`save` → RPC `lab.save_formula_with_reconciliation`; history reads) coexists with stubbed/scaffold methods (`addItem`/`captureWeight`/`recalculate` return hard-coded values). The client-history read path selects the `0063` `notes` column, so it **assumes the un-applied 0063 schema** — do not build ZAC insights on it. Other lab modules (`lab-billing-rules`, `lab-device`, `lab-session`, `lab-pin`, `lab-appointments`) are auth/config/checkout plumbing, not intelligence surfaces.

### 2.2 Stock / inventory / products / retail
**`inventory` (STABLE).** Controller (`inventory.controller.ts:32-138`), guarded `@RequireRoles('owner','manager')` + `@RequirePermissions('inventory.manage')`. **Read** endpoints usable by ZAC:
- `GET /inventory/products` → `listProducts`
- `GET /inventory/stock` → `listStock` (supports a `lowStockOnly` filter)
- `GET /inventory/movements` → `listMovements`
- `GET /inventory/low-stock` → `listLowStock` (reads `low_stock_alerts` where `status='open'`)
- `GET /inventory/categories` → `listCategories`

Writes (`POST/PATCH/DELETE` for products, stock initialize/adjust/threshold, categories) are **out of scope** for read-only ZAC. There is also a **lab-session variant** (`lab/inventory/session/:sessionId/...`) where station stock reads are intentionally not owner/manager-gated (a PIN-unlocked stylist sees location-scoped quantities); management mutations remain owner/manager-only. **ZAC Phase 1 uses the JWT `inventory` reads, not the session variants.**

**Live low-stock is also computed by `dashboard`.** `GET /dashboard/inventory-alerts` (owner/manager + `report.dashboard.view`) → `DashboardService.inventoryAlerts` computes low-stock **live** from `location_stock` (`isLowStock = threshold > 0 && quantity_on_hand_grams <= threshold`). This is the more reliable "what is low right now" primitive; the `low_stock_alerts` table can lag.

**`retail-sales`.** `GET /retail-sales` (owner/manager + `report.financials.view`) → `RetailSalesService.list`; `POST /retail-sales` (`retail.record`) is a write (excluded). See §2.4 on emptiness.

### 2.3 Stable vs under V1.1 change
| Migration | Provides | Applied on inspected dev-test? | Status for ZAC |
|---|---|---|---|
| `0021` lab/billing/inventory foundation | formulas, formula_items, products, location_stock, stock_movements, waste_events, low_stock_alerts, visit_line_items | ✅ (foundational) | **STABLE** |
| `0024` inventory management | catalogue/size/retail fields, movement types, adjustment audit | ✅ | **STABLE** |
| `0031` retail_sales | first-class retail revenue | ✅ (schema) | STABLE schema, **empty data** |
| `0036–0038` categories | inventory taxonomy | ✅ | **STABLE** |
| `0063` formula record model | `formulas.{version,notes,service_name_snapshot,…}` | ❌ **NOT applied** | **IN-FLIGHT V1.1** |
| `0068` formula notes persist | formula notes | ❌ **NOT applied** | **IN-FLIGHT V1.1** |
| `0069` formula draft save | `status='draft'` rows | ❌ **NOT applied** | **IN-FLIGHT V1.1** |
| `0070` split-tender | multi-row `salon_payments` | ❌ **NOT applied** | **IN-FLIGHT V1.1** |

On the inspected **dev-test** branch the newest applied migration is **`0062`** (verified via `list_migrations` in the earlier feasibility pass), so `0063→0070` are files-not-yet-applied and are active V1.1 work. `0063` states it plainly: *"DATA MODEL ONLY … the 'Zac' AI remain future scope"* (`0063:6-8`). **Production schema parity is unverified and must be re-confirmed (QC8).** (Note: migration numbers `0071`–`0074` are now taken by the parallel payroll work, unrelated to QLAB.)

### 2.4 Read-only methods, permissions, scoping — and the emptiness reality
- **Read-only methods already exist** for everything ZAC needs: `LabAnalyticsService.summary`, `InventoryService.listProducts/listStock/listMovements/listLowStock/listCategories`, `DashboardService.inventoryAlerts`. ZAC composes these with the acting `AuthUser` — it does **not** open a Supabase client.
- **Permissions:** `report.lab_analytics.view` (colour analytics), `inventory.manage` (inventory reads/writes), `report.dashboard.view` (dashboard low-stock alerts), `report.financials.view` (retail list). All enforced at the controller guard; the underlying services re-check **role + location** but **not** the permission key — so **each ZAC tool must independently re-check the same permission** (the platform-wide rule from the architecture analysis).
- **Scoping:** every service uses the service-role client and enforces `business_id` + `allowedLocationIds` in code (owner = all business locations; manager bounded to their locations). RLS on these tables gates only the `authenticated` role, which the service-role bypasses — so ZAC's isolation comes from calling these guarded methods with the real `AuthUser`, never from RLS.
- **Emptiness caveats (load-bearing):**
  - `inventory.waste_events` is **write-only** — inserted by the formula RPC, deleted-then-reinserted on re-save, and **never SELECT-ed anywhere** (grep = 0 reads). Get waste from `lab.formulas.waste_cost_cents` (via `lab-analytics`), **never** from `waste_events`.
  - `billing.retail_sales` is applied but **effectively empty** — the only reader besides its own module is the KPI engine, which defends against the table being absent; no UI writer was found. **Do not offer retail insights as if backed by data.**
  - Colour analytics are only meaningful where the salon **actually mixes formulas in Qlooqo Lab**; low-stock is only meaningful where products + stock + thresholds are **configured**. Both are likely sparse in early production → a **data-population probe** must gate any tool so ZAC never confidently reports zeros.

---

## 3. Data Readiness

Classification: **A** = Ready for Phase 1 read-only · **B** = Possible with minor mapping · **C** = Not ready / defer · **D** = Unsafe / needs V1.1 (or net-new) completion.

| Potential insight | Class | Grounds |
|---|---|---|
| **Basic colour cost / waste signals** (current window) | **A** | `LabAnalyticsService.summary` returns colour revenue, formula cost, gross margin %, waste cost, waste % of revenue directly. Immune to un-applied draft work (`status='saved'`). *Caveat: value ≈ 0 if the Lab isn't used → gate on population probe.* |
| **Low-stock items** | **A** | Live computation via `DashboardService.inventoryAlerts` / `InventoryService.listLowStock`; guarded, location-scoped, stable. Prefer the live path over the lagging `low_stock_alerts` table. |
| **Colour waste trends** (period-over-period) | **B** | `summary` is single-window; a trend = call it for two windows and compare. Light mapping, no new backend. Trend only as reliable as the number of saved formulas. |
| **Fast-moving products** | **B** | Colour subset is near-A via `summary`'s *most-used products by weight/cost*; general fast-movers require ranking `stock_movements` over a window (light derivation, no endpoint). Descriptive only, not predictive. |
| **Slow-moving stock** | **B → C** | Derivable by ranking `stock_movements` ascending / flagging zero-usage products over a window (no dedicated endpoint; light derivation). **Effectively C until movement history is populated** — sparse data makes "slow" indistinguishable from "unused/new". Descriptive only. |
| **Products approaching expiry** | **C/D** | **No expiry/batch/shelf-life field exists at all.** Not in Phase 1 and **not even in current V1.1** — would require net-new schema. Defer. |
| **Products likely to run out before next delivery** | **C/D** | Requires delivery cadence + lead-time + consumption-rate model — **none exist**. Predictive. Defer. |
| **Over-ordering detection** | **C/D** | Requires purchase-order / ordering data — **none exist**. Defer. |
| **Stock-holding optimisation** | **C/D** | Optimisation over cost-of-capital + demand — no data, predictive. Defer. |
| **Predicted ordering requirements** | **C/D** | Forecasting over consumption + lead-time — no data. Defer. |
| **Automated ordering** | **D** | A **write/action** requiring a supplier workflow — violates Phase-1 read-only *and* has no data model. Hard defer. |
| *(context)* Formula notes / versions / drafts / reapply | **D** | Depend on the un-applied `0063/0068/0069` chain (in-flight V1.1). Do not build on them. |
| *(context)* Retail performance / retail commission | **C** | `retail_sales` applied but empty / no writer. Not ready. |

---

## 4. Phase 1 Boundary

**Included:**
> QLAB/stock **technical feasibility and limited read-only foundation pass**.

**Possible if stable (candidates for read-only exposure, each gated on a data-population probe):**
- colour waste trends
- basic colour cost/waste signals
- low-stock items
- slow-moving stock
- fast-moving products

**Deferred unless already cleanly supported (they are NOT — no data model):**
- advanced prediction
- ordering forecasts
- over-ordering detection
- stock-holding optimisation
- automated ordering
- supplier purchasing workflows

**Acceptance condition:** a QLAB/stock capability is included **only if** it is read-only, backed by **applied and populated** schema, permission-aware (`report.lab_analytics.view` / `inventory.manage` / `report.dashboard.view`), and **non-disruptive to the V1.1 roadmap**. Week 1 is **feasibility-only** (no user-facing tool); the safe read tools are candidates for Week 2/3, each behind the population probe.

---

## 5. Recommended ZAC Tool Contracts

All tools are read-only, wrap an existing guarded service with the acting `AuthUser`, independently re-check their permission, never open a DB client, and follow `error_behavior: fail_closed` / `fallback_behavior: state_unavailable`.

### QlabColourWasteSummaryTool
- **Purpose:** basic colour cost/waste/margin signals for a window (and, by comparing two windows, a simple waste *trend*).
- **Required data:** `lab.formulas` (`status='saved'`) + `lab.formula_items`.
- **Required permission:** `report.lab_analytics.view`.
- **Input:** `{ range | from/to, locationId? }`.
- **Output:** colour revenue, formula cost, gross margin %, waste cost, waste % of revenue, worst-margin location, per-location/stylist/service breakdowns, most-used products.
- **Evidence refs:** `LabAnalyticsService.summary` output with `as_of` (never `waste_events`).
- **Unavailable-data behaviour:** if the population probe finds no saved formulas in the window → return "no colour data captured yet", not zeros.
- **Risk level:** **Medium** (emptiness/adoption risk; stable code path).

### StockVisibilitySummaryTool
- **Purpose:** current product catalogue + on-hand stock levels where reliable.
- **Required data:** `inventory.products` + `inventory.location_stock`.
- **Required permission:** `inventory.manage`.
- **Input:** `{ locationId?, lowStockOnly? }`.
- **Output:** products with on-hand grams, threshold, `isLowStock`, category, active flag.
- **Evidence refs:** `InventoryService.listStock` / `listProducts`.
- **Unavailable-data behaviour:** if no stock initialised for the location → "stock not set up yet".
- **Risk level:** **Low**.

### LowStockItemsTool
- **Purpose:** "what is low right now" for owners/managers.
- **Required data:** `inventory.location_stock` (live) — optionally `inventory.low_stock_alerts`.
- **Required permission:** `report.dashboard.view` (live alerts) **or** `inventory.manage` (`listLowStock`).
- **Input:** `{ locationId? }`.
- **Output:** product, on-hand grams, threshold grams, per location.
- **Evidence refs:** `DashboardService.inventoryAlerts` (preferred, live) / `InventoryService.listLowStock`.
- **Unavailable-data behaviour:** if no thresholds configured → "no low-stock thresholds set".
- **Risk level:** **Low**.

### SlowMovingStockTool *(optional; Week 2/3+)*
- **Purpose:** descriptive flag of products with little/no recent usage.
- **Required data:** `inventory.stock_movements` over a window + `inventory.products`.
- **Required permission:** `inventory.manage`.
- **Input:** `{ from/to, locationId? }`.
- **Output:** products ranked ascending by usage in the window, with a zero-usage flag. **Descriptive only — no prediction.**
- **Evidence refs:** `InventoryService.listMovements` + light derivation.
- **Unavailable-data behaviour:** if movement history is sparse → "insufficient movement history to judge slow-movers".
- **Risk level:** **Medium** (derivation + data sparsity; do not present "slow" as "over-ordered").

### FastMovingProductsTool *(optional; Week 2/3+)*
- **Purpose:** most-used products by weight/cost (colour) or by movement volume (general).
- **Required data:** `lab.formula_items` (colour, via `summary` most-used) and/or `inventory.stock_movements` (general).
- **Required permission:** `report.lab_analytics.view` (colour) / `inventory.manage` (general).
- **Input:** `{ range | from/to, locationId? }`.
- **Output:** ranked most-used products by weight and by cost.
- **Evidence refs:** `LabAnalyticsService.summary` most-used products / `InventoryService.listMovements`.
- **Unavailable-data behaviour:** if no usage captured → "no product usage captured yet".
- **Risk level:** **Medium** (descriptive; colour subset most reliable).

---

## 6. Final Recommendation

**Included in Phase 1 core:** the **QLAB/stock feasibility pass itself** (Week 1) — confirm applied schema + prod parity, run the data-population probe, produce a documented go/no-go. **No user-facing QLAB/stock tool ships in Week 1.**

**Phase 1 read-only tools (candidates for Week 2/3, each gated on the population probe):**
- **`QlabColourWasteSummaryTool`** — basic colour cost/waste signals (and simple trend). *Safe, stable, wraps `LabAnalyticsService.summary`.*
- **`LowStockItemsTool`** + **`StockVisibilitySummaryTool`** — low-stock and current stock visibility. *Safe, stable, wraps `dashboard`/`inventory` reads.*

**Optional (Week 2/3+, only if the team wants them):**
- **`FastMovingProductsTool`** (colour subset is reliable; general needs light derivation).
- **`SlowMovingStockTool`** (descriptive-only; hold until stock-movement history is populated).

**Deferred (no data model — do not attempt in Phase 1):**
- products approaching expiry; run-out-before-delivery prediction; over-ordering detection; stock-holding optimisation; predicted ordering requirements; automated ordering; supplier purchasing workflows; retail performance insights; formula notes/versions/drafts (in-flight `0063/0068/0069`).

**Does including QLAB/stock affect the 3-week estimate?**
- **No, if scoped to the two safe read tools + the feasibility pass.** They wrap existing, stable, guarded services (`LabAnalyticsService.summary`, `InventoryService.listLowStock/listStock`, `DashboardService.inventoryAlerts`) — **no new backend, no new schema, no new permissions** — so they fit inside the planned Week-2/3 tool-wiring work.
- **Minor add** if `FastMoving`/`SlowMoving` derivation is included (light ranking logic over `stock_movements`) — keep optional so it can be dropped without risk.
- **Would blow the estimate** if any predictive/ordering/expiry capability were attempted — those need net-new schema (supplier/PO/lead-time/expiry) and services and are explicitly out of Phase 1.

**What Cosan must confirm before implementation:**
1. **Production schema parity (QC8)** — is the `0021/0024/0031/0036-0038` foundation applied in prod "Sheer V1", and confirm `0063+` are *not* required by any wrapped read path (they aren't — `summary` uses `status='saved'`).
2. **Data-population reality** — do the target businesses actually use Qlooqo Lab (saved formulas) and have stock initialised with thresholds? If not, the tools return zeros — the probe result decides go/no-go.
3. **Exposure timing** — keep QLAB/stock **feasibility-only in Week 1**; expose the two safe read tools in Week 2/3, or defer entirely.
4. **Permission mapping** — accept `report.lab_analytics.view` (colour), `inventory.manage` / `report.dashboard.view` (stock) as the required permissions each ZAC tool re-checks.
5. **JWT surface only** — ZAC wraps the **JWT** `LabAnalyticsService.summary` and JWT `inventory` reads, never the lab-session-token variants.
6. **Waste source** — take waste from `lab.formulas.waste_cost_cents` (via `summary`), **never** the write-only `inventory.waste_events`.
7. **Retail exclusion** — confirm `billing.retail_sales` is empty / no writer, so **no retail insights** are surfaced in Phase 1.

**Bottom line:** QLOOQO has a solid, applied **colour + stock-deduction** data model that safely supports **basic colour cost/waste signals** and **low-stock/stock visibility** as read-only ZAC insights — gated on a data-population probe and wrapping existing guarded services. It has **no purchasing/forecasting/expiry model**, so every prediction/ordering insight is deferred. Including the safe subset does **not** extend the 3-week estimate; the feasibility pass stays in Week 1 and the two read tools ride the planned Week-2/3 tool wiring.

---

*Analysis only. This file created no application source code, migrations, environment files, package manifests, or Supabase data, and stages/commits nothing.*
