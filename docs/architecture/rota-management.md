# Rota management — Phase 1 (manager surface, reusable core)

This phase ships the **manager-facing rota surface** and lays down the
reusable backend/domain layer that owner and stylist views will sit on
top of in later phases. The schema scaffolding for shifts, breaks,
leave, and absences was already in place from
`supabase/migrations/0005_rota_foundation.sql`; this phase adds the
configuration + audit pieces and wires up the API + web UI.

## Scope (and non-scope)

In-scope this phase:

- Manager weekly rota board for their assigned location.
- Shift CRUD (create, edit, delete) with overlap protection.
- Break CRUD on a shift, with the existing schema invariants
  (within-shift, no overlap) enforced server-side.
- Leave-request approval / rejection with the **holiday-notice rule**
  and a manager **override** path.
- Sickness / absence marking with full audit capture.
- Mandatory **reason capture** for any past-rota edit, persisted to
  the rota audit log.
- Per-stylist break defaults that pre-fill the shift form.

Out of scope this phase (deferred, but the backend already supports
them where relevant):

- Owner rota UI — backend allows owner callers, but the web page
  intentionally renders a "coming soon" hint when `role === 'owner'`.
- Stylist self-service rota in the Sheer App (no UI yet; the service
  already has the scaffolding for `kind: 'self'`).
- Stylist leave request creation (only managers approve / reject in
  this phase; stylist UX comes with the mobile app rota view).
- Booking-availability re-computation, target re-calculation, and
  notification side effects when a shift changes.

## Database

New migration: `supabase/migrations/0014_rota_management.sql`.

| Object                                  | Purpose |
| --------------------------------------- | ------- |
| `rota.staff_break_defaults`             | Per-stylist default break length / paid flag / notes. One row per `staff_profile`. |
| `core.location_settings.holiday_notice_days` | Per-location threshold for the auto-decline rule. Default `30`, range `0..365`. |
| `audit.rota_audit_events`               | Append-only log of who-did-what-when on rota records. |

RLS: owners can read every audit row in their business; managers can
read only audit rows scoped to a location they manage. **All writes
to all three tables flow through the service-role API**, matching the
existing convention used by Lab access events. Authenticated clients
do not touch the audit table directly.

The shift / break / leave / absence tables themselves keep their
existing RLS policies from `0007_rls_helpers_and_policies.sql` and the
`rota_shifts_no_overlap` exclusion constraint from
`0008_indexes_and_triggers.sql`.

## Backend

New module: `apps/api/src/rota/`.

```
apps/api/src/rota/
├── dto.ts
├── rota.controller.ts
├── rota.module.ts
├── rota.service.ts
└── rota.service.spec.ts   ← it.todo scaffold (matches staff/locations style)
```

`RotaService` is the **reusable core**. Every public method takes the
`AuthUser` actor as the first argument and applies role-aware scoping:

| Method                                                    | Scoping behaviour |
| --------------------------------------------------------- | ----------------- |
| `getWeeklyRota(actor, locationId, weekStart)`             | manager → must be in `allowedLocationIds`. Owner → any location in business. (Future: stylist will project to self.) |
| `createShift / updateShift / deleteShift`                 | manager → own location only. Owner → business-wide. Past edits require a reason. |
| `addBreak / updateBreak / deleteBreak`                    | inherits the parent shift's location scope. Validates within-shift + no-overlap. |
| `listLeaveRequests / approveLeaveRequest / rejectLeaveRequest` | manager → own location. Owner → business-wide. Approval respects holiday notice + override. |
| `markAbsence`                                             | manager → own location. Owner → business-wide. |
| `saveWeeklyRota` (optional bulk path)                     | wraps create/update for week-level publish flows. |

Endpoints exposed (under the existing `/api` global prefix):

