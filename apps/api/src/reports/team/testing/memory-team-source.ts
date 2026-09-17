/**
 * In-memory TeamSource for tests. It applies the same predicates as
 * SupabaseTeamSource — business, per-location windows (overlap or instant), status
 * sets, keysets and the date overlaps — so a hand-built ledger can be reconciled
 * against the report. The adapter's query shapes are pinned in team-source.spec.ts.
 */
import { getReportDefinition, type ReportFilter, type WeekStartDay } from '@sheer/domain';
import type { ReportActor } from '../../report-actor';
import type { ReportScope } from '../../report-scope.service';
import type { MoneyAfter, MoneyWindow } from '../../money/money-source';
import { micros } from '../../money/testing/memory-money-source';
import { moneyScope, type ScopeLocation } from '../../money/testing/money-scope';
import type {
  AbsenceRow,
  ActiveMembershipRow,
  BookOutTypeRow,
  BookedAppointmentRow,
  EligibleVisitRow,
  FutureAppointmentRow,
  LeaveRow,
  LocalDateRange,
  PayPeriodRow,
  PaySummaryRow,
  ShiftBreakRow,
  ShiftRow,
  StaffEmploymentStatus,
  StaffProfileRow,
  TeamSource,
} from '../team-source';

export type AppointmentStatus = 'pending' | 'accepted' | 'rejected' | 'checked_in' | 'awaiting_payment' | 'paid' | 'cancelled' | 'no_show';
export type VisitStatus = 'checked_in' | 'in_progress' | 'completed' | 'cancelled' | 'awaiting_payment' | 'paid';

