# QLOOQO V1.1 Week 8 — R2 Team

**Status:** G1 approved 2026-09-16 (decisions U-1…U-12, §10). Base G2–G4 built on
this branch; review items R-1…R-4 resolved and the final product decisions of
2026-09-17 (L-1…L-4, §14) applied. G5 (hosted UAT) not started. `team` stays `release: 'foundation'`.
Builds on [Ticket A](week-8-ticket-a-foundation.md) (report registry, fail-closed
access, per-location windows, decision S-1d) and consumes
[R1 Money](week-8-ticket-b-r1-money.md)'s paid-bill universe.

**Ownership.** Cosan owns this ticket. No ZAC file, no Dashboard file and no
migration changes. §4 carries a handoff note for Oleksandr (ZAC).

---

## 1. What R2 answers

Team performance per staff member and per location, over each location's own
report window.

| Metric | State in base R2 |
|---|---|
| Service revenue (gross incl. VAT; net alongside) | Available |
| Colour | Available |
| Average bill | Available |
| Utilisation | Available; approved leave is staff-wide (§4) |
| Future Booking (and confirmed-only) | Available, as at generation |
| Retail revenue | Available |
| Retail share of service revenue | Available, team and location only |
| Finalised commission | Available, locked or paid pay periods only; amounts `currency_unverified` until payroll records a statement's currency (§7) |
| Team and location totals, staff rows, staff filter | Available |
| **Rebooking At Source** | Unavailable — `capture_not_implemented` |
| **Revenue vs target** and target-dependent figures | Unavailable — `target_model_not_available` |
| **Retail attach** | Unavailable — `retail_visit_linkage_not_captured` |
| **Live commission** | Unavailable — `payroll_rules_not_implemented` |

An unavailable metric is listed with its reason and is never rendered as 0.

## 2. Sources

