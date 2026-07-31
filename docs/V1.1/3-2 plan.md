# V1.1 Week 3.2 — Financial Rules Engine Workflow: Analysis & Implementation Plan

> **Nature of this document.** A deep analysis of the current codebase and a concrete implementation plan for turning the Week 3 Financial Rules Engine **database foundation** into a usable staff pay / commission / settlement workflow that Luke can review in the development environment. **This planning file changes no source code, migrations, env or packages, applies nothing to any database, and stages/commits nothing.** Every migration named here is *authored for review, not applied*.
>
> Date: 2026-07-30 · Status: **awaiting approval** — implementation has not started.
>
> **Basis.** Read directly against the working tree at commit `49d90d4` (branch `develop`): migrations `0071`–`0075` in full, `packages/domain/src/index.ts`, `apps/api/src/auth/*`, `apps/api/src/kpi/*`, `apps/api/src/rota/*`, `apps/web/src/{App,components/Sidebar,pages/CommissionPage}.tsx`, plus `docs/financial-rules-engine-principles.md`, `docs/payroll-loh-template.md`, `docs/payroll-competitor-review.md` and `docs/financial-rules-engine-verification-guide.md`. Findings were then put through three adversarial verification passes (data-source availability, permission enforcement, schema fit); corrections from those passes are folded in throughout and called out in [§15](#15-verification-log--claims-overturned).
>
> **Scope guard.** This document does not touch ZAC. Migrations `0076`–`0077` are ZAC's; the next free number for this work is **`0078`**.

---

## Naming note: why "3.2" and not "Week 4"

Per the V1.1 roadmap (Cosan's Revised Plan + Wrike project `4507147422`), contracted **Week 4 is "Diary, Search, Till & Bills"** — quick-action toolbar, global client search, per-location slot size, end-of-day cash-up, itemised bills, bill finder. Pay, commission and wage summaries were **Week 3** ticket scope.

Labelling this work "Week 4" would either silently displace the Till/Bills pillar or read as scope creep under a contract with strict change control ("anything outside the original V1.1 plan requires written approval *before* work"). It is more accurately **Week 3 completion** — the application layer for a Week 3 deliverable whose database half shipped.

This is a labelling and change-control matter, not a technical one. The work below is planned exactly as briefed regardless. **Action required:** confirm with Luke/Cosan whether this is booked as Week 3 completion (Till/Bills keeps its slot) or as a change request replacing it.

---

## 1. Executive Summary

Week 3 delivered a genuinely strong **database-only** Financial Rules Engine: 17 `payroll.*` tables, 23 enums, 11 functions, 17 RLS policies, and a set of immutability triggers better than most of the market surveyed. It is applied to dev_test (`0071`–`0075`) and merged to `develop` via PR #30 / commit `3f2df78`.

It has **zero TypeScript**. `grep -rn "schema('payroll')" apps/api/src` returns nothing. There is no `apps/api/src/payroll/`, no payroll type in `@sheer/domain`, no web route, and no calculation code of any kind. This is not a polish week — it is building the entire application layer on a finished schema.

Week 3.2 delivers, in dependency order:

1. **Unblock the permission layer.** Migration `0074` seeded seven `payroll.*` keys into `core.security_levels`, but its own header ordered a matching `@sheer/domain` change that **never shipped**. Two consequences: `@RequirePermissions('payroll.view')` cannot compile (`Permission` is a closed union), and — the live danger — `owner-security-levels.service.ts` **silently deletes** the seeded keys the first time any owner saves any security level.
2. **Fix seven schema defects** in one migration (`0078`). Two are hard blockers: a used pay-structure version **cannot be closed** (making the engine's central "change a rate → close the version, open a new one" promise impossible after the first pay run), and the **supersede/regenerate mechanism is unbuildable as designed** in every period status.
3. **Write the calculation engine** as a pure, deterministic function over resolved rule rows — new code, never derived from `kpi.calc.ts`, which differs from intent by **~7×, up to 14×**.
4. **Ship the pay-period workflow** (generate → ready → approve → lock → paid) and an owner/manager review UI where every figure drills to its source and every uncaptured source is labelled, never zeroed.
5. **Seed the Luke Ormsby Hair template.** Non-zero pay figures are *structurally impossible* today regardless of revenue data — there are no writers for any rule table and no working seed file. Without this, every screen renders empty at review.

The property to protect above all others: **accuracy and explainability over surface area**. A payslip only has to be wrong once.

---

## 2. Current Project Architecture Relevant to This Work

pnpm + turbo monorepo: `apps/api` (NestJS 10), `apps/web` (Vite + React 19 SPA), `apps/sheer-app` + `apps/sheer-lab` (Expo), `packages/*`.

| Area | Location | Convention to follow |
|---|---|---|
| API feature module | `apps/api/src/<name>/` | Flat: `<name>.module.ts`, `<name>.controller.ts`, `<name>.service.ts`, `dto.ts`, optional `<name>.calc.ts` + `*.spec.ts`. Register in `app.module.ts` |
| Supabase access | per-service | **No shared `SupabaseService`.** 40 services each construct their own service-role client from `ConfigService` (identical 5-line snippet). Target schemas with `.schema('payroll')`. **PostgREST cannot embed across schemas** — fetch separately and stitch by id in JS |
| Controllers | thin pass-throughs | `@UseGuards(SupabaseAuthGuard, RolesGuard, PermissionsGuard)` + `@RequireRoles(...)` + `@RequirePermissions(...)`, actor via `@CurrentUser()`. Scope resolved **inside the service** from `actor.businessId` / `actor.allowedLocationIds` |
| Permissions | `apps/api/src/auth/permissions.guard.ts` | Keys are the closed union + `PERMISSION_CATALOG` at `packages/domain/src/index.ts:266-346` |
| Domain types | `@sheer/domain` | New flat sibling `packages/domain/src/payroll.ts`, re-exported from `index.ts` (copy the `tax.ts` shape). `packages/types` is dead legacy; `packages/api-client` is sheer-lab-only |
| Response shape | bare camelCase | No envelope. Money as integer `*Cents`, dates ISO / `'YYYY-MM-DD'`. Hand-written private `toX(row)` mapper per service |
| Validation | global `ValidationPipe` | `forbidNonWhitelisted: true` — any undeclared query/body key returns 400. Numeric params need `@Type(() => Number)` before `@IsInt()` |
| Web pages | `apps/web/src/pages/` | Route in `App.tsx` (imperative `<Route>` list, gated by `<ProtectedRoute allowedRoles requiredPermissions>`); nav in `components/Sidebar.tsx:37-61` |
| Web data fetching | `apps/web/src/auth/api.ts` | **No react-query.** One exported fn per endpoint over a private `request<T>()`; pages own `useState` + `useCallback` + `useEffect` |
| Closest UI analogue | `pages/CommissionPage.tsx` + `components/kpi/StylistKpiDetailModal.tsx` | CSS-grid "table" + stat tiles + row → detail **modal**. No drawer/sheet component exists anywhere in web |
| Tests | colocated `*.spec.ts` | Jest 29 + ts-jest, `apps/api/jest.config.js`, `testMatch` `<rootDir>/src/**/*.spec.ts`. 39 suites / 369 pass / **229 `it.todo`**. Pure-calc model: `kpi/kpi.calc.spec.ts` |
| Migrations | `supabase/migrations/NNNN_snake_case.sql` | Idempotent `if not exists`, heavy header comments. Applied via `supabase db push` / SQL editor — **never** via MCP |

**Where this work lives:** `apps/api/src/payroll/` (new) · `packages/domain/src/payroll.ts` + permission edits in `index.ts` · `apps/web/src/pages/Payroll*.tsx` + `components/payroll/` + `auth/api.ts` · `supabase/migrations/0078_*.sql` · `docs/architecture/payroll-financial-rules-engine.md`.

### Build traps that will cost a day if not known

- `pnpm --filter @sheer/web typecheck` is a **no-op** — `apps/web/tsconfig.json` is a solution file with `"files": []`. Use `npx tsc -b`.
- `apps/web` resolves `@sheer/domain` from **dist**; `apps/api` typecheck/test resolve it from **source** (tsconfig paths / jest moduleNameMapper) while `nest build` resolves **dist**. A green API test run does not prove web compiles.
- `@sheer/domain` has no subpath export — `import from '@sheer/domain/payroll'` cannot work. Anything added must be re-exported through `src/index.ts`.
- `packages/domain/src/index.js`, `index.js.map` and `index.d.ts.map` are stale compiled artefacts committed inside `src/`. Unused, but they pollute diffs and mislead greps.

---

## 3. What Week 3 Already Completed

**Rule definition (`0071`)** — `pay_structures` (identity only; rates never here) → `pay_structure_versions` (effective-dated, GiST no-overlap, `effective_to` **exclusive**) → `pay_structure_stages` (ordered pipeline over 8 stage types, commission fields fail-closed by CHECK) → `pay_structure_bands` (rates as **rows**, exactly one lower bound enforced by XOR CHECK + basis-matching trigger, `accelerator_rate_percent` per band). Plus `accelerators` (all / any / at_least_n / weighted / custom, parameters constrained per mode) + `accelerator_conditions`, `version_hour_rules` (8 categories × `counts_toward_target` / `counts_as_paid`), `business_data_sources` (per-business capture matrix + `missing_data_sources(version_id)`), `staff_pay_assignments` (effective-dated, cross-business guard).

**Targets (`0072`)** — effective-dated at staff / location / business scope, three partial GiST exclusions. Explicitly **tracking only**; band thresholds are what move money.

**Output (`0073`)** — `payroll_settings` (Tuesday week anchor, timezone, calc vs payment frequency, auto-seeded for new businesses by trigger), `pay_periods` (calculation vs payment, one-level roll-up, GiST no-overlap per scope), `pay_summaries` (the full settlement figure set, `greater_of_applied`/`greater_of_winner`, `is_stale`, `inputs_snapshot`), `pay_summary_lines` (`source_type`/`source_id`/`occurred_on`, `vat_rate_percent_snapshot`, per-line `structure_version_id`, `source_unavailable` + CHECK forbidding a non-zero unavailable line), `pay_summary_hours`, `target_adjustments` (append-only, every field mandatory), `pay_adjustments` (carry-forward, freeze once applied).

**Integrity** — locked/paid periods physically immutable via an explicit column **allowlist** (only `exported_at`, `emailed_at`, `superseded_by_id`, `is_stale`, `stale_reason`, `updated_at` stay writable); status ratchet blocks backwards moves from locked; used rule versions freeze together with their stages, bands, accelerators, conditions and hour rules; deletion resists (staff with payroll cannot be deleted; a period with summaries cannot be deleted).

**Permissions (`0074`)** — 7 keys seeded into `core.security_levels`: owner/group_admin all six management keys + self-view, manager `payroll.view` only, stylist `payroll.self.view` only, receptionist deliberately nothing.

**Rename (`0075`)** — Service Revenue Target terminology, shipped through DB + domain + API + web.

**Tests** — `supabase/tests/payroll_validation.sql` (21 cases / 26 assertions) + `payroll_regression.sql` (19 cases / 25 assertions). These are `\echo`-labelled psql scripts graded by a **human** reading terminal output against a table in the verification guide. No assertion library, no exit code, no runner, invisible to `pnpm test`. **They test the schema, not any TypeScript.** Any status report saying "validation and regression test coverage" is done should be read as "two hand-run scripts plus a 428-line manual runbook".

---

## 4. Current Gaps

### 4.1 Blockers

| # | Gap | Detail |
|---|---|---|
| B1 | **`payroll.*` keys absent from `@sheer/domain`** | Not in the `Permission` union (`index.ts:266-297`) or `PERMISSION_CATALOG` (`:319-346`). `Permission` is a **closed union**, so `@RequirePermissions('payroll.view')` cannot compile — caught by `apps/api` `tsc --noEmit`. The live danger is different and worse: `auth.service.ts:645-648` filters level rows through `new Set(ALL_PERMISSIONS)`, and `owner-security-levels.service.ts:261` re-writes `permissions` through the same filter on **every save** — so the first time any owner edits any security level, the `0074` seed is **permanently destroyed with no error**. Verified: the dev_test rows are currently intact and correct. |
| B2 | **A used pay-structure version can never be closed** | `payroll.assert_rule_version_unused()` fires `before update` with **no column allowlist**, so `set effective_to = …` on a version referenced by any summary or line is refused — while `pay_structure_versions_no_overlap` means an open-ended version blocks any successor. The trigger's own error message instructs you to do exactly what it forbids. **After the first pay run, that structure's rates are frozen forever.** (Workaround if `0078` is rejected: create a new structure and re-point `staff_pay_assignments`, which are *not* frozen — but that abandons the shared-preset model and loses structure identity.) |
| B3 | **Supersede/regenerate is unbuildable as designed** | `superseded_by_id` is a **non-deferrable** self-FK (`0073:411`; `grep -in deferrable` across `0071`–`0073` returns nothing) sitting behind a **partial** unique index (`0073:447-449`). Insert-new-first violates the index (two live rows); update-old-first violates the FK (target doesn't exist); self-supersede is CHECK-blocked (`0073:424-425`). A data-modifying CTE doesn't help — both checks are immediate. The only working path is delete-then-insert, legal in draft/ready/approved only, which loses `generated_at`, mints a new summary id, and nulls `target_adjustments.summary_id`. |
| B4 | **Hosted Exposed Schemas unverified** | `supabase/config.toml:16,18` lists `payroll`, but config.toml governs **only** the local stack (`0071:49-52` says so). `0077:12-14` confirms supabase-js routes through PostgREST **even with the service role**, so exposure is load-bearing on every hosted project. Never exercised — no code has ever touched the schema. Omission = `PGRST106 "Invalid schema: payroll"` at runtime, and no amount of correct code fixes it. Could not be verified read-only; it lives in project config, not `pg_*`. |
| B5 | **Payroll responses would be logged in full** | `common/request-response-logging.middleware.ts:22` suppresses bodies for `/api/zac` only. Every wage figure would land in Railway logs. |
| B6 | **Pay-determining staff fields writable with only `staff.manage`** | `assertSensitiveStaffFields` (`staff.service.ts:904-918`) omits `average_bill_benchmark`, `contracted_hours`, `employment_type` and `holiday_entitlement_days`, and `toStaffMember` (`:1475-1482`) returns them outside the `includePayFields` gate. Since `accelerator_conditions` with `basis='staff_benchmark'` reads `average_bill_benchmark` (`0071:618-630`), **a manager without `staff.pay.manage` can move a stylist from the 15% band to the 30% accelerator rate.** Privilege escalation straight into money. |

### 4.2 Schema defects for `0078`

- **`pay_summary_hours` has no locked-period guard.** `pay_summaries` and `pay_summary_lines` are protected; the *hours evidence behind a locked target* is freely insertable, editable and deletable. `hours` also carries `check (hours >= 0)`, blocking downward corrections.
- **`assert_target_adjustment_immutable()` has a hole.** It only raises when `new.summary_id is not distinct from old.summary_id`, so an UPDATE that *also* changes `summary_id` can rewrite the reason, both amounts and the actor. Same class of hole deliberately closed on `pay_summaries` with an allowlist.
- **No `band_id` on `pay_summary_lines`.** The engine can price slices correctly but cannot record **which band** priced each one — a real hole against the per-band explainability Luke ranked third.
- **No accelerator outcome persistence.** `payroll.accelerators` has no config/jsonb column (so `evaluation_mode='custom'` is a dead enum value with nowhere to store its rule), and `pay_summaries` has no `accelerator_applied` flag and no per-condition pass/fail record anywhere.
- **Status ratchet is `before update` only** (`0073:855-857`) — an INSERT with `status='paid'` is completely unguarded. And `0073:834` is literally `if v_old >= 4 and v_new < v_old`, so `draft→paid` in one jump and `approved→draft` are both legal. No constraint ties `approved_at` / `locked_at` / `paid_at` / `*_by_user_profile_id` to the status they document.
- **Approval freezes nothing.** Only `locked` and `paid` engage `assert_period_not_locked()`. Summaries in a `ready_for_review` or `approved` period can be deleted, regenerated and rewritten at will — "approved" is a UI state with no database meaning.
- **Business-consistency triggers cover 2 of 17 tables.** `pay_summaries.business_id` is never checked against its period's or its staff member's business; `pay_periods.location_id` never against `business_id`; `targets` ids never against `business_id`.
- **`greater_of_winner` CHECK allows only `base_pay`/`commission`** — a chair-renter's `revenue_split` greater-of cannot record its winner, even though `in_greater_of_comparison` can be set on that stage.
- **Both non-trigger `SECURITY DEFINER` functions are granted to PUBLIC.** This is a **deviation from an established house pattern** applied in at least 7 other migrations (`revoke all on function X from public; grant execute … to service_role` — `0010:180`, `0011:215-218`, `0012:284-294`, `0015:150,276`, `0024:237`, `0029:269`, `0031:147-148`). `payroll.missing_data_sources(uuid)` is therefore a genuine **cross-tenant read leak** (returns stage labels and source names for any version id in any business) with a copy-paste fix.
- **RLS policies in `0071`/`0073` are not idempotent** (unlike everything else in those files) — re-running either file fails with `42710`.

### 4.3 Missing application layer — all greenfield

Version resolution `(staff, service date) → assignment → version in force`; timezone-correct local-date period generation; the stage/band/accelerator evaluator; the rota→hour-category resolver; commissionable-basis derivation from the six version policy columns; VAT de-grossing + snapshot; uncaptured-source surfacing (nothing reads `business_data_sources` or calls `missing_data_sources()`); the workflow endpoints; readiness/pre-flight checks; all UI; all automated tests; `is_stale` production; adjustment application.

### 4.4 Undefined contracts

`pay_structure_stages.config` jsonb is **undefined for 5 of 8 stage types** — only `base_pay` (`{"source":"hourly_rate_x_payable_hours"}`) and `greater_of` (`{}`) appear anywhere. `revenue_split` (split %), `chair_rent` (amount + cadence), `deduction` (fixed/percentage/service-specific), `bonus` (trigger + amount) and `tips_payout` have no keys defined, and `0071:428` says "validated per stage_type in the API DTO layer" — a layer that doesn't exist. **This is why a rule-authoring UI cannot be built responsibly this week.**

No documented spec exists for stage-evaluation order, rounding direction, how `greater_of` composes with `in_greater_of_comparison`, or how a mid-period version change splits a period.

### 4.5 Silent-error risks (reported from dev_test)

| Risk | Observation | Consequence |
|---|---|---|
| Silent £0 | `hourly_rate = 0.00` for **7 of 14** staff; `service_revenue_target_amount` NULL for **14 of 14**; `payroll.targets` empty | Base pay and every `multiple_of_base_pay` threshold compute to £0 with **no warning** |
| Silent 2× overpay | `average_bill_benchmark = 0.00` for **13 of 14** staff | An accelerator condition with `basis='staff_benchmark'` **trivially passes** (`actual >= 0`), promoting stylists from 15% to 30%. A doubling of pay with no error message |
| No demo data | Zero rows in every rule table; `database/seeds/` holds only `.gitkeep` + `README.md` | Non-zero pay is **structurally impossible** until a seed ships |

> Row counts above came from agents querying the dev_test branch read-only; one verification pass could not independently re-confirm them. Treat as indicative and re-check before the review.

---

## 5. Data Source Readiness Matrix

| Data source | Current status | Use now? | Risk | Recommended handling |
|---|---|---|---|---|
| **Service revenue** | **Live.** `booking.appointment_services.price_amount`, **staff-attributed** and fully populated, rolled up into a single `billing.visit_line_items` row of `line_type='service'` at completion | **Yes — primary** | **High:** `reconcileServiceLineItem` has exactly **one** call site (`lab-appointments.service.ts:1445`, inside `complete()`), and `replaceAppointmentServices` (`:1355-1425`) writes `appointment_services` without touching `visit_line_items` — so after a post-completion service change the two **permanently disagree** | Use `appointment_services` as the authority (per-service **and** staff-attributed). Reconcile to the penny against the rolled-up line the way `expandServiceLineItems` (`:2834-2856`) does, and surface any variance as a warning — never assume agreement |
| **VAT / commissionable basis** | **Live but per-location *configuration*, not an invariant.** `tax.ts:174`: `basis = displayMode === 'inc_tax' ? 'gross' : 'net'`. Nothing persists a per-transaction tax breakdown | **Yes** | **High:** on an `inc_tax` location, `vat_basis='exclusive'` would **double-count VAT** out of the commission base | Resolve `display_mode` per location, de-gross with `taxWithinGross` from `@sheer/domain`, and **snapshot the rate** into `pay_summary_lines.vat_rate_percent_snapshot` on every line |
| **Worked hours** | **Live but SCHEDULED only.** `rota.shifts.scheduled_start_at/end_at` minus unpaid `shift_breaks`. **No clock-in, no timesheet, no attendance.** All 194 dev_test rows are `published`; **0** are `completed`; `published_at` is NULL on all 194 (the web editor hardcodes `status:'published'`) | **Yes — labelled honestly** | High if presented as actual | Filter `status='published'`. Use the **overlap** query form from `KpiService.fetchShifts` (`kpi.service.ts:369-373`) — **not** `RotaService.fetchShiftsInRange` (`:2016-2037`), which filters on `scheduled_start_at` only and silently drops shifts straddling a period boundary. Label as "derived from published rota" |
| **Staff rate / employment type** | **Live** (`core.staff_profiles`), sparsely populated | **Yes + pre-flight gate** | **High — silent £0** | Block generation per staff member with an explicit readiness error. `employment_type` has no `chair_renter` value (enum is `employed`/`self_employed`/`hybrid`), so a renter's `employment_type_snapshot` will read `self_employed` |
| **Hour categories** | **`worked` only.** `sickness`/`training`/`authorised_absence` derivable from `absence_events.absence_type` + `book_out_type_id`. `paid_holiday` vs `unpaid_leave` **indistinguishable** — `rota.leave_requests` has no leave type and no paid flag, only `status` + free-text `reason`. `additional` and `manual_adjustment` have **no source**. Leave has dates but **no hours** | Partial | High | Populate what is real; write the rest as `pay_summary_hours` rows with 0 hours **plus an explanatory note**. Add `hour_category` to `rota.book_out_types` in `0078` so owners map it once instead of the engine guessing |
| **Product / colour cost (QLAB)** | **Conditionally live.** `visit_line_items.cost_amount_cents` (`0028`). Four gates: both writers early-return when `billing_rules.product_billing_enabled` is false (`:2165`, `:1151`); `costAmountCents <= 0` early-returns (`:2172`); the lab path needs opt-in `billingHandoffRequested` (`lab-formula.service.ts:334-336`); the column is **nullable**. Cost lands **per-visit with no staff column** | Only if a deduction stage is configured | **High** | Support `product_cost_mode='actual_usage'` but verify per location. **Two writers race:** both upsert `onConflict: 'visit_id,line_type'`, and PostgREST's DO UPDATE only sets payload columns — so a post-completion formula save overwrites `cost_amount_cents` with that single formula's cost while leaving multi-formula `metadata.product_breakdown` intact, producing a **self-contradicting row**. Treat any disagreement as a warning. **Do not** wire `lab-billing-rules` — it is unwired, feature-flagged off, and conflicts with the real path in `billing.billing_rules` |
| **Retail sales** | **Structurally present, not captured.** `billing.retail_sales`, `POST /retail-sales`, RPC `billing.record_retail_sale`, DTO and `retail.record` permission all exist — but **no client anywhere calls it** (zero grep hits in `apps/web/src`, `apps/sheer-app`, `apps/sheer-lab/src`, `packages/api-client/src`). 0 rows on dev_test. `staff_profile_id` is nullable | **No** | **High if assumed** | **Leave `is_captured = false` and make the flag read-only this week.** Flipping it would silence `missing_data_sources()` and make LOH retail commission pay **£0 instead of "source not captured"** — precisely the failure `principles.md` §4 forbids. Also means LOH accelerator condition #2 ("retail target achieved") can never legitimately pass, so the 30% rate is currently unreachable |
| **Tips** | **Missing.** No table, column or endpoint | No | — | `tips_paid_out_cents` / `tips_owed_cents` stay 0 + an unavailable line |
| **Refunds / voids** | **Missing, and needs a migration not just UI.** `salon_payments.amount_cents` has `check (>= 0)`, `payment_method` is `check in ('cash','card_reader')`, and `unique(visit_id, payment_method)` blocks offsetting rows. `visit_line_items.amount_cents >= 0` forbids negative corrections. `booking.visits.checkout_status='voided'` is a valid value nothing writes | No | — | Unavailable line. Reversal belongs to `pay_adjustments` once capture exists |
| **Cancellation fees** | **Missing.** A forfeited deposit leaves `booking.deposits` at `status='paid'` with only an `audit.activity_log` entry carrying no amount and no staff attribution | No | — | `cancellation_fee_share_percent` is honoured but evaluates to 0 → unavailable line |
| **Deposits** | **Live** (`booking.deposits` + Stripe) | Only as `total_collected_cents` | **High — double count** | Deposits are already inside the visit's service total. `deposit_recognition='on_completion'` ⇒ read `visit_line_items` only and **ignore deposits entirely**. `'on_collection'` ⇒ recognise `paid_at` **and** net them out of the service line, filtering `status='paid' AND appointment_id IS NOT NULL` (29 dev_test rows are dangling `pending` with a null appointment) |
| **Discounts** | **Missing.** No discount is recorded anywhere; the only discount column is `core.location_settings.discount_authorisation_threshold_percent`, a permission threshold | No | Medium | `discount_basis` values `actual_after_discount` and `custom_commissionable_value` are **unsatisfiable** — hide them in any UI or warn via the same missing-source mechanism |
| **Staff pay assignments** | **Table live, 0 rows** | Yes — must be seeded | Medium | Every screen renders empty until a structure + version + assignment exists. See ticket **W3.2-K** |

### 5.1 The £0 rule, made concrete

Two distinct unavailability classes need different handling, and conflating them is how an owner ends up trusting a figure that was never calculated:

- **Uncaptured transaction source** → a `pay_summary_lines` row with `source_unavailable = true`, `unavailable_source = <enum>`, `amount_cents = 0`. A DB CHECK already enforces the zero. Surfaced as *"This rule uses retail sales, but retail capture has not yet been enabled."*
- **Missing configuration input** (no hourly rate, no hour rules, no structure, zero benchmark) → **not a line**. A `readiness` error that **blocks generation** for that staff member. The schema has no equivalent of `missing_data_sources()` for this class, so it must be built in application code.

### 5.2 Pay inputs must be read server-side, never from an API response

**Binding on the calculation engine.** Every pay input — hourly rate, contracted
hours, average bill benchmark, employment type, holiday entitlement — must be
resolved **server-side from `core.staff_profiles`** with the service-role client.
The engine must never consume these from a client-facing response.

Both client-facing shapes redact them for callers without `staff.pay.manage`, and
neither redaction is detectable by a consumer:

| Shape | Endpoint | Redaction | Failure if consumed |
|---|---|---|---|
| `StaffProfileDetails` | `GET /profiles/*` | → **`0`** | Indistinguishable from a real zero. £0 base pay; a 0 benchmark makes `staff_benchmark` accelerator conditions pass trivially → stylist promoted to the accelerator rate |
| `StaffMember.staffProfile` | `GET /staff` | **omitted** | Arrives `undefined` → `NaN` in arithmetic, propagating silently |

Redacting to `0` on the profile shape is a deliberate trade-off: making those
fields optional would change `StaffProfileDetails`, which `apps/sheer-app` consumes
with `contractedHours` required. Accepted, with this rule as the mitigation.

### 5.3 Two structural limitations to document

- **`business_data_sources` is keyed `(business_id, source)` with no `location_id`**, yet both captured sources are location-gated in code. The capture matrix therefore **cannot express the truth** for a multi-location business.
- **Attribution must be snapshotted, never re-derived.** All three attribution columns are `on delete set null` (`appointments.assigned_staff_profile_id` `0004:84`, `appointment_services.assigned_staff_profile_id` `:114`, `visits.primary_staff_profile_id` `:161`) while `pay_summaries.staff_profile_id` is `ON DELETE RESTRICT` (`0073:350`). So a deleted staff profile is refused by payroll history but **silently erases attribution on every upstream revenue row** — a regenerate of an unlocked period would drop that revenue to nobody, with no error. Snapshot attribution into `inputs_snapshot` at generation.

---

## 6. Permission Model Plan

The plumbing is already mature and adopted at ~48 sites across 25 controllers: `PermissionsGuard` + `RequirePermissions`, `RolesGuard` + `RequireRoles`, `LocationScopeGuard`, `StylistSelfGuard`, `expandPermissions`, and server-side resolution in `auth.service.resolveAuthUser`. **This work builds no new permission machinery** — it registers keys and applies them.

### 6.1 Catalogue additions (`packages/domain/src/index.ts`, group `'Payroll'`)

| Key | kind | requires |
|---|---|---|
| `payroll.view` | report | — |
| `payroll.edit` | feature | `payroll.view` |
| `payroll.approve` | feature | `payroll.view` |
| `payroll.lock` | feature | `payroll.view` |
| `payroll.export` | feature | `payroll.view` |
| `payroll.email` | feature | `payroll.view` |
| `payroll.self.view` | report | **none** |

> ⛔ **`payroll.self.view` must have no `requires` edge.** Adding the obvious-looking `requires: ['payroll.view']` would cause `expandPermissions` to upgrade **every stylist to business-wide pay visibility** — exactly the wage leak `0074` was written to prevent.

### 6.2 Role behaviour

| Actor | Keys | Mechanism |
|---|---|---|
| Owner | all 7 | Automatic — `DEFAULT_ROLE_PERMISSIONS.owner = [...ALL_PERMISSIONS]` and the short-circuit at `auth.service.ts:603-605` |
| Group admin | all 7 | Automatic — `SYSTEM_SECURITY_LEVELS.group_admin` derives from `ALL_PERMISSIONS` |
| Manager | `payroll.view` only | Via the **`manager` security level**, never the role default |
| Stylist | `payroll.self.view` only | Needs a deliberate decision — see 6.3 |
| Receptionist | **none** | Deliberate absence — and the reason 6.3's first rule exists |
| Client / no-access | none | — |

**Two hard rules:**

- ⛔ **Never add `payroll.view` to `DEFAULT_ROLE_PERMISSIONS.manager`.** `receptionist` is not a real role (`core.membership_role_enum` is only owner/manager/stylist/client) and the receptionist system level has `base_role='manager'`, so any membership without an explicit `security_level_id` falls back to the manager role default — handing wage data to every unassigned front-desk user. `0074:33-40` forbids this in capitals.
- ⚠️ `SYSTEM_SECURITY_LEVELS.manager` currently **spreads** `DEFAULT_ROLE_PERMISSIONS.manager` (`:475`), as does `.stylist` (`:496`). Getting `payroll.view` onto the *level* without the *role default* means breaking that spread: `permissions: [...DEFAULT_ROLE_PERMISSIONS.manager, 'payroll.view']`. This is the easy place to accidentally do the forbidden thing.

### 6.3 The stylist problem — decision required

Verified on dev_test: **all 9 active stylist memberships and 3 of 4 manager memberships have `security_level_id = NULL`**, so they resolve from `DEFAULT_ROLE_PERMISSIONS` — which `0074` deliberately left alone. **`0074`'s seeding is therefore a functional no-op for every real user**, and fixing the catalogue alone changes nothing for them.

| Option | Effect | Note |
|---|---|---|
| **(a) Add `payroll.self.view` to `DEFAULT_ROLE_PERMISSIONS.stylist`** | Self-view works for all stylists immediately | **Recommended.** Safe — it only ever exposes the actor's own pay, and `base_role='stylist'` has no receptionist-style inheritance problem |
| (b) Backfill migration assigning system levels to NULL memberships | Fixes manager `payroll.view` too | Behaviour change well beyond payroll — needs its own approval |
| (c) Require owners to assign levels at `/settings/security-levels` | Matches `0074`'s stated intent, zero code | Nothing works until an owner acts; `ensureSystemLevels` only INSERTs missing levels, never repairs existing ones |

Also note: for businesses created **after** `0074` ran, `SYSTEM_SECURITY_LEVELS` seeds manager without `payroll.view`. Expect "manager can see payroll on the old business but not the new one" unless resolved.

### 6.4 Where checks go — five layers, all required

1. **Route guard** — `@RequirePermissions` per handler. ⚠️ `permissions.guard.ts:24` uses `getAllAndOverride`, so a method-level decorator **replaces** the class-level one rather than unioning. **Always re-list `payroll.view`** alongside the specific key.
2. **Guard-presence contract** — ⚠️ both guards **fail open** when the decorator is absent (`permissions.guard.ts:29-31`, `roles.guard.ts:21-23`). A one-line omission silently unguards a route; `GET /kpi/me` is a shipped example. This needs a **test**, not code review (see §10).
3. **Service scope** — the service-role client **bypasses RLS entirely** (39 usages; the anon key is used solely for token verification at `auth.service.ts:143`), so tenant isolation is **100% application-level**. Payroll RLS is real (17 policies, one per table) but **owner-SELECT-only** via `is_business_owner()` — a manager with `payroll.view` and a stylist with `payroll.self.view` are both *denied* by RLS. Only the API path works; **no client may query `payroll.*` directly**. Every query, insert and update needs `.eq('business_id', actor.businessId)`. `businessId` is never client-supplied (zero DTOs accept it); the spoofable inputs are `locationId` (21 DTO files) and `staffProfileId` (12).
4. **Location scoping** — ⚠️ permissions carry **no location dimension** (they are unioned across memberships at `auth.service.ts:614-623`) and `pay_summaries` has **no `location_id` column**. Manager location-scoping must therefore be applied indirectly via a cross-schema join on the staff member's location. **This is the concrete place a correct-looking, business-scoped query still leaks another location's pay.**
5. **Self-view derivation** — the self endpoint takes **no `staffProfileId` param**; resolve it server-side from the actor. **Do not reuse `StylistSelfGuard`** — it is DI-registered but used by zero controllers, and `stylist-self.guard.ts:33` bypasses on *role* (`userHasAnyRole(user, ['owner','manager'])`), which would let a receptionist-level user (base_role `manager`) straight through.

Plus: refuse writes to locked/paid periods with a **403 in the service, before** the DB trigger raises (which would surface as a 500), and add `/api/payroll` to `BODY_SUPPRESSED_ROUTE_PREFIXES`.

### 6.5 Pre-existing inconsistency to settle

`DEFAULT_ROLE_PERMISSIONS.manager` already grants `report.commission.view` (`index.ts:419`), so **every manager can already read commission figures** at `/commission` regardless of the tight payroll posture `0074` built. Define the relationship between `payroll.view`, `report.commission.view` and `staff.pay.manage` and record it.

---

## 7. Delivery Plan

Priority order. **W3.2-A** and **W3.2-B** gate everything else.

### W3.2-A — Register payroll permissions and close the leaks · *BLOCKER, ~1 day*

- **Objective:** make the seven keys real, stop the silent deletion, stop wage data reaching logs, close the benchmark escalation path, confirm the schema is reachable.
- **Files:** `packages/domain/src/index.ts` (`Permission` union, `PERMISSION_CATALOG`, `SYSTEM_SECURITY_LEVELS.manager` + `.stylist`, `AuditEntityType` += `pay_period`/`pay_summary`/`pay_structure`/`pay_adjustment`) · `apps/api/src/common/request-response-logging.middleware.ts` · `apps/api/src/staff/staff.service.ts` (extend `assertSensitiveStaffFields` + the `includePayFields` gate to cover `average_bill_benchmark`, `contracted_hours`, `employment_type`, `holiday_entitlement_days`).
- **Notes:** rebuild `@sheer/domain` (dist is current, not stale — but web reads dist, so the rebuild is mandatory after the edit). Pre-flight: confirm `payroll` is in Exposed Schemas for dev_test via the dashboard. **Do not re-run `0074`.** Resolve the §6.3 stylist decision here.
- **Dependencies:** none.
- **Acceptance:** `@RequirePermissions('payroll.view')` compiles · an owner resolves all 7 keys · saving a security level **round-trips** the payroll keys instead of dropping them · the Security Levels screen shows a Payroll group · a probe against `payroll` does not return PGRST106 · `average_bill_benchmark` is unreadable and unwritable without `staff.pay.manage`.
- **Tests:** `expandPermissions('payroll.approve')` ⊇ `payroll.view` · `payroll.self.view` has **no** `requires` · no payroll key in `DEFAULT_ROLE_PERMISSIONS.manager` · sensitive-field redaction spec.

### W3.2-B — Migration `0078`: schema integrity fixes · *BLOCKER, ~1 day*

- **Objective:** make the documented rate-change and regeneration workflows possible, and close the integrity holes.
- **Files:** `supabase/migrations/0078_payroll_integrity_fixes.sql` — **file only, no push**.
- **Contents:**
  1. `{effective_to, notes}` column allowlist on `assert_rule_version_unused()`, guarded so a close date cannot precede the latest priced `occurred_on` *(fixes B2)*
  2. `superseded_by_id` → `DEFERRABLE INITIALLY IMMEDIATE` *(fixes B3)*
  3. Locked-period guard on `pay_summary_hours`; relax `hours >= 0` if downward corrections are in scope
  4. `band_id uuid references payroll.pay_structure_bands(id)` on `pay_summary_lines` *(per-band drill-down)*
  5. Column allowlist on `assert_target_adjustment_immutable()` so only `summary_id` may change
  6. `revoke all on function … from public; grant execute … to service_role` on both `SECURITY DEFINER` functions *(matches the 7-migration house pattern)*
  7. Business-consistency triggers on `pay_summaries` and `pay_periods`; widen `greater_of_winner` to include `revenue_split`; make the status ratchet cover INSERT
  8. *Optional, pending Q5:* `hour_category` on `rota.book_out_types` + correct the `annual_leave` / `sick_leave` `counts_as_paid_time` seeds
- **Acceptance:** the regression suite still ERRORs on R09/R10/R12/R13/R14/R15/R17/R18 · a **new** case proves a used version can be closed and a successor inserted · a new case proves `pay_summary_hours` writes are refused after lock · a new case proves supersede works inside one transaction.

### W3.2-C — Domain payroll contracts · *~1 day*

- **Files:** new `packages/domain/src/payroll.ts` + one re-export line in `index.ts`.
- **Notes:** flat sibling, **not** a directory — `tax.ts` is the only shape proven end-to-end through dist-ESM + Vite + Metro + Nest. Mirror all 23 enums as string-literal unions with `Record<Union,string>` label maps (`TierSemantics` needs a *descriptions* map — marginal vs retroactive is the single most consequential setting). All money `...Cents: number` + `currencyCode`. Dates `'YYYY-MM-DD'`, `periodEnd` **exclusive**; timestamps ISO. ⚠️ PostgREST returns `bigint`/`numeric` as **strings** — every mapper must `Number(...)`. ⚠️ Existing `CommissionTier`/`CommissionResult` encode the V1 model — **do not** redefine or repurpose them. ⚠️ Existing staff pay fields are **major currency** while KPI/payroll are cents — every crossing needs an explicit ×100.
- **Acceptance:** `pnpm --filter @sheer/domain build` clean; `apps/api` `tsc --noEmit` and `cd apps/web && npx tsc -b` both clean.

### W3.2-D — Pure calculation engine · *~3 days — the core*

- **Objective:** a deterministic pure function `(inputs, resolvedRules, period) → statement`. No I/O, no clock, no randomness.
- **Files:** `apps/api/src/payroll/payroll.calc.ts` (pure) · `payroll-inputs.service.ts` (all I/O) · `payroll-money.ts` (one home; `toCents` is already duplicated 3× and two divergent remainder algorithms exist).
- **Must support:** payable vs worked hours from `version_hour_rules` · base pay · Service Revenue Target · eligible service revenue after the version's discount/VAT/deposit policy · **marginal** band pricing slice-by-slice across all five threshold bases · per-band `accelerator_rate_percent` substitution (replaces, never stacks, never reaches back) · accelerator evaluation across all/any/at_least_n/weighted · retail as a separate stage outside the greater-of by default · `greater_of` keeping **both** sides and recording the winner · deductions incl. `actual_usage` product cost · chair rent and revenue split · adjustments · **signed** `net_payable_cents` · `business_retained_cents` · unavailable-source lines · per-line `structure_version_id`, `band_id` and `vat_rate_percent_snapshot`.
- **Decisions to encode:**
  - **Service Revenue Target precedence.** Three competing representations exist with no defined precedence. The money-affecting figure is **the commission stage's band threshold** (`multiple_of_base_pay` × payable base pay). `payroll.targets` is **display/tracking only** — `0072:12-14` was written specifically to prevent that conflation. `core.staff_profiles.service_revenue_target_amount` is legacy and **not read** (as is `proRateServiceRevenueTarget`, currently unused). The displayed target goes into `inputs_snapshot`.
  - **Snapshot what has no column.** The displayed target, the accelerator outcome with per-condition results, and staff attribution all have **no schema home**. Store them in `inputs_snapshot` under a documented, versioned key shape. No migration needed, but the shape must be specified before coding.
  - **Missing benchmark ≠ pass.** A `staff_benchmark` condition whose benchmark is 0 or NULL **fails** and emits a warning. This removes the 2× silent overpayment.
  - **Unavailable condition source ⇒ accelerator not achieved**, with a named warning. Under `evaluation_mode='all'` this means the lower band rate applies — the safe direction. **Never silently pass.**
  - **Rounding.** Integer minor units; `Math.round(basis * rate / 100)` once per line; lines sum to the header. The DB enforces **no** arithmetic invariant between `net_payable_cents` and its components, so every invariant is an application assertion.
  - **Bands** carry only a lower bound with no ascending/distinct/starts-at-zero constraint, and they freeze on INSERT once used — the engine sorts, validates, and defines below-first-band behaviour.
- **Dependencies:** W3.2-C.
- **Acceptance:** every worked example in `docs/payroll-loh-template.md` reproduces exactly — LOH marginal **£38.01** / **£51.60**, Example A1 **£680.10**, Example A2 **£540.00**, retail **£7.00**.

### W3.2-E — Rota → hour-category resolver · *~1 day*

- **Files:** `apps/api/src/payroll/hours.calc.ts` (pure) + reader.
- **Notes:** overlap-form shift query, `status='published'`, subtract unpaid breaks. Map `absence_events.absence_type` + `book_out_type_id` → categories. Leave has dates but no hours, so a documented day→hours rule is required (rostered shift that day / `contracted_hours` ÷ working days / fixed standard day). **Precedence:** `version_hour_rules.counts_as_paid` **wins** over `book_out_types.counts_as_paid_time` — rule data beats operational config. ⚠️ The two currently **disagree** on both categories that matter (see Q5). Do **not** reuse `computeNetWorkedHours` — it subtracts all leave and absence unconditionally and has no payable-hours concept, so a stylist on paid holiday gets target 0 and no base pay.
- **Acceptance:** paid holiday is payable but does **not** raise the target · sickness neither · every category appears in `pay_summary_hours` with its counted flags, including zero rows carrying an explanatory note.

### W3.2-F — Pay-period workflow · *~2 days*

- **Files:** `apps/api/src/payroll/` — `payroll.module.ts`, `payroll.controller.ts`, `payroll-self.controller.ts`, `payroll-period.service.ts`, `payroll-readiness.service.ts`, `dto.ts`; registration in `app.module.ts`.
- **Notes:** timezone-correct **local-date** period generation from `payroll_settings` (Tuesday anchor; a Tuesday 00:00 London boundary is 23:00 UTC Monday for half the year — **every** existing window resolver in the repo is UTC- or server-local-only). **Select-then-insert**, never `upsert({onConflict})` — the live-summary index is partial (the `0049` 42P10 trap, restated at `0073:443-446`). Regenerating a draft deletes summaries first (`pay_period_id` is `ON DELETE NO ACTION`), in order, in one transaction. **Enforce the full ladder in the service** — the DB blocks only backwards moves from locked/paid, so `draft→paid` and `approved→draft` are otherwise legal. Set the matching `*_at` / `*_by_user_profile_id` stamps (no constraint ties them to status). Audit every approve/lock/mark-paid via `AuditService.record`. Note **approval freezes nothing** at DB level — if approved figures must be stable, the service must enforce it.
- **Acceptance:** every transition permission-gated · locked periods refuse regeneration with **403, not 500** · readiness blocks generation on missing hourly rate / hour rules / structure · a manager sees only their own locations' summaries.

### W3.2-G — Owner/manager UI · *~2 days*

- **Files:** `apps/web/src/pages/PayrollPeriodsPage.tsx`, `PayrollPeriodDetailPage.tsx` · `components/payroll/PaySummaryDetailModal.tsx`, `PayrollWarningNotice.tsx` · routes in `App.tsx` · nav in `Sidebar.tsx` · fetchers in `auth/api.ts`.
- **Notes:** copy `CommissionPage` + `StylistKpiDetailModal` almost verbatim (CSS-grid rows to match the financial screens, wrapped in `overflow-x-auto`). ⚠️ Use `selectedLocationId` with the `!== 'all' ? id : undefined` idiom — **never** `resolvedLocationId`, which silently collapses "All locations" to `locations[0]` while payroll periods are business-wide by default. `StatusBadge` has 4 tones for 5 statuses — pick a mapping or add one. Render `net_payable_cents` **signed** (negative is correct for renters) — copy `signedMoney()` from `StylistKpiDetailModal.tsx:201-204`. Import `formatMoney` from `components/kpi/format.ts` (already duplicated 7×). Use `PastEditReasonDialog`, **not** `window.prompt`, for audited notes. **No un-approve or revert-to-draft controls.** Sidebar entry gets **both** `permission: 'payroll.view'` **and** `allowedRoles: ['owner','manager']` — a permission-only entry is visible to any key-holder while the route is owner/manager-gated, producing a dead link to `/unauthorized`.
- **Acceptance:** every figure drills to source · unavailable sources render as labelled warnings, **never £0** · empty states explain *why* ("No pay structure assigned", "No hourly rate set", "Period not yet generated", "Hour rules incomplete").

### W3.2-H — Stylist self-view: API only, client UI deferred

- **Rationale for deferral:** `apps/web` hard-gates the entire dashboard shell to owner/manager (`App.tsx:107`) with **no stylist route at all**, and `apps/sheer-app` has **zero** permission awareness (`userHasPermission` appears nowhere). A client surface is its own scope.
- **Deliver now:** `GET /payroll/me/summaries` and `/:summaryId` behind `payroll.self.view`, on a **separate controller** (`@RequireRoles('owner','manager','stylist')` — the management class's role list would exclude stylists), staff profile resolved server-side, **no `staffProfileId` param**, plus the §6.3 decision.
- **Acceptance:** a stylist reads only their own summaries · a colleague's id is unrequestable by construction · tested.

### W3.2-I — Tests · *~2 days* — see [§10](#10-testing-plan)

### W3.2-J — Documentation · *~0.5 day*

New `docs/architecture/payroll-financial-rules-engine.md` following the `rota-management.md` format (Object/Purpose table, Method/Path/Roles table, module tree, response shapes, "why these guardrails", TODOs). Plus the calculation spec (stage order, rounding, greater-of composition, mid-period version split, `inputs_snapshot` shape), the state machine + permission matrix, a test-flow guide, data sources used vs unavailable, deferred items, known limitations, and the settlement disclaimer copy the competitor review asks for twice ("Total pay before tax, National Insurance and pension").

⚠️ **Correct or supersede `docs/financial-rules-engine-verification-guide.md`.** Its line 5 claims "Nothing has been committed, branched, pushed, deployed, or applied to any database" and line 427 says the work is "not to be merged to `develop`" — both false since `3f2df78` / PR #30. Its §9 rollback would `rm` applied migration files and merged docs. Also fix `docs/ZAC/phase-1-week-1-backend-foundation-task-breakdown.md:7`, which says payroll holds `0071`–`0074` (it holds `0075` too).

### W3.2-K — LOH demo seed · *~0.5 day — hard dependency for the review*

A clean, **idempotent** LOH template seed: structure (`is_system=true`) + version + 3 marginal bands (0/0%, 3.0×/10%, 3.5×/15% with 30% accelerator) + retail stage (`percent_of_service_target`, 0%→0%, 10%→10%) + all-of-three accelerator + all 8 `version_hour_rules` + one `staff_pay_assignment`. Extract from `payroll_validation.sql` (~lines 15-88 and 151-176), which is scratch-DB-only, interleaved with 11 deliberately-failing `_ERROR` cases, and shares fixture UUIDs with the regression suite.

⚠️ **Do not resurrect `supabase/seed.sql.bak`** — it is 59KB of well-formed SQL targeting a schema that never shipped (`rota.shifts(shift_date, start_at, end_at, role_label)`, type `rota.shift_status`, `analytics.stylist_target_snapshots`) and fails on its first rota statement.

⚠️ During development, **generating one test summary permanently freezes that version's stages, bands, conditions and hour rules** — inserts included. Dev/QA must create a new version, never tweak an existing one.

---

## 8. Recommended API Contract

Prefix `/payroll`. **One handler per transition** — `getAllAndOverride` means a method-level decorator replaces the class-level one, so every handler re-lists `payroll.view`.

```
GET   /payroll/settings                        payroll.view
PATCH /payroll/settings                        payroll.view + payroll.edit
GET   /payroll/data-sources                    payroll.view            (read-only this week)
GET   /payroll/structures                      payroll.view
GET   /payroll/periods?kind&status&from&to     payroll.view
POST  /payroll/periods                         payroll.view + payroll.edit
GET   /payroll/periods/:periodId               payroll.view
GET   /payroll/periods/:periodId/readiness     payroll.view
POST  /payroll/periods/:periodId/generate      payroll.view + payroll.edit
GET   /payroll/periods/:periodId/summaries     payroll.view
GET   /payroll/summaries/:summaryId            payroll.view
POST  /payroll/periods/:periodId/ready         payroll.view + payroll.edit
POST  /payroll/periods/:periodId/approve       payroll.view + payroll.approve
POST  /payroll/periods/:periodId/lock          payroll.view + payroll.lock
POST  /payroll/periods/:periodId/mark-paid     payroll.view + payroll.lock      ← see Q8
GET   /payroll/me/summaries                    payroll.self.view
GET   /payroll/me/summaries/:summaryId         payroll.self.view
```

Bare camelCase responses (house convention). Key shapes:

```ts
// GET /payroll/periods/:periodId/summaries
{ period: PayPeriod,
  summaries: Array<{
    summaryId: string; staffProfileId: string; staffName: string;
    employmentTypeSnapshot: StaffEmploymentType;
    structureName: string | null; structureVersionNo: number | null;
    payableHours: number; workedHours: number;
    serviceRevenueTargetCents: number | null;
    serviceRevenueCents: number; retailRevenueCents: number;
    basePayCents: number; commissionCents: number;
    revenueSplitCents: number; chairRentCents: number;
    deductionsCents: number; bonusCents: number; adjustmentsCents: number;
    netPayableCents: number;              // SIGNED — negative = stylist owes the business
    businessRetainedCents: number;
    greaterOfApplied: boolean;
    greaterOfWinner: 'base_pay' | 'commission' | 'revenue_split' | null;
    acceleratorAchieved: boolean | null;  // null = could not be evaluated
    isStale: boolean; staleReason: string | null;
    warnings: PayrollWarning[]; currencyCode: string;
  }>,
  periodWarnings: PayrollWarning[] }

type PayrollWarning =
  | { kind: 'source_unavailable'; source: PayrollDataSource;
      stageLabel: string | null; message: string }
  | { kind: 'input_missing';
      input: 'hourly_rate' | 'hour_rules' | 'pay_structure'
           | 'staff_benchmark' | 'contracted_hours';
      staffProfileId: string | null; message: string }
  | { kind: 'accelerator_unevaluable'; conditionMetric: AcceleratorMetric; message: string }
  | { kind: 'source_variance'; detail: string };   // appointment_services vs visit_line_items

// GET /payroll/summaries/:summaryId — the explainability payload
{ summary: PaySummary,
  hours: Array<{ category: HourCategory; hours: number;
                 countedTowardTarget: boolean; countedAsPaid: boolean;
                 notes: string | null }>,
  lines: Array<{ sequenceNo: number; lineType: PayLineType; label: string | null;
                 sourceType: PayLineSource | null; sourceId: string | null;
                 occurredOn: string | null; quantity: number | null;
                 basisAmountCents: number | null;
                 vatRatePercentSnapshot: number | null; ratePercent: number | null;
                 amountCents: number;                 // signed
                 bandId: string | null; structureVersionId: string | null;
                 sourceUnavailable: boolean;
                 unavailableSource: PayrollDataSource | null }>,
  target: { serviceRevenueTargetCents: number | null; basis: ThresholdBasis | null;
            derivation: string; adjustments: TargetAdjustment[] },
  accelerator: { achieved: boolean | null; evaluationMode: AcceleratorEvaluation | null;
                 conditions: Array<{ metric: AcceleratorMetric; comparator: Comparator;
                                     basis: ConditionBasis; thresholdValue: number | null;
                                     actualValue: number | null; passed: boolean | null;
                                     unevaluableReason: string | null }> },
  bands: Array<{ bandId: string; sequenceNo: number; fromLabel: string;
                 sliceFromCents: number; sliceToCents: number | null;
                 ratePercentApplied: number; acceleratorRateApplied: boolean;
                 amountCents: number }>,
  warnings: PayrollWarning[] }
```

**Errors:** `403` for permission failures and locked-period writes (raised in the service, before the trigger) · `409` for status-transition violations · `422` for readiness failures, with the blocking `PayrollWarning[]` in the body.

---

## 9. Recommended UI Flow

**Owner / manager:**

1. Sidebar → **Staff pay** (Team Hub group, `permission: 'payroll.view'` + `allowedRoles: ['owner','manager']`).
2. **Pay periods list** — window, kind, frequency, status pill, staff count, total net payable, stale indicator. "Create period" (`payroll.edit`) prefilled from `payroll_settings`.
3. **Period detail** — header (window, status, actor stamps) → **readiness panel** if anything blocks → staff table (name, structure/version, payable hours, target, service revenue, base pay, commission, accelerator, deductions, **signed** net payable) → workflow buttons enabled strictly by held key and current status.
4. **Staff breakdown modal** — hours by category with counted flags · the target and how it was derived, plus any `target_adjustments` · **each band's slice priced separately**, showing the rate actually applied and whether the accelerator substituted · per-condition accelerator results including "could not evaluate" · itemised lines drilling to visits · the greater-of comparison showing **both** sides · deductions · adjustments carried in · final signed total.
5. **Unavailable sources** as a distinct amber notice, never a £0 row.

**Empty states must diagnose, not decorate:** "No pay structure assigned to this stylist" · "No hourly rate set" · "Period not yet generated" · "Hour rules incomplete for this rule version".

**Stylist self-view:** API only this week; the client surface is deferred (W3.2-H).

---

## 10. Testing Plan

New automated tests under `apps/api/src/payroll/`. ⚠️ Jest `testMatch` is `<rootDir>/src/**/*.spec.ts` and the script uses `--passWithNoTests`, so a spec placed anywhere else **reports success while running nothing** — verify the suite count rises from 39.

| File | Covers |
|---|---|
| `payroll.calc.spec.ts` | LOH marginal bands (£38.01 / £51.60) · Example A1 (£680.10) · Example A2 greater-of (£540.00) · retail (£7.00) · **marginal vs retroactive on identical inputs** · all five threshold bases · accelerator all/any/at_least_n/weighted · `staff_benchmark = 0` **fails** rather than passes · unevaluable accelerator ⇒ not achieved + warning · signed negative net payable for a renter · rounding and line-sum invariants (the DB enforces none) |
| `hours.calc.spec.ts` | Paid holiday payable but **not** target-raising · sickness neither · unpaid breaks deducted · a shift straddling a period boundary counted correctly · `version_hour_rules` beats `book_out_types.counts_as_paid_time` · unmappable categories produce zero rows with notes |
| `payroll-period.service.spec.ts` | Full ladder enforced in the service · backwards moves refused · `draft→paid` refused · locked-period writes 403 **before** the trigger · regenerate deletes-then-inserts and never uses `onConflict` · timezone-correct Tuesday-anchored boundaries **including a BST/GMT transition** |
| `payroll-readiness.service.spec.ts` | Missing hourly rate blocks · missing hour rules block · missing structure blocks · uncaptured source **warns but does not block** |
| `payroll.service.spec.ts` | Manager with `payroll.view` reads but cannot approve · stylist with only `payroll.self.view` sees exactly their own and 403s on a colleague's · receptionist/client rejected · every query carries `business_id` · **a manager sees only their own locations' summaries** |
| `payroll.controller.spec.ts` | **Guard-presence contract:** enumerate every payroll route and assert each carries both `RolesGuard` and `PermissionsGuard` metadata, and that every mutating handler re-lists `payroll.view`. Needed because both guards **fail open** on a missing decorator |
| `packages/domain` assertions | `expandPermissions('payroll.approve')` ⊇ `payroll.view` · `payroll.self.view` has **no** `requires` · no payroll key in `DEFAULT_ROLE_PERMISSIONS.manager` |

**Extract a shared Supabase fake.** Five new specs need the same multi-table stub, and there is **no** test helper/fixture/factory directory anywhere in `apps/api` — three divergent hand-rolled patterns have drifted. Add `apps/api/src/common/testing/supabase-fake.ts` (thenable table-router pattern) extended with `.rpc()`, `.is()`, `.lte()`, `.gte()`, `.not()` and bare-`await` support, which the existing mocks all lack.

⛔ **Do not touch `kpi.calc.ts` or `kpi.calc.spec.ts`.** That spec deliberately asserts the retroactive behaviour (`:271-276` 10% of the whole base, `:296-303` 30% of the whole base) as correct. It is the only test of shipped V1 behaviour, and "fixing" it would break a green suite that was written on purpose.

**Commands:**

```bash
pnpm --filter @sheer/domain build            # MANDATORY — apps/web reads dist
pnpm --filter @sheer/api test
pnpm --filter @sheer/api exec tsc --noEmit
cd apps/web && npx tsc -b                    # NOT --noEmit — that is a no-op here
```

Plus a manual re-run of Parts A–C of the verification guide against a **scratch** cluster after `0078`, confirming R09/R10/R12/R13/R14/R15/R17/R18 still ERROR. ⚠️ The two SQL suites share fixture UUIDs and need **separate** databases. ⚠️ `0063`–`0070` are absent from the dev_test migration ledger, so a fresh-chain scratch DB is **not** identical to dev_test.

**Web tests:** `apps/web` has no harness at all (no vitest/jest/RTL/playwright, no test script). Introducing one is its own scope — rely on `tsc -b` plus a manual walkthrough this week.

**CI:** none exists (no `.github/`, no husky). If "tests pass" is to be a gate, that is a separate cheap ticket.

---

## 11. Deferred Items

| Item | Reason |
|---|---|
| PDF / CSV export, email | `principles.md:138` defers them; no blob/download plumbing exists in web (`request<T>()` only parses JSON). Keys and `exported_at`/`emailed_at` stay unused. ⚠️ **Contradiction to resolve (Q6):** the Wrike Week 3 ticket *required* PDF/CSV + email |
| Simulation mode | Design-ready only, by agreement. The pure calc makes it cheap later |
| Employer NI / pension / total cost to business | Reporting layer, deliberately outside gross pay |
| Retail capture UI | Separate ticket in Luke's stated priority order. **Highest-leverage single deferred item** — the endpoint, RPC, DTO, permission and KPI read query all already exist, so one till panel would unblock retail commission *and* the currently unreachable 30% accelerator. Also needs a decision on whether `inventory.products.retail_price_cents` is per-unit (what the RPC assumes) or per-gram (what the lab UI writes) |
| Tips capture | No table, column or endpoint. Needs staff attribution and a paid-out-vs-owed distinction |
| Refund / void capture | Needs a **migration**, not just UI (three constraints block it) |
| Cancellation-fee capture | Needs a fee record when a deposit is forfeited |
| Location- and role-level hour-category overrides | Follow-up ticket; the version snapshot means adding them later cannot disturb history |
| `is_stale` detection | Needs triggers on four rota tables. Leave the flag **unset** and document that rota edits inside a generated period are not yet detected — `payroll-competitor-review.md:46` names this exact behaviour as the industry cautionary tale, so it must be a **named limitation, not a silent one** |
| Pay-structure authoring UI | The `config` jsonb contract is undefined for 5 of 8 stage types (§4.4), so authoring cannot be built responsibly yet. W3.2-K seeds instead |
| Advanced payment routing, automated payroll submission | Out of scope |
| Stylist self-view **client UI** | No stylist surface exists in web; mobile has no permission awareness. API ships (W3.2-H) |
| ZAC integration, autonomous AI | Explicitly separate workstream |
| Rewriting `kpi.calc.ts` | Live permission-gated surface with a spec locking in current behaviour. Needs the Q2 product decision first |

**One item recommended for inclusion:** migration `0078`. Without it the first pay run permanently freezes that structure's rates (B2) and regeneration is unbuildable (B3) — both contradict the engine's central promises. Risk is low (additive trigger allowlists, one FK modifier, one nullable column, grant tightening; no data rewrite) and testable on a scratch cluster. The cost of discovering it after Luke's review is high.

---

## 12. Risks & Mitigations

| Risk | Severity | Mitigation |
|---|---|---|
| **Calculation correctness** — live `kpi.calc.ts` differs from intent by **~7×, up to 14×** (`loh-template.md:34`: £270 vs £38.01), not the 1.5–3× in older notes | Critical | New pure engine, never derived from KPI. Every LOH worked example as a fixture. `tier_semantics` always read from data, never inferred. Plan against the 7×/14× figure |
| **Two commission numbers on screen** — `/commission`, `/performance`, `CommissionReadinessCard`, sheer-app `/performance` and the ZAC `kpi_summary` tool will all disagree with payroll | High | **Product decision required before the review (Q2).** Relabel KPI screens as "indicative KPI — not pay", or repoint them at payroll. Do not let an owner discover this |
| **Silent £0 / silent 2× overpay** (§4.5) | High | Readiness gate blocks generation; a zero benchmark **fails** its condition; unevaluable accelerator ⇒ not achieved |
| **Permission leakage** — service-role bypasses RLS; payroll RLS is owner-only, so the API is the sole control | High | `business_id` on every query · per-handler guards re-listing `payroll.view` · **guard-presence test** (both guards fail open on omission) · location scoping via cross-schema join (permissions have no location dimension and `pay_summaries` has no `location_id`) · self-view derives the staff id server-side · `/api/payroll` log suppression · benchmark field locked to `staff.pay.manage` · **test with a restricted manager account** — owners bypass every gate |
| **Missing data presented as fact** | High | `source_unavailable` lines (DB CHECK forbids a non-zero figure) + separate `input_missing` warnings; UI renders both as notices |
| **Locked history destroyed** | High | DB triggers enforce it; `0078` extends the guard to `pay_summary_hours`; service returns 403 before triggers 500; re-run the regression suite after `0078` — **R14 and R15 were real defects found adversarially** |
| **Rate change impossible after first run** (B2) | High | `0078` allowlist. Documented workaround if rejected |
| **Regeneration unbuildable** (B3) | High | `0078` DEFERRABLE. Until then only delete-then-insert in draft/ready/approved, which loses `generated_at` and nulls `target_adjustments.summary_id` |
| **Attribution silently erased** — attribution columns are `on delete set null` while payroll is RESTRICT | Medium-High | Snapshot attribution into `inputs_snapshot` at generation; never re-derive |
| **`appointment_services` vs `visit_line_items` divergence** — one reconcile call site, and post-completion edits don't re-reconcile | Medium-High | Pick `appointment_services` as authority, reconcile to the penny, surface variance as a warning |
| **Approved ≠ frozen** | Medium | Enforce in the service; document that "approved" has no DB meaning yet |
| **Schema mismatch** — no columns for the displayed target, accelerator outcome or attribution | Medium | Documented, versioned `inputs_snapshot` shape (+ `band_id` in `0078`) |
| **PGRST106 on every endpoint** (B4) | Medium | Exposed Schemas pre-flight per hosted project as checklist item #1 |
| **PostgREST partial-index upsert (42P10)** | Medium | Select-then-insert only. Documented in `0073`; burned us in `0049` |
| **Timezone boundary errors** | Medium | Dedicated local-date resolver + a BST/GMT-transition test. Every existing resolver is UTC-only |
| **Empty review** — no rule rows and no working seed | Medium | W3.2-K is a hard dependency, not a tail-end task |
| **Multi-location capture truth** — `business_data_sources` has no `location_id` | Low-Medium | Document the limitation; do not pretend per-location accuracy |
| **Performance** | Low-Medium | Per-period, per-staff, indexed. Batch reads across staff; avoid N+1 per stylist |
| **Migration risk** | Low | `0078` is additive triggers/grants + one FK modifier + one nullable column. File only; verified on a scratch cluster; no push |
| **Scope creep** | Medium | Hard-defer the rule builder, exports, retail capture and simulation. Resolve the Week-4 labelling collision up front |

---

## 13. Branch / Commit Plan

**Branch:** `feature/week4-financial-rules-engine-workflow` (keeping the name already agreed, despite the §0 labelling note), cut from `develop`.

Six reviewable commits, each independently sensible:

1. `feat(domain): register payroll permission keys and lock sensitive staff fields` — W3.2-A. The blocker; smallest and highest-value. Includes log suppression and the rebuilt `dist`.
2. `chore(db): payroll integrity fixes — closable versions, deferrable supersede, hours lock` — W3.2-B. Migration **file only**, plus new regression cases. **No push.**
3. `feat(domain): payroll contracts for structures, periods and summaries` — W3.2-C.
4. `feat(api): payroll calculation engine and pay-period workflow` — W3.2-D + E + F + H, with specs. Largest commit; split into calc / hours / workflow if review gets heavy.
5. `feat(web): owner and manager staff pay review workflow` — W3.2-G.
6. `docs(payroll): financial rules engine architecture, test flow and limitations` — W3.2-J + K, including the verification-guide correction.

Keep ZAC entirely untouched. Do not renumber or re-apply `0071`–`0077`.

---

## 14. Questions for Cosan / Luke Before Implementation

1. **Labelling / change control.** Is this booked as **Week 3 completion** (Till/Bills keeps its Week 4 slot), or as a change request replacing the Diary/Search/Till/Bills pillar? Needs writing down before code.
2. **Two commission numbers.** Once payroll ships, `/commission` and `/performance` will differ from a payslip by up to 7×. Which is authoritative — and do we relabel the KPI screens "indicative — not pay", repoint them at payroll, or hide them? *(Recommendation: relabel now, repoint later.)*
3. **Stylist `payroll.self.view` default.** All 9 active stylist memberships have no security level, so `0074`'s seeding does nothing for them. Add `payroll.self.view` to the stylist **role default** *(recommended — it only ever exposes their own pay)*, or require owners to assign levels?
4. **Paid holiday vs unpaid leave.** `rota.leave_requests` records no leave type and no hours, so the two are indistinguishable. Do we (a) add `leave_type` + `is_paid` + a day→hours rule now, (b) route all leave through book-out types, or (c) treat all approved leave as unpaid this week and flag it as a limitation?
5. **`book_out_types` vs `version_hour_rules`.** The seeded defaults **contradict** the signed-off rules — `annual_leave` is `counts_as_paid_time = false` while paid holiday should be payable; `sick_leave` is `true` while sickness should not be. The same wrong values are duplicated in `packages/domain` `SYSTEM_BOOK_OUT_TYPES` and already materialised in 65 dev_test rows. Confirm `version_hour_rules` wins, and whether `0078` corrects the seeds and backfills.
6. **PDF / CSV / email.** `principles.md` defers them; the Wrike Week 3 ticket required them; the schema and permission keys are export-ready. Confirm deferred.
7. **Review expectations.** Retail is uncaptured, so LOH's retail commission and accelerator condition #2 can only render "source not captured" — meaning the **30% accelerator cannot legitimately fire** in a demo. Is a review that leads with the unavailable-source line *as a feature* acceptable, or is retail capture now a prerequisite?
8. **`mark-paid` permission.** Luke's six keys don't obviously cover "mark as paid". Should it require `payroll.lock`, `payroll.approve`, or its own key?

---

## 15. Verification Log — claims overturned

Every finding above survived three adversarial verification passes. These claims did **not**, and are recorded so nobody re-derives them from an earlier draft:

| Claim | Verdict | Correction |
|---|---|---|
| `packages/domain/dist` is stale and lacks `zac.access` | **Wrong** | The grep behind it used a nonexistent path. `dist/cjs` and `dist/esm` both contain `zac.access`, and dist mtime is **newer** than src. The rebuild after adding keys is still required; no clean/repair is |
| Guarded payroll routes silently 403 everyone including the owner | **Overstated** | `Permission` is a closed union, so it is a **build error** caught by `apps/api tsc --noEmit` — safer, and it reorders remediation. The real runtime danger is the silent stripping of seeded keys |
| `businessId` could be spoofed by a client-supplied param | **Wrong** | Zero DTOs accept `businessId` anywhere; it is derived server-side at `auth.service.ts:466-471,513`. The spoofable inputs are `locationId` (21 DTO files) and `staffProfileId` (12) |
| Week 4 needs no new migration | **Wrong** | At least four are required for the described workflow to persist correctly (B2, B3, hours lock guard, `band_id`), plus grant tightening |
| Supersede is blocked only after lock | **Understated** | It is impossible in **every** period status — non-deferrable self-FK behind a partial unique index (B3) |
| Retail's `is_captured` flag is "now factually wrong"; flip it to `true` | **Wrong** | Flipping it would be **actively harmful** — it silences `missing_data_sources()` and makes retail commission pay £0 instead of "not captured". The flag's wording is imprecise (the API *can* write) but its conclusion holds: no client calls the endpoint |
| Stored prices are NET, so `vat_basis='exclusive'` is a free read | **Overstated** | Net-vs-gross is per-location **configuration** (`tax.ts:174`). Under `display_mode='inc_tax'` the same value is gross, and `'exclusive'` would double-count VAT |
| Actual QLAB product cost is live and usable now | **Overstated** | Four gates plus a two-writer race that produces a self-contradicting row (§5) |
| Luke's review can show non-zero numbers off existing dev_test data | **Wrong** | Structurally impossible — zero writers for any rule table, no working seed. W3.2-K is a hard dependency |
| The status ratchet fails open on a future enum value | **Overstated** | All five values are enumerated today; it is a latent maintenance risk. The **real** gap is that the trigger is `before update` only, leaving INSERT-at-paid unguarded |
| Payroll is exposed via PostgREST, so any authenticated user can RPC the definer functions | **Wrong premise, right conclusion** | Hosted exposure is **unverified** (config.toml is local-only). The ACL problem is real and independently confirmed, and is a deviation from a 7-migration house pattern |
| Payroll RLS comprises 13 policies | **Wrong** | 17 — exactly one per table. No unprotected table to hunt for |
| The definer-function ACL gap is low impact | **Understated** | `missing_data_sources(uuid)` is a genuine cross-tenant read leak with a copy-paste fix |

**Method caveat:** live `pg_class` / `pg_policy` / `pg_proc.proacl` reads were blocked during verification, so RLS and function-ACL verdicts rest on migration-file evidence rather than an independent live read. The ACL inference is sound — no payroll migration contains any `revoke`, so PostgreSQL's default EXECUTE-to-PUBLIC stands. Live row counts came from read-only branch queries and should be re-confirmed before the review.
