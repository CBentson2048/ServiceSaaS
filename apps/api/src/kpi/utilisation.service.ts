import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import {
  computeDailyUtilisation,
  normaliseIntervalsMs,
  resolveBookOutBehaviour,
  subtractIntervalsMs,
  totalIntervalMs,
  UTILISATION_BOOKED_STATUSES,
  userHasRole,
  type UtilisationIntervalMs,
} from '@sheer/domain';
import { parseMultirange } from '../common/occupied-ranges';

const DAY_MS = 86_400_000;
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

export type UtilisationPeriod = 'today' | 'week' | 'month';

export interface UtilisationQuery {
  locationId?: string;
  period?: UtilisationPeriod;
}

export interface UtilisationBucket {
  availableMinutes: number;
  bookedMinutes: number;
  /** booked ÷ available × 100 rounded; null when nothing was available. */
  utilisationPercent: number | null;
}

export interface UtilisationGap {
  locationId: string;
  locationName: string;
  staffName: string;
  date: string;
  weekday: string;
  startIso: string;
  endIso: string;
  minutes: number;
}

export interface UtilisationSummaryResponse {
  scope: 'owner' | 'manager';
  period: UtilisationPeriod;
  rangeStart: string;
  rangeEnd: string;
  locations: { id: string; name: string }[];
  overall: UtilisationBucket & { staffDayCount: number };
  previousPeriod: UtilisationBucket;
  byLocation: Array<UtilisationBucket & { locationId: string; locationName: string }>;
  byWeekday: Array<UtilisationBucket & { weekday: string }>;
  quietestWeekday: string | null;
  busiestWeekday: string | null;
  /** Largest unbooked-but-available diary windows in the period (up to 3). */
  largestGaps: UtilisationGap[];
  /** Per-location warning benchmark, when a single location is in focus. */
  warningThresholdPercent: number | null;
  /** Honest data-quality notes (missing rota, bookings without shifts, ...). */
  dataQuality: string[];
}

interface ShiftRow {
  id: string;
  location_id: string;
  staff_profile_id: string;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
}

interface BreakRow {
  shift_id: string;
  started_at: string;
  ended_at: string;
}

interface AbsenceRow {
  location_id: string;
  staff_profile_id: string;
  starts_at: string;
  ends_at: string | null;
  book_out_type_id: string | null;
}

interface LeaveRow {
  staff_profile_id: string;
  start_date: string;
  end_date: string;
}

interface AppointmentRow {
  location_id: string;
  assigned_staff_profile_id: string | null;
  status: string;
  scheduled_start_at: string;
  scheduled_end_at: string;
  occupied_ranges: string | null;
}

interface StaffDay {
  staffId: string;
  locationId: string;
  dayStartMs: number;
  available: UtilisationIntervalMs[];
  availableMs: number;
  bookedMs: number;
  booked: UtilisationIntervalMs[];
}

/**
 * The server-side utilisation path — the ONE thing the disabled ZAC skeleton
 * was blocked on. It computes nothing novel: per staff-day it assembles rota
 * shifts (non-cancelled), breaks, reducing book-outs/leave and the stylist-
 * occupied appointment time, and hands them to the CANONICAL
 * `computeDailyUtilisation` from @sheer/domain — the same formula behind the
 * web calendar badge. Known input-attribution edge vs the badge: a
 * midnight-crossing shift is split across both UTC days here, while the badge
 * shows it only on its start day (rota validation makes such shifts rare).
 *
 * Numerator provenance: `booking.appointments.occupied_ranges`, the write-time
 * multirange snapshot the double-booking exclusion constraint itself keys on
 * (stylist-free development segments already excluded by the writers; 0050
 * backfilled whole-span for legacy rows). Statuses: the shared
 * UTILISATION_BOOKED_STATUSES list.
 *
 * Day boundaries are UTC — the rota module's documented MVP convention
 * ("the only supported timezone family is Europe/London").
 */
@Injectable()
export class UtilisationService {
  private readonly logger = new Logger(UtilisationService.name);
  private readonly admin: SupabaseClient;

  constructor(config: ConfigService) {
    const supabaseUrl = config.getOrThrow<string>('SUPABASE_URL');
    const serviceRoleKey = config.getOrThrow<string>('SUPABASE_SERVICE_ROLE_KEY');
    this.admin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
  }

