# Payroll — Financial Rules Engine application layer (V1.1 Week 3.2)

**Status:** Implemented against the `payroll` schema (migrations `0071`–`0075` + `0078`, all applied to dev_test). Delivered per `docs/V1.1/3-2 plan.md`; binding principles in `docs/financial-rules-engine-principles.md`; canonical template and worked examples in `docs/payroll-loh-template.md`.

## What Week 3.2 implemented

| Object                                                                                             | Purpose                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/payroll/payroll.calc.ts`                                                             | **Pure calculation engine.** `(inputs, resolved rule version, period) → statement`. No I/O, no clock, no randomness. Never derived from `kpi.calc.ts`.                                         |
| `apps/api/src/payroll/hours.calc.ts`                                                               | Pure rota → hour-category resolver (8 categories, interval arithmetic, honesty notes).                                                                                                         |
| `apps/api/src/payroll/period-dates.ts`                                                             | Local-date period arithmetic + DST-safe timezone conversion (Tuesday-anchored weeks; a London Tuesday midnight is 23:00 UTC Monday in summer).                                                 |
| `apps/api/src/payroll/payroll-money.ts`                                                            | One home for cents arithmetic: half-up-on-magnitude rounding, major↔minor conversion, PostgREST string coercion.                                                                               |
| `apps/api/src/payroll/payroll-inputs.service.ts`                                                   | All I/O. Resolves **trusted** pay inputs from `core.staff_profiles` (never from redacted client responses), rule rows by effective date, rota/visit/revenue/tax/retail/adjustment/target data. |
| `apps/api/src/payroll/payroll-readiness.service.ts`                                                | Pre-flight gate: dry-runs the same engine; missing config inputs BLOCK, uncaptured sources WARN.                                                                                               |
| `apps/api/src/payroll/payroll-period.service.ts`                                                   | Period lifecycle + generation. Full status ladder enforced in the service; locked/paid writes 403 before DB triggers; select-then-insert only.                                                 |
| `apps/api/src/payroll/payroll.service.ts`                                                          | Read side: settings, data sources, structures, period lists with totals, summaries, explainability breakdown, stylist self-view.                                                               |
| `apps/api/src/payroll/payroll.controller.ts` + `payroll-self.controller.ts`                        | Guarded endpoints (below). Self-view is a separate controller so the management role list never widens.                                                                                        |
| `apps/web/src/pages/PayrollPeriodsPage.tsx`, `PayrollPeriodDetailPage.tsx`, `components/payroll/*` | Owner/manager review UI: period list, detail with readiness panel + workflow buttons, staff table, per-staff breakdown modal.                                                                  |
| `apps/api/scripts/seed-loh-pay-template.ts`                                                        | Idempotent dev seed of the LOH template (`pnpm --filter @sheer/api seed-loh-pay-template -- --business <id>`). Without rule rows, every screen is empty by design.                             |
| `apps/api/src/common/testing/supabase-fake.ts`                                                     | Shared thenable table-router fake for specs.                                                                                                                                                   |

## Calculation rules (the parts that move money)

- **Stage pipeline.** A pay structure is an ordered list of stages (`base_pay → commission → revenue_split → chair_rent → deduction → bonus → greater_of → tips_payout`). Employed / self-employed / hybrid differ only in which stages exist. Every rate/threshold/ordering is rule data — there are no default rates in code.
- **Marginal vs retroactive** (`tier_semantics`, per commission stage, never inferred): marginal prices each band's slice separately; retroactive prices the whole base at the highest crossed band's rate. LOH is marginal: base £488.40 + revenue £1,800 → £38.01 (£51.60 with accelerator); the live KPI screen's retroactive £270 is exactly what this engine replaces.
- **Thresholds** resolve per band basis: `multiple_of_base_pay` (× payable base pay), `absolute`, `per_client` (× distinct clients), `percent_of_service_target` (× the derived SRT), `percent_of_service_revenue`.
- **Service Revenue Target precedence**: the money-affecting figure is the service commission stage's first positive band threshold. `payroll.targets` rows are tracking/display only; `core.staff_profiles.service_revenue_target_amount` is not read.
- **Accelerator**: replaces a band's rate with `accelerator_rate_percent` on that band's slice only — never stacks, never reaches back. Modes all/any/at_least_n/weighted. **A staff benchmark of 0/NULL fails its condition** (with a warning); an unevaluable condition can never make the accelerator pass — unknown resolves to _not achieved_ (lower rate: the safe direction).
- **Hours**: `version_hour_rules` decides payable vs target-raising per category (rule data beats `book_out_types.counts_as_paid_time`). Paid holiday is payable but does not raise the target; sickness is neither.
- **VAT**: with `vat_basis='exclusive'` on an inc-tax location, the commission base is de-grossed via `taxWithinGross` and the rate snapshotted per line (`vat_rate_percent_snapshot`).
- **Revenue authority**: `booking.appointment_services` (staff-attributed headline prices). The rolled-up `billing.visit_line_items` service row is reconciled and any disagreement becomes a `source_variance` warning.
- **Rounding**: integer cents; `round(basis × rate / 100)` once per line, half-up on the magnitude; the engine asserts pay lines sum to `net_payable_cents` (the DB enforces no arithmetic invariant, so the engine does).
- **Greater-of**: both sides survive (`greater_of_applied`, `greater_of_winner`, full comparison in `inputs_snapshot`); the losing leg contributes no pay lines.
- **Snapshot**: everything consumed — staff inputs, rule identity, hours, target derivation, accelerator outcome, band slices, attribution — persists in `pay_summaries.inputs_snapshot` (`snapshotVersion: 1`, engine `payroll.calc@1`).

### The £0 honesty contract

- **Uncaptured transaction source** (retail, tips, refunds, cancellation fees today) → a zero-amount line with `source_unavailable=true` + `unavailable_source`, surfaced in the UI as an amber "not captured" notice. Never a silent £0.
- **Missing configuration input** (no structure, no hourly rate, no hour rules, unresolvable threshold) → `input_missing` warning that **blocks generation** for that staff member (422 with the readiness payload). Silently paying £0 for want of an hourly rate is the failure mode this exists to prevent.

## Pay-period workflow

`draft → ready_for_review → approved → locked → paid`, one step at a time, enforced in `payroll-period.service.ts` (the DB only physically blocks rewinds from locked/paid). Transitions stamp the actor and timestamp, and everything is audited (`audit.activity_log`, entity `pay_period`).

- **Generate** (draft/ready/approved only; refused 403 once locked/paid): readiness gate → pure engine per staff member → delete-then-insert of live summaries + lines + hours in order. Never `upsert(onConflict)` — the live-summary unique index is partial.
- **Ready** requires generated summaries. **Approve** freezes nothing at DB level (documented); the service still only allows locked-step forward.
- **Lock** finalises: consumed `pay_adjustments` are stamped `applied_in_pay_period_id`/`applied_at` (they freeze thereafter). Corrections after lock go through new `pay_adjustments` into a later period.
- Timezone: period boundaries are local dates in `payroll_settings.timezone` (default Europe/London); timestamptz sources are windowed through the DST-safe converter.

## Endpoints

All under `/api/payroll`, guarded `SupabaseAuthGuard + RolesGuard + PermissionsGuard`. Every handler re-lists the base key (`getAllAndOverride` replaces, never unions).

| Method/Path                                                                                                      | Roles                   | Permissions                        |
| ---------------------------------------------------------------------------------------------------------------- | ----------------------- | ---------------------------------- |
| GET `/payroll/settings` · `/data-sources` · `/structures`                                                        | owner, manager          | `payroll.view`                     |
| GET `/payroll/periods` · `/periods/:id` · `/periods/:id/readiness` · `/periods/:id/summaries` · `/summaries/:id` | owner, manager          | `payroll.view`                     |
| POST `/payroll/periods` · `/periods/:id/generate` · `/periods/:id/ready`                                         | owner, manager          | `payroll.view` + `payroll.edit`    |
| POST `/payroll/periods/:id/approve`                                                                              | owner, manager          | `payroll.view` + `payroll.approve` |
| POST `/payroll/periods/:id/lock` · `/periods/:id/mark-paid`                                                      | owner, manager          | `payroll.view` + `payroll.lock`    |
| GET `/payroll/me/summaries[/:id]`                                                                                | owner, manager, stylist | `payroll.self.view`                |

Errors: 403 permission/locked-period (raised in the service before triggers), 409 status-transition violations, 422 readiness failures with the blocking `PayrollWarning[]` in the body.

## Permission & scoping model

- Keys per `0074`/domain catalogue: `payroll.view/edit/approve/lock/export/email/self.view`. `mark-paid` uses `payroll.lock` (plan Q8 recommendation). `payroll.self.view` has **no** `requires` edge — adding one would leak business-wide pay to every stylist via `expandPermissions`.
- Tenancy is 100 % application-level (service-role client bypasses RLS; payroll RLS is owner-SELECT defence-in-depth). Every query carries `business_id`.
- **Manager location scoping**: permissions carry no location dimension and `pay_summaries` has no location column, so managers are scoped by filtering to staff whose `primary_location_id` is in their `allowedLocationIds`; location-scoped periods are invisible to managers without that location.
- **Self-view** resolves the staff profile from the verified actor; no `staffProfileId` parameter exists on that controller, and a colleague's summary id returns 404 (no existence oracle). `StylistSelfGuard` is deliberately not used (it bypasses on role and would admit receptionist-level users).
- A guard-presence spec (`payroll.controller.spec.ts`) locks all of this in — both guards fail open on a missing decorator, so this is tested, not reviewed.

## Owner/manager test flow (dev)

1. `pnpm --filter @sheer/api seed-loh-pay-template -- --business <business_id> --staff <staff_profile_id>` (staff needs `hourly_rate > 0`; benchmark optional — without one the accelerator condition is _unevaluable_, which is correct).
2. Web → sidebar **Staff pay** → Create period (Tuesday-anchored week from payroll settings).
3. Open the period: the readiness panel names anything blocking (no structure / no hourly rate / no hour rules) or warns on uncaptured sources.
4. Generate → staff table appears; open a row for the full breakdown (hours with counted flags, target derivation, per-band slices, accelerator per-condition results, greater-of, itemised lines, signed net payable).
5. Mark ready → Approve → Lock → Mark paid, observing button gating per held key; after Lock, regenerate attempts return 403.
6. Retail/tips render as amber "not captured" notices throughout — that is the feature, not a bug (see below).

## Data sources: used vs unavailable

| Source            | State           | Engine behaviour                                                                                                  |
| ----------------- | --------------- | ----------------------------------------------------------------------------------------------------------------- |
| Service revenue   | ✅ captured     | Authority: staff-attributed `appointment_services`; roll-up reconciled, variance warned                           |
| QLAB product cost | ✅ captured     | `product_cost_mode='actual_usage'` deduction stage                                                                |
| Retail sales      | ❌ not captured | Unavailable line + warning; retail commission and the LOH accelerator's retail condition cannot legitimately fire |
| Tips              | ❌ not captured | Unavailable line + warning; `tips_paid_out/owed` stay 0                                                           |
| Refunds / voids   | ❌ not captured | Unavailable via warning; corrections go through `pay_adjustments`                                                 |
| Cancellation fees | ❌ not captured | Warning when `cancellation_fee_share_percent` is set                                                              |

## Known limitations (named, not silent)

- **Paid vs unpaid leave is indistinguishable** (`rota.leave_requests` has no type/paid flag/hours): approved leave subtracts from worked time and reports as `unpaid_leave` with an explanatory note. Paid holiday arises only from `annual_leave` book-outs.
- **`additional` / `manual_adjustment` hours have no source** — emitted as 0-hour rows with notes.
- **`is_stale` is never set**: rota/revenue edits inside a generated (unlocked) period are not auto-detected — regenerate before review. The competitor review names this exact behaviour as the industry cautionary tale, hence a named limitation.
- **Mid-period rule-version changes are not split**: the version in force at period start prices the whole period this week.
- **Utilisation accelerator conditions are unevaluable** (utilisation is a browser-side derivation; no trusted server figure).
- **Multi-stylist visits**: per-service attribution is used, but a service with no `assigned_staff_profile_id` credits the visit's primary staff member.
- **`business_data_sources` has no location dimension** — capture truth is business-wide.
- **Two commission numbers on screen**: `/commission`, `/performance` and sheer-app still run the legacy hard-coded model (deliberately untouched — its spec locks in shipped V1 behaviour). The payroll engine is the authoritative pay calculation; relabel/repoint is a product decision (plan Q2).
- Money-metric accelerator thresholds (`absolute_amount` on money metrics) are interpreted as **cents**.

## Deferred (per plan §11)

PDF export · CSV export · email sending · advanced simulation mode · retail capture UI (highest-leverage single unlock: enables retail commission AND the 30% accelerator) · tips/refunds/cancellation-fee capture · full QLAB product-cost deduction verification per location · stylist mobile self-view **UI** (the API ships now) · pay-structure authoring UI (stage `config` contract undefined for 5 of 8 stage types) · location/role-level hour-category overrides · `is_stale` production · ZAC integration (separate workstream, untouched).

## Pay-structure authoring (Phase 1 addendum)

Added after the Week 3.2 core: owners can now create structures from templates, version them, preview them, and assign staff — without touching the deferred free-form rule builder.

**The ratified stage-config contract** (the DTO layer migration 0071 promised) lives in `packages/domain/src/payroll.ts` §10 and is enforced by `PayrollStructuresService.validateRules`: `base_pay` (`hourly_rate_x_payable_hours` | `fixed_amount`), `revenue_split` (`split_percent`), `chair_rent` (`amount_cents`, per-period), `deduction` (`product_cost` | `fixed`), `bonus` (`fixed`). Refused outright, with reasons: tips stages (uncaptured), `custom` accelerators (no engine semantics), non-headline discount bases (no discount data), incomplete hour rules, band bounds that don't match the threshold basis, non-ascending thresholds, malformed greater-of pipelines. ⚠️ Contract shapes pending formal sign-off by Luke (the "Phase 0" session) — they ratify what the engine already computes, so sign-off risk is naming, not behaviour.

**Endpoints** (PayrollController): `GET /payroll/structures/:id` (owner/manager, `payroll.view`) · `POST /payroll/structures`, `POST /payroll/structures/preview`, `POST /payroll/structures/:id/versions` (**owner-only** + `payroll.view`+`payroll.edit` — handler-level role narrowing, locked by the guard-presence spec) · `POST /payroll/staff/:staffProfileId/assignment` (owner, or manager for staff at their own locations; closes any open assignment at the new effective date and inserts the next — append-only history).

**Version lifecycle**: creating version N+1 closes the current version at the new `effectiveFrom`. Closing a USED version is legal only when the close date clears everything it priced (0078 trigger); the DB refusal maps to a 409 telling the owner to pick a later date. A failed create reopens the closed version so no coverage gap is left. Structure create is cleanup-on-failure (delete cascades; version 1 is unused so nothing is frozen).

**Preview** runs the drafted rules through the REAL `calculatePaySummary` with sample inputs (defaults: £12.21 × 40h, £1,800 revenue) — the wizard's worked example can never disagree with a payslip. All sources are treated as captured for illustration (flagged `illustrative: true`); live runs still apply the capture matrix. Spec-locked to reproduce £38.01 / £51.60 / £540.00.

**UI**: `/payroll/structures` (list) · `/payroll/structures/:id` (read view with frozen badges, bands, accelerator, hour-rules matrix, version history) · `/payroll/structures/new` — a 4-step template wizard (Flat % · Tiered LOH-style · Base + bonus · Guarantee-or-commission · Chair renter → parameters → hour rules → live preview), plus "Assign structure…" directly on readiness rows blocked by `input_missing: pay_structure`.

## Retail capture (Phase 1 addendum 2)

Retail sales capture is now live end-to-end, on the **per-unit price decision** (confirmed by Cosan 2026-08-04): `inventory.products.retail_price_cents` is treated as the per-unit shelf price; the existing `POST /retail-sales` endpoint already defaulted `unitPriceCents` from it.

- **Recording**: web → Retail sales page (`/retail-sales`, `retail.record`) → Record sale modal. The **selling stylist is mandatory in the UI** even though the table allows null attribution — payroll can only credit attributed sales, so an unattributed sale would silently vanish from commission.
- **The capture flag** (`payroll.business_data_sources.retail_sales.is_captured`) is now flippable in-product: `PATCH /payroll/data-sources/:source` (owner-only + `payroll.edit`, audited), surfaced as the "Data capture" card on the Pay structures page with an explicit confirm step. **Honesty guard**: tips/refunds/cancellation fees are refused from ever being marked captured — no capture path exists for them, and flipping them would turn honest warnings into confident £0s.
- **Effect on payroll** (no engine changes needed): once flipped, retail revenue lands on statements, retail commission bands price (LOH: 10% above 10%-of-SRT), and the accelerator's "retail target met" condition becomes evaluable — making the 30% rate legitimately reachable for the first time.
- **Rollout order matters**: record real sales FIRST, then flip the flag. Flipping first would replace "source not captured" warnings with real £0s for stylists who simply had no recorded sales.
- ⚠️ Known caveat: colour/lab products whose `retail_price_cents` was entered per-gram by the Lab UI must not be sold through the retail panel until their pricing is normalised — products without a sensible per-unit retail price should have none set (the picker disables them).
