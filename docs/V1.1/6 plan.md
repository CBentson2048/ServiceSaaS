# V1.1 Week 6 — Stock, Colour Prep & Automated Ordering: Analysis & Implementation Plan

**Wrike:** [Week 6 — Stock, Colour Prep & Automated Ordering](https://www.wrike.com/open.htm?id=4507280124)
**Planned window:** 2026-08-12 → 2026-08-18 · **Budgeted:** 40 h / $1,200 @ $30/hr
**Subtasks:** 10 (9 planned + 1 change request)
**Analysis date:** 2026-08-14, against `develop` @ `65ffee4` (Week 5 merged, tree clean)
**Estimated to deliver all ten:** 150 h → **extension request of +110 h** ([§14](#14-extension-request))

---

## 1. Executive Summary

Week 6 divides into two halves in completely different states.

**The colour/Lab half is largely built.** `lab.save_formula` already computes per-product gram
usage from formula records, deducts it from `inventory.location_stock`, writes
`formula_usage` / `formula_waste` movements, reverses prior movements on re-save, records
waste events and raises low-stock alerts (`0021`, rewritten in `0069`). The Lab-usage ticket
is ~80 % done. What is missing is the phrase *"where configured"* — deduction is gated on a
**client-supplied payload flag**, not on any location or product setting.

**The ordering half does not exist.** No supplier entity, no supplier email, no minimum order
quantity, no purchase order, no approval workflow, no dead-stock concept, no barcode anywhere
in the repository. Five of ten tickets are pure greenfield.

Three structural problems sit underneath the week, none visible from the ticket titles:

1. **The stock model is grams-only.** Every quantity, cost and threshold in `inventory` is in
   grams. Retail sales already work around it (`quantity × size_value`); MOQ ("order 6
   bottles") cannot be expressed at all. Ticket 4 asks for unit conversion explicitly — this
   is the real work of the week and it touches the money path. Design in [§6](#6-the-unit-model).
2. **Nothing maps a service to a colour category.** Colour prep cannot answer "which upcoming
   appointments are colour appointments". Blocker **B1**.
3. **The change request needs written sign-off** and is 3.25 days on its own.

**Budget verdict.** 40 h buys the foundation (tickets 1, 2, 4) but produces **nothing
demonstrable**. Making Week 6 demo-able needs 60 h. All ten tickets need 150 h. See
[§13](#13-effort-estimate) and [§14](#14-extension-request).

---

## 2. Scope of This Document

This plan covers all ten subtasks, grouped into three deliverable phases:

| Phase | Tickets | Hours | Demo |
| --- | --- | --- | --- |
| **1 — Stock engine & colour prep** | 1, 2, 4, 5, 6 | 60 | Colour prep with live shortfalls |
| **2 — Ordering** | 7, 8, 9 | 44 | Draft order → approve → supplier email |
| **3 — Barcode & classification (CR)** | 3, 10 | 46 | Scan-to-deduct; per-product pricing |

Phases are separable, each ends on a working demo, and each maps to its own migration —
so a phase that is not funded leaves no dead schema behind.

---

## 3. Current Architecture

| Area | Where it lives |
| --- | --- |
| Product catalogue | `inventory.products`, `inventory.categories` (`0021`, `0024`, `0036`, `0038`) |
| Per-location stock | `inventory.location_stock` — `unique (location_id, product_id)` |
| Movement ledger | `inventory.stock_movements` — 8 movement types |
| Alerts | `inventory.low_stock_alerts` — `unique (location_id, product_id, status)` |
| Waste | `inventory.waste_events` (Lab-sourced only) |
| Manual/retail deduction | `inventory.adjust_location_stock(jsonb)` RPC |
| Lab deduction | `lab.save_formula(jsonb)` RPC (`0069`) |
| Retail sale | `billing.record_retail_sale(jsonb)` → calls `adjust_location_stock` |
| Colour billing rules | `billing.service_billing_rules`, `billing.service_billing_settings` (`0043`) |
| Location product billing | `productBillingRule` / `productMarkupPercent` in `packages/domain`, applied by `apps/api/src/common/product-billing.helper.ts` |
| Per-location config | `core.location_settings` (incl. `waste_allowance_percent`, default 10) |
| API | `apps/api/src/inventory/` — 967-line service, 278-line controller |
| Web | `/inventory` → `InventoryManagementPage` + `InventoryPage` (1,168 lines) + `InventoryCategoriesPage`; `/retail-sales` |
| Email | `apps/api/src/email/` — `EmailService.send()`, two templates |
| Audit | `apps/api/src/audit/` — `AuditService.record()` |

**House conventions to follow** (from `inventory.controller.ts`, and the Week 5 `bills`/`eod`
modules as the most recent greenfield precedent):

```ts
@Controller('inventory')
@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)
@RequireRoles('owner', 'manager')
@RequirePermissions('inventory.manage')
```

Actor via `@CurrentUser() actor: AuthUser`; responses always wrapped
(`ListXResponse { items: X[] }`, `XResponse { item: X }`); domain types in
`packages/domain/src/index.ts`; DTOs use `class-validator`.

### Build traps that will cost a day if not known

- **Permission keys must be written in two places.** A key seeded only in the migration is
  silently stripped the first time an owner saves a security level, because
  `owner-security-levels` validates against `PERMISSION_CATALOG`. The `0074` header documents
  this at length. Ship the domain change *with* the migration.
- **Cross-schema embeds do not work.** PostgREST cannot embed `billing.retail_sales` →
  `inventory.products`; `retail-sales.service.ts` stitches names manually. Orders → products →
  suppliers needs the same treatment or an RPC.
- **`lab.save_formula` is re-entrant.** Re-saving nets `formula_usage + formula_waste −
  formula_reversal`. Any change to the deduction path must preserve this or Lab stock drifts
  on every edit.
- **Migrations are applied by hand** via the SQL editor, never through MCP. Next free
  number is **0089**.

---

## 4. Readiness Per Ticket

| # | Ticket | State |
| --- | --- | --- |
| 1 | [Product size & stock metadata](https://www.wrike.com/open.htm?id=4507283053) | ~50 % |
| 2 | [Lab usage → stock, where configured](https://www.wrike.com/open.htm?id=4507283123) | ~80 % |
| 3 | [Barcode consumption records](https://www.wrike.com/open.htm?id=4507283214) | 0 % |
| 4 | [Unified stock deduction engine](https://www.wrike.com/open.htm?id=4507283292) | ~40 % |
| 5 | [Colour prep service](https://www.wrike.com/open.htm?id=4507283411) | 0 % |
| 6 | [Prep planning date views](https://www.wrike.com/open.htm?id=4507283421) | 0 % |
| 7 | [Dead stock alerts](https://www.wrike.com/open.htm?id=4507283325) | 0 % |
| 8 | [Automated order forms](https://www.wrike.com/open.htm?id=4507283458) | 0 % |
| 9 | [Approval + supplier email + history](https://www.wrike.com/open.htm?id=4507283488) | 0 % |
| 10 | [CR: Product use classification](https://www.wrike.com/open.htm?id=4526936574) | DB only |

**Ticket 1** — present: `brand`, `sku`, `size_value`/`size_unit`, `default_unit`,
`default_cost_per_gram_cents`, `retail_price_cents`, `low_stock_threshold_grams` (product
*and* location level), managed category catalogue, all wired through
`UpsertInventoryProductDto` → `InventoryProduct` → web form. Absent: **supplier** (one grep
hit repo-wide — a form label in the Lab app), **MOQ**, pack/case size, dead-stock threshold.

**Ticket 10** — `0079` shipped `is_salon_use`, `is_lab_use`, `is_retail`,
`lab_markup_percent` with a range constraint and a backfill. **All four have zero TypeScript
references.** They are dead columns today: not in the DTO, not in `InventoryProduct`, not in
the product form, not gating the retail picker.

---

## 5. Gaps and Blockers

### 5.1 Blockers

**B1 — No service → colour-category mapping.** `billing.service_billing_category_enum`
(`permanent_colour`, `lightener_bleach`, `semi_toners`, `special_treatments`) exists only as a
key on `billing.service_billing_rules`. Nothing on `booking.services` or
`booking.service_categories` points at it. Blocks tickets 5 and 6. Fix in `0090` ([§8](#8-migration-0090--colour-prep-mapping)).

**B2 — Supplier is a field in one ticket, an entity in another.** Ticket 1 says "supplier
email"; ticket 8 says "group by supplier". Build `inventory.suppliers`.

**B3 — CR not signed off.** The ticket states in bold that it requires written sign-off and an
hours agreement. It also has a *sequencing* consequence: classification shares the DTO,
service and product form with ticket 1, so a late yes means building that form twice.

### 5.2 Schema defects to fix in `0089`

- **No negative-stock guard.** `location_stock.quantity_on_hand_grams` has no
  `check (>= 0)` and `save_formula` subtracts unconditionally. Stock can go negative today.
- **Retail sales silently skip stock deduction when `size_value` is null.**
  `record_retail_sale` computes `v_grams := quantity × coalesce(size_value, 0)` and wraps the
  deduction in `if v_grams > 0`. A retail product with no size sells with **no deduction and
  no movement row**, no error. Live data-integrity bug, not a Week 6 feature.
- **No barcode column or lookup index.** `sku` is `unique nulls not distinct (business_id, sku)`
  and is not a barcode.

### 5.3 The markup collision

Three markup sources once the CR lands:

| Source | Scope | Field |
| --- | --- | --- |
| Location product billing | location | `productBillingRule` + `productMarkupPercent` / `productFixedUpliftAmount` + round-up |
| Colour service billing rules (`0043`) | location × colour category | `salon_markup_percent`, `standard_allowance_grams`, `charging_strategy` |
| CR (`0079`) | product | `lab_markup_percent` |

The CR's own acceptance is *"the colour charge is never double-marked-up."* The resolver,
`product-billing.helper.ts`, feeds the visit bill and the stored bills written by
`record_bill` (`0085`). Algorithm in [§11.3](#113-markup-precedence-ticket-10b).

---

## 6. The Unit Model

The single most consequential design decision in the week.

**Today.** `quantity_on_hand_grams`, `default_cost_per_gram_cents`,
`low_stock_threshold_grams`, `quantity_delta_grams`. Retail already works around it:
`v_grams := quantity × coalesce(size_value, 0)`.

**Requirement (ticket 4).** *"Handles unit conversions (e.g. grams vs whole units)"*, and MOQ
must be expressible in orderable units.

**Decision: keep grams as the canonical stored quantity; add declared units and pack sizes on
the product; convert at the boundary.**

```
products.stock_unit      'gram' | 'millilitre' | 'unit'   -- what one base quantity means
products.pack_size        numeric  -- base quantities in one sellable/orderable pack
products.order_multiple   integer  -- supplier order step (default 1)
products.minimum_order_quantity integer  -- in packs
```

One conversion helper, used by every deduction source:

```ts
// packages/domain or apps/api/src/inventory/unit-conversion.ts
toBaseQuantity(product, quantity, unit: 'base' | 'pack'): number
toPackQuantity(product, baseQuantity): number
```

**Why not rename the column.** Renaming `quantity_on_hand_grams` → `quantity_on_hand_base`
touches `adjust_location_stock`, `save_formula`, `record_retail_sale`,
`inventory.service.ts`, `dashboard.service.ts`, the Zac stock tool, `InventoryPage.tsx` and
the Lab `InventoryScreen`. There is precedent for such a rename (`0082` renamed
`net_payable` → `gross_payable`), but it is a cosmetic day in a week already 3× over budget.
**Ship the functional conversion now; log the rename as tech debt.** Add a column comment
recording that for non-gram products the column holds base quantities, not grams.

---

## 7. Migration `0089` — Stock & Supplier Foundation

Covers ticket 1, underpins 4, 7, 8, 9. Idempotent throughout, per house style.

```sql
-- 1. Suppliers -----------------------------------------------------------
create table if not exists inventory.suppliers (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  name text not null,
  contact_email text,
  contact_phone text,
  account_reference text,
  lead_time_days integer check (lead_time_days is null or lead_time_days >= 0),
  notes text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists inventory_suppliers_business_name_key
  on inventory.suppliers (business_id, lower(name));
-- RLS + set_updated_at trigger mirroring inventory.categories (0036)

-- 2. Product ordering & unit metadata ------------------------------------
alter table inventory.products
  add column if not exists supplier_id uuid references inventory.suppliers(id) on delete set null,
  add column if not exists stock_unit text not null default 'gram'
    check (stock_unit in ('gram','millilitre','unit')),
  add column if not exists pack_size numeric(12,3)
    check (pack_size is null or pack_size > 0),
  add column if not exists minimum_order_quantity integer not null default 1
    check (minimum_order_quantity >= 1),
  add column if not exists order_multiple integer not null default 1
    check (order_multiple >= 1),
  add column if not exists barcode text,
  add column if not exists dead_stock_days integer
    check (dead_stock_days is null or dead_stock_days > 0);

create unique index if not exists inventory_products_business_barcode_key
  on inventory.products (business_id, barcode) where barcode is not null;
create index if not exists idx_inventory_products_supplier
  on inventory.products (business_id, supplier_id) where supplier_id is not null;

-- Backfill: size_value has carried pack size implicitly since 0024.
update inventory.products set pack_size = size_value
  where pack_size is null and size_value is not null and size_value > 0;

-- 3. Per-location stock policy -------------------------------------------
alter table core.location_settings
  add column if not exists stock_deduction_enabled boolean not null default true,
  add column if not exists allow_negative_stock boolean not null default true,
  add column if not exists dead_stock_days_default integer not null default 90
    check (dead_stock_days_default > 0),
  add column if not exists reorder_usage_window_weeks integer not null default 8
    check (reorder_usage_window_weeks > 0),
  add column if not exists reorder_coverage_weeks integer not null default 4
    check (reorder_coverage_weeks > 0);

-- 4. Defect fix: retail sales must not silently skip stock ---------------
--    record_retail_sale currently guards on `if v_grams > 0`. Replace with an
--    explicit raise when the product tracks no pack size, so a mis-configured
--    product fails loudly at the till instead of leaking stock.
```

> **Data check before shipping §4:** audit existing products for
> `is_retail = true and size_value is null` and existing negative
> `quantity_on_hand_grams`. Backfill or write a `correction` movement first,
> otherwise the constraint and the raise will block live sales.

---

## 8. Migration `0090` — Colour Prep Mapping

Resolves **B1**. Covers tickets 5 and 6.

```sql
alter table booking.service_categories
  add column if not exists billing_category billing.service_billing_category_enum;

create index if not exists idx_service_categories_billing_category
  on booking.service_categories (business_id, billing_category)
  where billing_category is not null;

comment on column booking.service_categories.billing_category is
  'Links a service category to its colour billing category (0043). Null means the
   category is not a colour service and is excluded from colour prep planning.';
```

Owner sets this once per category in the existing service-category settings UI. Null is the
safe default: a category with no mapping is simply not a colour service.

---

## 9. Migration `0091` — Purchase Orders & Permissions

Covers tickets 8 and 9. **Only ship if Phase 2 is funded** — otherwise these tables sit unused.

```sql
do $$ begin
  create type inventory.purchase_order_status_enum as enum (
    'draft','pending_approval','approved','sent','cancelled'
  );
exception when duplicate_object then null; end $$;

create table if not exists inventory.purchase_orders (
  id uuid primary key default extensions.gen_random_uuid(),
  business_id uuid not null references core.businesses(id) on delete cascade,
  location_id uuid not null references core.locations(id) on delete restrict,
  supplier_id uuid not null references inventory.suppliers(id) on delete restrict,
  order_number text not null,
  status inventory.purchase_order_status_enum not null default 'draft',
  currency_code char(3) not null default 'GBP',
  subtotal_cents integer not null default 0 check (subtotal_cents >= 0),
  notes text,
  created_by uuid references core.user_profiles(id) on delete set null,
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references core.user_profiles(id) on delete set null,
  sent_at timestamptz,
  sent_to_email text,
  send_error text,
  cancelled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (business_id, order_number)
);

create table if not exists inventory.purchase_order_lines (
  id uuid primary key default extensions.gen_random_uuid(),
  purchase_order_id uuid not null references inventory.purchase_orders(id) on delete cascade,
  product_id uuid not null references inventory.products(id) on delete restrict,
  product_name_snapshot text not null,
  pack_size_snapshot numeric(12,3),
  suggested_quantity integer not null check (suggested_quantity >= 0),
  ordered_quantity integer not null check (ordered_quantity >= 0),
  unit_cost_cents integer check (unit_cost_cents is null or unit_cost_cents >= 0),
  line_total_cents integer not null default 0 check (line_total_cents >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (purchase_order_id, product_id)
);
```

`order_number` follows the **gapless-and-idempotent counter pattern already proven by
`billing.bill_counters` + `record_bill` in `0085`** — reuse that design rather than inventing
a second numbering scheme.

Permission seed in the same file, plus the matching `PERMISSION_CATALOG` entries in the same
commit ([§10](#10-permission-model)).

---

## 10. Permission Model

Currently the entire inventory controller is gated on the single key `inventory.manage`
(*"Manage products and stock"*, group `Operations`). Ordering authorises spend and needs its own.

### 10.1 Catalogue additions — `packages/domain/src/index.ts`, group `Operations`

| Key | Label | Requires |
| --- | --- | --- |
| `orders.view` | View purchase orders | — |
| `orders.manage` | Create and edit draft orders | `orders.view` |
| `orders.approve` | Approve and send orders to suppliers | `orders.view` |

### 10.2 Default posture

- `owner`, `group_admin` — all three (derived automatically from `ALL_PERMISSIONS`).
- `manager` — `orders.view` + `orders.manage`. **Not** `orders.approve` unless Luke says
  otherwise; approval is the spend control.
- `stylist`, front desk — none.

**Do not add anything to `DEFAULT_ROLE_PERMISSIONS.manager`.** Memberships without an explicit
`security_level_id` fall back to role defaults, which would hand every unassigned front-desk
user ordering rights. Managers get keys through the `manager` security level, never the role
default — this is the `0074` lesson.

### 10.3 Audit

Every submit / approve / send / edit-after-approval writes `AuditService.record()`. Add
`'purchase_order'` to the audit entity-type union; `'stock'` already exists.

---

## 11. Algorithms

### 11.1 Colour prep (ticket 5)

```
input: locationId, from, to
1. appointments := booking.appointments
     where location_id = locationId
       and scheduled_start_at in [from, to]
       and status in ('pending','confirmed')
2. join booking.appointment_services → booking.services → booking.service_categories
   keep only rows where service_categories.billing_category is not null      -- B1
3. for each appointment:
     formula := latest lab.formulas
       where client_profile_id = appt.client_profile_id and status = 'saved'
       order by saved_at desc limit 1
     if none → emit { appointment, status: 'no_formula_on_file' }   -- never drop silently
4. required[product] := Σ formula_items.captured_grams across appointments
5. apply location_settings.waste_allowance_percent (default 10) as an uplift
6. onHand[product] := location_stock.quantity_on_hand_grams
7. shortfall[product] := max(0, required − onHand)
```

Step 5 reuses a setting that already exists and is already meaningful to Luke — do not invent
a second waste figure.

Step 3's `no_formula_on_file` case is the reason to prefer the category mapping over inferring
colour from formula history: a first-time colour client has no formula, and must still appear
in the plan as "needs consultation", not vanish from it.

### 11.2 MOQ round-up (ticket 8)

```
usagePerWeek   := Σ|delta| over outbound movement types in the trailing
                  reorder_usage_window_weeks ÷ that window
forecast       := usagePerWeek × reorder_coverage_weeks
shortfallBase  := max(0, forecast + threshold − onHand)
packs          := ceil(shortfallBase ÷ pack_size)
packs          := max(packs, minimum_order_quantity)
packs          := ceil(packs ÷ order_multiple) × order_multiple
```

Outbound types only (`formula_usage`, `formula_waste`, `retail_sale`, and scanned
consumption). A `restock` is not usage, and counting it would inflate every forecast.

### 11.3 Markup precedence (ticket 10b)

Exactly one multiplication, most-specific source first:

```
resolveColourCharge(costCents, product, colourCategory, locationSettings):
  1. product.lab_markup_percent   != null → base := cost × (1 + p/100),  source 'product'
  2. serviceBillingRule(category).salon_markup_percent > 0
                                          → base := cost × (1 + c/100),  source 'category'
  3. locationSettings.productBillingEnabled
                                          → base := existing helper,     source 'location'
  4. otherwise                            → base := cost,                source 'none'
  then apply round-up ONCE if productRoundUpEnabled
  return { amountCents, source }
```

Returning `source` matters: the bill needs to explain the figure, and the regression tests
need to assert *which* rule fired, not only the amount.

### 11.4 Dead stock (ticket 7)

```
lastOutbound := max(created_at) from stock_movements
                where product_id, location_id and quantity_delta_grams < 0
daysIdle     := now() − coalesce(lastOutbound, location_stock.created_at)
threshold    := coalesce(product.dead_stock_days,
                         location_settings.dead_stock_days_default)   -- 90
dead         := daysIdle >= threshold and quantity_on_hand_grams > 0
```

Outbound-only again, and `quantity_on_hand > 0` — a product at zero is not dead stock, it is
out of stock. Changing a threshold recomputes on read; nothing is materialised.

---

## 12. API & Domain Contracts

### 12.1 Extend `InventoryProduct` and `UpsertInventoryProductRequest`

```ts
supplierId?: string;  supplierName?: string;      // resolved for display
stockUnit: 'gram' | 'millilitre' | 'unit';
packSize?: number;
minimumOrderQuantity: number;
orderMultiple: number;
barcode?: string;
deadStockDays?: number;
// CR (ticket 10)
isSalonUse: boolean;  isLabUse: boolean;  isRetail: boolean;
labMarkupPercent?: number;
```

### 12.2 New endpoints

| Method | Route | Permission | Ticket |
| --- | --- | --- | --- |
| `GET/POST` | `/inventory/suppliers` | `inventory.manage` | 1 |
| `PATCH/DELETE` | `/inventory/suppliers/:id` | `inventory.manage` | 1 |
| `POST` | `/inventory/products/bulk-classify` | `inventory.manage` | 10a |
| `GET` | `/inventory/colour-prep?locationId&from&to` | `inventory.manage` | 5, 6 |
| `GET` | `/inventory/dead-stock?locationId` | `inventory.manage` | 7 |
| `GET` | `/inventory/scan?barcode=` | `inventory.manage` | 3 |
| `POST` | `/inventory/consumption` | `inventory.manage` | 3 |
| `GET` | `/orders?status&supplierId&locationId` | `orders.view` | 8, 9 |
| `POST` | `/orders/generate` | `orders.manage` | 8 |
| `GET/PATCH` | `/orders/:id` | `orders.view` / `orders.manage` | 8 |
| `POST` | `/orders/:id/submit` | `orders.manage` | 9 |
| `POST` | `/orders/:id/approve` | `orders.approve` | 9 |
| `POST` | `/orders/:id/send` | `orders.approve` | 9 |

New module `apps/api/src/orders/` (`orders.controller.ts`, `orders.service.ts`, `dto.ts`,
`orders.module.ts`, `orders.service.spec.ts`) — mirroring the `bills` and `eod` modules
delivered in Week 5.

### 12.3 Key response shapes

```ts
export interface ColourPrepPlan {
  locationId: string; from: string; to: string;
  appointments: ColourPrepAppointment[];   // incl. 'no_formula_on_file' entries
  products: ColourPrepProduct[];           // requiredGrams, onHandGrams, shortfallGrams
  totalShortfallProducts: number;
}

export interface PurchaseOrder {
  id: string; orderNumber: string; supplierId: string; supplierName: string;
  locationId: string; status: PurchaseOrderStatus;
  lines: PurchaseOrderLine[]; subtotalCents: number;
  submittedAt?: string; approvedAt?: string; approvedBy?: string;
  sentAt?: string; sentToEmail?: string; sendError?: string;
}
```

---

## 13. Delivery Plan

### Phase 1 — Stock engine & colour prep · 60 h

**W6-A · Migration `0089` + product/supplier metadata — *1.5 d, BLOCKER*** *(ticket 1)*
DDL per [§7](#7-migration-0089--stock--supplier-foundation); domain types; `UpsertInventoryProductDto`;
`inventory.service.ts` read/write; supplier CRUD endpoints; web product form + new
`/inventory/suppliers` tab. Includes the retail-sale defect fix and the pre-flight data audit.

**W6-B · Unified stock deduction service — *2.0 d, the core*** *(ticket 4)*
One service both paths call. Preserve `save_formula`'s reversal netting and
`adjust_location_stock`'s cost snapshot + alert raising. Unit conversion per
[§6](#6-the-unit-model). Negative-stock policy applied in one place, driven by
`allow_negative_stock`. Regression tests on Lab save, Lab **re-save**, retail sale, manual
adjustment.

**W6-C · Lab deduction "where configured" — *0.5 d*** *(ticket 2)*
Gate on `location_settings.stock_deduction_enabled` and `products.is_lab_use`; keep the
`inventoryDeductionRequested` payload flag as a draft-save override only.
⚠️ `is_lab_use` is a CR column — if the CR is unfunded, ship the location gate alone and add
the product gate when it lands.

**W6-D · Colour prep service — *2.5 d*** *(ticket 5)*
Migration `0090` + service-category settings control; algorithm per
[§11.1](#111-colour-prep-ticket-5); `GET /inventory/colour-prep`; domain contracts.

**W6-E · Prep planning views — *1.0 d*** *(ticket 6)*
New `/colour-prep` page: Today / This Week / Next Week / Custom, aggregate prep table,
shortfall highlighting, URL-synced state (the shareable-link pattern Luke asked for in Week 5).

### Phase 2 — Ordering · 44 h

**W6-F · Dead stock alerts — *1.0 d*** *(ticket 7)* — [§11.4](#114-dead-stock-ticket-7); global
default + per-product override; alert surface reusing the `low_stock_alerts` shape.

**W6-G · Automated order forms — *2.0 d*** *(ticket 8)* — migration `0091`; suggested-order
computation per [§11.2](#112-moq-round-up-ticket-8); supplier grouping; editable draft UI.

**W6-H · Approval, supplier email, history — *2.0 d*** *(ticket 9)* — status workflow,
permission gates per [§10](#10-permission-model), audit on every transition, order email
template in `apps/api/src/email/templates/`, send-failure surface, order history page.

**W6-I · Ordering tests — *0.5 d***

> Treat G and H as one unit. A half-built approval flow merged to `develop` is worse than
> not starting.

### Phase 3 — Barcode & classification · 46 h

**W6-J · Barcode consumption — *1.0 d (web) / 2.5 d (camera)*** *(ticket 3)*
**Recommended: web + USB HID wedge scanner.** A wedge scanner types the barcode as keyboard
input — needs a focused capture field, `barcode → product` lookup, quantity entry and an
unknown-barcode "link or create" flow. No native module, no EAS rebuild, no app-store cycle.
The camera alternative is viable (`apps/sheer-app` is Expo with EAS configured, so
`expo-camera` is available) but adds a dev-client build, permissions and a release cycle.
`apps/sheer-lab` is bare React Native (BLE only) and would cost more again.

**W6-K · Classification surfaced — *1.5 d*** *(ticket 10a)*
Flags through domain → DTO → service → UI; conditional fields (markup only when Lab, retail
price only when Retail); bulk apply across range/selection; gate the retail product picker on
`is_retail`. **Build with W6-A if funded** — same DTO, same service, same 1,168-line form.

**W6-L · Markup reconciliation — *1.75 d*** *(ticket 10b)*
[§11.3](#113-markup-precedence-ticket-10b) in `product-billing.helper.ts`, with tests, plus
confirmation that stored bills (`record_bill`, `0085`) are unaffected.

**W6-M · Regression tests — *1.0 d***
**W6-N · Documentation + LOH demo seed — *0.5 d***
Extend `apps/api/scripts/` with a Week 6 seed: products with suppliers and MOQ, a stocked
location, an upcoming colour appointment with a prior formula, and a deliberate shortfall that
produces a draft order. As in Week 3.2, the seed is a **hard dependency for the demo**.

---

## 14. Effort Estimate

| Step | Ticket | Days | Hours |
| --- | --- | --- | --- |
| W6-A Foundation migration + metadata | 1 | 1.5 | 12 |
| W6-B Unified deduction engine | 4 | 2.0 | 16 |
| W6-C Lab "where configured" | 2 | 0.5 | 4 |
| W6-D Colour prep service (incl. B1) | 5 | 2.5 | 20 |
| W6-E Prep planning views | 6 | 1.0 | 8 |
| **Phase 1** | | **7.5** | **60** |
| W6-F Dead stock alerts | 7 | 1.0 | 8 |
| W6-G Automated order forms | 8 | 2.0 | 16 |
| W6-H Approval + email + history | 9 | 2.0 | 16 |
| W6-I Ordering tests | — | 0.5 | 4 |
| **Phase 2** | | **5.5** | **44** |
| W6-J Barcode (wedge path) | 3 | 1.0 | 8 |
| W6-K Classification surfaced | 10a | 1.5 | 12 |
| W6-L Markup reconciliation | 10b | 1.75 | 14 |
| W6-M Regression tests | — | 1.0 | 8 |
| W6-N Docs + demo seed | — | 0.5 | 4 |
| **Phase 3** | | **5.75** | **46** |
| **Total** | | **18.75** | **150** |

**Budgeted: 40 h. Estimated: 150 h.**

Week 5 delivered eight tickets inside 40 h, so the low end is defensible — but Week 5 built on
existing foundations, while Week 6 changes the unit model underneath billing and adds a
spend-authorising workflow with its own permission surface. Treat 150 h as the working number.

---

## 15. Extension Request

**The 40 h budget does not reach a demonstrable milestone.** It funds W6-A, W6-B and W6-C —
tickets 1, 2 and 4 — which is the foundation and the engine. Architecturally essential,
visually nothing. There is no screen to show Luke at the end of it.

### The ask

| Option | Hours | Cost @ $30/hr | Delivers |
| --- | --- | --- | --- |
| **Minimum viable week** | **+20 h** | **+$600** | Phase 1 complete — colour prep with live shortfalls, a real demo |
| Ordering block | +44 h | +$1,320 | Phase 2 — draft order → approve → supplier email |
| Barcode + change request | +46 h | +$1,380 | Phase 3 — scan-to-deduct, per-product pricing |
| **All ten tickets** | **+110 h** | **+$3,300** | Week 6 as scoped in Wrike |

### Recommendation

**Ask for +20 h now, and quote Phases 2 and 3 as separately-scheduled weeks (6.2 and 6.3).**

Reasons to phase rather than request all 110 h at once:

- Each phase ends on a working demo and its own migration, so an unfunded phase leaves no
  dead schema behind.
- The change request already requires separate written sign-off and an hours agreement —
  bundling it into one number invites a single "no" to the whole week.
- Ordering (7, 8, 9) is one continuous piece; scheduling it as its own week is cleaner than
  half-delivering it inside an extended Week 6.
- +$600 to turn an invisible week into a demonstrable one is a much easier conversation than
  +$3,300, and it buys the item Wrike itself calls *"the core colour/inventory moat."*

**If Luke declines any extension:** deliver W6-A, W6-B, W6-C and demo the engine through the
existing stock screens and a Lab save — honest, but expect the review to feel thin. Say so in
advance rather than at the meeting.

---

## 16. Testing Plan

| Area | Cases |
| --- | --- |
| Unit conversion | gram/ml/unit products; pack↔base round-trip; null `pack_size` raises |
| Unified deduction | Lab save; **Lab re-save reversal netting**; retail sale; manual adjustment; all four produce reconciling movements |
| Negative stock | `allow_negative_stock` true → flagged; false → blocked with a usable error |
| Lab gating | location off; product `is_lab_use` false; draft-save override |
| Colour prep | appointment with formula; **without** formula; non-colour category excluded; waste allowance applied; shortfall arithmetic |
| MOQ round-up | below MOQ → MOQ; non-multiple → next multiple; zero shortfall → no line |
| Dead stock | restock does not reset idle; zero on-hand excluded; threshold change recomputes |
| Order workflow | permission matrix per role; approve without `orders.approve` rejected; send failure recorded |
| Markup precedence | each of the four sources fires in isolation; **never twice**; assert `source` not just amount |
| Stored bills | `record_bill` figures unchanged by markup work |

---

## 17. Questions for Luke Before Implementation

**Blocking — code cannot be written**

1. **How do we identify a colour appointment?** Proposal: tag each service category with a
   colour billing category (`0090`). The alternative — infer from the client's formula
   history — misses every first-time colour client, which is the exact case colour prep is
   for. *Blocks tickets 5 and 6.*
2. **Markup precedence.** Proposal: product → category → location, most specific first,
   applied exactly once. *Blocks ticket 10b.*

**Commercial — settle before day one**

3. **Which phases are funded?** See [§15](#15-extension-request). This changes migration
   design: `0091` should not ship unless Phase 2 is going ahead.
4. **Is the change request approved, and at what hours?** Affects day one — classification
   shares the DTO, service and product form with ticket 1.
5. **Week 5 sign-off**, and fixing its Wrike statuses (see [§19](#19-wrike-hygiene)).

**Long lead time — ask now, needed later**

6. **Barcode surface:** web + USB wedge scanner, or in-app camera? 1 day vs 2.5 — but ask
   Monday because a wedge scanner has to be ordered and delivered.
7. **Supplier order email contents:** letterhead, account number, delivery address, PO
   reference? Same shape as the Week 5 bill-email wording question, which is still open.

**Proceeding on these assumptions unless told otherwise**

| Question | Assumption |
| --- | --- |
| Negative stock: block or flag? | **Allow + flag**, config-driven — blocking a Lab save mid-service is disruptive |
| Can a manager approve/send orders? | **Owner only** by default; owner-configurable |
| Dead-stock threshold levels? | **Global default (90 d) + per-product override**; no category tier |
| Usage window for reordering? | **Trailing 8 weeks**, coverage 4 weeks, both configurable |
| Retail products with no pack size | **Block the sale** until a size is recorded, after a backfill pass |

---

## 18. Risks & Mitigations

| Risk | Mitigation |
| --- | --- |
| Unit-model change regresses billing | W6-B lands with tests before anything reads new units; stored bills are ledger-anchored and re-verified |
| Markup precedence changes historical bills | Stored bills freeze display lines at `confirmPayment`; confirm no recompute path touches settled bills |
| Negative-stock constraint breaks existing data | Audit for negatives before adding it; backfill a `correction` movement |
| Retail raise blocks live sales | Audit `is_retail and size_value is null` first; backfill pack sizes in the same migration window |
| Migrations 0083–0088 not applied everywhere | Verify applied state **before** authoring `0089`; `0079` was applied to dev-test out-of-band and the repo file is the reconciliation |
| New permission keys silently stripped | Ship migration seed + `PERMISSION_CATALOG` in one commit (`0074` precedent) |
| Barcode becomes an app-store cycle | Take the wedge-scanner path unless Luke needs in-app camera |
| Phase 2 unfunded after `0091` ships | Do not ship `0091` until Phase 2 is confirmed |
| Demo has nothing to show | W6-N seed is scheduled, not opportunistic; and see [§15](#15-extension-request) |

---

## 19. Branch / Commit Plan

Branch `feature/week6-stock-colour-prep` off `develop` for Phase 1.

1. `feat(inventory): migration 0089 — suppliers, ordering metadata, unit model`
2. `fix(billing): retail sale must not silently skip stock deduction`
3. `feat(inventory): unified stock deduction service with unit conversion`
4. `feat(lab): gate stock deduction on location and product configuration`
5. `feat(inventory): migration 0090 + colour prep service`
6. `feat(web): colour prep planning date-range views`
7. `chore(docs): week 6 plan and demo seed`

Phase 2 → `feature/week6-2-ordering`. Phase 3 → `feature/week6-3-barcode-classification`.
Each phase merges to `develop` on its own demo.

---

## 20. Wrike Hygiene

Week 5's parent is still `Active` and seven of its eight subtasks still read `Deferred`
despite being delivered and merged into `develop` — only the slot-size ticket is `Completed`.
Close these before the next review; the demo agenda is built from Wrike status.