  async summary(actor: AuthUser, query: UtilisationQuery = {}): Promise<UtilisationSummaryResponse> {
    const scope = this.resolveScope(actor, query.locationId);
    const period = query.period ?? 'week';
    const { startMs, endMs } = this.resolveRange(period);
    const previousRange = { startMs: startMs - (endMs - startMs), endMs: startMs };

    const [current, previous, locationNames, threshold] = await Promise.all([
      this.collectStaffDays(actor.businessId, scope.locationIds, startMs, endMs),
      this.collectStaffDays(actor.businessId, scope.locationIds, previousRange.startMs, previousRange.endMs),
      this.fetchLocationNames(actor.businessId, scope.locationIds),
      scope.locationIds.length === 1
        ? this.fetchWarningThreshold(actor.businessId, scope.locationIds[0])
        : Promise.resolve(null),
    ]);

    const overall = this.bucket(current.staffDays);
    const dataQuality = [...current.dataQuality];
    if (current.staffDays.length === 0) {
      dataQuality.push('No rota shifts are recorded for this period — utilisation cannot be measured without rostered hours.');
    }

    const byLocation = scope.locationIds
      .map((locationId) => ({
        locationId,
        locationName: locationNames.get(locationId) ?? 'Unknown location',
        ...this.bucket(current.staffDays.filter((day) => day.locationId === locationId)),
      }))
      .filter((entry) => entry.availableMinutes > 0 || entry.bookedMinutes > 0);

    const byWeekday = this.weekdayBuckets(current.staffDays);
    const measured = byWeekday.filter((entry) => entry.utilisationPercent !== null);
    const quietest = measured.length > 1
      ? measured.reduce((min, entry) => (entry.utilisationPercent! < min.utilisationPercent! ? entry : min))
      : null;
    const busiest = measured.length > 1
      ? measured.reduce((max, entry) => (entry.utilisationPercent! > max.utilisationPercent! ? entry : max))
      : null;

    return {
      scope: scope.kind,
      period,
      rangeStart: new Date(startMs).toISOString(),
      rangeEnd: new Date(endMs).toISOString(),
      locations: scope.locationIds.map((id) => ({ id, name: locationNames.get(id) ?? 'Unknown location' })),
      overall: { ...overall, staffDayCount: current.staffDays.length },
      previousPeriod: this.bucket(previous.staffDays),
      byLocation,
      byWeekday,
      quietestWeekday: quietest?.weekday ?? null,
      busiestWeekday: busiest?.weekday ?? null,
      largestGaps: this.largestGaps(current.staffDays, current.staffNames, locationNames),
      warningThresholdPercent: threshold,
      dataQuality,
    };
  }

  /** Owner: business locations (optionally one). Manager: assigned locations. */
  private resolveScope(
    actor: AuthUser,
    requestedLocationId?: string,
  ): { kind: 'owner' | 'manager'; locationIds: string[] } {
    const isOwner = userHasRole(actor, 'owner');
    const isManager = userHasRole(actor, 'manager');
    if (!isOwner && !isManager) {
      throw new ForbiddenException('Utilisation reporting is owner/manager scope');
    }
    const permitted = isOwner
      ? actor.locations.map((location) => location.id)
      : [...actor.allowedLocationIds];
    if (requestedLocationId) {
      if (!permitted.includes(requestedLocationId)) {
        throw new ForbiddenException('Location is outside your utilisation scope');
      }
      return { kind: isOwner ? 'owner' : 'manager', locationIds: [requestedLocationId] };
    }
    return { kind: isOwner ? 'owner' : 'manager', locationIds: permitted };
  }

  /** UTC ranges: [start, end). Week is Monday-anchored, matching the rota. */
  private resolveRange(period: UtilisationPeriod): { startMs: number; endMs: number } {
    const now = new Date();
    const todayStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    if (period === 'today') {
      return { startMs: todayStartMs, endMs: todayStartMs + DAY_MS };
    }
    if (period === 'week') {
      const weekday = new Date(todayStartMs).getUTCDay();
      const sinceMonday = (weekday + 6) % 7;
      const weekStartMs = todayStartMs - sinceMonday * DAY_MS;
      return { startMs: weekStartMs, endMs: weekStartMs + 7 * DAY_MS };
    }
    const monthStartMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const monthEndMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    return { startMs: monthStartMs, endMs: monthEndMs };
  }

