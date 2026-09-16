/**
 * Read access to the non-money facts R2 Team reports (QLOOQO V1.1 Week 8).
 * Money is read through R1 Money's own loader (`loadMoneyFacts`), never here.
 *
 * Every read filters `business_id`. Windowed reads bind EACH location to its own
 * Ticket A window — OR-ed per location, never an envelope. Reads use an id (or
 * instant, id) keyset, never an offset. Staff come from actual memberships and
 * from the facts themselves — never `staff_profiles.primary_location_id`.
 * docs/V1.1/week-8-r2-team.md §2.
 */
import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { UTILISATION_BOOKED_STATUSES } from '@sheer/domain';
import type { MoneyAfter, MoneyWindow } from '../money/money-source';
import { MoneySourceShapeError, instantKey, integerValue, isInstantKey, isUuid, isWindowBound } from '../money/money-values';

export interface EligibleVisitRow {
  id: string;
  locationId: string;
  /** `completed_at` as an instant key. */
  at: string;
  appointmentId: string | null;
  clientProfileId: string;
  primaryStaffProfileId: string | null;
}

export type FutureAppointmentStatus = 'pending' | 'accepted';

export interface FutureAppointmentRow {
  id: string;
  clientProfileId: string;
  status: FutureAppointmentStatus;
}

export interface ActiveMembershipRow {
  id: string;
  userProfileId: string;
  locationId: string;
}

export type StaffEmploymentStatus = 'active' | 'on_leave' | 'notice' | 'terminated';

export interface StaffProfileRow {
  id: string;
  userProfileId: string;
  name: string;
  employmentStatus: StaffEmploymentStatus;
}

export interface ShiftRow {
  id: string;
  locationId: string;
  staffProfileId: string;
  /** Instant keys. */
  startAt: string;
  endAt: string;
}

export interface ShiftBreakRow {
  id: string;
  shiftId: string;
  startAt: string;
  endAt: string;
}

export interface AbsenceRow {
  id: string;
  locationId: string;
  staffProfileId: string;
  startAt: string;
  /** `null`: open-ended. */
  endAt: string | null;
  bookOutTypeId: string | null;
}

export interface BookOutTypeRow {
  id: string;
  reducesAvailableHours: boolean;
}

export interface LeaveRow {
  id: string;
  locationId: string;
  staffProfileId: string;
  /** Inclusive local dates as recorded. */
  startDate: string;
  endDate: string;
}

export interface BookedAppointmentRow {
  id: string;
  locationId: string;
  staffProfileId: string;
  startAt: string;
  endAt: string;
  /** The stored `occupied_ranges` text; `null` for a row that predates it. */
  occupiedRanges: string | null;
}

export interface PayPeriodRow {
  id: string;
  /** `null`: a business-wide pay period. */
  locationId: string | null;
  label: string | null;
  periodStart: string;
  /** Exclusive, as stored. */
  periodEnd: string;
  status: 'locked' | 'paid';
}

export interface PaySummaryRow {
  id: string;
  payPeriodId: string;
  staffProfileId: string;
  currencyCode: string;
  commissionCents: number;
  adjustmentsCents: number;
  greaterOfApplied: boolean;
  greaterOfWinner: 'base_pay' | 'commission' | null;
}

/** An inclusive local date range. */
export interface LocalDateRange {
  from: string;
  to: string;
}

