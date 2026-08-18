import type { AuthUser, DashboardKpisResponse, Permission, UserRole } from '@sheer/domain';
import type { DashboardService } from '../../dashboard/dashboard.service';
import type { KpiService } from '../../kpi/kpi.service';
import type { UtilisationService } from '../../kpi/utilisation.service';
import type { LabAppointmentsService } from '../../lab-appointments/lab-appointments.service';
import type { ZacActingContext } from '../context/zac-context.types';
import { ZacToolRegistryService } from './zac-tool-registry.service';
import type { ZacToolName } from './zac-tool.types';

const LIVE_TOOLS: ZacToolName[] = [
  'context.business_summary',
  'context.location_summary',
  'context.capabilities',
  'report.business_health',
  'report.stylist_performance',
  'report.kpi_summary',
  'report.rebooking_summary',
  'report.utilisation_summary',
  'kpi.personal_coaching',
  'schedule.my_appointments',
];

const STYLIST_PERF_FIXTURE = {
  rangeStart: '2026-07-21T00:00:00.000Z',
  rangeEnd: '2026-07-28T00:00:00.000Z',
  scope: 'owner',
  stylists: [
    {
      staffProfileId: 'staff-1',
      stylistName: 'Maya Chen',
      locationId: 'loc-1',
      locationName: 'Main',
      hourlyRate: 1450,
      contractedHours: 32,
      totalBookings: 24,
      completedBookings: 22,
      cancelledBookings: 2,
      noShowBookings: 0,
      rebookedVisits: 12,
      rebookingRatePercent: 55,
      revenueCents: 84000,
      averageBookingValueCents: 3818,
      currencyCode: 'GBP',
    },
    {
      staffProfileId: 'staff-2',
      stylistName: 'Jordan Blake',
      locationId: 'loc-1',
      locationName: 'Main',
      hourlyRate: 1300,
      totalBookings: 18,
      completedBookings: 15,
      cancelledBookings: 3,
      noShowBookings: 0,
      rebookedVisits: 5,
      rebookingRatePercent: 33,
      revenueCents: 52000,
      averageBookingValueCents: 3466,
      currencyCode: 'GBP',
    },
  ],
} as unknown as Awaited<ReturnType<DashboardService['stylistPerformance']>>;

const STYLIST_LIST_FIXTURE = {
  periodStart: '2026-07-29T00:00:00.000Z',
  periodEnd: '2026-08-05T00:00:00.000Z',
  period: 'week',
  scope: 'owner',
  locations: [{ id: 'loc-1', name: 'Main' }],
  commissionReadyCount: 1,
  stylists: [
    {
      staffProfileId: 'staff-1',
      stylistName: 'Maya Chen',
      locationId: 'loc-1',
      locationName: 'Main',
      currencyCode: 'GBP',
      hoursWorked: 32,
      serviceTargetProgressPercent: 104,
      retailTargetProgressPercent: 88,
      rebooking: { rebookingRatePercent: 55, thresholdPercent: 50 },
      rebookingKpiMet: true,
      retailKpiMet: true,
      averageBillKpiMet: true,
      allKpisMet: true,
      commission: { tier: 'tier_3_5x', ratePercent: 15 },
      notes: [],
    },
    {
      staffProfileId: 'staff-2',
      stylistName: 'Jordan Blake',
      locationId: 'loc-1',
      locationName: 'Main',
      currencyCode: 'GBP',
      hoursWorked: 28,
      serviceTargetProgressPercent: 61,
      retailTargetProgressPercent: 22,
      rebooking: { rebookingRatePercent: 33, thresholdPercent: 50 },
      rebookingKpiMet: false,
      retailKpiMet: false,
      averageBillKpiMet: true,
      allKpisMet: false,
      commission: { tier: 'below_3x', ratePercent: 0 },
      notes: ['no_hours_worked'],
    },
  ],
} as unknown as Awaited<ReturnType<KpiService['stylistList']>>;

const MY_KPI_FIXTURE = {
  periodStart: '2026-07-29T00:00:00.000Z',
  periodEnd: '2026-08-05T00:00:00.000Z',
  period: 'week',
  scope: 'stylist',
  selectedLocationId: 'loc-1',
  stylist: {
    staffProfileId: 'staff-1',
    stylistName: 'Maya Chen',
    currencyCode: 'GBP',
    hoursWorked: 32,
    serviceTargetCents: 96000,
    actualServiceRevenueCents: 72000,
    serviceTargetProgressPercent: 75,
    retailTargetProgressPercent: 40,
    rebooking: { rebookingRatePercent: 35 },
    rebookingKpiMet: false,
    retailKpiMet: false,
    averageBillKpiMet: true,
  },
} as unknown as Awaited<ReturnType<KpiService['myKpi']>>;

