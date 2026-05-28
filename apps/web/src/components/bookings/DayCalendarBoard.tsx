import type { SVGProps } from 'react';
import type {
  RotaAbsenceIndicator,
  RotaLeaveIndicator,
  RotaShift,
  RotaStaffSummary,
  StaffBookingSummary,
} from '@sheer/domain';
import { formatTime, isSameLocalDay, toIsoDate } from '../rota/dateUtils';

function CalendarEmptyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden {...props}>
      <rect x="3" y="4" width="14" height="13" rx="2" />
      <path d="M3 8h14M7 2v4M13 2v4" strokeLinecap="round" />
    </svg>
  );
}

const HOUR_PX = 64;
const MIN_BLOCK_PX = 28;
const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 18;
const COLUMN_WIDTH = 200;
const HEADER_HEIGHT = 'h-14';

type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

interface ColumnModel {
  key: string;
  name: string;
  subtitle: string;
  colorHex?: string;
  shifts: RotaShift[];
  absences: RotaAbsenceIndicator[];
  onLeave: boolean;
  bookings: StaffBookingSummary[];
}

interface DayCalendarBoardProps {
  day: Date;
  staff: RotaStaffSummary[];
  shifts: RotaShift[];
  leave: RotaLeaveIndicator[];
  absences: RotaAbsenceIndicator[];
  /** Appointments already scoped to this day + location. */
  bookings: StaffBookingSummary[];
  selectedBookingId?: string | null;
  onSelectBooking: (booking: StaffBookingSummary) => void;
}

/**
 * Manager/owner-facing day calendar board.
 *
 * Layout: a fixed time axis on the left and one column per rostered
 * stylist. Each column paints the stylist's rota context (working
 * hours, breaks, approved leave, absences) as the background and lays
 * real appointments over it, positioned by start/end time with simple
 * overlap lanes. Blocks are click-to-act (the page wires the existing
 * complete / checkout / rebooking flow).
 *
 * All values are derived from live rota + booking data — nothing here
 * is mocked. Times mirror the rest of the product: timezone-naive on
 * the client, matching the API's UTC week range.
 */
