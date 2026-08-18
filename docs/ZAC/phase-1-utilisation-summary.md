# ZAC — Utilisation Summary (Phase 1 Core MVP tool, implemented)

> **Status: implemented and enabled.** `report.utilisation_summary` is the
> final Core MVP tool from the Phase 1 plan ("explain utilisation patterns and
> diary gaps"). QLab analytics and stock/inventory remain the optional/deferred
> skeletons.

## 1. One source of truth

The tool invents **no formula**. It feeds a new server-side aggregation
(`UtilisationService`, `apps/api/src/kpi/utilisation.service.ts`) into the
canonical **`computeDailyUtilisation`** from `@sheer/domain` — the same pure
function behind the web calendar's utilisation badge, specified by
`apps/api/src/kpi/utilisation.spec.ts` and by the domain's own worked example
(9h shift − 30m lunch − 1h reducing meeting, 6h booked → 7.5h available →
80%). The service spec reproduces that exact example against seeded data.

## 2. The business definition

Per staff member per day:

```
utilisation % = round(booked stylist-occupied time ÷ available time × 100)
available     = union(non-cancelled rota shifts)
                − (shift breaks ∪ book-outs/leave whose type reduces available hours)
```

- **Numerator**: `booking.appointments.occupied_ranges` — the write-time
  multirange snapshot the double-booking exclusion constraint keys on
  (stylist-free development segments already excluded by the writers; 0050
  backfilled whole-span for legacy rows; a NULL column falls back to the
  scheduled span). Occupying statuses are the shared
  `UTILISATION_BOOKED_STATUSES` (pending, accepted, checked_in,
  awaiting_payment, paid) — cancelled/rejected/no-show free the slot. The web
  board now imports this list from the domain too.
- **Denominator**: `rota.shifts` (status ≠ cancelled) − `rota.shift_breaks` −
  `rota.absence_events` whose `book_out_types.reduces_available_hours` is true
  (legacy untyped absences reduce, per `LEGACY_BOOK_OUT_BEHAVIOUR`). Approved
  `rota.leave_requests` remove the whole staff-day (web-calendar parity).
- **Null, not zero**: no available time → utilisation is null and ZAC says so.
- **Timezone**: UTC day boundaries — the rota module's documented MVP
  convention ("the only supported timezone family is Europe/London").

Aggregates: overall + previous same-length period, per-location, per-weekday
(quietest/busiest), the three largest unbooked-but-available diary windows
(≥30 min, with staff name), and the per-location
`utilisation_warning_threshold_percent` (default 60 — previously stored but
consumed by nothing) as the benchmark: below it, the response is a Watch
Point; otherwise an Insight.

## 3. Permissions & scope

Owner/manager roles with **effective** `report.performance.view` — the same
permission as the other staff-performance tools; registry visibility and
dispatch both re-check it. Owners see business locations, managers their
assigned locations (single-location focus validated against that scope,
ForbiddenException otherwise); the service refuses non-owner/manager actors
outright. Stylist questions about team/business utilisation hit the stylist
restricted refusal and dispatch nothing. Inputs: `{ period?: today|week|month
(default week), locationId? }`.

## 4. Routing, memory, grounding

- *"What is my utilisation this week?"* → `qlooqo_data` → this tool.
  *"Why are Tuesdays quiet?"* / diary-gap phrasings route here too.
- *"Generally, how can salons improve utilisation?"* → general advice, no
  tool. *"If utilisation were 45%…"* / *"Ignore my QLOOQO data…"* →
  hypothetical, no tool, 45% stays a user assumption. (Regression-tested.)
- A remembered goal ("My utilisation goal is 75%") rides into narration as
  attributed memory context — *"your stated goal of 75%"* — while the live
  figure comes from tool evidence; a narration presenting an invented figure
  (or a derived number outside evidence/memory) falls back to the
  deterministic answer via the existing grounding system.

## 5. Measurement spine

Nothing new: a utilisation turn persists its `zac.tool_calls` row, its output
(feedback-ready `output_id`), and its model cost events with full
trace/conversation linkage, exactly like every other live tool.

## 6. Data limitations (real, from the sources)

- Utilisation requires a **filled-in rota**; with no shifts in the period the
  tool refuses honestly ("no rota shifts are recorded") rather than inventing
  a percentage. A rota that IS filled in but fully zeroed by leave/book-outs
  gets its own accurate refusal ("the rota is filled in, but…").
- Booked time on days without a rota shift is excluded from the numerator and
  flagged; booked time at a **different location** than that day's shift is
  excluded with its own distinct note (each location measures its own rostered
  hours — matching the web board's per-location columns).
- A midnight-crossing shift is split across both UTC days server-side, while
  the web badge shows it only on its start day — a rare-shape attribution
  difference on the input side; the formula itself is shared.
- Day boundaries are UTC (Europe/London operating assumption) — stated in
  every answer's limitations.
- `chairCount` ("the denominator for utilisation reporting" in an old domain
  comment) is **not** part of the canonical formula — the platform measures
  against rostered hours, not chairs. The stale comment is a known
  documentation discrepancy; the code-level source of truth is
  `computeDailyUtilisation`.

## 7. Tests

```bash
cd apps/api
npx jest src/kpi/utilisation.service.spec.ts        # canonical parity, scope, leave, gaps, no-data, isolation
npx jest src/zac/zac.service.spec.ts -t "utilisation" # routing, permissions, memory, grounding, spine
npx jest src/zac src/kpi                             # everything
```
