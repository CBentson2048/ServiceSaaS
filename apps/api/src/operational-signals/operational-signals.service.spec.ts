/**
 * OperationalSignalsService — canonical data loading, tenancy and reporting.
 *
 * The four calculators are asserted in signal-rules.spec.ts. What these specs
 * prove is everything AROUND them: that spend comes from settled bills only,
 * that a cancellation is never counted as a no-show, that colour is resolved
 * structurally, that a lunch break closes a gap, that a client id from a URL
 * cannot cross a tenant boundary, and that a failure degrades instead of taking
 * down the diary.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser, UserRole } from '@sheer/domain';
import { ALL_PERMISSIONS, DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS } from '@sheer/domain';
import type { AuditService } from '../audit/audit.service';
import { OperationalSignalsService } from './operational-signals.service';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const BUSINESS = 'b0000000-0000-4000-8000-000000000001';
const OTHER_BUSINESS = 'b0000000-0000-4000-8000-000000000002';
const LOCATION = '10000000-0000-4000-8000-000000000001';
const OTHER_LOCATION = '10000000-0000-4000-8000-000000000002';
const CLIENT = 'c0000000-0000-4000-8000-000000000001';
const SAM = 'sam-staff-id';

type Row = Record<string, unknown>;

interface Fixture {
  bills?: Row[];
  appointments?: Row[];
  client_profiles?: Row[];
  locations?: Row[];
  location_settings?: Row[];
  businesses?: Row[];
  appointment_services?: Row[];
  services?: Row[];
  service_categories?: Row[];
  shifts?: Row[];
  shift_breaks?: Row[];
  leave_requests?: Row[];
  absence_events?: Row[];
  book_out_types?: Row[];
  operational_signal_settings?: Row[];
  readErrors?: string[];
}

interface Captured {
  table: string;
  verb: string;
  payload?: Row;
}

function build(fixture: Fixture = {}) {
  const captured: Captured[] = [];
  const tables: Record<string, Row[]> = {
    bills: fixture.bills ?? [],
    appointments: fixture.appointments ?? [],
    client_profiles: fixture.client_profiles ?? [
      { id: CLIENT, business_id: BUSINESS, primary_location_id: LOCATION, first_name: 'Jane', last_name: 'Doe' },
    ],
    locations: fixture.locations ?? [{ id: LOCATION, business_id: BUSINESS, timezone: 'Europe/London' }],
    location_settings: fixture.location_settings ?? [
      { location_id: LOCATION, cancellation_notice_hours: 48 },
    ],
    businesses: fixture.businesses ?? [{ id: BUSINESS, timezone: 'Europe/London' }],
    appointment_services: fixture.appointment_services ?? [],
    services: fixture.services ?? [],
    service_categories: fixture.service_categories ?? [],
    shifts: fixture.shifts ?? [],
    shift_breaks: fixture.shift_breaks ?? [],
    leave_requests: fixture.leave_requests ?? [],
    absence_events: fixture.absence_events ?? [],
    book_out_types: fixture.book_out_types ?? [],
    operational_signal_settings: fixture.operational_signal_settings ?? [],
  };

  const makeChain = (table: string) => {
    let rows = (tables[table] ?? []).map((row) => ({ ...row }));
    let verb = 'select';
    let payload: Row = {};

    const read = () =>
      fixture.readErrors?.includes(table)
        ? { data: null, error: { message: `${table} unavailable` } }
        : { data: rows, error: null };

    const chain: Record<string, unknown> = {};
    Object.assign(chain, {
      select: () => chain,
      order: () => chain,
      limit: () => chain,
      returns: () => chain,
      eq: (column: string, value: unknown) => {
        rows = rows.filter((row) => row[column] === value);
        return chain;
      },
      in: (column: string, values: readonly unknown[]) => {
        rows = rows.filter((row) => values.includes(row[column]));
        return chain;
      },
      not: (column: string) => {
        rows = rows.filter((row) => row[column] !== null && row[column] !== undefined);
        return chain;
      },
      gte: (column: string, value: string) => {
        rows = rows.filter((row) => String(row[column]) >= value);
        return chain;
      },
      lte: (column: string, value: string) => {
        rows = rows.filter((row) => String(row[column]) <= value);
        return chain;
      },
      gt: (column: string, value: string) => {
        rows = rows.filter((row) => String(row[column]) > value);
        return chain;
      },
      lt: (column: string, value: string) => {
        rows = rows.filter((row) => String(row[column]) < value);
        return chain;
      },
      upsert: (body: Row) => {
        verb = 'upsert';
        payload = body;
        return chain;
      },
      maybeSingle: async () => {
        if (verb !== 'select') {
          captured.push({ table, verb, payload });
          return { data: { ...payload }, error: null };
        }
        const result = read();
        return result.error ? result : { data: rows[0] ?? null, error: null };
      },
      then: (resolve: (v: unknown) => unknown, reject?: (r: unknown) => unknown) => {
        if (verb !== 'select') {
          captured.push({ table, verb, payload });
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        return Promise.resolve(read()).then(resolve, reject);
      },
    });
    return chain;
  };

  mockedCreateClient.mockReturnValue({
    schema: () => ({ from: (table: string) => makeChain(table) }),
  } as never);

  const audit = { record: jest.fn(async () => undefined) } as unknown as AuditService;
  const config = { getOrThrow: () => 'x' } as unknown as ConfigService;
  return { service: new OperationalSignalsService(config, audit), audit, captured };
}

function actor(overrides: Partial<AuthUser> = {}): AuthUser {
  const roles: UserRole[] = overrides.roles ?? ['owner'];
  return {
    id: 'u1',
    roles,
    primaryRole: roles[0],
    businessId: BUSINESS,
    allowedLocationIds: [LOCATION],
    locationScope: 'all',
    locations: [],
    profile: { firstName: 'O', lastName: 'O', email: 'o@example.com' },
    permissions: [...ALL_PERMISSIONS],
    ...overrides,
  } as AuthUser;
}

/** A settled bill, £value, N days ago. */
function bill(pounds: number, daysAgo: number, overrides: Row = {}): Row {
  return {
    client_profile_id: CLIENT,
    gross_cents: Math.round(pounds * 100),
    status: 'paid',
    business_id: BUSINESS,
    occurred_at: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
    ...overrides,
  };
}