export interface TeamSource {
  /** Completed, awaiting-payment and paid visits by `completed_at`, per location window, after the keyset. */
  eligibleVisits(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<EligibleVisitRow[]>;
  /** Pending or accepted appointments of the given clients starting after `afterInstant`, by id keyset. */
  futureAppointments(businessId: string, clientIds: readonly string[], afterInstant: string, afterId: string | null, limit: number): Promise<FutureAppointmentRow[]>;
  /** Active manager and stylist memberships at the given locations, by id keyset. */
  activeMemberships(businessId: string, locationIds: readonly string[], afterId: string | null, limit: number): Promise<ActiveMembershipRow[]>;
  /** Staff profiles of the given users (one per user per business). */
  staffProfilesOfUsers(businessId: string, userProfileIds: readonly string[]): Promise<StaffProfileRow[]>;
  /** The given staff profiles that still exist. */
  staffProfiles(businessId: string, staffProfileIds: readonly string[]): Promise<StaffProfileRow[]>;
  /** Non-cancelled rota shifts overlapping each location's window, by id keyset. */
  shifts(businessId: string, windows: readonly MoneyWindow[], afterId: string | null, limit: number): Promise<ShiftRow[]>;
  shiftBreaks(businessId: string, shiftIds: readonly string[], afterId: string | null, limit: number): Promise<ShiftBreakRow[]>;
  /** Book-outs overlapping each location's window (open-ended included), by id keyset. */
  absences(businessId: string, windows: readonly MoneyWindow[], afterId: string | null, limit: number): Promise<AbsenceRow[]>;
  bookOutTypes(businessId: string): Promise<BookOutTypeRow[]>;
  /** Approved leave of the given staff, at any location, overlapping any of the date ranges, by id keyset. */
  approvedLeave(businessId: string, staffProfileIds: readonly string[], ranges: readonly LocalDateRange[], afterId: string | null, limit: number): Promise<LeaveRow[]>;
  /** Appointments that occupy a stylist (utilisation's booked statuses) overlapping each location's window, by id keyset. */
  bookedAppointments(businessId: string, windows: readonly MoneyWindow[], afterId: string | null, limit: number): Promise<BookedAppointmentRow[]>;
  /** Locked or paid calculation pay periods overlapping any of the date ranges, by id keyset. */
  finalisedPayPeriods(businessId: string, ranges: readonly LocalDateRange[], afterId: string | null, limit: number): Promise<PayPeriodRow[]>;
  /** Current (not superseded) statements of the given pay periods, by id keyset. */
  paySummaries(businessId: string, payPeriodIds: readonly string[], afterId: string | null, limit: number): Promise<PaySummaryRow[]>;
}

export const TEAM_SOURCE = Symbol('TEAM_SOURCE');

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ELIGIBLE_VISIT_STATUSES = ['completed', 'awaiting_payment', 'paid'] as const;
const FUTURE_STATUSES: readonly FutureAppointmentStatus[] = ['pending', 'accepted'];
const EMPLOYMENT_STATUSES: readonly StaffEmploymentStatus[] = ['active', 'on_leave', 'notice', 'terminated'];

type Row = Record<string, unknown>;

function assertUuids(ids: readonly string[]): void {
  if (ids.some((id) => !isUuid(id))) throw new Error('team source received an invalid id');
}

function assertWindow(window: MoneyWindow): void {
  if (!isUuid(window.locationId) || !isWindowBound(window.fromUtc) || !isWindowBound(window.toUtcExclusive)) {
    throw new Error('team source received an invalid window');
  }
}

function assertRange(range: LocalDateRange): void {
  if (!LOCAL_DATE.test(range.from) || !LOCAL_DATE.test(range.to)) throw new Error('team source received an invalid date');
}

/** `(location_id = L AND start < to AND end > from)` per location, OR-ed. */
export function overlapFilter(startColumn: string, endColumn: string, windows: readonly MoneyWindow[], openEnded = false): string {
  if (windows.length === 0) throw new Error('overlapFilter needs at least one window');
  return windows
    .map((window) => {
      assertWindow(window);
      const end = openEnded
        ? `or(${endColumn}.is.null,${endColumn}.gt."${window.fromUtc}")`
        : `${endColumn}.gt."${window.fromUtc}"`;
      return `and(location_id.eq.${window.locationId},${startColumn}.lt."${window.toUtcExclusive}",${end})`;
    })
    .join(',');
}

/** `(start <= to AND end >= from)` (or `end > from` when the end is exclusive) per range, OR-ed. */
export function dateOverlapFilter(startColumn: string, endColumn: string, ranges: readonly LocalDateRange[], endExclusive: boolean): string {
  if (ranges.length === 0) throw new Error('dateOverlapFilter needs at least one range');
  return ranges
    .map((range) => {
      assertRange(range);
      return `and(${startColumn}.lte.${range.to},${endColumn}.${endExclusive ? 'gt' : 'gte'}.${range.from})`;
    })
    .join(',');
}

function visitKeyset(after: MoneyAfter): string {
  if (!isInstantKey(after.key)) throw new Error('keyset received an invalid instant');
  if ('id' in after) {
    if (!isUuid(after.id)) throw new Error('keyset received an invalid id');
    return `or(completed_at.gt."${after.key}",and(completed_at.eq."${after.key}",id.gt.${after.id}))`;
  }
  return `completed_at.${after.op}."${after.key}"`;
}

/** Per-location `completed_at` windows with the keyset inside each clause. */
export function visitWindowFilter(windows: readonly MoneyWindow[], after: MoneyAfter | null): string {
  if (windows.length === 0) throw new Error('visitWindowFilter needs at least one window');
  const keyset = after === null ? null : visitKeyset(after);
  return windows
    .map((window) => {
      assertWindow(window);
      const parts = [`location_id.eq.${window.locationId}`, `completed_at.gte."${window.fromUtc}"`, `completed_at.lt."${window.toUtcExclusive}"`];
      if (keyset) parts.push(keyset);
      return `and(${parts.join(',')})`;
    })
    .join(',');
}

function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new MoneySourceShapeError(what);
  return value;
}