| Method | Path                                              | Auth roles      |
| ------ | ------------------------------------------------- | --------------- |
| GET    | `/api/rota/week`                                  | owner, manager  |
| POST   | `/api/rota/shifts`                                | owner, manager  |
| PATCH  | `/api/rota/shifts/:id`                            | owner, manager  |
| DELETE | `/api/rota/shifts/:id`                            | owner, manager  |
| POST   | `/api/rota/shifts/:shiftId/breaks`                | owner, manager  |
| PATCH  | `/api/rota/shifts/:shiftId/breaks/:breakId`       | owner, manager  |
| DELETE | `/api/rota/shifts/:shiftId/breaks/:breakId`       | owner, manager  |
| GET    | `/api/rota/leave-requests`                        | owner, manager  |
| POST   | `/api/rota/leave-requests/:id/approve`            | owner, manager  |
| POST   | `/api/rota/leave-requests/:id/reject`             | owner, manager  |
| POST   | `/api/rota/absence-events`                        | owner, manager  |
| POST   | `/api/rota/week/save`                             | owner, manager  |

The role guard is `@RequireRoles('owner', 'manager')`. Manager
location scope is enforced inside `RotaService` (mirroring the
`LocationsService` pattern), not at the URL level.

### Holiday notice rule

`approveLeaveRequest` reads `core.location_settings.holiday_notice_days`
for the request's location and compares it to `start_date - today`:

- If the request is **outside** the threshold → approved normally.
- If the request is **inside** the threshold and `override !== true`
  → server returns `400` with a message instructing the manager to
  resubmit with `override: true`.
- If `override === true` → approved, with an `override` audit row that
  captures `days_until_start`, the `required_notice_days` for the
  location, and the manager's note.

Stylists never trigger this code path in this phase (they can't
create leave requests in the web app). When the mobile app adds the
"request leave" UX, the same rule will surface as an inline warning
*before* submission, but the server check is still authoritative.

### Past-edit audit rule

Any mutation that touches a record in the past — creating a shift in
the past, editing a past shift / break, deleting one — requires a
non-empty `pastEditReason`. The reason is forwarded into a
`audit.rota_audit_events` row with `action='past_edit'` plus the
actor's user-profile id and role. Audit failures never block the
primary mutation; they log loudly so operators can investigate.

The web client never asks for the reason up-front. Instead it tries
the action, watches for the server's "Reason is required for editing
…" 400, and **only then** opens the past-edit dialog. Once the
manager confirms, the same call is replayed with the reason attached.
This keeps the happy path one-click while preserving audit integrity.

### Per-stylist break defaults

`rota.staff_break_defaults` rows are read alongside the staff list
inside `getWeeklyRota`. Each `RotaStaffSummary` carries
`defaultBreakMinutes` and `defaultBreakIsPaid`, defaulting to 30 min
unpaid when no row exists. The shift editor uses these values to
suggest break end-times and the paid checkbox state when the manager
adds a break. Owners write the defaults via a future settings UI; for
now they are seedable directly through the service-role client.

## Web frontend

New routes:
- `/rota`: mounted under the existing dashboard `<ProtectedRoute allowedRoles={['owner', 'manager']}>`. Owner role renders a placeholder note; manager role renders the full board.
- `/rota/new-week`: a dedicated creation flow for generating the next week's schedule.

```
apps/web/src/components/rota/
├── dateUtils.ts           ← shared date/week helpers
├── LeaveRequestsPanel.tsx ← list + approve/reject + override
├── MarkAbsenceModal.tsx
├── PastEditReasonDialog.tsx
├── ShiftEditorModal.tsx   ← shift CRUD + inline break editor
└── WeeklyRotaBoard.tsx    ← grid: stylists × 7 days
apps/web/src/pages/RotaPage.tsx
apps/web/src/pages/NewWeekRotaPage.tsx ← new week creation flow
```

### New Week Generation (`/rota/new-week`)