  /** Assemble per-staff-day inputs and run the canonical daily computation. */
  private async collectStaffDays(
    businessId: string,
    locationIds: string[],
    startMs: number,
    endMs: number,
  ): Promise<{ staffDays: StaffDay[]; staffNames: Map<string, string>; dataQuality: string[] }> {
    if (locationIds.length === 0) {
      return { staffDays: [], staffNames: new Map(), dataQuality: ['No accessible locations.'] };
    }
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();

    const [shifts, absences, leave, appointments, bookOutTypes] = await Promise.all([
      this.fetchShifts(businessId, locationIds, startIso, endIso),
      this.fetchAbsences(businessId, locationIds, startIso, endIso),
      this.fetchApprovedLeave(businessId, locationIds, startMs, endMs),
      this.fetchAppointments(businessId, locationIds, startIso, endIso),
      this.fetchBookOutBehaviours(businessId),
    ]);
    const breaks = await this.fetchBreaks(businessId, shifts.map((shift) => shift.id));

    const breaksByShift = new Map<string, BreakRow[]>();
    for (const row of breaks) {
      const list = breaksByShift.get(row.shift_id) ?? [];
      list.push(row);
      breaksByShift.set(row.shift_id, list);
    }

    // Group everything per (staff, UTC day, location).
    const staffDays = new Map<string, StaffDay & { shiftIntervals: UtilisationIntervalMs[]; breakIntervals: UtilisationIntervalMs[]; reducing: UtilisationIntervalMs[] }>();
    const keyOf = (staffId: string, dayStartMs: number, locationId: string) =>
      `${staffId}|${dayStartMs}|${locationId}`;
    const ensureDay = (staffId: string, dayStartMs: number, locationId: string) => {
      const key = keyOf(staffId, dayStartMs, locationId);
      let entry = staffDays.get(key);
      if (!entry) {
        entry = {
          staffId,
          locationId,
          dayStartMs,
          shiftIntervals: [],
          breakIntervals: [],
          reducing: [],
          available: [],
          availableMs: 0,
          bookedMs: 0,
          booked: [],
        };
        staffDays.set(key, entry);
      }
      return entry;
    };

    // Shifts + their breaks, split per day (a shift never crosses midnight in
    // practice; clamping keeps any that do correct).
    for (const shift of shifts) {
      const spanStart = Date.parse(shift.scheduled_start_at);
      const spanEnd = Date.parse(shift.scheduled_end_at);
      for (const [dayStartMs, interval] of this.splitByUtcDay(spanStart, spanEnd, startMs, endMs)) {
        const entry = ensureDay(shift.staff_profile_id, dayStartMs, shift.location_id);
        entry.shiftIntervals.push(interval);
        for (const brk of breaksByShift.get(shift.id) ?? []) {
          const clamped = this.clampInterval(Date.parse(brk.started_at), Date.parse(brk.ended_at), dayStartMs, dayStartMs + DAY_MS);
          if (clamped) entry.breakIntervals.push(clamped);
        }
      }
    }

    // Reducing book-outs (per book-out type flag; legacy = reduces).
    for (const absence of absences) {
      const behaviour = resolveBookOutBehaviour(
        absence.book_out_type_id ? bookOutTypes.get(absence.book_out_type_id) : null,
      );
      if (!behaviour.reducesAvailableHours) continue;
      const spanStart = Date.parse(absence.starts_at);
      const spanEnd = absence.ends_at ? Date.parse(absence.ends_at) : endMs;
      for (const [dayStartMs, interval] of this.splitByUtcDay(spanStart, spanEnd, startMs, endMs)) {
        // Only reduces days where the staff member actually has a shift row.
        const key = keyOf(absence.staff_profile_id, dayStartMs, absence.location_id);
        const entry = staffDays.get(key);
        if (entry) entry.reducing.push(interval);
      }
    }

    // Approved leave removes the whole day (web parity: on-leave columns are
    // excluded from utilisation entirely).
    for (const row of leave) {
      const leaveStartMs = Date.parse(`${row.start_date}T00:00:00.000Z`);
      const leaveEndMs = Date.parse(`${row.end_date}T00:00:00.000Z`) + DAY_MS;
      for (const entry of staffDays.values()) {
        if (entry.staffId !== row.staff_profile_id) continue;
        if (entry.dayStartMs >= leaveStartMs && entry.dayStartMs < leaveEndMs) {
          entry.reducing.push({ startMs: entry.dayStartMs, endMs: entry.dayStartMs + DAY_MS });
        }
      }
    }

    // Booked (stylist-occupied) time from the stored occupied_ranges snapshot.
    // Two distinct miss cases get two distinct diagnoses: no rota that day at
    // all vs rostered at a DIFFERENT location than the appointment.
    let bookingsWithoutRota = 0;
    let crossLocationBookings = 0;
    const staffDayAnyLocation = new Set(
      [...staffDays.values()].map((entry) => `${entry.staffId}|${entry.dayStartMs}`),
    );
    for (const appointment of appointments) {
      if (!appointment.assigned_staff_profile_id) continue;
      const occupied = this.occupiedIntervals(appointment);
      for (const interval of occupied) {
        for (const [dayStartMs, clamped] of this.splitByUtcDay(interval.startMs, interval.endMs, startMs, endMs)) {
          const key = keyOf(appointment.assigned_staff_profile_id, dayStartMs, appointment.location_id);
          const entry = staffDays.get(key);
          if (!entry) {
            if (staffDayAnyLocation.has(`${appointment.assigned_staff_profile_id}|${dayStartMs}`)) {
              crossLocationBookings += 1;
            } else {
              bookingsWithoutRota += 1;
            }
            continue;
          }
          entry.booked.push(clamped);
          entry.bookedMs += clamped.endMs - clamped.startMs;
        }
      }
    }

    // Run the canonical computation per staff-day.
    const result: StaffDay[] = [];
    for (const entry of staffDays.values()) {
      const daily = computeDailyUtilisation({
        shifts: entry.shiftIntervals,
        breaks: entry.breakIntervals,
        reducingBlocks: entry.reducing,
        bookedMs: entry.bookedMs,
      });
      const available = subtractIntervalsMs(entry.shiftIntervals, [
        ...entry.breakIntervals,
        ...entry.reducing,
      ]);
      result.push({
        staffId: entry.staffId,
        locationId: entry.locationId,
        dayStartMs: entry.dayStartMs,
        available,
        availableMs: daily.availableMs,
        bookedMs: daily.bookedMs,
        booked: normaliseIntervalsMs(entry.booked),
      });
    }

    const dataQuality: string[] = [];
    if (bookingsWithoutRota > 0) {
      dataQuality.push(
        `${bookingsWithoutRota} booked appointment window${bookingsWithoutRota === 1 ? ' falls' : 's fall'} on days with no rota shift — that time is excluded from utilisation until the rota is filled in.`,
      );
    }
    if (crossLocationBookings > 0) {
      dataQuality.push(
        `${crossLocationBookings} booked appointment window${crossLocationBookings === 1 ? ' is' : 's are'} at a different location than the stylist's rota shift that day — excluded from utilisation (each location's figure measures its own rostered hours).`,
      );
    }

    const staffNames = await this.fetchStaffNames(
      businessId,
      [...new Set(result.map((day) => day.staffId))],
    );
    return { staffDays: result, staffNames, dataQuality };
  }

