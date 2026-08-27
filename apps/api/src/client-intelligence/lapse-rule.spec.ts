/**
 * The lapsed-client rule matrix for the canonical calculation
 * (packages/domain evaluateClientLapse). This is the definition proof:
 *
 *   usual interval = MEDIAN gap between consecutive basis visits
 *   expected return = last basis visit + usual interval
 *   today <= expected            -> active   (due today is still active)
 *   expected < today <= +buffer  -> at_risk
 *   today > expected + buffer    -> lapsed
 *   valid upcoming appointment   -> booked (masks at_risk/lapsed only)
 *   too little history           -> insufficient_history, never a fabricated cadence
 *
 * What these specs do NOT prove: that the SQL in 0097 selects the right visits
 * (that is the service spec plus supabase/tests), or that a real appointment
 * transition reaches the API. They pin the arithmetic and the state machine.
 */
import {
  DEFAULT_LAPSE_DETECTION_SETTINGS,
  addLocalDays,
  evaluateClientLapse,
  localDaysBetween,
  medianDays,
  resolveLapseDetectionSettings,
  type ClientCompletedVisit,
  type ClientLapseInput,
  type ClientLapseResult,
  type LapseDetectionSettings,
} from '@sheer/domain';

const DAY_ZERO = '2026-01-01';
const COLOUR = 'svc-colour';
const CUT = 'svc-cut';
const WEDDING = 'svc-wedding';

const SETTINGS: LapseDetectionSettings = { ...DEFAULT_LAPSE_DETECTION_SETTINGS };

function visitAt(dayOffset: number, serviceIds: string[] = [COLOUR]): ClientCompletedVisit {
  const visitDate = addLocalDays(DAY_ZERO, dayOffset);
  return {
    visitDate,
    visitAt: `${visitDate}T10:00:00.000Z`,
    locationId: 'loc-1',
    services: serviceIds.map((serviceId) => ({
      serviceId,
      serviceName: serviceId === COLOUR ? 'Full Head Colour' : serviceId === CUT ? 'Cut & Finish' : 'Wedding Styling',
      serviceCategoryId: serviceId === WEDDING ? 'cat-occasion' : 'cat-hair',
    })),
  };
}

