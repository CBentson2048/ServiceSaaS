# V1.1 Adjusted Week 6 — Stock, QLAB & Colour Prep: implementation record

**Branch:** `feature/week6-stock-colour-prep` off `develop` @ `4deca59`
**Migration:** `0091_week6_stock_colour_prep.sql`
**Scope basis:** QLOOQO V1.1 Client Approval Baseline, 19 August 2026 (adjusted Week 6)

Ordering, suppliers and purchase orders are **Week 7** and are deliberately absent here.

---

## 1. What the week changed

| Area | Before | After |
| --- | --- | --- |
| Stock units | Everything implicitly grams; retail multiplied by `size_value` | `products.stock_unit` + `pack_size`; one conversion helper at the boundary |
| Lab deduction gate | A **client-supplied** payload flag defaulting to true | `core.location_settings.stock_deduction_enabled` AND the payload flag |
| Negative stock | Silently possible everywhere | `allow_negative_stock` per location; allow-and-flag by default, refusable |
| Retry safety | None — a resubmitted adjustment deducted twice | `idempotency_key` on movements; the RPC replays instead of re-deducting |
| Barcode | No column, no lookup, no consumption path | `products.barcode` (unique per business), `GET /inventory/scan`, `POST /inventory/consumption` |
| Colour identification | Impossible — nothing linked a service to a colour category | `booking.service_categories.billing_category` |
| Colour Prep | Did not exist | `GET /colour-prep`, `/colour-prep` screen, four planning ranges |
| Retail sale defect | Silently skipped deduction when `size_value` was null | Resolves the quantity explicitly and raises when it cannot |

---

## 2. Two decisions worth knowing

**Deduction is NOT gated on `products.is_lab_use`.** The obvious reading of
"deduct where configured" is to gate on the product classification shipped in
`0079`. That would have been a live-data landmine: `0079` backfilled
`is_lab_use = true` only for rows with `created_at < 2026-08-05`, and the four
classification columns have never had a write path (no DTO, no form, zero
TypeScript references). Gating on the column would have silently stopped
deducting stock for every product created since 5 August. The gate is therefore
the **location setting**, and `0091 §2c` repairs the classification gap by
applying the same rule `0079` intended. Week 6 also gives those columns their
first write path, so they stop being dead.

**`quantity_on_hand_grams` was not renamed.** For a `stock_unit = 'unit'` product
the column now counts items, so the name is wrong. Renaming it touches
`adjust_location_stock`, `save_formula_with_reconciliation`, `record_retail_sale`,
the inventory service, the dashboard, the ZAC stock tool and two mobile screens —
a cosmetic day inside a delivery week. The column carries a comment recording the
real meaning; the rename is logged as technical debt.

---

## 3. How QLAB reaches inventory

`lab.save_formula_with_reconciliation` was already correct about the hard part and
was left alone apart from the gate. On every save it:

1. reads the formula's **own movement ledger** and credits back the net previously
   deducted — derived from movements, not from `lab.formula_items`, so a draft
   save that never deducted adds nothing back;
2. writes a `formula_reversal` movement for that credit;
3. re-deducts `captured_grams + waste_grams` for the items now on the formula.

That reverse-then-re-deduct shape is what makes a **correction net correctly**
(30g → 20g leaves 20g consumed, not 50g) and what makes a **product swap** credit
product A while consuming product B. Because it reverses everything before
re-applying, an identical re-save is also naturally idempotent in net terms.

## 4. How Colour Prep answers the question

```
appointments in window at location, status in (pending, confirmed,
                                               awaiting_acceptance, checked_in)
  -> appointment_services -> services -> service_categories
       keep only categories with a billing_category            (colour work)
  -> client -> latest lab.formulas where status = 'saved'
       none? emit the appointment as `no_formula_on_file`      (never dropped)
  -> formula_items: required = captured_grams x (1 + waste_allowance_percent/100)
  -> sum per product across appointments
  -> compare with inventory.location_stock at that location
  -> state: sufficient | low_stock | shortfall | not_stocked | unmapped_product
```

