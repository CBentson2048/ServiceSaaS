/**
 * Operational & Client Intelligence Signals (QLOOQO V1.1, Wrike 4507283793).
 *
 * FOUR deterministic signals, four pure calculators, one vocabulary:
 *
 *   CLIENT_SPEND_TREND    is this client's average visit value moving?
 *   CLIENT_NO_SHOW_RISK   does this client have a missed-appointment pattern?
 *   BACK_TO_BACK_COLOUR   are two colour appointments stacked on one stylist?
 *   SLOT_GAP              is there genuinely bookable dead time in a shift?
 *
 * Everything here is PURE: no clock reads, no I/O, no model of any kind. The
 * caller supplies "today", the salon timezone and the loaded evidence. Same data
 * plus same configuration always gives the same answer — which is the whole
 * point of the ticket, and why money is integer pence and time is integer
 * milliseconds throughout.
 *
 * These signals INFORM. Nothing here blocks a booking, demands a deposit, hides
 * availability or moves an appointment; the calculators cannot, because they
 * return values and have no side effects at all.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES EACH SIGNAL HONEST (read before changing a rule)
 * ---------------------------------------------------------------------------
 * - Spend trend reports AVERAGE VALUE PER VISIT and visit counts SEPARATELY, so
 *   "they come less often" is never mislabelled "they spend less per visit".
 * - No-show risk uses attendance facts only. It never touches age, postcode,
 *   notes, or anything a person is rather than something they did. It is a
 *   behavioural flag, never a probability — there is no validated model behind
 *   it and it must never be phrased as one.
 * - Colour is identified STRUCTURALLY from the service billing category, never
 *   from a service name containing "colour".
 * - A slot gap is computed against the stylist's real shift minus every canonical
 *   busy source, so a lunch break between two appointments is not a gap.
 */

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

export const IntelligenceSignalType = {
  ClientSpendTrend: 'client_spend_trend',
  ClientNoShowRisk: 'client_no_show_risk',
  BackToBackColour: 'back_to_back_colour',
  SlotGap: 'slot_gap',
} as const;

export type IntelligenceSignalType =
  (typeof IntelligenceSignalType)[keyof typeof IntelligenceSignalType];

/**
 * Shared severity. Deliberately three plain levels and deliberately NOT combined
 * across signals into one opaque score — the four measure different domains and
 * adding them would produce a number nobody could explain.
 */
export type SignalSeverity = 'info' | 'attention' | 'high';

// ===========================================================================
// 1. SPEND TREND
// ===========================================================================

/**
 * `insufficient_data` is a first-class answer, not a failure. A client with
 * three lifetime visits has no trend, and inventing one is how a stylist learns
 * to distrust the whole feature.
 */
export type SpendTrendStatus = 'rising' | 'stable' | 'falling' | 'insufficient_data';

export type SpendTrendInsufficientReason =
  | 'not_enough_completed_visits'
  /** The earlier window billed nothing, so a percentage change is undefined. */
  | 'no_previous_spend';

/** One settled visit's contribution to spend. */
export interface ClientVisitSpend {
  /** Salon-local date of the visit, `YYYY-MM-DD`. Ordering key. */
  visitDate: string;
  /**
   * What the till actually collected for that visit, in PENCE.
   * `billing.bills.gross_cents` for a bill whose status is `paid`. Voided bills
   * are excluded by the caller and never reach here.
   */
  grossCents: number;
}

export interface SpendTrendThresholds {
  /**
   * Visits per comparison window. The latest N are compared with the N before.
   * A fixed VISIT count rather than a fixed date window: salon visit cadence
   * varies from 4 to 12 weeks, so equal-length calendar periods would compare a
   * client's three-visit quarter against someone else's one-visit quarter and
   * call the difference a trend.
   */
  windowVisits: number;
  /**
   * Percentage change in average visit value at or beyond which the trend is
   * rising/falling. Below it, STABLE.
   */
  materialityPercent: number;
}

export interface SpendTrendEvidence {
  recentAverageCents: number;
  previousAverageCents: number;
  /** Signed whole percent. Positive = rising. */
  changePercent: number;
  recentVisitCount: number;
  previousVisitCount: number;
  recentTotalCents: number;
  previousTotalCents: number;
  /** Salon-local dates bounding each window, for "compared with" text. */
  recentFromDate: string;
  recentToDate: string;
  previousFromDate: string;
  previousToDate: string;
}

