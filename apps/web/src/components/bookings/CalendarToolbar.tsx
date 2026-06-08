import type { ReactNode } from 'react';
import { cn } from '@sheer/utils';

export interface CalendarToolbarState {
  /** When false, stylists with no appointments on the selected day are hidden. */
  showAllTeamMembers: boolean;
  /** When true, a red "now" line is drawn on the calendar at the current time. */
  showTimeline: boolean;
  /** When true, the calendar board is hidden from view. */
  autoHideCalendar: boolean;
}

export type CalendarToolbarKey = keyof CalendarToolbarState;

const TOGGLES: { key: CalendarToolbarKey; label: string; hint: string }[] = [
  {
    key: 'showAllTeamMembers',
    label: 'Show all team members',
    hint: 'Hide stylists with no appointments today',
  },
  {
    key: 'showTimeline',
    label: 'Show timeline',
    hint: 'Draw a red line at the current time',
  },
  {
    key: 'autoHideCalendar',
    label: 'Auto-hide calendar',
    hint: 'Collapse the calendar board',
  },
];

/**
 * Owner / manager calendar toolbar. Three switch-style toggles that tune what
 * the day calendar board renders. The page owns the state (and persists it);
 * this component is purely presentational.
 *
 * `trailing` is rendered on the far right of the bar — the page docks the
 * location picker and refresh control here so they live alongside the view
 * toggles instead of in a separate panel.
 */
export function CalendarToolbar({
  state,
  onToggle,
  trailing,
}: {
  state: CalendarToolbarState;
  onToggle: (key: CalendarToolbarKey) => void;
  trailing?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 border-b border-border bg-surface-alt/50 px-4 py-2.5">
      <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-text-muted">View options</span>
      {TOGGLES.map((toggle) => (
        <Toggle
          key={toggle.key}
          label={toggle.label}
          hint={toggle.hint}
          checked={state[toggle.key]}
          onChange={() => onToggle(toggle.key)}
        />
      ))}
      {trailing ? <div className="ml-auto flex items-center gap-2">{trailing}</div> : null}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      title={hint}
      onClick={onChange}
      className="group inline-flex items-center gap-2 focus:outline-none"
    >
      <span
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors group-focus-visible:ring-2 group-focus-visible:ring-primary/30',
          checked ? 'bg-primary' : 'bg-border-strong',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow-sm transition-transform',
            checked && 'translate-x-4',
          )}
        />
      </span>
      <span
        className={cn(
          'text-[12px] font-medium transition-colors',
          checked ? 'text-text-primary' : 'text-text-secondary group-hover:text-text-primary',
        )}
      >
        {label}
      </span>
    </button>
  );
}
