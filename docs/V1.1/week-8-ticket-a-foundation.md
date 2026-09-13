# QLOOQO V1.1 Week 8 — Ticket A: Universal Report Foundation

**Status:** approved 2026-09-13. Normative for every QLOOQO 10 report built on
top of it (R1 Money, R7 Cash Up, R2 Team, R6 Colour Lab, P&L, exports).

**Ownership.** Cosan owns all non-ZAC implementation, including the Dashboard.
Oleksandr owns ZAC. Ticket A changes no ZAC file; when canonical report metrics
later need ZAC to move, that is a handoff task for Oleksandr.

**Gates.** G1 definition → G2 canonical backend → G3 reconciliation/security
tests → G4 UI → G5 hosted manual UAT. **COMPLETE means G5 passed.**

---

## 1. What Ticket A delivers

- One registry of reports (`REPORT_DEFINITIONS` in `@sheer/domain`) that drives
  the API guards, the web routes and the sidebar through one decision function.
- A strict/lenient filter codec shared by the browser URL and the API query.
- Per-location local-date resolution on the server, from each location's own
  IANA timezone.
- Fail-closed, per-membership report access.
- `GET /api/reports/:reportKey/options` and `GET /api/reports/:reportKey/result`
  (result `body` is always `null` in Ticket A).
- The Report Control Bar (presets, custom range, locations, summary/detail) with
  an **actions slot** for Ticket G exports and a **staff slot** that no report
  uses yet.
- A foundation preview shell behind a flag, off by default. Production shows no
  report navigation until a report is released.

Ticket A adds **no Supabase migration**. Migration numbers `0113` and `0114`
stay permanently reserved; new Week 8 migrations start at `0115` when a later
ticket needs one.

---

## 2. Report access — fails closed

A missing security level must never broaden report access.

| Actor | Rule |
|---|---|
| Owner (active owner membership) | Every report, at every location of the business, inactive included. |
| Non-owner | Needs an **active manager membership** at the location, carrying an **explicitly assigned, existing, same-business security level** whose expanded permissions contain the report's permission. |
| Manager membership with a NULL level | **No report access.** Front desk and managers are indistinguishable when no level is set (there is no receptionist role and no job-title field), so role defaults are never used for reports. |
| Stylist membership | **Never** grants a management report, whatever level the stylist row carries. |
| Front desk | No report access, unless the business deliberately gives the person a manager membership with a qualifying level. |

The grants are resolved at sign-in into `AuthUser.membershipGrants`: one entry
per qualifying manager membership, `{ locationId, permissions }`. Owners carry
no grants. The merged `AuthUser.permissions` and `allowedLocationIds` are
unchanged and are **never** read by reporting — that is what stops a
manager@A + stylist@B from reaching B's reports.

### Report permissions

| Report | Permission |
|---|---|
| Money | `report.financials.view` |
| Cash up | `report.financials.view` (sign-off stays on `eod.sign_off`) |
| Team report | `report.performance.view` |
| Colour lab | `report.lab_analytics.view` |
| P&L | `report.pnl.view` |

`report.pnl.view` is new and exists only in the catalogue (no migration). It is
in the owner **role** defaults, and in no manager role default and no system
security level (Owner and Group Admin levels exclude it). An owner can delegate
it by adding it to a custom level. P&L includes revenue, so delegating P&L also
delegates the revenue figures inside it. "Financials" is relabelled
"Financials (revenue)".

### Actor matrix

Y = allowed; — = API 403 / web `/unauthorized` / no nav entry.