export interface SpendTrendSignal {
  type: typeof IntelligenceSignalType.ClientSpendTrend;
  status: SpendTrendStatus;
  severity: SignalSeverity;
  /** Neutral, operational wording. Never a judgement about the client. */
  summary: string;
  insufficientReason?: SpendTrendInsufficientReason;
  evidence?: SpendTrendEvidence;
  thresholds: SpendTrendThresholds;
}

/**
 * Compare the client's latest N settled visits with the N before them.
 *
 * THE METRIC IS AVERAGE VALUE PER VISIT, not total period spend. Those are
 * different facts and conflating them is the classic error this ticket calls
 * out: a client who came four times at £100 and now comes twice at £100 has not
 * reduced their spend per visit at all — their frequency changed. Both numbers
 * are returned so the UI can say which actually moved.
 *
 * `visits` must be ordered oldest-first and contain only SETTLED visits.
 */
export function assessSpendTrend(
  visits: readonly ClientVisitSpend[],
  thresholds: SpendTrendThresholds,
): SpendTrendSignal {
  const n = Math.max(1, Math.trunc(thresholds.windowVisits));
  const required = n * 2;

  if (visits.length < required) {
    return {
      type: IntelligenceSignalType.ClientSpendTrend,
      status: 'insufficient_data',
      severity: 'info',
      summary: `Not enough visit history yet (${visits.length} of ${required} settled visits).`,
      insufficientReason: 'not_enough_completed_visits',
      thresholds,
    };
  }

  const recent = visits.slice(-n);
  const previous = visits.slice(-required, -n);

  const recentTotal = sumPence(recent);
  const previousTotal = sumPence(previous);
  // Integer division with half-up rounding: averages stay in whole pence and
  // never acquire a floating-point tail.
  const recentAverage = divideRound(recentTotal, recent.length);
  const previousAverage = divideRound(previousTotal, previous.length);

  const evidence: SpendTrendEvidence = {
    recentAverageCents: recentAverage,
    previousAverageCents: previousAverage,
    changePercent: 0,
    recentVisitCount: recent.length,
    previousVisitCount: previous.length,
    recentTotalCents: recentTotal,
    previousTotalCents: previousTotal,
    recentFromDate: recent[0].visitDate,
    recentToDate: recent[recent.length - 1].visitDate,
    previousFromDate: previous[0].visitDate,
    previousToDate: previous[previous.length - 1].visitDate,
  };

  // A zero baseline makes a percentage change undefined — dividing by it would
  // produce Infinity and a nonsense "+∞% rising". Reported honestly instead.
  if (previousAverage === 0) {
    return {
      type: IntelligenceSignalType.ClientSpendTrend,
      status: 'insufficient_data',
      severity: 'info',
      summary: 'No settled spend in the earlier visits, so there is nothing to compare against.',
      insufficientReason: 'no_previous_spend',
      evidence,
      thresholds,
    };
  }

  // DISPLAY value only, rounded half away from zero so -15.5% and +15.5% read
  // symmetrically.
  evidence.changePercent = signedDivideRound((recentAverage - previousAverage) * 100, previousAverage);

  // The COMPARISON is exact integer arithmetic on the unrounded change, never on
  // the displayed percent:
  //
  //     delta/previous >= materiality/100   <=>   delta*100 >= materiality*previous
  //
  // Cross-multiplying keeps everything in integers, so there is no division, no
  // floating point and no rounding anywhere in the decision. It also fixes a real
  // trap: comparing the ROUNDED percent would make a -14.5% change round to -15%
  // and trip a 15% threshold it never actually reached.
  const materiality = Math.abs(Math.trunc(thresholds.materialityPercent));
  const delta = recentAverage - previousAverage;
  const scaledThreshold = materiality * previousAverage;
  const status: SpendTrendStatus =
    delta * 100 >= scaledThreshold
      ? 'rising'
      : delta * 100 <= -scaledThreshold
        ? 'falling'
        : 'stable';

  return {
    type: IntelligenceSignalType.ClientSpendTrend,
    status,
    // Falling spend is worth a stylist's attention; rising and stable are not a
    // problem to be flagged. Nothing here is ever `high` — a spend trend is
    // never an operational emergency.
    severity: status === 'falling' ? 'attention' : 'info',
    summary:
      status === 'stable'
        ? `Recent spend is steady (${formatPence(recentAverage)} average per visit).`
        : status === 'rising'
          ? `Recent spend trend is higher — ${formatPence(recentAverage)} average per visit, up from ${formatPence(previousAverage)}.`
          : `Recent spend trend is lower — ${formatPence(recentAverage)} average per visit, down from ${formatPence(previousAverage)}.`,
    evidence,
    thresholds,
  };
}

// ===========================================================================
// 2. NO-SHOW RISK
// ===========================================================================