function appointment(status: string, daysAgo: number, overrides: Row = {}): Row {
  const at = new Date(Date.now() - daysAgo * 86_400_000);
  return {
    id: `appt-${status}-${daysAgo}`,
    business_id: BUSINESS,
    location_id: LOCATION,
    client_profile_id: CLIENT,
    assigned_staff_profile_id: SAM,
    status,
    scheduled_start_at: at.toISOString(),
    scheduled_end_at: new Date(at.getTime() + 3_600_000).toISOString(),
    cancelled_at: null,
    occupied_ranges: null,
    ...overrides,
  };
}

beforeEach(() => jest.clearAllMocks());

// ===========================================================================
// Spend — canonical financial data
// ===========================================================================

describe('spend trend data', () => {
  it('derives spend from SETTLED bills', async () => {
    const { service } = build({
      bills: [
        bill(90, 180), bill(95, 150), bill(92, 120),
        bill(75, 60), bill(72, 30), bill(78, 5),
      ],
    });
    const signals = await service.clientSignals(actor(), CLIENT);
    expect(signals.spendTrend.status).toBe('falling');
    expect(signals.spendTrend.evidence?.recentVisitCount).toBe(3);
  });

  it('queries only status=paid, so a voided bill can never inflate the average', async () => {
    const { service } = build({
      bills: [
        bill(100, 180), bill(100, 150), bill(100, 120),
        bill(100, 60), bill(100, 30),
        // A voided bill for an enormous amount. The query filters it out.
        bill(10_000, 5, { status: 'voided' }),
      ],
    });
    const signals = await service.clientSignals(actor(), CLIENT);
    // Only 5 paid bills — below the 6 needed — so no trend is claimed, and
    // critically the £10,000 never reached the maths.
    expect(signals.spendTrend.status).toBe('insufficient_data');
  });

  it('scopes bills to the acting business', async () => {
    const { service } = build({
      bills: Array.from({ length: 6 }, (_, i) => bill(100, i * 10, { business_id: OTHER_BUSINESS })),
    });
    const signals = await service.clientSignals(actor(), CLIENT);
    expect(signals.spendTrend.status).toBe('insufficient_data');
  });

  it('orders windows oldest-first regardless of query order', async () => {
    // The query returns newest-first; the calculator needs oldest-first, so a
    // reversed order here would invert rising and falling.
    const { service } = build({
      bills: [
        bill(78, 5), bill(72, 30), bill(75, 60),
        bill(92, 120), bill(95, 150), bill(90, 180),
      ],
    });
    const signals = await service.clientSignals(actor(), CLIENT);
    expect(signals.spendTrend.status).toBe('falling');
  });
});