| Actor | money | cash-up | team | colour-lab | pnl | Locations |
|---|---|---|---|---|---|---|
| Owner | Y | Y | Y | Y | Y | all |
| manager@A, Manager level | Y | Y | Y | Y | — | A |
| manager@A, NULL level | — | — | — | — | — | none |
| manager@A, Receptionist level (as seeded) | — | — | — | — | — | none |
| stylist@B, any level | — | — | — | — | — | none |
| manager@A + stylist@B, Manager level on both | Y | Y | Y | Y | — | A only |
| manager@A NULL + stylist@A Manager level | — | — | — | — | — | none |
| manager@A Manager + manager@C NULL (from invite) | Y | Y | Y | Y | — | A only |
| Group Admin level on manager@A, manager@C | Y | Y | Y | Y | — | A, C |
| manager@A on the Owner system level | Y | Y | Y | Y | — | A |
| manager@A, custom level including `report.pnl.view` | per level | per level | per level | per level | Y | A |
| manager@A, custom level without `report.financials.view` | — | — | per level | per level | per level | A |
| Membership at an inactive location, Manager level | Y | Y | Y | Y | — | that location, shown as Closed |
| Dangling level, or another business's level | — | — | — | — | — | none |
| Suspended / revoked / invited manager row | — | — | — | — | — | none |

### Release prerequisite (every environment, including LOH)

Before any report is released in an environment:

1. Audit active manager memberships with a NULL security level (aggregate count).
2. The owner classifies each person's actual job.
3. Managers get the Manager level, or a custom level (for a manager who is also a
   stylist, a custom level of Manager permissions plus `payroll.self.view`
   avoids losing own-pay visibility, because assigning a level writes it to
   every manager and stylist row of that person). Front desk gets the
   Receptionist level. **Nothing is backfilled automatically.**

On dev-test (2026-09-13) this affects 2 of 3 non-owner manager users.

---

## 3. Dates — per location, never shared

- **Relative presets** (`today`, `yesterday`, `this_week`, `last_week`,
  `this_month`, `last_month`) resolve **independently for each selected
  location** from that location's IANA timezone, at one request instant. At an
  instant where London is 13 Sep and Tokyo is 14 Sep, "Today" is London 13 Sep
  and Tokyo 14 Sep.
- **Custom ranges** apply the user's local `YYYY-MM-DD` dates to every location
  **as given** — no clamping to today, and a range in the future is valid. Each
  location converts them to its own half-open UTC interval.
- **No UTC envelope** is ever used as a query boundary. Every fact must lie
  inside its own location's window.
- Each resolved location reports `localToday`, `from`, `to` and a status:
  `complete` (to < localToday), `in_progress` (from ≤ localToday ≤ to),
  `not_started` (from > localToday). A report must render unstarted days as
  "not started", never as 0 or £0.00.
- **Week start** is the business's existing `payroll.payroll_settings.week_start_day`
  (0 = Sunday), read with a SELECT only. `options` always reads it (so the
  control bar can disable week presets); `result` reads it only for week
  presets. A missing row or invalid value is reported explicitly
  (`409 report_week_start_unconfigured`; `options.weekStartDay: null`) — never
  silently Monday. A failed read is a 500, never "unconfigured".
- **A preset is not one custom range.** When locations' local dates differ, no
  single custom range reproduces a preset, so URLs, saved views and future
  scheduled exports store the preset, and exports print per-location ranges.
- **DST.** `localDateStartUtc` returns the first instant of the local date,
  including in zones where midnight is skipped (Santiago, Havana, Azores), where
  the clock falls back over midnight (first midnight wins) and on dates that
  never existed (an empty window). Payroll shares this helper; results in
  London, New York and Los Angeles are unchanged for 2000–2030.

Limits: custom ranges up to 366 days, from 2000-01-01 to 2099-12-31 inclusive;
at most 50 ids per list; each parameter at most once (a repeated parameter is
refused, never resolved by picking one copy).

---

## 4. API contract

```
GET /api/reports/:reportKey/options
GET /api/reports/:reportKey/result?preset&from&to&locations&staff&view
```

Guard order: `ReportAvailabilityGuard` (404 before auth, identical for unknown
and unavailable reports) → `SupabaseAuthGuard` (401) → `ReportAccessGuard` (403).
No handler carries role/permission metadata. Handler responses (200s and the
typed refusals thrown by the scope resolver) send `Cache-Control: no-store,
private`; the guards' 404/401/403 are thrown before the handler and carry no
report data.

**options** takes no selection query in Ticket A, so it cannot return a
selection-related 400 or 403. It returns every location the actor may report on
— inactive locations and locations with an invalid timezone included, flagged by
`isActive` and `timezoneValid` — and `weekStartDay`. An actor whose permitted
set for the report is **empty** still receives
`403 report_no_locations_in_scope`.