/**
 * A behavioural flag, never a probability. There is no validated model behind
 * this and the wording must never imply one — "78% likely to no-show" would be a
 * fabrication.
 */
export type NoShowRiskLevel = 'insufficient_data' | 'low' | 'medium' | 'high';

/**
 * One appointment's attendance outcome, as the platform actually records it.
 *
 * These map directly onto `booking.appointment_status_enum`:
 *   attended         -> `awaiting_payment` / `paid` (the client came)
 *   no_show          -> `no_show`
 *   late_cancelled   -> `cancelled` with `cancelled_at` after the location's
 *                       refund cutoff (`scheduled_start_at` minus
 *                       `core.location_settings.cancellation_notice_hours`)
 *   cancelled        -> `cancelled` inside the notice window — a courtesy, and
 *                       explicitly NOT evidence of anything
 *
 * READ `late_cancelled` PRECISELY. It means "cancelled inside the salon's
 * CURRENT notice window", not "was late under the policy in force that day".
 * QLOOQO stores no durable lateness marker: `cancellation_notice_hours` is
 * mutable (PATCH /owner/cancellation-policy) and is not versioned or snapshotted
 * onto the appointment, so an owner who widens the window reclassifies past
 * cancellations. That is deterministic under this ticket's own rule — same data
 * plus same CONFIGURATION gives the same answer — but it is a re-evaluation, not
 * a historical record, and the UI must not claim otherwise. A durable marker
 * written at cancel time is the fix, and it is recorded as remaining work rather
 * than faked here.
 *
 * `pending`, `accepted`, `checked_in` and `rejected` are not outcomes: the
 * appointment either has not happened yet or the salon itself declined it.
 */
export type AttendanceOutcome = 'attended' | 'no_show' | 'late_cancelled' | 'cancelled';

export interface AttendanceEvent {
  /** Salon-local date the appointment was scheduled for, `YYYY-MM-DD`. */
  scheduledDate: string;
  outcome: AttendanceOutcome;
}

export interface NoShowRiskThresholds {
  /**
   * How far back attendance is considered, in days. A no-show five years ago is
   * not the same fact as one last month, and an unbounded history would let an
   * old pattern haunt a client who has attended reliably ever since.
   */
  lookbackDays: number;
  /**
   * Relevant appointments (attended + missed) required before a RATE is trusted.
   * Below it, one miss out of one appointment is not "a 100% no-show client".
   */
  minimumRelevantAppointments: number;
  /** No-show rate, whole percent, at or above which risk is `medium`. */
  mediumRatePercent: number;
  /** No-show rate, whole percent, at or above which risk is `high`. */
  highRatePercent: number;
  /**
   * No-show count that reaches `high` on its own, regardless of rate. Three
   * misses is a pattern even for a client who attends often.
   */
  highNoShowCount: number;
  /**
   * Late cancellations that, on their own, justify `medium`. Counted separately
   * from no-shows and never treated as equivalent: the client did tell the
   * salon, just too late to refill the slot.
   */
  mediumLateCancellationCount: number;
}

export interface NoShowRiskEvidence {
  lookbackDays: number;
  /** Attended + no-show + late-cancelled. In-notice cancellations are excluded. */
  relevantAppointments: number;
  attendedCount: number;
  noShowCount: number;
  lateCancellationCount: number;
  /** Excluded from every count; reported so the total is explicable. */
  inNoticeCancellationCount: number;
  /** Whole percent of relevant appointments that were no-shows. */
  noShowRatePercent: number;
  /** Salon-local date of the most recent no-show inside the window. */
  mostRecentNoShowDate?: string;
  daysSinceMostRecentNoShow?: number;
}

export interface NoShowRiskSignal {
  type: typeof IntelligenceSignalType.ClientNoShowRisk;
  level: NoShowRiskLevel;
  severity: SignalSeverity;
  /** Operational, never shaming. */
  summary: string;
  evidence: NoShowRiskEvidence;
  thresholds: NoShowRiskThresholds;
}

/**
 * Assess a client's missed-appointment pattern from attendance facts alone.
 *
 * THE RULE, stated once:
 *
 *   relevant = attended + no_show + late_cancelled
 *              (an in-notice cancellation is NOT relevant — the client gave the
 *               salon the slot back in time, which is the behaviour we want)
 *
 *   high     no_show >= highNoShowCount
 *            OR (relevant >= minimum AND rate >= highRatePercent)
 *   medium   (relevant >= minimum AND rate >= mediumRatePercent)
 *            OR late_cancelled >= mediumLateCancellationCount
 *            OR (no_show >= 1 AND relevant >= minimum)
 *   low      relevant >= minimum, nothing above
 *   insufficient_data   relevant < minimum and no count-based override fired
 *
 * The count-based overrides are what stop a small sample hiding a real pattern:
 * a client with three no-shows out of four appointments reaches `high` on the
 * count even though four is a thin sample. Everything else waits for enough
 * history rather than extrapolating from one data point.
 *
 * `events` must already be filtered to the lookback window by the caller, and
 * `today` is the salon-local date the window was resolved against.
 */
