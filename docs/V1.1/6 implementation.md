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
