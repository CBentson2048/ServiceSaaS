import type { AuthUser } from '@sheer/domain';
import { ZacAnalysisIntentService } from '../analysis/zac-analysis-intent.service';
import { ZacEvidenceService } from '../analysis/zac-evidence.service';
import { ZacOrchestratorService } from '../analysis/zac-orchestrator.service';
import { ZacPriorityService } from '../analysis/zac-priority.service';
import { ZacToolPlannerService } from '../analysis/zac-tool-planner.service';
import type { ZacActingContext } from '../context/zac-context.types';
import type { PayrollService } from '../../payroll/payroll.service';
import type { OwnerLocationSettingsService } from '../../owner-location-settings/owner-location-settings.service';
import { ZacToolRegistryService } from '../tools/zac-tool-registry.service';
import type { ClientIntelligenceService } from '../../client-intelligence/client-intelligence.service';
import type { DashboardService } from '../../dashboard/dashboard.service';
import type { KpiService } from '../../kpi/kpi.service';
import type { LabAppointmentsService } from '../../lab-appointments/lab-appointments.service';
import type { LabAnalyticsService } from '../../lab-analytics/lab-analytics.service';
import type { ColourPrepService } from '../../colour-prep/colour-prep.service';
import type { InventoryService } from '../../inventory/inventory.service';
import type { OrdersService } from '../../orders/orders.service';
import type { RetailSalesService } from '../../retail-sales/retail-sales.service';
import type { UtilisationService } from '../../kpi/utilisation.service';
import type {
  ZacAnalysisPlanOutcome,
  ZacModelCompletion,
  ZacModelProvider,
  ZacPrioritySynthesisOutcome,
} from '../models/zac-model-provider.interface';

/**
 * BEHAVIOURAL PARITY.
 *
 * Provider choice changes ZAC's INTELLIGENCE. It must not change ZAC's
 * AUTHORITY MODEL. These tests hold two providers to the same deterministic
 * outputs and assert that everything the server decides for itself — which
 * tools may run, what evidence they produce, how issues consolidate, how many
 * priorities come back — is byte-identical.
 *
 * That is the property that lets a benchmark mean anything. If OpenAI and
 * Anthropic could reach different tool sets or different permissions, a
 * "quality" difference between them would partly be a difference in what they
 * were allowed to see, and no scorecard could separate the two.
 */

const OWNER: AuthUser = {
  id: 'u1',
  roles: ['owner'],
  primaryRole: 'owner',
  businessId: 'b1',
  allowedLocationIds: ['l1'],
  locationScope: { kind: 'all', locationIds: ['l1'] },
  locations: [],
  profile: { id: 'u1', fullName: 'Olive Owner', email: 'olive@example.com' },
  permissions: ['zac.access', 'report.dashboard.view', 'report.performance.view'],
} as unknown as AuthUser;

const STYLIST: AuthUser = {
  ...OWNER,
  id: 'u2',
  roles: ['stylist'],
  primaryRole: 'stylist',
  permissions: ['zac.access'],
} as unknown as AuthUser;


/** Read-only inventory fake. Empty by default; the WS3 tools have their own specs. */
const INVENTORY_FAKE = {
  listStock: jest.fn().mockResolvedValue({ stock: [], locations: [], scope: 'owner' }),
  listLowStock: jest.fn().mockResolvedValue({ alerts: [] }),
  listDeadStock: jest.fn().mockResolvedValue({ items: [], locations: [], totalEstimatedValueCents: 0 }),
  listMovements: jest.fn().mockResolvedValue({ movements: [] }),
  listProducts: jest.fn().mockResolvedValue({ products: [] }),
  listSuppliers: jest.fn().mockResolvedValue({ suppliers: [] }),
  listCategories: jest.fn().mockResolvedValue({ categories: [] }),
};