**result** resolves in this order:

0. the global ValidationPipe refuses unknown parameters, non-string values
   (including a parameter repeated in the query string) and over-long values
   with Nest's standard untyped 400 — no `code`, no issue list
1. strict decode → `400 report_control_not_supported` if any issue is an
   unsupported control, otherwise `400 report_filter_invalid` with the issues
2. business locations (inactive included)
3. permitted set empty → `403 report_no_locations_in_scope`
4. any selected id outside the permitted set → `403 report_location_out_of_scope`
   (whole request; identical for foreign, unknown and not-permitted ids)
5. an invalid timezone among the resolved locations → `422 report_timezone_invalid`
   listing only those ids
6. week presets only: week start → `409 report_week_start_unconfigured`
7. per-location windows

`[]` locations means every permitted location. A database read failure is a 500
and is never reported as "missing".

### Provider invariant (every later report service)

- Every fact belongs to a resolved location and lies in that location's
  `[fromUtc, toUtcExclusive)`, or in `[from, to]` for date columns.
- Unstarted locations/days are rendered as not started, never zero.
- Staff filters (when a later ticket adds them) only ever narrow.
- Sub-gates (e.g. commission) use per-grant location checks, never
  `allowedLocationIds` or merged `permissions`.

---

## 5. Staff control — decision S-1d

The schema cannot reconstruct historical staff-location assignment: moves and
role changes hard-delete membership rows, status timestamps are overwritten,
`primary_location_id` is overwritten on moves, and there is no staff-location
history table.

Therefore Ticket A ships **no staff scope**:

- `team.controls.staff` is `false`; every report refuses `staff`
  (`400 report_control_not_supported`).
- `ReportDefinition.controls.staff`, `ReportFilter.staffProfileIds` and the
  control bar's staff slot remain in the contract so R2 can switch it on.
- R2 decides the durable staff-scope model from its canonical facts. If an
  effective-dated staff-location relationship is needed, R2 adds it in a fresh
  migration (`0115+`). Neither `primary_location_id` nor rota shifts nor
  appointments are an authorisation model.

---

## 6. Navigation and release

- Each definition has `release: 'foundation' | 'released'`. Availability
  (`release === 'released'` or the foundation shell is on) is a separate check
  from permission; `reportAccessDecision` combines them.
- The foundation shell is on only when `REPORTS_FOUNDATION_SHELL === 'true'`
  (API) and `VITE_REPORTS_FOUNDATION_SHELL === 'true'` (web, baked at build).
  Default off; no dev-mode default and no browser override. Set on dev-test only.
- With the shell on, the sidebar shows "Reports (preview)" with each report the
  user may open; each page shows the control bar, the per-location scope line
  and a "Foundation preview" banner, and no figures.
- With the shell off, `/reports/*` redirects to `/` and `/api/reports/*` returns
  404 before auth.
- A report is released by a **separate commit after its own G5 sign-off**, and
  only once the §2 release prerequisite and §7 preconditions are met.
- Deploy the API before the web, so an old API never strips `report.pnl.view`
  when an owner saves a level.

---

## 7. Known exposure outside Ticket A

Recorded, not fixed here:

1. Existing pages (`/dashboard`, `/performance`, `/commission`, `/kpi/*`,
   `/lab/analytics`) still use merged permissions and merged location ids, so
   NULL-level managers and front desk keep the access they have today. Closed
   in the Dashboard/ZAC migration stage; must be tracked before any report is
   released to production.
2. A non-owner with `staff.manage` can add manager memberships for themselves;
   new rows copy an existing level. Follow-up to decide before any report is
   released to production.
3. A holder of `security.manage` can assign themselves a level containing
   `report.pnl.view`.
4. ZAC `report.profitability` stays gated on `payroll.view` (ZAC is untouched).

---

## 8. Out of scope for Ticket A

Report figures (R1–P&L), exports (Ticket G builds CSV/PDF/email into the actions
slot), staff scope (R2), Dashboard and ZAC migration, any migration.