// ===========================================================================
// Attendance — status semantics
// ===========================================================================

describe('attendance classification', () => {
  it('counts awaiting_payment and paid as ATTENDED', async () => {
    const { service } = build({
      appointments: [
        appointment('paid', 30), appointment('awaiting_payment', 20),
        appointment('paid', 10), appointment('paid', 5), appointment('paid', 2),
      ],
    });
    const signals = await service.clientSignals(actor(), CLIENT);
    expect(signals.noShowRisk.evidence.attendedCount).toBe(5);
    expect(signals.noShowRisk.level).toBe('low');
  });

  it('NEVER counts a cancellation as a no-show', async () => {
    const { service } = build({
      appointments: [
        ...Array.from({ length: 6 }, (_, i) => appointment('paid', 10 + i)),
        // Cancelled well inside the 48h notice window -> an ordinary cancellation.
        appointment('cancelled', 5, {
          id: 'early-cancel',
          cancelled_at: new Date(Date.now() - 20 * 86_400_000).toISOString(),
        }),
      ],
    });
    const signals = await service.clientSignals(actor(), CLIENT);
    expect(signals.noShowRisk.evidence.noShowCount).toBe(0);
    expect(signals.noShowRisk.evidence.inNoticeCancellationCount).toBe(1);
    expect(signals.noShowRisk.level).toBe('low');
  });

  it('classifies a cancellation inside the notice window separately', async () => {
    const start = new Date(Date.now() - 5 * 86_400_000);
    const { service } = build({
      appointments: [
        ...Array.from({ length: 6 }, (_, i) => appointment('paid', 10 + i)),
        {
          ...appointment('cancelled', 5, { id: 'late-cancel' }),
          scheduled_start_at: start.toISOString(),
          // Cancelled one hour before the start — inside a 48h window.
          cancelled_at: new Date(start.getTime() - 3_600_000).toISOString(),
        },
      ],
    });
    const signals = await service.clientSignals(actor(), CLIENT);
    expect(signals.noShowRisk.evidence.lateCancellationCount).toBe(1);
    expect(signals.noShowRisk.evidence.noShowCount).toBe(0);
  });

  it('treats a cancellation with no timestamp as an ordinary cancellation', async () => {
    const { service } = build({
      appointments: [
        ...Array.from({ length: 6 }, (_, i) => appointment('paid', 10 + i)),
        appointment('cancelled', 5, { id: 'no-ts', cancelled_at: null }),
      ],
    });
    const signals = await service.clientSignals(actor(), CLIENT);
    // Conservative: never inferred to be late from anything else.
    expect(signals.noShowRisk.evidence.lateCancellationCount).toBe(0);
    expect(signals.noShowRisk.evidence.inNoticeCancellationCount).toBe(1);
  });

  it('counts no_show appointments', async () => {
    const { service } = build({
      appointments: [
        ...Array.from({ length: 5 }, (_, i) => appointment('paid', 10 + i)),
        appointment('no_show', 3, { id: 'ns1' }),
        appointment('no_show', 8, { id: 'ns2' }),
      ],
    });
    const signals = await service.clientSignals(actor(), CLIENT);
    expect(signals.noShowRisk.evidence.noShowCount).toBe(2);
    // 2 of 7 relevant = 29%, below the 30% high rate, and 2 is below the
    // 3-no-show override — so MEDIUM, not HIGH. The thresholds compose exactly
    // as documented rather than any miss escalating straight to the top.
    expect(signals.noShowRisk.evidence.noShowRatePercent).toBe(29);
    expect(signals.noShowRisk.level).toBe('medium');
  });

  it('excludes pending, accepted and rejected — none is client attendance', async () => {
    // `rejected` is the SALON declining a request, not the client missing one.
    const { service } = build({
      appointments: [
        appointment('pending', 3, { id: 'p' }),
        appointment('accepted', 4, { id: 'a' }),
        appointment('rejected', 5, { id: 'r' }),
      ],
    });
    const signals = await service.clientSignals(actor(), CLIENT);
    expect(signals.noShowRisk.evidence.relevantAppointments).toBe(0);
    expect(signals.noShowRisk.level).toBe('insufficient_data');
  });
});