export function assessNoShowRisk(
  events: readonly AttendanceEvent[],
  today: string,
  thresholds: NoShowRiskThresholds,
): NoShowRiskSignal {
  let attended = 0;
  let noShows = 0;
  let lateCancellations = 0;
  let inNotice = 0;
  let mostRecentNoShowDate: string | undefined;

  for (const event of events) {
    switch (event.outcome) {
      case 'attended':
        attended += 1;
        break;
      case 'no_show':
        noShows += 1;
        if (!mostRecentNoShowDate || event.scheduledDate > mostRecentNoShowDate) {
          mostRecentNoShowDate = event.scheduledDate;
        }
        break;
      case 'late_cancelled':
        lateCancellations += 1;
        break;
      case 'cancelled':
        inNotice += 1;
        break;
    }
  }

  const relevant = attended + noShows + lateCancellations;
  const ratePercent = relevant === 0 ? 0 : divideRound(noShows * 100, relevant);

  const evidence: NoShowRiskEvidence = {
    lookbackDays: thresholds.lookbackDays,
    relevantAppointments: relevant,
    attendedCount: attended,
    noShowCount: noShows,
    lateCancellationCount: lateCancellations,
    inNoticeCancellationCount: inNotice,
    noShowRatePercent: ratePercent,
    ...(mostRecentNoShowDate
      ? {
          mostRecentNoShowDate,
          daysSinceMostRecentNoShow: Math.max(0, localDaysBetweenDates(mostRecentNoShowDate, today)),
        }
      : {}),
  };

  const hasSample = relevant >= thresholds.minimumRelevantAppointments;

  let level: NoShowRiskLevel;
  if (noShows >= thresholds.highNoShowCount || (hasSample && ratePercent >= thresholds.highRatePercent)) {
    level = 'high';
  } else if (
    (hasSample && ratePercent >= thresholds.mediumRatePercent) ||
    lateCancellations >= thresholds.mediumLateCancellationCount ||
    (hasSample && noShows >= 1)
  ) {
    level = 'medium';
  } else if (hasSample) {
    level = 'low';
  } else {
    level = 'insufficient_data';
  }

  return {
    type: IntelligenceSignalType.ClientNoShowRisk,
    level,
    severity: level === 'high' ? 'high' : level === 'medium' ? 'attention' : 'info',
    summary: describeNoShowRisk(level, evidence),
    evidence,
    thresholds,
  };
}

function describeNoShowRisk(level: NoShowRiskLevel, evidence: NoShowRiskEvidence): string {
  if (level === 'insufficient_data') {
    return `Not enough recent appointment history to show a pattern (${evidence.relevantAppointments} in the last ${evidence.lookbackDays} days).`;
  }
  if (level === 'low') {
    return `No missed-appointment pattern in the last ${evidence.lookbackDays} days.`;
  }
  const parts: string[] = [];
  if (evidence.noShowCount > 0) {
    parts.push(
      `${evidence.noShowCount} no-show${evidence.noShowCount === 1 ? '' : 's'} from ${evidence.relevantAppointments} appointments (${evidence.noShowRatePercent}%)`,
    );
  }
  if (evidence.lateCancellationCount > 0) {
    // "inside the notice period", never "was late" — the classification is made
    // against the salon's current window, not the one in force at the time.
    parts.push(
      `${evidence.lateCancellationCount} cancellation${evidence.lateCancellationCount === 1 ? '' : 's'} inside the notice period`,
    );
  }
  return `Previous missed-appointment pattern: ${parts.join(', ')} in the last ${evidence.lookbackDays} days.`;
}

// ===========================================================================
// 3. BACK-TO-BACK COLOUR
// ===========================================================================

export type ColourSequenceKind =
  /** The two stylist-occupied windows overlap. Stronger than a tight buffer. */
  | 'overlap'
  /** Consecutive with less than the configured buffer between them. */
  | 'back_to_back';

