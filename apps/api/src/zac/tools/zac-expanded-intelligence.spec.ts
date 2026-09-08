import { parseZacPeriod } from './zac-period';
import type {
  AuthUser,
  DashboardKpiSummary,
  DashboardKpisResponse,
  DashboardTopServicesResponse,
  Permission,
  UserRole,
} from '@sheer/domain';
import type { ClientIntelligenceService } from '../../client-intelligence/client-intelligence.service';
import type { DashboardService } from '../../dashboard/dashboard.service';
import type { KpiService } from '../../kpi/kpi.service';
import type { UtilisationService } from '../../kpi/utilisation.service';
import type { LabAppointmentsService } from '../../lab-appointments/lab-appointments.service';
import type { RetailSalesService } from '../../retail-sales/retail-sales.service';
import type { ZacActingContext } from '../context/zac-context.types';
import { ZacEvidenceService } from '../analysis/zac-evidence.service';
import { ZacPriorityService } from '../analysis/zac-priority.service';
import { ZacToolRegistryService } from './zac-tool-registry.service';
import type { ZacToolResult } from './zac-tool.types';

/**
 * Workstream 1 — Expanded Intelligence.
 *
 * What these specs are actually protecting, beyond "the tool returns numbers":
 *
 *  - Every new source reaches business data ONLY through its existing guarded
 *    QLOOQO service, called with the acting user.
 *  - Each declares the same permission its own HTTP endpoint declares, so ZAC
 *    can never become a side door around a permission the dashboard enforces.
 *  - No denominator is faked. An empty window reports `null`, never 0%.
 *  - Client retention returns COUNTS. A client name must not be reachable.
 *  - Profitability is registered and disabled, so "what is my margin?" gets an
 *    honest "not connected" instead of a guess.
 */

const KPI_SUMMARY: DashboardKpiSummary = {
  totalRevenueCents: 1_845_000,
  totalBookings: 248,
  completedBookings: 214,
  cancelledBookings: 26,
  noShowBookings: 8,
  newClients: 47,
  repeatClients: 167,
  rebookedVisits: 124,
  rebookingRatePercent: 58,
  stylistRebookedVisits: 96,
  clientRebookedVisits: 28,
  completedPaidBookings: 200,
  averageBookingValueCents: 8621,
  lowStockProducts: 0,
  currencyCode: 'GBP',
};

const KPIS: DashboardKpisResponse = {
  rangeStart: '2026-08-20T00:00:00.000Z',
  rangeEnd: '2026-08-27T00:00:00.000Z',
  scope: 'owner',
  locations: [{ id: 'loc-1', name: 'Main' }],
  summary: KPI_SUMMARY,
  byLocation: [{ locationId: 'loc-1', locationName: 'Main', ...KPI_SUMMARY }],
};

const TOP_SERVICES: DashboardTopServicesResponse = {
  rangeStart: '2026-07-28T00:00:00.000Z',
  rangeEnd: '2026-08-27T00:00:00.000Z',
  scope: 'owner',
  services: [
    { serviceName: 'Full head colour', bookingCount: 62, revenueCents: 620_000, currencyCode: 'GBP' },
    { serviceName: 'Cut and finish', bookingCount: 88, revenueCents: 264_000, currencyCode: 'GBP' },
    { serviceName: 'Balayage', bookingCount: 21, revenueCents: 231_000, currencyCode: 'GBP' },
  ],
};