const MY_SCHEDULE_FIXTURE = {
  bookings: [
    {
      id: 'b1',
      status: 'accepted',
      startsAt: '2026-08-05T09:00:00.000Z',
      clientDisplayName: 'Sarah Whitfield',
      serviceNames: ['Cut & finish'],
    },
    {
      id: 'b2',
      status: 'cancelled',
      startsAt: '2026-08-05T11:00:00.000Z',
      clientDisplayName: 'Nope Cancelled',
      serviceNames: ['Colour'],
    },
  ],
  scope: 'stylist',
  rangeStart: '2026-08-05T00:00:00.000Z',
  rangeEnd: '2026-08-06T00:00:00.000Z',
} as unknown as Awaited<ReturnType<LabAppointmentsService['today']>>;

const MY_SCHEDULE_LIST_FIXTURE = {
  bookings: [
    ...MY_SCHEDULE_FIXTURE.bookings,
    {
      id: 'b3',
      status: 'pending',
      startsAt: '2026-08-06T10:00:00.000Z',
      clientDisplayName: 'Priya Patel',
      serviceNames: ['Balayage'],
    },
    {
      id: 'b4',
      status: 'accepted',
      startsAt: '2026-08-20T10:00:00.000Z',
      clientDisplayName: 'Far Future',
      serviceNames: ['Cut'],
    },
  ],
  scope: 'stylist',
  rangeStart: '2026-08-01T00:00:00.000Z',
  rangeEnd: '2026-08-20T00:00:00.000Z',
} as unknown as Awaited<ReturnType<LabAppointmentsService['list']>>;

const KPI_SUMMARY = {
  totalRevenueCents: 125000,
  totalBookings: 42,
  completedBookings: 38,
  cancelledBookings: 4,
  noShowBookings: 0,
  newClients: 6,
  repeatClients: 20,
  rebookedVisits: 15,
  rebookingRatePercent: 39,
  stylistRebookedVisits: 10,
  clientRebookedVisits: 5,
  completedPaidBookings: 36,
  averageBookingValueCents: 3472,
  lowStockProducts: 1,
  currencyCode: 'GBP',
};


const UTILISATION_FIXTURE = {
  scope: 'owner',
  period: 'week',
  rangeStart: '2026-08-10T00:00:00.000Z',
  rangeEnd: '2026-08-17T00:00:00.000Z',
  locations: [{ id: 'loc-1', name: 'Main' }],
  overall: { availableMinutes: 2400, bookedMinutes: 1464, utilisationPercent: 61, staffDayCount: 10 },
  previousPeriod: { availableMinutes: 2400, bookedMinutes: 1368, utilisationPercent: 57 },
  byLocation: [
    { locationId: 'loc-1', locationName: 'Main', availableMinutes: 2400, bookedMinutes: 1464, utilisationPercent: 61 },
  ],
  byWeekday: [
    { weekday: 'Tuesday', availableMinutes: 480, bookedMinutes: 216, utilisationPercent: 45 },
    { weekday: 'Friday', availableMinutes: 480, bookedMinutes: 384, utilisationPercent: 80 },
  ],
  quietestWeekday: 'Tuesday',
  busiestWeekday: 'Friday',
  largestGaps: [
    {
      locationId: 'loc-1',
      locationName: 'Main',
      staffName: 'Maya Chen',
      date: '2026-08-11',
      weekday: 'Tuesday',
      startIso: '2026-08-11T13:00:00.000Z',
      endIso: '2026-08-11T16:00:00.000Z',
      minutes: 180,
    },
  ],
  warningThresholdPercent: 60,
  dataQuality: [],
} as unknown as Awaited<ReturnType<UtilisationService['summary']>>;

const KPI_FIXTURE: DashboardKpisResponse = {
  rangeStart: '2026-07-21T00:00:00.000Z',
  rangeEnd: '2026-07-28T00:00:00.000Z',
  scope: 'owner',
  locations: [{ id: 'loc-1', name: 'Main' }],
  summary: KPI_SUMMARY,
  byLocation: [{ locationId: 'loc-1', locationName: 'Main', ...KPI_SUMMARY }],
};