Two rules matter for trust. A first-time colour client has no formula and still
appears, flagged for consultation. A formula line never linked to a catalogue
product surfaces as `unmapped_product` with its whole requirement outstanding —
missing data is never rendered as "enough stock".

The waste uplift reuses the existing `location_settings.waste_allowance_percent`
(default 10) rather than inventing a second waste figure.

Reads are set-based: one query per table for the whole window, stitched in
memory, because PostgREST cannot embed booking → lab → inventory across schemas
and a per-appointment query would be an N+1 on a screen opened every morning.

---

## 5. Date ranges

Windows are computed in **`core.locations.timezone`**, not server-local time. The
existing analytics helper uses `setHours(0,0,0,0)` and `getDay()`, which silently
drops a Monday-morning appointment whenever the API host runs west of the salon
and shifts every boundary by an hour across the BST/GMT transitions.
`colour-prep/date-range.ts` resolves boundaries through `Intl` and is covered by
21 tests including both 2026 clock changes.

Weeks are Monday-based, matching the rota. Custom ranges take inclusive local
dates, so "1st to 3rd" is three whole salon days.

---

## 6. Verification

| Layer | What it proves | How to run |
| --- | --- | --- |
| `colour-prep/date-range.spec.ts` | Range boundaries, DST, custom validation | `pnpm --filter @sheer/api test` |
| `inventory/unit-conversion.spec.ts` | Pack↔base, refusal to guess, decimal safety | as above |
| `colour-prep/colour-prep.service.spec.ts` | Prep rules, shortfall states, tenancy, N+1 shape | as above |
| `inventory/inventory-consumption.spec.ts` | Barcode resolution, idempotent retry, audit | as above |
| **`supabase/tests/week6_stock_colour_prep.sql`** | **The plpgsql arithmetic** — netting, swap, retry, gate, negative-stock refusal | `psql -d <scratch> -f supabase/tests/week6_stock_colour_prep.sql` |

The SQL suite exists because the reconciliation lives in plpgsql. The Jest specs
stub the Supabase client, so they can prove *which* RPC was called with *which*
payload but can never prove that a 30g → 20g correction nets to 20g. Case 02 of
the SQL suite proves it. **Both layers must be run before Week 6 is signed off.**

---

## 7. Demo

`pnpm --filter @sheer/api seed-week6-colour-prep -- --business <id> --location <id>`

Creates the colour-tagged category and two demo products with deterministic
stock: one comfortably covered, one deliberately short. The remaining steps
(service, clients, appointments) are done through the app so the walkthrough
exercises the real booking flow. Expected outcome is one shortfall, one in-stock
product, and one client flagged "No formula on file".

---

## 8. Follow-ups (not Week 6 acceptance blockers)

- Rename `quantity_on_hand_grams` → `quantity_on_hand_base` (tech debt above).
- Colour Prep is gated on `inventory.manage`, so stylists cannot open it. Widening
  it needs a new permission key seeded in **both** the migration and
  `PERMISSION_CATALOG` (the `0074` lesson) — deliberately out of Week 6.
- The barcode capture surface (wedge-scanner field or camera) is Week 7 UI. The
  API, domain rules and idempotency are done and tested here.

---

## 9. Addendum (2026-08-24) — ticket 1 completed: suppliers & ordering metadata

Branch `feature/week6-ticket1-supplier-metadata`, migration
**`0092_ticket1_suppliers_ordering_metadata.sql`**. This closes the half of
Wrike ticket 1 that 0091 did not cover.

| Piece | What shipped |
| --- | --- |
| `inventory.suppliers` | Business-scoped catalogue (name unique per business, contact email/phone, account reference, lead time, notes, active flag), RLS + trigger mirroring `inventory.categories` (0036) |
| `inventory.products` | `supplier_id` (ON DELETE SET NULL), `minimum_order_quantity` (packs, default 1), `order_multiple` (packs, default 1), `dead_stock_days` (nullable per-product override) |
| API | `GET/POST /inventory/suppliers`, `PATCH/DELETE /inventory/suppliers/:id` under the existing `inventory.manage` gate (owner-only delete); product create/update accepts and returns the new fields with `supplierName` resolved |
| Web | `/inventory/suppliers` tab (create/edit/deactivate/delete); product form now exposes stock unit, pack size, barcode, supplier, MOQ, order multiple and dead-stock days |
| Tests | `inventory/inventory-suppliers.spec.ts` — tenancy scoping, payload mapping, permission posture, conflict handling |