const RETAIL = {
  scope: 'owner',
  rangeStart: '2026-07-28T00:00:00.000Z',
  rangeEnd: '2026-08-27T00:00:00.000Z',
  sales: [
    {
      id: 's1',
      businessId: 'biz-1',
      locationId: 'loc-1',
      productId: 'p1',
      productName: 'Repair shampoo',
      quantity: 2,
      unitPriceCents: 1800,
      totalAmountCents: 3600,
      currencyCode: 'GBP',
      soldAt: '2026-08-20T10:00:00.000Z',
      createdAt: '2026-08-20T10:00:00.000Z',
      unitCostCents: 900,
    },
    {
      id: 's2',
      businessId: 'biz-1',
      locationId: 'loc-1',
      productId: 'p2',
      productName: 'Bond builder',
      quantity: 1,
      unitPriceCents: 2600,
      totalAmountCents: 2600,
      currencyCode: 'GBP',
      soldAt: '2026-08-21T10:00:00.000Z',
      createdAt: '2026-08-21T10:00:00.000Z',
      // No cost recorded: must be excluded from margin, not counted as free.
    },
  ],
  totalAmountCents: 6200,
  currencyCode: 'GBP',
} as unknown as Awaited<ReturnType<RetailSalesService['list']>>;

const LAPSE = {
  clients: [],
  counts: { active: 120, atRisk: 24, lapsed: 16, booked: 40, insufficientHistory: 55 },
  settings: { lapsedBufferDays: 14, minCompletedVisits: 3, historyVisitLimit: 10 },
  truncated: false,
  evaluatedClientCount: 255,
  pagination: { page: 1, pageSize: 1, total: 200, totalPages: 200 },
} as unknown as Awaited<ReturnType<ClientIntelligenceService['listLapsedClients']>>;

const ALL_PERMISSIONS: Permission[] = [
  'zac.access',
  'report.dashboard.view',
  'report.performance.view',
  'report.financials.view',
  'crm.view',
];

function actorWith(roles: UserRole[], permissions: Permission[]): AuthUser {
  return {
    id: 'user-1',
    roles,
    primaryRole: roles[0],
    businessId: 'biz-1',
    businessName: 'Shear Genius',
    allowedLocationIds: ['loc-1'],
    locationScope: { kind: 'all', locationIds: ['loc-1'] },
    locations: [{ id: 'loc-1', name: 'Main' }],
    profile: { id: 'profile-1', email: 'owner@example.com', fullName: 'Owner One' },
    permissions,
  } as AuthUser;
}

function context(overrides: Partial<ZacActingContext> = {}): ZacActingContext {
  return {
    actorUserId: 'user-1',
    actorFirstName: 'Sam',
    businessId: 'biz-1',
    businessName: 'Shear Genius',
    locationId: null,
    accessibleLocationIds: ['loc-1'],
    accessibleLocations: [{ id: 'loc-1', name: 'Main' }],
    roleContext: 'owner',
    roles: ['owner'],
    permissions: ALL_PERMISSIONS,
    staffProfileId: null,
    requestSource: 'web_dashboard',
    timezone: 'Europe/London',
    locale: 'en-GB',
    firstAssistantTurn: true,
    ...overrides,
  };
}

function makeRegistry(
  overrides: {
    dashboard?: Partial<DashboardService>;
    retailSales?: Partial<RetailSalesService>;
    clientIntelligence?: Partial<ClientIntelligenceService>;
  } = {},
): ZacToolRegistryService {
  const dashboard = overrides.dashboard ?? {
    kpis: jest.fn().mockResolvedValue(KPIS),
    topServices: jest.fn().mockResolvedValue(TOP_SERVICES),
  };
  const retailSales = overrides.retailSales ?? { list: jest.fn().mockResolvedValue(RETAIL) };
  const clientIntelligence = overrides.clientIntelligence ?? {
    listLapsedClients: jest.fn().mockResolvedValue(LAPSE),
  };
  return new ZacToolRegistryService(
    dashboard as DashboardService,
    { myKpi: jest.fn(), stylistList: jest.fn() } as unknown as KpiService,
    { today: jest.fn(), list: jest.fn() } as unknown as LabAppointmentsService,
    { summary: jest.fn() } as unknown as UtilisationService,
    retailSales as RetailSalesService,
    clientIntelligence as ClientIntelligenceService,
  );
}

