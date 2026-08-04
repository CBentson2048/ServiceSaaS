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
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isLocalDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

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

/**
 * The UTC instant at which local date `date` begins in `timeZone`.
 * Two-pass offset refinement handles DST transitions (a 23:00/01:00 UTC
 * midnight either side of a BST/GMT switch resolves correctly).
 */
export function localDateStartUtc(timeZone: string, date: string): Date {
  const guess = dateToUtcMidnight(date);
  const offset1 = tzOffsetMs(timeZone, guess);
  const candidate = guess - offset1;
  const offset2 = tzOffsetMs(timeZone, candidate);
  return new Date(guess - offset2);
}

/** The local calendar date ('YYYY-MM-DD') of a UTC instant in `timeZone`. */
export function utcToLocalDate(timeZone: string, isoOrMs: string | number): string {
  const utcMs = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  const wc = wallClockAt(timeZone, utcMs);
  return `${wc.year}-${String(wc.month).padStart(2, '0')}-${String(wc.day).padStart(2, '0')}`;
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