// ===========================================================================
// Diary signals
// ===========================================================================

describe('diary signals', () => {
  const DAY = '2026-09-01';
  const at = (hhmm: string) => `2026-09-01T${hhmm}:00.000Z`;

  function colourService(id: string) {
    return {
      link: { appointment_id: id, service_id: 'svc-colour' },
      service: { id: 'svc-colour', business_id: BUSINESS, service_category_id: 'cat-colour' },
      category: { id: 'cat-colour', business_id: BUSINESS, billing_category: 'permanent_colour' },
    };
  }

  function diaryAppt(id: string, start: string, end: string, overrides: Row = {}): Row {
    return {
      id,
      business_id: BUSINESS,
      location_id: LOCATION,
      client_profile_id: CLIENT,
      assigned_staff_profile_id: SAM,
      status: 'accepted',
      scheduled_start_at: at(start),
      scheduled_end_at: at(end),
      occupied_ranges: `{["${at(start)}","${at(end)}")}`,
      ...overrides,
    };
  }

  it('warns on two colour appointments stacked on one stylist', async () => {
    const { service } = build({
      appointments: [diaryAppt('a', '10:00', '11:30'), diaryAppt('b', '11:30', '13:00')],
      appointment_services: [colourService('a').link, colourService('b').link],
      services: [colourService('a').service],
      service_categories: [colourService('a').category],
    });
    const signals = await service.diarySignals(actor(), LOCATION, DAY);
    expect(signals.backToBackColour).toHaveLength(1);
    expect(signals.backToBackColour[0].bufferMinutes).toBe(0);
  });

  it('identifies colour STRUCTURALLY — a colour-sounding name is not enough', async () => {
    // Both appointments carry a service whose category has NO billing_category,
    // so neither is colour work however the service happens to be named.
    const { service } = build({
      appointments: [diaryAppt('a', '10:00', '11:30'), diaryAppt('b', '11:30', '13:00')],
      appointment_services: [
        { appointment_id: 'a', service_id: 'svc-cut' },
        { appointment_id: 'b', service_id: 'svc-cut' },
      ],
      services: [{ id: 'svc-cut', business_id: BUSINESS, service_category_id: 'cat-cut' }],
      service_categories: [{ id: 'cat-cut', business_id: BUSINESS, billing_category: null }],
    });
    const signals = await service.diarySignals(actor(), LOCATION, DAY);
    expect(signals.backToBackColour).toHaveLength(0);
  });

  it('excludes cancelled and no-show appointments from the diary', async () => {
    const { service } = build({
      appointments: [
        diaryAppt('a', '10:00', '11:30'),
        diaryAppt('b', '11:30', '13:00', { status: 'cancelled' }),
        diaryAppt('c', '13:00', '14:00', { status: 'no_show' }),
      ],
      appointment_services: [colourService('a').link, colourService('b').link, colourService('c').link],
      services: [colourService('a').service],
      service_categories: [colourService('a').category],
    });
    const signals = await service.diarySignals(actor(), LOCATION, DAY);
    // A cancelled booking freed the chair, so there is no adjacent pair at all.
    expect(signals.backToBackColour).toHaveLength(0);
  });

  it('finds a genuine slot gap inside a published shift', async () => {
    const { service } = build({
      appointments: [diaryAppt('a', '09:00', '10:00'), diaryAppt('b', '10:30', '11:30')],
      shifts: [
        {
          id: 'shift-1',
          business_id: BUSINESS,
          location_id: LOCATION,
          staff_profile_id: SAM,
          status: 'published',
          scheduled_start_at: at('09:00'),
          scheduled_end_at: at('17:00'),
        },
      ],
    });
    const signals = await service.diarySignals(actor(), LOCATION, DAY);
    expect(signals.slotGaps).toHaveLength(1);
    expect(signals.slotGaps[0]).toMatchObject({ gapMinutes: 30, staffProfileId: SAM });
  });

  it('does NOT report a gap that is actually a shift break', async () => {
    const { service } = build({
      appointments: [diaryAppt('a', '09:00', '10:00'), diaryAppt('b', '10:30', '11:30')],
      shifts: [
        {
          id: 'shift-1',
          business_id: BUSINESS,
          location_id: LOCATION,
          staff_profile_id: SAM,
          status: 'published',
          scheduled_start_at: at('09:00'),
          scheduled_end_at: at('17:00'),
        },
      ],
      shift_breaks: [
        {
          shift_id: 'shift-1',
          business_id: BUSINESS,
          location_id: LOCATION,
          started_at: at('10:00'),
          ended_at: at('10:30'),
        },
      ],
    });
    const signals = await service.diarySignals(actor(), LOCATION, DAY);
    expect(signals.slotGaps).toHaveLength(0);
  });

  it('ignores draft shifts — a draft is not a commitment to be at work', async () => {
    const { service } = build({
      appointments: [diaryAppt('a', '09:00', '10:00'), diaryAppt('b', '10:30', '11:30')],
      shifts: [
        {
          id: 'shift-1',
          business_id: BUSINESS,
          location_id: LOCATION,
          staff_profile_id: SAM,
          status: 'draft',
          scheduled_start_at: at('09:00'),
          scheduled_end_at: at('17:00'),
        },
      ],
    });
    expect((await service.diarySignals(actor(), LOCATION, DAY)).slotGaps).toHaveLength(0);
  });

  it('badges only clients with a real no-show pattern', async () => {
    const { service } = build({
      appointments: [
        diaryAppt('today-1', '10:00', '11:00'),
        ...Array.from({ length: 5 }, (_, i) => appointment('paid', 10 + i)),
        appointment('no_show', 3, { id: 'ns1' }),
        appointment('no_show', 8, { id: 'ns2' }),
        appointment('no_show', 20, { id: 'ns3' }),
      ],
    });
    const signals = await service.diarySignals(actor(), LOCATION, DAY);
    expect(Object.keys(signals.noShowByAppointment)).toContain('today-1');
    expect(signals.noShowByAppointment['today-1'].level).toBe('high');
  });

  it('does not badge a client with no pattern', async () => {
    const { service } = build({
      appointments: [
        diaryAppt('today-1', '10:00', '11:00'),
        ...Array.from({ length: 6 }, (_, i) => appointment('paid', 10 + i)),
      ],
    });
    const signals = await service.diarySignals(actor(), LOCATION, DAY);
    expect(signals.noShowByAppointment).toEqual({});
  });
});