/**
 * One appointment as the sequencing check sees it.
 *
 * `occupiedIntervals` are the STYLIST-OCCUPIED sub-windows, not the whole
 * appointment span. QLOOQO models colour development as stylist-free time
 * (`booking.appointments.occupied_ranges`, a tstzmultirange the double-booking
 * exclusion constraint keys on), so a stylist genuinely is free while a client
 * processes. Measuring buffers against raw start/end times would therefore
 * manufacture warnings for exactly the interleaving the platform is designed to
 * allow. When a caller has no occupancy data, it passes the whole span.
 */
export interface ColourAppointmentInput {
  appointmentId: string;
  staffProfileId: string;
  clientDisplayName: string;
  /** ISO instants. Used for display and ordering. */
  startsAt: string;
  endsAt: string;
  /** Stylist-occupied windows as epoch-millisecond pairs, ascending. */
  occupiedIntervals: ReadonlyArray<{ startMs: number; endMs: number }>;
  /** True when any service on the appointment is in a colour billing category. */
  isColour: boolean;
  serviceNames: string[];
}

export interface BackToBackColourThresholds {
  /**
   * Minutes of stylist-free time wanted between two colour appointments. A gap
   * strictly BELOW this warns; a gap equal to it is fine.
   */
  minimumBufferMinutes: number;
}

export interface BackToBackColourSignal {
  type: typeof IntelligenceSignalType.BackToBackColour;
  kind: ColourSequenceKind;
  severity: SignalSeverity;
  summary: string;
  staffProfileId: string;
  firstAppointmentId: string;
  secondAppointmentId: string;
  /** Negative when the occupied windows overlap. */
  bufferMinutes: number;
  minimumBufferMinutes: number;
  first: { clientDisplayName: string; startsAt: string; endsAt: string; serviceNames: string[] };
  second: { clientDisplayName: string; startsAt: string; endsAt: string; serviceNames: string[] };
}

/**
 * Find colour appointments stacked on ONE stylist with too little breathing room.
 *
 * Rules, all of which matter:
 *  - Both appointments must be colour, decided structurally by the caller from
 *    the service billing category — never from a service name.
 *  - Both must belong to the SAME stylist. Two colour appointments on different
 *    stylists are not a stylist-sequencing risk, however close they sit.
 *  - The gap is measured between the first appointment's LAST occupied moment
 *    and the second's FIRST, so colour development time is correctly treated as
 *    availability rather than as a wall.
 *  - Only CONSECUTIVE pairs are reported. Comparing every pair in a day would
 *    turn a four-colour day into six warnings describing the same diary.
 *
 * `appointments` may arrive in any order; they are sorted internally so the
 * result is a deterministic function of the set.
 */
export function detectBackToBackColour(
  appointments: readonly ColourAppointmentInput[],
  thresholds: BackToBackColourThresholds,
): BackToBackColourSignal[] {
  const byStaff = new Map<string, ColourAppointmentInput[]>();
  for (const appointment of appointments) {
    if (!appointment.isColour || !appointment.staffProfileId) continue;
    const list = byStaff.get(appointment.staffProfileId) ?? [];
    list.push(appointment);
    byStaff.set(appointment.staffProfileId, list);
  }

  const signals: BackToBackColourSignal[] = [];
  const bufferMs = Math.max(0, Math.trunc(thresholds.minimumBufferMinutes)) * 60_000;

  // Deterministic staff order so the output does not depend on Map insertion.
  for (const staffProfileId of [...byStaff.keys()].sort()) {
    const list = byStaff
      .get(staffProfileId)!
      .slice()
      .sort(
        (a, b) =>
          occupiedStart(a) - occupiedStart(b) ||
          occupiedEnd(a) - occupiedEnd(b) ||
          a.appointmentId.localeCompare(b.appointmentId),
      );

    for (let i = 0; i + 1 < list.length; i++) {
      const first = list[i];
      const second = list[i + 1];
      const firstEnd = occupiedEnd(first);
      const secondStart = occupiedStart(second);
      if (!Number.isFinite(firstEnd) || !Number.isFinite(secondStart)) continue;

      const gapMs = secondStart - firstEnd;
      if (gapMs >= bufferMs) continue;

      const kind: ColourSequenceKind = gapMs < 0 ? 'overlap' : 'back_to_back';
      const bufferMinutes = Math.round(gapMs / 60_000);

      signals.push({
        type: IntelligenceSignalType.BackToBackColour,
        kind,
        // An overlap is a real diary conflict; a tight-but-positive buffer is a
        // heads-up. They are not the same thing and are not graded the same.
        severity: kind === 'overlap' ? 'high' : 'attention',
        summary:
          kind === 'overlap'
            ? `Two colour appointments overlap for this stylist by ${Math.abs(bufferMinutes)} min.`
            : `Two colour appointments with ${bufferMinutes} min between them (${thresholds.minimumBufferMinutes} min recommended).`,
        staffProfileId,
        firstAppointmentId: first.appointmentId,
        secondAppointmentId: second.appointmentId,
        bufferMinutes,
        minimumBufferMinutes: thresholds.minimumBufferMinutes,
        first: {
          clientDisplayName: first.clientDisplayName,
          startsAt: first.startsAt,
          endsAt: first.endsAt,
          serviceNames: first.serviceNames,
        },
        second: {
          clientDisplayName: second.clientDisplayName,
          startsAt: second.startsAt,
          endsAt: second.endsAt,
          serviceNames: second.serviceNames,
        },
      });
    }
  }

  return signals;
}