export function DayCalendarBoard({
  day,
  staff,
  shifts,
  leave,
  absences,
  bookings,
  selectedBookingId,
  onSelectBooking,
}: DayCalendarBoardProps) {
  const dayIso = toIsoDate(day);
  const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const dayEnd = new Date(dayStart.getTime() + 86_400_000);

  const shiftsForDay = shifts.filter(
    (shift) => shift.status !== 'cancelled' && isSameLocalDay(shift.scheduledStartAt, day),
  );
  const absencesForDay = absences.filter((absence) => intersectsDay(absence.startsAt, absence.endsAt, dayStart, dayEnd));
  const leaveStaffOnDay = new Set(
    leave
      .filter((entry) => entry.status === 'approved' && entry.startDate <= dayIso && entry.endDate >= dayIso)
      .map((entry) => entry.staffProfileId),
  );

  const columns = buildColumns({
    staff,
    bookings,
    shiftsForDay,
    absencesForDay,
    leaveStaffOnDay,
  });

  const { startHour, endHour } = resolveWindow(columns, day);
  const hours = range(startHour, endHour);
  const totalHeight = (endHour - startHour) * HOUR_PX;

  if (columns.length === 0) {
    return (
      <div className="rounded-2xl border border-border bg-surface px-4 py-16 text-center">
        <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-alt text-text-muted">
          <CalendarEmptyIcon className="h-5 w-5" />
        </div>
        <div className="text-[14px] font-semibold text-text-primary">Nothing on the book for this day</div>
        <div className="mt-1 text-[13px] text-text-secondary">
          No stylists are rostered and there are no appointments at this location on {formatDayLabel(day)}.
        </div>
      </div>
    );
  }

  const minBoardWidth = columns.length * COLUMN_WIDTH + 64;

  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface shadow-sm">
      <div className="flex" style={{ minWidth: minBoardWidth }}>
        {/* Time axis */}
        <div className="sticky left-0 z-30 w-16 shrink-0 border-r border-border/60 bg-surface">
          <div className={`${HEADER_HEIGHT} border-b border-border/60`} />
          <div className="relative">
            {hours.map((hour) => (
              <div
                key={hour}
                style={{ height: HOUR_PX }}
                className="border-t border-border/40 pr-2 pt-1.5 text-right text-[10px] font-medium text-text-muted"
              >
                {hourLabel(hour)}
              </div>
            ))}
          </div>
        </div>

        {/* Stylist columns */}
        {columns.map((column) => (
          <div key={column.key} className="min-w-0 flex-1 border-r border-border/60 last:border-r-0">
            <div className={`${HEADER_HEIGHT} flex items-center gap-2.5 border-b border-border/60 bg-surface-alt/60 px-3`}>
              <span
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white shadow-sm ${
                  column.colorHex ? '' : 'bg-primary'
                }`}
                style={column.colorHex ? { backgroundColor: column.colorHex } : undefined}
                aria-hidden
              >
                {initials(column.name)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-[13px] font-semibold text-text-primary">{column.name}</div>
                <div className="truncate text-[11px] text-text-muted">{column.subtitle}</div>
              </div>
            </div>

            <div className="relative" style={{ height: totalHeight }}>
              {/* Hour gridlines */}
              {hours.map((hour, idx) => (
                <div
                  key={hour}
                  style={{ height: HOUR_PX }}
                  className={idx === 0 ? '' : 'border-t border-border/30'}
                />
              ))}

              {/* Half-hour sub-gridlines */}
              {hours.map((hour) => (
                <div
                  key={`half-${hour}`}
                  style={{ top: (hour - startHour) * HOUR_PX + HOUR_PX / 2, height: 0 }}
                  className="absolute inset-x-0 border-t border-dashed border-border/20"
                  aria-hidden
                />
              ))}

              {/* Working-hours shading. */}
              {column.shifts.map((shift) => {
                const top = offsetPx(shift.scheduledStartAt, startHour, totalHeight);
                const bottom = offsetPx(shift.scheduledEndAt, startHour, totalHeight);
                return (
                  <div
                    key={`shift-${shift.id}`}
                    className="absolute inset-x-0 bg-primary/[0.04]"
                    style={{ top, height: Math.max(0, bottom - top) }}
                    aria-hidden
                  />
                );
              })}

              {/* Breaks (lunch). */}
              {column.shifts.flatMap((shift) =>
                shift.breaks.map((brk) => {
                  const top = offsetPx(brk.startedAt, startHour, totalHeight);
                  const bottom = offsetPx(brk.endedAt, startHour, totalHeight);
                  return (
                    <div
                      key={`break-${brk.id}`}
                      className="absolute inset-x-2 flex items-center justify-center rounded-lg bg-border/30 text-[10px] font-medium uppercase tracking-[0.07em] text-text-muted"
                      style={{ top, height: Math.max(MIN_BLOCK_PX, bottom - top) }}
                      title={brk.isPaid ? 'Paid break' : 'Break'}
                    >
                      Break
                    </div>
                  );
                }),
              )}

              {/* Approved leave → day off. */}
              {column.onLeave ? (
                <div className="absolute inset-0 flex items-center justify-center bg-success-soft/70" aria-hidden>
                  <span className="rounded-full bg-success-soft px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.07em] text-success">
                    Day off
                  </span>
                </div>
              ) : null}

              {/* Absences. */}
              {column.absences.map((absence) => {
                const top = offsetPx(absence.startsAt, startHour, totalHeight);
                const bottom = absence.endsAt ? offsetPx(absence.endsAt, startHour, totalHeight) : totalHeight;
                return (
                  <div
                    key={`absence-${absence.id}`}
                    className="absolute inset-x-1.5 flex items-center justify-center rounded-lg bg-danger-soft text-[11px] font-semibold text-danger"
                    style={{ top, height: Math.max(MIN_BLOCK_PX, bottom - top) }}
                  >
                    {absenceLabel(absence.absenceType)}
                  </div>
                );
              })}

              {/* Appointment blocks. */}
              {layoutBlocks(column.bookings, startHour, totalHeight).map(({ booking, top, height, lane, laneCount }) => {
                const tone = statusTone(booking.status);
                const accent = statusAccent(tone);
                const muted = booking.status === 'cancelled' || booking.status === 'no_show';
                const selected = selectedBookingId === booking.id;
                const widthPct = 100 / laneCount;
                return (
                  <button
                    key={booking.id}
                    type="button"
                    onClick={() => onSelectBooking(booking)}
                    style={{
                      top,
                      height,
                      left: `calc(${lane * widthPct}% + 3px)`,
                      width: `calc(${widthPct}% - 6px)`,
                    }}
                    className={`absolute overflow-hidden rounded-lg border text-left transition-all ${
                      selected
                        ? `z-20 border-primary bg-primary/5 shadow-md ring-2 ring-primary/30`
                        : `z-10 border-border/70 bg-surface shadow-sm hover:border-border hover:shadow-md`
                    } ${muted ? 'opacity-60' : ''}`}
                  >
                    <span className={`absolute inset-y-0 left-0 w-[3px] rounded-l-lg ${accent.bar}`} aria-hidden />
                    <span className="block py-1.5 pl-3 pr-1.5">
                      <span className="block truncate text-[11px] font-semibold text-text-primary">
                        {formatTime(booking.startsAt)} · {booking.clientDisplayName}
                      </span>
                      <span className="block truncate text-[10px] text-text-muted">
                        {booking.serviceNames.join(', ') || 'Service'}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface PositionedBlock {
  booking: StaffBookingSummary;
  top: number;
  height: number;
  lane: number;
  laneCount: number;
}

function layoutBlocks(bookings: StaffBookingSummary[], startHour: number, totalHeight: number): PositionedBlock[] {
  const total = (totalHeight / HOUR_PX) * 60;
  const items = bookings
    .map((booking) => {
      const startMin = clamp(minutesFromWindowStart(booking.startsAt, startHour), 0, total);
      let endMin = minutesFromWindowStart(booking.endsAt, startHour);
      if (endMin <= startMin) endMin = startMin + (booking.durationMinutes ?? 30);
      endMin = clamp(endMin, startMin, total);
      return { booking, startMin, endMin };
    })
    .sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);

  const laneEnds: number[] = [];
  const withLanes = items.map((item) => {
    let lane = laneEnds.findIndex((end) => end <= item.startMin);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.endMin);
    } else {
      laneEnds[lane] = item.endMin;
    }
    return { ...item, lane };
  });
  const laneCount = Math.max(1, laneEnds.length);

  return withLanes.map((item) => ({
    booking: item.booking,
    top: (item.startMin / 60) * HOUR_PX,
    height: Math.max(MIN_BLOCK_PX, ((item.endMin - item.startMin) / 60) * HOUR_PX),
    lane: item.lane,
    laneCount,
  }));
}

function buildColumns(input: {
  staff: RotaStaffSummary[];
  bookings: StaffBookingSummary[];
  shiftsForDay: RotaShift[];
  absencesForDay: RotaAbsenceIndicator[];
  leaveStaffOnDay: Set<string>;
}): ColumnModel[] {
  const { staff, bookings, shiftsForDay, absencesForDay, leaveStaffOnDay } = input;
  const bookingsByStaff = new Map<string, StaffBookingSummary[]>();
  const unassigned: StaffBookingSummary[] = [];
  for (const booking of bookings) {
    if (booking.assignedStaffProfileId) {
      const list = bookingsByStaff.get(booking.assignedStaffProfileId) ?? [];
      list.push(booking);
      bookingsByStaff.set(booking.assignedStaffProfileId, list);
    } else {
      unassigned.push(booking);
    }
  }

  const columns: ColumnModel[] = staff.map((member) => ({
    key: member.staffProfileId,
    name: member.displayName || member.fullName || 'Stylist',
    subtitle: subtitleForStaff(member, leaveStaffOnDay.has(member.staffProfileId), shiftsForDay),
    colorHex: member.colorHex,
    shifts: shiftsForDay.filter((shift) => shift.staffProfileId === member.staffProfileId),
    absences: absencesForDay.filter((absence) => absence.staffProfileId === member.staffProfileId),
    onLeave: leaveStaffOnDay.has(member.staffProfileId),
    bookings: bookingsByStaff.get(member.staffProfileId) ?? [],
  }));

  // Surface any appointments assigned to stylists who are not in this
  // location's roster so nothing is silently hidden.
  const rosterIds = new Set(staff.map((member) => member.staffProfileId));
  for (const [staffProfileId, list] of bookingsByStaff) {
    if (rosterIds.has(staffProfileId)) continue;
    columns.push({
      key: staffProfileId,
      name: 'Other stylist',
      subtitle: 'Not on this location’s rota',
      shifts: [],
      absences: [],
      onLeave: false,
      bookings: list,
    });
  }

  if (unassigned.length > 0) {
    columns.push({
      key: 'unassigned',
      name: 'Unassigned',
      subtitle: 'No stylist assigned',
      shifts: [],
      absences: [],
      onLeave: false,
      bookings: unassigned,
    });
  }

  return columns;
}

function subtitleForStaff(member: RotaStaffSummary, onLeave: boolean, shiftsForDay: RotaShift[]): string {
  if (onLeave) return 'On leave';
  const memberShifts = shiftsForDay.filter((shift) => shift.staffProfileId === member.staffProfileId);
  if (memberShifts.length === 0) return 'Not scheduled';
  const start = memberShifts.reduce((min, shift) => (shift.scheduledStartAt < min ? shift.scheduledStartAt : min), memberShifts[0].scheduledStartAt);
  const end = memberShifts.reduce((max, shift) => (shift.scheduledEndAt > max ? shift.scheduledEndAt : max), memberShifts[0].scheduledEndAt);
  return `${formatTime(start)} – ${formatTime(end)}`;
}

function resolveWindow(columns: ColumnModel[], day: Date): { startHour: number; endHour: number } {
  let minHour = DEFAULT_START_HOUR;
  let maxHour = DEFAULT_END_HOUR;
  const consider = (iso: string) => {
    if (!isSameLocalDay(iso, day)) return;
    const d = new Date(iso);
    minHour = Math.min(minHour, d.getHours());
    maxHour = Math.max(maxHour, d.getHours() + (d.getMinutes() > 0 ? 1 : 0));
  };
  for (const column of columns) {
    for (const shift of column.shifts) {
      consider(shift.scheduledStartAt);
      consider(shift.scheduledEndAt);
    }
    for (const booking of column.bookings) {
      consider(booking.startsAt);
      consider(booking.endsAt);
    }
  }
  const startHour = clamp(Math.min(minHour, DEFAULT_START_HOUR), 0, 23);
  const endHour = clamp(Math.max(maxHour, DEFAULT_END_HOUR, startHour + 1), startHour + 1, 24);
  return { startHour, endHour };
}

function minutesFromWindowStart(iso: string, startHour: number): number {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes() - startHour * 60;
}

function offsetPx(iso: string, startHour: number, totalHeight: number): number {
  const minutes = minutesFromWindowStart(iso, startHour);
  return clamp((minutes / 60) * HOUR_PX, 0, totalHeight);
}

function intersectsDay(startsAt: string, endsAt: string | undefined, dayStart: Date, dayEnd: Date): boolean {
  const start = new Date(startsAt).getTime();
  const end = endsAt ? new Date(endsAt).getTime() : Number.POSITIVE_INFINITY;
  return start < dayEnd.getTime() && end > dayStart.getTime();
}

function statusTone(status: StaffBookingSummary['status']): StatusTone {
  switch (status) {
    case 'confirmed':
    case 'checked_in':
    case 'in_progress':
    case 'in_service':
      return 'success';
    case 'pending':
    case 'draft':
    case 'booked':
      return 'warning';
    case 'cancelled':
    case 'no_show':
      return 'danger';
    default:
      return 'neutral';
  }
}

function statusAccent(tone: StatusTone): { bar: string } {
  switch (tone) {
    case 'success':
      return { bar: 'bg-success-fill' };
    case 'warning':
      return { bar: 'bg-warning-fill' };
    case 'danger':
      return { bar: 'bg-danger-fill' };
    default:
      return { bar: 'bg-border-strong' };
  }
}

function absenceLabel(type: RotaAbsenceIndicator['absenceType']): string {
  if (type === 'sickness') return 'Sick';
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function hourLabel(hour: number): string {
  const date = new Date();
  date.setHours(hour, 0, 0, 0);
  return date.toLocaleTimeString(undefined, { hour: 'numeric' });
}

function formatDayLabel(day: Date): string {
  return day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '–';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function range(startInclusive: number, endExclusive: number): number[] {
  return Array.from({ length: Math.max(0, endExclusive - startInclusive) }, (_, idx) => startInclusive + idx);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