  private bucket(staffDays: StaffDay[]): UtilisationBucket {
    const availableMs = staffDays.reduce((sum, day) => sum + day.availableMs, 0);
    // Booked time on a zero-available day (e.g. fully on leave) is a data
    // oddity, not capacity used — keep it out of the aggregate numerator so a
    // percentage never exceeds what available hours can explain.
    const bookedMs = staffDays.reduce(
      (sum, day) => sum + (day.availableMs > 0 ? day.bookedMs : 0),
      0,
    );
    return {
      availableMinutes: Math.round(availableMs / 60_000),
      bookedMinutes: Math.round(bookedMs / 60_000),
      utilisationPercent: availableMs > 0 ? Math.round((bookedMs / availableMs) * 100) : null,
    };
  }

  private weekdayBuckets(staffDays: StaffDay[]): Array<UtilisationBucket & { weekday: string }> {
    const byWeekday = new Map<number, StaffDay[]>();
    for (const day of staffDays) {
      const weekday = new Date(day.dayStartMs).getUTCDay();
      const list = byWeekday.get(weekday) ?? [];
      list.push(day);
      byWeekday.set(weekday, list);
    }
    return [...byWeekday.entries()]
      .sort(([a], [b]) => a - b)
      .map(([weekday, days]) => ({ weekday: WEEKDAY_NAMES[weekday], ...this.bucket(days) }));
  }

