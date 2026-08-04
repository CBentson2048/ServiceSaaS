/**
 * Rota -> hour-category resolver. Pure: no I/O, no clock.
 *
 * Produces the eight payroll.hour_category_enum buckets from published rota
 * shifts, unpaid breaks, categorised book-outs and approved leave. Whether a
 * category is PAYABLE or TARGET-RAISING is decided later by the rule version's
 * `version_hour_rules` (rule data beats operational config —
 * `book_out_types.counts_as_paid_time` is deliberately NOT consulted here; the
 * two seeded sources currently disagree on both categories that matter, see
 * docs/V1.1/3-2 plan.md Q5).
 *
 * Honesty rules (principle 4):
 *  - Approved leave carries dates but NO hours and NO paid flag
 *    (`rota.leave_requests` has neither), so leave days subtract from worked
 *    time but land in `unpaid_leave` with 0 hours and an explanatory note —
 *    a documented limitation, never a guessed figure.
 *  - `additional` and `manual_adjustment` have no source table; they are
 *    emitted as 0-hour rows with notes so the statement shows the category
 *    exists and why it is empty.
 */

export type EngineHourCategory =
  | 'worked'
  | 'paid_holiday'
  | 'unpaid_leave'
  | 'sickness'
  | 'training'
  | 'authorised_absence'
  | 'additional'
  | 'manual_adjustment';

export interface HoursShiftInput {
  /** ISO timestamps (timestamptz). Only non-cancelled shifts belong here. */
  startsAtMs: number;
  endsAtMs: number;
}

export interface HoursBreakInput {
  startsAtMs: number;
  endsAtMs: number;
  isPaid: boolean;
}

export interface HoursAbsenceInput {
  startsAtMs: number;
  /** Null = open-ended; clamped to the period window. */
  endsAtMs: number | null;
  /**
   * The book-out type key ('training', 'sick_leave', 'annual_leave',
   * 'staff_meeting', 'admin', 'marketing', 'lunch', 'other') or null for
   * legacy rows, which fall back to absenceType.
   */
  bookOutKey: string | null;
  /** rota.absence_type_enum: sickness|emergency|bereavement|unauthorised|other */
  absenceType: string | null;
}

export interface HoursLeaveInput {
  /** UTC window of the approved leave, already expanded to [start, end+1d). */
  startsAtMs: number;
  endsAtMs: number;
}

export interface HoursCalcInput {
  /** UTC window of the pay period (from periodUtcWindow). */
  periodStartMs: number;
  periodEndMs: number;
  shifts: HoursShiftInput[];
  breaks: HoursBreakInput[];
  absences: HoursAbsenceInput[];
  approvedLeave: HoursLeaveInput[];
}

export interface HoursCategoryRow {
  category: EngineHourCategory;
  hours: number;
  notes: string | null;
}

interface Interval {
  start: number;
  end: number;
}

function clamp(interval: Interval, windowStart: number, windowEnd: number): Interval | null {
  const start = Math.max(interval.start, windowStart);
  const end = Math.min(interval.end, windowEnd);
  return end > start ? { start, end } : null;
}

function mergeIntervals(intervals: Interval[]): Interval[] {
  // Copy every element: merging mutates `end`, and callers share interval
  // objects between collections (absenceIntervals vs categorised).
  if (intervals.length <= 1) return intervals.map((i) => ({ ...i }));
  const sorted = intervals.map((i) => ({ ...i })).sort((a, b) => a.start - b.start);
  const merged: Interval[] = [sorted[0]];
  for (const next of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (next.start <= last.end) {
      last.end = Math.max(last.end, next.end);
    } else {
      merged.push({ ...next });
    }
  }
  return merged;
}

function subtract(base: Interval[], removals: Interval[]): Interval[] {
  let result = base.slice();
  for (const removal of mergeIntervals(removals)) {
    const next: Interval[] = [];
    for (const piece of result) {
      if (removal.end <= piece.start || removal.start >= piece.end) {
        next.push(piece);
        continue;
      }
      if (removal.start > piece.start) next.push({ start: piece.start, end: removal.start });
      if (removal.end < piece.end) next.push({ start: removal.end, end: piece.end });
    }
    result = next;
  }
  return result;
}

function intersect(a: Interval[], b: Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) {
    for (const y of mergeIntervals(b)) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return mergeIntervals(out);
}

function totalHours(intervals: Interval[]): number {
  const ms = intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
  // numeric(8,2) in pay_summary_hours — round to 2dp.
  return Math.round((ms / 3_600_000) * 100) / 100;
}

/** Book-out key -> hour category. 'lunch' reduces worked time but is no category. */
const BOOK_OUT_CATEGORY: Record<string, EngineHourCategory | null> = {
  training: 'training',
  sick_leave: 'sickness',
  annual_leave: 'paid_holiday',
  staff_meeting: 'authorised_absence',
  admin: 'authorised_absence',
  marketing: 'authorised_absence',
  other: 'authorised_absence',
  lunch: null,
};

/** Legacy absence_type -> hour category, for rows without a book-out type. */
const ABSENCE_TYPE_CATEGORY: Record<string, EngineHourCategory> = {
  sickness: 'sickness',
  emergency: 'authorised_absence',
  bereavement: 'authorised_absence',
  unauthorised: 'unpaid_leave',
  other: 'authorised_absence',
};

