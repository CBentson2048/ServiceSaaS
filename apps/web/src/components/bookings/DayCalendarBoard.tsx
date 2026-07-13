import { Fragment, useEffect, useRef, useState, type SVGProps } from 'react';
import type {
  BookOutType,
  RotaAbsenceIndicator,
  RotaLeaveIndicator,
  RotaShift,
  RotaStaffSummary,
  StaffBookingSummary,
} from '@sheer/domain';
import { computeDailyUtilisation } from '@sheer/domain';
import { formatTime, isSameLocalDay, toIsoDate } from '../rota/dateUtils';

function CalendarEmptyIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden {...props}>
      <rect x="3" y="4" width="14" height="13" rx="2" />
      <path d="M3 8h14M7 2v4M13 2v4" strokeLinecap="round" />
    </svg>
  );
}

// Vertical zoom: taller hour rows make appointment blocks easier to read and
// let the board fill the (now much wider) right-hand content area.
const HOUR_PX = 60;
// Each hour is ruled into four 15-minute rows to match the 15-minute booking
// grid. QUARTER_PX is the pixel height of one 15-minute slot.
const QUARTER_PX = HOUR_PX / 4;
const MIN_BLOCK_PX = 30;
const DEFAULT_START_HOUR = 9;
const DEFAULT_END_HOUR = 18;
const COLUMN_WIDTH = 220;
const HEADER_HEIGHT = 'h-12';
const HEADER_HEIGHT_PX = 48; // keep in sync with HEADER_HEIGHT (h-12)

type StatusTone = 'success' | 'warning' | 'danger' | 'neutral';

interface ColumnModel {
  key: string;
  /** Staff profile this column books into. Undefined for the Unassigned column. */
  staffProfileId?: string;
  name: string;
  subtitle: string;
  colorHex?: string;
  shifts: RotaShift[];
  absences: RotaAbsenceIndicator[];
  onLeave: boolean;
  bookings: StaffBookingSummary[];
  /** booked ÷ available for the day (null when the stylist has no available time). */
  utilisationPercent: number | null;
}

const SLOT_SNAP_MINUTES = 15;

export interface AddAppointmentInput {
  staffProfileId: string;
  staffName: string;
  /** ISO timestamp of the clicked slot start (snapped to 15 minutes). */
  startAt: string;
}

export interface AddBookoutInput extends AddAppointmentInput {
  endsAt: string;
  notes?: string;
  /** Chosen configurable book-out type (drives availability + utilisation). */
  bookOutTypeId?: string;
}

interface SlotMenuState {
  staffProfileId: string;
  staffName: string;
  startAt: string;
  /** Click position relative to the board's positioned container. */
  x: number;
  y: number;
  boardWidth: number;
}

interface DayCalendarBoardProps {
  day: Date;
  staff: RotaStaffSummary[];
  shifts: RotaShift[];
  leave: RotaLeaveIndicator[];
  absences: RotaAbsenceIndicator[];
  /** Appointments already scoped to this day + location. */
  bookings: StaffBookingSummary[];
  /**
   * Configurable book-out types for this business. Powers the book-out reason
   * picker and lets the utilisation badge respect each type's flags.
   */
  bookOutTypes?: BookOutType[];
  /**
   * serviceId → category colour (#RRGGBB). A tile is tinted by the first of its
   * services that resolves a colour; the thin left bar keeps showing status.
   */
  serviceColors?: Map<string, string>;
  /**
   * Lower-cased service name → category colour. Fallback for when an
   * appointment's service rows carry only a name snapshot (no `service_id`), so
   * the id map can't resolve — the tile still tints by the catalogue colour.
   */
  serviceColorsByName?: Map<string, string>;
  selectedBookingId?: string | null;
  onSelectBooking: (booking: StaffBookingSummary) => void;
  /**
   * Double-tap / double-click a tile to open the client's profile. When
   * provided, a single tap is briefly deferred so it can be distinguished from
   * a double tap (single → action menu, double → profile).
   */
  onViewClientProfile?: (booking: StaffBookingSummary) => void;
  /** Tile action menu: mark the client arrived (confirmed → checked in). */
  onCheckIn?: (booking: StaffBookingSummary) => void;
  /** Tile action menu: open the checkout / payment screen (complete the service). */
  onCheckOut?: (booking: StaffBookingSummary) => void;
  /** Tile action menu: open the reschedule / reassign editor. */
  onEditBooking?: (booking: StaffBookingSummary) => void;
  /** Tile action menu: cancel the appointment. */
  onCancelBooking?: (booking: StaffBookingSummary) => void;
  /** When false, stylists with no appointments on this day are hidden. */
  showAllTeamMembers?: boolean;
  /** When true, a red "now" line is drawn at the current time (today only). */
  showTimeline?: boolean;
  /** Clicking an empty slot in a stylist column → "Add appointment" (deep-links into booking). */
  onAddAppointment?: (input: AddAppointmentInput) => void;
  /** Clicking an empty slot → "Add bookout" (blocks the stylist's time). */
  onAddBookout?: (input: AddBookoutInput) => void;
  /**
   * Drag an appointment tile to a new time and/or another stylist column. Fired on
   * drop with a 15-minute-snapped start; `staffProfileId` is set only when the drop
   * lands on a different stylist. Enables drag-to-move / drag-to-reassign.
   */
  onMoveBooking?: (booking: StaffBookingSummary, input: MoveBookingInput) => void;
  /**
   * Drag the bottom edge of a tile to lengthen/shorten it. Fired on drop with the
   * new total duration in minutes (15-minute-snapped). Enables drag-to-resize.
   */
  onResizeBooking?: (booking: StaffBookingSummary, input: ResizeBookingInput) => void;
  /**
   * Called when a drop is refused because it would fall outside the target stylist's
   * rostered working hours (they're not scheduled then, or the appointment can't fit).
   */
  onDragBlocked?: (staffName: string) => void;
}

export interface MoveBookingInput {
  /** ISO start of the drop position (snapped to 15 minutes). */
  startAt: string;
  /** Target stylist when the tile is dropped on a different column; omit to keep. */
  staffProfileId?: string;
  staffName?: string;
}

export interface ResizeBookingInput {
  /**
   * New total appointment duration in minutes. The tile's END is snapped to the
   * 15-minute grid while the (possibly off-grid) start is preserved, so the
   * duration is a multiple of 15 only when the start already sits on the grid.
   */
  durationMinutes: number;
}

interface BookingMenuState {
  booking: StaffBookingSummary;
  /** Click position relative to the board's positioned container. */
  x: number;
  y: number;
  boardWidth: number;
  boardHeight: number;
}

// Live state while an appointment tile is being dragged. All time values are in
// minutes from the visible window start; the preview reads from here each frame.
interface DragState {
  booking: StaffBookingSummary;
  mode: 'move' | 'resize';
  /** Minutes between the booking start and where inside the tile it was grabbed. */
  grabOffsetMin: number;
  originStartMin: number;
  originDurationMin: number;
  /** Start (minutes from window) of the last stylist-occupied slice — the resize
   *  handle grabs this slice, so a resize can't shrink the total below it. */
  lastRunStartMin: number;
  previewStartMin: number;
  previewDurationMin: number;
  /** Column the pointer is currently over (drop target). */
  targetColKey: string;
  targetStaffProfileId?: string;
  targetStaffName: string;
  originStaffProfileId?: string;
  /** Working intervals (minutes from window) of the ORIGIN stylist — resize clamps
   *  the end to the shift that contains the start. */
  originWorking: MinuteInterval[];
  /** False when the current preview can't sit inside the target stylist's working
   *  hours (drop is blocked). Move clamps to stay valid where it can. */
  valid: boolean;
  /** True once the pointer has moved past the click/drag threshold. */
  moved: boolean;
}