  /** Largest unbooked-but-available windows: available minus booked, top 3. */
  private largestGaps(
    staffDays: StaffDay[],
    staffNames: Map<string, string>,
    locationNames: Map<string, string>,
  ): UtilisationGap[] {
    const gaps: UtilisationGap[] = [];
    for (const day of staffDays) {
      for (const free of subtractIntervalsMs(day.available, day.booked)) {
        const minutes = Math.round((free.endMs - free.startMs) / 60_000);
        if (minutes < 30) continue;
        const date = new Date(day.dayStartMs);
        gaps.push({
          locationId: day.locationId,
          locationName: locationNames.get(day.locationId) ?? 'Unknown location',
          staffName: staffNames.get(day.staffId) ?? 'Team member',
          date: date.toISOString().slice(0, 10),
          weekday: WEEKDAY_NAMES[date.getUTCDay()],
          startIso: new Date(free.startMs).toISOString(),
          endIso: new Date(free.endMs).toISOString(),
          minutes,
        });
      }
    }
    return gaps.sort((a, b) => b.minutes - a.minutes).slice(0, 3);
  }

  /** Occupied stylist intervals for one appointment, whole-span fallback. */
  private occupiedIntervals(appointment: AppointmentRow): UtilisationIntervalMs[] {
    const parsed = parseMultirange(appointment.occupied_ranges);
    if (parsed.length > 0) {
      return parsed.map((interval) => ({
        startMs: interval.start.getTime(),
        endMs: interval.end.getTime(),
      }));
    }
    // `{}` legitimately means all-free (never occupies); only a NULL column
    // (pre-0050 row that missed the backfill) falls back to the whole span.
    if (appointment.occupied_ranges !== null) return [];
    return [
      {
        startMs: Date.parse(appointment.scheduled_start_at),
        endMs: Date.parse(appointment.scheduled_end_at),
      },
    ];
  }

  private *splitByUtcDay(
    spanStartMs: number,
    spanEndMs: number,
    rangeStartMs: number,
    rangeEndMs: number,
  ): Generator<[number, UtilisationIntervalMs]> {
    const clampedStart = Math.max(spanStartMs, rangeStartMs);
    const clampedEnd = Math.min(spanEndMs, rangeEndMs);
    if (clampedEnd <= clampedStart) return;
    let dayStartMs = Math.floor(clampedStart / DAY_MS) * DAY_MS;
    while (dayStartMs < clampedEnd) {
      const dayEndMs = dayStartMs + DAY_MS;
      const interval = this.clampInterval(clampedStart, clampedEnd, dayStartMs, dayEndMs);
      if (interval) yield [dayStartMs, interval];
      dayStartMs = dayEndMs;
    }
  }

  private clampInterval(
    startMs: number,
    endMs: number,
    windowStartMs: number,
    windowEndMs: number,
  ): UtilisationIntervalMs | null {
    const clampedStart = Math.max(startMs, windowStartMs);
    const clampedEnd = Math.min(endMs, windowEndMs);
    return clampedEnd > clampedStart ? { startMs: clampedStart, endMs: clampedEnd } : null;
  }

  // ---------------------------------------------------------------------------
  // Queries — business-scoped, overlap semantics, service-role per convention.
  // ---------------------------------------------------------------------------