function occupiedStart(appointment: ColourAppointmentInput): number {
  if (appointment.occupiedIntervals.length === 0) return Date.parse(appointment.startsAt);
  return Math.min(...appointment.occupiedIntervals.map((i) => i.startMs));
}

function occupiedEnd(appointment: ColourAppointmentInput): number {
  if (appointment.occupiedIntervals.length === 0) return Date.parse(appointment.endsAt);
  return Math.max(...appointment.occupiedIntervals.map((i) => i.endMs));
}

// ===========================================================================
// 4. SLOT GAP
// ===========================================================================

export interface Interval {
  startMs: number;
  endMs: number;
}

export interface SlotGapThresholds {
  /**
   * Shortest gap worth reporting. A five-minute window between two clients is
   * turnaround, not lost capacity, and reporting it would bury the real gaps.
   */
  minimumGapMinutes: number;
}

export interface SlotGapSignal {
  type: typeof IntelligenceSignalType.SlotGap;
  severity: SignalSeverity;
  summary: string;
  staffProfileId: string;
  startsAt: string;
  endsAt: string;
  gapMinutes: number;
}

/**
 * Merge overlapping/adjacent intervals into a normalised ascending set.
 *
 * Required before any gap arithmetic: two appointments running 09:00-10:00 and
 * 09:30-10:30 are ONE busy block of 09:00-10:30, and subtracting them
 * independently would invent a negative gap between them.
 */
export function mergeIntervals(intervals: readonly Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.endMs > interval.startMs)
    .slice()
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    // `>=` merges ADJACENT intervals too: 09:00-10:00 followed by 10:00-11:00 is
    // continuous busy time with no gap between them, not two blocks around a
    // zero-minute gap.
    if (last && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      merged.push({ startMs: interval.startMs, endMs: interval.endMs });
    }
  }
  return merged;
}

/**
 * Genuinely bookable dead time INSIDE a stylist's shift.
 *
 * `busy` must already contain every canonical unavailability source — booked
 * appointments' stylist-occupied windows, shift breaks, approved leave and
 * blocking absences — exactly as the platform's own availability engine
 * assembles them. That is what makes "10:00 appointment ends, 10:00-10:30 lunch,
 * 10:30 appointment starts" correctly produce NO gap.
 *
 * INTERIOR ONLY. A shift that starts at 09:00 with a first booking at 11:00 has
 * two unbooked hours, but that is opening availability, not a slot gap wedged
 * between commitments — and conflating them would report every quiet morning as
 * an inefficiency. The gap must have busy time on BOTH sides.
 */
export function findSlotGaps(
  input: {
    staffProfileId: string;
    shift: Interval;
    busy: readonly Interval[];
  },
  thresholds: SlotGapThresholds,
): SlotGapSignal[] {
  const minimumMs = Math.max(0, Math.trunc(thresholds.minimumGapMinutes)) * 60_000;
  if (input.shift.endMs <= input.shift.startMs) return [];

  // Clip busy time to the shift: a booking running past the end of a shift does
  // not create availability outside it, and leave spanning whole days must not
  // drag a gap boundary outside the working window.
  const clipped = input.busy
    .map((interval) => ({
      startMs: Math.max(interval.startMs, input.shift.startMs),
      endMs: Math.min(interval.endMs, input.shift.endMs),
    }))
    .filter((interval) => interval.endMs > interval.startMs);

  const merged = mergeIntervals(clipped);
  // Fewer than two busy blocks cannot enclose an interior gap.
  if (merged.length < 2) return [];

  const gaps: SlotGapSignal[] = [];
  for (let i = 0; i + 1 < merged.length; i++) {
    const startMs = merged[i].endMs;
    const endMs = merged[i + 1].startMs;
    const durationMs = endMs - startMs;
    if (durationMs < minimumMs || durationMs <= 0) continue;

    const gapMinutes = Math.round(durationMs / 60_000);
    gaps.push({
      type: IntelligenceSignalType.SlotGap,
      // A gap is lost capacity to be aware of, never an alarm.
      severity: 'info',
      summary: `${gapMinutes} min unbooked between appointments.`,
      staffProfileId: input.staffProfileId,
      startsAt: new Date(startMs).toISOString(),
      endsAt: new Date(endMs).toISOString(),
      gapMinutes,
    });
  }
  return gaps;
}

