/**
 * The four pure signal calculators in @sheer/domain.
 *
 * Deterministic and clock-free, so they can be asserted exactly. The cases that
 * matter most are the ones that must stay QUIET: a client who visits less often
 * but spends the same, a single no-show from a thin history, two colour
 * appointments on different stylists, and a lunch break that is not a diary gap.
 * A signal that fires on those is a signal staff learn to ignore.
 *
 * The I/O half — canonical data loading, tenancy, reporting — is in
 * operational-signals.service.spec.ts.
 */
import {
  DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS,
  OPERATIONAL_SIGNAL_BOUNDS,
  assessNoShowRisk,
  assessSpendTrend,
  detectBackToBackColour,
  findSlotGaps,
  mergeIntervals,
  resolveOperationalSignalThresholds,
  validateOperationalSignalThresholds,
  type AttendanceEvent,
  type ClientVisitSpend,
  type ColourAppointmentInput,
} from '@sheer/domain';

const T = DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS;

/** £-value visits on sequential dates, oldest first. */
function visits(...pounds: number[]): ClientVisitSpend[] {
  return pounds.map((value, index) => ({
    visitDate: `2026-0${1 + Math.floor(index / 28)}-${String((index % 28) + 1).padStart(2, '0')}`,
    grossCents: Math.round(value * 100),
  }));
}

// ===========================================================================
// 1. SPEND TREND — Wrike sections 5-10, 54
// ===========================================================================

describe('spend trend', () => {
  it('reports insufficient data below the required history', () => {
    // windowVisits 3 needs 6 settled visits.
    const signal = assessSpendTrend(visits(100, 100, 100, 100, 100), T.spend);
    expect(signal.status).toBe('insufficient_data');
    expect(signal.insufficientReason).toBe('not_enough_completed_visits');
    expect(signal.severity).toBe('info');
  });

  it('never fabricates a trend from a single difference', () => {
    const signal = assessSpendTrend(visits(100, 95), T.spend);
    expect(signal.status).toBe('insufficient_data');
    expect(signal.evidence).toBeUndefined();
  });

  it('calls a small drift STABLE', () => {
    // £100 average -> £98 average is -2%, far below the 15% materiality.
    const signal = assessSpendTrend(visits(100, 100, 100, 98, 98, 98), T.spend);
    expect(signal.status).toBe('stable');
    expect(signal.evidence?.changePercent).toBe(-2);
    expect(signal.severity).toBe('info');
  });

  it('detects a clearly falling trend', () => {
    const signal = assessSpendTrend(visits(90, 95, 92, 75, 72, 78), T.spend);
    expect(signal.status).toBe('falling');
    expect(signal.severity).toBe('attention');
    expect(signal.evidence?.recentAverageCents).toBe(7500);
    expect(signal.evidence?.previousAverageCents).toBe(9233);
  });

  it('detects a clearly rising trend', () => {
    const signal = assessSpendTrend(visits(70, 72, 74, 100, 105, 98), T.spend);
    expect(signal.status).toBe('rising');
    expect(signal.severity).toBe('info'); // rising is not a problem to flag
  });

  it('treats exactly the threshold as material, symmetrically', () => {
    // £100 -> £85 is exactly -15%.
    const falling = assessSpendTrend(visits(100, 100, 100, 85, 85, 85), T.spend);
    expect(falling.evidence?.changePercent).toBe(-15);
    expect(falling.status).toBe('falling');

    // £100 -> £115 is exactly +15%.
    const rising = assessSpendTrend(visits(100, 100, 100, 115, 115, 115), T.spend);
    expect(rising.evidence?.changePercent).toBe(15);
    expect(rising.status).toBe('rising');

    // One pence inside the boundary stays stable on both sides.
    expect(assessSpendTrend(visits(100, 100, 100, 85.5, 85.5, 85.5), T.spend).status).toBe('stable');
  });

  it('does NOT call reduced visit frequency a spend drop', () => {
    // The classic error. Four £100 visits then two £100 visits: total period
    // spend halved, but the value of a visit did not move at all.
    const signal = assessSpendTrend(visits(100, 100, 100, 100, 100, 100), T.spend);
    expect(signal.status).toBe('stable');
    expect(signal.evidence?.recentAverageCents).toBe(signal.evidence?.previousAverageCents);
  });

  it('reports visit counts and totals separately from the average', () => {
    // So the UI can say WHICH thing moved rather than conflating them.
    const signal = assessSpendTrend(visits(90, 95, 92, 75, 72, 78), T.spend);
    expect(signal.evidence).toMatchObject({
      recentVisitCount: 3,
      previousVisitCount: 3,
      recentTotalCents: 22500,
      previousTotalCents: 27700,
    });
  });

  it('handles a zero baseline without producing Infinity', () => {
    const signal = assessSpendTrend(visits(0, 0, 0, 100, 100, 100), T.spend);
    expect(signal.status).toBe('insufficient_data');
    expect(signal.insufficientReason).toBe('no_previous_spend');
    expect(signal.evidence?.recentAverageCents).toBe(10000);
  });

  it('keeps money in integer pence', () => {
    const signal = assessSpendTrend(visits(33.33, 33.33, 33.34, 50, 50, 50), T.spend);
    expect(Number.isInteger(signal.evidence!.recentAverageCents)).toBe(true);
    expect(Number.isInteger(signal.evidence!.previousAverageCents)).toBe(true);
    expect(signal.evidence!.previousAverageCents).toBe(3333);
  });

  it('compares only the two most recent windows, ignoring older history', () => {
    // The ancient £500 visits must not drag the comparison.
    const signal = assessSpendTrend(visits(500, 500, 500, 100, 100, 100, 100, 100, 100), T.spend);
    expect(signal.status).toBe('stable');
  });

  it('uses neutral wording about the spend, never about the client', () => {
    const signal = assessSpendTrend(visits(90, 95, 92, 75, 72, 78), T.spend);
    expect(signal.summary).toContain('Recent spend trend is lower');
    expect(signal.summary).not.toMatch(/declin|value|poor|bad|worse/i);
  });

  it('honours a configured window and materiality', () => {
    const custom = { windowVisits: 2, materialityPercent: 5 };
    // 4 visits is enough at windowVisits 2; -10% clears a 5% materiality.
    const signal = assessSpendTrend(visits(100, 100, 90, 90), custom);
    expect(signal.status).toBe('falling');
    expect(signal.evidence?.recentVisitCount).toBe(2);
  });
});