MOQ and order multiple are in **packs** (of `pack_size` base quantities) because
that is the unit a supplier sells in. No new permission keys: suppliers are
product metadata; the `orders.*` keys arrive with the Week 7 approval workflow.

---

## 10. Addendum (2026-08-24) — ticket 7: dead stock alerts

Migration **`0093_week6_dead_stock_alerts.sql`**. Dead stock = quantity on hand
with no **outbound** movement (any `quantity_delta_grams < 0`) for longer than
its threshold. Everything is **computed on read** — changing a threshold
reclassifies instantly, nothing is materialised or scheduled.

| Piece | What shipped |
| --- | --- |
| `core.location_settings.dead_stock_days_default` | Location-wide threshold, default 90 days; editable on the location settings screen ("Dead stock after") |
| `inventory.location_stock.created_at` | Idle-clock anchor for never-moved stock; backfilled from the pair's earliest movement |
| `inventory.dead_stock_report(uuid, uuid[])` | The set-based classification, one call per screen; partial index on outbound movements keeps it a point read |
| API | `GET /inventory/dead-stock?locationId` under `inventory.manage`; items decorated with product/supplier/location names and `estimatedValueCents` |
| Web | "Dead stock" section on `/inventory` — idle days vs threshold (and which threshold fired), last-used date or "Never used", tied-up value |
| Seed | `pnpm --filter @sheer/api seed-dead-stock -- --business <id> --location <id>` — backdated history: one dead by location default, one dead by product override ("Never used"), one alive control |

**Rules, deliberately:** a restock never resets the idle clock (a delivery is
not usage); zero on hand is *out of stock*, not dead stock; threshold
precedence is `products.dead_stock_days` (0092) → location default → 90.
A never-moved product anchors to its first movement, else the shelf record.

**Verification:** `inventory-dead-stock.spec.ts` (Jest — scope, permissions,
decoration) and `supabase/tests/week6_dead_stock_alerts.sql` (12 cases — the
classification arithmetic itself). The old `week6_stock_colour_prep.sql`
fixtures used `p1/p2/p3` in UUID literals (`p` is not hex) and would have
failed on first run; fixed to `f1/f2/f3` in the same change.

## 10b. Addendum (2026-08-25) — colour-work tagging UI

The §4 "open assumption" gap closed: `billing_category` (0091) finally has a
write path a salon can use. The Service management → Categories form gains a
**"Colour billing category"** dropdown (Not colour work / Permanent colour /
Lightener & bleach / Semi & toners / Special treatments) and the categories
table a **"Colour work"** badge column; Colour Prep's empty state now links
straight to that screen. No migration — the column shipped in 0091. The
category PATCH also had the `in`-operator partial-update trap (description and
colour would have been wiped by a partial PATCH); fixed to `!== undefined`
while adding the field. Colour Prep page itself was rebuilt the same day to the
house design language (KPI cards, severity-sorted mixing list, day-grouped
schedule, print action).

---

## 10c. Addendum (2026-08-26) — Product Use Classification & Pricing (approved CR)

The CR is commercially approved; Luke's final rules are implemented in full.
Migration **`0096_retail_pricing_and_classification.sql`**.

**Three separate concepts, kept separate end to end:**
1. **Use classification** — the existing 0079 booleans (`is_retail`,
   `is_salon_use`, `is_lab_use`), multi-select, now editable on the product
   form ("Product use").
2. **Location availability** — where a product is stocked/sold. NO new table:
   an ACTIVE `inventory.location_stock` row IS availability (the existing
   structure already models product+location+active with the right uniqueness
   and indexes). "Available locations" checkboxes on the product form;
   `GET/PUT /inventory/products/:id/availability`.
