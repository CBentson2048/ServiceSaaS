import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { AuthUser } from '@sheer/domain';
import {
  createSupabaseFake,
  createSupabaseFakeState,
  type SupabaseFakeState,
} from '../common/testing/supabase-fake';
import { UtilisationService } from './utilisation.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => {
    return (globalThis as { __supabaseFake?: unknown }).__supabaseFake;
  }),
}));

// Fixed clock: Wednesday 2026-08-12 → 'week' = Mon 2026-08-10 .. Mon 2026-08-17 (UTC).
const NOW = new Date('2026-08-12T12:00:00.000Z');

function makeService(state: SupabaseFakeState): UtilisationService {
  (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
  const config = {
    getOrThrow: jest.fn((key: string) => `fake-${key}`),
  } as unknown as ConfigService;
  return new UtilisationService(config);
}

function owner(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user-1',
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: 'biz-1',
    allowedLocationIds: ['loc-1', 'loc-2'],
    locations: [
      { id: 'loc-1', name: 'Main' },
      { id: 'loc-2', name: 'Second' },
    ],
    profile: { id: 'p1', email: 'o@example.com', fullName: 'Owner One' },
    permissions: ['zac.access', 'report.performance.view'],
    ...overrides,
  } as AuthUser;
}

function manager(overrides: Partial<AuthUser> = {}): AuthUser {
  return owner({
    roles: ['manager'],
    primaryRole: 'manager',
    allowedLocationIds: ['loc-1'],
    ...overrides,
  });
}

/** One multirange literal covering a single occupied window. */
function occupied(startIso: string, endIso: string): string {
  return `{["${startIso}","${endIso}")}`;
}

/**
 * Canonical seed, mirroring the domain spec's worked example on Tue 2026-08-11:
 * 09:00–18:00 shift (9h), 30-minute lunch break, a 1h staff meeting that
 * reduces available hours, and 6h of booked appointments → available 7.5h,
 * utilisation 80%.
 */
function canonicalSeed(): Record<string, Record<string, unknown>[]> {
  return {
    'core.locations': [
      { id: 'loc-1', business_id: 'biz-1', name: 'Main' },
      { id: 'loc-2', business_id: 'biz-1', name: 'Second' },
      { id: 'loc-9', business_id: 'biz-2', name: 'Rival' },
    ],
    'core.staff_profiles': [
      { id: 'staff-1', business_id: 'biz-1', display_name: 'Maya Chen' },
      { id: 'staff-9', business_id: 'biz-2', display_name: 'Rival Stylist' },
    ],
    'core.location_settings': [
      { location_id: 'loc-1', utilisation_warning_threshold_percent: 60 },
    ],
    'rota.book_out_types': [
      {
        id: 'bot-meeting',
        business_id: 'biz-1',
        blocks_appointments: true,
        reduces_available_hours: true,
        counts_as_paid_time: true,
      },
      {
        id: 'bot-admin',
        business_id: 'biz-1',
        blocks_appointments: true,
        reduces_available_hours: false,
        counts_as_paid_time: true,
      },
    ],
    'rota.shifts': [
      {
        id: 'shift-1',
        business_id: 'biz-1',
        location_id: 'loc-1',
        staff_profile_id: 'staff-1',
        status: 'published',
        scheduled_start_at: '2026-08-11T09:00:00.000Z',
        scheduled_end_at: '2026-08-11T18:00:00.000Z',
      },
    ],
    'rota.shift_breaks': [
      {
        id: 'brk-1',
        business_id: 'biz-1',
        shift_id: 'shift-1',
        started_at: '2026-08-11T13:00:00.000Z',
        ended_at: '2026-08-11T13:30:00.000Z',
      },
    ],
    'rota.absence_events': [
      {
        id: 'abs-1',
        business_id: 'biz-1',
        location_id: 'loc-1',
        staff_profile_id: 'staff-1',
        starts_at: '2026-08-11T11:00:00.000Z',
        ends_at: '2026-08-11T12:00:00.000Z',
        book_out_type_id: 'bot-meeting',
      },
    ],
    'rota.leave_requests': [],
    'booking.appointments': [
      {
        id: 'appt-1',
        business_id: 'biz-1',
        location_id: 'loc-1',
        assigned_staff_profile_id: 'staff-1',
        status: 'accepted',
        scheduled_start_at: '2026-08-11T09:00:00.000Z',
        scheduled_end_at: '2026-08-11T11:00:00.000Z',
        occupied_ranges: occupied('2026-08-11T09:00:00.000Z', '2026-08-11T11:00:00.000Z'),
      },
      {
        id: 'appt-2',
        business_id: 'biz-1',
        location_id: 'loc-1',
        assigned_staff_profile_id: 'staff-1',
        status: 'paid',
        scheduled_start_at: '2026-08-11T14:00:00.000Z',
        scheduled_end_at: '2026-08-11T18:00:00.000Z',
        occupied_ranges: occupied('2026-08-11T14:00:00.000Z', '2026-08-11T18:00:00.000Z'),
      },
      // Cancelled — must NOT count.
      {
        id: 'appt-3',
        business_id: 'biz-1',
        location_id: 'loc-1',
        assigned_staff_profile_id: 'staff-1',
        status: 'cancelled',
        scheduled_start_at: '2026-08-11T12:00:00.000Z',
        scheduled_end_at: '2026-08-11T13:00:00.000Z',
        occupied_ranges: occupied('2026-08-11T12:00:00.000Z', '2026-08-11T13:00:00.000Z'),
      },
    ],
  };
}