/** An empty colour-prep plan — the shape ColourPrepService.getPlan returns. */
const EMPTY_COLOUR_PREP = {
  locationId: 'loc-1',
  locationName: 'Main',
  timezone: 'Europe/London',
  range: 'custom',
  from: '2026-09-11T00:00:00.000Z',
  to: '2026-09-25T00:00:00.000Z',
  fromDate: '2026-09-11',
  toDate: '2026-09-24',
  wasteAllowancePercent: 10,
  appointments: [],
  products: [],
  summary: {
    appointmentCount: 0,
    appointmentsWithoutFormula: 0,
    productCount: 0,
    shortfallProductCount: 0,
    lowStockProductCount: 0,
    unmappedProductCount: 0,
  },
};

/** An empty reorder preview — the shape OrdersService.previewReorder returns. */
const EMPTY_REORDER_PREVIEW = {
  locationId: 'loc-1',
  windowWeeks: 8,
  coverageWeeks: 4,
  windowFromIso: '2026-07-17T00:00:00.000Z',
  usageObserved: false,
  lines: [],
  unorderable: [],
  linesWithoutCost: 0,
};

/** A readable but empty colour summary — the shape LabAnalyticsService.summary returns. */
const EMPTY_LAB_ANALYTICS = {
  range: 'custom',
  rangeStart: '2026-06-13T00:00:00.000Z',
  rangeEnd: '2026-09-11T00:00:00.000Z',
  scope: 'owner',
  summary: {
    colourRevenueCents: 0,
    formulaCostCents: 0,
    grossMarginCents: 0,
    grossMarginPercent: 0,
    wasteCostCents: 0,
    wastePercentOfRevenue: 0,
    formulasMixed: 0,
    currencyCode: 'GBP',
  },
  byLocation: [],
  byStylist: [],
  averageFormulaCostByServiceType: [],
  mostUsedProductsByWeight: [],
  mostUsedProductsByCost: [],
  lowStockAlerts: [],
};

function context(overrides: Partial<ZacActingContext> = {}): ZacActingContext {
  return {
    actorUserId: 'u1',
    actorFirstName: 'Olive',
    businessId: 'b1',
    businessName: 'Salon',
    locationId: null,
    accessibleLocationIds: ['l1'],
    accessibleLocations: [{ id: 'l1', name: 'Pinner' }],
    roleContext: 'owner',
    roles: ['owner'],
    permissions: OWNER.permissions,
    staffProfileId: null,
    requestSource: 'web_dashboard',
    timezone: 'Europe/London',
    locale: 'en-GB',
    firstAssistantTurn: true,
    ...overrides,
  };
}

const KPIS = {
  rangeStart: '2026-08-28T00:00:00.000Z',
  rangeEnd: '2026-09-04T00:00:00.000Z',
  scope: 'owner' as const,
  locations: [{ id: 'l1', name: 'Pinner' }],
  summary: {
    totalRevenueCents: 500_000,
    totalBookings: 120,
    completedBookings: 110,
    cancelledBookings: 10,
    noShowBookings: 0,
    newClients: 20,
    repeatClients: 90,
    rebookedVisits: 33,
    rebookingRatePercent: 30,
    stylistRebookedVisits: 20,
    clientRebookedVisits: 13,
    completedPaidBookings: 110,
    averageBookingValueCents: 4545,
    lowStockProducts: 0,
    currencyCode: 'GBP',
  },
  byLocation: [],
};