export interface TeamLedger {
  visits: Array<{ id: string; businessId: string; locationId: string; status: VisitStatus; completedAt: string | null; appointmentId: string | null; clientProfileId: string; primaryStaffProfileId: string | null }>;
  appointments: Array<{
    id: string;
    businessId: string;
    locationId: string;
    clientProfileId: string;
    staffProfileId: string | null;
    status: AppointmentStatus;
    startAt: string;
    endAt: string;
    occupiedRanges?: string | null;
  }>;
  memberships: Array<{ id: string; businessId: string; userProfileId: string; locationId: string | null; role: 'owner' | 'manager' | 'stylist' | 'client'; status: 'invited' | 'active' | 'suspended' | 'revoked' }>;
  staff: Array<{ id: string; businessId: string; userProfileId: string; name: string; employmentStatus?: StaffEmploymentStatus }>;
  shifts: Array<ShiftRow & { businessId: string; cancelled?: boolean }>;
  breaks: Array<ShiftBreakRow & { businessId: string }>;
  absences: Array<AbsenceRow & { businessId: string }>;
  bookOutTypes: Array<BookOutTypeRow & { businessId: string }>;
  leave: Array<LeaveRow & { businessId: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled' }>;
  payPeriods: Array<Omit<PayPeriodRow, 'status'> & { businessId: string; kind: 'calculation' | 'payment'; status: 'draft' | 'ready_for_review' | 'approved' | 'locked' | 'paid' }>;
  paySummaries: Array<PaySummaryRow & { businessId: string; supersededById?: string | null }>;
}

/** A fresh empty ledger: every call returns new arrays, so tests never share rows. */
export function emptyTeamLedger(): TeamLedger {
  return {
    visits: [],
    appointments: [],
    memberships: [],
    staff: [],
    shifts: [],
    breaks: [],
    absences: [],
    bookOutTypes: [],
    leave: [],
    payPeriods: [],
    paySummaries: [],
  };
}

export interface TeamReadLog {
  method: keyof TeamSource;
  businessId: string;
  windows?: readonly MoneyWindow[];
  ids?: readonly string[];
  locationIds?: readonly string[];
  ranges?: readonly LocalDateRange[];
  afterInstant?: string;
}

function overlapsWindow(locationId: string, startAt: string, endAt: string | null, windows: readonly MoneyWindow[]): boolean {
  return windows.some(
    (w) => w.locationId === locationId && micros(startAt) < micros(w.toUtcExclusive) && (endAt === null || micros(endAt) > micros(w.fromUtc)),
  );
}

const byId = <T extends { id: string }>(a: T, b: T) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export class MemoryTeamSource implements TeamSource {
  readonly reads: TeamReadLog[] = [];

  constructor(
    private readonly ledger: TeamLedger,
    private readonly serverCap = Number.POSITIVE_INFINITY,
  ) {}

  private take<T>(rows: T[], limit: number): T[] {
    return rows.slice(0, Math.min(limit, this.serverCap));
  }

  async eligibleVisits(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<EligibleVisitRow[]> {
    this.reads.push({ method: 'eligibleVisits', businessId, windows });
    const rows = this.ledger.visits
      .filter((v) => v.businessId === businessId && ['completed', 'awaiting_payment', 'paid'].includes(v.status) && v.completedAt !== null)
      .map((v) => ({ id: v.id, locationId: v.locationId, at: v.completedAt!, appointmentId: v.appointmentId, clientProfileId: v.clientProfileId, primaryStaffProfileId: v.primaryStaffProfileId }))
      .filter((v) => windows.some((w) => w.locationId === v.locationId && micros(v.at) >= micros(w.fromUtc) && micros(v.at) < micros(w.toUtcExclusive)))
      .filter((v) => {
        if (after === null) return true;
        const t = micros(v.at);
        const k = micros(after.key);
        return 'id' in after ? t > k || (t === k && v.id > after.id) : after.op === 'gt' ? t > k : t >= k;
      })
      .sort((a, b) => (micros(a.at) !== micros(b.at) ? (micros(a.at) < micros(b.at) ? -1 : 1) : byId(a, b)));
    return this.take(rows, limit);
  }

  async futureAppointments(businessId: string, clientIds: readonly string[], afterInstant: string, afterId: string | null, limit: number): Promise<FutureAppointmentRow[]> {
    this.reads.push({ method: 'futureAppointments', businessId, ids: clientIds, afterInstant });
    const rows = this.ledger.appointments
      .filter(
        (a) =>
          a.businessId === businessId &&
          clientIds.includes(a.clientProfileId) &&
          (a.status === 'pending' || a.status === 'accepted') &&
          micros(a.startAt) > micros(afterInstant) &&
          (afterId === null || a.id > afterId),
      )
      .sort(byId)
      .map((a) => ({ id: a.id, clientProfileId: a.clientProfileId, status: a.status as 'pending' | 'accepted' }));
    return this.take(rows, limit);
  }

  async activeMemberships(businessId: string, locationIds: readonly string[], afterId: string | null, limit: number): Promise<ActiveMembershipRow[]> {
    this.reads.push({ method: 'activeMemberships', businessId, ids: locationIds });
    const rows = this.ledger.memberships
      .filter(
        (m) =>
          m.businessId === businessId &&
          m.status === 'active' &&
          (m.role === 'manager' || m.role === 'stylist') &&
          m.locationId !== null &&
          locationIds.includes(m.locationId) &&
          (afterId === null || m.id > afterId),
      )
      .sort(byId)
      .map((m) => ({ id: m.id, userProfileId: m.userProfileId, locationId: m.locationId! }));
    return this.take(rows, limit);
  }

  async staffProfilesOfUsers(businessId: string, userProfileIds: readonly string[]): Promise<StaffProfileRow[]> {
    this.reads.push({ method: 'staffProfilesOfUsers', businessId, ids: userProfileIds });
    return this.profiles((s) => s.businessId === businessId && userProfileIds.includes(s.userProfileId));
  }

  async staffProfiles(businessId: string, staffProfileIds: readonly string[]): Promise<StaffProfileRow[]> {
    this.reads.push({ method: 'staffProfiles', businessId, ids: staffProfileIds });
    return this.profiles((s) => s.businessId === businessId && staffProfileIds.includes(s.id));
  }

  private profiles(match: (s: TeamLedger['staff'][number]) => boolean): StaffProfileRow[] {
    return this.ledger.staff
      .filter(match)
      .map((s) => ({ id: s.id, userProfileId: s.userProfileId, name: s.name, employmentStatus: s.employmentStatus ?? 'active' }));
  }

  async shifts(businessId: string, windows: readonly MoneyWindow[], afterId: string | null, limit: number): Promise<ShiftRow[]> {
    this.reads.push({ method: 'shifts', businessId, windows });
    const rows = this.ledger.shifts
      .filter((s) => s.businessId === businessId && !s.cancelled && overlapsWindow(s.locationId, s.startAt, s.endAt, windows) && (afterId === null || s.id > afterId))
      .sort(byId)
      .map(({ businessId: _b, cancelled: _c, ...row }) => row);
    return this.take(rows, limit);
  }

  async shiftBreaks(businessId: string, shiftIds: readonly string[], afterId: string | null, limit: number): Promise<ShiftBreakRow[]> {
    this.reads.push({ method: 'shiftBreaks', businessId, ids: shiftIds });
    const rows = this.ledger.breaks
      .filter((b) => b.businessId === businessId && shiftIds.includes(b.shiftId) && (afterId === null || b.id > afterId))
      .sort(byId)
      .map(({ businessId: _b, ...row }) => row);
    return this.take(rows, limit);
  }

  async absences(businessId: string, windows: readonly MoneyWindow[], afterId: string | null, limit: number): Promise<AbsenceRow[]> {
    this.reads.push({ method: 'absences', businessId, windows });
    const rows = this.ledger.absences
      .filter((a) => a.businessId === businessId && overlapsWindow(a.locationId, a.startAt, a.endAt, windows) && (afterId === null || a.id > afterId))
      .sort(byId)
      .map(({ businessId: _b, ...row }) => row);
    return this.take(rows, limit);
  }

  async bookOutTypes(businessId: string): Promise<BookOutTypeRow[]> {
    this.reads.push({ method: 'bookOutTypes', businessId });
    return this.ledger.bookOutTypes.filter((t) => t.businessId === businessId).map(({ businessId: _b, ...row }) => row);
  }

  async approvedLeave(
    businessId: string,
    locationIds: readonly string[],
    staffProfileIds: readonly string[],
    ranges: readonly LocalDateRange[],
    afterId: string | null,
    limit: number,
  ): Promise<LeaveRow[]> {
    this.reads.push({ method: 'approvedLeave', businessId, locationIds, ids: staffProfileIds, ranges });
    const rows = this.ledger.leave
      .filter(
        (l) =>
          l.businessId === businessId &&
          l.status === 'approved' &&
          locationIds.includes(l.locationId) &&
          staffProfileIds.includes(l.staffProfileId) &&
          ranges.some((r) => l.startDate <= r.to && l.endDate >= r.from) &&
          (afterId === null || l.id > afterId),
      )
      .sort(byId)
      .map(({ businessId: _b, status: _s, ...row }) => row);
    return this.take(rows, limit);
  }

  async bookedAppointments(businessId: string, windows: readonly MoneyWindow[], afterId: string | null, limit: number): Promise<BookedAppointmentRow[]> {
    this.reads.push({ method: 'bookedAppointments', businessId, windows });
    const booked = ['pending', 'accepted', 'checked_in', 'awaiting_payment', 'paid'];
    const rows = this.ledger.appointments
      .filter(
        (a) =>
          a.businessId === businessId &&
          booked.includes(a.status) &&
          a.staffProfileId !== null &&
          overlapsWindow(a.locationId, a.startAt, a.endAt, windows) &&
          (afterId === null || a.id > afterId),
      )
      .sort(byId)
      .map((a) => ({ id: a.id, locationId: a.locationId, staffProfileId: a.staffProfileId!, startAt: a.startAt, endAt: a.endAt, occupiedRanges: a.occupiedRanges ?? null }));
    return this.take(rows, limit);
  }

  async finalisedPayPeriods(businessId: string, ranges: readonly LocalDateRange[], afterId: string | null, limit: number): Promise<PayPeriodRow[]> {
    this.reads.push({ method: 'finalisedPayPeriods', businessId, ranges });
    const rows = this.ledger.payPeriods
      .filter(
        (p) =>
          p.businessId === businessId &&
          p.kind === 'calculation' &&
          (p.status === 'locked' || p.status === 'paid') &&
          ranges.some((r) => p.periodStart <= r.to && p.periodEnd > r.from) &&
          (afterId === null || p.id > afterId),
      )
      .sort(byId)
      .map((p) => ({ id: p.id, locationId: p.locationId, label: p.label, periodStart: p.periodStart, periodEnd: p.periodEnd, status: p.status as 'locked' | 'paid' }));
    return this.take(rows, limit);
  }

  async paySummaries(businessId: string, payPeriodIds: readonly string[], afterId: string | null, limit: number): Promise<PaySummaryRow[]> {
    this.reads.push({ method: 'paySummaries', businessId, ids: payPeriodIds });
    const rows = this.ledger.paySummaries
      .filter((s) => s.businessId === businessId && payPeriodIds.includes(s.payPeriodId) && !s.supersededById && (afterId === null || s.id > afterId))
      .sort(byId)
      .map(({ businessId: _b, supersededById: _s, ...row }) => row);
    return this.take(rows, limit);
  }
}

/** A Ticket A scope for the Team report, as the scope service resolves it. */
/** The viewer's grant for the Team report. Default: exactly the resolved locations. */
export interface TeamGrant {
  permittedLocationIds: readonly string[];
}

export function teamScope(
  businessId: string,
  locations: readonly ScopeLocation[],
  filter: ReportFilter,
  asOf: Date,
  actor: ReportActor = { id: 'owner-1', businessId, roles: ['owner'] },
  weekStartDay: WeekStartDay = 2,
  grant?: TeamGrant,
): ReportScope {
  const scope = moneyScope(businessId, locations, filter, asOf, weekStartDay);
  return { ...scope, ...grant, actor, definition: getReportDefinition('team')!, resolved: { ...scope.resolved, reportKey: 'team' } };
}