3. **Pricing** — the new Pricing tab under Product management.

**The retail picker** (`GET /retail-sales/sellable?locationId`) shows a product
only when Retail AND available at the location AND active — the till modal now
uses it, with the canonical price prefilled and its source shown.

**Pricing precedence (authoritative):** location product → product default →
location category → category default → location default. First configured rule
wins and STOPS; rules never stack. Every level supports percentage markup OR a
fixed selling price (a FINAL price, not an uplift). **NULL inherits; explicit
0% is a real zero-markup override** — enforced at DB (row-absence vs
`markup_percent = 0`), API (`!== undefined` checks), resolver, UI (blank input
is invalid, never coerced to 0) and tests. With no rule at any level, the
legacy `products.retail_price_cents` applies exactly as before — the table
ships empty, so **no salon's price moves because the schema landed**.

**One canonical resolver:** `resolveRetailPricing` in `packages/domain` (pure);
consumed by the API's effective endpoint, the batch picker resolution (one
rules query for any product count — no N+1), the till, and the DB acceptance
harness. Provenance is part of the result: price, mode, configured value,
effective markup (derived for fixed prices, null when cost is 0/missing —
never divide-by-zero, never fabricated), source + rule id + label. Rounding is
the house convention: integer cents, `cost + round(cost × pct / 100)`.

**Transaction lock point:** a retail sale is single-shot — the price locks at
`POST /retail-sales`. The service resolves canonically (or accepts a till
override, snapshotted as source `manual`) and `record_retail_sale` persists
cost, mode, source, configured value and effective markup into the sale row.
Completed sales are never recomputed; history reads stored values only.
Rule changes are audited (`retail_pricing.rule_set/rule_cleared`).

**Permissions:** the whole pricing surface sits behind
`settings.billing.manage` (owner + manager per existing contracts); location-
bound rules re-check the caller's location scope; stylists/front-desk gain
nothing. The picker itself needs only `retail.record`.

**Verification:** resolver matrix `retail-pricing.resolver.spec.ts` (27 cases —
every precedence level, null-vs-zero, fixed semantics, rounding),
`retail-pricing.service.spec.ts` (validation/tenancy/batch),
`retail-sales.service.spec.ts` (lock point, manual override, picker filters,
historical immutability), `pricingRuleForm.spec.ts` (blank≠0 at the UI
boundary), and harness Phase E (constraints on the real DB + **Luke's §43 UAT
chain executed against real rows**: £18 → £13 → £12.50 → £12 → £11 → 0%→£10 →
fixed £17, plus the completed-sale-unchanged proof). **Action: apply 0096 in
the dev_test SQL editor, then `pnpm --filter @sheer/api week6-acceptance`.**

---

## 11a. Addendum (2026-08-25) — Week 6 closure pass