  private async fetchShifts(
    businessId: string,
    locationIds: string[],
    startIso: string,
    endIso: string,
  ): Promise<ShiftRow[]> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('shifts')
      .select('id, location_id, staff_profile_id, status, scheduled_start_at, scheduled_end_at')
      .eq('business_id', businessId)
      .in('location_id', locationIds)
      .neq('status', 'cancelled')
      .lt('scheduled_start_at', endIso)
      .gt('scheduled_end_at', startIso);
    if (error) throw new Error(`utilisation shifts query failed: ${error.message}`);
    return (data ?? []) as ShiftRow[];
  }

  private async fetchBreaks(businessId: string, shiftIds: string[]): Promise<BreakRow[]> {
    if (shiftIds.length === 0) return [];
    const { data, error } = await this.admin
      .schema('rota')
      .from('shift_breaks')
      .select('shift_id, started_at, ended_at')
      .eq('business_id', businessId)
      .in('shift_id', shiftIds);
    if (error) throw new Error(`utilisation breaks query failed: ${error.message}`);
    return (data ?? []) as BreakRow[];
  }

  private async fetchAbsences(
    businessId: string,
    locationIds: string[],
    startIso: string,
    endIso: string,
  ): Promise<AbsenceRow[]> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('absence_events')
      .select('location_id, staff_profile_id, starts_at, ends_at, book_out_type_id')
      .eq('business_id', businessId)
      .in('location_id', locationIds)
      .lt('starts_at', endIso)
      .or(`ends_at.is.null,ends_at.gt.${startIso}`);
    if (error) throw new Error(`utilisation absences query failed: ${error.message}`);
    return (data ?? []) as AbsenceRow[];
  }

  private async fetchApprovedLeave(
    businessId: string,
    locationIds: string[],
    startMs: number,
    endMs: number,
  ): Promise<LeaveRow[]> {
    const startDate = new Date(startMs).toISOString().slice(0, 10);
    const endDate = new Date(endMs - 1).toISOString().slice(0, 10);
    const { data, error } = await this.admin
      .schema('rota')
      .from('leave_requests')
      .select('staff_profile_id, start_date, end_date')
      .eq('business_id', businessId)
      .in('location_id', locationIds)
      .eq('status', 'approved')
      .lte('start_date', endDate)
      .gte('end_date', startDate);
    if (error) throw new Error(`utilisation leave query failed: ${error.message}`);
    return (data ?? []) as LeaveRow[];
  }

  private async fetchAppointments(
    businessId: string,
    locationIds: string[],
    startIso: string,
    endIso: string,
  ): Promise<AppointmentRow[]> {
    const { data, error } = await this.admin
      .schema('booking')
      .from('appointments')
      .select('location_id, assigned_staff_profile_id, status, scheduled_start_at, scheduled_end_at, occupied_ranges')
      .eq('business_id', businessId)
      .in('location_id', locationIds)
      .in('status', [...UTILISATION_BOOKED_STATUSES])
      .lt('scheduled_start_at', endIso)
      .gt('scheduled_end_at', startIso)
      .not('assigned_staff_profile_id', 'is', null);
    if (error) throw new Error(`utilisation appointments query failed: ${error.message}`);
    return (data ?? []) as AppointmentRow[];
  }

  private async fetchBookOutBehaviours(
    businessId: string,
  ): Promise<Map<string, { blocksAppointments: boolean; reducesAvailableHours: boolean; countsAsPaidTime: boolean }>> {
    const { data, error } = await this.admin
      .schema('rota')
      .from('book_out_types')
      .select('id, blocks_appointments, reduces_available_hours, counts_as_paid_time')
      .eq('business_id', businessId);
    if (error) throw new Error(`utilisation book-out types query failed: ${error.message}`);
    return new Map(
      ((data ?? []) as Array<{ id: string; blocks_appointments: boolean; reduces_available_hours: boolean; counts_as_paid_time: boolean }>).map(
        (row) => [
          row.id,
          {
            blocksAppointments: row.blocks_appointments,
            reducesAvailableHours: row.reduces_available_hours,
            countsAsPaidTime: row.counts_as_paid_time,
          },
        ],
      ),
    );
  }

  private async fetchLocationNames(businessId: string, locationIds: string[]): Promise<Map<string, string>> {
    if (locationIds.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('core')
      .from('locations')
      .select('id, name')
      .eq('business_id', businessId)
      .in('id', locationIds);
    if (error) throw new Error(`utilisation locations query failed: ${error.message}`);
    return new Map(((data ?? []) as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]));
  }

  private async fetchStaffNames(businessId: string, staffIds: string[]): Promise<Map<string, string>> {
    if (staffIds.length === 0) return new Map();
    const { data, error } = await this.admin
      .schema('core')
      .from('staff_profiles')
      .select('id, display_name')
      .eq('business_id', businessId)
      .in('id', staffIds);
    if (error) throw new Error(`utilisation staff query failed: ${error.message}`);
    return new Map(
      ((data ?? []) as Array<{ id: string; display_name: string | null }>).map((row) => [
        row.id,
        row.display_name?.trim() || 'Team member',
      ]),
    );
  }

  private async fetchWarningThreshold(businessId: string, locationId: string): Promise<number | null> {
    const { data, error } = await this.admin
      .schema('core')
      .from('location_settings')
      .select('utilisation_warning_threshold_percent')
      .eq('location_id', locationId)
      .maybeSingle<{ utilisation_warning_threshold_percent: number | string | null }>();
    if (error) {
      this.logger.warn(`utilisation threshold read failed (non-fatal): ${error.message}`);
      return null;
    }
    // Tenant safety: `locationId` is only ever a value resolveScope validated
    // against the acting user's own business — location_settings has no
    // business_id column of its own to re-filter on.
    void businessId;
    const raw = data?.utilisation_warning_threshold_percent;
    const value = raw === null || raw === undefined ? null : Number(raw);
    return value !== null && Number.isFinite(value) ? value : null;
  }
}