// ===========================================================================
// Tenancy
// ===========================================================================

describe('tenancy', () => {
  it('cannot read a client from another business', async () => {
    const { service } = build({
      client_profiles: [{ id: CLIENT, business_id: OTHER_BUSINESS, primary_location_id: LOCATION }],
    });
    await expect(service.clientSignals(actor(), CLIENT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('cannot read a diary at another business’s location', async () => {
    const { service } = build({
      locations: [{ id: LOCATION, business_id: OTHER_BUSINESS, timezone: 'Europe/London' }],
    });
    await expect(service.diarySignals(actor(), LOCATION)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('bounds a stylist to their own locations', async () => {
    const { service } = build({
      locations: [{ id: OTHER_LOCATION, business_id: BUSINESS, timezone: 'Europe/London' }],
    });
    const stylist = actor({ roles: ['stylist'], allowedLocationIds: [LOCATION] });
    await expect(service.diarySignals(stylist, OTHER_LOCATION)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a client account outright — these are staff-only signals', async () => {
    const { service } = build();
    const client = actor({ roles: ['client'], clientProfileId: CLIENT });
    await expect(service.clientSignals(client, CLIENT)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.diarySignals(client, LOCATION)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

// ===========================================================================
// Settings
// ===========================================================================

describe('settings', () => {
  const valid = { ...DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS };

  it('reports platform defaults when nothing is configured', async () => {
    const { service } = build();
    const settings = await service.getSettings(actor());
    expect(settings.scopes[0]).toMatchObject({ locationId: null, configured: false });
    expect(settings.defaults.slotGap.minimumGapMinutes).toBe(15);
  });

  it('rejects impossible thresholds', async () => {
    const { service } = build();
    await expect(
      service.upsertSettings(actor(), { ...valid, slotGap: { minimumGapMinutes: -200 } }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a medium rate above the high rate', async () => {
    const { service } = build();
    await expect(
      service.upsertSettings(actor(), {
        ...valid,
        noShow: { ...valid.noShow, mediumRatePercent: 80, highRatePercent: 20 },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets a manager READ but not CHANGE sensitivity', async () => {
    const manager = actor({ roles: ['manager'] });
    const { service } = build();
    await expect(service.getSettings(manager)).resolves.toBeDefined();
    await expect(service.upsertSettings(manager, valid)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('never takes businessId from the caller', async () => {
    const { service, captured } = build();
    await service.upsertSettings(actor(), { ...valid, ...({ businessId: OTHER_BUSINESS } as object) });
    expect(captured.find((c) => c.verb === 'upsert')?.payload?.['business_id']).toBe(BUSINESS);
  });

  it('records a threshold change in the shared audit trail', async () => {
    const { service, audit } = build();
    await service.upsertSettings(actor(), { ...valid, slotGap: { minimumGapMinutes: 45 } });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: BUSINESS }),
      expect.objectContaining({ action: 'operational_signal_settings.updated' }),
    );
  });

  it('applies configured thresholds to a real assessment', async () => {
    const bills = [
      bill(100, 180), bill(100, 150), bill(100, 120),
      bill(90, 60), bill(90, 30), bill(90, 5),
    ];
    // -10%: below the default 15% materiality.
    expect((await build({ bills }).service.clientSignals(actor(), CLIENT)).spendTrend.status).toBe('stable');

    // The same data under a 5% materiality is falling — computed on read, so a
    // settings change is reflected immediately with nothing to rebuild.
    const strict = build({
      bills,
      operational_signal_settings: [
        {
          business_id: BUSINESS,
          location_id: null,
          spend_window_visits: 3,
          spend_materiality_percent: 5,
          no_show_lookback_days: 365,
          no_show_minimum_appointments: 5,
          no_show_medium_rate_percent: 15,
          no_show_high_rate_percent: 30,
          no_show_high_count: 3,
          no_show_medium_late_cancellations: 3,
          colour_buffer_minutes: 15,
          slot_gap_minimum_minutes: 15,
        },
      ],
    });
    expect((await strict.service.clientSignals(actor(), CLIENT)).spendTrend.status).toBe('falling');
  });
});

// ===========================================================================
// Reporting and failure isolation
// ===========================================================================

describe('reporting', () => {
  it('returns structured counts, never rendered text', async () => {
    const { service } = build({
      appointments: [
        ...Array.from({ length: 6 }, (_, i) => appointment('paid', 10 + i)),
      ],
      bills: [
        bill(90, 180), bill(95, 150), bill(92, 120),
        bill(75, 60), bill(72, 30), bill(78, 5),
      ],
    });
    const report = await service.report(actor(), LOCATION, '2026-09-01');

    expect(report).toMatchObject({ businessId: BUSINESS, locationId: LOCATION });
    expect(typeof report.spendTrend.falling).toBe('number');
    expect(typeof report.slotGaps.totalGapMinutes).toBe('number');
    expect(typeof report.backToBackColour.warningCount).toBe('number');
    expect(report.thresholds).toBeDefined();
  });

  it('requires owner or manager', async () => {
    const { service } = build();
    await expect(service.report(actor({ roles: ['stylist'] }), LOCATION)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});

describe('failure isolation', () => {
  it('falls back to platform defaults when settings cannot be read', async () => {
    const { service } = build({ readErrors: ['operational_signal_settings'] });
    const thresholds = await service.thresholdsFor(BUSINESS, null);
    expect(thresholds).toEqual(DEFAULT_OPERATIONAL_SIGNAL_THRESHOLDS);
  });

  it('degrades client signals to undefined rather than throwing', async () => {
    const { service } = build({ readErrors: ['bills'] });
    await expect(service.clientSignalsSafe(actor(), CLIENT)).resolves.toBeUndefined();
  });

  it('degrades diary signals to undefined rather than throwing', async () => {
    const { service } = build({ readErrors: ['appointments'] });
    await expect(service.diarySignalsSafe(actor(), LOCATION)).resolves.toBeUndefined();
  });

  it('writes nothing while computing a signal', async () => {
    const { service, captured } = build({
      bills: [bill(100, 10)],
      appointments: [appointment('paid', 5)],
    });
    await service.clientSignals(actor(), CLIENT);
    // Signals inform; they never mutate. No booking is created, cancelled,
    // repriced or moved by reading one.
    expect(captured.filter((c) => c.verb !== 'select')).toHaveLength(0);
  });
});