const DRAG_THRESHOLD_PX = 4;

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
  bookOutTypes,
  serviceColors,
  serviceColorsByName,
  selectedBookingId,
  onSelectBooking,
  onViewClientProfile,
  onCheckIn,
  onCheckOut,
  onEditBooking,
  onCancelBooking,
  showAllTeamMembers = true,
  showTimeline = true,
  onAddAppointment,
  onAddBookout,
  onMoveBooking,
  onResizeBooking,
  onDragBlocked,
}: DayCalendarBoardProps) {
  // A live clock so the "now" line tracks the current time. Updates once a
  // minute — fine for a calendar ruled in 15-minute gridlines.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  // Click-to-create: clicking an empty slot in a stylist column opens a small
  // menu (Add appointment / Add bookout), the primary way to add appointments.
  const boardRef = useRef<HTMLDivElement>(null);
  const [slotMenu, setSlotMenu] = useState<SlotMenuState | null>(null);
  // Click an appointment block → an action menu (Check in / Check out / Edit /
  // Cancel) opens right at the tile, so no scrolling is needed to act on it.
  const [bookingMenu, setBookingMenu] = useState<BookingMenuState | null>(null);
  const createEnabled = Boolean(onAddAppointment || onAddBookout);
  const bookingActionsEnabled = Boolean(onCheckIn || onCheckOut || onEditBooking || onCancelBooking);
  const dragEnabled = Boolean(onMoveBooking || onResizeBooking);

  // Live drag state (null when idle). A ref mirrors it so the window pointer
  // listeners always read the latest without being re-bound each frame.
  const [drag, setDrag] = useState<DragState | null>(null);
  const dragRef = useRef<DragState | null>(null);
  // Set right after a drag so the synthetic click that follows pointerup does not
  // also open the tile's action menu.
  const suppressClickRef = useRef(false);
  // Double-tap detection for opening the client profile. `lastTapRef` records the
  // last tile tap; `tapTimerRef` holds the pending single-tap (action menu) timer
  // so a follow-up tap can cancel it and open the profile instead.
  const lastTapRef = useRef<{ id: string; time: number } | null>(null);
  const tapTimerRef = useRef<number | null>(null);

  // Route a tile tap to either the action menu (single) or the client profile
  // (double). Only defers the single tap when a profile handler is wired, so the
  // existing single-tap behaviour is unchanged when the feature isn't enabled.
  function handleBookingTap(clientX: number, clientY: number, booking: StaffBookingSummary) {
    if (!onViewClientProfile) {
      openBookingMenuAt(clientX, clientY, booking);
      return;
    }

    const now = Date.now();
    const last = lastTapRef.current;
    const isDoubleTap = last && last.id === booking.id && now - last.time < 300;

    if (isDoubleTap) {
      if (tapTimerRef.current !== null) {
        window.clearTimeout(tapTimerRef.current);
        tapTimerRef.current = null;
      }
      lastTapRef.current = null;
      onViewClientProfile(booking);
      return;
    }

    lastTapRef.current = { id: booking.id, time: now };
    if (tapTimerRef.current !== null) window.clearTimeout(tapTimerRef.current);
    tapTimerRef.current = window.setTimeout(() => {
      tapTimerRef.current = null;
      lastTapRef.current = null;
      openBookingMenuAt(clientX, clientY, booking);
    }, 260);
  }

  useEffect(() => {
    return () => {
      if (tapTimerRef.current !== null) window.clearTimeout(tapTimerRef.current);
    };
  }, []);

  function openBookingMenuAt(clientX: number, clientY: number, booking: StaffBookingSummary) {
    onSelectBooking(booking);
    const board = boardRef.current;
    if (!board || !bookingActionsEnabled) return;
    const boardRect = board.getBoundingClientRect();
    setSlotMenu(null);
    setBookingMenu({
      booking,
      x: clientX - boardRect.left,
      y: clientY - boardRect.top,
      boardWidth: boardRect.width,
      boardHeight: boardRect.height,
    });
  }

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

  const allColumns = buildColumns({
    staff,
    bookings,
    shiftsForDay,
    absencesForDay,
    leaveStaffOnDay,
    day,
  });

  // "Show all team members" off → drop columns with nothing booked. The
  // Unassigned / off-roster columns always carry bookings, so they survive.
  const columns = showAllTeamMembers
    ? allColumns
    : allColumns.filter((column) => column.bookings.length > 0);

  const { startHour, endHour } = resolveWindow(columns, day);
  const hours = range(startHour, endHour);
  const totalHeight = (endHour - startHour) * HOUR_PX;
  // Internal 15-minute gridline positions. Index 0 (top edge) and the final
  // tick (bottom edge) are skipped — the header/board borders cover those.
  const quarterTicks = range(1, (endHour - startHour) * 4);

  function openSlotMenu(event: React.MouseEvent<HTMLDivElement>, column: ColumnModel) {
    // A drag just ended over this column — swallow the trailing click.
    if (suppressClickRef.current) return;
    if (!createEnabled || !column.staffProfileId) return;
    const board = boardRef.current;
    if (!board) return;
    const gridRect = event.currentTarget.getBoundingClientRect();
    const boardRect = board.getBoundingClientRect();
    const minutesFromStart = ((event.clientY - gridRect.top) / HOUR_PX) * 60;
    const absoluteMinutes = Math.max(
      0,
      Math.round((startHour * 60 + minutesFromStart) / SLOT_SNAP_MINUTES) * SLOT_SNAP_MINUTES,
    );
    const start = new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      Math.floor(absoluteMinutes / 60),
      absoluteMinutes % 60,
      0,
      0,
    );
    setSlotMenu({
      staffProfileId: column.staffProfileId,
      staffName: column.name,
      startAt: start.toISOString(),
      x: event.clientX - boardRect.left,
      y: event.clientY - boardRect.top,
      boardWidth: boardRect.width,
    });
  }

  const windowMinutes = (endHour - startHour) * 60;

  // Pointer Y (viewport) → minutes from the window start. The grid begins one
  // header height below the board's top; the board itself may be scrolled, which
  // getBoundingClientRect already accounts for.
  function pointerToMinutes(clientY: number): number {
    const board = boardRef.current;
    if (!board) return 0;
    const rect = board.getBoundingClientRect();
    return ((clientY - rect.top - HEADER_HEIGHT_PX) / HOUR_PX) * 60;
  }

  const snap = (minutes: number) => Math.round(minutes / SLOT_SNAP_MINUTES) * SLOT_SNAP_MINUTES;

  // Minutes-from-window-start → an ISO timestamp on the shown day.
  function minutesToIso(minutesFromWindow: number): string {
    const absolute = startHour * 60 + minutesFromWindow;
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, 0, 0, 0);
    start.setMinutes(absolute);
    return start.toISOString();
  }

  // The stylist column under the pointer, found via the DOM (the drag preview is
  // pointer-events-none, so it never shadows the column beneath).
  function columnAtPoint(clientX: number, clientY: number): ColumnModel | null {
    const el = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest('[data-col-key]');
    if (!el) return null;
    const key = (el as HTMLElement).dataset.colKey;
    return columns.find((column) => column.key === key) ?? null;
  }

  function beginBookingDrag(
    event: React.PointerEvent<HTMLElement>,
    booking: StaffBookingSummary,
    column: ColumnModel,
    mode: DragState['mode'],
  ) {
    if (!dragEnabled) return;
    if (mode === 'move' && !onMoveBooking) return;
    if (mode === 'resize' && !onResizeBooking) return;
    // Only primary-button / touch / pen drags.
    if (event.button !== 0 && event.pointerType === 'mouse') return;

    const originStartMin = clamp(minutesFromWindowStart(booking.startsAt, startHour), 0, windowMinutes);
    let originEndMin = minutesFromWindowStart(booking.endsAt, startHour);
    if (originEndMin <= originStartMin) originEndMin = originStartMin + (booking.durationMinutes ?? 30);
    const originDurationMin = Math.max(SLOT_SNAP_MINUTES, originEndMin - originStartMin);
    const grabOffsetMin = pointerToMinutes(event.clientY) - originStartMin;
    // The resize handle grabs the LAST occupied slice, so a resize can't drag its
    // bottom above its own top — the total can't shrink below that slice's start.
    const runs = serviceOccupiedRuns(booking, startHour, windowMinutes);
    const lastRunStartMin = runs.length ? runs[runs.length - 1].startMin : originStartMin;
    const originWorking = workingIntervalsFor(column, startHour, windowMinutes);

    const initial: DragState = {
      booking,
      mode,
      grabOffsetMin,
      originStartMin,
      originDurationMin,
      lastRunStartMin,
      previewStartMin: originStartMin,
      previewDurationMin: originDurationMin,
      targetColKey: column.key,
      targetStaffProfileId: column.staffProfileId,
      targetStaffName: column.name,
      originStaffProfileId: booking.assignedStaffProfileId,
      originWorking,
      valid: true,
      moved: false,
    };
    dragRef.current = initial;

    const startClientX = event.clientX;
    const startClientY = event.clientY;

    const handleMove = (moveEvent: PointerEvent) => {
      const current = dragRef.current;
      if (!current) return;
      if (!current.moved) {
        const dx = moveEvent.clientX - startClientX;
        const dy = moveEvent.clientY - startClientY;
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        current.moved = true;
      }
      moveEvent.preventDefault();
      if (current.mode === 'move') {
        // Snap the DELTA relative to the (possibly off-grid) original start so a
        // purely sideways drag (reassign only) leaves the start untouched, and an
        // off-grid booking keeps its offset when moved.
        const deltaMin = pointerToMinutes(moveEvent.clientY) - current.grabOffsetMin - current.originStartMin;
        const maxStart = Math.max(0, windowMinutes - current.originDurationMin);
        const desiredStart = clamp(current.originStartMin + snap(deltaMin), 0, maxStart);
        // The effective drop target is the hovered stylist column (or the last one
        // hovered). The appointment is CLAMPED into that stylist's working hours, so
        // the tile can't leave the roster; if it can't fit at all, the drop is invalid.
        const hovered = columnAtPoint(moveEvent.clientX, moveEvent.clientY);
        const targetColumn =
          hovered && hovered.staffProfileId
            ? hovered
            : columns.find((column) => column.key === current.targetColKey) ?? null;
        const working = workingIntervalsFor(targetColumn, startHour, windowMinutes);
        const fit = fitToWorking(desiredStart, current.originDurationMin, working);
        const next: DragState = {
          ...current,
          previewStartMin: fit.start,
          valid: fit.valid,
          ...(targetColumn && targetColumn.staffProfileId
            ? {
                targetColKey: targetColumn.key,
                targetStaffProfileId: targetColumn.staffProfileId,
                targetStaffName: targetColumn.name,
              }
            : {}),
        };
        dragRef.current = next;
        setDrag(next);
      } else {
        const rawEnd = pointerToMinutes(moveEvent.clientY);
        // The end can't be dragged past the end of the working shift that contains
        // the start, so a resize can never push the appointment beyond the roster.
        // An appointment that ALREADY overruns its shift keeps its current end
        // (isn't force-shrunk on the first nudge).
        const shift = current.originWorking.find(
          (iv) => current.originStartMin >= iv.startMin && current.originStartMin < iv.endMin,
        );
        const originEndMin = current.originStartMin + current.originDurationMin;
        const maxEnd = shift ? Math.max(shift.endMin, originEndMin) : windowMinutes;
        // Nor above the last slice's top (+ one slot) — that slice is what grows/
        // shrinks. Capped at maxEnd so the clamp window can never invert past the roster.
        const minEnd = Math.min(current.lastRunStartMin + SLOT_SNAP_MINUTES, maxEnd);
        const snappedEnd = clamp(snap(rawEnd), minEnd, maxEnd);
        const next: DragState = { ...current, previewDurationMin: snappedEnd - current.originStartMin };
        dragRef.current = next;
        setDrag(next);
      }
    };

    const detachListeners = () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleCancel);
    };

    const handleUp = (upEvent: PointerEvent) => {
      detachListeners();
      const current = dragRef.current;
      dragRef.current = null;
      setDrag(null);
      if (!current || !current.moved) return; // treat as a click — let onClick handle it
      // Suppress the trailing click ONLY when the drag actually commits a change; a
      // tiny drag that snaps back to the same slot/stylist is a no-op and should
      // still open the tile's action menu like a plain click.
      const suppressClick = () => {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      };

      if (current.mode === 'move') {
        // Refuse a drop that can't sit inside the target stylist's working hours.
        if (!current.valid) {
          suppressClick();
          onDragBlocked?.(current.targetStaffName);
          return;
        }
        const staffChanged =
          current.targetStaffProfileId != null && current.targetStaffProfileId !== current.originStaffProfileId;
        const timeChanged = current.previewStartMin !== current.originStartMin;
        if (!staffChanged && !timeChanged) return;
        suppressClick();
        onMoveBooking?.(current.booking, {
          startAt: minutesToIso(current.previewStartMin),
          staffProfileId: staffChanged ? current.targetStaffProfileId : undefined,
          staffName: staffChanged ? current.targetStaffName : undefined,
        });
      } else {
        const durationMinutes = current.previewDurationMin;
        if (durationMinutes === current.originDurationMin) return;
        suppressClick();
        onResizeBooking?.(current.booking, { durationMinutes });
      }
      void upEvent;
    };

    // The browser fires pointercancel INSTEAD of pointerup when it takes over the
    // pointer (multi-touch, an OS gesture, or the tile unmounting mid-drag). Tear
    // down and drop the drag WITHOUT committing, so listeners never leak and the
    // tile is never left stuck dimmed.
    const handleCancel = () => {
      detachListeners();
      dragRef.current = null;
      setDrag(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleCancel);
    setDrag(initial);
  }

  // Position of the current-time line within the visible window.
  const isToday = isSameDayLocal(now, day);
  const nowMinutes = now.getHours() * 60 + now.getMinutes() - startHour * 60;
  const nowOffset = (nowMinutes / 60) * HOUR_PX;
  const showNowLine = showTimeline && isToday && nowMinutes >= 0 && nowMinutes <= (endHour - startHour) * 60;

  if (columns.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center rounded-2xl border border-border bg-surface px-4 py-16 text-center">
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-surface-alt text-text-muted">
          <CalendarEmptyIcon className="h-5 w-5" />
        </div>
        <div className="text-[14px] font-semibold text-text-primary">
          {showAllTeamMembers ? 'Nothing on the book for this day' : 'No appointments scheduled'}
        </div>
        <div className="mt-1 text-[13px] text-text-secondary">
          {showAllTeamMembers
            ? `No stylists are rostered and there are no appointments at this location on ${formatDayLabel(day)}.`
            : `No team member has an appointment on ${formatDayLabel(day)}. Turn on “Show all team members” to see everyone rostered.`}
        </div>
      </div>
    );
  }

  const minBoardWidth = columns.length * COLUMN_WIDTH + 64;

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-2xl border border-border bg-surface shadow-sm">
      <div ref={boardRef} className="relative flex" style={{ minWidth: minBoardWidth }}>
        {/* Time axis — hour labels only; the 15-minute ruling lives in the
            stylist columns, not in this rail. */}
        <div className="sticky left-0 z-30 w-16 shrink-0 border-r border-border/60 bg-surface">
          <div className={`${HEADER_HEIGHT} border-b border-border/60`} />
          <div className="relative" style={{ height: totalHeight }}>
            {hours.map((hour) => (
              <div
                key={hour}
                // Centre the label on its hour line (leading-none avoids the
                // inherited 1.5 line-height that otherwise drifts it toward :15).
                style={{ top: (hour - startHour) * HOUR_PX }}
                className="absolute right-0 -translate-y-1/2 pr-2 text-right text-[10px] font-medium leading-none text-text-muted"
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
              <div className="min-w-0 flex-1">
                <div className="truncate text-[13px] font-semibold text-text-primary">{column.name}</div>
                <div className="truncate text-[11px] text-text-muted">{column.subtitle}</div>
              </div>
              {column.utilisationPercent !== null ? (
                <span
                  className={`shrink-0 rounded-pill px-1.5 py-0.5 text-[10px] font-bold tabular-nums ${utilisationTone(
                    column.utilisationPercent,
                  )}`}
                  title={`Utilisation: ${column.utilisationPercent}% of available hours booked`}
                >
                  {column.utilisationPercent}%
                </span>
              ) : null}
            </div>

            <div
              data-col-key={column.key}
              data-staff-id={column.staffProfileId ?? ''}
              className={`relative ${createEnabled && column.staffProfileId ? 'cursor-pointer' : ''} ${
                drag && drag.mode === 'move' && column.staffProfileId && drag.targetColKey === column.key
                  ? 'bg-primary/[0.04] ring-2 ring-inset ring-primary/30'
                  : ''
              }`}
              style={{ height: totalHeight }}
              onClick={(event) => openSlotMenu(event, column)}
            >
              {/* 15-minute gridlines. Every quarter-hour is ruled; the hour
                  boundary reads strongest, then the half-hour, then the
                  quarters — all in a light-black tint so appointment tiles
                  stay dominant. */}
              <QuarterHourGridlines ticks={quarterTicks} />

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

              {/* Appointment blocks. An appointment is split into ONE slice PER
                  SERVICE, each tinted by that service's category colour; a
                  stylist-free "development" segment is left as a clear, bookable gap
                  (never a tile) and can split a service into two slices. The slices of
                  one appointment are linked by a thin neutral rail through any gap. */}
              {layoutBookings(column.bookings, startHour, totalHeight).map((positioned) => {
                const { booking, lane, laneCount, blocks, topPx: railTop, heightPx: railHeight } = positioned;
                const tone = statusTone(booking.status);
                const accent = statusAccent(tone);
                const muted = booking.status === 'cancelled' || booking.status === 'no_show';
                const selected = selectedBookingId === booking.id;
                const arrived = booking.status === 'checked_in';
                const widthPct = 100 / laneCount;
                const split = blocks.length > 1;
                // Only live, un-settled appointments can be dragged/resized.
                const canDrag = dragEnabled && ['pending', 'accepted', 'checked_in'].includes(booking.status);
                const isDragging = drag?.booking.id === booking.id && drag.moved;
                const dimClass = isDragging ? 'opacity-40' : muted ? 'opacity-60' : '';
                return (
                  <Fragment key={booking.id}>
                    {/* Neutral rail spanning the whole appointment, including any
                        development gap, so the per-service slices read as one booking.
                        pointer-events-none → the clear gap stays clickable to book
                        another client into the stylist's free time. */}
                    {split ? (
                      <span
                        aria-hidden
                        className="pointer-events-none absolute z-0 rounded-full"
                        style={{
                          top: railTop,
                          height: railHeight,
                          left: `${lane * widthPct}%`,
                          width: 3,
                          backgroundColor: 'rgba(16,24,40,0.22)',
                          opacity: muted ? 0.3 : 0.55,
                        }}
                      />
                    ) : null}
                    {blocks.map((block, blockIndex) => {
                      const rounding = !split
                        ? 'rounded-lg'
                        : block.isFirst
                          ? 'rounded-t-lg'
                          : block.isLast
                            ? 'rounded-b-lg'
                            : '';
                      const barRounding = !split
                        ? 'rounded-l-lg'
                        : `${block.isFirst ? 'rounded-tl-lg' : ''} ${block.isLast ? 'rounded-bl-lg' : ''}`;
                      // Tint THIS slice by its own service's category colour, with
                      // readable text picked from the colour's luminance.
                      const blockColor = serviceCategoryColor(
                        block.serviceId,
                        block.serviceName,
                        serviceColors,
                        serviceColorsByName,
                      );
                      const onDark = blockColor ? hexLuminance(blockColor) < 0.55 : false;
                      const primaryText = blockColor ? (onDark ? '#FFFFFF' : '#101828') : undefined;
                      const mutedText = blockColor
                        ? onDark
                          ? 'rgba(255,255,255,0.82)'
                          : 'rgba(16,24,40,0.66)'
                        : undefined;
                      return (
                        <Fragment key={blockIndex}>
                          {/* Opaque backing so the 15-minute gridlines never show
                              through a booked block (covers translucent tiles too). */}
                          <div
                            className="absolute bg-surface"
                            style={{ top: block.topPx, height: block.heightPx, left: `${lane * widthPct}%`, width: `${widthPct}%` }}
                            aria-hidden
                          />
                          <button
                            type="button"
                            onPointerDown={
                              canDrag && onMoveBooking
                                ? (event) => beginBookingDrag(event, booking, column, 'move')
                                : undefined
                            }
                            onClick={(event) => {
                              // Don't let a block click also open the empty-slot create menu.
                              event.stopPropagation();
                              // A drag just ended — swallow the trailing click.
                              if (suppressClickRef.current) return;
                              handleBookingTap(event.clientX, event.clientY, booking);
                            }}
                            style={{
                              top: block.topPx,
                              height: block.heightPx,
                              left: `calc(${lane * widthPct}% + 3px)`,
                              width: `calc(${widthPct}% - 6px)`,
                              ...(blockColor ? { backgroundColor: blockColor } : {}),
                            }}
                            className={`absolute overflow-hidden border text-left shadow-sm transition-all ${rounding} ${
                              canDrag ? 'cursor-grab touch-none active:cursor-grabbing' : ''
                            } ${
                              selected
                                ? `z-20 border-primary shadow-md ring-2 ring-primary/40`
                                : `z-10 border-border/70 hover:border-border hover:shadow-md`
                            } ${blockColor ? '' : selected ? 'bg-primary/5' : 'bg-surface'} ${dimClass}`}
                            title={`${booking.clientDisplayName} · ${block.serviceName}`}
                          >
                            <span className={`absolute inset-y-0 left-0 w-[3px] ${barRounding} ${accent.bar}`} aria-hidden />
                            {block.isFirst ? (
                              <span className="relative z-[1] block py-1.5 pl-3 pr-1.5">
                                <span
                                  className="flex items-center gap-1 truncate text-[11px] font-semibold text-text-primary"
                                  style={primaryText ? { color: primaryText } : undefined}
                                >
                                  {arrived ? (
                                    <span
                                      className="inline-flex shrink-0 items-center rounded-pill bg-success-soft px-1.5 text-[9px] font-bold uppercase tracking-[0.05em] text-success"
                                      title="Client has arrived"
                                    >
                                      Arrived
                                    </span>
                                  ) : null}
                                  <span className="truncate">
                                    {formatTime(booking.startsAt)} · {booking.clientDisplayName}
                                  </span>
                                </span>
                                {/* This slice's own service (the first one). */}
                                <span
                                  className="block truncate text-[10px] text-text-muted"
                                  style={mutedText ? { color: mutedText } : undefined}
                                >
                                  {block.serviceName || 'Service'}
                                </span>
                              </span>
                            ) : (
                              // A later service (or the same service resumed after
                              // development time), labelled by its own name.
                              <span className="relative z-[1] block py-1 pl-3 pr-1.5">
                                <span
                                  className="truncate text-[10px] font-semibold text-text-primary"
                                  style={primaryText ? { color: primaryText } : undefined}
                                >
                                  {block.serviceName || 'Service'}
                                  {block.continued ? ' · resumes' : ''}
                                </span>
                              </span>
                            )}
                            {/* Drag the bottom edge to lengthen/shorten (resize) the
                                appointment. Only on the last block; its own pointerdown
                                stops the move-drag from also firing. */}
                            {block.isLast && canDrag && onResizeBooking ? (
                              <span
                                role="separator"
                                aria-label="Drag to change duration"
                                onPointerDown={(event) => {
                                  event.stopPropagation();
                                  beginBookingDrag(event, booking, column, 'resize');
                                }}
                                onClick={(event) => event.stopPropagation()}
                                className="absolute inset-x-0 bottom-0 z-[2] flex h-2.5 cursor-ns-resize touch-none items-end justify-center opacity-0 transition-opacity hover:opacity-100"
                              >
                                <span className="mb-0.5 h-1 w-6 rounded-full bg-black/30" aria-hidden />
                              </span>
                            ) : null}
                          </button>
                        </Fragment>
                      );
                    })}
                  </Fragment>
                );
              })}

              {/* Drag preview — a dashed ghost showing where the appointment will
                  land (move: target column + new start; resize: same column + new
                  end). Rendered inside the target column's grid so it reuses the
                  exact vertical coordinate system as the real tiles. */}
              {drag && drag.moved && drag.targetColKey === column.key
                ? (() => {
                    let ghostStartMin: number;
                    let ghostEndMin: number;
                    if (drag.mode === 'move') {
                      // Whole appointment slides to the new start (its span is unchanged).
                      ghostStartMin = drag.previewStartMin;
                      ghostEndMin = drag.previewStartMin + drag.originDurationMin;
                    } else {
                      // Resize anchors on the LAST occupied slice so the ghost never
                      // covers the clear development gap of a split appointment. The
                      // end is clamped (in handleMove) to stay below the slice's top,
                      // so start < end always holds.
                      ghostStartMin = drag.lastRunStartMin;
                      ghostEndMin = drag.originStartMin + drag.previewDurationMin;
                    }
                    const ghostTop = (ghostStartMin / 60) * HOUR_PX;
                    const ghostHeight = Math.max(SPLIT_BLOCK_MIN_PX, ((ghostEndMin - ghostStartMin) / 60) * HOUR_PX);
                    const reassigning =
                      drag.mode === 'move' && drag.targetStaffProfileId !== drag.originStaffProfileId;
                    // Outside the target stylist's working hours → red "can't drop here".
                    const invalid = drag.mode === 'move' && !drag.valid;
                    return (
                      <div
                        className="pointer-events-none absolute inset-x-0 z-30 px-[3px]"
                        style={{ top: ghostTop, height: ghostHeight }}
                        aria-hidden
                      >
                        <div
                          className={`flex h-full w-full flex-col overflow-hidden rounded-lg border-2 border-dashed px-2 py-1 shadow-lg ${
                            invalid ? 'border-danger bg-danger-soft' : 'border-primary bg-primary/10'
                          }`}
                        >
                          <span
                            className={`truncate text-[11px] font-semibold ${invalid ? 'text-danger' : 'text-primary'}`}
                          >
                            {formatTime(minutesToIso(ghostStartMin))}
                            {drag.mode === 'resize' ? `–${formatTime(minutesToIso(ghostEndMin))}` : ''}
                          </span>
                          <span className={`truncate text-[10px] ${invalid ? 'text-danger' : 'text-primary/80'}`}>
                            {invalid
                              ? 'Outside working hours'
                              : reassigning
                                ? `→ ${drag.targetStaffName}`
                                : drag.booking.clientDisplayName}
                          </span>
                        </div>
                      </div>
                    );
                  })()
                : null}
            </div>
          </div>
        ))}

        {/* Current-time line. Spans every column; the label sits over the time
            axis. Offset by the header height so it lands inside the grid. */}
        {showNowLine ? (
          <div
            className="pointer-events-none absolute inset-x-0 z-40"
            style={{ top: HEADER_HEIGHT_PX + nowOffset }}
            aria-hidden
          >
            <div className="flex items-center">
              <span className="w-16 shrink-0 pr-2 text-right text-[10px] font-bold leading-none text-danger">
                {formatTime(now.toISOString())}
              </span>
              <span className="relative flex-1">
                <span className="absolute -left-1 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-danger" />
                <span className="block h-0.5 w-full bg-danger" />
              </span>
            </div>
          </div>
        ) : null}

        {bookingMenu ? (
          <BookingActionMenu
            state={bookingMenu}
            onClose={() => setBookingMenu(null)}
            onCheckIn={onCheckIn ? () => { onCheckIn(bookingMenu.booking); setBookingMenu(null); } : undefined}
            onCheckOut={onCheckOut ? () => { onCheckOut(bookingMenu.booking); setBookingMenu(null); } : undefined}
            onEdit={onEditBooking ? () => { onEditBooking(bookingMenu.booking); setBookingMenu(null); } : undefined}
            onCancel={onCancelBooking ? () => { onCancelBooking(bookingMenu.booking); setBookingMenu(null); } : undefined}
          />
        ) : null}

        {slotMenu ? (
          <SlotMenu
            state={slotMenu}
            bookOutTypes={bookOutTypes}
            onClose={() => setSlotMenu(null)}
            onAddAppointment={
              onAddAppointment
                ? () => {
                    onAddAppointment({
                      staffProfileId: slotMenu.staffProfileId,
                      staffName: slotMenu.staffName,
                      startAt: slotMenu.startAt,
                    });
                    setSlotMenu(null);
                  }
                : undefined
            }
            onAddBookout={
              onAddBookout
                ? (minutes, notes, bookOutTypeId) => {
                    const endsAt = new Date(new Date(slotMenu.startAt).getTime() + minutes * 60_000).toISOString();
                    onAddBookout({
                      staffProfileId: slotMenu.staffProfileId,
                      staffName: slotMenu.staffName,
                      startAt: slotMenu.startAt,
                      endsAt,
                      notes,
                      bookOutTypeId,
                    });
                    setSlotMenu(null);
                  }
                : undefined
            }
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * Horizontal 15-minute gridlines, absolutely positioned within a relative,
 * fixed-height container (the time axis or a stylist column). Ticks are
 * 15-minute indices from the window start; every 4th tick is an hour
 * boundary and every 2nd is the half-hour. Lines are drawn in a light-black
 * tint with the hour strongest so the ruling stays subtle under tiles.
 */
function QuarterHourGridlines({ ticks }: { ticks: number[] }) {
  return (
    <>
      {ticks.map((tick) => {
        const isHour = tick % 4 === 0;
        const isHalf = tick % 4 === 2;
        const color = isHour ? 'rgba(0,0,0,0.16)' : isHalf ? 'rgba(0,0,0,0.10)' : 'rgba(0,0,0,0.06)';
        return (
          <div
            key={`grid-${tick}`}
            className="pointer-events-none absolute inset-x-0"
            style={{ top: tick * QUARTER_PX, height: 0, borderTop: `1px solid ${color}` }}
            aria-hidden
          />
        );
      })}
    </>
  );
}

function SlotMenu({
  state,
  bookOutTypes,
  onClose,
  onAddAppointment,
  onAddBookout,
}: {
  state: SlotMenuState;
  bookOutTypes?: BookOutType[];
  onClose: () => void;
  onAddAppointment?: () => void;
  onAddBookout?: (minutes: number, notes?: string, bookOutTypeId?: string) => void;
}) {
  const [bookoutMode, setBookoutMode] = useState(false);
  const [minutes, setMinutes] = useState(30);
  const [note, setNote] = useState('');
  const activeTypes = (bookOutTypes ?? []).filter((type) => type.isActive);
  const [bookOutTypeId, setBookOutTypeId] = useState<string>('');

  const PANEL_WIDTH = 256;
  const left = Math.max(8, Math.min(state.x, state.boardWidth - PANEL_WIDTH - 8));

  return (
    <>
      {/* Click-away backdrop */}
      <div className="absolute inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        className="absolute z-50 rounded-card-lg border border-border bg-surface p-3 shadow-lg"
        style={{ top: state.y, left, width: PANEL_WIDTH }}
        role="dialog"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="min-w-0 text-[13px] font-semibold text-text-primary">
            <span className="truncate">{state.staffName}</span>
            <span className="text-text-secondary"> · {formatTime(state.startAt)}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-text-secondary transition hover:bg-surface-alt hover:text-text-primary"
          >
            ×
          </button>
        </div>

        {bookoutMode ? (
          <div className="flex flex-col gap-2">
            {activeTypes.length > 0 ? (
              <label className="text-[11px] font-medium uppercase tracking-[0.06em] text-text-secondary">
                Reason
                <select
                  value={bookOutTypeId}
                  onChange={(event) => setBookOutTypeId(event.target.value)}
                  className="mt-1 h-9 w-full rounded-input border border-border bg-surface px-2 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
                >
                  <option value="">General book out</option>
                  {activeTypes.map((type) => (
                    <option key={type.id} value={type.id}>
                      {type.name}
                      {type.blocksAppointments ? '' : ' (bookable)'}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <label className="text-[11px] font-medium uppercase tracking-[0.06em] text-text-secondary">
              Duration
              <select
                value={minutes}
                onChange={(event) => setMinutes(Number(event.target.value))}
                className="mt-1 h-9 w-full rounded-input border border-border bg-surface px-2 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
              >
                {[15, 30, 45, 60, 90, 120].map((m) => (
                  <option key={m} value={m}>
                    {m} min
                  </option>
                ))}
              </select>
            </label>
            <input
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Note (optional)"
              className="h-9 w-full rounded-input border border-border bg-surface px-2 text-[13px] text-text-primary outline-none focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setBookoutMode(false)}
                className="h-9 flex-1 rounded-pill border border-border-strong bg-surface text-[13px] font-medium text-text-secondary transition hover:bg-surface-alt"
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => onAddBookout?.(minutes, note.trim() || undefined, bookOutTypeId || undefined)}
                className="h-9 flex-1 rounded-pill bg-primary text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
              >
                Create bookout
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {onAddAppointment ? (
              <button
                type="button"
                onClick={onAddAppointment}
                className="h-10 w-full rounded-pill bg-primary text-[13px] font-semibold text-text-on-primary transition hover:bg-primary-deep"
              >
                Add appointment
              </button>
            ) : null}
            {onAddBookout ? (
              <button
                type="button"
                onClick={() => setBookoutMode(true)}
                className="h-10 w-full rounded-pill border border-border-strong bg-surface text-[13px] font-semibold text-text-primary transition hover:bg-surface-alt"
              >
                Add bookout
              </button>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}

/** Which tile actions apply to a booking, given its status. */
function bookingActionAvailability(status: StaffBookingSummary['status']): {
  canCheckIn: boolean;
  canCheckOut: boolean;
  canEdit: boolean;
  canCancel: boolean;
  checkOutLabel: string;
} {
  return {
    canCheckIn: status === 'accepted',
    canCheckOut: ['accepted', 'checked_in', 'awaiting_payment'].includes(status),
    canEdit: ['pending', 'accepted', 'checked_in'].includes(status),
    canCancel: ['pending', 'accepted', 'checked_in'].includes(status),
    checkOutLabel: status === 'awaiting_payment' ? 'Open checkout' : 'Check out',
  };
}

// Action menu anchored at the clicked appointment tile. Mirrors SlotMenu's
// click-away + clamped positioning so it stays inside the board with no scroll.
function BookingActionMenu({
  state,
  onClose,
  onCheckIn,
  onCheckOut,
  onEdit,
  onCancel,
}: {
  state: BookingMenuState;
  onClose: () => void;
  onCheckIn?: () => void;
  onCheckOut?: () => void;
  onEdit?: () => void;
  onCancel?: () => void;
}) {
  const { booking } = state;
  const availability = bookingActionAvailability(booking.status);
  const arrived = booking.status === 'checked_in';

  const PANEL_WIDTH = 240;
  const PANEL_HEIGHT = 252;
  const left = Math.max(8, Math.min(state.x, state.boardWidth - PANEL_WIDTH - 8));
  const top = Math.max(8, Math.min(state.y, state.boardHeight - PANEL_HEIGHT - 8));

  return (
    <>
      {/* Click-away backdrop */}
      <div className="absolute inset-0 z-40" onClick={onClose} aria-hidden />
      <div
        className="absolute z-50 rounded-card-lg border border-border bg-surface p-3 shadow-lg"
        style={{ top, left, width: PANEL_WIDTH }}
        role="dialog"
        aria-label="Appointment actions"
      >
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-text-primary">{booking.clientDisplayName}</div>
            <div className="truncate text-[11px] text-text-secondary">
              {formatTime(booking.startsAt)} · {booking.serviceNames.join(', ') || 'Service'}
            </div>
            {arrived ? (
              <div className="mt-0.5 text-[11px] font-semibold text-success">Arrived — checked in</div>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-text-secondary transition hover:bg-surface-alt hover:text-text-primary"
          >
            ×
          </button>
        </div>

        <div className="flex flex-col gap-1.5">
          {onCheckIn ? (
            <BookingMenuButton
              label={arrived ? 'Checked in' : 'Check in'}
              onClick={onCheckIn}
              disabled={!availability.canCheckIn}
              icon={<CheckIcon className="h-4 w-4" />}
            />
          ) : null}
          {onCheckOut ? (
            <BookingMenuButton
              label={availability.checkOutLabel}
              onClick={onCheckOut}
              disabled={!availability.canCheckOut}
              variant="primary"
              icon={<CardIcon className="h-4 w-4" />}
            />
          ) : null}
          {onEdit ? (
            <BookingMenuButton
              label="Edit appointment"
              onClick={onEdit}
              disabled={!availability.canEdit}
              icon={<PencilIcon className="h-4 w-4" />}
            />
          ) : null}
          {onCancel ? (
            <BookingMenuButton
              label="Cancel appointment"
              onClick={onCancel}
              disabled={!availability.canCancel}
              variant="danger"
              icon={<BanIcon className="h-4 w-4" />}
            />
          ) : null}
        </div>
      </div>
    </>
  );
}

function BookingMenuButton({
  label,
  onClick,
  disabled = false,
  variant = 'default',
  icon,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'default' | 'primary' | 'danger';
  icon?: React.ReactNode;
}) {
  const tone =
    variant === 'primary'
      ? 'bg-primary text-text-on-primary hover:bg-primary-deep border-transparent'
      : variant === 'danger'
        ? 'bg-surface text-danger border-danger-border hover:bg-danger-soft'
        : 'bg-surface text-text-primary border-border-strong hover:bg-surface-alt';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-10 w-full items-center gap-2 rounded-pill border px-3.5 text-[13px] font-semibold transition disabled:cursor-not-allowed disabled:opacity-40 ${tone}`}
    >
      {icon ? <span className="shrink-0" aria-hidden>{icon}</span> : null}
      <span className="truncate">{label}</span>
    </button>
  );
}

function CheckIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden {...props}>
      <path d="m4 10.5 4 4 8-9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function CardIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden {...props}>
      <rect x="2.5" y="5" width="15" height="10" rx="2" />
      <path d="M2.5 8.5h15" strokeLinecap="round" />
    </svg>
  );
}

function PencilIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden {...props}>
      <path d="M13.5 4 16 6.5 7.5 15H5v-2.5L13.5 4Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BanIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden {...props}>
      <circle cx="10" cy="10" r="6.5" />
      <path d="m5.5 5.5 9 9" strokeLinecap="round" />
    </svg>
  );
}

// One drawn slice of an appointment: a contiguous stylist-OCCUPIED run WITHIN a
// single service. Each service is its own slice (coloured by its category), and a
// service with a stylist-free development segment splits into two slices with a
// clear gap between them.
interface PositionedBlockPart {
  topPx: number;
  heightPx: number;
  isFirst: boolean;
  isLast: boolean;
  /** Index into booking.services this slice belongs to (for its category colour). */
  serviceIndex: number;
  serviceId?: string;
  serviceName: string;
  /** True when this is a later run of the SAME service, resumed after free time. */
  continued: boolean;
}

interface PositionedBooking {
  booking: StaffBookingSummary;
  lane: number;
  laneCount: number;
  /** Top / height of the whole appointment span (first block top → last block bottom). */
  topPx: number;
  heightPx: number;
  blocks: PositionedBlockPart[];
}

interface MinuteInterval {
  startMin: number;
  endMin: number;
}

// A stylist-occupied run tagged with the service it belongs to, so the calendar can
// draw one coloured slice per service (and per resumed run after development time).
interface ServiceRun extends MinuteInterval {
  serviceIndex: number;
  serviceId?: string;
  serviceName: string;
  continued: boolean;
}

// Minimum drawn height for a single-block appointment (unchanged legibility floor)
// and for each slice of a split one (small — just enough to stay readable/clickable
// without inflating over the clear development gap).
const SPLIT_BLOCK_MIN_PX = 14;

// One stylist-OCCUPIED run PER SERVICE (in minutes from the window start), so each
// service draws as its own category-coloured slice. Within a service the non-free
// segments are kept and merged where contiguous; a stylist-free "development"
// segment splits the service into two runs with a clear gap. Runs are NOT merged
// across services (their colours differ). Falls back to a single full-span run when
// there is no per-service data, so every appointment always draws something.
function serviceOccupiedRuns(booking: StaffBookingSummary, startHour: number, totalMin: number): ServiceRun[] {
  const clampMin = (value: number) => clamp(value, 0, totalMin);
  const services = booking.services ?? [];
  const runs: ServiceRun[] = [];

  services.forEach((service, serviceIndex) => {
    const raw: MinuteInterval[] = [];
    let cursor = minutesFromWindowStart(service.startsAt, startHour);
    const segments = service.segments ?? [];
    if (segments.length === 0) {
      raw.push({ startMin: cursor, endMin: cursor + service.durationMinutes });
    } else {
      for (const segment of segments) {
        const end = cursor + segment.durationMinutes;
        if (!segment.isStylistFree) raw.push({ startMin: cursor, endMin: end });
        cursor = end;
      }
    }
    const clamped = raw
      .map((interval) => ({ startMin: clampMin(interval.startMin), endMin: clampMin(interval.endMin) }))
      .filter((interval) => interval.endMin > interval.startMin)
      .sort((a, b) => a.startMin - b.startMin);
    // Merge contiguous occupied windows WITHIN this service (same colour).
    const merged: MinuteInterval[] = [];
    for (const interval of clamped) {
      const last = merged[merged.length - 1];
      if (last && interval.startMin <= last.endMin) last.endMin = Math.max(last.endMin, interval.endMin);
      else merged.push({ ...interval });
    }
    merged.forEach((interval, runIndex) =>
      runs.push({
        ...interval,
        serviceIndex,
        serviceId: service.serviceId,
        serviceName: service.name,
        continued: runIndex > 0,
      }),
    );
  });

  if (runs.length === 0) {
    const startMin = clampMin(minutesFromWindowStart(booking.startsAt, startHour));
    let endMin = minutesFromWindowStart(booking.endsAt, startHour);
    if (endMin <= startMin) endMin = startMin + (booking.durationMinutes ?? 30);
    endMin = clampMin(endMin);
    if (endMin > startMin) {
      runs.push({
        startMin,
        endMin,
        serviceIndex: 0,
        serviceId: booking.serviceIds?.[0],
        serviceName: booking.serviceNames?.[0] ?? 'Service',
        continued: false,
      });
    }
  }

  runs.sort((a, b) => a.startMin - b.startMin || a.endMin - b.endMin);
  return runs;
}

// Two appointments conflict only when their OCCUPIED windows overlap — a booking
// slotted into another's development gap does not, so it shares the lane.
function intervalsOverlap(a: MinuteInterval[], b: MinuteInterval[]): boolean {
  return a.some((x) => b.some((y) => x.startMin < y.endMin && y.startMin < x.endMin));
}

// The part(s) of interval `iv` left after removing `cut` (0, 1 or 2 pieces).
function subtractInterval(iv: MinuteInterval, cut: MinuteInterval): MinuteInterval[] {
  if (cut.endMin <= iv.startMin || cut.startMin >= iv.endMin) return [iv]; // no overlap
  const out: MinuteInterval[] = [];
  if (cut.startMin > iv.startMin) out.push({ startMin: iv.startMin, endMin: cut.startMin });
  if (cut.endMin < iv.endMin) out.push({ startMin: cut.endMin, endMin: iv.endMin });
  return out;
}

// A stylist's BOOKABLE working windows for the day: their shift hours with lunch/
// breaks cut out, in minutes from the window start. Drag/resize keep an appointment
// inside these, so a tile can never land on a break or outside the roster.
function workingIntervalsFor(
  column: ColumnModel | null,
  startHour: number,
  totalMin: number,
): MinuteInterval[] {
  if (!column) return [];
  let intervals: MinuteInterval[] = [];
  for (const shift of column.shifts) {
    const startMin = clamp(minutesFromWindowStart(shift.scheduledStartAt, startHour), 0, totalMin);
    const endMin = clamp(minutesFromWindowStart(shift.scheduledEndAt, startHour), 0, totalMin);
    if (endMin > startMin) intervals.push({ startMin, endMin });
  }
  const breaks = column.shifts
    .flatMap((shift) => shift.breaks)
    .map((brk) => ({
      startMin: clamp(minutesFromWindowStart(brk.startedAt, startHour), 0, totalMin),
      endMin: clamp(minutesFromWindowStart(brk.endedAt, startHour), 0, totalMin),
    }))
    .filter((brk) => brk.endMin > brk.startMin);
  for (const brk of breaks) {
    intervals = intervals.flatMap((iv) => subtractInterval(iv, brk));
  }
  return intervals.sort((a, b) => a.startMin - b.startMin);
}

// Fit an appointment of `durationMin` starting near `desiredStart` into the nearest
// working interval that can hold it, returning the clamped start. `valid` is false
// when there are no working hours, or none long enough — the drop is then refused.
function fitToWorking(
  desiredStart: number,
  durationMin: number,
  intervals: MinuteInterval[],
): { start: number; valid: boolean } {
  if (intervals.length === 0) return { start: desiredStart, valid: false };
  const fitting = intervals.filter((interval) => interval.endMin - interval.startMin >= durationMin);
  if (fitting.length === 0) return { start: desiredStart, valid: false };
  let bestStart = desiredStart;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const interval of fitting) {
    const lo = interval.startMin;
    const hi = interval.endMin - durationMin;
    const clamped = Math.min(Math.max(desiredStart, lo), hi);
    const distance = Math.abs(clamped - desiredStart);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestStart = clamped;
    }
  }
  return { start: bestStart, valid: true };
}

// Positions every appointment in a column into overlap lanes and splits each into
// its per-service occupied slices. Lane assignment keys on occupied windows (not the
// full span), so a client booked during another's development time sits inline.
function layoutBookings(
  bookings: StaffBookingSummary[],
  startHour: number,
  totalHeight: number,
): PositionedBooking[] {
  const totalMin = (totalHeight / HOUR_PX) * 60;
  const items = bookings
    .map((booking) => ({ booking, runs: serviceOccupiedRuns(booking, startHour, totalMin) }))
    .filter((item) => item.runs.length > 0)
    .sort(
      (a, b) =>
        a.runs[0].startMin - b.runs[0].startMin ||
        a.runs[a.runs.length - 1].endMin - b.runs[b.runs.length - 1].endMin,
    );

  const lanes: MinuteInterval[][] = [];
  const withLanes = items.map((item) => {
    let lane = lanes.findIndex((laneIntervals) => !intervalsOverlap(laneIntervals, item.runs));
    if (lane === -1) {
      lane = lanes.length;
      lanes.push(item.runs.map((run) => ({ startMin: run.startMin, endMin: run.endMin })));
    } else {
      lanes[lane].push(...item.runs.map((run) => ({ startMin: run.startMin, endMin: run.endMin })));
    }
    return { ...item, lane };
  });
  const laneCount = Math.max(1, lanes.length);

  // The sorted start of every occupied slice PER LANE (across all bookings sharing
  // that lane). A slice's min-height floor is clamped to the next slice's start in
  // the SAME lane so a short/floored slice can never overlap the tile beneath it —
  // including a booking slotted into another's development gap (same lane).
  const laneStarts = new Map<number, number[]>();
  for (const item of withLanes) {
    const starts = laneStarts.get(item.lane) ?? [];
    for (const run of item.runs) starts.push(run.startMin);
    laneStarts.set(item.lane, starts);
  }
  for (const starts of laneStarts.values()) starts.sort((a, b) => a - b);

  return withLanes.map((item) => {
    const single = item.runs.length === 1;
    const laneSorted = laneStarts.get(item.lane) ?? [];
    const blocks: PositionedBlockPart[] = item.runs.map((run, index) => {
      const topPx = (run.startMin / 60) * HOUR_PX;
      const rawHeight = ((run.endMin - run.startMin) / 60) * HOUR_PX;
      // Single blocks keep the legible 30px floor; split slices use a small floor.
      const floored = single ? Math.max(MIN_BLOCK_PX, rawHeight) : Math.max(SPLIT_BLOCK_MIN_PX, rawHeight);
      // Never draw past the start of the NEXT occupied slice in this lane (any
      // booking) — that would (a) cover the clear development gap after it, and (b)
      // visually overlap the tile beneath it. When nothing follows, keep the floor.
      const nextStart = laneSorted.find((start) => start > run.startMin);
      const maxHeight = nextStart !== undefined ? (nextStart / 60) * HOUR_PX - topPx : Number.POSITIVE_INFINITY;
      return {
        topPx,
        heightPx: Math.min(floored, maxHeight),
        isFirst: index === 0,
        isLast: index === item.runs.length - 1,
        serviceIndex: run.serviceIndex,
        serviceId: run.serviceId,
        serviceName: run.serviceName,
        continued: run.continued,
      };
    });
    const first = blocks[0];
    const last = blocks[blocks.length - 1];
    return {
      booking: item.booking,
      lane: item.lane,
      laneCount,
      topPx: first.topPx,
      heightPx: last.topPx + last.heightPx - first.topPx,
      blocks,
    };
  });
}

function buildColumns(input: {
  staff: RotaStaffSummary[];
  bookings: StaffBookingSummary[];
  shiftsForDay: RotaShift[];
  absencesForDay: RotaAbsenceIndicator[];
  leaveStaffOnDay: Set<string>;
  day: Date;
}): ColumnModel[] {
  const { staff, bookings, shiftsForDay, absencesForDay, leaveStaffOnDay, day } = input;
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

  const columns: ColumnModel[] = staff.map((member) => {
    const memberShifts = shiftsForDay.filter((shift) => shift.staffProfileId === member.staffProfileId);
    const memberAbsences = absencesForDay.filter(
      (absence) => absence.staffProfileId === member.staffProfileId,
    );
    const onLeave = leaveStaffOnDay.has(member.staffProfileId);
    const memberBookings = bookingsByStaff.get(member.staffProfileId) ?? [];
    return {
      key: member.staffProfileId,
      staffProfileId: member.staffProfileId,
      name: member.displayName || member.fullName || 'Stylist',
      subtitle: subtitleForStaff(member, onLeave, shiftsForDay),
      colorHex: member.colorHex,
      shifts: memberShifts,
      absences: memberAbsences,
      onLeave,
      bookings: memberBookings,
      utilisationPercent: columnUtilisation(memberShifts, memberAbsences, memberBookings, onLeave, day),
    };
  });

  // Surface any appointments assigned to stylists who are not in this
  // location's roster so nothing is silently hidden.
  const rosterIds = new Set(staff.map((member) => member.staffProfileId));
  for (const [staffProfileId, list] of bookingsByStaff) {
    if (rosterIds.has(staffProfileId)) continue;
    columns.push({
      key: staffProfileId,
      staffProfileId,
      name: 'Other stylist',
      subtitle: 'Not on this location’s rota',
      shifts: [],
      absences: [],
      onLeave: false,
      bookings: list,
      utilisationPercent: null,
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
      utilisationPercent: null,
    });
  }

  return columns;
}

// Statuses that occupy the stylist's time and so count toward utilisation.
// Cancelled / rejected / no-show appointments free the slot up again.
const UTILISATION_BOOKED_STATUSES: StaffBookingSummary['status'][] = [
  'pending',
  'accepted',
  'checked_in',
  'awaiting_payment',
  'completed',
];

// Stylist-occupied milliseconds an appointment contributes on the given day.
// Mirrors the calendar's per-service occupied runs (development/stylist-free
// segments don't count), clamped to the day, with a whole-duration fallback.
function bookingOccupiedMs(booking: StaffBookingSummary, dayStartMs: number, dayEndMs: number): number {
  const clampMs = (value: number) => Math.min(Math.max(value, dayStartMs), dayEndMs);
  const services = booking.services ?? [];
  if (services.length === 0) {
    const startMs = new Date(booking.startsAt).getTime();
    let endMs = new Date(booking.endsAt).getTime();
    if (endMs <= startMs) endMs = startMs + (booking.durationMinutes ?? 30) * 60_000;
    return Math.max(0, clampMs(endMs) - clampMs(startMs));
  }
  let total = 0;
  for (const service of services) {
    let cursor = new Date(service.startsAt).getTime();
    const segments = service.segments ?? [];
    if (segments.length === 0) {
      total += Math.max(0, clampMs(cursor + service.durationMinutes * 60_000) - clampMs(cursor));
    } else {
      for (const segment of segments) {
        const end = cursor + segment.durationMinutes * 60_000;
        if (!segment.isStylistFree) total += Math.max(0, clampMs(end) - clampMs(cursor));
        cursor = end;
      }
    }
  }
  return total;
}

// Daily utilisation for one stylist column: booked ÷ available, where available
// is shift time minus breaks minus any book-out/leave that reduces available
// hours. Returns null when there's no available time (nothing to show).
function columnUtilisation(
  shifts: RotaShift[],
  absences: RotaAbsenceIndicator[],
  bookings: StaffBookingSummary[],
  onLeave: boolean,
  day: Date,
): number | null {
  if (onLeave) return null;
  const dayStartMs = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const dayEndMs = dayStartMs + 86_400_000;
  const clampMs = (value: number) => Math.min(Math.max(value, dayStartMs), dayEndMs);

  const shiftIntervals = shifts
    .filter((shift) => shift.status !== 'cancelled')
    .map((shift) => ({
      startMs: clampMs(new Date(shift.scheduledStartAt).getTime()),
      endMs: clampMs(new Date(shift.scheduledEndAt).getTime()),
    }));

  const breakIntervals = shifts
    .flatMap((shift) => shift.breaks)
    .map((brk) => ({
      startMs: clampMs(new Date(brk.startedAt).getTime()),
      endMs: clampMs(new Date(brk.endedAt).getTime()),
    }));

  const reducingBlocks = absences
    .filter((absence) => absence.reducesAvailableHours)
    .map((absence) => ({
      startMs: clampMs(new Date(absence.startsAt).getTime()),
      endMs: absence.endsAt ? clampMs(new Date(absence.endsAt).getTime()) : dayEndMs,
    }));

  const bookedMs = bookings
    .filter((booking) => UTILISATION_BOOKED_STATUSES.includes(booking.status))
    .reduce((sum, booking) => sum + bookingOccupiedMs(booking, dayStartMs, dayEndMs), 0);

  return computeDailyUtilisation({
    shifts: shiftIntervals,
    breaks: breakIntervals,
    reducingBlocks,
    bookedMs,
  }).utilisationPercent;
}

// Colour the utilisation badge: red when under-booked, amber mid, green when
// healthily busy. Thresholds mirror common salon utilisation targets.
function utilisationTone(percent: number): string {
  if (percent >= 75) return 'bg-success-soft text-success';
  if (percent >= 45) return 'bg-warning-soft text-warning';
  return 'bg-danger-soft text-danger';
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

function isSameDayLocal(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function intersectsDay(startsAt: string, endsAt: string | undefined, dayStart: Date, dayEnd: Date): boolean {
  const start = new Date(startsAt).getTime();
  const end = endsAt ? new Date(endsAt).getTime() : Number.POSITIVE_INFINITY;
  return start < dayEnd.getTime() && end > dayStart.getTime();
}

function statusTone(status: StaffBookingSummary['status']): StatusTone {
  switch (status) {
    case 'accepted':
    case 'checked_in':
      return 'success';
    case 'pending':
      return 'warning';
    case 'rejected':
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

// The category colour for a single service, used to tint that service's slice.
// Prefers the id map (exact catalogue match) and falls back to the name map, so a
// service row that only snapshotted a name (no `service_id`) still tints. Returns
// undefined → the slice stays neutral.
function serviceCategoryColor(
  serviceId: string | undefined,
  serviceName: string,
  byId?: Map<string, string>,
  byName?: Map<string, string>,
): string | undefined {
  const idColor = serviceId ? byId?.get(serviceId) : undefined;
  if (idColor) return idColor;
  return byName?.get(serviceName.trim().toLowerCase());
}

// Relative luminance of a #RRGGBB colour (WCAG), used to pick readable tile
// text — dark text on light category colours, white text on dark ones.
function hexLuminance(hex: string): number {
  const normalized = hex.replace('#', '');
  if (normalized.length !== 6) return 1;
  const channel = (start: number) => {
    const value = parseInt(normalized.slice(start, start + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
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
