import type { AuthUser, DashboardKpisResponse, Permission, UserRole } from '@sheer/domain';
import type { DashboardService } from '../../dashboard/dashboard.service';
import type { ZacActingContext } from '../context/zac-context.types';
import { ZacToolRegistryService } from './zac-tool-registry.service';
import type { ZacToolName } from './zac-tool.types';

const LIVE_TOOLS: ZacToolName[] = [
  'context.business_summary',
  'context.location_summary',
  'context.capabilities',
  'report.business_health',
];

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

const KPI_FIXTURE: DashboardKpisResponse = {
  rangeStart: '2026-07-21T00:00:00.000Z',
  rangeEnd: '2026-07-28T00:00:00.000Z',
  scope: 'owner',
  locations: [{ id: 'loc-1', name: 'Main' }],
  summary: KPI_SUMMARY,
  byLocation: [{ locationId: 'loc-1', locationName: 'Main', ...KPI_SUMMARY }],
};

function makeRegistry(dashboard?: Partial<DashboardService>): ZacToolRegistryService {
  const fake = dashboard ?? { kpis: jest.fn().mockResolvedValue(KPI_FIXTURE) };
  return new ZacToolRegistryService(fake as DashboardService);
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

  it('enables exactly the four low-risk Week 2 tools; everything else stays disabled', () => {
    const everything = registry.buildFor(
      actorWith(['owner', 'manager', 'stylist'], OWNER_ALL.permissions),
    );

    const enabled = everything.filter((tool) => tool.enabled).map((tool) => tool.name);
    expect(enabled.sort()).toEqual([...LIVE_TOOLS].sort());
  });

  it('shows an owner the context tools and permitted report tools, never the stylist-self tool', () => {
    const tools = registry.buildFor(OWNER_ALL).map((tool) => tool.name);

    for (const name of LIVE_TOOLS) {
      expect(tools).toContain(name);
    }
    expect(tools).toContain('report.kpi_summary');
    expect(tools).not.toContain('kpi.personal_coaching');
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

  it('shows a stylist only the personal coaching tool, and a client nothing at all', () => {
    const stylistTools = registry.buildFor(actorWith(['stylist'], ['zac.access'])).map((t) => t.name);
    expect(stylistTools).toEqual(['kpi.personal_coaching']);

    expect(registry.buildFor(actorWith(['client'], ['zac.access']))).toEqual([]);
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
      'report.kpi_summary',
      {},
    );

    expect(result.status).toBe('not_connected');
    expect(result.data).toBeNull();
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