function makeRegistry(
  dashboard?: Partial<DashboardService>,
  kpi?: Partial<KpiService>,
  labAppointments?: Partial<LabAppointmentsService>,
  utilisation?: Partial<UtilisationService>,
): ZacToolRegistryService {
  const dashboardFake = dashboard ?? { kpis: jest.fn().mockResolvedValue(KPI_FIXTURE) };
  const kpiFake = kpi ?? { myKpi: jest.fn().mockResolvedValue(MY_KPI_FIXTURE) };
  const labFake =
    labAppointments ??
    {
      today: jest.fn().mockResolvedValue(MY_SCHEDULE_FIXTURE),
      list: jest.fn().mockResolvedValue(MY_SCHEDULE_LIST_FIXTURE),
    };
  const utilisationFake = utilisation ?? {
    summary: jest.fn().mockResolvedValue(UTILISATION_FIXTURE),
  };
  return new ZacToolRegistryService(
    dashboardFake as DashboardService,
    kpiFake as KpiService,
    labFake as LabAppointmentsService,
    utilisationFake as UtilisationService,
  );
}

function actorWith(roles: UserRole[], permissions: Permission[]): AuthUser {
  return { roles, permissions } as unknown as AuthUser;
}

function contextWith(overrides: Partial<ZacActingContext> = {}): ZacActingContext {
  return {
    actorUserId: 'user-1',
    actorFirstName: null,
    businessId: 'biz-1',
    businessName: 'Test Salon',
    locationId: null,
    accessibleLocationIds: ['loc-1'],
    accessibleLocations: [{ id: 'loc-1', name: 'Main' }],
    roleContext: 'manager',
    roles: ['manager'],
    permissions: [],
    staffProfileId: null,
    requestSource: 'web_dashboard',
    timezone: 'Europe/London',
    locale: 'en-GB',
    firstAssistantTurn: true,
    ...overrides,
  };
}

const OWNER_ALL = actorWith(
  ['owner'],
  [
    'zac.access',
    'report.dashboard.view',
    'report.performance.view',
    'report.commission.view',
    'report.lab_analytics.view',
    'inventory.manage',
  ],
);