// ===========================================================================
// Thresholds
// ===========================================================================

export interface OperationalSignalThresholds {
  spend: SpendTrendThresholds;
  noShow: NoShowRiskThresholds;
  colour: BackToBackColourThresholds;
  slotGap: SlotGapThresholds;
}

/**
 * Platform defaults.
 *
 * EVERY VALUE BELOW IS AN ENGINEERING DEFAULT REQUIRING PRODUCT TUNING. None of
 * them was supplied by the client. They are set conservatively, because a signal
 * that fires too often is a signal staff learn to scroll past.
 *
 *   spend.windowVisits 3          — three visits smooths one unusual ticket
 *                                   without needing a year of history; six
 *                                   settled visits total to say anything.
 *   spend.materialityPercent 15   — a £100 -> £98 drift is noise; £100 -> £85 is
 *                                   a change worth a conversation.
 *   noShow.lookbackDays 365       — a full year of seasonality, and old history
 *                                   ages out rather than haunting a client.
 *   noShow.minimumRelevantAppointments 5
 *                                 — below five, a rate means nothing; only the
 *                                   count-based overrides can fire.
 *   noShow.mediumRatePercent 15 / highRatePercent 30
 *   noShow.highNoShowCount 3      — three misses is a pattern at any sample size.
 *   noShow.mediumLateCancellationCount 3
 *                                 — late cancels are counted separately and are
 *                                   never treated as equal to a no-show.
 *   colour.minimumBufferMinutes 15
 *                                 — turnaround between two colour clients on one
 *                                   stylist, measured against OCCUPIED time.
 *   slotGap.minimumGapMinutes 15  — below this is turnaround, not lost capacity.
 */
export const DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS: OperationalSignalThresholds = {
  spend: { windowVisits: 3, materialityPercent: 15 },
  noShow: {
    lookbackDays: 365,
    minimumRelevantAppointments: 5,
    mediumRatePercent: 15,
    highRatePercent: 30,
    highNoShowCount: 3,
    mediumLateCancellationCount: 3,
  },
  colour: { minimumBufferMinutes: 15 },
  slotGap: { minimumGapMinutes: 15 },
};

/** Hard bounds, mirrored exactly by the CHECK constraints in migration 0106. */
export const OPERATIONAL_SIGNAL_BOUNDS = {
  spendWindowVisits: { min: 2, max: 12 },
  spendMaterialityPercent: { min: 1, max: 100 },
  noShowLookbackDays: { min: 30, max: 1095 },
  noShowMinimumRelevantAppointments: { min: 2, max: 50 },
  noShowMediumRatePercent: { min: 1, max: 100 },
  noShowHighRatePercent: { min: 1, max: 100 },
  noShowHighNoShowCount: { min: 1, max: 20 },
  noShowMediumLateCancellationCount: { min: 1, max: 20 },
  colourMinimumBufferMinutes: { min: 0, max: 240 },
  slotGapMinimumGapMinutes: { min: 5, max: 240 },
} as const;

/** One stored settings row. `locationId` null is the business-wide default. */
export interface OperationalSignalSettingsRecord extends OperationalSignalThresholds {
  businessId: string;
  locationId: string | null;
}

/**
 * Location override -> business default -> platform default.
 *
 * Resolution is PER ROW: the first configured scope wins outright and its whole
 * threshold set is used together. Thresholds never stack, and a location never
 * inherits half its values from the business row — that would produce a
 * combination nobody chose. Same rule as the lapse and formula-change resolvers.
 */
export function resolveOperationalSignalThresholds(
  records: readonly OperationalSignalSettingsRecord[],
  locationId: string | null,
): OperationalSignalThresholds {
  const forLocation = locationId ? records.find((r) => r.locationId === locationId) : undefined;
  const business = records.find((r) => r.locationId === null);
  const chosen = forLocation ?? business;
  if (!chosen) return cloneThresholds(DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS);
  return {
    spend: { ...chosen.spend },
    noShow: { ...chosen.noShow },
    colour: { ...chosen.colour },
    slotGap: { ...chosen.slotGap },
  };
}

