/**
 * Local-date period arithmetic for payroll.
 *
 * Pay-period boundaries are LOCAL dates ('YYYY-MM-DD', end EXCLUSIVE) in the
 * business's payroll timezone. Source events (`booking.visits.completed_at`,
 * `rota.shifts.scheduled_start_at`, ...) are timestamptz — attributing one to a
 * period must convert through the timezone first. A Tuesday 00:00
 * Europe/London boundary is 23:00 UTC Monday for half the year, and every
 * pre-existing window resolver in this repo is UTC-only, so payroll has its
 * own (see docs/V1.1/3-2 plan.md W3.2-F).
 *
 * Pure functions only — no clock reads. Callers pass "today" explicitly.
 *
 * Reporting (apps/api/src/reports) resolves per-location report windows with
 * the same helpers, so there is exactly one DST-correct day boundary in the API.
 */

// One strict calendar-date check for payroll, reporting and the browser.
export { isLocalDate } from '@sheer/domain';

/** 'YYYY-MM-DD' -> ms of that date at 00:00 UTC (calendar arithmetic space). */
function dateToUtcMidnight(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcMidnightToDate(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const da = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${da}`;
}

export function addDays(date: string, days: number): string {
  return utcMidnightToDate(dateToUtcMidnight(date) + days * 86_400_000);
}

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const daysInTarget = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, daysInTarget));
  return utcMidnightToDate(target.getTime());
}

/** date-only comparison; works because the format is lexicographic. */
export function isBefore(a: string, b: string): boolean {
  return a < b;
}

/** 0 = Sunday .. 6 = Saturday, matching payroll_settings.week_start_day. */
export function dayOfWeek(date: string): number {
  return new Date(dateToUtcMidnight(date)).getUTCDay();
}

/** The most recent date on/before `date` whose weekday is `weekStartDay`. */
export function alignToWeekStart(date: string, weekStartDay: number): string {
  const diff = (dayOfWeek(date) - weekStartDay + 7) % 7;
  return addDays(date, -diff);
}

export interface PeriodWindow {
  /** Local date, inclusive. */
  periodStart: string;
  /** Local date, EXCLUSIVE. */
  periodEnd: string;
}

/**
 * Resolve the period window containing `referenceDate` for a frequency.
 * `custom` has no derivable window — callers must pass explicit dates instead.
 */
export function resolvePeriodWindow(
  frequency: 'weekly' | 'fortnightly' | 'four_weekly' | 'monthly',
  weekStartDay: number,
  referenceDate: string,
): PeriodWindow {
  if (frequency === 'monthly') {
    const [y, m] = referenceDate.split('-').map(Number);
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    return { periodStart: start, periodEnd: addMonths(start, 1) };
  }
  const spanDays = frequency === 'weekly' ? 7 : frequency === 'fortnightly' ? 14 : 28;
  const start = alignToWeekStart(referenceDate, weekStartDay);
  return { periodStart: start, periodEnd: addDays(start, spanDays) };
}

/**
 * Phase-locked window for span-based cadences (fortnightly/four-weekly): the
 * window containing `referenceDate` on the grid anchored at `anchorStart`.
 * Keeps consecutive periods tiling exactly regardless of when payroll is run.
 */
export function resolveAnchoredWindow(
  spanDays: number,
  anchorStart: string,
  referenceDate: string,
): PeriodWindow {
  const anchorMs = dateToUtcMidnight(anchorStart);
  const refMs = dateToUtcMidnight(referenceDate);
  const diffDays = Math.floor((refMs - anchorMs) / 86_400_000);
  const offset = Math.floor(diffDays / spanDays) * spanDays;
  const periodStart = addDays(anchorStart, offset);
  return { periodStart, periodEnd: addDays(periodStart, spanDays) };
}

// ---------------------------------------------------------------------------
// Timezone conversion (DST-safe, no dependency)
// ---------------------------------------------------------------------------

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let dtf = dtfCache.get(timeZone);
  if (!dtf) {
    dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    dtfCache.set(timeZone, dtf);
  }
  return dtf;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClockAt(timeZone: string, utcMs: number): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(utcMs));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0');
  // en-CA hour '24' can appear for midnight in some ICU versions; normalise.
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of `timeZone` from UTC at the instant `utcMs`, in ms. */
function tzOffsetMs(timeZone: string, utcMs: number): number {
  const wc = wallClockAt(timeZone, utcMs);
  const asUtc = Date.UTC(wc.year, wc.month - 1, wc.day, wc.hour, wc.minute, wc.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

function wallClockDate(wc: WallClock): string {
  return `${wc.year}-${String(wc.month).padStart(2, '0')}-${String(wc.day).padStart(2, '0')}`;
}

/** Every UTC offset in force within this span of a date's UTC midnight. */
const TRANSITION_PROBE_MS = 40 * 3_600_000;
/** An offset stays in force for weeks, never under an hour, so hourly samples see every one. */
const TRANSITION_SAMPLE_MS = 3_600_000;

/**
 * The first UTC instant whose local date in `timeZone` is `date`.
 *
 * Almost every date has one offset all day: its start is local midnight at that
 * offset (the fast path). Around a clock change the start is the EARLIEST
 * instant that reads `date` 00:00:00 on the local clock — which also covers a
 * clock falling back across midnight, where midnight happens twice and the day
 * begins at the first. Where midnight never happens (Santiago, Havana and the
 * Azores jump from 23:59:59 to 01:00), the day begins at the first instant whose
 * local date is `date`. A date the zone skipped entirely (Pacific/Apia,
 * 2011-12-30) gets an empty window: its start equals the next day's start.
 */
export function localDateStartUtc(timeZone: string, date: string): Date {
  const guess = dateToUtcMidnight(date);
  const earliestProbe = guess - TRANSITION_PROBE_MS;
  const latestProbe = guess + TRANSITION_PROBE_MS;
  const offsetBefore = tzOffsetMs(timeZone, earliestProbe);
  const offsetAfter = tzOffsetMs(timeZone, latestProbe);
  if (offsetBefore === offsetAfter) {
    return new Date(guess - offsetBefore);
  }

  const offsets = new Set<number>([offsetBefore, offsetAfter]);
  for (let probe = earliestProbe; probe <= latestProbe; probe += TRANSITION_SAMPLE_MS) {
    offsets.add(tzOffsetMs(timeZone, probe));
  }
  let firstMidnight: number | null = null;
  for (const offset of offsets) {
    const candidate = guess - offset;
    const wc = wallClockAt(timeZone, candidate);
    const isMidnightOfDate =
      wc.hour === 0 && wc.minute === 0 && wc.second === 0 && wallClockDate(wc) === date;
    if (isMidnightOfDate && (firstMidnight === null || candidate < firstMidnight)) {
      firstMidnight = candidate;
    }
  }
  if (firstMidnight !== null) {
    return new Date(firstMidnight);
  }

  // Local midnight does not occur on this date. The earliest probe reads an
  // earlier date and the latest a later one (no offset exceeds ±14h), so search
  // to the second for the first instant that reads `date` or later.
  let before = earliestProbe;
  let atOrAfter = latestProbe;
  while (atOrAfter - before > 1000) {
    const middle = Math.floor((before + atOrAfter) / 2000) * 1000;
    if (wallClockDate(wallClockAt(timeZone, middle)) >= date) {
      atOrAfter = middle;
    } else {
      before = middle;
    }
  }
  return new Date(atOrAfter);
}

/** The local calendar date ('YYYY-MM-DD') of a UTC instant in `timeZone`. */
export function utcToLocalDate(timeZone: string, isoOrMs: string | number): string {
  const utcMs = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  return wallClockDate(wallClockAt(timeZone, utcMs));
}

/**
 * True when `timeZone` is an IANA zone this runtime can convert. Never throws:
 * a location saved with a typo must be reported, not crash a request.
 */
export function isSupportedTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== 'string' || timeZone.trim() === '') return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * UTC query window [fromUtc, toUtc) covering the local-date period
 * [periodStart, periodEnd) in `timeZone` — for filtering timestamptz columns.
 */
export function periodUtcWindow(
  timeZone: string,
  periodStart: string,
  periodEnd: string,
): { fromUtc: string; toUtc: string } {
  return {
    fromUtc: localDateStartUtc(timeZone, periodStart).toISOString(),
    toUtc: localDateStartUtc(timeZone, periodEnd).toISOString(),
  };
}
