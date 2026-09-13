import type { LocalDate, ReportLocalStatus, ResolvedReportLocation } from '@sheer/domain';

/**
 * Human wording for resolved report dates. Pure string handling of local dates
 * the server already resolved per location: no clock, no `Intl`, no timezone
 * maths — the browser's own day is never consulted.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sept', 'Oct', 'Nov', 'Dec'];

function partsOf(date: LocalDate): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}

/** '2026-09-28' → '28 Sept 2026'. */
export function formatReportDate(date: LocalDate): string {
  const { year, month, day } = partsOf(date);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** '22–28 Sept 2026', '29 Sept – 1 Oct 2026', '30 Dec 2025 – 2 Jan 2026', or one date. */
export function formatReportDateRange(from: LocalDate, to: LocalDate): string {
  if (from === to) return formatReportDate(from);
  const start = partsOf(from);
  const end = partsOf(to);
  if (start.year === end.year && start.month === end.month) {
    return `${start.day}–${end.day} ${MONTHS[end.month - 1]} ${end.year}`;
  }
  if (start.year === end.year) {
    return `${start.day} ${MONTHS[start.month - 1]} – ${end.day} ${MONTHS[end.month - 1]} ${end.year}`;
  }
  return `${formatReportDate(from)} – ${formatReportDate(to)}`;
}

const STATUS_SUFFIX: Record<ReportLocalStatus, string> = {
  complete: '',
  in_progress: ' (in progress)',
  not_started: ' (not started)',
};

export interface ReportScopeGroup {
  key: string;
  /** e.g. '22–28 Sept 2026 (in progress)'. */
  label: string;
  status: ReportLocalStatus;
  locationNames: string[];
}

/**
 * Locations grouped by identical local range and status, in first-seen order.
 * Two locations can read the same dates while covering different UTC hours —
 * each follows its own calendar, which is what a salon means by "the 28th".
 */
export function groupReportScope(locations: readonly ResolvedReportLocation[]): ReportScopeGroup[] {
  const groups = new Map<string, ReportScopeGroup>();
  for (const location of locations) {
    const key = `${location.from}|${location.to}|${location.status}`;
    const existing = groups.get(key);
    if (existing) {
      existing.locationNames.push(location.name);
    } else {
      groups.set(key, {
        key,
        label: `${formatReportDateRange(location.from, location.to)}${STATUS_SUFFIX[location.status]}`,
        status: location.status,
        locationNames: [location.name],
      });
    }
  }
  return [...groups.values()];
}

/** Said whenever locations resolve to different local dates. */
export const LOCAL_CALENDAR_NOTE = 'Dates follow each location’s local calendar.';

/** The one custom range every location shares, to prefill the custom-range form; otherwise null. */
export function sharedLocalRange(
  locations: readonly ResolvedReportLocation[] | null | undefined,
): { from: LocalDate; to: LocalDate } | null {
  if (!locations || locations.length === 0) return null;
  const [first] = locations;
  return locations.every((l) => l.from === first.from && l.to === first.to)
    ? { from: first.from, to: first.to }
    : null;
}