/** Validate an owner-supplied threshold set. Returns every problem at once. */
export function validateOperationalSignalThresholds(
  input: OperationalSignalThresholds,
): string[] {
  const errors: string[] = [];
  const check = (label: string, value: unknown, bounds: { min: number; max: number }) => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      errors.push(`${label} must be a whole number between ${bounds.min} and ${bounds.max}`);
    }
  };
  const B = OPERATIONAL_SIGNAL_BOUNDS;

  check('Spend comparison window', input.spend?.windowVisits, B.spendWindowVisits);
  check('Spend change threshold', input.spend?.materialityPercent, B.spendMaterialityPercent);
  check('No-show lookback', input.noShow?.lookbackDays, B.noShowLookbackDays);
  check('Minimum appointment history', input.noShow?.minimumRelevantAppointments, B.noShowMinimumRelevantAppointments);
  check('Medium no-show rate', input.noShow?.mediumRatePercent, B.noShowMediumRatePercent);
  check('High no-show rate', input.noShow?.highRatePercent, B.noShowHighRatePercent);
  check('High no-show count', input.noShow?.highNoShowCount, B.noShowHighNoShowCount);
  check('Late cancellation count', input.noShow?.mediumLateCancellationCount, B.noShowMediumLateCancellationCount);
  check('Colour buffer', input.colour?.minimumBufferMinutes, B.colourMinimumBufferMinutes);
  check('Minimum diary gap', input.slotGap?.minimumGapMinutes, B.slotGapMinimumGapMinutes);

  // A medium rate above the high rate would make `medium` unreachable — a
  // silently dead branch rather than a rejected configuration.
  if (
    typeof input.noShow?.mediumRatePercent === 'number' &&
    typeof input.noShow?.highRatePercent === 'number' &&
    input.noShow.mediumRatePercent > input.noShow.highRatePercent
  ) {
    errors.push('Medium no-show rate cannot be higher than the high no-show rate');
  }
  return errors;
}

function cloneThresholds(source: OperationalSignalThresholds): OperationalSignalThresholds {
  return {
    spend: { ...source.spend },
    noShow: { ...source.noShow },
    colour: { ...source.colour },
    slotGap: { ...source.slotGap },
  };
}

// ===========================================================================
// Reporting contract
// ===========================================================================

/**
 * The structured roll-up reporting consumes. Reporting reads THESE numbers, never
 * rendered UI text, so a wording change can never move a report.
 */
export interface OperationalSignalReport {
  businessId: string;
  locationId: string | null;
  /** Salon-local window the diary signals were computed over. */
  fromDate: string;
  toDate: string;
  timezone: string;
  spendTrend: {
    rising: number;
    stable: number;
    falling: number;
    insufficientData: number;
    clientsEvaluated: number;
  };
  noShowRisk: {
    low: number;
    medium: number;
    high: number;
    insufficientData: number;
    clientsEvaluated: number;
    /** Upcoming appointments belonging to medium/high clients in the window. */
    upcomingAppointmentsForFlaggedClients: number;
  };
  backToBackColour: {
    warningCount: number;
    overlapCount: number;
    staffAffected: number;
  };
  slotGaps: {
    gapCount: number;
    totalGapMinutes: number;
    averageGapMinutes: number;
    staffAffected: number;
  };
  thresholds: OperationalSignalThresholds;
}

// ===========================================================================
// Arithmetic helpers — integer, deterministic
// ===========================================================================

function sumPence(visits: readonly ClientVisitSpend[]): number {
  let total = 0;
  for (const visit of visits) {
    const value = Math.trunc(visit.grossCents);
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

/** Non-negative integer division, rounded half up. */
function divideRound(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  return Math.round(numerator / denominator);
}

/**
 * Signed integer division rounded half AWAY FROM ZERO, so -15.5% and +15.5%
 * behave symmetrically at the threshold. `Math.round` alone rounds -15.5 to -15,
 * which would make a falling trend need a fractionally larger move than a rising
 * one to cross the same materiality line.
 */
function signedDivideRound(numerator: number, denominator: number): number {
  if (denominator === 0) return 0;
  const value = numerator / denominator;
  return value < 0 ? -Math.round(-value) : Math.round(value);
}

/** Whole calendar days from `from` to `to`. Both `YYYY-MM-DD`, salon-local. */
function localDaysBetweenDates(from: string, to: string): number {
  const parse = (date: string) => {
    const [y, m, d] = date.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/** Pence to a readable amount. Display only — never used for comparison. */
function formatPence(cents: number): string {
  return `£${(Math.round(cents) / 100).toFixed(2)}`;
}
