import { useEffect, useState, type ReactNode, type SVGProps } from 'react';
import { cn } from '@sheer/utils';
import { addDays, snapToMonday } from '../rota/dateUtils';
import {
  CalendarToolbar,
  type CalendarToolbarKey,
  type CalendarToolbarState,
} from './CalendarToolbar';

interface WeekStripProps {
  /** Currently selected day (drives the visible week + highlight). */
  day: Date;
  onSelectDay: (day: Date) => void;
  /** View toggles, rendered as a toolbar docked to the top of the calendar. */
  toolbar: CalendarToolbarState;
  onToggleToolbar: (key: CalendarToolbarKey) => void;
  /** Controls docked to the far right of the toolbar (location picker, refresh). */
  toolbarTrailing?: ReactNode;
}

/**
 * Sheer-app-style week strip day selector — the booking page's "calendar".
 *
 * A view toolbar is docked to the top of the card; below it a month/year
 * header with circular week / month nav arrows, a "Today" shortcut, and a
 * seven-day row where each cell shows the weekday, day number, and a brand dot
 * marking today. The selected day is filled with the brand colour. The visible
 * week always contains the selected `day`, and browsing weeks/months moves the
 * selection alongside it so the owner/manager rota stays loaded.
 *
 * The "Auto-hide calendar" toggle collapses the date picker below the toolbar
 * (leaving the timetable untouched); the toolbar itself stays put so the
 * toggles remain reachable.
 */
export function WeekStrip({ day, onSelectDay, toolbar, onToggleToolbar, toolbarTrailing }: WeekStripProps) {
  const [weekStart, setWeekStart] = useState<Date>(() => snapToMonday(day));

  // Keep the visible week in sync when the selected day jumps outside it
  // (e.g. the "Today" shortcut or a programmatic change elsewhere).
  useEffect(() => {
    setWeekStart(snapToMonday(day));
  }, [day]);

  const today = new Date();
  const days = Array.from({ length: 7 }, (_, index) => addDays(weekStart, index));

  return (
    <div className="w-full overflow-hidden rounded-card border border-border bg-surface shadow-card">
      {/* View toolbar, docked to the top of the calendar. Stays put even when
          the date picker is auto-hidden, so the toggles remain reachable. */}
      <CalendarToolbar state={toolbar} onToggle={onToggleToolbar} trailing={toolbarTrailing} />

      {toolbar.autoHideCalendar ? null : (
        <div className="px-3 pb-3 pt-5">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-[14px] font-semibold text-text-primary">{monthYearLabel(addDays(weekStart, 3))}</span>
        <div className="flex items-center gap-1.5">
          <NavButton
            label="Previous month"
            onClick={() => setWeekStart((current) => snapToMonday(addMonths(current, -1)))}
          >
            <ChevronDoubleLeftIcon className="h-4 w-4" />
          </NavButton>
          <NavButton
            label="Previous week"
            onClick={() => setWeekStart((current) => addDays(current, -7))}
          >
            <ChevronLeftIcon className="h-4 w-4" />
          </NavButton>
          <button
            type="button"
            onClick={() => onSelectDay(new Date())}
            className="h-7 rounded-pill border border-border bg-surface px-3 text-[12px] font-medium text-text-secondary transition hover:bg-surface-alt hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
          >
            Today
          </button>
          <NavButton
            label="Next week"
            onClick={() => setWeekStart((current) => addDays(current, 7))}
          >
            <ChevronRightIcon className="h-4 w-4" />
          </NavButton>
          <NavButton
            label="Next month"
            onClick={() => setWeekStart((current) => snapToMonday(addMonths(current, 1)))}
          >
            <ChevronDoubleRightIcon className="h-4 w-4" />
          </NavButton>
        </div>
      </div>
      <div className="grid grid-cols-7 gap-1.5">
        {days.map((cell) => {
          const selected = isSameDay(cell, day);
          const today_ = isSameDay(cell, today);
          return (
            <button
              key={cell.toISOString()}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelectDay(cell)}
              className={cn(
                'flex flex-col items-center gap-1 rounded-input px-1 py-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
                selected ? 'bg-primary shadow-card' : 'hover:bg-surface-alt',
              )}
            >
              <span
                className={cn(
                  'text-[10px] font-semibold uppercase tracking-[0.06em]',
                  selected ? 'text-text-on-primary/80' : 'text-text-muted',
                )}
              >
                {weekdayLabel(cell)}
              </span>
              <span
                className={cn(
                  'text-[15px] font-semibold',
                  selected ? 'text-text-on-primary' : 'text-text-primary',
                )}
              >
                {cell.getDate()}
              </span>
              <span
                className={cn(
                  'h-1.5 w-1.5 rounded-full',
                  today_ ? (selected ? 'bg-white' : 'bg-primary') : 'bg-transparent',
                )}
                aria-hidden
              />
            </button>
          );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function NavButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center rounded-full border border-border bg-surface text-text-secondary transition hover:bg-surface-alt hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
    >
      {children}
    </button>
  );
}

function addMonths(date: Date, months: number): Date {
  return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

function weekdayLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { weekday: 'short' }).toUpperCase();
}

function monthYearLabel(date: Date): string {
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function ChevronLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden {...props}>
      <path d="M12 5 7 10l5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden {...props}>
      <path d="m8 5 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronDoubleLeftIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden {...props}>
      <path d="M10 5 5 10l5 5M15 5l-5 5 5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ChevronDoubleRightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={1.8} aria-hidden {...props}>
      <path d="m5 5 5 5-5 5M10 5l5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