function run(overrides: Partial<ClientLapseInput> & { visits: ClientCompletedVisit[] }): ClientLapseResult {
  return evaluateClientLapse({
    clientId: 'client-1',
    businessId: 'biz-1',
    locationId: 'loc-1',
    nextBooking: null,
    serviceRebookingIntervalDays: null,
    today: DAY_ZERO,
    timezone: 'Europe/London',
    settings: SETTINGS,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Core cadence
// ---------------------------------------------------------------------------

describe('usual booking interval', () => {
  it('derives a stable cadence from evenly spaced visits', () => {
    // Day 0, 42, 84, 126 -> 42 / 42 / 42
    const result = run({ visits: [0, 42, 84, 126].map((d) => visitAt(d)), today: addLocalDays(DAY_ZERO, 126) });

    expect(result.usualIntervalDays).toBe(42);
    expect(result.evidence.intervalDaysSamples).toEqual([42, 42, 42]);
    expect(result.expectedNextVisitAt).toBe(addLocalDays(DAY_ZERO, 168));
    expect(result.historySampleSize).toBe(4);
  });

  it('takes the median of an uneven cadence', () => {
    // Intervals 40 / 44 / 42 -> median 42, not the 42 mean by coincidence:
    // the sorted middle value is what is returned.
    const result = run({ visits: [0, 40, 84, 126].map((d) => visitAt(d)), today: addLocalDays(DAY_ZERO, 126) });

    expect(result.evidence.intervalDaysSamples).toEqual([40, 44, 42]);
    expect(result.usualIntervalDays).toBe(42);
  });

  it('does not let one extreme gap destroy an otherwise stable cadence', () => {
    // Intervals 42 / 42 / 120 / 43. A mean would give 61.75 — nearly a month of
    // drift from one holiday. The median gives 43.
    const visits = [0, 42, 84, 204, 247].map((d) => visitAt(d));
    const result = run({ visits, today: addLocalDays(DAY_ZERO, 247) });

    expect(result.evidence.intervalDaysSamples).toEqual([42, 42, 120, 43]);
    expect(result.usualIntervalDays).toBe(43);
    expect(result.confidence).toBe('high');
  });

  it('collapses several services on one day into a single visit', () => {
    // Colour and a cut booked as two appointments on the same Tuesday is ONE
    // return. Without the collapse the 0-day gap would halve the median.
    const visits = [
      visitAt(0, [COLOUR]),
      visitAt(0, [CUT]),
      visitAt(42, [COLOUR]),
      visitAt(84, [COLOUR]),
      visitAt(126, [COLOUR]),
    ];
    const result = run({ visits, today: addLocalDays(DAY_ZERO, 126) });

    expect(result.evidence.intervalDaysSamples).toEqual([42, 42, 42]);
    expect(result.evidence.totalVisitsConsidered).toBe(4);
  });

  it('ignores visits dated after today', () => {
    const visits = [...[0, 42, 84].map((d) => visitAt(d)), visitAt(400)];
    const result = run({ visits, today: addLocalDays(DAY_ZERO, 84) });

    expect(result.evidence.totalVisitsConsidered).toBe(3);
    expect(result.lastCompletedVisitAt).toBe(`${addLocalDays(DAY_ZERO, 84)}T10:00:00.000Z`);
  });

  it('keeps only the most recent historyVisitLimit visits', () => {
    const visits = Array.from({ length: 14 }, (_, i) => visitAt(i * 30));
    const result = run({
      visits,
      today: addLocalDays(DAY_ZERO, 13 * 30),
      settings: { ...SETTINGS, historyVisitLimit: 5 },
    });

    expect(result.historySampleSize).toBe(5);
    expect(result.evidence.intervalDaysSamples).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// Insufficient history — honesty over classification
// ---------------------------------------------------------------------------

describe('insufficient history', () => {
  it('reports insufficient_history for a client with no completed visits', () => {
    const result = run({ visits: [] });

    expect(result.status).toBe('insufficient_history');
    expect(result.usualIntervalDays).toBeNull();
    expect(result.expectedNextVisitAt).toBeNull();
    expect(result.lastCompletedVisitAt).toBeNull();
    expect(result.confidence).toBeNull();
    expect(result.evidence.insufficientReason).toBe('no_completed_visits');
  });

  it('reports insufficient_history for a client with one completed visit', () => {
    const result = run({ visits: [visitAt(0)], today: addLocalDays(DAY_ZERO, 500) });

    expect(result.status).toBe('insufficient_history');
    expect(result.usualIntervalDays).toBeNull();
    expect(result.overdueDays).toBe(0);
    expect(result.evidence.insufficientReason).toBe('below_minimum_visits');
  });

  it('reports insufficient_history at one visit below the configured minimum', () => {
    const result = run({ visits: [visitAt(0), visitAt(42)], today: addLocalDays(DAY_ZERO, 42) });

    expect(result.status).toBe('insufficient_history');
    expect(result.evidence.insufficientReason).toBe('below_minimum_visits');
  });

  it('derives a cadence at exactly the configured minimum', () => {
    const result = run({ visits: [visitAt(0), visitAt(42), visitAt(84)], today: addLocalDays(DAY_ZERO, 84) });

    expect(result.status).toBe('active');
    expect(result.usualIntervalDays).toBe(42);
    expect(result.historySampleSize).toBe(3);
    expect(result.confidence).toBe('medium');
  });

  it('honours a lowered minimum of two visits (one measured interval)', () => {
    const result = run({
      visits: [visitAt(0), visitAt(42)],
      today: addLocalDays(DAY_ZERO, 42),
      settings: { ...SETTINGS, minCompletedVisits: 2 },
    });

    expect(result.usualIntervalDays).toBe(42);
    expect(result.confidence).toBe('low');
  });

  it('uses a salon-configured service rebooking interval as the fallback', () => {
    // 0062's per-service nudge interval is a real product decision, so it beats
    // "we don't know" for a client with only one visit.
    const result = run({
      visits: [visitAt(0)],
      serviceRebookingIntervalDays: 35,
      today: addLocalDays(DAY_ZERO, 10),
    });

    expect(result.status).toBe('active');
    expect(result.usualIntervalDays).toBe(35);
    expect(result.expectedNextVisitAt).toBe(addLocalDays(DAY_ZERO, 35));
    expect(result.evidence.intervalBasis).toBe('service_rebooking_interval');
    expect(result.confidence).toBe('low');
    expect(result.historySampleSize).toBe(1);
  });

  it('never invents an interval when no service has opted in', () => {
    const result = run({ visits: [visitAt(0)], serviceRebookingIntervalDays: null });

    expect(result.status).toBe('insufficient_history');
    expect(result.evidence.intervalBasis).toBe('none');
  });

  it('prefers real personal history over the service fallback', () => {
    const result = run({
      visits: [0, 42, 84].map((d) => visitAt(d)),
      serviceRebookingIntervalDays: 35,
      today: addLocalDays(DAY_ZERO, 84),
    });

    expect(result.usualIntervalDays).toBe(42);
    expect(result.evidence.intervalBasis).toBe('dominant_service_history');
  });

  it('does not apply the service fallback to a client with no visits at all', () => {
    const result = run({ visits: [], serviceRebookingIntervalDays: 35 });

    expect(result.status).toBe('insufficient_history');
    expect(result.expectedNextVisitAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

describe('lapse status', () => {
  const HISTORY = [0, 42, 84].map((d) => visitAt(d)); // expected return = day 126

  function statusOn(dayOffset: number, settings: LapseDetectionSettings = SETTINGS) {
    return run({ visits: HISTORY, today: addLocalDays(DAY_ZERO, dayOffset), settings });
  }

  it('is active before the expected return date', () => {
    const result = statusOn(120);
    expect(result.status).toBe('active');
    expect(result.overdueDays).toBe(0);
  });

  it('is active on the expected return date itself', () => {
    // The deterministic rule: due TODAY is not yet overdue. The client has the
    // whole day to walk in.
    const result = statusOn(126);
    expect(result.expectedNextVisitAt).toBe(addLocalDays(DAY_ZERO, 126));
    expect(result.status).toBe('active');
    expect(result.overdueDays).toBe(0);
  });

  it('is at_risk on the first day past the expected return', () => {
    const result = statusOn(127);
    expect(result.status).toBe('at_risk');
    expect(result.overdueDays).toBe(1);
  });

  it('is at_risk on the exact buffer boundary', () => {
    const result = statusOn(126 + SETTINGS.lapsedBufferDays);
    expect(result.overdueDays).toBe(SETTINGS.lapsedBufferDays);
    expect(result.status).toBe('at_risk');
  });

  it('is lapsed one day past the buffer', () => {
    const result = statusOn(126 + SETTINGS.lapsedBufferDays + 1);
    expect(result.overdueDays).toBe(SETTINGS.lapsedBufferDays + 1);
    expect(result.status).toBe('lapsed');
  });

  it('stays lapsed for a very overdue client and reports the true overdue days', () => {
    const result = statusOn(126 + 400);
    expect(result.status).toBe('lapsed');
    expect(result.overdueDays).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

describe('configurable buffer', () => {
  const HISTORY = [0, 42, 84].map((d) => visitAt(d)); // expected return = day 126

  it('lapses immediately when the buffer is zero', () => {
    // 0 is a real decision, not "unset": there is no grace period at all.
    const result = run({
      visits: HISTORY,
      today: addLocalDays(DAY_ZERO, 127),
      settings: { ...SETTINGS, lapsedBufferDays: 0 },
    });

    expect(result.status).toBe('lapsed');
    expect(result.lapsedBufferDays).toBe(0);
  });

  it('is still active on the expected date even with a zero buffer', () => {
    const result = run({
      visits: HISTORY,
      today: addLocalDays(DAY_ZERO, 126),
      settings: { ...SETTINGS, lapsedBufferDays: 0 },
    });

    expect(result.status).toBe('active');
  });

  it('keeps a client at_risk for longer under a larger buffer', () => {
    const result = run({
      visits: HISTORY,
      today: addLocalDays(DAY_ZERO, 126 + 40),
      settings: { ...SETTINGS, lapsedBufferDays: 60 },
    });

    expect(result.status).toBe('at_risk');
    expect(result.lapsedBufferDays).toBe(60);
  });

  it('echoes the buffer that was actually applied', () => {
    const result = run({
      visits: HISTORY,
      today: addLocalDays(DAY_ZERO, 126),
      settings: { ...SETTINGS, lapsedBufferDays: 7 },
    });
    expect(result.lapsedBufferDays).toBe(7);
  });
});

describe('settings resolution', () => {
  const rows = [
    { businessId: 'biz-1', locationId: null, lapsedBufferDays: 21, minCompletedVisits: 4 },
    { businessId: 'biz-1', locationId: 'loc-2', lapsedBufferDays: 0, minCompletedVisits: 2 },
  ];

  it('falls back to the platform defaults when nothing is configured', () => {
    expect(resolveLapseDetectionSettings([], null)).toEqual(DEFAULT_LAPSE_DETECTION_SETTINGS);
  });

  it('uses the business-wide row when no location is scoped', () => {
    expect(resolveLapseDetectionSettings(rows, null).lapsedBufferDays).toBe(21);
  });

  it('uses the business-wide row for a location with no override', () => {
    expect(resolveLapseDetectionSettings(rows, 'loc-1').lapsedBufferDays).toBe(21);
  });

  it('prefers a location override over the business default', () => {
    const resolved = resolveLapseDetectionSettings(rows, 'loc-2');
    expect(resolved.lapsedBufferDays).toBe(0);
    expect(resolved.minCompletedVisits).toBe(2);
  });

  it('treats a stored zero as an override, not as missing configuration', () => {
    const zeroOnly = [
      { businessId: 'biz-1', locationId: null, lapsedBufferDays: 0, minCompletedVisits: 3 },
    ];
    expect(resolveLapseDetectionSettings(zeroOnly, null).lapsedBufferDays).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Future bookings
// ---------------------------------------------------------------------------

describe('upcoming appointments', () => {
  const HISTORY = [0, 42, 84].map((d) => visitAt(d)); // expected return = day 126
  const BOOKING = {
    appointmentId: 'appt-next',
    scheduledStartAt: '2026-06-01T09:00:00.000Z',
    locationId: 'loc-1',
  };

  it('masks a lapsed client who has already rebooked', () => {
    const result = run({
      visits: HISTORY,
      today: addLocalDays(DAY_ZERO, 200),
      nextBooking: BOOKING,
    });

    expect(result.status).toBe('booked');
    expect(result.hasFutureBooking).toBe(true);
    expect(result.nextBookedAppointmentAt).toBe(BOOKING.scheduledStartAt);
    // The underlying overdue reality is preserved, not erased.
    expect(result.evidence.statusIgnoringFutureBooking).toBe('lapsed');
    expect(result.overdueDays).toBe(74);
  });

  it('masks an at_risk client who has already rebooked', () => {
    const result = run({ visits: HISTORY, today: addLocalDays(DAY_ZERO, 130), nextBooking: BOOKING });

    expect(result.status).toBe('booked');
    expect(result.evidence.statusIgnoringFutureBooking).toBe('at_risk');
  });

  it('leaves an on-cadence client active rather than calling them booked', () => {
    // `active` must keep meaning "on cadence", otherwise the list cannot tell a
    // healthy client from an overdue one who happens to have rebooked.
    const result = run({ visits: HISTORY, today: addLocalDays(DAY_ZERO, 100), nextBooking: BOOKING });

    expect(result.status).toBe('active');
    expect(result.hasFutureBooking).toBe(true);
  });

  it('does not mask insufficient history', () => {
    const result = run({ visits: [visitAt(0)], nextBooking: BOOKING });

    expect(result.status).toBe('insufficient_history');
    expect(result.hasFutureBooking).toBe(true);
  });

  it('returns to lapsed once the upcoming appointment is gone', () => {
    // A cancelled future appointment is filtered out upstream, so the same
    // client arrives here with nextBooking = null and must lapse again.
    const booked = run({ visits: HISTORY, today: addLocalDays(DAY_ZERO, 200), nextBooking: BOOKING });
    const cancelled = run({ visits: HISTORY, today: addLocalDays(DAY_ZERO, 200), nextBooking: null });

    expect(booked.status).toBe('booked');
    expect(cancelled.status).toBe('lapsed');
    expect(cancelled.hasFutureBooking).toBe(false);
    expect(cancelled.nextBookedAppointmentAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Service-aware behaviour
// ---------------------------------------------------------------------------

describe('service history', () => {
  it('uses the dominant service when the client has one recurring service', () => {
    const result = run({ visits: [0, 42, 84, 126].map((d) => visitAt(d, [COLOUR])), today: addLocalDays(DAY_ZERO, 126) });

    expect(result.evidence.intervalBasis).toBe('dominant_service_history');
    expect(result.representativeServiceId).toBe(COLOUR);
    expect(result.representativeServiceName).toBe('Full Head Colour');
    expect(result.serviceCategoryId).toBe('cat-hair');
  });

  it('keeps the recurring cadence when a one-off service is mixed into history', () => {
    // Colour every 42 days, plus a one-off wedding styling 10 days after the
    // last colour. Averaging everything would report a 26-day cadence and make
    // the client look overdue weeks early.
    const visits = [
      visitAt(0, [COLOUR]),
      visitAt(42, [COLOUR]),
      visitAt(84, [COLOUR]),
      visitAt(126, [COLOUR]),
      visitAt(136, [WEDDING]),
    ];
    const result = run({ visits, today: addLocalDays(DAY_ZERO, 136) });

    expect(result.evidence.intervalBasis).toBe('dominant_service_history');
    expect(result.usualIntervalDays).toBe(42);
    expect(result.representativeServiceId).toBe(COLOUR);
    // Anchored on the last COLOUR visit, not on the wedding styling.
    expect(result.evidence.anchorVisitDate).toBe(addLocalDays(DAY_ZERO, 126));
    expect(result.expectedNextVisitAt).toBe(addLocalDays(DAY_ZERO, 168));
    // The client's actual last visit is still reported truthfully.
    expect(result.lastCompletedVisitAt).toBe(`${addLocalDays(DAY_ZERO, 136)}T10:00:00.000Z`);
  });

  it('counts a multi-service appointment once per service for dominance', () => {
    const visits = [
      visitAt(0, [COLOUR, CUT]),
      visitAt(42, [COLOUR, CUT]),
      visitAt(84, [COLOUR, CUT]),
      visitAt(126, [COLOUR]),
    ];
    const result = run({ visits, today: addLocalDays(DAY_ZERO, 126) });

    // Colour appears in 4 visits, cut in 3 — colour wins outright.
    expect(result.representativeServiceId).toBe(COLOUR);
    expect(result.evidence.dominantServiceVisitCount).toBe(4);
    expect(result.usualIntervalDays).toBe(42);
  });

  it('picks the more recent service when two are equally frequent', () => {
    const visits = [
      visitAt(0, [CUT]),
      visitAt(30, [CUT]),
      visitAt(60, [CUT]),
      visitAt(20, [COLOUR]),
      visitAt(50, [COLOUR]),
      visitAt(80, [COLOUR]),
    ];
    const result = run({ visits, today: addLocalDays(DAY_ZERO, 80) });

    expect(result.representativeServiceId).toBe(COLOUR);
  });

  it('falls back to all visits when no service repeats often enough', () => {
    const visits = [
      visitAt(0, [COLOUR]),
      visitAt(42, [CUT]),
      visitAt(84, [WEDDING]),
      visitAt(126, ['svc-treatment']),
    ];
    const result = run({ visits, today: addLocalDays(DAY_ZERO, 126) });

    expect(result.evidence.intervalBasis).toBe('all_visit_history');
    expect(result.usualIntervalDays).toBe(42);
  });

  it('falls back to all visits when the dominant service is below the minimum', () => {
    const visits = [
      visitAt(0, [COLOUR]),
      visitAt(42, [COLOUR]),
      visitAt(84, [CUT]),
      visitAt(126, [WEDDING]),
    ];
    const result = run({ visits, today: addLocalDays(DAY_ZERO, 126) });

    expect(result.evidence.dominantServiceVisitCount).toBe(2); // colour, below min 3
    expect(result.evidence.intervalBasis).toBe('all_visit_history');
    expect(result.historySampleSize).toBe(4);
  });

  it('keeps the historic snapshot name for a service that was later renamed', () => {
    // service_name_snapshot is what the appointment recorded; it is never
    // re-resolved, so a deactivated or renamed service still reads correctly.
    const visits = [0, 42, 84].map((d) => ({
      ...visitAt(d, [COLOUR]),
      services: [
        { serviceId: COLOUR, serviceName: 'Full Head Tint (2024 menu)', serviceCategoryId: 'cat-hair' },
      ],
    }));
    const result = run({ visits, today: addLocalDays(DAY_ZERO, 84) });

    expect(result.representativeServiceName).toBe('Full Head Tint (2024 menu)');
  });

  it('handles a visit with no service lines at all', () => {
    // Walk-in visits exist with no appointment and therefore no service rows.
    const visits = [0, 42, 84].map((d) => ({ ...visitAt(d), services: [] }));
    const result = run({ visits, today: addLocalDays(DAY_ZERO, 84) });

    expect(result.evidence.intervalBasis).toBe('all_visit_history');
    expect(result.usualIntervalDays).toBe(42);
    expect(result.representativeServiceId).toBeNull();
  });

  it('reports the current category of the representative service', () => {
    const visits = [0, 42, 84].map((d) => ({
      ...visitAt(d, [COLOUR]),
      services: [{ serviceId: COLOUR, serviceName: 'Colour', serviceCategoryId: 'cat-new' }],
    }));
    expect(run({ visits, today: addLocalDays(DAY_ZERO, 84) }).serviceCategoryId).toBe('cat-new');
  });
});

// ---------------------------------------------------------------------------
// Recomputation
// ---------------------------------------------------------------------------

describe('recomputation', () => {
  it('recomputes the cadence and expected return when a new visit completes', () => {
    const before = run({ visits: [0, 42, 84].map((d) => visitAt(d)), today: addLocalDays(DAY_ZERO, 200) });
    expect(before.status).toBe('lapsed');
    expect(before.expectedNextVisitAt).toBe(addLocalDays(DAY_ZERO, 126));

    // The client comes back on day 200 — a 116-day gap.
    const after = run({
      visits: [0, 42, 84, 200].map((d) => visitAt(d)),
      today: addLocalDays(DAY_ZERO, 200),
    });

    expect(after.status).toBe('active');
    expect(after.evidence.intervalDaysSamples).toEqual([42, 42, 116]);
    expect(after.usualIntervalDays).toBe(42); // median resists the one long gap
    expect(after.expectedNextVisitAt).toBe(addLocalDays(DAY_ZERO, 242));
    expect(after.overdueDays).toBe(0);
  });

  it('walks lapsed -> booked -> lapsed -> active across the full lifecycle', () => {
    const history = [0, 42, 84].map((d) => visitAt(d));
    const today = addLocalDays(DAY_ZERO, 200);
    const booking = { appointmentId: 'a1', scheduledStartAt: '2026-08-01T09:00:00.000Z', locationId: 'loc-1' };

    expect(run({ visits: history, today }).status).toBe('lapsed');
    expect(run({ visits: history, today, nextBooking: booking }).status).toBe('booked');
    expect(run({ visits: history, today, nextBooking: null }).status).toBe('lapsed');
    expect(run({ visits: [...history, visitAt(200)], today }).status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// Evidence and date safety
// ---------------------------------------------------------------------------

describe('evidence', () => {
  it('carries everything needed to explain the status without prose', () => {
    const result = run({ visits: [0, 42, 84].map((d) => visitAt(d)), today: addLocalDays(DAY_ZERO, 140) });

    expect(result.evidence).toMatchObject({
      intervalBasis: 'dominant_service_history',
      intervalDaysSamples: [42, 42],
      anchorVisitDate: addLocalDays(DAY_ZERO, 84),
      basisVisitDates: [DAY_ZERO, addLocalDays(DAY_ZERO, 42), addLocalDays(DAY_ZERO, 84)],
      totalVisitsConsidered: 3,
      statusIgnoringFutureBooking: 'at_risk',
      evaluatedOn: addLocalDays(DAY_ZERO, 140),
      timezone: 'Europe/London',
    });
    // "Normally returns every 42 days. Last visit 25 March. Expected 6 May.
    //  14 days overdue." — assembled by the presentation layer from these.
    expect(result.usualIntervalDays).toBe(42);
    expect(result.expectedNextVisitAt).toBe(addLocalDays(DAY_ZERO, 126));
    expect(result.overdueDays).toBe(14);
  });

  it('omits the insufficient reason when a cadence was derived', () => {
    const result = run({ visits: [0, 42, 84].map((d) => visitAt(d)), today: addLocalDays(DAY_ZERO, 84) });
    expect(result.evidence.insufficientReason).toBeUndefined();
  });
});

describe('local date arithmetic', () => {
  it('counts whole calendar days across a spring DST transition', () => {
    // Europe/London springs forward on 2026-03-29. A naive 24h-based subtraction
    // would report 6.958 days here and truncate to 6.
    expect(localDaysBetween('2026-03-26', '2026-04-02')).toBe(7);
    expect(addLocalDays('2026-03-26', 7)).toBe('2026-04-02');
  });

  it('counts whole calendar days across an autumn DST transition', () => {
    // Clocks go back 2026-10-25.
    expect(localDaysBetween('2026-10-22', '2026-10-29')).toBe(7);
    expect(addLocalDays('2026-10-22', 7)).toBe('2026-10-29');
  });

  it('crosses month and year boundaries', () => {
    expect(addLocalDays('2026-12-20', 42)).toBe('2027-01-31');
    expect(localDaysBetween('2026-12-20', '2027-01-31')).toBe(42);
  });

  it('handles a leap day', () => {
    expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(localDaysBetween('2028-02-28', '2028-03-01')).toBe(2);
  });

  it('produces a status that does not shift across a DST boundary', () => {
    const visits = ['2026-01-11', '2026-02-22', '2026-04-05'].map((visitDate) => ({
      visitDate,
      visitAt: `${visitDate}T10:00:00.000Z`,
      locationId: 'loc-1',
      services: [{ serviceId: COLOUR, serviceName: 'Colour', serviceCategoryId: 'cat-hair' }],
    }));
    // 11 Jan -> 22 Feb = 42 days; 22 Feb -> 5 Apr = 42 days (spanning the
    // 29 March clock change). Expected return: 17 May.
    const result = run({ visits, today: '2026-05-17' });

    expect(result.evidence.intervalDaysSamples).toEqual([42, 42]);
    expect(result.expectedNextVisitAt).toBe('2026-05-17');
    expect(result.status).toBe('active');
  });
});

describe('medianDays', () => {
  it('returns the middle value for an odd sample', () => {
    expect(medianDays([40, 44, 42])).toBe(42);
  });

  it('averages the two middle values for an even sample and rounds half up', () => {
    expect(medianDays([42, 42, 43, 120])).toBe(43);
    expect(medianDays([40, 42])).toBe(41);
    expect(medianDays([41, 42])).toBe(42);
  });

  it('is order independent', () => {
    expect(medianDays([120, 42, 43, 42])).toBe(medianDays([42, 42, 43, 120]));
  });

  it('returns the single value for a one-element sample', () => {
    expect(medianDays([57])).toBe(57);
  });

  it('refuses an empty sample rather than inventing a cadence', () => {
    expect(() => medianDays([])).toThrow();
  });
});