describe('period is read from the question, not hardcoded', () => {
  // The parser is unit-tested in zac-period.spec.ts. These prove the WIRING:
  // that a resolved window actually reaches the guarded service and the copy,
  // which is where a silent regression would otherwise hide.
  const NOW = Date.parse('2026-09-08T10:30:00.000Z');

  it('passes an explicitly asked-for window through to the dashboard service', async () => {
    const kpis = jest.fn().mockResolvedValue(KPIS);
    const registry = makeRegistry({ dashboard: { kpis, topServices: jest.fn() } });

    const { result } = await registry.dispatch(
      actorWith(['owner'], ALL_PERMISSIONS),
      context(),
      'report.appointment_summary',
      { period: parseZacPeriod('how many appointments last month?', 7, NOW) },
    );

    // August, as a calendar month with an exclusive end — NOT the tool's
    // 7-day default, which is what this question used to be answered on.
    expect(kpis).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
      }),
    );
    expect(result.presentation?.answer).toContain('Last month');
    expect(result.presentation?.limitations.join(' ')).toContain('last month');
  });

  it('still uses the tool default when the question names no period', async () => {
    const kpis = jest.fn().mockResolvedValue(KPIS);
    const registry = makeRegistry({ dashboard: { kpis, topServices: jest.fn() } });

    const { result } = await registry.dispatch(
      actorWith(['owner'], ALL_PERMISSIONS),
      context(),
      'report.appointment_summary',
      { period: parseZacPeriod('how many appointments did we take?', 7, NOW) },
    );

    expect(result.presentation?.answer).toContain('The last 7 days');
  });

  it('says which window it used when the requested one was out of range', async () => {
    const registry = makeRegistry();
    const { result } = await registry.dispatch(
      actorWith(['owner'], ALL_PERMISSIONS),
      context(),
      'report.appointment_summary',
      { period: parseZacPeriod('appointments over the last 40 years?', 7, NOW) },
    );

    // Answers on the default, and states plainly that it did.
    expect(result.presentation?.limitations.join(' ')).toContain('at most 5 years');
  });

  it('carries the window into retail as well', async () => {
    const list = jest.fn().mockResolvedValue(RETAIL);
    const registry = makeRegistry({ retailSales: { list } });

    await registry.dispatch(
      actorWith(['owner'], ALL_PERMISSIONS),
      context(),
      'report.retail_performance',
      { period: parseZacPeriod('how was retail in August?', 30, NOW) },
    );

    expect(list).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: '2026-08-01T00:00:00.000Z' }),
    );
  });

  it('tells the user retention cannot be rewound to a past period', async () => {
    const registry = makeRegistry();
    const { result } = await registry.dispatch(
      actorWith(['owner'], ALL_PERMISSIONS),
      context(),
      'report.client_retention',
      { requestedPeriod: parseZacPeriod('how many clients lapsed last month?', 0, NOW) },
    );

    // The underlying service takes no window; saying so beats returning
    // today's counts under last month's question.
    expect(result.presentation?.limitations.join(' ')).toContain('cannot rewind it to last month');
  });

  it('adds no such caveat when no period was asked for', async () => {
    const registry = makeRegistry();
    const { result } = await registry.dispatch(
      actorWith(['owner'], ALL_PERMISSIONS),
      context(),
      'report.client_retention',
      { requestedPeriod: parseZacPeriod('how many clients have lapsed?', 0, NOW) },
    );

    expect(result.presentation?.limitations.join(' ')).not.toContain('cannot rewind');
  });
});

