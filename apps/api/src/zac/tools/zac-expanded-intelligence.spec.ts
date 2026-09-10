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
import type { PayrollService } from '../../payroll/payroll.service';
import type { OwnerLocationSettingsService } from '../../owner-location-settings/owner-location-settings.service';
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

/** ALL_PERMISSIONS deliberately excludes payroll.view — see the profitability tests. */
const WITH_PAYROLL: Permission[] = [...ALL_PERMISSIONS, 'payroll.view'];

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
    payroll?: Partial<PayrollService>;
    kpi?: Partial<KpiService>;
    utilisation?: Partial<UtilisationService>;
    locationSettings?: Partial<OwnerLocationSettingsService>;
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
    (overrides.kpi ?? { myKpi: jest.fn(), stylistList: jest.fn() }) as KpiService,
    { today: jest.fn(), list: jest.fn() } as unknown as LabAppointmentsService,
    (overrides.utilisation ?? { summary: jest.fn() }) as UtilisationService,
    retailSales as RetailSalesService,
    clientIntelligence as ClientIntelligenceService,
      (overrides.payroll ?? {
        listPeriods: jest.fn().mockResolvedValue({ periods: [] }),
        listSummaries: jest.fn(),
      }) as PayrollService,
      (overrides.locationSettings ?? {
        getSettings: jest.fn().mockResolvedValue({ rebookRateBenchmarkPercent: 50 }),
      }) as OwnerLocationSettingsService,
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

  // ---- Phase 1 reports now honour the period too -------------------------
  // Before this, "last month" was honoured by the newer tools and silently
  // ignored by these three, so the same phrasing behaved differently inside a
  // single conversation with nothing to indicate which had happened.

  it('applies an asked-for window to business health', async () => {
    const kpis = jest.fn().mockResolvedValue(KPIS);
    const registry = makeRegistry({ dashboard: { kpis, topServices: jest.fn() } });

    const { result } = await registry.dispatch(
      actorWith(['owner'], ALL_PERMISSIONS),
      context(),
      'report.business_health',
      { period: parseZacPeriod('how was my business last month?', 7, NOW) },
    );

    expect(kpis).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-09-01T00:00:00.000Z',
      }),
    );
    expect(result.presentation?.answer).toContain('last month');
  });

  it('applies an asked-for window to the rebooking summary', async () => {
    const kpis = jest.fn().mockResolvedValue(KPIS);
    const registry = makeRegistry({ dashboard: { kpis, topServices: jest.fn() } });

    const { result } = await registry.dispatch(
      actorWith(['owner'], ALL_PERMISSIONS),
      context(),
      'report.rebooking_summary',
      { period: parseZacPeriod('what was my rebooking rate in August?', 7, NOW) },
    );

    expect(kpis).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ from: '2026-08-01T00:00:00.000Z' }),
    );
    expect(result.presentation?.answer).toContain('August 2026');
  });

  it('leaves the Phase 1 defaults untouched when no period is named', async () => {
    // The 7-day default is pinned client-accepted behaviour: a question with no
    // period must read exactly as it always did.
    const registry = makeRegistry();
    const { result } = await registry.dispatch(
      actorWith(['owner'], ALL_PERMISSIONS),
      context(),
      'report.business_health',
      { period: parseZacPeriod('how is my business doing?', 7, NOW) },
    );

    expect(result.presentation?.answer).toContain('the last 7 days');
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

  describe('report.profitability — what remains after recorded payroll', () => {
    const PERIOD = {
      period: { id: 'pp-1', periodStart: '2026-08-01', periodEnd: '2026-08-31', label: 'August 2026', status: 'approved' },
      totals: { staffCount: 2, totalGrossPayableCents: 444000, totalBasePayCents: 0, totalCommissionCents: 0, staleCount: 0, currencyCode: 'GBP' },
    };
    const SUMMARIES = {
      period: PERIOD.period,
      periodWarnings: [],
      summaries: [
        { serviceRevenueCents: 600000, retailRevenueCents: 0, grossPayableCents: 266400, isStale: false, currencyCode: 'GBP' },
        { serviceRevenueCents: 400000, retailRevenueCents: 0, grossPayableCents: 177600, isStale: false, currencyCode: 'GBP' },
      ],
    };
    const payrollStub = () => ({
      listPeriods: jest.fn().mockResolvedValue({ periods: [PERIOD] }),
      listSummaries: jest.fn().mockResolvedValue(SUMMARIES),
    });

    it('is denied to an owner without payroll.view', async () => {
      // The figure exposes the wage bill, so report.financials.view is not
      // enough — it sits behind the permission that guards payroll itself.
      const registry = makeRegistry({ payroll: payrollStub() });
      const { result } = await registry.dispatch(
        actorWith(['owner'], ALL_PERMISSIONS),
        context(),
        'report.profitability',
        {},
      );
      expect(result.status).toBe('permission_denied');
      expect(result.data).toBeNull();
    });

    it('reports revenue, recorded payroll and what remains — and states it is NOT net profit', async () => {
      const registry = makeRegistry({ payroll: payrollStub() });
      const { result } = await registry.dispatch(
        actorWith(['owner'], WITH_PAYROLL),
        context(),
        'report.profitability',
        {},
      );

      expect(result.status).toBe('ok');
      // £10,000 revenue - £4,440 payroll = £5,560 (55.6%)
      expect(result.data).toMatchObject({
        revenue_cents: 1000000,
        recorded_payroll_cents: 444000,
        remaining_after_payroll_cents: 556000,
        remaining_after_payroll_percent: 55.6,
      });
      const answer = result.presentation?.answer ?? '';
      expect(answer).toContain('£5560.00');
      expect(answer).toContain('55.6%');
      // The single most important sentence in this tool.
      expect(answer).toMatch(/not your net profit/i);
      expect(answer).toMatch(/rent, products, utilities, software, insurance, taxes/i);
    });

    it('never calls the figure profit, contribution or a margin', async () => {
      // "Profit" means net profit; "contribution margin" means revenue less
      // VARIABLE costs. Payroll alone is neither, and an accountant would catch
      // either label immediately — which would discredit every other figure.
      const registry = makeRegistry({ payroll: payrollStub() });
      const { result } = await registry.dispatch(
        actorWith(['owner'], WITH_PAYROLL),
        context(),
        'report.profitability',
        {},
      );
      const answer = (result.presentation?.answer ?? '').toLowerCase();
      expect(answer).not.toMatch(/profit margin|gross profit|operating profit|contribution/);
      expect(answer).not.toMatch(/retained earnings|available to (withdraw|take)/);
      // It may only say the literal thing it did.
      expect(answer).toMatch(/after recorded payroll/);
    });

    it('refuses to estimate when payroll has not been generated for the window', async () => {
      const registry = makeRegistry({
        payroll: {
          listPeriods: jest.fn().mockResolvedValue({ periods: [{ ...PERIOD, totals: null }] }),
          listSummaries: jest.fn(),
        },
      });
      const { result } = await registry.dispatch(
        actorWith(['owner'], WITH_PAYROLL),
        context(),
        'report.profitability',
        {},
      );
      // Treating an ungenerated period as zero payroll would overstate what
      // remains — the direction that flatters.
      expect(result.status).toBe('not_connected');
      expect(result.explanation).toMatch(/not been generated/i);
      expect(result.explanation).toMatch(/will not estimate/i);
    });

    it('flags stale statements rather than presenting them as settled', async () => {
      const stale = {
        ...SUMMARIES,
        summaries: [{ ...SUMMARIES.summaries[0], isStale: true }, SUMMARIES.summaries[1]],
      };
      const registry = makeRegistry({
        payroll: {
          listPeriods: jest.fn().mockResolvedValue({ periods: [PERIOD] }),
          listSummaries: jest.fn().mockResolvedValue(stale),
        },
      });
      const { result } = await registry.dispatch(
        actorWith(['owner'], WITH_PAYROLL),
        context(),
        'report.profitability',
        {},
      );
      expect(result.presentation?.confidence).toBe('medium');
      expect(result.presentation?.limitations.join(' ')).toMatch(/out of date/i);
    });

    it('is a live capability in the catalogue', () => {
      const registry = makeRegistry({ payroll: payrollStub() });
      const tool = registry.allTools().find((t) => t.name === 'report.profitability');
      expect(tool).toBeDefined();
      expect(tool?.enabled).toBe(true);
      expect(tool?.requiredPermissions).toContain('payroll.view');
    });
  });

  describe('report.scorecard — the important KPIs, judged only against real targets', () => {
    const UTIL = {
      overall: { utilisationPercent: 71, availableMinutes: 9000, bookedMinutes: 6390 },
      warningThresholdPercent: 65,
      byStaffDay: [],
      weekdayPattern: [],
      gaps: [],
    };
    const KPI_LIST = { stylists: [{}, {}, {}], commissionReadyCount: 2, periodStart: '', periodEnd: '' };
    const services = () => ({
      dashboard: { kpis: jest.fn().mockResolvedValue(KPIS), topServices: jest.fn() },
      kpi: { stylistList: jest.fn().mockResolvedValue(KPI_LIST), myKpi: jest.fn() },
      utilisation: { summary: jest.fn().mockResolvedValue(UTIL) },
    });

    it('marks each measure against the target QLOOQO actually holds', async () => {
      const registry = makeRegistry(services());
      const { result } = await registry.dispatch(
        actorWith(['owner'], WITH_PAYROLL),
        context(),
        'report.scorecard',
        {},
      );

      expect(result.status).toBe('ok');
      const byKey = Object.fromEntries(
        (result.data?.measures as Array<Record<string, unknown>>).map((m) => [m.key, m]),
      );
      // Rebooking: judged against the KPI engine's canonical 50% threshold.
      expect(byKey.rebooking_rate).toMatchObject({ target_source: 'canonical_threshold' });
      // Utilisation: judged against the owner-configured warning threshold.
      expect(byKey.utilisation_rate).toMatchObject({
        status: 'on_target',
        target_source: 'location_setting',
      });
      // Team: the KPI engine's own per-stylist verdict, 2 of 3 -> behind.
      expect(byKey.team_kpis).toMatchObject({ status: 'below_target', target_source: 'kpi_engine' });
    });

    it("uses the owner's configured rebook benchmark, not the shipped default", async () => {
      // The defect this pins: judging 58% as "on target" against the shipped
      // 50% while the owner had typed 60% into Record settings. ZAC
      // contradicting a number the owner set themselves is the worst outcome
      // this feature has.
      const svc = services();
      const registry = makeRegistry({
        ...svc,
        locationSettings: { getSettings: jest.fn().mockResolvedValue({ rebookRateBenchmarkPercent: 60 }) },
      });
      const { result } = await registry.dispatch(
        actorWith(['owner'], WITH_PAYROLL),
        context({ locationId: 'loc-1' }),
        'report.scorecard',
        {},
      );
      const byKey = Object.fromEntries(
        (result.data?.measures as Array<Record<string, unknown>>).map((m) => [m.key, m]),
      );
      // 58% against a configured 60% is BELOW target, not on it.
      expect(byKey.rebooking_rate).toMatchObject({
        status: 'below_target',
        target: '60%',
        target_source: 'location_setting',
      });
    });

    it('falls back to the shipped benchmark and says so when the setting is unreadable', async () => {
      const svc = services();
      const registry = makeRegistry({
        ...svc,
        locationSettings: { getSettings: jest.fn().mockRejectedValue(new Error('denied')) },
      });
      const { result } = await registry.dispatch(
        actorWith(['owner'], WITH_PAYROLL),
        context({ locationId: 'loc-1' }),
        'report.scorecard',
        {},
      );
      const byKey = Object.fromEntries(
        (result.data?.measures as Array<Record<string, unknown>>).map((m) => [m.key, m]),
      );
      // "On target" means something different depending on the number it was
      // measured against, so the fallback is reported, not silent.
      expect(byKey.rebooking_rate).toMatchObject({
        target: '50%',
        target_source: 'canonical_threshold',
      });
      expect(result.presentation?.answer).toContain('58%');
    });

    it('shows revenue as context and never invents a target for it', async () => {
      const registry = makeRegistry(services());
      const { result } = await registry.dispatch(
        actorWith(['owner'], WITH_PAYROLL),
        context(),
        'report.scorecard',
        {},
      );
      const byKey = Object.fromEntries(
        (result.data?.measures as Array<Record<string, unknown>>).map((m) => [m.key, m]),
      );
      // "Good revenue" is not a fact QLOOQO holds. Inventing one would be
      // ZAC's opinion wearing QLOOQO's clothes.
      expect(byKey.revenue).toMatchObject({ status: 'no_target', target: null });
      expect(byKey.cancellation_rate).toMatchObject({ status: 'no_target', target: null });
    });

    it('gives a COUNT of measures on target, never a composite score', async () => {
      const registry = makeRegistry(services());
      const { result } = await registry.dispatch(
        actorWith(['owner'], WITH_PAYROLL),
        context(),
        'report.scorecard',
        {},
      );
      const answer = result.presentation?.answer ?? '';
      expect(result.data).toMatchObject({ measures_with_target: 3, measures_on_target: 2 });
      expect(answer).toMatch(/2 of 3 measures with a target/i);
      // A 0-100 index would need an invented weighting and could not be
      // checked against any QLOOQO report.
      expect(answer).not.toMatch(/\bscore of\b|\b\d{1,3}\s*\/\s*100\b|health score/i);
      expect(result.presentation?.limitations.join(' ')).toMatch(/no single health score/i);
    });

    it('says "no target set" rather than passing an unconfigured threshold as healthy', async () => {
      const svc = services();
      svc.utilisation.summary = jest.fn().mockResolvedValue({ ...UTIL, warningThresholdPercent: null });
      const registry = makeRegistry(svc);
      const { result } = await registry.dispatch(
        actorWith(['owner'], WITH_PAYROLL),
        context(),
        'report.scorecard',
        {},
      );
      const byKey = Object.fromEntries(
        (result.data?.measures as Array<Record<string, unknown>>).map((m) => [m.key, m]),
      );
      expect(byKey.utilisation_rate).toMatchObject({ status: 'no_target' });
      expect(result.data).toMatchObject({ measures_with_target: 2 });
    });

    it('degrades one section at a time and never presents a partial view as complete', async () => {
      const svc = services();
      svc.utilisation.summary = jest.fn().mockRejectedValue(new Error('denied'));
      const registry = makeRegistry(svc);
      const { result } = await registry.dispatch(
        actorWith(['owner'], WITH_PAYROLL),
        context(),
        'report.scorecard',
        {},
      );

      expect(result.status).toBe('ok');
      const answer = result.presentation?.answer ?? '';
      expect(answer).toMatch(/rebooking rate/i);
      expect(answer).toMatch(/not a complete picture/i);
      expect(result.presentation?.confidence).toBe('medium');
    });

    it('is hidden from a stylist entirely', () => {
      const registry = makeRegistry(services());
      const visible = registry.buildFor(actorWith(['stylist'], WITH_PAYROLL)).map((t) => t.name);
      expect(visible).not.toContain('report.scorecard');
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
