/**
 * Rota management — test scaffold.
 *
 * The repo's Jest config is currently `--passWithNoTests` (see
 * apps/api/package.json). These `it.todo` entries record the test cases
 * the rota management phase requires so the cases are not lost when a
 * Jest harness lands. They mirror the conventions used by
 * staff.service.spec.ts and locations.service.spec.ts.
 *
 * When implementing:
 *   - mock SupabaseClient with `jest.fn()` covers for `.schema().from().select()/insert()/update()/delete()`
 *     chains and for `.rpc()` results.
 *   - cover guard rails (manager scope, owner scope, past-edit reason).
 *   - cover validation: time ranges, break-in-shift, break overlaps,
 *     overlapping shift exclusion constraint.
 *   - cover audit row insertion (one per mutation, with the right action).
 */

describe('RotaService — getWeeklyRota', () => {
  it.todo('manager can read their own location rota for the requested week');
  it.todo('manager 403s when querying another location');
  it.todo('manager with no allowedLocationIds gets BadRequest (locationId is required)');
  it.todo('owner can read any location in their business');
  it.todo('weekStart is snapped to Monday before filtering shifts');
  it.todo('staff list is sorted by displayName and excludes terminated employees');
  it.todo('default break minutes fall back to 30 when staff has no break_defaults row');
  it.todo('holidayNoticeDays falls back to 30 when location_settings is missing');
  it.todo('breaks are grouped under their shift in the response');
  it.todo('leave + absence indicators that overlap the week are included');
});

describe('RotaService — shift CRUD', () => {
  it.todo('manager can create a shift for staff at their location');
  it.todo('manager 403s when target staff belongs to another location');
  it.todo('createShift requires pastEditReason when start is in the past');
  it.todo('createShift rejects scheduled_end_at <= scheduled_start_at');
  it.todo('createShift returns 400 when the rota_shifts_no_overlap exclusion fires');
  it.todo('updateShift preserves location and accepts partial fields');
  it.todo('updateShift requires pastEditReason when shift is or becomes past');
  it.todo('updateShift writes a past_edit audit row instead of update when applicable');
  it.todo('deleteShift requires pastEditReason for past shifts');
  it.todo('deleteShift writes an audit row and 404s for unknown shifts');
});

describe('RotaService — break CRUD', () => {
  it.todo('addBreak rejects breaks outside the shift range');
  it.todo('addBreak rejects breaks that overlap an existing break on the same shift');
  it.todo('addBreak requires pastEditReason on past shifts');
  it.todo('updateBreak validates time and overlap against the *other* breaks');
  it.todo('deleteBreak removes the row and writes an audit row');
});

describe('RotaService — leave requests', () => {
  it.todo('listLeaveRequests scopes to the manager location by default');
  it.todo('listLeaveRequests with status filter respects the enum (pending/approved/rejected/cancelled/all)');
  it.todo('approveLeaveRequest blocks when start_date is inside the holiday-notice window without override=true');
  it.todo('approveLeaveRequest allows override=true and records an "override" audit action');
  it.todo('approveLeaveRequest rejects requests not in pending status');
  it.todo('rejectLeaveRequest writes status=rejected, reviewer, and a "reject" audit row');
  it.todo('manager 403s when approving a request for a foreign location');
});

describe('RotaService — absences', () => {
  it.todo('markAbsence persists absence_events and audits as mark_absence');
  it.todo('markAbsence rejects ends_at <= starts_at');
  it.todo('manager 403s when targeting staff from another location');
});

describe('RotaService — past-edit audit', () => {
  it.todo('past_edit audit rows include the actor user_profile_id, role, and reason');
  it.todo('past edits without a reason are rejected with BadRequest');
  it.todo('audit failures never block the primary mutation (logged, not thrown)');
});

describe('RotaService — new week generation', () => {
  it.todo('previewNewWeek returns 403 for manager accessing foreign location');
  it.todo('previewNewWeek returns warnings if target week already has shifts');
  it.todo('previewNewWeek for clone_last_week returns correct counts based on previous week');
  it.todo('previewNewWeek for generate_from_defaults returns correct counts based on staff defaults');
  it.todo('createNewWeek blocks if target week already has shifts');
  it.todo('createNewWeek for clone_last_week copies previous week shifts for the manager location only');
  it.todo('createNewWeek for clone_last_week shifts cloned shift and break timestamps forward by 7 days');
  it.todo('createNewWeek for clone_last_week remaps break rows to the new shift ids');
  it.todo('createNewWeek for clone_last_week rejects when the previous week has no shifts');
  it.todo('createNewWeek for clone_last_week is atomic when any shift or break insert fails');
  it.todo('createNewWeek for generate_from_defaults generates shifts and breaks from defaults');
});

describe('RotaService — stylist self-service', () => {
  it.todo('stylist can fetch only their own weekly rota via my-week');
  it.todo('stylist my-week includes own shifts, breaks, approved leave, and absences only');
  it.todo('stylist can list only their own leave requests');
  it.todo('stylist can create a leave request only for their own staff profile');
  it.todo('stylist leave request records holiday notice metadata for manager review');
  it.todo('stylist can cancel only their own pending leave request');
  it.todo('stylist cannot cancel approved, rejected, or already-cancelled leave requests');
  it.todo('owner and manager cannot call stylist self-service endpoints');
});