**Ticket 3 completed.** The scan-to-consume surface now exists on `/inventory`
(Operations column): a focused input built for USB/Bluetooth wedge scanners —
scan → product resolves with identity and shelf level → quantity in the
product's real unit → Enter confirms → deduction lands through the existing
`adjust_location_stock` RPC with an idempotency key per scan (a retried or
double-fired Enter can never deduct twice). Unknown barcode, archived product,
out-of-scope location, permission refusal and server failure are five distinct,
visible states. All decisions live in the pure module
`apps/web/src/components/inventory/scanConsumption.ts` (23 DOM-free tests, per
the repo's no-jsdom testing policy); the API side was already covered by
`inventory-consumption.spec.ts`.

**Real-database acceptance.** `pnpm --filter @sheer/api week6-acceptance` runs
40 behavioural cases against the actual dev_test database through the same
RPCs the platform uses (QLAB reconciliation incl. correction netting, swap,
identical re-save, waste, the deduction gate on/off and its safe defaults,
idempotent consumption, negative-stock refusal; the full dead-stock rule set;
purchase-order numbering/retry/snapshot/permission seeds; the colour-prep join
chain with tagged/untagged categories, cross-location and cross-business
isolation, no-formula and unmapped-product cases). Fixtures live under the
`a6000000-` UUID prefix and self-clean; `--keep` leaves them for UAT.
Result 2026-08-25: **39/40 PASS** — the one failure is the harness detecting
that **migration 0095 is not applied to dev_test** (see below).

**0095 closure fixes** (`0095_week6_closure_fixes.sql`): withdraws the direct
PostgREST read grants 0092/0094 gave `authenticated` on suppliers and purchase
orders (spend data must only flow through the permission-checked API), and
widens the one-open-order guarantee so an APPROVED-but-unsent order also blocks
a duplicate generate. The psql suite gained the matching case
(05_APPROVED_STILL_OPEN). **Action: apply 0095 in the dev_test SQL editor,
then re-run `week6-acceptance` — expected 40/40.**

Also folded in: a colour-prep fallback so a client whose last formula is very
old can never be mis-rendered as "no formula on file" when the formula query
hits PostgREST's row cap.

## 11b. Week 6 UAT demo script (deterministic)

Seeds first (idempotent):
`pnpm --filter @sheer/api seed-week6-colour-prep -- --business <id> --location <id>`
and `pnpm --filter @sheer/api seed-dead-stock -- --business <id> --location <id>`.

1. **Stock/QLAB** — note a product's stock on `/inventory`; save a QLAB formula
   using 30g of it; stock drops 30g and the movement log shows `formula_usage`.
   Re-save the same formula at 20g → net drop is 20g (movement log shows the
   reversal pair). Swap the product for another → first restored, second
   consumed.
2. **Barcode** — on `/inventory`, click into "Scan to consume", scan (or type +
   Enter) a seeded barcode → product card appears with shelf level → Enter →
   "consumed … on hand …" and the stock table refreshes. Scan `0000000000000`
   → amber "No product matches" with the add-barcode hint; nothing deducted.
3. **Colour Prep** — `/colour-prep`: Today / This week / Next week / Custom;
   the seeded appointments show the in-stock product, the exact shortfall on
   the short one, and the no-formula client flagged for consultation. "Print
   prep sheet" for the morning-bench copy.
4. **Dead stock** — `/inventory` Dead stock section: the seeded mask (~120 idle
   days vs 90) and never-used spray (30-day product override); record an
   outbound adjustment on one → it leaves the list; a restock does not.
5. **Ordering foundation** (not the demo centrepiece — its acceptance is the
   next block): `/orders` → Generate → the shortfall from the same stock model
   becomes a supplier-grouped draft with MOQ-rounded quantities, proving Colour
   Prep's shortfall feeds ordering with no architectural change.

## 11c. Week 7 stability — frozen contracts

A second developer can build on these without redesign; **coordinate before
modifying any of them**:

| Contract | Where | Rule |
| --- | --- | --- |
| Movement ledger | `inventory.stock_movements` | Append-only; outbound = negative delta; every deduction goes through `adjust_location_stock` or `save_formula_with_reconciliation` — never direct writes |
| QLAB reconciliation | `lab.save_formula_with_reconciliation` (0091) | Reverse-then-re-deduct from the formula's own ledger; do not add a second deduction path |
| Unit model | `products.stock_unit/pack_size` + `apps/api/src/inventory/unit-conversion.ts` | `quantity_on_hand_grams` holds BASE quantities; convert only at the boundary |
| Barcode consumption | `GET /inventory/scan`, `POST /inventory/consumption` | Idempotency key contract; UI logic in `scanConsumption.ts` |
| Colour Prep shortfall | `GET /colour-prep`, types in `packages/domain` | `sufficient/low_stock/shortfall/not_stocked/unmapped_product`; missing data is never "sufficient" |
| Reorder metadata | `products.supplier_id/minimum_order_quantity/order_multiple`, `orders/reorder-math.ts` | MOQ and multiple are in PACKS; suggestion = shortfall → packs → MOQ → multiple |
| PO lifecycle | `inventory.create_purchase_order` (0095 version) | Gapless numbers; OPEN = draft/pending_approval/approved; one open order per supplier+location |
| Permissions | `PERMISSION_CATALOG` + migrations | Every new key ships in BOTH places (0074 rule); new SECURITY DEFINER functions revoke PUBLIC execute (0078 rule) |
| Migration numbering | `supabase/migrations/` | Next free number is **0096**; never renumber an applied file |

**Product Use Classification / markup CR: PARKED, PENDING CLIENT APPROVAL** —
the 0079 fields keep their write path, but no classification UI, no `isRetail`
picker gating, no markup-precedence resolver until the CR is signed off.

---

## 11. Addendum (2026-08-24) — tickets 8 + 9: automated ordering with approval

Migration **`0094_week6_purchase_orders.sql`**. Built as one unit, per the plan
("a half-built approval flow merged to develop is worse than not starting").

| Piece | What shipped |
| --- | --- |
| Schema | `inventory.purchase_orders` / `purchase_order_lines` (name/pack snapshots) / `purchase_order_counters`; status enum draft → pending_approval → approved → sent, + cancelled |
| Numbering | `inventory.create_purchase_order(jsonb,jsonb)` — gapless per-business `PO-00001` via the 0085 bill-counter pattern; **one OPEN order per supplier+location** (partial unique index), so a retried generate returns the existing draft |
| Suggestion | `inventory.reorder_usage` (outbound-only aggregate) + `orders/reorder-math.ts`: forecast = trailing usage × coverage; shortfall → packs → MOQ → order multiple. Window/coverage are location settings (8/4 weeks, editable) |
| Permissions | `orders.view` / `orders.manage` / `orders.approve` — seeded in 0094 AND `PERMISSION_CATALOG` same commit (0074 rule). Managers prepare (view+manage via the manager level); **approve/send is owner + group_admin only** — the spend control. Nothing touches role defaults |
| API | `apps/api/src/orders/` — `GET/POST /orders`, `/orders/generate`, `PATCH /orders/:id`, `/:id/submit`, `/:id/approve`, `/:id/send`, `/:id/cancel`. Race-safe conditional transitions; every transition audited (`purchase_order.*`) |
| Email | `purchase-order.template.ts` → Resend. Quantities in packs, account reference, PO number to quote. Failure keeps the order `approved` with `send_error` recorded and a visible retry; costs deliberately not sent to the supplier |
| Web | `/orders` page (sidebar "Purchase orders"): generate per location, status filters, editable draft quantities, permission-gated Submit/Approve/Send/Cancel, history with send dates and failure banners |

Verification: `reorder-math.spec.ts` (the rounding chain), `orders.service.spec.ts`
(permission matrix, transitions, send outcomes, tenancy), and
`supabase/tests/week6_purchase_orders.sql` (7 cases — gapless numbering, retry
safety, snapshots, outbound-only usage window, permission seeds).

Open with Luke (flagged in the plan, defaulted conservatively): can managers
ever approve (currently no — grantable per business via security levels), and
the supplier email wording/letterhead.

---

A 28-agent adversarial review of the ticket 1 + 7 diff confirmed and led to
four fixes worth remembering:

1. **`dead_stock_report` needed `revoke ... from public, anon, authenticated`.**
   Postgres grants EXECUTE to PUBLIC on every new function; a SECURITY DEFINER
   function taking a caller-supplied business id is a cross-tenant read for any
   logged-in user until revoked (the 0071 bug, fixed in 0078; 0093 now revokes).
2. **Never use the `in` operator on a ValidationPipe DTO.** Pipe-built
   instances carry every declared field as an own `undefined` property, so
   `'field' in dto` is always true and a partial PATCH silently nulls whatever
   the caller omitted. `updateSupplier` now checks `!== undefined`; the same
   latent trap exists at pre-existing sites (`updateCategory`,
   `updateStockThreshold`, services) and should be swept in a follow-up.
3. **The supplier/ordering product columns are partial-upsert.** The lab
   station's product form does not round-trip them; full-upsert semantics would
   have reset supplier/MOQ on every lab edit.
4. The web settings form was saving every field EXCEPT the new
   `deadStockDaysDefault` — the edit looked live but never persisted.