describe('ZacToolRegistryService', () => {
  const registry = makeRegistry();

  it('registers read-only, fail-closed tools only, none visible to clients', () => {
    const everything = registry.buildFor(
      actorWith(['owner', 'manager', 'stylist'], OWNER_ALL.permissions),
    );

    expect(everything.length).toBeGreaterThan(0);
    for (const tool of everything) {
      expect(tool.readOnly).toBe(true);
      expect(tool.errorBehavior).toBe('fail_closed');
      expect(tool.fallbackBehavior).toBe('state_unavailable');
      expect(tool.allowedRoles).not.toContain('client');
    }
  });

  it('enables exactly the nine live tools; everything else stays disabled', () => {
    const everything = registry.buildFor(
      actorWith(['owner', 'manager', 'stylist'], [...OWNER_ALL.permissions, 'bookings.manage']),
    );

    const enabled = everything.filter((tool) => tool.enabled).map((tool) => tool.name);
    expect(enabled.sort()).toEqual([...LIVE_TOOLS].sort());
  });

  it('shows an owner the context and report tools, never the stylist-self tools', () => {
    const tools = registry.buildFor(OWNER_ALL).map((tool) => tool.name);

    for (const name of [
      'context.business_summary',
      'context.location_summary',
      'context.capabilities',
      'report.business_health',
    ]) {
      expect(tools).toContain(name);
    }
    expect(tools).toContain('report.kpi_summary');
    expect(tools).not.toContain('kpi.personal_coaching');
    expect(tools).not.toContain('schedule.my_appointments');
  });

  it('hides commission/performance-bearing tools from a manager holding neither permission', () => {
    const tools = registry
      .buildFor(actorWith(['manager'], ['zac.access', 'report.dashboard.view']))
      .map((tool) => tool.name);

    expect(tools).toContain('context.business_summary');
    expect(tools).toContain('context.capabilities');
    expect(tools).toContain('report.business_health');
    expect(tools).not.toContain('report.kpi_summary');
    expect(tools).not.toContain('report.stylist_performance');
    expect(tools).not.toContain('report.utilisation_summary');
  });

  it('shows a stylist the self-scoped catalogue only, and a client nothing', () => {
    // Schedule requires bookings.manage (mirroring its endpoint), so a stylist
    // without it sees two tools…
    const bare = registry.buildFor(actorWith(['stylist'], ['zac.access'])).map((t) => t.name);
    expect(bare.sort()).toEqual(['context.capabilities', 'kpi.personal_coaching']);

    // …and the default stylist permission set unlocks their diary too.
    const withBookings = registry
      .buildFor(actorWith(['stylist'], ['zac.access', 'bookings.manage']))
      .map((t) => t.name);
    expect(withBookings.sort()).toEqual([
      'context.capabilities',
      'kpi.personal_coaching',
      'schedule.my_appointments',
    ]);

    expect(registry.buildFor(actorWith(['client'], ['zac.access']))).toEqual([]);
  });

  it('runs the live coaching tool through the guarded KpiService, self-scoped', async () => {
    const myKpi = jest.fn().mockResolvedValue(MY_KPI_FIXTURE);
    const liveRegistry = makeRegistry(undefined, { myKpi } as Partial<KpiService>);
    const actor = actorWith(['stylist'], ['zac.access']);

    const { result } = await liveRegistry.dispatch(
      actor,
      contextWith({ roleContext: 'stylist', roles: ['stylist'], staffProfileId: 'staff-1' }),
      'kpi.personal_coaching',
      { period: 'week' },
    );

    expect(result.status).toBe('ok');
    expect(myKpi).toHaveBeenCalledWith(actor, { period: 'week' });
    expect(result.presentation?.answer).toContain('rebooking rate is 35%');
    expect(result.presentation?.answer).not.toMatch(/commission|hourly/i);
    expect(result.presentation?.responseType).toBe('Coaching Point');
  });

  it('runs the live schedule tool: today-and-tomorrow filtering, no dead or far-future rows', async () => {
    const today = jest.fn().mockResolvedValue(MY_SCHEDULE_FIXTURE);
    const list = jest.fn().mockResolvedValue(MY_SCHEDULE_LIST_FIXTURE);
    const liveRegistry = makeRegistry(undefined, undefined, {
      today,
      list,
    } as Partial<LabAppointmentsService>);

    const { result } = await liveRegistry.dispatch(
      actorWith(['stylist'], ['zac.access', 'bookings.manage']),
      contextWith({ roleContext: 'stylist', roles: ['stylist'], staffProfileId: 'staff-1' }),
      'schedule.my_appointments',
      { horizon: 'today_tomorrow' },
    );

    expect(result.status).toBe('ok');
    expect(result.rowCount).toBe(2); // Sarah today + Priya tomorrow
    expect(result.presentation?.answer).toContain('Cut & finish with Sarah');
    expect(result.presentation?.answer).toContain('Tomorrow');
    expect(result.presentation?.answer).toContain('Balayage with Priya');
    expect(result.presentation?.answer).not.toContain('Nope'); // cancelled
    expect(result.presentation?.answer).not.toContain('Far Future'); // outside window
  });

  it('denies the schedule tool to a stylist without bookings.manage', async () => {
    const { result } = await registry.dispatch(
      actorWith(['stylist'], ['zac.access']),
      contextWith({ roleContext: 'stylist', roles: ['stylist'], staffProfileId: 'staff-1' }),
      'schedule.my_appointments',
      {},
    );

    expect(result.status).toBe('permission_denied');
  });

  it('never shows a stylist any business, staff, client, QLAB or stock tool — even fully permissioned', () => {
    // Adversarial: a stylist who somehow holds every report/inventory permission
    // still only reaches the stylist-safe catalogue, because allowedRoles gates
    // independently of permissions.
    const tools = registry.buildFor(actorWith(['stylist'], OWNER_ALL.permissions)).map((t) => t.name);
    expect(tools.sort()).toEqual(['context.capabilities', 'kpi.personal_coaching']);
  });

  it('dispatch denies a stylist the business health tool with a safe result', async () => {
    const { result } = await registry.dispatch(
      actorWith(['stylist'], ['zac.access', 'report.dashboard.view']),
      contextWith({ roleContext: 'stylist', roles: ['stylist'] }),
      'report.business_health',
      {},
    );

    expect(result.status).toBe('permission_denied');
    expect(result.data).toBeNull();
  });

  it('dispatch fails closed without zac.access, even for an otherwise-permitted actor', async () => {
    const { result } = await registry.dispatch(
      actorWith(['owner'], ['report.dashboard.view']),
      contextWith({ roleContext: 'owner', roles: ['owner'] }),
      'report.business_health',
      {},
    );

    expect(result.status).toBe('permission_denied');
    expect(result.data).toBeNull();
  });

  it('dispatch re-checks the underlying tool permission independently of zac.access', async () => {
    const { result } = await registry.dispatch(
      actorWith(['manager'], ['zac.access']),
      contextWith(),
      'report.business_health',
      {},
    );

    expect(result.status).toBe('permission_denied');
    expect(result.data).toBeNull();
  });

  it('runs the live business health tool through the guarded dashboard service', async () => {
    const kpis = jest.fn().mockResolvedValue(KPI_FIXTURE);
    const liveRegistry = makeRegistry({ kpis } as Partial<DashboardService>);
    const actor = actorWith(['owner'], ['zac.access', 'report.dashboard.view']);

    const { result, trace } = await liveRegistry.dispatch(
      actor,
      contextWith({ roleContext: 'owner', roles: ['owner'] }),
      'report.business_health',
      {},
    );

    expect(result.status).toBe('ok');
    expect(kpis).toHaveBeenCalledWith(actor, expect.objectContaining({ locationId: undefined }));
    expect(result.presentation?.answer).toContain('£1250.00');
    expect(result.presentation?.evidence[0].source_type).toBe('report.dashboard');
    expect(trace.status).toBe('ok');
  });

  it('converts a failing guarded service into a safe error result, never a throw', async () => {
    const liveRegistry = makeRegistry({
      kpis: jest.fn().mockRejectedValue(new Error('boom')),
    } as Partial<DashboardService>);

    const { result } = await liveRegistry.dispatch(
      actorWith(['owner'], ['zac.access', 'report.dashboard.view']),
      contextWith({ roleContext: 'owner', roles: ['owner'] }),
      'report.business_health',
      {},
    );

    expect(result.status).toBe('unavailable');
    expect(result.data).toBeNull();
    expect(result.explanation.length).toBeGreaterThan(0);
  });

  it('answers business context entirely from the acting scope, without any service call', async () => {
    const kpis = jest.fn();
    const liveRegistry = makeRegistry({ kpis } as Partial<DashboardService>);

    const { result } = await liveRegistry.dispatch(
      actorWith(['manager'], ['zac.access']),
      contextWith(),
      'context.business_summary',
      {},
    );

    expect(result.status).toBe('ok');
    expect(result.presentation?.answer).toContain('Test Salon');
    expect(result.presentation?.answer).toContain('manager');
    expect(kpis).not.toHaveBeenCalled();
  });

  it('lists connected vs planned capabilities honestly for the acting user', async () => {
    const { result } = await registry.dispatch(
      actorWith(['manager'], ['zac.access']),
      contextWith(),
      'context.capabilities',
      {},
    );

    expect(result.status).toBe('ok');
    const data = result.data as { connected_capabilities: string[]; planned_capabilities: string[] };
    expect(data.connected_capabilities.sort()).toEqual(
      ['context.business_summary', 'context.location_summary'].sort(),
    );
    expect(data.planned_capabilities).toEqual([]);
    expect(result.presentation?.answer).not.toContain('business health snapshot');
  });

  it('reports disabled skeletons as not_connected for a fully permitted actor', async () => {
    const { result } = await registry.dispatch(
      OWNER_ALL,
      contextWith({ roleContext: 'owner', roles: ['owner'] }),
      'qlab.colour_analytics',
      {},
    );

    expect(result.status).toBe('not_connected');
    expect(result.data).toBeNull();
  });

  it('dispatches the live utilisation tool through the guarded service', async () => {
    const summary = jest.fn().mockResolvedValue(UTILISATION_FIXTURE);
    const liveRegistry = makeRegistry(undefined, undefined, undefined, { summary });

    const { result } = await liveRegistry.dispatch(
      OWNER_ALL,
      contextWith({ roleContext: 'owner', roles: ['owner'] }),
      'report.utilisation_summary',
      { period: 'week' },
    );

    expect(summary).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('ok');
    expect(result.presentation?.answer).toContain('61%');
    expect(result.presentation?.answer).toContain('Tuesday');
  });

  describe('staff performance tools (Week 3)', () => {
    it('ranks stylists via the guarded dashboard reducer and never leaks pay fields', async () => {
      const stylistPerformance = jest.fn().mockResolvedValue(STYLIST_PERF_FIXTURE);
      const liveRegistry = makeRegistry({
        stylistPerformance,
      } as Partial<DashboardService>);
      const actor = actorWith(['owner'], ['zac.access', 'report.performance.view']);

      const { result } = await liveRegistry.dispatch(
        actor,
        contextWith({ roleContext: 'owner', roles: ['owner'] }),
        'report.stylist_performance',
        {},
      );

      expect(result.status).toBe('ok');
      expect(stylistPerformance).toHaveBeenCalledWith(
        actor,
        expect.objectContaining({ locationId: undefined }),
      );
      expect(result.presentation?.answer).toContain('Maya Chen');
      expect(result.presentation?.answer).toContain('£840.00');
      expect(result.presentation?.answer).toContain('55% rebooking');
      // Honest about what "top" means: no ratings exist.
      expect(result.presentation?.limitations.join(' ')).toMatch(/no client ratings/i);
      // Pay-adjacent fields are stripped unconditionally from the data payload
      // (the limitations PROSE may mention pay to say it is excluded).
      expect(JSON.stringify(result.data)).not.toMatch(/hourly|contracted|benchmark|1450|1300/i);
    });

    it('summarises KPIs with commission stripped without report.commission.view', async () => {
      const stylistList = jest.fn().mockResolvedValue(STYLIST_LIST_FIXTURE);
      const liveRegistry = makeRegistry(undefined, { stylistList } as Partial<KpiService>);
      const actor = actorWith(['manager'], ['zac.access', 'report.performance.view']);

      const { result } = await liveRegistry.dispatch(
        actor,
        contextWith(),
        'report.kpi_summary',
        { period: 'week' },
      );

      expect(result.status).toBe('ok');
      expect(stylistList).toHaveBeenCalledWith(actor, expect.objectContaining({ period: 'week' }));
      expect(result.presentation?.answer).toContain('1 of 2 stylists meet all three KPIs');
      expect(result.presentation?.answer).toContain('Jordan Blake (33%)');
      expect(result.presentation?.responseType).toBe('Watch Point');
      expect(JSON.stringify(result)).not.toMatch(/commission_tier|commission_rate|tier_3_5x/);
    });

    it('includes commission tier only with report.commission.view', async () => {
      const stylistList = jest.fn().mockResolvedValue(STYLIST_LIST_FIXTURE);
      const liveRegistry = makeRegistry(undefined, { stylistList } as Partial<KpiService>);

      const { result } = await liveRegistry.dispatch(
        actorWith(['owner'], ['zac.access', 'report.commission.view']),
        contextWith({ roleContext: 'owner', roles: ['owner'] }),
        'report.kpi_summary',
        {},
      );

      expect(result.status).toBe('ok');
      expect(JSON.stringify(result.data)).toContain('commission_tier');
    });

    it('summarises rebooking with the stylist/client split from dashboard KPIs', async () => {
      const kpis = jest.fn().mockResolvedValue(KPI_FIXTURE);
      const liveRegistry = makeRegistry({ kpis } as Partial<DashboardService>);

      const { result } = await liveRegistry.dispatch(
        actorWith(['owner'], ['zac.access', 'report.dashboard.view']),
        contextWith({ roleContext: 'owner', roles: ['owner'] }),
        'report.rebooking_summary',
        {},
      );

      expect(result.status).toBe('ok');
      expect(result.presentation?.answer).toContain('39%');
      expect(result.presentation?.answer).toContain('10 were rebooked by stylists');
      expect(result.presentation?.limitations.join(' ')).toMatch(/no-show/i);
    });
  });

  it('dispatch denies the stylist-self tool when the actor has no staff profile', async () => {
    const { result } = await registry.dispatch(
      actorWith(['stylist'], ['zac.access']),
      contextWith({ roleContext: 'stylist', roles: ['stylist'], staffProfileId: null }),
      'kpi.personal_coaching',
      {},
    );

    expect(result.status).toBe('permission_denied');
  });

  it('dispatch returns unavailable (not a throw) for an unknown tool', async () => {
    const { result } = await registry.dispatch(
      actorWith(['owner'], ['zac.access']),
      contextWith({ roleContext: 'owner', roles: ['owner'] }),
      'report.nonexistent' as ZacToolName,
      {},
    );

    expect(result.status).toBe('unavailable');
  });
});