// ===========================================================================
// 2. NO-SHOW RISK — Wrike sections 11-17, 55
// ===========================================================================

describe('no-show risk', () => {
  const TODAY = '2026-09-01';

  function events(spec: Partial<Record<AttendanceEvent['outcome'], number>>): AttendanceEvent[] {
    const out: AttendanceEvent[] = [];
    let day = 1;
    for (const [outcome, count] of Object.entries(spec)) {
      for (let i = 0; i < (count ?? 0); i++) {
        out.push({
          scheduledDate: `2026-0${1 + Math.floor(day / 28)}-${String((day % 28) + 1).padStart(2, '0')}`,
          outcome: outcome as AttendanceEvent['outcome'],
        });
        day++;
      }
    }
    return out;
  }

  it('reports insufficient data below the minimum history', () => {
    const signal = assessNoShowRisk(events({ attended: 2 }), TODAY, T.noShow);
    expect(signal.level).toBe('insufficient_data');
    expect(signal.severity).toBe('info');
  });

  it('does NOT call one no-show from one appointment a 100% risk', () => {
    // The small-sample trap. A rate of 100% from a single data point is not a
    // pattern, and only the count-based override may fire — 1 < highNoShowCount.
    const signal = assessNoShowRisk(events({ no_show: 1 }), TODAY, T.noShow);
    expect(signal.level).toBe('insufficient_data');
    expect(signal.evidence.noShowRatePercent).toBe(100);
  });

  it('reports LOW when there is history and no misses', () => {
    const signal = assessNoShowRisk(events({ attended: 10 }), TODAY, T.noShow);
    expect(signal.level).toBe('low');
    expect(signal.summary).toContain('No missed-appointment pattern');
  });

  it('reports MEDIUM for a single no-show once the sample is large enough', () => {
    const signal = assessNoShowRisk(events({ attended: 7, no_show: 1 }), TODAY, T.noShow);
    expect(signal.level).toBe('medium');
    expect(signal.severity).toBe('attention');
  });

  it('reports HIGH on repeated no-shows regardless of rate', () => {
    // 3 misses out of 20 is only 15%, but three misses is a pattern.
    const signal = assessNoShowRisk(events({ attended: 17, no_show: 3 }), TODAY, T.noShow);
    expect(signal.level).toBe('high');
    expect(signal.severity).toBe('high');
  });

  it('reports HIGH on a high rate with enough sample', () => {
    // 2 of 6 = 33% >= highRatePercent 30, with sample >= 5.
    const signal = assessNoShowRisk(events({ attended: 4, no_show: 2 }), TODAY, T.noShow);
    expect(signal.level).toBe('high');
  });

  it('treats exactly the threshold rate as significant', () => {
    // 3 of 10 = 30% = highRatePercent. (Also 3 no-shows, which is high anyway.)
    expect(assessNoShowRisk(events({ attended: 7, no_show: 3 }), TODAY, T.noShow).level).toBe('high');
    // 2 of 13 = 15% = mediumRatePercent exactly.
    const medium = assessNoShowRisk(events({ attended: 11, no_show: 2 }), TODAY, T.noShow);
    expect(medium.evidence.noShowRatePercent).toBe(15);
    expect(medium.level).toBe('medium');
  });

  it('NEVER equates a normal cancellation with a no-show', () => {
    // Ten in-notice cancellations are not a missed-appointment pattern: the
    // client gave the slot back in time, which is the behaviour salons want.
    const signal = assessNoShowRisk(events({ attended: 6, cancelled: 10 }), TODAY, T.noShow);
    expect(signal.level).toBe('low');
    expect(signal.evidence.noShowCount).toBe(0);
    expect(signal.evidence.inNoticeCancellationCount).toBe(10);
    // In-notice cancellations are excluded from the denominator entirely.
    expect(signal.evidence.relevantAppointments).toBe(6);
  });

  it('counts late cancellations separately and never as no-shows', () => {
    const signal = assessNoShowRisk(events({ attended: 6, late_cancelled: 3 }), TODAY, T.noShow);
    expect(signal.evidence.noShowCount).toBe(0);
    expect(signal.evidence.lateCancellationCount).toBe(3);
    expect(signal.evidence.noShowRatePercent).toBe(0);
    // Three late cancels reach MEDIUM on their own threshold — never HIGH.
    expect(signal.level).toBe('medium');
  });

  it('reports the most recent no-show and its recency', () => {
    const signal = assessNoShowRisk(
      [
        { scheduledDate: '2026-01-10', outcome: 'no_show' },
        { scheduledDate: '2026-08-14', outcome: 'no_show' },
        ...Array.from({ length: 6 }, (_, i) => ({
          scheduledDate: `2026-07-0${i + 1}`,
          outcome: 'attended' as const,
        })),
      ],
      TODAY,
      T.noShow,
    );
    expect(signal.evidence.mostRecentNoShowDate).toBe('2026-08-14');
    expect(signal.evidence.daysSinceMostRecentNoShow).toBe(18);
  });

  it('states evidence as counts, never as a probability', () => {
    const signal = assessNoShowRisk(events({ attended: 6, no_show: 2 }), TODAY, T.noShow);
    expect(signal.summary).toMatch(/no-shows? from \d+ appointments/);
    expect(signal.summary).not.toMatch(/likely|probability|predict|chance|%\s*likely/i);
  });

  it('uses operational wording, never shaming', () => {
    const signal = assessNoShowRisk(events({ attended: 4, no_show: 3 }), TODAY, T.noShow);
    expect(signal.summary).not.toMatch(/unreliable|bad client|problem client|abuse/i);
  });

  it('honours configured thresholds', () => {
    const strict = { ...T.noShow, minimumRelevantAppointments: 2, mediumRatePercent: 10, highRatePercent: 20 };
    const signal = assessNoShowRisk(events({ attended: 3, no_show: 1 }), TODAY, strict);
    expect(signal.level).toBe('high'); // 25% >= 20 with sample 4 >= 2
  });
});

