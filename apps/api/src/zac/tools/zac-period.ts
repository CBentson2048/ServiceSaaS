/**
 * PERIOD RESOLUTION for ZAC's reporting tools.
 *
 * The defect this closes: every Expanded Intelligence tool carried a hardcoded
 * window (7 days for appointments, 30 for services and retail) and the question
 * text was never consulted. "How many appointments did we take last month?"
 * was answered on the last SEVEN DAYS, under a sentence that said so — honest
 * about what it did, but not what was asked.
 *
 * BOUNDARY CONVENTIONS ARE COPIED, NOT INVENTED. `resolveKpiWindow` in
 * kpi.calc.ts is the canonical reporting window for QLOOQO, and this module
 * matches it exactly: UTC day boundaries, weeks starting MONDAY, calendar
 * months, and an EXCLUSIVE end. A ZAC figure and the matching dashboard page
 * must cover the same seconds, or the two disagree and the user cannot tell
 * which is wrong.
 *
 * Deterministic on purpose. The router decides WHICH tool runs; the window it
 * runs over is read from the question by these rules, never proposed by a
 * model — a model that quietly widens a window changes the number it reports.
 */

/** How the window was chosen. Closed enum: safe for telemetry and the inspector. */
export type ZacPeriodKind =
  | 'default'
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'last_week'
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'last_quarter'
  | 'this_year'
  | 'last_year'
  | 'year_to_date'
  | 'last_n_days'
  | 'named_month'
  | 'all_time';

export interface ZacResolvedPeriod {
  /** Inclusive start, ISO. */
  fromIso: string;
  /** EXCLUSIVE end, ISO — matches resolveKpiWindow. */
  toIso: string;
  /**
   * How the window reads in an answer: "last month", "the last 30 days",
   * "August 2026". Always phrased to drop straight into a sentence after
   * "over" or "in".
   */
  label: string;
  kind: ZacPeriodKind;
  /**
   * True when the USER asked for this window. False when it is the tool's
   * default. Tools say which they used, so a default is never mistaken for a
   * request that was honoured.
   */
  explicit: boolean;
  /**
   * Set when the question named a period that could not be served as asked —
   * a future window, or one older than the cap. The tool states this instead
   * of silently substituting a different window.
   */
  unsupportedReason?: string;
}

const MS_PER_DAY = 86_400_000;

/**
 * The furthest back "all time" will actually reach. An unbounded scan is a
 * production incident waiting for the first busy salon, and a five-year window
 * is beyond any salon's useful trading history in this product. Stated in the
 * label so it is never passed off as literally everything.
 */
const MAX_LOOKBACK_YEARS = 5;

/** The longest explicit "last N <unit>" that will be honoured. */
const MAX_LOOKBACK_DAYS = MAX_LOOKBACK_YEARS * 366;

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
] as const;

function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Monday-anchored, matching resolveKpiWindow's `mondayUtc`. */
function mondayUtc(ms: number): number {
  const start = startOfUtcDay(ms);
  const dow = new Date(start).getUTCDay(); // 0=Sun..6=Sat
  return start - ((dow + 6) % 7) * MS_PER_DAY;
}

function monthStart(ms: number, offsetMonths = 0): number {
  const d = new Date(startOfUtcDay(ms));
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offsetMonths, 1);
}

function quarterStart(ms: number, offsetQuarters = 0): number {
  const d = new Date(startOfUtcDay(ms));
  const q = Math.floor(d.getUTCMonth() / 3) + offsetQuarters;
  return Date.UTC(d.getUTCFullYear(), q * 3, 1);
}

function yearStart(ms: number, offsetYears = 0): number {
  return Date.UTC(new Date(startOfUtcDay(ms)).getUTCFullYear() + offsetYears, 0, 1);
}