/** A registry over frozen QLOOQO data — identical for every provider. */
function makeRegistry(): ZacToolRegistryService {
  const dashboard = {
    kpis: jest.fn().mockResolvedValue(KPIS),
    stylistPerformance: jest.fn().mockResolvedValue({ stylists: [] }),
  } as unknown as DashboardService;
  const kpi = {
    stylistList: jest.fn().mockResolvedValue({ stylists: [], commissionReadyCount: 0 }),
    myKpi: jest.fn().mockResolvedValue({}),
  } as unknown as KpiService;
  const utilisation = { summary: jest.fn().mockRejectedValue(new Error('n/a')) } as unknown as UtilisationService;
  const labAppointments = { today: jest.fn(), list: jest.fn() } as unknown as LabAppointmentsService;
  const retailSales = {
    list: jest.fn().mockResolvedValue({ sales: [], totalAmountCents: 0, currencyCode: 'GBP' }),
  } as unknown as RetailSalesService;
  const clientIntelligence = {
    listLapsedClients: jest.fn().mockResolvedValue({
      clients: [],
      counts: { active: 0, atRisk: 0, lapsed: 0, booked: 0, insufficientHistory: 0 },
      settings: { lapsedBufferDays: 14, minCompletedVisits: 3, historyVisitLimit: 10 },
      truncated: false,
      evaluatedClientCount: 0,
      pagination: { page: 1, pageSize: 1, total: 0, totalPages: 1 },
    }),
  } as unknown as ClientIntelligenceService;
  return new ZacToolRegistryService(
    dashboard,
    kpi,
    labAppointments,
    utilisation,
    retailSales,
    clientIntelligence,
      {
        listPeriods: jest.fn().mockResolvedValue({ periods: [] }),
        listSummaries: jest.fn(),
      } as unknown as PayrollService,
      {
        getSettings: jest.fn().mockResolvedValue({ rebookRateBenchmarkPercent: 50 }),
      } as unknown as OwnerLocationSettingsService,
      {
        // Workstream 3 — colour analytics. Empty by default: these suites
        // cover other tools, and an empty summary exercises the colour
        // tool's not-configured branch without asserting on it.
        summary: jest.fn().mockResolvedValue(EMPTY_LAB_ANALYTICS),
      } as unknown as LabAnalyticsService,
      INVENTORY_FAKE as unknown as InventoryService,
      {
        // Workstream 3 — colour prep and ordering. Empty by default: these
        // suites cover other tools, and the WS3 tools have their own specs.
        getPlan: jest.fn().mockResolvedValue(EMPTY_COLOUR_PREP),
      } as unknown as ColourPrepService,
      {
        previewReorder: jest.fn().mockResolvedValue(EMPTY_REORDER_PREVIEW),
        list: jest.fn().mockResolvedValue({ orders: [] }),
        getOrder: jest.fn(),
      } as unknown as OrdersService,
    );
}

const PLAN: ZacAnalysisPlanOutcome = {
  raw: {
    analysis_intent: 'business_priorities',
    reason_code: 'business_priority_request',
    confidence: 0.9,
    synthesis_strategy: 'rank_business_priorities',
    tools: [{ tool_name: 'report.business_health', purpose: 'baseline' }],
  },
  failure: null,
  completion: null,
};

const SYNTHESIS: ZacPrioritySynthesisOutcome = {
  raw: { preamble: '', priorities: [] },
  failure: null,
  completion: null,
};

/**
 * Two providers, different vendor identities, IDENTICAL ZAC-contract outputs.
 * Any downstream difference is therefore caused by the vendor label alone —
 * which is exactly what must never happen.
 */
function makeProvider(name: string, model: string): ZacModelProvider {
  const completion: ZacModelCompletion = {
    text: 'Rebooking is 30%.',
    provider: name,
    model,
    inputTokens: 10,
    outputTokens: 5,
    reasoningTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    estimatedCostUsd: 0,
  };
  return {
    name,
    model,
    narrates: true,
    semanticRouting: true,
    complete: jest.fn().mockResolvedValue(completion),
    planAnalysis: jest.fn().mockResolvedValue(PLAN),
    synthesisePriorities: jest.fn().mockResolvedValue(SYNTHESIS),
  };
}

function makeOrchestrator(provider: ZacModelProvider, registry: ZacToolRegistryService) {
  return new ZacOrchestratorService(
    new ZacAnalysisIntentService(),
    new ZacToolPlannerService(registry),
    new ZacEvidenceService(),
    new ZacPriorityService(),
    registry,
    provider,
  );
}

const QUESTION = 'What are the two biggest things I should focus on?';

async function runTurn(provider: ZacModelProvider, actor: AuthUser, acting: ZacActingContext) {
  const registry = makeRegistry();
  const orchestrator = makeOrchestrator(provider, registry);
  const decided = await orchestrator.decideAnalysis({
    question: QUESTION,
    context: acting,
    actor,
    recentTurnSummaries: [],
    memory: [],
  });
  const plan = orchestrator.buildPlan({ decision: decided.decision, actor, context: acting });
  const executed = await orchestrator.execute({
    actor,
    context: acting,
    plan: plan.plan,
    capability: plan.capability,
    toolInput: () => ({}),
    memory: [],
  });
  return { orchestrator, registry, plan, executed };
}

