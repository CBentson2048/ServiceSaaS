/**
 * Per-location report windows (V1.1 Week 8 Ticket A). Pure: the caller passes
 * the request instant.
 *
 * There is no shared report date. A relative preset resolves at EACH location
 * from that location's own IANA timezone — at an instant where London is 13 Sep
 * and Tokyo is 14 Sep, "today" is London 13 Sep and Tokyo 14 Sep. A custom range
 * applies the user's local dates to every location as given, and each location
 * converts them to its own half-open UTC interval. Nothing builds a union
 * ("envelope") of the windows: every fact must be read inside its own location's
 * window. docs/V1.1/week-8-ticket-a-foundation.md §3.
 */
import type {
  LocalDate,
  ReportFilter,
  ReportLocalStatus,
  WeekStartDay,
} from '@sheer/domain';
import { WEEK_PRESETS } from '@sheer/domain';
import {
  addDays,
  addMonths,
  alignToWeekStart,
  localDateStartUtc,
  utcToLocalDate,
} from '../payroll/period-dates';

export interface ReportLocalRange {
  /** Inclusive. */
  from: LocalDate;
  /** Inclusive. */
  to: LocalDate;
}

export interface ReportLocationWindow extends ReportLocalRange {
  locationId: string;
  timezone: string;
  /** The location's local date at the request instant. */
  localToday: LocalDate;
  status: ReportLocalStatus;
  /** First instant of `from` at the location, ISO UTC. */
  fromUtc: string;
  /** First instant of the day after `to` at the location, ISO UTC (exclusive). */
  toUtcExclusive: string;
}

export function isWeekPreset(preset: ReportFilter['preset']): boolean {
  return WEEK_PRESETS.includes(preset);
}

/**
 * The inclusive local range a filter means at a location whose local date is
 * `localToday`. Week presets need the business's week start; they throw without
 * one rather than assume Monday — the caller reports the missing configuration.
 */
export function resolveLocalRange(
  filter: Pick<ReportFilter, 'preset' | 'from' | 'to'>,
  localToday: LocalDate,
  weekStartDay: WeekStartDay | null,
): ReportLocalRange {
  const firstOfMonth = `${localToday.slice(0, 8)}01`;
  switch (filter.preset) {
    case 'today':
      return { from: localToday, to: localToday };
    case 'yesterday': {
      const yesterday = addDays(localToday, -1);
      return { from: yesterday, to: yesterday };
    }
    case 'this_week':
    case 'last_week': {
      if (weekStartDay === null) {
        throw new Error(`The ${filter.preset} preset needs the business week start`);
      }
      const weekStart = alignToWeekStart(localToday, weekStartDay);
      return filter.preset === 'this_week'
        ? { from: weekStart, to: localToday }
        : { from: addDays(weekStart, -7), to: addDays(weekStart, -1) };
    }
    case 'this_month':
      return { from: firstOfMonth, to: localToday };
    case 'last_month':
      // Built from the first of the month: addMonths clamps day-of-month, so
      // stepping back from e.g. 31 March would land on 28 February.
      return { from: addMonths(firstOfMonth, -1), to: addDays(firstOfMonth, -1) };
    case 'custom':
      if (filter.from === undefined || filter.to === undefined) {
        throw new Error('A custom range needs both dates');
      }
      return { from: filter.from, to: filter.to };
  }
}

/** Where a range sits against a location's today. Dates compare as strings. */
export function reportLocalStatus(range: ReportLocalRange, localToday: LocalDate): ReportLocalStatus {
  if (range.to < localToday) return 'complete';
  if (range.from > localToday) return 'not_started';
  return 'in_progress';
}

/**
 * One window per location, in the order given. Every location's timezone must
 * already have been validated by the caller.
 */
export function resolveReportWindows(
  locations: readonly { id: string; timezone: string }[],
  filter: Pick<ReportFilter, 'preset' | 'from' | 'to'>,
  asOf: Date,
  weekStartDay: WeekStartDay | null,
): ReportLocationWindow[] {
  const instant = asOf.getTime();
  return locations.map((location) => {
    const localToday = utcToLocalDate(location.timezone, instant);
    const range = resolveLocalRange(filter, localToday, weekStartDay);
    return {
      locationId: location.id,
      timezone: location.timezone,
      localToday,
      from: range.from,
      to: range.to,
      status: reportLocalStatus(range, localToday),
      fromUtc: localDateStartUtc(location.timezone, range.from).toISOString(),
      toUtcExclusive: localDateStartUtc(location.timezone, addDays(range.to, 1)).toISOString(),
    };
  });
}