function nullableText(value: unknown, what: string): string | null {
  return value === null || value === undefined ? null : text(value, what);
}

function localDate(value: unknown, what: string): string {
  const date = text(value, what);
  if (!LOCAL_DATE.test(date)) throw new MoneySourceShapeError(what);
  return date;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], what: string): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) throw new MoneySourceShapeError(what);
  return value as T;
}

function bool(value: unknown, what: string): boolean {
  if (typeof value !== 'boolean') throw new MoneySourceShapeError(what);
  return value;
}

/** A stored integer amount (bigint columns may arrive as strings). */
function bigintCents(value: unknown, what: string): number {
  const number = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  return integerValue(number, what);
}

@Injectable()
export class SupabaseTeamSource implements TeamSource {
  private readonly logger = new Logger(SupabaseTeamSource.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async eligibleVisits(businessId: string, windows: readonly MoneyWindow[], after: MoneyAfter | null, limit: number): Promise<EligibleVisitRow[]> {
    const rows = await this.run('visits', () =>
      this.admin
        .schema('booking')
        .from('visits')
        .select('id,location_id,completed_at,appointment_id,client_profile_id,primary_staff_profile_id')
        .eq('business_id', businessId)
        .in('status', [...ELIGIBLE_VISIT_STATUSES])
        .or(visitWindowFilter(windows, after))
        .order('completed_at', { ascending: true })
        .order('id', { ascending: true })
        .limit(limit)
        .returns<Row[]>(),
    );
    return rows.map((row) => ({
      id: text(row.id, 'visit id'),
      locationId: text(row.location_id, 'visit location'),
      at: instantKey(row.completed_at),
      appointmentId: nullableText(row.appointment_id, 'visit appointment'),
      clientProfileId: text(row.client_profile_id, 'visit client'),
      primaryStaffProfileId: nullableText(row.primary_staff_profile_id, 'visit staff'),
    }));
  }

  async futureAppointments(
    businessId: string,
    clientIds: readonly string[],
    afterInstant: string,
    afterId: string | null,
    limit: number,
  ): Promise<FutureAppointmentRow[]> {
    assertUuids(clientIds);
    if (afterId !== null) assertUuids([afterId]);
    if (!isInstantKey(afterInstant)) throw new Error('team source received an invalid instant');
    if (clientIds.length === 0) return [];
    const rows = await this.run('appointments', () => {
      let query = this.admin
        .schema('booking')
        .from('appointments')
        .select('id,client_profile_id,status')
        .eq('business_id', businessId)
        .in('client_profile_id', [...clientIds])
        .in('status', [...FUTURE_STATUSES])
        .gt('scheduled_start_at', afterInstant);
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit).returns<Row[]>();
    });
    return rows.map((row) => ({
      id: text(row.id, 'appointment id'),
      clientProfileId: text(row.client_profile_id, 'appointment client'),
      status: oneOf(row.status, FUTURE_STATUSES, 'appointment status'),
    }));
  }