function window(
  fromMs: number,
  toMs: number,
  label: string,
  kind: ZacPeriodKind,
): ZacResolvedPeriod {
  return {
    fromIso: new Date(fromMs).toISOString(),
    toIso: new Date(toMs).toISOString(),
    label,
    kind,
    explicit: true,
  };
}

/** The tool's own window, used when the question named none. */
export function defaultPeriod(days: number, nowMs: number): ZacResolvedPeriod {
  const toMs = nowMs;
  return {
    fromIso: new Date(toMs - days * MS_PER_DAY).toISOString(),
    toIso: new Date(toMs).toISOString(),
    label: `the last ${days} days`,
    kind: 'default',
    explicit: false,
  };
}

/**
 * Read a reporting window out of the question.
 *
 * Returns the tool's default when the question names no period, so a caller
 * always receives a usable window; `explicit` says which happened.
 */
export function parseZacPeriod(
  question: string,
  defaultDays: number,
  nowMs: number = Date.now(),
): ZacResolvedPeriod {
  const q = question.toLowerCase();
  const fallback = defaultPeriod(defaultDays, nowMs);

  // --- Everything on record ------------------------------------------------
  if (
    /\b(all[- ]?time|of all time|since (we|i) (started|opened|began)|ever since|in total|overall history|entire history|whole history|since the beginning|all the data|everything (you|we) have)\b/.test(
      q,
    ) ||
    /\bever\b(?!y)/.test(q)
  ) {
    const fromMs = yearStart(nowMs, -MAX_LOOKBACK_YEARS);
    return window(
      fromMs,
      nowMs,
      `everything on record (back to ${new Date(fromMs).getUTCFullYear()})`,
      'all_time',
    );
  }

  // --- Explicit "last/past N units" ---------------------------------------
  // Before the bare this/last rules, so "last 3 months" is not read as "last
  // month". The unit is captured, so days, weeks, months and years all work.
  const nMatch = q.match(
    /\b(?:last|past|previous|prior)\s+(\d{1,3})\s*(day|days|week|weeks|month|months|year|years)\b/,
  );
  if (nMatch) {
    const n = Number(nMatch[1]);
    const unit = nMatch[2] as string;
    if (n >= 1) {
      const toMs = nowMs;
      let fromMs: number;
      let label: string;
      if (unit.startsWith('day')) {
        fromMs = toMs - n * MS_PER_DAY;
        label = `the last ${n} ${n === 1 ? 'day' : 'days'}`;
      } else if (unit.startsWith('week')) {
        fromMs = toMs - n * 7 * MS_PER_DAY;
        label = `the last ${n} ${n === 1 ? 'week' : 'weeks'}`;
      } else if (unit.startsWith('month')) {
        fromMs = monthStart(nowMs, -n);
        label = `the last ${n} ${n === 1 ? 'month' : 'months'}`;
      } else {
        fromMs = yearStart(nowMs, -n);
        label = `the last ${n} ${n === 1 ? 'year' : 'years'}`;
      }
      if (toMs - fromMs > MAX_LOOKBACK_DAYS * MS_PER_DAY) {
        return {
          ...fallback,
          unsupportedReason: `I can look back at most ${MAX_LOOKBACK_YEARS} years, so I used ${fallback.label} instead.`,
        };
      }
      return window(fromMs, toMs, label, 'last_n_days');
    }
  }

  // --- Named calendar month, optionally with a year ------------------------
  const monthMatch = q.match(
    new RegExp(`\\b(?:in|during|for)?\\s*(${MONTHS.join('|')})\\b(?:\\s+(\\d{4}))?`),
  );
  if (monthMatch) {
    const monthIndex = MONTHS.indexOf(monthMatch[1] as (typeof MONTHS)[number]);
    const nowYear = new Date(nowMs).getUTCFullYear();
    // A bare month name means the most recent one that has already happened —
    // asking about "August" in September means this year, not next.
    let year = monthMatch[2] ? Number(monthMatch[2]) : nowYear;
    if (!monthMatch[2] && Date.UTC(year, monthIndex, 1) > nowMs) year -= 1;
    const fromMs = Date.UTC(year, monthIndex, 1);
    const toMs = Date.UTC(year, monthIndex + 1, 1);
    if (fromMs > nowMs) {
      return {
        ...fallback,
        unsupportedReason: `${monthMatch[1]} ${year} is in the future, so I used ${fallback.label} instead.`,
      };
    }
    const name = monthMatch[1]!.charAt(0).toUpperCase() + monthMatch[1]!.slice(1);
    return window(fromMs, Math.min(toMs, nowMs), `${name} ${year}`, 'named_month');
  }

  // --- Named relative periods ---------------------------------------------
  if (/\byesterday\b/.test(q)) {
    const start = startOfUtcDay(nowMs) - MS_PER_DAY;
    return window(start, start + MS_PER_DAY, 'yesterday', 'yesterday');
  }
  if (/\b(today|so far today)\b/.test(q)) {
    const start = startOfUtcDay(nowMs);
    return window(start, start + MS_PER_DAY, 'today', 'today');
  }
  if (/\blast\s+week\b/.test(q)) {
    const start = mondayUtc(nowMs) - 7 * MS_PER_DAY;
    return window(start, start + 7 * MS_PER_DAY, 'last week', 'last_week');
  }
  if (/\b(this|current)\s+week\b|\bthis week'?s\b/.test(q)) {
    return window(mondayUtc(nowMs), nowMs, 'this week so far', 'this_week');
  }
  if (/\blast\s+month\b/.test(q)) {
    return window(monthStart(nowMs, -1), monthStart(nowMs), 'last month', 'last_month');
  }
  if (/\b(this|current)\s+month\b|\bthis month'?s\b|\bmonth to date\b|\bmtd\b/.test(q)) {
    return window(monthStart(nowMs), nowMs, 'this month so far', 'this_month');
  }
  if (/\blast\s+quarter\b/.test(q)) {
    return window(quarterStart(nowMs, -1), quarterStart(nowMs), 'last quarter', 'last_quarter');
  }
  if (/\b(this|current)\s+quarter\b/.test(q)) {
    return window(quarterStart(nowMs), nowMs, 'this quarter so far', 'this_quarter');
  }
  if (/\blast\s+year\b/.test(q)) {
    return window(yearStart(nowMs, -1), yearStart(nowMs), 'last year', 'last_year');
  }
  if (/\b(year to date|ytd)\b/.test(q)) {
    return window(yearStart(nowMs), nowMs, 'the year to date', 'year_to_date');
  }
  if (/\b(this|current)\s+year\b/.test(q)) {
    return window(yearStart(nowMs), nowMs, 'this year so far', 'this_year');
  }

  // --- Bare "week"/"month", as the pre-existing KPI parser accepted --------
  if (/\bthe week\b|\bweekly\b|\bpast week\b/.test(q)) {
    return window(mondayUtc(nowMs), nowMs, 'this week so far', 'this_week');
  }

  return fallback;
}

/**
 * Read the window out of a tool's dispatch input, falling back to the tool's
 * own default. Tools take their period this way so the parsing lives in ONE
 * place and a tool called directly (tests, the planner) still behaves.
 */
export function periodFromInput(
  input: Record<string, unknown>,
  defaultDays: number,
  nowMs: number = Date.now(),
): ZacResolvedPeriod {
  const candidate = input['period'];
  if (
    candidate !== null &&
    typeof candidate === 'object' &&
    typeof (candidate as ZacResolvedPeriod).fromIso === 'string' &&
    typeof (candidate as ZacResolvedPeriod).toIso === 'string' &&
    typeof (candidate as ZacResolvedPeriod).label === 'string'
  ) {
    return candidate as ZacResolvedPeriod;
  }
  return defaultPeriod(defaultDays, nowMs);
}

/** Sentence-start form of a period label: "last month" -> "Last month". */
export function capitalise(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}
