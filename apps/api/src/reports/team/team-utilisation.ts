/**
 * R2 Team utilisation assembler. Pure — no I/O, no clock.
 *
 * The formula is the shared one (`computeDailyUtilisation`, packages/domain):
 * available = rostered shift time − (breaks ∪ reducing book-outs ∪ leave), and
 * booked = occupied appointment time, per staff-day. What differs from the
 * KPI/ZAC assembler is only how staff-days are formed:
 * - days are each location's own LOCAL days (DST-safe), inside that location's
 *   Ticket A window — never UTC days;
 * - a staff-day belongs to one location: shifts, book-outs and appointments count
 *   only at their own location (unchanged);
 * - approved leave removes a staff-day only when it was recorded at that same
 *   location. Leave recorded at another location makes the staff-day ambiguous:
 *   its utilisation is not stated (`leave_location_ambiguous`), never guessed.
 *
 * Aggregates keep the shared semantics: minutes add up across staff-days, booked
 * time on a day with no available time is left out, and nothing is capped.
 * docs/V1.1/week-8-r2-team.md §4.
 */
import { computeDailyUtilisation, inclusiveDayCount, resolveBookOutBehaviour, type UtilisationIntervalMs } from '@sheer/domain';
import { parseMultirange } from '../../common/occupied-ranges';
import { addDays, localDateStartUtc } from '../../payroll/period-dates';
import type { AbsenceRow, BookOutTypeRow, BookedAppointmentRow, LeaveRow, ShiftBreakRow, ShiftRow } from './team-source';

export interface UtilisationWindow {
  locationId: string;
  timezone: string;
  /** Inclusive local dates. */
  from: string;
  to: string;
  /** The location's local today: later days have not started and are never counted. */
  localToday: string;
}

export interface UtilisationFacts {
  shifts: readonly ShiftRow[];
  breaks: readonly ShiftBreakRow[];
  absences: readonly AbsenceRow[];
  bookOutTypes: readonly BookOutTypeRow[];
  leave: readonly LeaveRow[];
  appointments: readonly BookedAppointmentRow[];
}

export interface UtilisationSums {
  availableMs: number;
  /** Booked time on staff-days that had available time. */
  bookedMs: number;
  /** A staff-day is covered by leave recorded at another location. */
  ambiguous: boolean;
}

export interface UtilisationResult {
  /** Per location, per staff member with a rostered staff-day there. */
  byLocationStaff: Map<string, Map<string, UtilisationSums>>;
  dataQuality: {
    bookedWithoutRota: number;
    bookedAtAnotherLocation: number;
    leaveAtAnotherLocation: number;
  };
}

interface LocalDay {
  date: string;
  startMs: number;
  endMs: number;
}

interface StaffDay {
  staffId: string;
  locationId: string;
  day: LocalDay;
  shifts: UtilisationIntervalMs[];
  breaks: UtilisationIntervalMs[];
  reducing: UtilisationIntervalMs[];
  bookedMs: number;
  ambiguous: boolean;
}

/** An instant key (microsecond text) as epoch milliseconds. */
export function keyMs(key: string): number {
  return Date.parse(`${key.slice(0, 23)}Z`);
}

function localDays(window: UtilisationWindow): LocalDay[] {
  const days: LocalDay[] = [];
  // Days after the location's today have not started: future rota and bookings are not utilisation.
  const last = window.to < window.localToday ? window.to : window.localToday;
  if (last < window.from) return days;
  const count = inclusiveDayCount(window.from, last);
  for (let index = 0; index < count; index += 1) {
    const date = addDays(window.from, index);
    days.push({
      date,
      startMs: localDateStartUtc(window.timezone, date).getTime(),
      endMs: localDateStartUtc(window.timezone, addDays(date, 1)).getTime(),
    });
  }
  return days;
}

/** The local days an interval overlaps, each with the interval clamped to it. */
function* overlapping(days: readonly LocalDay[], startMs: number, endMs: number): Generator<[LocalDay, UtilisationIntervalMs]> {
  if (endMs <= startMs || days.length === 0) return;
  // First day ending after the interval starts.
  let low = 0;
  let high = days.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (days[middle].endMs <= startMs) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < days.length && days[index].startMs < endMs; index += 1) {
    const day = days[index];
    const clampedStart = Math.max(startMs, day.startMs);
    const clampedEnd = Math.min(endMs, day.endMs);
    if (clampedEnd > clampedStart) yield [day, { startMs: clampedStart, endMs: clampedEnd }];
  }
}