describe('UtilisationService', () => {
  beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['queueMicrotask'] });
    jest.setSystemTime(NOW);
  });
  afterAll(() => {
    jest.useRealTimers();
  });

  it('reproduces the canonical domain example: 6h booked of 7.5h available = 80%', async () => {
    const service = makeService(createSupabaseFakeState(canonicalSeed()));

    const summary = await service.summary(owner(), { period: 'week' });

    expect(summary.overall.availableMinutes).toBe(450); // 7.5h
    expect(summary.overall.bookedMinutes).toBe(360); // 6h
    expect(summary.overall.utilisationPercent).toBe(80);
    expect(summary.warningThresholdPercent).toBeNull(); // multi-location scope
    expect(summary.byWeekday.find((d) => d.weekday === 'Tuesday')?.utilisationPercent).toBe(80);
  });

  it('does not subtract non-reducing book-outs from available hours', async () => {
    const seed = canonicalSeed();
    (seed['rota.absence_events'][0] as Record<string, unknown>)['book_out_type_id'] = 'bot-admin';
    const service = makeService(createSupabaseFakeState(seed));

    const summary = await service.summary(owner(), { period: 'week' });

    // Available back to 8.5h (only the lunch break reduces) → 360/510 = 71%.
    expect(summary.overall.availableMinutes).toBe(510);
    expect(summary.overall.utilisationPercent).toBe(71);
  });

  it('treats a legacy absence with no book-out type as reducing (LEGACY behaviour)', async () => {
    const seed = canonicalSeed();
    (seed['rota.absence_events'][0] as Record<string, unknown>)['book_out_type_id'] = null;
    const service = makeService(createSupabaseFakeState(seed));

    const summary = await service.summary(owner(), { period: 'week' });
    expect(summary.overall.availableMinutes).toBe(450);
  });

  it('excludes approved-leave days entirely (web calendar parity)', async () => {
    const seed = canonicalSeed();
    seed['rota.leave_requests'] = [
      {
        id: 'leave-1',
        business_id: 'biz-1',
        location_id: 'loc-1',
        staff_profile_id: 'staff-1',
        status: 'approved',
        start_date: '2026-08-11',
        end_date: '2026-08-11',
      },
    ];
    const service = makeService(createSupabaseFakeState(seed));

    const summary = await service.summary(owner(), { period: 'week' });
    expect(summary.overall.availableMinutes).toBe(0);
    expect(summary.overall.utilisationPercent).toBeNull();
  });

  it('surfaces the largest unbooked available window as a diary gap', async () => {
    const service = makeService(createSupabaseFakeState(canonicalSeed()));

    const summary = await service.summary(owner(), { period: 'week' });

    // Free available time: 12:00–13:00 and 13:30–14:00 → largest gap is 60m.
    expect(summary.largestGaps[0]).toMatchObject({
      staffName: 'Maya Chen',
      weekday: 'Tuesday',
      date: '2026-08-11',
      minutes: 60,
    });
  });

  it('scopes managers to their assigned locations and rejects foreign focus', async () => {
    const seed = canonicalSeed();
    // A second-location shift the manager (loc-1 only) must never see.
    seed['rota.shifts'].push({
      id: 'shift-2',
      business_id: 'biz-1',
      location_id: 'loc-2',
      staff_profile_id: 'staff-1',
      status: 'published',
      scheduled_start_at: '2026-08-12T09:00:00.000Z',
      scheduled_end_at: '2026-08-12T17:00:00.000Z',
    });
    const service = makeService(createSupabaseFakeState(seed));

    const summary = await service.summary(manager(), { period: 'week' });
    expect(summary.locations.map((location) => location.id)).toEqual(['loc-1']);
    expect(summary.overall.availableMinutes).toBe(450); // loc-2 shift excluded

    await expect(service.summary(manager(), { locationId: 'loc-2' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('returns the warning threshold when a single location is in focus', async () => {
    const service = makeService(createSupabaseFakeState(canonicalSeed()));

    const summary = await service.summary(owner(), { period: 'week', locationId: 'loc-1' });
    expect(summary.warningThresholdPercent).toBe(60);
  });

  it('never crosses a business boundary', async () => {
    const seed = canonicalSeed();
    seed['rota.shifts'].push({
      id: 'shift-9',
      business_id: 'biz-2',
      location_id: 'loc-9',
      staff_profile_id: 'staff-9',
      status: 'published',
      scheduled_start_at: '2026-08-11T09:00:00.000Z',
      scheduled_end_at: '2026-08-11T18:00:00.000Z',
    });
    seed['booking.appointments'].push({
      id: 'appt-9',
      business_id: 'biz-2',
      location_id: 'loc-9',
      assigned_staff_profile_id: 'staff-9',
      status: 'paid',
      scheduled_start_at: '2026-08-11T09:00:00.000Z',
      scheduled_end_at: '2026-08-11T18:00:00.000Z',
      occupied_ranges: occupied('2026-08-11T09:00:00.000Z', '2026-08-11T18:00:00.000Z'),
    });
    const service = makeService(createSupabaseFakeState(seed));

    const summary = await service.summary(owner(), { period: 'week' });
    expect(summary.overall.availableMinutes).toBe(450);
    expect(summary.overall.bookedMinutes).toBe(360);
  });

  it('is honest when there is no rota to measure against', async () => {
    const seed = canonicalSeed();
    seed['rota.shifts'] = [];
    seed['rota.shift_breaks'] = [];
    const service = makeService(createSupabaseFakeState(seed));

    const summary = await service.summary(owner(), { period: 'week' });
    expect(summary.overall.utilisationPercent).toBeNull();
    expect(summary.dataQuality.join(' ')).toContain('No rota shifts are recorded');
  });

  it('flags booked time on days without rota instead of silently counting it', async () => {
    const seed = canonicalSeed();
    seed['booking.appointments'].push({
      id: 'appt-4',
      business_id: 'biz-1',
      location_id: 'loc-1',
      assigned_staff_profile_id: 'staff-1',
      status: 'accepted',
      scheduled_start_at: '2026-08-13T09:00:00.000Z',
      scheduled_end_at: '2026-08-13T10:00:00.000Z',
      occupied_ranges: occupied('2026-08-13T09:00:00.000Z', '2026-08-13T10:00:00.000Z'),
    });
    const service = makeService(createSupabaseFakeState(seed));

    const summary = await service.summary(owner(), { period: 'week' });
    expect(summary.overall.bookedMinutes).toBe(360); // Thursday booking excluded
    expect(summary.dataQuality.join(' ')).toContain('no rota shift');
  });

  it('counts draft shifts but never cancelled ones (web-badge status parity)', async () => {
    const seed = canonicalSeed();
    (seed['rota.shifts'][0] as Record<string, unknown>)['status'] = 'draft';
    seed['rota.shifts'].push({
      id: 'shift-cancelled',
      business_id: 'biz-1',
      location_id: 'loc-1',
      staff_profile_id: 'staff-1',
      status: 'cancelled',
      scheduled_start_at: '2026-08-12T09:00:00.000Z',
      scheduled_end_at: '2026-08-12T17:00:00.000Z',
    });
    const service = makeService(createSupabaseFakeState(seed));

    const summary = await service.summary(owner(), { period: 'week' });
    // Draft still counts (only 'cancelled' is excluded); the cancelled
    // Wednesday shift adds nothing.
    expect(summary.overall.availableMinutes).toBe(450);
  });

  it('flags cross-location bookings distinctly from missing rota', async () => {
    const seed = canonicalSeed();
    // Rostered at loc-1 on Tuesday; an extra booking that day at loc-2.
    seed['booking.appointments'].push({
      id: 'appt-cross',
      business_id: 'biz-1',
      location_id: 'loc-2',
      assigned_staff_profile_id: 'staff-1',
      status: 'accepted',
      scheduled_start_at: '2026-08-11T12:00:00.000Z',
      scheduled_end_at: '2026-08-11T13:00:00.000Z',
      occupied_ranges: occupied('2026-08-11T12:00:00.000Z', '2026-08-11T13:00:00.000Z'),
    });
    const service = makeService(createSupabaseFakeState(seed));

    const summary = await service.summary(owner(), { period: 'week' });
    expect(summary.overall.bookedMinutes).toBe(360); // cross-location excluded
    expect(summary.dataQuality.join(' ')).toContain('different location');
    expect(summary.dataQuality.join(' ')).not.toContain('no rota shift');
  });

  it('refuses stylist actors at the service layer', async () => {
    const service = makeService(createSupabaseFakeState(canonicalSeed()));
    const stylist = owner({ roles: ['stylist'], primaryRole: 'stylist' });

    await expect(service.summary(stylist, {})).rejects.toBeInstanceOf(ForbiddenException);
  });
});
