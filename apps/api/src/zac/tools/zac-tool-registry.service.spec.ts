import type { AuthUser, Permission, UserRole } from '@sheer/domain';
import type { ZacActingContext } from '../context/zac-context.types';
import { ZacToolRegistryService } from './zac-tool-registry.service';
import type { ZacToolName } from './zac-tool.types';

function actorWith(roles: UserRole[], permissions: Permission[]): Pick<AuthUser, 'roles' | 'permissions'> {
  return { roles, permissions };
}

function contextWith(overrides: Partial<ZacActingContext> = {}): ZacActingContext {
  return {
    actorUserId: 'user-1',
    actorFirstName: null,
    businessId: 'biz-1',
    locationId: null,
    accessibleLocationIds: ['loc-1'],
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

describe('ZacToolRegistryService', () => {
  const registry = new ZacToolRegistryService();

  it('registers read-only, fail-closed tools only, none visible to clients and none enabled in Week 1', () => {
    const everything = registry.buildFor(
      actorWith(
        ['owner', 'manager', 'stylist'],
        [
          'zac.access',
          'report.dashboard.view',
          'report.performance.view',
          'report.commission.view',
          'report.lab_analytics.view',
          'inventory.manage',
        ],
      ),
    );

    expect(everything.length).toBeGreaterThan(0);
    for (const tool of everything) {
      expect(tool.readOnly).toBe(true);
      expect(tool.errorBehavior).toBe('fail_closed');
      expect(tool.fallbackBehavior).toBe('state_unavailable');
      expect(tool.allowedRoles).not.toContain('client');
      expect(tool.enabled).toBe(false);
    }
  });

  it('shows an owner every owner/manager tool but never the stylist-self tool', () => {
    const tools = registry
      .buildFor(
        actorWith(
          ['owner'],
          [
            'zac.access',
            'report.dashboard.view',
            'report.performance.view',
            'report.commission.view',
            'report.lab_analytics.view',
            'inventory.manage',
          ],
        ),
      )
      .map((tool) => tool.name);

    expect(tools).toContain('report.business_health');
    expect(tools).toContain('report.kpi_summary');
    expect(tools).toContain('report.stylist_performance');
    expect(tools).not.toContain('kpi.personal_coaching');
  });

  it('hides commission/performance-bearing tools from a manager holding neither permission', () => {
    const tools = registry
      .buildFor(actorWith(['manager'], ['zac.access', 'report.dashboard.view']))
      .map((tool) => tool.name);

    expect(tools).toContain('report.business_health');
    expect(tools).toContain('report.rebooking_summary');
    expect(tools).not.toContain('report.kpi_summary');
    expect(tools).not.toContain('report.stylist_performance');
    expect(tools).not.toContain('report.utilisation_summary');
  });

  it('keeps the KPI summary visible with performance-only access (commission stripped at tool level)', () => {
    const tools = registry
      .buildFor(actorWith(['manager'], ['zac.access', 'report.performance.view']))
      .map((tool) => tool.name);

    expect(tools).toContain('report.kpi_summary');
    expect(tools).toContain('report.stylist_performance');
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

  it('dispatch reports disabled Week 1 tools as not_connected for a fully permitted actor', async () => {
    const { result, trace } = await registry.dispatch(
      actorWith(['owner'], ['zac.access', 'report.dashboard.view']),
      contextWith({ roleContext: 'owner', roles: ['owner'] }),
      'report.business_health',
      {},
    );

    expect(result.status).toBe('not_connected');
    expect(result.data).toBeNull();
    expect(trace.tool).toBe('report.business_health');
    expect(trace.status).toBe('not_connected');
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