export function assembleUtilisation(windows: readonly UtilisationWindow[], facts: UtilisationFacts): UtilisationResult {
  const daysByLocation = new Map(
    windows.map((window) => [window.locationId, localDays(window)] as const).filter(([, days]) => days.length > 0),
  );
  const staffDays = new Map<string, StaffDay>();
  const keyOf = (locationId: string, staffId: string, date: string) => `${locationId}|${staffId}|${date}`;

  const breaksByShift = new Map<string, ShiftBreakRow[]>();
  for (const row of facts.breaks) {
    const list = breaksByShift.get(row.shiftId);
    if (list) list.push(row);
    else breaksByShift.set(row.shiftId, [row]);
  }

  // Shifts and their breaks, split into the shift location's local days.
  for (const shift of facts.shifts) {
    const days = daysByLocation.get(shift.locationId);
    if (!days) continue;
    for (const [day, interval] of overlapping(days, keyMs(shift.startAt), keyMs(shift.endAt))) {
      const key = keyOf(shift.locationId, shift.staffProfileId, day.date);
      let entry = staffDays.get(key);
      if (!entry) {
        entry = { staffId: shift.staffProfileId, locationId: shift.locationId, day, shifts: [], breaks: [], reducing: [], bookedMs: 0, ambiguous: false };
        staffDays.set(key, entry);
      }
      entry.shifts.push(interval);
      for (const brk of breaksByShift.get(shift.id) ?? []) {
        const clampedStart = Math.max(keyMs(brk.startAt), day.startMs);
        const clampedEnd = Math.min(keyMs(brk.endAt), day.endMs);
        if (clampedEnd > clampedStart) entry.breaks.push({ startMs: clampedStart, endMs: clampedEnd });
      }
    }
  }

  // Reducing book-outs, only on days with a shift at the book-out's own location.
  const bookOutTypes = new Map(facts.bookOutTypes.map((type) => [type.id, type]));
  for (const absence of facts.absences) {
    const type = absence.bookOutTypeId === null ? null : bookOutTypes.get(absence.bookOutTypeId);
    const reduces = type ? type.reducesAvailableHours : resolveBookOutBehaviour(null).reducesAvailableHours;
    if (!reduces) continue;
    const days = daysByLocation.get(absence.locationId);
    if (!days) continue;
    const endMs = absence.endAt === null ? days[days.length - 1].endMs : keyMs(absence.endAt);
    for (const [day, interval] of overlapping(days, keyMs(absence.startAt), endMs)) {
      staffDays.get(keyOf(absence.locationId, absence.staffProfileId, day.date))?.reducing.push(interval);
    }
  }

  // Approved leave: same location removes the whole local day; another location only marks the day ambiguous.
  const leaveByStaff = new Map<string, LeaveRow[]>();
  for (const row of facts.leave) {
    const list = leaveByStaff.get(row.staffProfileId);
    if (list) list.push(row);
    else leaveByStaff.set(row.staffProfileId, [row]);
  }
  let leaveAtAnotherLocation = 0;
  for (const entry of staffDays.values()) {
    const covering = (leaveByStaff.get(entry.staffId) ?? []).filter((row) => row.startDate <= entry.day.date && entry.day.date <= row.endDate);
    if (covering.length === 0) continue;
    if (covering.some((row) => row.locationId === entry.locationId)) {
      entry.reducing.push({ startMs: entry.day.startMs, endMs: entry.day.endMs });
    } else {
      entry.ambiguous = true;
      leaveAtAnotherLocation += 1;
    }
  }

  // Booked (occupied) time, per day slice, only against a staff-day at the appointment's own location.
  const staffDates = new Set([...staffDays.values()].map((entry) => `${entry.staffId}|${entry.day.date}`));
  let bookedWithoutRota = 0;
  let bookedAtAnotherLocation = 0;
  for (const appointment of facts.appointments) {
    const days = daysByLocation.get(appointment.locationId);
    if (!days) continue;
    for (const interval of occupiedIntervals(appointment)) {
      for (const [day, clamped] of overlapping(days, interval.startMs, interval.endMs)) {
        const entry = staffDays.get(keyOf(appointment.locationId, appointment.staffProfileId, day.date));
        if (entry) entry.bookedMs += clamped.endMs - clamped.startMs;
        else if (staffDates.has(`${appointment.staffProfileId}|${day.date}`)) bookedAtAnotherLocation += 1;
        else bookedWithoutRota += 1;
      }
    }
  }

  const byLocationStaff = new Map<string, Map<string, UtilisationSums>>();
  for (const entry of staffDays.values()) {
    const daily = computeDailyUtilisation({ shifts: entry.shifts, breaks: entry.breaks, reducingBlocks: entry.reducing, bookedMs: entry.bookedMs });
    const byStaff = byLocationStaff.get(entry.locationId) ?? new Map<string, UtilisationSums>();
    const sums = byStaff.get(entry.staffId) ?? { availableMs: 0, bookedMs: 0, ambiguous: false };
    sums.availableMs += daily.availableMs;
    sums.bookedMs += daily.availableMs > 0 ? daily.bookedMs : 0;
    sums.ambiguous = sums.ambiguous || entry.ambiguous;
    byStaff.set(entry.staffId, sums);
    byLocationStaff.set(entry.locationId, byStaff);
  }
  return { byLocationStaff, dataQuality: { bookedWithoutRota, bookedAtAnotherLocation, leaveAtAnotherLocation } };
}

/** Occupied stylist intervals: the stored ranges, or the whole span only when the column is NULL. */
function occupiedIntervals(appointment: BookedAppointmentRow): UtilisationIntervalMs[] {
  if (appointment.occupiedRanges === null) return [{ startMs: keyMs(appointment.startAt), endMs: keyMs(appointment.endAt) }];
  return parseMultirange(appointment.occupiedRanges).map((interval) => ({ startMs: interval.start.getTime(), endMs: interval.end.getTime() }));
}

/** Sum utilisation over a set of staff (any location map). */
export function sumUtilisation(cells: Iterable<UtilisationSums>): UtilisationSums {
  const total = { availableMs: 0, bookedMs: 0, ambiguous: false };
  for (const cell of cells) {
    total.availableMs += cell.availableMs;
    total.bookedMs += cell.bookedMs;
    total.ambiguous = total.ambiguous || cell.ambiguous;
  }
  return total;
}