  async activeMemberships(businessId: string, locationIds: readonly string[], afterId: string | null, limit: number): Promise<ActiveMembershipRow[]> {
    assertUuids(locationIds);
    if (afterId !== null) assertUuids([afterId]);
    if (locationIds.length === 0) return [];
    const rows = await this.run('user_memberships', () => {
      let query = this.admin
        .schema('core')
        .from('user_memberships')
        .select('id,user_profile_id,location_id')
        .eq('business_id', businessId)
        .eq('status', 'active')
        .in('role', ['manager', 'stylist'])
        .in('location_id', [...locationIds]);
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit).returns<Row[]>();
    });
    return rows.map((row) => ({
      id: text(row.id, 'membership id'),
      userProfileId: text(row.user_profile_id, 'membership user'),
      locationId: text(row.location_id, 'membership location'),
    }));
  }

  staffProfilesOfUsers(businessId: string, userProfileIds: readonly string[]): Promise<StaffProfileRow[]> {
    return this.readStaffProfiles(businessId, 'user_profile_id', userProfileIds);
  }

  staffProfiles(businessId: string, staffProfileIds: readonly string[]): Promise<StaffProfileRow[]> {
    return this.readStaffProfiles(businessId, 'id', staffProfileIds);
  }

  private async readStaffProfiles(businessId: string, column: 'id' | 'user_profile_id', ids: readonly string[]): Promise<StaffProfileRow[]> {
    assertUuids(ids);
    if (ids.length === 0) return [];
    // One staff profile per id and per user in a business, so a chunk can never exceed its own size.
    const rows = await this.run('staff_profiles', () =>
      this.admin
        .schema('core')
        .from('staff_profiles')
        .select('id,user_profile_id,display_name,employment_status')
        .eq('business_id', businessId)
        .in(column, [...ids])
        .limit(ids.length)
        .returns<Row[]>(),
    );
    return rows.map((row) => ({
      id: text(row.id, 'staff id'),
      userProfileId: text(row.user_profile_id, 'staff user'),
      name: text(row.display_name, 'staff name'),
      employmentStatus: oneOf(row.employment_status, EMPLOYMENT_STATUSES, 'staff employment status'),
    }));
  }

  async shifts(businessId: string, windows: readonly MoneyWindow[], afterId: string | null, limit: number): Promise<ShiftRow[]> {
    if (afterId !== null) assertUuids([afterId]);
    const rows = await this.run('shifts', () => {
      let query = this.admin
        .schema('rota')
        .from('shifts')
        .select('id,location_id,staff_profile_id,scheduled_start_at,scheduled_end_at')
        .eq('business_id', businessId)
        .neq('status', 'cancelled')
        .or(overlapFilter('scheduled_start_at', 'scheduled_end_at', windows));
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit).returns<Row[]>();
    });
    return rows.map((row) => ({
      id: text(row.id, 'shift id'),
      locationId: text(row.location_id, 'shift location'),
      staffProfileId: text(row.staff_profile_id, 'shift staff'),
      startAt: instantKey(row.scheduled_start_at),
      endAt: instantKey(row.scheduled_end_at),
    }));
  }

  async shiftBreaks(businessId: string, shiftIds: readonly string[], afterId: string | null, limit: number): Promise<ShiftBreakRow[]> {
    assertUuids(shiftIds);
    if (afterId !== null) assertUuids([afterId]);
    if (shiftIds.length === 0) return [];
    const rows = await this.run('shift_breaks', () => {
      let query = this.admin
        .schema('rota')
        .from('shift_breaks')
        .select('id,shift_id,started_at,ended_at')
        .eq('business_id', businessId)
        .in('shift_id', [...shiftIds]);
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit).returns<Row[]>();
    });
    return rows.map((row) => ({
      id: text(row.id, 'break id'),
      shiftId: text(row.shift_id, 'break shift'),
      startAt: instantKey(row.started_at),
      endAt: instantKey(row.ended_at),
    }));
  }

  async absences(businessId: string, windows: readonly MoneyWindow[], afterId: string | null, limit: number): Promise<AbsenceRow[]> {
    if (afterId !== null) assertUuids([afterId]);
    const rows = await this.run('absence_events', () => {
      let query = this.admin
        .schema('rota')
        .from('absence_events')
        .select('id,location_id,staff_profile_id,starts_at,ends_at,book_out_type_id')
        .eq('business_id', businessId)
        .or(overlapFilter('starts_at', 'ends_at', windows, true));
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit).returns<Row[]>();
    });
    return rows.map((row) => ({
      id: text(row.id, 'absence id'),
      locationId: text(row.location_id, 'absence location'),
      staffProfileId: text(row.staff_profile_id, 'absence staff'),
      startAt: instantKey(row.starts_at),
      endAt: row.ends_at === null ? null : instantKey(row.ends_at),
      bookOutTypeId: nullableText(row.book_out_type_id, 'absence book-out type'),
    }));
  }

  async bookOutTypes(businessId: string): Promise<BookOutTypeRow[]> {
    // A handful per business; read whole.
    const rows = await this.run('book_out_types', () =>
      this.admin
        .schema('rota')
        .from('book_out_types')
        .select('id,reduces_available_hours')
        .eq('business_id', businessId)
        .order('id', { ascending: true })
        .returns<Row[]>(),
    );
    return rows.map((row) => ({
      id: text(row.id, 'book-out type id'),
      reducesAvailableHours: bool(row.reduces_available_hours, 'book-out type reduces'),
    }));
  }

  async approvedLeave(
    businessId: string,
    staffProfileIds: readonly string[],
    ranges: readonly LocalDateRange[],
    afterId: string | null,
    limit: number,
  ): Promise<LeaveRow[]> {
    assertUuids(staffProfileIds);
    if (afterId !== null) assertUuids([afterId]);
    if (staffProfileIds.length === 0 || ranges.length === 0) return [];
    const rows = await this.run('leave_requests', () => {
      let query = this.admin
        .schema('rota')
        .from('leave_requests')
        .select('id,location_id,staff_profile_id,start_date,end_date')
        .eq('business_id', businessId)
        .eq('status', 'approved')
        .in('staff_profile_id', [...staffProfileIds])
        .or(dateOverlapFilter('start_date', 'end_date', ranges, false));
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit).returns<Row[]>();
    });
    return rows.map((row) => ({
      id: text(row.id, 'leave id'),
      locationId: text(row.location_id, 'leave location'),
      staffProfileId: text(row.staff_profile_id, 'leave staff'),
      startDate: localDate(row.start_date, 'leave start'),
      endDate: localDate(row.end_date, 'leave end'),
    }));
  }

  async bookedAppointments(businessId: string, windows: readonly MoneyWindow[], afterId: string | null, limit: number): Promise<BookedAppointmentRow[]> {
    if (afterId !== null) assertUuids([afterId]);
    const rows = await this.run('appointments', () => {
      let query = this.admin
        .schema('booking')
        .from('appointments')
        .select('id,location_id,assigned_staff_profile_id,scheduled_start_at,scheduled_end_at,occupied_ranges')
        .eq('business_id', businessId)
        .in('status', [...UTILISATION_BOOKED_STATUSES])
        .not('assigned_staff_profile_id', 'is', null)
        .or(overlapFilter('scheduled_start_at', 'scheduled_end_at', windows));
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit).returns<Row[]>();
    });
    return rows.map((row) => ({
      id: text(row.id, 'appointment id'),
      locationId: text(row.location_id, 'appointment location'),
      staffProfileId: text(row.assigned_staff_profile_id, 'appointment staff'),
      startAt: instantKey(row.scheduled_start_at),
      endAt: instantKey(row.scheduled_end_at),
      occupiedRanges: nullableText(row.occupied_ranges, 'appointment occupied ranges'),
    }));
  }

  async finalisedPayPeriods(businessId: string, ranges: readonly LocalDateRange[], afterId: string | null, limit: number): Promise<PayPeriodRow[]> {
    if (afterId !== null) assertUuids([afterId]);
    if (ranges.length === 0) return [];
    const rows = await this.run('pay_periods', () => {
      let query = this.admin
        .schema('payroll')
        .from('pay_periods')
        .select('id,location_id,label,period_start,period_end,status')
        .eq('business_id', businessId)
        .eq('kind', 'calculation')
        .in('status', ['locked', 'paid'])
        .or(dateOverlapFilter('period_start', 'period_end', ranges, true));
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit).returns<Row[]>();
    });
    return rows.map((row) => ({
      id: text(row.id, 'pay period id'),
      locationId: nullableText(row.location_id, 'pay period location'),
      label: row.label === null || row.label === undefined ? null : String(row.label),
      periodStart: localDate(row.period_start, 'pay period start'),
      periodEnd: localDate(row.period_end, 'pay period end'),
      status: oneOf(row.status, ['locked', 'paid'] as const, 'pay period status'),
    }));
  }

  async paySummaries(businessId: string, payPeriodIds: readonly string[], afterId: string | null, limit: number): Promise<PaySummaryRow[]> {
    assertUuids(payPeriodIds);
    if (afterId !== null) assertUuids([afterId]);
    if (payPeriodIds.length === 0) return [];
    const rows = await this.run('pay_summaries', () => {
      let query = this.admin
        .schema('payroll')
        .from('pay_summaries')
        .select('id,pay_period_id,staff_profile_id,currency_code,commission_cents,adjustments_cents,greater_of_applied,greater_of_winner')
        .eq('business_id', businessId)
        .in('pay_period_id', [...payPeriodIds])
        .is('superseded_by_id', null);
      if (afterId !== null) query = query.gt('id', afterId);
      return query.order('id', { ascending: true }).limit(limit).returns<Row[]>();
    });
    return rows.map((row) => {
      const code = typeof row.currency_code === 'string' ? row.currency_code.trim().toUpperCase() : '';
      if (!/^[A-Z]{3}$/.test(code)) throw new MoneySourceShapeError('pay summary currency');
      const winner = row.greater_of_winner;
      return {
        id: text(row.id, 'pay summary id'),
        payPeriodId: text(row.pay_period_id, 'pay summary period'),
        staffProfileId: text(row.staff_profile_id, 'pay summary staff'),
        currencyCode: code,
        commissionCents: bigintCents(row.commission_cents, 'pay summary commission'),
        adjustmentsCents: bigintCents(row.adjustments_cents, 'pay summary adjustments'),
        greaterOfApplied: bool(row.greater_of_applied, 'pay summary greater-of'),
        greaterOfWinner: winner === null ? null : oneOf(winner, ['base_pay', 'commission'] as const, 'pay summary greater-of winner'),
      };
    });
  }

  /** A database or shape failure is a 500, never an empty (zero) report. */
  private async run(table: string, query: () => PromiseLike<{ data: Row[] | null; error: unknown }>): Promise<Row[]> {
    const { data, error } = await query();
    if (error) {
      this.logger.error(`team source read of ${table} failed`, error instanceof Error ? error.stack : String(JSON.stringify(error)));
      throw new InternalServerErrorException();
    }
    if (!Array.isArray(data)) {
      this.logger.error(`team source read of ${table} returned no rows array`);
      throw new InternalServerErrorException();
    }
    return data;
  }
}