describe('ZAC Workstream 1 — Expanded Intelligence', () => {
  describe('report.appointment_summary', () => {
    it('reports volume, completion and cancellation from the guarded dashboard service', async () => {
      const kpis = jest.fn().mockResolvedValue(KPIS);
      const registry = makeRegistry({ dashboard: { kpis, topServices: jest.fn() } });

      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.appointment_summary',
        {},
      );

      // Called with the acting user — the service re-checks scope itself.
      expect(kpis).toHaveBeenCalledWith(expect.objectContaining({ id: 'user-1' }), expect.any(Object));
      expect(result.status).toBe('ok');
      expect(result.data).toMatchObject({
        total_bookings: 248,
        completed_bookings: 214,
        cancelled_bookings: 26,
        completion_rate_percent: 86,
        cancellation_rate_percent: 10,
      });
      expect(result.presentation?.answer).toContain('248 appointments');
      expect(result.presentation?.answer).toContain('10%');
    });

    it('states recorded no-shows as a floor, never as a complete count', async () => {
      const registry = makeRegistry();
      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.appointment_summary',
        {},
      );

      expect(result.presentation?.answer).toContain('8 were marked as no-shows');
      expect(result.presentation?.limitations.join(' ')).toContain('only counted when someone marks them');
    });

    it('reports null rates for an empty window rather than 0%', async () => {
      const empty: DashboardKpisResponse = {
        ...KPIS,
        summary: { ...KPI_SUMMARY, totalBookings: 0, completedBookings: 0, cancelledBookings: 0 },
        byLocation: [],
      };
      const registry = makeRegistry({
        dashboard: { kpis: jest.fn().mockResolvedValue(empty), topServices: jest.fn() },
      });

      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.appointment_summary',
        {},
      );

      expect(result.data).toMatchObject({
        completion_rate_percent: null,
        cancellation_rate_percent: null,
      });
      expect(result.presentation?.answer).toContain('No appointments were recorded');
    });

    it('fails closed to a safe result when the guarded service throws', async () => {
      const registry = makeRegistry({
        dashboard: { kpis: jest.fn().mockRejectedValue(new Error('scope')), topServices: jest.fn() },
      });

      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.appointment_summary',
        {},
      );

      expect(result.status).toBe('unavailable');
      expect(result.data).toBeNull();
      expect(result.explanation).not.toContain('scope');
    });
  });

  describe('report.service_mix', () => {
    it('ranks services and states the leader share of the RANKED group only', async () => {
      const registry = makeRegistry();
      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.service_mix',
        {},
      );

      expect(result.status).toBe('ok');
      // 620000 / (620000 + 264000 + 231000) = 55.6% -> 56
      expect(result.data).toMatchObject({
        top_service_share_percent: 56,
        ranked_service_count: 3,
        ranked_revenue_cents: 1_115_000,
      });
      expect(result.presentation?.answer).toContain('Full head colour');
      expect(result.presentation?.limitations.join(' ')).toContain('not of all salon revenue');
    });

    it('never presents service revenue as profitability', async () => {
      const registry = makeRegistry();
      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.service_mix',
        {},
      );

      expect(result.presentation?.limitations.join(' ')).toContain('revenue mix, not profitability');
    });

    it('says so plainly when nothing was booked', async () => {
      const registry = makeRegistry({
        dashboard: {
          kpis: jest.fn(),
          topServices: jest.fn().mockResolvedValue({ ...TOP_SERVICES, services: [] }),
        },
      });

      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.service_mix',
        {},
      );

      expect(result.rowCount).toBe(0);
      expect(result.presentation?.answer).toContain('No services were booked');
    });
  });

  describe('report.retail_performance', () => {
    it('summarises retail value, products and attachment per 100 paid visits', async () => {
      const registry = makeRegistry();
      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.retail_performance',
        {},
      );

      expect(result.status).toBe('ok');
      expect(result.data).toMatchObject({
        sale_count: 2,
        unit_count: 3,
        total_amount_cents: 6200,
        completed_paid_visits: 200,
        attach_rate_percent: 1,
      });
      expect(result.presentation?.answer).toContain('Repair shampoo');
    });

    it('computes margin ONLY from sales carrying a recorded cost, and states coverage', async () => {
      const registry = makeRegistry();
      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.retail_performance',
        {},
      );

      const margin = (result.data as Record<string, unknown>)['margin'] as Record<string, number>;
      // Only s1 has a cost: revenue 3600, cost 900 x 2 = 1800, margin 50%.
      expect(margin).toMatchObject({
        covered_sale_count: 1,
        covered_revenue_cents: 3600,
        cost_cents: 1800,
        margin_percent: 50,
      });
      // 3600 of 6200 total retail value carries a cost.
      expect(margin.coverage_percent).toBe(58);
      expect(result.presentation?.limitations.join(' ')).toContain('not business profit');
    });

    it('returns no margin at all when no sale carries a cost — never a zero margin', async () => {
      const noCost = {
        ...RETAIL,
        sales: [RETAIL.sales[1]],
        totalAmountCents: 2600,
      };
      const registry = makeRegistry({
        retailSales: { list: jest.fn().mockResolvedValue(noCost) } as Partial<RetailSalesService>,
      });

      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.retail_performance',
        {},
      );

      expect((result.data as Record<string, unknown>)['margin']).toBeNull();
      expect(result.presentation?.limitations.join(' ')).toContain('No retail margin is shown');
    });

    it('still answers when the visit denominator is unreadable, omitting attachment', async () => {
      const registry = makeRegistry({
        dashboard: {
          kpis: jest.fn().mockRejectedValue(new Error('no dashboard permission')),
          topServices: jest.fn(),
        },
      });

      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.retail_performance',
        {},
      );

      expect(result.status).toBe('ok');
      expect(result.data).toMatchObject({ attach_rate_percent: null, completed_paid_visits: null });
      expect(result.presentation?.limitations.join(' ')).toContain('Retail attachment per visit is not shown');
    });

    it('is denied to an owner without report.financials.view', async () => {
      const registry = makeRegistry();
      const { result } = await registry.dispatch(
        actorWith(['owner'], ['zac.access', 'report.dashboard.view']),
        context({ permissions: ['zac.access', 'report.dashboard.view'] }),
        'report.retail_performance',
        {},
      );

      expect(result.status).toBe('permission_denied');
      expect(result.data).toBeNull();
    });
  });

  describe('report.client_retention', () => {
    it('reports counts and shares over the MEASURABLE clients only', async () => {
      const listLapsedClients = jest.fn().mockResolvedValue(LAPSE);
      const registry = makeRegistry({ clientIntelligence: { listLapsedClients } });

      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.client_retention',
        {},
      );

      expect(result.status).toBe('ok');
      // 120 + 24 + 16 + 40 = 200 measurable; the 55 without history are excluded.
      expect(result.data).toMatchObject({
        measurable_clients: 200,
        at_risk_clients: 24,
        lapsed_clients: 16,
        at_risk_share_percent: 12,
        lapsed_share_percent: 8,
        insufficient_history_clients: 55,
      });
    });

    it('asks for one row and returns no client identity of any kind', async () => {
      const listLapsedClients = jest.fn().mockResolvedValue(LAPSE);
      const registry = makeRegistry({ clientIntelligence: { listLapsedClients } });

      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.client_retention',
        {},
      );

      expect(listLapsedClients).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'user-1' }),
        expect.objectContaining({ pageSize: 1 }),
      );
      // Nothing that could identify a person survives: the source payload's
      // `clients` array is dropped entirely, and no name/contact field appears.
      const serialised = JSON.stringify(result);
      for (const forbidden of ['displayName', 'clientId', 'email', 'phone', 'lastVisit']) {
        expect(serialised).not.toContain(forbidden);
      }
      expect(result.data).not.toHaveProperty('clients');
      expect(result.presentation?.limitations.join(' ')).toContain('never list or name individual clients');
    });

    it('says it cannot judge retention when nobody has enough history', async () => {
      const thin = {
        ...LAPSE,
        counts: { active: 0, atRisk: 0, lapsed: 0, booked: 0, insufficientHistory: 30 },
        evaluatedClientCount: 30,
      };
      const registry = makeRegistry({
        clientIntelligence: { listLapsedClients: jest.fn().mockResolvedValue(thin) },
      });

      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.client_retention',
        {},
      );

      expect(result.presentation?.answer).toContain('cannot judge retention yet');
      expect(result.presentation?.answer).toContain('history-depth limit');
    });

    it('is denied to an owner without crm.view', async () => {
      const registry = makeRegistry();
      const { result } = await registry.dispatch(
        actorWith(['owner'], ['zac.access', 'report.dashboard.view']),
        context({ permissions: ['zac.access', 'report.dashboard.view'] }),
        'report.client_retention',
        {},
      );

      expect(result.status).toBe('permission_denied');
    });
  });

  describe('report.profitability', () => {
    it('is registered but not connected, and says why without guessing a number', async () => {
      const registry = makeRegistry();
      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.profitability',
        {},
      );

      expect(result.status).toBe('not_connected');
      expect(result.data).toBeNull();
      // The tool's OWN reason reaches the answer, not the generic
      // "not connected yet" — which would promise a figure that is coming.
      expect(result.explanation).toContain('no profitability calculation');
      expect(result.explanation).toContain('will not estimate one');
    });

    it('appears in the catalogue as a disabled capability, not an absent one', () => {
      const registry = makeRegistry();
      const profitability = registry
        .allTools()
        .find((tool) => tool.name === 'report.profitability');

      expect(profitability).toBeDefined();
      expect(profitability?.enabled).toBe(false);
    });
  });

  describe('stylists never see any Workstream 1 business source', () => {
    it.each([
      'report.appointment_summary',
      'report.service_mix',
      'report.retail_performance',
      'report.client_retention',
      'report.profitability',
    ] as const)('hides %s from a fully permissioned stylist', (toolName) => {
      const registry = makeRegistry();
      const visible = registry
        .buildFor(actorWith(['stylist'], ALL_PERMISSIONS))
        .map((tool) => tool.name);

      expect(visible).not.toContain(toolName);
    });
  });

  describe('evidence normalisation and consolidation', () => {
    const evidence = new ZacEvidenceService();
    const priorities = new ZacPriorityService();

    async function resultFor(toolName: Parameters<ZacToolRegistryService['dispatch']>[2]) {
      const registry = makeRegistry();
      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        toolName,
        {},
      );
      return result as ZacToolResult;
    }

    it('turns retention counts into one combined overdue-or-lapsed signal', async () => {
      const signals = evidence.normalise('report.client_retention', await resultFor('report.client_retention'));

      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({
        issueKey: 'client_retention',
        domain: 'client_retention',
        currentValue: 20,
        severity: 'watch',
      });
      expect(signals[0].headline).toContain('40 of 200 measurable clients');
    });

    it('raises retail attachment as a watch point and retail revenue as context', async () => {
      const signals = evidence.normalise('report.retail_performance', await resultFor('report.retail_performance'));

      expect(signals.map((signal) => signal.issueKey)).toEqual([
        'retail_performance',
        'retail_attachment',
      ]);
      expect(signals[1]).toMatchObject({ severity: 'watch', currentValue: 1 });
    });

    it('flags a concentrated service mix as a watch point', async () => {
      const signals = evidence.normalise('report.service_mix', await resultFor('report.service_mix'));

      expect(signals).toHaveLength(1);
      expect(signals[0]).toMatchObject({ issueKey: 'service_concentration', severity: 'watch' });
    });

    it('consolidates the appointment and business-health views of cancellations into ONE issue', async () => {
      const appointmentSignals = evidence.normalise(
        'report.appointment_summary',
        await resultFor('report.appointment_summary'),
      );
      const healthSignals = evidence.normalise(
        'report.business_health',
        await resultFor('report.business_health'),
      );

      const consolidation = priorities.consolidate([...appointmentSignals, ...healthSignals]);
      const cancellationCandidates = consolidation.candidates.filter(
        (candidate) => candidate.title === 'Cancellations',
      );

      expect(cancellationCandidates).toHaveLength(1);
    });

    it('gives every new issue a human title, never an internal key', async () => {
      const signals = [
        ...evidence.normalise('report.client_retention', await resultFor('report.client_retention')),
        ...evidence.normalise('report.retail_performance', await resultFor('report.retail_performance')),
        ...evidence.normalise('report.service_mix', await resultFor('report.service_mix')),
      ];

      const titles = priorities.consolidate(signals).candidates.map((candidate) => candidate.title);
      for (const title of titles) {
        expect(title).not.toMatch(/_/);
      }
    });
  });
});