// ===========================================================================
// 3. BACK-TO-BACK COLOUR — Wrike sections 18-26, 56
// ===========================================================================

describe('back-to-back colour', () => {
  const MS = (iso: string) => Date.parse(iso);

  function appt(
    id: string,
    staffProfileId: string,
    startsAt: string,
    endsAt: string,
    options: { isColour?: boolean; occupied?: Array<[string, string]> } = {},
  ): ColourAppointmentInput {
    return {
      appointmentId: id,
      staffProfileId,
      clientDisplayName: `Client ${id}`,
      startsAt,
      endsAt,
      // Default: the whole span occupies the stylist.
      occupiedIntervals: (options.occupied ?? [[startsAt, endsAt]]).map(([s, e]) => ({
        startMs: MS(s),
        endMs: MS(e),
      })),
      isColour: options.isColour ?? true,
      serviceNames: ['Full Head Colour'],
    };
  }

  it('warns on two colour appointments with zero gap', () => {
    const signals = detectBackToBackColour(
      [
        appt('a', 'sam', '2026-09-01T10:00:00Z', '2026-09-01T11:30:00Z'),
        appt('b', 'sam', '2026-09-01T11:30:00Z', '2026-09-01T13:00:00Z'),
      ],
      T.colour,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: 'back_to_back', bufferMinutes: 0, severity: 'attention' });
  });

  it('warns below the buffer and stays quiet at or above it', () => {
    const pair = (gapMinutes: number) =>
      detectBackToBackColour(
        [
          appt('a', 'sam', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
          appt(
            'b',
            'sam',
            new Date(MS('2026-09-01T11:00:00Z') + gapMinutes * 60_000).toISOString(),
            new Date(MS('2026-09-01T12:00:00Z') + gapMinutes * 60_000).toISOString(),
          ),
        ],
        T.colour,
      );

    expect(pair(10)).toHaveLength(1);
    expect(pair(14)).toHaveLength(1);
    expect(pair(15)).toHaveLength(0); // exactly the buffer is acceptable
    expect(pair(30)).toHaveLength(0);
  });

  it('grades an overlap higher than a tight buffer', () => {
    const signals = detectBackToBackColour(
      [
        appt('a', 'sam', '2026-09-01T10:00:00Z', '2026-09-01T11:30:00Z'),
        appt('b', 'sam', '2026-09-01T11:00:00Z', '2026-09-01T12:30:00Z'),
      ],
      T.colour,
    );
    expect(signals[0]).toMatchObject({ kind: 'overlap', severity: 'high', bufferMinutes: -30 });
    expect(signals[0].summary).toContain('overlap');
  });

  it('does not warn when only one appointment is colour', () => {
    expect(
      detectBackToBackColour(
        [
          appt('a', 'sam', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
          appt('b', 'sam', '2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z', { isColour: false }),
        ],
        T.colour,
      ),
    ).toHaveLength(0);

    expect(
      detectBackToBackColour(
        [
          appt('a', 'sam', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z', { isColour: false }),
          appt('b', 'sam', '2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z'),
        ],
        T.colour,
      ),
    ).toHaveLength(0);
  });

  it('does NOT warn across different stylists', () => {
    // Two stylists working back to back is a busy salon, not a sequencing risk.
    expect(
      detectBackToBackColour(
        [
          appt('a', 'sam', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
          appt('b', 'olivia', '2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z'),
        ],
        T.colour,
      ),
    ).toHaveLength(0);
  });

  it('measures the gap against OCCUPIED time, not the appointment span', () => {
    // The first appointment runs 10:00-12:00 but the stylist is free from 10:45
    // while the colour develops. The next colour starts at 12:00, so there is
    // 75 minutes of genuine stylist availability — no warning.
    const signals = detectBackToBackColour(
      [
        appt('a', 'sam', '2026-09-01T10:00:00Z', '2026-09-01T12:00:00Z', {
          occupied: [['2026-09-01T10:00:00Z', '2026-09-01T10:45:00Z']],
        }),
        appt('b', 'sam', '2026-09-01T12:00:00Z', '2026-09-01T13:30:00Z', {
          occupied: [['2026-09-01T12:00:00Z', '2026-09-01T12:45:00Z']],
        }),
      ],
      T.colour,
    );
    expect(signals).toHaveLength(0);
  });

  it('reports one warning per consecutive pair, not every combination', () => {
    // Three stacked colours = 2 consecutive pairs, not 3 combinations.
    const signals = detectBackToBackColour(
      [
        appt('a', 'sam', '2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
        appt('b', 'sam', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        appt('c', 'sam', '2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z'),
      ],
      T.colour,
    );
    expect(signals).toHaveLength(2);
    expect(signals.map((s) => [s.firstAppointmentId, s.secondAppointmentId])).toEqual([
      ['a', 'b'],
      ['b', 'c'],
    ]);
  });

  it('is order-independent', () => {
    const forward = detectBackToBackColour(
      [
        appt('a', 'sam', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
        appt('b', 'sam', '2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z'),
      ],
      T.colour,
    );
    const reversed = detectBackToBackColour(
      [
        appt('b', 'sam', '2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z'),
        appt('a', 'sam', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
      ],
      T.colour,
    );
    expect(reversed).toEqual(forward);
  });

  it('ignores an appointment with no assigned stylist', () => {
    expect(
      detectBackToBackColour(
        [
          appt('a', '', '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
          appt('b', '', '2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z'),
        ],
        T.colour,
      ),
    ).toHaveLength(0);
  });

  it('carries the context a stylist needs to act', () => {
    const signals = detectBackToBackColour(
      [
        appt('a', 'sam', '2026-09-01T10:00:00Z', '2026-09-01T11:30:00Z'),
        appt('b', 'sam', '2026-09-01T11:30:00Z', '2026-09-01T13:00:00Z'),
      ],
      T.colour,
    );
    expect(signals[0].first).toMatchObject({ clientDisplayName: 'Client a', serviceNames: ['Full Head Colour'] });
    expect(signals[0].second).toMatchObject({ clientDisplayName: 'Client b' });
    expect(signals[0].minimumBufferMinutes).toBe(15);
  });
});

// ===========================================================================
// 4. SLOT GAP — Wrike sections 27-33, 57
// ===========================================================================

describe('slot gaps', () => {
  const MS = (iso: string) => Date.parse(iso);
  const iv = (s: string, e: string) => ({ startMs: MS(s), endMs: MS(e) });
  const SHIFT = iv('2026-09-01T09:00:00Z', '2026-09-01T17:00:00Z');

  const gaps = (busy: Array<{ startMs: number; endMs: number }>, thresholds = T.slotGap) =>
    findSlotGaps({ staffProfileId: 'sam', shift: SHIFT, busy }, thresholds);

  it('finds a simple gap between two appointments', () => {
    const result = gaps([
      iv('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
      iv('2026-09-01T10:30:00Z', '2026-09-01T11:30:00Z'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ gapMinutes: 30, staffProfileId: 'sam' });
    expect(result[0].startsAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('ignores a gap below the minimum', () => {
    expect(
      gaps([
        iv('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
        iv('2026-09-01T10:05:00Z', '2026-09-01T11:00:00Z'),
      ]),
    ).toHaveLength(0);
  });

  it('treats exactly the minimum as reportable', () => {
    const result = gaps([
      iv('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
      iv('2026-09-01T10:15:00Z', '2026-09-01T11:00:00Z'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].gapMinutes).toBe(15);
  });

  it('reports nothing for genuinely back-to-back appointments', () => {
    expect(
      gaps([
        iv('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
        iv('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z'),
      ]),
    ).toHaveLength(0);
  });

  it('does NOT call a lunch break a diary gap', () => {
    // The headline false positive. 10:00 appointment ends, 10:00-10:30 break,
    // 10:30 next appointment. The stylist was never available.
    expect(
      gaps([
        iv('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
        iv('2026-09-01T10:00:00Z', '2026-09-01T10:30:00Z'), // break
        iv('2026-09-01T10:30:00Z', '2026-09-01T11:30:00Z'),
      ]),
    ).toHaveLength(0);
  });

  it('merges overlapping busy periods rather than inventing a negative gap', () => {
    const result = gaps([
      iv('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
      iv('2026-09-01T09:30:00Z', '2026-09-01T10:30:00Z'),
      iv('2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z'),
    ]);
    // Union is 09:00-10:30, so the only gap is 10:30-11:00.
    expect(result).toHaveLength(1);
    expect(result[0].gapMinutes).toBe(30);
  });

  it('finds multiple gaps in one shift', () => {
    const result = gaps([
      iv('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
      iv('2026-09-01T10:30:00Z', '2026-09-01T11:30:00Z'),
      iv('2026-09-01T13:00:00Z', '2026-09-01T14:00:00Z'),
    ]);
    expect(result.map((g) => g.gapMinutes)).toEqual([30, 90]);
  });

  it('does NOT report opening or closing availability as a slot gap', () => {
    // Shift starts 09:00, first booking 11:00. Two idle hours, but that is
    // opening availability, not a gap wedged between commitments.
    const result = gaps([
      iv('2026-09-01T11:00:00Z', '2026-09-01T12:00:00Z'),
      iv('2026-09-01T12:00:00Z', '2026-09-01T13:00:00Z'),
    ]);
    expect(result).toHaveLength(0);
  });

  it('needs busy time on BOTH sides', () => {
    expect(gaps([iv('2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z')])).toHaveLength(0);
    expect(gaps([])).toHaveLength(0);
  });

  it('clips busy time to the shift so leave cannot drag a boundary outside it', () => {
    const result = gaps([
      // A whole-day leave block extending well past the shift.
      iv('2026-09-01T00:00:00Z', '2026-09-01T10:00:00Z'),
      iv('2026-09-01T10:30:00Z', '2026-09-01T23:59:00Z'),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].gapMinutes).toBe(30);
  });

  it('returns nothing for an empty or inverted shift', () => {
    expect(
      findSlotGaps(
        { staffProfileId: 'sam', shift: iv('2026-09-01T17:00:00Z', '2026-09-01T09:00:00Z'), busy: [] },
        T.slotGap,
      ),
    ).toHaveLength(0);
  });

  it('is severity info — lost capacity, never an alarm', () => {
    const result = gaps([
      iv('2026-09-01T09:00:00Z', '2026-09-01T10:00:00Z'),
      iv('2026-09-01T10:30:00Z', '2026-09-01T11:30:00Z'),
    ]);
    expect(result[0].severity).toBe('info');
  });

  it('is DST-safe because it works in absolute instants', () => {
    // The UK clocks go back at 02:00 on 2026-10-25. A shift spanning it is 9
    // wall-clock hours but 10 real hours; the gap is measured in real time.
    const shift = iv('2026-10-25T00:00:00Z', '2026-10-25T09:00:00Z');
    const result = findSlotGaps(
      {
        staffProfileId: 'sam',
        shift,
        busy: [iv('2026-10-25T00:00:00Z', '2026-10-25T01:00:00Z'), iv('2026-10-25T02:00:00Z', '2026-10-25T03:00:00Z')],
      },
      T.slotGap,
    );
    expect(result).toHaveLength(1);
    expect(result[0].gapMinutes).toBe(60);
  });
});

describe('interval merging', () => {
  it('merges overlapping and adjacent intervals', () => {
    expect(mergeIntervals([{ startMs: 0, endMs: 10 }, { startMs: 5, endMs: 20 }])).toEqual([
      { startMs: 0, endMs: 20 },
    ]);
    expect(mergeIntervals([{ startMs: 0, endMs: 10 }, { startMs: 10, endMs: 20 }])).toEqual([
      { startMs: 0, endMs: 20 },
    ]);
  });

  it('keeps genuinely separate intervals apart', () => {
    expect(mergeIntervals([{ startMs: 0, endMs: 10 }, { startMs: 15, endMs: 20 }])).toHaveLength(2);
  });

  it('drops zero-length and inverted intervals', () => {
    expect(mergeIntervals([{ startMs: 10, endMs: 10 }, { startMs: 20, endMs: 5 }])).toEqual([]);
  });

  it('is order-independent', () => {
    const a = mergeIntervals([{ startMs: 20, endMs: 30 }, { startMs: 0, endMs: 10 }]);
    const b = mergeIntervals([{ startMs: 0, endMs: 10 }, { startMs: 20, endMs: 30 }]);
    expect(a).toEqual(b);
  });

  it('absorbs a fully contained interval', () => {
    expect(mergeIntervals([{ startMs: 0, endMs: 100 }, { startMs: 20, endMs: 30 }])).toEqual([
      { startMs: 0, endMs: 100 },
    ]);
  });
});

// ===========================================================================
// Thresholds — Wrike sections 43-45
// ===========================================================================

describe('thresholds', () => {
  const business = {
    businessId: 'b1',
    locationId: null,
    ...DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS,
    slotGap: { minimumGapMinutes: 20 },
  };
  const location = {
    businessId: 'b1',
    locationId: 'loc-1',
    ...DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS,
    slotGap: { minimumGapMinutes: 45 },
    colour: { minimumBufferMinutes: 30 },
  };

  it('falls back to platform defaults', () => {
    expect(resolveOperationalSignalThresholds([], 'loc-1')).toEqual(DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS);
  });

  it('uses the business default when no location override exists', () => {
    expect(resolveOperationalSignalThresholds([business], 'loc-1').slotGap.minimumGapMinutes).toBe(20);
  });

  it('lets a location override win outright', () => {
    const resolved = resolveOperationalSignalThresholds([business, location], 'loc-1');
    expect(resolved.slotGap.minimumGapMinutes).toBe(45);
    expect(resolved.colour.minimumBufferMinutes).toBe(30);
  });

  it('does not apply an override to a different location', () => {
    expect(resolveOperationalSignalThresholds([business, location], 'loc-2').slotGap.minimumGapMinutes).toBe(20);
  });

  it('never blends scopes — the winning row is used whole', () => {
    const resolved = resolveOperationalSignalThresholds([business, location], 'loc-1');
    expect(resolved).toEqual({
      spend: location.spend,
      noShow: location.noShow,
      colour: location.colour,
      slotGap: location.slotGap,
    });
  });

  it('returns a copy, so a caller cannot mutate the shared defaults', () => {
    const resolved = resolveOperationalSignalThresholds([], null);
    resolved.slotGap.minimumGapMinutes = 999;
    expect(DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS.slotGap.minimumGapMinutes).toBe(15);
  });

  describe('validation', () => {
    it('accepts the defaults', () => {
      expect(validateOperationalSignalThresholds(DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS)).toEqual([]);
    });

    it('rejects impossible values', () => {
      const bad = {
        ...DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS,
        slotGap: { minimumGapMinutes: -200 },
      };
      expect(validateOperationalSignalThresholds(bad)).not.toEqual([]);
    });

    it('rejects fractional thresholds, which make boundaries ambiguous', () => {
      expect(
        validateOperationalSignalThresholds({
          ...DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS,
          spend: { windowVisits: 3, materialityPercent: 15.5 },
        }),
      ).not.toEqual([]);
    });

    it('rejects a medium rate above the high rate, which would make medium unreachable', () => {
      const errors = validateOperationalSignalThresholds({
        ...DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS,
        noShow: { ...DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS.noShow, mediumRatePercent: 60, highRatePercent: 30 },
      });
      expect(errors.join(' ')).toContain('cannot be higher');
    });

    it('reports every problem at once', () => {
      const errors = validateOperationalSignalThresholds({
        spend: { windowVisits: 0, materialityPercent: 0 },
        noShow: {
          lookbackDays: 0,
          minimumRelevantAppointments: 0,
          mediumRatePercent: 0,
          highRatePercent: 0,
          highNoShowCount: 0,
          mediumLateCancellationCount: 0,
        },
        colour: { minimumBufferMinutes: -1 },
        slotGap: { minimumGapMinutes: 0 },
      });
      expect(errors.length).toBeGreaterThanOrEqual(10);
    });

    it('accepts both ends of every documented bound', () => {
      for (const bounds of Object.values(OPERATIONAL_SIGNAL_BOUNDS)) {
        expect(bounds.min).toBeLessThanOrEqual(bounds.max);
      }
    });
  });
});
