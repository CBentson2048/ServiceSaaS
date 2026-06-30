import type { SheerLabAnalyticsRange } from '@sheer/domain';

/**
 * The period a Lab user can scope the Formula History view to. Mirrors the
 * backend `SheerLabAnalyticsRange`: the three presets plus a custom from/to
 * window ("randomize period").
 */
export type LabPeriod = SheerLabAnalyticsRange; // 'today' | 'week' | 'month' | 'custom'

/** Inclusive calendar-day selection from the date picker, as 'YYYY-MM-DD' strings. */
export interface LabCustomRange {
  from: string;
  to: string;
}

/** A resolved half-open ISO window [from 00:00, to+1day 00:00) sent to the API. */
export interface LabPeriodWindow {
  from: string;
  to: string;
}

/**
 * Resolve a custom calendar-day selection to a half-open ISO window
 * [from 00:00, to+1day 00:00) so the final day is included. Returns null when
 * the selection is incomplete or inverted, so callers can hold off fetching
 * until both ends are valid.
 */
export function resolveLabCustomWindow(custom: LabCustomRange | undefined): LabPeriodWindow | null {
  if (!custom?.from || !custom?.to) return null;
  const from = new Date(`${custom.from}T00:00:00`);
  const toStart = new Date(`${custom.to}T00:00:00`);
  if (Number.isNaN(from.getTime()) || Number.isNaN(toStart.getTime()) || from > toStart) return null;
  const to = new Date(toStart);
  to.setDate(to.getDate() + 1); // end is exclusive — include the whole final day
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Short suffix for period-aware labels, e.g. "Completed this week". */
export function periodSuffix(period: LabPeriod): string {
  switch (period) {
    case 'week':
      return 'this week';
    case 'month':
      return 'this month';
    case 'custom':
      return 'this period';
    default:
      return 'today';
  }
}

/** Possessive noun for the header subtitle, e.g. "Review this week's mixing sessions…". */
export function periodPossessive(period: LabPeriod): string {
  switch (period) {
    case 'week':
      return "this week's";
    case 'month':
      return "this month's";
    case 'custom':
      return "the selected period's";
    default:
      return "today's";
  }
}