const openai = () => makeProvider('openai', 'gpt-5.6-luna');
const anthropic = () => makeProvider('anthropic', 'claude-opus-5');

describe('switching provider changes intelligence, never authority', () => {
  it('reaches the same permission-filtered tool catalogue', () => {
    const registry = makeRegistry();
    const forOwner = registry.buildFor(OWNER).map((tool) => tool.name).sort();
    const forStylist = registry.buildFor(STYLIST).map((tool) => tool.name).sort();

    // The catalogue is decided by role and permissions, server-side, before any
    // model is consulted — so it cannot vary by vendor.
    expect(forOwner).not.toEqual(forStylist);
    expect(forStylist).not.toContain('report.business_health');
  });

  it('produces identical evidence signals under either provider', async () => {
    const a = await runTurn(openai(), OWNER, context());
    const b = await runTurn(anthropic(), OWNER, context());
    expect(a.executed.result.signals).toEqual(b.executed.result.signals);
  });

  it('consolidates to identical priority candidates under either provider', async () => {
    const a = await runTurn(openai(), OWNER, context());
    const b = await runTurn(anthropic(), OWNER, context());
    expect(a.executed.result.consolidation).toEqual(b.executed.result.consolidation);
  });

  it('honours the requested count identically under either provider', async () => {
    const priorities = new ZacPriorityService();
    const a = await runTurn(openai(), OWNER, context());
    const b = await runTurn(anthropic(), OWNER, context());

    const requested = priorities.requestedCount(QUESTION);
    expect(requested).toBe(2);
    const topA = priorities.selectTop(a.executed.result.consolidation?.candidates ?? [], requested);
    const topB = priorities.selectTop(b.executed.result.consolidation?.candidates ?? [], requested);
    expect(topA).toEqual(topB);
    expect(topA.length).toBeLessThanOrEqual(2);
  });

  it('dispatches the same tools with the same statuses', async () => {
    const a = await runTurn(openai(), OWNER, context());
    const b = await runTurn(anthropic(), OWNER, context());
    const shape = (run: Awaited<ReturnType<typeof runTurn>>) =>
      run.executed.result.executions.map((execution) => ({
        tool: execution.toolName,
        status: execution.status,
        ok: execution.ok,
      }));
    expect(shape(a)).toEqual(shape(b));
  });

  it('refuses a stylist the same tools whichever provider is configured', async () => {
    const stylistContext = context({
      actorUserId: 'u2',
      roleContext: 'stylist',
      roles: ['stylist'],
      permissions: STYLIST.permissions,
    });
    const a = await runTurn(openai(), STYLIST, stylistContext);
    const b = await runTurn(anthropic(), STYLIST, stylistContext);

    // Whatever the model proposed, the registry re-checks at dispatch. The
    // provider is never the security boundary, and a vendor swap cannot make
    // it one.
    expect(a.executed.result.capability.executable).toEqual(
      b.executed.result.capability.executable,
    );
    expect(a.executed.result.capability.executable).not.toContain('report.business_health');
  });

  it('never lets a model-proposed tool escape the permitted catalogue', async () => {
    // Both providers propose a real tool the STYLIST may not use.
    const rogue = makeProvider('openai', 'gpt-5.6-luna');
    rogue.planAnalysis = jest.fn().mockResolvedValue({
      ...PLAN,
      raw: {
        ...PLAN.raw,
        tools: [{ tool_name: 'report.business_health', purpose: 'baseline' }],
      },
    });
    const stylistContext = context({
      actorUserId: 'u2',
      roleContext: 'stylist',
      roles: ['stylist'],
      permissions: STYLIST.permissions,
    });
    const run = await runTurn(rogue, STYLIST, stylistContext);
    expect(run.plan.plan.tools.map((tool) => tool.toolName)).not.toContain(
      'report.business_health',
    );
  });
});