/**
 * Deterministic winner for time covered by book-outs of different categories.
 * Unpaid-leaning categories win so overlap can never inflate payable hours.
 */
const CATEGORY_PRECEDENCE: EngineHourCategory[] = [
  'unpaid_leave',
  'sickness',
  'authorised_absence',
  'training',
  'paid_holiday',
  'additional',
  'manual_adjustment',
];

const NO_SOURCE_NOTES: Partial<Record<EngineHourCategory, string>> = {
  additional: 'No source: additional worked hours are not captured yet.',
  manual_adjustment: 'No source: manual hour adjustments are not captured yet.',
};

export function calculateHours(input: HoursCalcInput): HoursCategoryRow[] {
  const window: Interval = { start: input.periodStartMs, end: input.periodEndMs };

  const scheduled = mergeIntervals(
    input.shifts
      .map((s) => clamp({ start: s.startsAtMs, end: s.endsAtMs }, window.start, window.end))
      .filter((i): i is Interval => i !== null),
  );

  const unpaidBreaks = input.breaks
    .filter((b) => !b.isPaid)
    .map((b) => clamp({ start: b.startsAtMs, end: b.endsAtMs }, window.start, window.end))
    .filter((i): i is Interval => i !== null);

  const leave = input.approvedLeave
    .map((l) => clamp({ start: l.startsAtMs, end: l.endsAtMs }, window.start, window.end))
    .filter((i): i is Interval => i !== null);

  const categorised = new Map<EngineHourCategory, Interval[]>();
  const absenceIntervals: Interval[] = [];
  for (const absence of input.absences) {
    const clamped = clamp(
      { start: absence.startsAtMs, end: absence.endsAtMs ?? window.end },
      window.start,
      window.end,
    );
    if (!clamped) continue;
    absenceIntervals.push(clamped);
    const category =
      absence.bookOutKey !== null
        ? absence.bookOutKey in BOOK_OUT_CATEGORY
          ? BOOK_OUT_CATEGORY[absence.bookOutKey]
          : 'authorised_absence'
        : (ABSENCE_TYPE_CATEGORY[absence.absenceType ?? 'other'] ?? 'authorised_absence');
    if (category === null) continue; // lunch: reduces worked time only
    const existing = categorised.get(category) ?? [];
    existing.push(clamped);
    categorised.set(category, existing);
  }

  // Worked = scheduled minus leave minus every absence minus unpaid breaks.
  const worked = subtract(subtract(subtract(scheduled, leave), absenceIntervals), unpaidBreaks);

  const rows = new Map<EngineHourCategory, HoursCategoryRow>();
  const put = (category: EngineHourCategory, hours: number, notes: string | null) => {
    rows.set(category, { category, hours, notes });
  };

  put('worked', totalHours(worked), null);

  // A categorised absence only earns hours where it displaced a scheduled
  // shift — an all-day book-out on a day off is not paid or counted time.
  // Each scheduled moment is creditable to AT MOST ONE category (`claimed`
  // tracking): overlapping book-outs of different categories must not turn an
  // 8h shift into 12 payable hours. Iteration follows CATEGORY_PRECEDENCE so
  // the winning category for overlapped time is deterministic, not Map order.
  // Unpaid breaks are subtracted here too — a break is unpaid regardless of
  // which category displaced the surrounding time.
  let claimed: Interval[] = [];
  for (const category of CATEGORY_PRECEDENCE) {
    const intervals = categorised.get(category);
    if (!intervals || intervals.length === 0) continue;
    const displacing = subtract(
      subtract(intersect(mergeIntervals(intervals), scheduled), unpaidBreaks),
      claimed,
    );
    const hours = totalHours(displacing);
    claimed = mergeIntervals([...claimed, ...displacing]);
    const existing = rows.get(category);
    put(category, (existing?.hours ?? 0) + hours, existing?.notes ?? null);
  }

  // Approved leave: dates only, no hours, no paid/unpaid flag. Deliberately
  // reported as unpaid_leave with the displaced scheduled hours and a note —
  // paid holiday CANNOT be derived from leave requests (documented limitation;
  // paid holiday only arises from 'annual_leave' book-outs).
  const leaveDisplacing = intersect(leave, scheduled);
  const leaveHours = totalHours(
    subtract(subtract(leaveDisplacing, absenceIntervals), unpaidBreaks),
  );
  if (leave.length > 0) {
    const existing = rows.get('unpaid_leave');
    put(
      'unpaid_leave',
      (existing?.hours ?? 0) + leaveHours,
      'Approved leave carries no paid/unpaid flag; treated as unpaid this period (known limitation).',
    );
  }

  const ALL_CATEGORIES: EngineHourCategory[] = [
    'worked',
    'paid_holiday',
    'unpaid_leave',
    'sickness',
    'training',
    'authorised_absence',
    'additional',
    'manual_adjustment',
  ];
  return ALL_CATEGORIES.map(
    (category) =>
      rows.get(category) ?? {
        category,
        hours: 0,
        notes: NO_SOURCE_NOTES[category] ?? null,
      },
  );
}