This page is a dedicated creation flow for managers to generate the next week's schedule safely. It supports three creation modes:
1. **Clone previous week**: Copies shifts and breaks from the previous week, advancing dates by 7 days.
2. **Generate from staff defaults**: Scaffolds a basic Mon-Fri 9-5 schedule for all bookable staff, inserting default breaks if configured.
3. **Blank week**: Initializes an empty week.

The page uses a two-step process: `previewNewWeek` to fetch expected counts and warnings (e.g. if shifts already exist), followed by `createNewWeek` to perform the actual generation. It then redirects back to the main `/rota` board.

Key UX rules baked into the manager surface:

- No location switcher: the page reads
  `auth.user.allowedLocationIds[0]` and locks itself to that location.
  If the manager has no allowed location, a friendly empty state is
  rendered.
- Click an empty cell → "new shift" modal pre-filled with stylist +
  date.
- Click an existing shift chip → "edit shift" modal with the same
  form plus the inline break editor.
- "Mark absence" can be triggered from the page header or per-stylist
  row.
- Leave-request panel sits below the board with status filters; rows
  inside the holiday-notice window switch the green Approve button to
  "Approve with override".
- Past-edit dialog only opens when the server flags the operation —
  there are no user-facing date predicate checks duplicated on the
  client.

### Sidebar / navigation

The existing sidebar already shows "Rota" to both owners and managers
(see `apps/web/src/components/Sidebar.tsx`). No nav changes were
needed — the placeholder previously mounted at `/rota` is replaced by
the live `RotaPage` for managers and a "coming soon" panel for
owners.

## Shape: WeeklyRotaResponse

```ts
interface WeeklyRotaResponse {
  locationId: string;
  weekStart: string;        // ISO date — Monday
  weekEnd: string;          // ISO date — exclusive end
  staff: RotaStaffSummary[]; // sorted by displayName, terminated excluded
  shifts: RotaShift[];      // each carries its breaks[] inline
  leave: RotaLeaveIndicator[];
  absences: RotaAbsenceIndicator[];
  holidayNoticeDays: number;
  scope: 'owner' | 'manager';
}
```

`scope` mirrors the `ListLocationsResponse` pattern so the client can
branch UI without a second `/auth/me` round-trip. `holidayNoticeDays`
is echoed alongside the leave list so the panel can render the rule
in the help text without another fetch.

## Why these guardrails

- **Manager cannot escape their location**: every service method
  re-derives scope from `actor.allowedLocationIds`. Even if the role
  guard regressed, the service-side check would 403.
- **No silent past edits**: any past-time mutation requires a reason
  AND writes a `past_edit` audit row containing the manager id, role,
  and reason.
- **Notice-rule overrides are visible**: an `override` audit row with
  `required_notice_days` + `days_until_start` makes operations
  trivially auditable later (e.g. "show me approvals overridden in
  the last quarter").
- **Audit table is service-role-only**: no user can forge or delete
  audit rows directly. RLS even denies INSERT to authenticated users.
- **Schema overlap protection survives**: the existing
  `rota_shifts_no_overlap` exclusion constraint catches any race that
  bypasses the application-level check; the service translates that
  into a friendly 400.

## TODOs

- [ ] Replace the `it.todo` scaffold in `rota.service.spec.ts` with
      real Jest tests when a Jest harness lands.
- [ ] Owner rota page (`/rota` for `role === 'owner'`) — add a
      location switcher, reuse the same `WeeklyRotaBoard`.
- [ ] Stylist rota view in the Sheer App — wire up the same backend
      with a `kind: 'self'` projection and the new
      `RotaStaffSummary.userProfileId` filter.
- [ ] Owner-side editor for `rota.staff_break_defaults` (so per-
      stylist defaults can be tuned without DB access).
- [ ] Stylist-side leave request creation that respects the
      holiday-notice rule client-side (server is authoritative).
- [ ] Reproject week boundaries into the location's timezone instead
      of UTC when timezones outside Europe/London are introduced.