| Fact | Source | Staff | Location | Date |
|---|---|---|---|---|
| Service, colour, adjustment lines | R1's loader: `billing.bills` (paid) + `bill_lines` | `bill_lines.staff_profile_id` | `bills.location_id` | `bills.occurred_at` |
| Retail sales | R1's loader: `billing.retail_sales` | `staff_profile_id` (seller) | `location_id` | `sold_at` |
| Currency | R1's rule: facts' currencies + the location's configured currency | — | — | — |
| Eligible visits | `booking.visits` (completed, awaiting payment, paid) | `primary_staff_profile_id` | `location_id` | `completed_at` |
| Future appointments | `booking.appointments` (pending, accepted), business-wide | — | — | `scheduled_start_at` > generation |
| Rota | `rota.shifts` (not cancelled), `shift_breaks`, `absence_events` + `book_out_types`, `leave_requests` (approved, staff-wide: any recording location, never read) | `staff_profile_id` | `location_id` | local days |
| Booked time | `booking.appointments` (utilisation's booked statuses), `occupied_ranges` | `assigned_staff_profile_id` | `location_id` | local days |
| Current staff | `core.user_memberships` (active manager or stylist) → `core.staff_profiles` | profile id | membership location | today |
| Finalised commission | `payroll.pay_periods` (calculation; locked or paid) + `pay_summaries` (not superseded) | `staff_profile_id` | the period's own `location_id` (or business-wide) | period dates |

Every read filters `business_id`; windowed reads bind each location to its own
window (no envelope); reads use keysets. Never read: `primary_location_id`,
`allowedLocationIds`, merged permissions, `visit_line_items`,
`appointment_services.price_amount`, `rebooking_outcomes`,
`crm.client_next_bookings`, the KPI or payroll calculators, `UtilisationService`.
The reports boundary spec enforces this.

**R1 adapter change.** R1's bill-line read now also selects `staff_profile_id` and
`source_ref` (per-service linkage), and its retail read selects the seller. R1's
own output is unchanged — proven by comparing R1 with and without the new fields.

## 3. Money

**Service revenue** (U-1, U-2) = Σ gross of `service` lines on R1 paid bills; net of
VAT alongside. **Colour** = Σ `product_usage` lines, separate. Lines with no staff are
**Unattributed**; a line naming a profile that no longer exists is **Former staff**.
Adjustment lines never belong to staff; they stay in the team figures.

**Average bill** (U-3)
- Team and location: Σ gross of every line on R1 paid bills that have at least one
  line ÷ the number of those bills. This total equals R1 gross − R1 not itemised.
- Staff (and any set of staff): Σ gross of their service and colour lines ÷ the
  distinct bills holding at least one of those lines. A shared bill counts once for
  each staff member on it, and once for a set.
- Never averaged from staff averages. No bills → `no_bills`; mixed currency → R1's
  reason.

**Retail revenue** = Σ retail sales by seller (no seller → Unattributed).
**Retail share** (U-12) = retail ÷ service revenue gross, team and location only;
service revenue ≤ 0 → `no_service_revenue`.

**Reconciliation invariants** (per location and for the summary, single currency;
tested against R1 on one ledger):
- Σ staff service + Unattributed service = R1 composition `service`
- Σ staff colour + Unattributed colour = R1 composition `product_usage` = R1 colour
- Σ seller retail + Unattributed retail = R1 retail recorded
- team average-bill total = R1 gross − R1 not itemised
- Σ staff average-bill totals + Unattributed + other bill lines = team total

## 4. Utilisation (U-10)

The formula is the shared pure `computeDailyUtilisation`: available = rostered
shift time − (breaks ∪ reducing book-outs ∪ leave); booked = occupied appointment
time; per staff-day. R2 has its own assembler (`team-utilisation.ts`):

- staff-days are each location's **local** days, DST-safe, inside its window and
  never after its local today (a custom range running into the future counts no
  future rota or bookings);
- shifts, book-outs and bookings count only at their own location (as before);
- **approved leave is a STAFF-LEVEL absence (L-1, locked 2026-09-17).** It applies to
  the staff member across the business, whichever location recorded or approved it;
  the recording location is administrative context. R2 reads approved leave for the
  staff rostered in scope by staff id only — it never selects or filters by the
  recording location. Each leave row becomes the interval [start of its first date,
  start of the day after its last date) in the zone of the location being calculated
  (leave is recorded as whole dates); the shared formula unions it with breaks,
  book-outs and other leave, so overlapping or duplicate leave is never subtracted
  twice, and it removes only the rostered time it overlaps at that location.
  Example: approved leave on 15 Sep and a Kensington shift that day — Kensington loses
  the shift's time on 15 Sep, identically whether the leave was recorded at Kensington
  or Primrose Hill.
- **privacy:** the body carries only the resulting availability and utilisation —
  never where leave was recorded, how many rows exist, or that another location is
  involved. A manager's utilisation can therefore reflect leave administered
  elsewhere; that is the locked, legitimate figure (L-1).
- aggregates keep the shared semantics: minutes add up across staff-days, booked
  time on a day with no available time is left out, nothing is capped (over 100%
  stays visible). Booked time is summed per appointment slice, as before.

**Handoff note for ZAC (Oleksandr) — no ZAC change made.** ZAC's utilisation
(`UtilisationService` → `report.utilisation_summary`, `report.scorecard`,
`utilisation_rate`) differs from R2's canonical figures:
1. UTC days and a Monday week, not the location's local days and the business week
   start;
2. leave taken from the selected locations only and applied across them, so figures
   depend on the selection — the canonical rule is staff-wide leave from any location
   (L-1, §4);
3. scope from `allowedLocationIds` (merged across memberships);
4. no per-staff output.
When ZAC moves to canonical report facts it should read R2's figures, not recompute
them. Known shared-formula defects, unchanged in both: booked time can double count
overlapping `awaiting_payment`/`paid` rows, and booked time is not bounded by shifts.

## 5. Future Booking (U-5)

- **Population:** distinct clients with an eligible visit (completed, awaiting
  payment, paid) in scope. Staff = the qualifying visit's stylist; location = the
  visit's location.
- **Numerator:** those clients holding ≥1 appointment in the business starting after
  the generation instant, status pending or accepted — at any location, with anyone.
  The qualifying visits' own appointments never count.
- **Confirmed-only:** status accepted.
- **As at generation only**, labelled "As at …" in each location's local time. Never
  "as at period end": accept and reschedule history is not stored.
- Distinct-client arithmetic: a client counts once in any total that covers their
  visits; staff figures are never summed into location or team figures.
- No clients seen → `no_clients_seen`.

Future Booking is **not** Rebooking At Source. Rebooking At Source is unavailable
until M-A captures it at the source visit (§12).

## 6. Staff universe and staff filter (U-11, S-1d)

**Rows** per location: current active staff (active manager or stylist membership
with a staff profile) at the resolved locations, zero activity included; plus staff
with facts there in the period (bill lines, eligible visits, retail sales, rostered
shifts, location pay statements); plus **Unattributed** (when there are facts with
no staff); plus **Former staff** (facts naming a removed profile). Facts keep their
own location. A row states whether the person is currently active at that location,
labelled as current and never as history (L-3): "Current: Active here" (employment
status given only for someone active here now), or "Not currently active here ·
Historical activity" for a row that exists only because the period's facts name them —
with no employment status, so nothing implies they work at another location
(`currentEmploymentStatus` is `null` for those rows).

A current member with nothing recorded at the location in the period has
`hasRecordedActivity: false` and the page says "No recorded activity here in this
period" beside today's status (R-2). That row comes from the current membership only,
never from `primary_location_id`, and is never claimed as history.

**Picker:** every staff and former-staff row id, plus staff on a business-wide
statement the viewer may see (owners).

**Filter:** `?staff=` (Team only). It narrows staff rows and commission lines; it
never widens locations; location and team totals stay full-scope, with a **Selected
staff** subtotal (distinct bills and clients across the selection). Any requested id
outside the picker — unknown, another business's, or outside the viewer's
locations — fails with the same `403 report_staff_out_of_scope`.

**Not knowable without a staff–location history (M-D):** who was assigned but idle
in a past period, headcount as of a date, left versus moved.

## 7. Finalised commission (U-8, U-9)

Locked or paid **calculation** pay periods overlapping the report dates, newest
first, each shown on its own: statements as locked (commission, adjustments shown
separately, greater-of outcome), never recalculated, never approved/review/draft,
never superseded statements, never rolled up across periods.

- Business-wide period: owners only.
- Location period: the viewer's grant at that location must carry
  `report.commission.view` (owners always). The period's own location decides.
- Restrictions are stated whether or not any hidden period exists.

**Statement currency (R-3).** Audit of `payroll.pay_summaries.currency_code`:
- A. Not written from the calculation's currency: the only writer
  (`payroll-period.service.ts` generate) inserts the literal `'GBP'`, and the engine's
  input currency is the literal `'GBP'` too (`payroll-inputs.service.ts`), whatever the
  location's currency.
- B. Yes: the column is `not null default 'GBP'` (0073), so every summary — legacy or
  new — reads GBP with no proof it was the period's currency.
- C. No: nothing records provenance, so a trustworthy code cannot be told from a
  defaulted one.

Treatment: R2 never reads `currency_code`. Every statement's currency is
`{ status: 'unverified' }`; its commission and adjustments, and its period's total,
are `currency_unverified`; the period's `currencyCode` is `null`. The page says
amounts aren't shown because payroll didn't record the currency, and never shows
them in a guessed currency. Never relabelled with today's location or business
currency, never defaulted, never converted; locked summaries are not modified. A
statement whose currency is verified (a future provenance record) is stated in its
own currency — tested with GBP and EUR. Mixed verified currencies leave the period
total `mixed_currencies`; a period with no statements has no total
(`no_pay_statements`). Recording the currency with provenance belongs to Payroll
engine alignment (§12).

**Live commission is unavailable** (`payroll_rules_not_implemented`): the KPI
calculator is not used, the current payroll engine is not presented as the approved
rules, and no new calculator exists.

**Payroll lock / adjustment defect — HIGH PRIORITY, MUST FIX BEFORE FINALISED
COMMISSION G5.** At lock, adjustments whose `origin_pay_period_id` is null are skipped
by `.neq('origin_pay_period_id', periodId)` (`payroll-period.service.ts`), while the
inputs query includes them. The lock then returns 500 after the period is already
locked, and the adjustment stays unapplied, so it can be paid again next period. Not
changed in base R2.

## 8. Security

| Actor | Team report | Rows and totals | Finalised commission |
|---|---|---|---|
| Owner | Allowed | All business locations | All periods |
| Manager level (grant: performance + commission at A) | Allowed | A only | A's location periods |
| Manager with performance only at A | Allowed | A only | None (restriction stated) |
| manager@A + stylist@B | Allowed | A only; B never read | A's periods if granted |
| NULL-level manager | 403 | — | — |
| Receptionist level | 403 | — | — |
| Stylist | 403 | — | — |
| Custom level without Performance | 403 | — | — |

No R2 authorisation uses `primary_location_id` or `allowedLocationIds`.

**Cross-location privacy (R-1).** A viewer learns nothing recorded at a location
outside their Team report grant: rota, book-outs, bookings, visits, bills, retail, pay
statements and memberships are read only at resolved locations, the scope carries no
"every location" flag, and `team-privacy.spec.ts` — with the scope resolved by the real
scope service — proves manager@A's whole report is identical with and without such
facts at B and an archived location C, including for a manager with commission only
at B.

Two approved cross-location effects (locked 2026-09-17), each carrying only the
resulting figure:
- **Approved leave (L-1):** staff-wide, so it reduces A's utilisation wherever it was
  recorded. Tested: the report is identical whether the leave was recorded at A or B;
  everything else at B changes nothing but that utilisation; no provenance or count
  shows; overlapping leave is unioned; other staff's leave at B has no effect; leave
  outside the A shift has no effect.
- **Future Booking (L-2, U-5):** a pending or accepted appointment anywhere in the
  business counts for a client seen at A. The manager sees only the aggregate for
  clients seen at A — never the future appointment's location, stylist, time or id.
  Tested: the report is identical whether that booking is at A with one stylist or at
  B with another.

## 9. Contract

`GET /api/reports/team/result?…[&staff=…]` → `body: TeamReportBody`
(`packages/domain/src/team-report.ts`): `generatedAt`, `currencyCode`, `summary`,
`selectedStaff`, `locations[]` (totals, Selected staff, Future Booking as-at),
`staffRows[]`, `staffOptions[]`, `finalisedCommission`, `unavailableMetrics[]`,
`dataQuality`. Amounts, counts and ratios are `available | unavailable(reason) |
not_started`; ratios carry numerator, denominator and basis points. All arithmetic
is in the API; the web formats (percentages are placed from basis points).

## 10. Locked decisions (2026-09-16)

U-1 service revenue = service lines only, colour separate · U-2 gross headline, net
alongside · U-3 average bill as §3 · U-4 no At Source yet, no heuristic, periods
before capture unavailable · U-5 Future Booking as §5 · U-6 job role separate from
membership role, not in base R2 · U-7 targets compare on aligned periods only, no
target model yet · U-8 live commission unavailable · U-9 finalised commission as §7 ·
U-10 location-local assembler, no ZAC change, no cap (leave semantics: L-1) ·
U-11 staff universe as §6 · U-12 retail share team/location only.

## 11. Known issues outside base R2 (not changed)

- Payroll lock / adjustment defect (§7) — must fix before finalised-commission G5.
- Payroll: approve and lock of business-wide periods are not owner-only; exports
  ignore period status; manager payroll scope uses `primary_location_id`.
- KPI and payroll use merged `allowedLocationIds` (manager@A + stylist@B sees B).
- A V1 commission calculator (`kpi.calc`) still serves `/kpi/stylists`.
- Rebooking writers link later bookings to earlier visits with no time bound.
- Shared utilisation defects noted in §4.
- `pay_summaries.currency_code` has no provenance (§7): finalised-commission amounts
  stay `currency_unverified` until payroll records the currency. **Finalised
  commission cannot pass G5 until this is resolved.**
- **Location pay statements can be built from other locations' facts.** Payroll picks
  a location period's staff by `primary_location_id` and reads their visits and
  retail business-wide (`payroll-period.service.ts`, `payroll-inputs.service.ts`), so a
  statement on A's period — shown to a manager with commission view at A, as U-9
  requires — can reflect bills at B. Today only the base-pay-or-commission outcome is
  visible (amounts are `currency_unverified`); once currency provenance lands the
  amounts would show. Belongs to Payroll engine alignment; **check before finalised
  commission G5.**
- **Online booking treats approved leave as location-specific — HIGH PRIORITY, MUST FIX
  BEFORE PILOT** (L-1 makes it incorrect). Separate follow-up ticket "Staff-wide
  approved leave in availability"; not changed on this branch.
- Rota diary, my-week, operational-signal gaps and KPI/ZAC utilisation also read
  leave by location; rescheduling and shift creation do not check leave at all
  (same follow-up ticket).
- Performance follow-ups (no migration in base R2): `booking.visits` has no index on
  `(business_id, location_id, completed_at)`; id-chunk reads run one after another
  (e.g. future appointments for many thousands of clients).

## 12. Prerequisite tickets (after base R2)

- **M-A At Source capture:** write-once source-visit fact with explicit source-visit
  context; periods before capture stay unavailable.
- **M-B Job role and targets:** a job-role model separate from membership role;
  individual → role → location → business targets with percentage metrics; drop the
  global 50% rebooking default.
- **Payroll engine alignment:** R1 paid-bill revenue, At Source gate, Route 2, the
  manager weekly target with the planned-hours lock; retire the V1 calculator. Currency
  (L-4): payroll generation must persist the authoritative calculation currency;
  literal and default `'GBP'` stop counting as financial provenance; already locked
  historical summaries are never rewritten; define how new verified summaries are
  distinguished from legacy unverified rows (e.g. an explicit provenance marker set
  only by the new writer), so R2 can state verified ones and keep legacy ones
  `currency_unverified`. Location periods: choose staff by membership, not
  `primary_location_id`, and scope inputs to the period's location (§11).
- **M-C Retail linkage:** visit or standalone sale context captured and validated at
  sale time; direct table writes narrowed.
- Optional **M-D** effective-dated staff–location assignments.

## 13. Migrations and release

No migration; `0113`/`0114` stay reserved and no number is allocated. `team` stays
`release: 'foundation'`; the production report shell stays off; G5 is mandatory
before release.

## 14. Review items (2026-09-17)

- **R-1 Cross-location leave privacy:** the leave-elsewhere count and all
  "another location" wording were removed. The interim `availability_scope_ambiguous`
  rule (utilisation unavailable to non-owners) was superseded by L-1 below and removed.
- **Re-review follow-ups:** no "every business location" scope flag (it revealed
  whether other locations exist); the web "no arithmetic" boundary is a syntax-tree
  check; utilisation's ratio is gated on the stated minutes; R1 is pinned never to use
  the staff fields its adapter carries.
- **R-2 Zero-activity current staff:** proven, and labelled (§6).
- **R-3 Finalised commission currency:** audited and treated (§7).
- **R-4 Full suite:** `app.bootstrap.spec.ts` validated the environment when
  `AppModule` was imported, before its own placeholder env was applied, so it passed
  only where a local `.env` existed. It now loads `AppModule` after the placeholders;
  the full API command exits green with no `.env`.

**Final product decisions (2026-09-17, locked):**
- **L-1 Leave:** approved leave is staff-wide (§4). Online booking's location-specific
  leave is a separate HIGH PRIORITY defect, must fix before pilot (§11).
- **L-2 Future Booking:** cross-location counting approved; aggregate only, no future
  location, stylist or time (§5, §8).
- **L-3 Staff status wording:** "Not currently active here" / "Historical activity";
  nothing implies work at another location (§6).
- **L-4 Finalised commission currency:** `currency_unverified` handling approved;
  currency provenance added to Payroll engine alignment; finalised commission cannot
  pass G5 until resolved (§7, §12).
