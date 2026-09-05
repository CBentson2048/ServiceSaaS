import type { ConfigService } from '@nestjs/config';
import type { AuthUser, Permission } from '@sheer/domain';
import {
  createSupabaseFake,
  createSupabaseFakeState,
  type SupabaseFakeState,
} from '../../common/testing/supabase-fake';
import { ZacPriorityService } from '../analysis/zac-priority.service';
import type { ZacActingContext } from '../context/zac-context.types';
import { ZacCostTelemetryService } from '../measurement/zac-cost-telemetry.service';
import { ZacIntelligenceSignalStore } from '../persistence/zac-intelligence-signal.store';
import type { ZacToolName, ZacToolResult } from '../tools/zac-tool.types';
import type { ZacToolRegistryService } from '../tools/zac-tool-registry.service';
import { ZacIntelligenceSignalService } from './zac-intelligence-signal.service';
import { ZacMetricObservationService } from './zac-metric-observation.service';
import { ZacSignalEvaluatorRegistry } from './zac-signal-evaluator.registry';
import { ZacSignalPriorityAdapter } from './zac-signal-priority.adapter';
import { ZacSignalReconciler } from './zac-signal-reconciler';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(() => (globalThis as { __supabaseFake?: unknown }).__supabaseFake),
}));

const BUSINESS_A = 'b0000000-0000-0000-0000-00000000000a';
const BUSINESS_B = 'b0000000-0000-0000-0000-00000000000b';
const LOCATION_1 = 'l0000000-0000-0000-0000-000000000001';
const LOCATION_2 = 'l0000000-0000-0000-0000-000000000002';
const OWNER_ID = 'u0000000-0000-0000-0000-000000000001';
const MANAGER_ID = 'u0000000-0000-0000-0000-000000000002';
const STYLIST_ID = 'u0000000-0000-0000-0000-000000000003';
const NOW = '2026-09-04T09:00:00.000Z';
const TABLE = 'zac.intelligence_signals';

const OWNER_PERMISSIONS: Permission[] = [
  'zac.access',
  'report.dashboard.view',
  'report.performance.view',
];

function authUser(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: OWNER_ID,
    roles: ['owner'],
    primaryRole: 'owner',
    businessId: BUSINESS_A,
    allowedLocationIds: [LOCATION_1, LOCATION_2],
    locationScope: 'all',
    locations: [],
    profile: { id: OWNER_ID, fullName: 'Olive Owner', email: 'olive@example.com' },
    permissions: OWNER_PERMISSIONS,
    ...overrides,
  } as unknown as AuthUser;
}

function actingContext(overrides: Partial<ZacActingContext> = {}): ZacActingContext {
  return {
    actorUserId: OWNER_ID,
    actorFirstName: 'Olive',
    businessId: BUSINESS_A,
    businessName: 'Luke Ormsby Hair',
    locationId: null,
    accessibleLocationIds: [LOCATION_1, LOCATION_2],
    accessibleLocations: [
      { id: LOCATION_1, name: 'Pinner' },
      { id: LOCATION_2, name: 'Primrose Hill' },
    ],
    roleContext: 'owner',
    roles: ['owner'],
    permissions: OWNER_PERMISSIONS,
    staffProfileId: null,
    requestSource: 'web_dashboard',
    timezone: 'Europe/London',
    locale: 'en-GB',
    firstAssistantTurn: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

function rebookingResult(ratePercent: number, completedBookings: number): ZacToolResult {
  return {
    status: 'ok',
    data: {
      range_start: '2026-08-28T09:00:00.000Z',
      range_end: '2026-09-04T09:00:00.000Z',
      rebooking_rate_percent: ratePercent,
      completed_bookings: completedBookings,
      by_location: [],
    },
    explanation: '',
    rowCount: 1,
    presentation: {
      answer: 'x',
      evidence: [
        {
          source_type: 'report.dashboard',
          source_ref: 'DashboardService.kpis',
          as_of: '2026-09-04T09:00:00.000Z',
          entities_used: [],
        },
      ],
      confidence: 'medium',
      limitations: [],
      suggestedNextStep: null,
      responseType: 'Insight',
    },
  };
}

function utilisationResult(percent: number, threshold: number | null): ZacToolResult {
  return {
    status: 'ok',
    data: {
      rangeStart: '2026-08-28T00:00:00.000Z',
      rangeEnd: '2026-09-04T00:00:00.000Z',
      overall: { availableMinutes: 6000, bookedMinutes: 2400, utilisationPercent: percent, staffDayCount: 20 },
      previousPeriod: { availableMinutes: 6000, bookedMinutes: 0, utilisationPercent: null },
      byLocation: [],
      byWeekday: [],
      largestGaps: [],
      warningThresholdPercent: threshold,
      dataQuality: [],
    },
    explanation: '',
    rowCount: 20,
    presentation: {
      answer: 'x',
      evidence: [
        {
          source_type: 'report.utilisation',
          source_ref: 'computeDailyUtilisation',
          as_of: '2026-09-04T00:00:00.000Z',
          entities_used: [],
        },
      ],
      confidence: 'medium',
      limitations: [],
      suggestedNextStep: null,
      responseType: 'Insight',
    },
  };
}

const denied: ZacToolResult = {
  status: 'permission_denied',
  data: null,
  explanation: 'That data is not available to your role.',
  rowCount: null,
};

interface Harness {
  service: ZacIntelligenceSignalService;
  store: ZacIntelligenceSignalStore;
  state: SupabaseFakeState;
  dispatch: jest.Mock;
  rows: () => Record<string, unknown>[];
}

function makeService(
  seed: Record<string, Record<string, unknown>[]> = {},
  results: Partial<Record<ZacToolName, ZacToolResult>> = {},
): Harness {
  const state = createSupabaseFakeState(seed);
  (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);

  const config = {
    get: jest.fn(),
    getOrThrow: jest.fn((key: string) => `fake-${key}`),
  } as unknown as ConfigService;

  const dispatch = jest.fn(async (_actor, _context, toolName: ZacToolName) => ({
    result: results[toolName] ?? rebookingResult(34, 120),
    trace: { tool: toolName, status: 'ok' as const, latency_ms: 1, row_count: 1 },
  }));
  const tools = { dispatch } as unknown as ZacToolRegistryService;

  const store = new ZacIntelligenceSignalStore(config);
  const service = new ZacIntelligenceSignalService(
    tools,
    new ZacMetricObservationService(),
    new ZacSignalEvaluatorRegistry(),
    new ZacSignalReconciler(),
    store,
    new ZacPriorityService(),
    new ZacSignalPriorityAdapter(),
    new ZacCostTelemetryService(),
  );

  return { service, store, state, dispatch, rows: () => state.tables.get(TABLE) ?? [] };
}

const run = { traceId: 't-1', evaluatedAt: NOW };

// ===========================================================================

describe('evaluation writes persisted signals', () => {
  it('opens one signal per metric and scope, with safe references only', async () => {
    const { service, rows } = makeService(
      { [TABLE]: [] },
      {
        'report.rebooking_summary': rebookingResult(34, 120),
        'report.utilisation_summary': utilisationResult(44, 60),
      },
    );

    const result = await service.evaluate(authUser(), actingContext(), run);

    expect(result.reconciliation.opened).toBeGreaterThan(0);
    expect(result.persistenceErrors).toEqual([]);
    for (const row of rows()) {
      expect(row['business_id']).toBe(BUSINESS_A);
      expect(row['status']).toBe('active');
      // Safe references, never a payload.
      expect(Array.isArray(row['metric_refs'])).toBe(true);
      expect(row['headline_redacted']).toEqual(expect.any(String));
      expect(JSON.stringify(row)).not.toContain('bookedMinutes');
    }
  });

  it('evaluates the business scope and each location for a multi-location business', async () => {
    const { service, dispatch } = makeService({ [TABLE]: [] });
    await service.evaluate(authUser(), actingContext(), run);

    const locations = dispatch.mock.calls.map((call) => call[1].locationId);
    expect(locations).toContain(null);
    expect(locations).toContain(LOCATION_1);
    expect(locations).toContain(LOCATION_2);
  });

  it('evaluates a single-location owner exactly once per metric', async () => {
    const { service, dispatch } = makeService({ [TABLE]: [] });
    await service.evaluate(
      authUser({ allowedLocationIds: [LOCATION_1] }),
      actingContext({
        accessibleLocationIds: [LOCATION_1],
        accessibleLocations: [{ id: LOCATION_1, name: 'Pinner' }],
      }),
      run,
    );
    // Two metrics, one scope — never the same reading twice under two names.
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it('honours an explicit location focus rather than widening past it', async () => {
    const { service, dispatch } = makeService({ [TABLE]: [] });
    await service.evaluate(authUser(), actingContext({ locationId: LOCATION_1 }), run);
    for (const call of dispatch.mock.calls) {
      expect(call[1].locationId).toBe(LOCATION_1);
    }
  });

  it('does nothing at all when ZAC access has been revoked', async () => {
    const { service, dispatch, rows } = makeService({ [TABLE]: [] });
    const result = await service.evaluate(
      authUser({ permissions: ['report.dashboard.view', 'report.performance.view'] }),
      actingContext(),
      run,
    );
    // The feature gate belongs on the write path too: an actor who cannot be
    // shown a signal must not be able to open, refresh or resolve one.
    expect(dispatch).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
    expect(result.reconciliation.actions).toEqual([]);
  });

  it('never dispatches a metric the actor lacks the permission for', async () => {
    const { service, dispatch } = makeService({ [TABLE]: [] });
    await service.evaluate(
      authUser({ permissions: ['zac.access', 'report.dashboard.view'] }),
      actingContext({ permissions: ['zac.access', 'report.dashboard.view'] }),
      run,
    );
    const dispatched = dispatch.mock.calls.map((call) => call[2]);
    expect(dispatched).toContain('report.rebooking_summary');
    expect(dispatched).not.toContain('report.utilisation_summary');
  });

  it('turns a denied tool into a missing observation, never a signal', async () => {
    const { service, rows } = makeService(
      { [TABLE]: [] },
      { 'report.rebooking_summary': denied, 'report.utilisation_summary': denied },
    );
    const result = await service.evaluate(authUser(), actingContext(), run);
    expect(rows()).toHaveLength(0);
    expect(result.withheld.every((entry) => entry.reason === 'missing')).toBe(true);
  });

  it('ABORTS rather than reconcile against an unreadable store', async () => {
    // Reading no signals and failing to read signals are different facts, and
    // the second one is not safe to proceed from: an empty `existing` set would
    // make every candidate look new, so a read failure would silently reopen
    // every problem the business already has. It is the same invariant that
    // stops a missing observation resolving a signal, applied to the store.
    const { service, state } = makeService({ [TABLE]: [] });
    state.errors.set(TABLE, { message: 'storage down' });
    await expect(service.evaluate(authUser(), actingContext(), run)).rejects.toThrow(
      /zac intelligence signal list failed/,
    );
  });

  it('reports a WRITE failure per action and finishes the rest of the plan', async () => {
    const { service, store, rows } = makeService(
      { [TABLE]: [] },
      {
        'report.rebooking_summary': rebookingResult(34, 120),
        'report.utilisation_summary': utilisationResult(44, 60),
      },
    );
    const insert = jest.spyOn(store, 'insert');
    insert.mockRejectedValueOnce(new Error('write rejected'));

    const context = actingContext({
      accessibleLocationIds: [LOCATION_1],
      accessibleLocations: [{ id: LOCATION_1, name: 'Pinner' }],
    });
    const result = await service.evaluate(authUser(), context, run);

    // One write failed, the other still landed — abandoning the plan half-way
    // could leave a resolved condition sitting on an owner's list.
    expect(result.persistenceErrors).toHaveLength(1);
    expect(result.persistenceErrors[0]).toContain('write rejected');
    expect(rows()).toHaveLength(1);
  });
});

// ===========================================================================
// Fixture K — permissions are re-evaluated at retrieval
// ===========================================================================

describe('K: a permission removed after a signal was written hides it', () => {
  const storedRow = (overrides: Record<string, unknown> = {}) => ({
    id: 'sig-1',
    business_id: BUSINESS_A,
    location_id: null,
    subject_user_id: null,
    signal_key: `${BUSINESS_A}|rebooking_shortfall|rebooking_rate|business|-|-|shortfall`,
    evaluator_key: 'rebooking_shortfall',
    metric_key: 'rebooking_rate',
    issue_key: 'rebooking',
    scope_type: 'business',
    scope_label: 'Luke Ormsby Hair',
    visibility_scope: 'business_owner',
    signal_type: 'opportunity',
    severity: 'attention',
    materiality: 0.32,
    confidence: 0.85,
    direction: 'unknown',
    observation_status: 'valid',
    observed_value: 34,
    comparison_value: null,
    target_value: 50,
    target_source: 'canonical_threshold',
    sample_size: 120,
    period_label: '2026-08-28..2026-09-04',
    metric_refs: [],
    evidence_refs: [],
    limitations: [],
    headline_redacted: 'Rebooking rate is 34% against a 50% target.',
    status: 'active',
    resolution_reason: null,
    occurrence_count: 1,
    first_evaluated_at: NOW,
    last_evaluated_at: NOW,
    last_confirmed_at: NOW,
    resolved_at: null,
    suppressed_until: null,
    expires_at: '2026-09-25T09:00:00.000Z',
    ...overrides,
  });

  it('returns the signal while the metric permission is held', async () => {
    const { service } = makeService({ [TABLE]: [storedRow()] });
    const visible = await service.listVisible(authUser(), actingContext());
    expect(visible).toHaveLength(1);
    expect(visible[0].metricKey).toBe('rebooking_rate');
  });

  it('hides it the moment that permission is revoked — the stored scope is unchanged', async () => {
    const { service } = makeService({ [TABLE]: [storedRow()] });
    const stripped = authUser({ permissions: ['zac.access'] });
    const visible = await service.listVisible(stripped, actingContext());
    expect(visible).toHaveLength(0);
  });

  it('hides everything when ZAC access itself is revoked', async () => {
    const { service } = makeService({ [TABLE]: [storedRow()] });
    const visible = await service.listVisible(
      authUser({ permissions: ['report.dashboard.view', 'report.performance.view'] }),
      actingContext(),
    );
    expect(visible).toHaveLength(0);
  });

  it('removes a revoked signal from the priority candidates too', async () => {
    const { service } = makeService({ [TABLE]: [storedRow()] });
    const withPermission = await service.priorityCandidates(authUser(), actingContext());
    expect(withPermission.candidates).toHaveLength(1);

    const withoutPermission = await service.priorityCandidates(
      authUser({ permissions: ['zac.access'] }),
      actingContext(),
    );
    expect(withoutPermission.candidates).toHaveLength(0);
  });

  it('refuses to suppress a signal the actor may no longer see', async () => {
    const { service, rows } = makeService({ [TABLE]: [storedRow()] });
    const suppressed = await service.suppress(
      authUser({ permissions: ['zac.access'] }),
      actingContext(),
      'sig-1',
      '2026-10-01T00:00:00.000Z',
      NOW,
    );
    expect(suppressed).toBe(false);
    expect(rows()[0]['status']).toBe('active');
  });

  it('refuses an unbounded or backdated suppression window', async () => {
    // There is no unsuppress path in this workstream, so an open-ended window
    // would silence a real business problem permanently.
    const { service, rows } = makeService({ [TABLE]: [storedRow()] });
    for (const until of ['', 'never', '2026-09-04T09:00:00.000Z', '2026-01-01T00:00:00.000Z']) {
      expect(await service.suppress(authUser(), actingContext(), 'sig-1', until, NOW)).toBe(false);
    }
    expect(rows()[0]['status']).toBe('active');
  });

  it('caps a suppression at the metric credibility window', async () => {
    // Rebooking stays credible for 21 days; a year-long silence would outlive
    // the reading it was silencing.
    const { service, rows } = makeService({ [TABLE]: [storedRow()] });
    expect(
      await service.suppress(authUser(), actingContext(), 'sig-1', '2027-09-04T09:00:00.000Z', NOW),
    ).toBe(true);
    expect(rows()[0]['suppressed_until']).toBe('2026-09-25T09:00:00.000Z');
  });

  it('suppresses when the actor may see it', async () => {
    const { service, rows } = makeService({ [TABLE]: [storedRow()] });
    const suppressed = await service.suppress(
      authUser(),
      actingContext(),
      'sig-1',
      '2026-10-01T00:00:00.000Z',
      NOW,
    );
    expect(suppressed).toBe(true);
    expect(rows()[0]['status']).toBe('suppressed');
    expect(rows()[0]['resolution_reason']).toBe('suppressed_by_actor');
  });

  // -------------------------------------------------------------------------
  // Visibility boundaries
  // -------------------------------------------------------------------------

  it('keeps a location-scoped signal inside the manager location scope', async () => {
    const { service } = makeService({
      [TABLE]: [
        storedRow({
          id: 'sig-loc-2',
          location_id: LOCATION_2,
          scope_type: 'location',
          visibility_scope: 'manager_team_theme',
        }),
      ],
    });

    const managerAtOne = authUser({
      id: MANAGER_ID,
      roles: ['manager'],
      primaryRole: 'manager',
      allowedLocationIds: [LOCATION_1],
    });
    const contextAtOne = actingContext({
      actorUserId: MANAGER_ID,
      roleContext: 'manager',
      roles: ['manager'],
      accessibleLocationIds: [LOCATION_1],
      accessibleLocations: [{ id: LOCATION_1, name: 'Pinner' }],
    });

    expect(await service.listVisible(managerAtOne, contextAtOne)).toHaveLength(0);
    // The owner sees every location in their own business.
    expect(await service.listVisible(authUser(), actingContext())).toHaveLength(1);
  });

  it('keeps a business-scope signal owner-only: a manager\'s own tools would never return the business-wide KPI', async () => {
    const { service } = makeService({
      [TABLE]: [storedRow({ id: 'sig-biz', location_id: null, scope_type: 'business', visibility_scope: 'business_owner' })],
    });
    const manager = authUser({ id: MANAGER_ID, roles: ['manager'], primaryRole: 'manager', allowedLocationIds: [LOCATION_1] });
    const context = actingContext({
      actorUserId: MANAGER_ID,
      roleContext: 'manager',
      roles: ['manager'],
      accessibleLocationIds: [LOCATION_1],
      accessibleLocations: [{ id: LOCATION_1, name: 'Pinner' }],
    });
    expect(await service.listVisible(manager, context)).toHaveLength(0);
    expect(await service.listVisible(authUser(), actingContext())).toHaveLength(1);
  });

  it('lets a suppression end by itself: the row is readable again once its window has lapsed, before any reading flips its status', async () => {
    const { service } = makeService({
      [TABLE]: [
        storedRow({
          id: 'sig-suppressed',
          status: 'suppressed',
          resolution_reason: 'suppressed_by_actor',
          suppressed_until: '2026-09-10T00:00:00.000Z',
        }),
      ],
    });
    // Inside the window: hidden, exactly as a suppression promises.
    expect(await service.listVisible(authUser(), actingContext(), '2026-09-08T09:00:00.000Z')).toHaveLength(0);
    // Window lapsed, status still 'suppressed' in the store: visible again — a
    // missing read after the lapse (which correctly retains) must not hide a
    // live problem indefinitely.
    expect(await service.listVisible(authUser(), actingContext(), '2026-09-11T09:00:00.000Z')).toHaveLength(1);
  });

  it('fails closed for a team-scoped signal with no resolvable location', async () => {
    const { service } = makeService({
      [TABLE]: [
        storedRow({ location_id: null, scope_type: 'team', visibility_scope: 'manager_team_theme' }),
      ],
    });
    const manager = authUser({ id: MANAGER_ID, roles: ['manager'], primaryRole: 'manager' });
    const context = actingContext({ actorUserId: MANAGER_ID, roleContext: 'manager', roles: ['manager'] });
    expect(await service.listVisible(manager, context)).toHaveLength(0);
  });

  it('keeps a personal signal private to its subject, whatever the reader role', async () => {
    const { service } = makeService({
      [TABLE]: [
        storedRow({
          scope_type: 'personal',
          visibility_scope: 'stylist_private',
          subject_user_id: STYLIST_ID,
        }),
      ],
    });

    // The owner does NOT widen into a stylist's private signal.
    expect(await service.listVisible(authUser(), actingContext())).toHaveLength(0);

    const stylist = authUser({ id: STYLIST_ID, roles: ['stylist'], primaryRole: 'stylist' });
    const stylistContext = actingContext({
      actorUserId: STYLIST_ID,
      roleContext: 'stylist',
      roles: ['stylist'],
    });
    expect(await service.listVisible(stylist, stylistContext)).toHaveLength(1);
  });

  it('shows a stylist nothing business-scoped', async () => {
    const { service } = makeService({ [TABLE]: [storedRow()] });
    const stylist = authUser({ id: STYLIST_ID, roles: ['stylist'], primaryRole: 'stylist' });
    const stylistContext = actingContext({
      actorUserId: STYLIST_ID,
      roleContext: 'stylist',
      roles: ['stylist'],
    });
    expect(await service.listVisible(stylist, stylistContext)).toHaveLength(0);
  });

  it('never returns a resolved, expired or suppressed signal as live', async () => {
    const { service } = makeService({
      [TABLE]: [
        storedRow({ id: 'a', status: 'resolved' }),
        storedRow({ id: 'b', status: 'expired', signal_key: 'k-b' }),
        storedRow({ id: 'c', status: 'suppressed', signal_key: 'k-c' }),
      ],
    });
    expect(await service.listVisible(authUser(), actingContext())).toHaveLength(0);
  });
});

// ===========================================================================
// Fixture I at the storage boundary
// ===========================================================================

describe('I: business isolation is enforced by the store, not by the filter', () => {
  it('never reads another business row even when it is the identical issue', async () => {
    const store = (harness: Harness) => harness;
    const { service, state } = store(
      makeService({
        [TABLE]: [
          {
            id: 'sig-a',
            business_id: BUSINESS_A,
            location_id: null,
            subject_user_id: null,
            signal_key: `${BUSINESS_A}|rebooking_shortfall|rebooking_rate|business|-|-|shortfall`,
            evaluator_key: 'rebooking_shortfall',
            metric_key: 'rebooking_rate',
            issue_key: 'rebooking',
            scope_type: 'business',
            scope_label: null,
            visibility_scope: 'business_owner',
            signal_type: 'opportunity',
            severity: 'attention',
            materiality: 0.32,
            confidence: 0.85,
            direction: 'unknown',
            observation_status: 'valid',
            observed_value: 34,
            comparison_value: null,
            target_value: 50,
            target_source: 'canonical_threshold',
            sample_size: 120,
            period_label: null,
            metric_refs: [],
            evidence_refs: [],
            limitations: [],
            headline_redacted: 'A',
            status: 'active',
            resolution_reason: null,
            occurrence_count: 1,
            first_evaluated_at: NOW,
            last_evaluated_at: NOW,
            last_confirmed_at: NOW,
            resolved_at: null,
            suppressed_until: null,
            expires_at: null,
          },
          {
            id: 'sig-b',
            business_id: BUSINESS_B,
            location_id: null,
            subject_user_id: null,
            signal_key: `${BUSINESS_B}|rebooking_shortfall|rebooking_rate|business|-|-|shortfall`,
            evaluator_key: 'rebooking_shortfall',
            metric_key: 'rebooking_rate',
            issue_key: 'rebooking',
            scope_type: 'business',
            scope_label: null,
            visibility_scope: 'business_owner',
            signal_type: 'opportunity',
            severity: 'attention',
            materiality: 0.32,
            confidence: 0.85,
            direction: 'unknown',
            observation_status: 'valid',
            observed_value: 34,
            comparison_value: null,
            target_value: 50,
            target_source: 'canonical_threshold',
            sample_size: 120,
            period_label: null,
            metric_refs: [],
            evidence_refs: [],
            limitations: [],
            headline_redacted: 'B',
            status: 'active',
            resolution_reason: null,
            occurrence_count: 1,
            first_evaluated_at: NOW,
            last_evaluated_at: NOW,
            last_confirmed_at: NOW,
            resolved_at: null,
            suppressed_until: null,
            expires_at: null,
          },
        ],
      }),
    );

    const visible = await service.listVisible(authUser(), actingContext());
    expect(visible).toHaveLength(1);
    expect(visible[0].businessId).toBe(BUSINESS_A);
    expect(visible[0].headline).toBe('A');
    // And the other tenant's row was never even read into memory.
    expect(state.tables.get(TABLE)).toHaveLength(2);
  });

  it("opens its own signal rather than refreshing another tenant's", async () => {
    const { service, rows } = makeService(
      {
        [TABLE]: [
          {
            id: 'sig-b',
            business_id: BUSINESS_B,
            location_id: null,
            subject_user_id: null,
            signal_key: `${BUSINESS_B}|rebooking_shortfall|rebooking_rate|business|-|-|shortfall`,
            evaluator_key: 'rebooking_shortfall',
            metric_key: 'rebooking_rate',
            issue_key: 'rebooking',
            scope_type: 'business',
            scope_label: null,
            visibility_scope: 'business_owner',
            signal_type: 'opportunity',
            severity: 'attention',
            materiality: 0.32,
            confidence: 0.85,
            direction: 'unknown',
            observation_status: 'valid',
            observed_value: 34,
            comparison_value: null,
            target_value: 50,
            target_source: 'canonical_threshold',
            sample_size: 120,
            period_label: null,
            metric_refs: [],
            evidence_refs: [],
            limitations: [],
            headline_redacted: 'B',
            status: 'active',
            resolution_reason: null,
            occurrence_count: 1,
            first_evaluated_at: NOW,
            last_evaluated_at: NOW,
            last_confirmed_at: NOW,
            resolved_at: null,
            suppressed_until: null,
            expires_at: null,
          },
        ],
      },
      { 'report.rebooking_summary': rebookingResult(34, 120), 'report.utilisation_summary': denied },
    );

    const result = await service.evaluate(
      authUser(),
      actingContext({
        accessibleLocationIds: [LOCATION_1],
        accessibleLocations: [{ id: LOCATION_1, name: 'Pinner' }],
      }),
      run,
    );

    expect(result.reconciliation.refreshed).toBe(0);
    expect(result.reconciliation.opened).toBe(1);
    const businesses = rows().map((row) => row['business_id']);
    expect(businesses).toEqual([BUSINESS_B, BUSINESS_A]);
  });
});

// ===========================================================================
// Persisted lifecycle end to end
// ===========================================================================

describe('the lifecycle survives a round trip through the store', () => {
  it('refreshes the same row on a second evaluation instead of inserting another', async () => {
    const { service, rows } = makeService(
      { [TABLE]: [] },
      { 'report.rebooking_summary': rebookingResult(34, 120), 'report.utilisation_summary': denied },
    );
    const context = actingContext({
      accessibleLocationIds: [LOCATION_1],
      accessibleLocations: [{ id: LOCATION_1, name: 'Pinner' }],
    });

    await service.evaluate(authUser(), context, run);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]['occurrence_count']).toBe(1);

    const second = await service.evaluate(authUser(), context, {
      ...run,
      evaluatedAt: '2026-09-11T09:00:00.000Z',
    });
    expect(second.reconciliation.refreshed).toBe(1);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]['occurrence_count']).toBe(2);
    expect(rows()[0]['last_confirmed_at']).toBe('2026-09-11T09:00:00.000Z');
  });

  it('resolves the row on a valid recovery and leaves it out of the live set', async () => {
    const { service, rows } = makeService(
      { [TABLE]: [] },
      { 'report.rebooking_summary': rebookingResult(34, 120), 'report.utilisation_summary': denied },
    );
    const context = actingContext({
      accessibleLocationIds: [LOCATION_1],
      accessibleLocations: [{ id: LOCATION_1, name: 'Pinner' }],
    });
    await service.evaluate(authUser(), context, run);

    const recovered = makeService;
    void recovered;
    // Re-point the dispatch at a recovered reading by rebuilding the harness on
    // the same table rows.
    const state = createSupabaseFakeState({ [TABLE]: rows() });
    (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
    const config = { get: jest.fn(), getOrThrow: jest.fn((key: string) => `fake-${key}`) } as unknown as ConfigService;
    const tools = {
      dispatch: jest.fn(async (_a, _c, toolName: ZacToolName) => ({
        result: toolName === 'report.rebooking_summary' ? rebookingResult(58, 130) : denied,
        trace: { tool: toolName, status: 'ok' as const, latency_ms: 1, row_count: 1 },
      })),
    } as unknown as ZacToolRegistryService;
    const service2 = new ZacIntelligenceSignalService(
      tools,
      new ZacMetricObservationService(),
      new ZacSignalEvaluatorRegistry(),
      new ZacSignalReconciler(),
      new ZacIntelligenceSignalStore(config),
      new ZacPriorityService(),
      new ZacSignalPriorityAdapter(),
      new ZacCostTelemetryService(),
    );

    const result = await service2.evaluate(authUser(), context, {
      ...run,
      evaluatedAt: '2026-09-11T09:00:00.000Z',
    });
    expect(result.reconciliation.resolved).toBe(1);

    const stored = state.tables.get(TABLE) ?? [];
    const shortfall = stored.find((row) => String(row['signal_key']).endsWith('shortfall'));
    expect(shortfall?.['status']).toBe('resolved');
    expect(shortfall?.['resolution_reason']).toBe('recovered');
    expect(await service2.listVisible(authUser(), context)).toHaveLength(1);
  });

  it('leaves the row active when the next evaluation cannot read the metric', async () => {
    const { service, rows } = makeService(
      { [TABLE]: [] },
      { 'report.rebooking_summary': rebookingResult(34, 120), 'report.utilisation_summary': denied },
    );
    const context = actingContext({
      accessibleLocationIds: [LOCATION_1],
      accessibleLocations: [{ id: LOCATION_1, name: 'Pinner' }],
    });
    await service.evaluate(authUser(), context, run);

    const state = createSupabaseFakeState({ [TABLE]: rows() });
    (globalThis as { __supabaseFake?: unknown }).__supabaseFake = createSupabaseFake(state);
    const config = { get: jest.fn(), getOrThrow: jest.fn((key: string) => `fake-${key}`) } as unknown as ConfigService;
    const tools = {
      dispatch: jest.fn(async (_a, _c, toolName: ZacToolName) => ({
        result: { status: 'error' as const, data: null, explanation: 'temporarily unavailable', rowCount: null },
        trace: { tool: toolName, status: 'error' as const, latency_ms: 1, row_count: null },
      })),
    } as unknown as ZacToolRegistryService;
    const service2 = new ZacIntelligenceSignalService(
      tools,
      new ZacMetricObservationService(),
      new ZacSignalEvaluatorRegistry(),
      new ZacSignalReconciler(),
      new ZacIntelligenceSignalStore(config),
      new ZacPriorityService(),
      new ZacSignalPriorityAdapter(),
      new ZacCostTelemetryService(),
    );

    const result = await service2.evaluate(authUser(), context, {
      ...run,
      evaluatedAt: '2026-09-11T09:00:00.000Z',
    });
    expect(result.reconciliation.resolved).toBe(0);
    expect(result.reconciliation.retained).toBe(1);
    expect((state.tables.get(TABLE) ?? [])[0]['status']).toBe('active');
  });
});

// ===========================================================================
// Scope attribution — a partial-scope actor must never speak for the business
// ===========================================================================

describe('only an owner reading may be filed as the business', () => {
  const managerAtOne = () =>
    authUser({
      id: MANAGER_ID,
      roles: ['manager'],
      primaryRole: 'manager',
      allowedLocationIds: [LOCATION_1],
    });
  const managerContext = () =>
    actingContext({
      actorUserId: MANAGER_ID,
      roleContext: 'manager',
      roles: ['manager'],
      accessibleLocationIds: [LOCATION_1],
      accessibleLocations: [{ id: LOCATION_1, name: 'Pinner' }],
    });

  it('files a location-restricted manager reading as a LOCATION signal', async () => {
    // AuthService.resolveAllowedLocationIds gives owners every active location
    // and everyone else the union of their own memberships. A manager at one
    // site asking about "the business" is reading one site — filing that under
    // the business key would overwrite the owner's business-wide signal with one
    // branch's number, and later resolve it on that branch's recovery.
    const { service, rows } = makeService(
      { [TABLE]: [] },
      { 'report.rebooking_summary': rebookingResult(34, 120), 'report.utilisation_summary': denied },
    );
    await service.evaluate(managerAtOne(), managerContext(), run);

    expect(rows()).toHaveLength(1);
    expect(rows()[0]['scope_type']).toBe('location');
    expect(rows()[0]['location_id']).toBe(LOCATION_1);
    expect(rows()[0]['visibility_scope']).toBe('manager_team_theme');
    expect(String(rows()[0]['signal_key'])).toContain(`|location|${LOCATION_1}|`);
  });

  it("never collides a manager's signal with the owner's business signal", async () => {
    const { service, rows } = makeService(
      { [TABLE]: [] },
      { 'report.rebooking_summary': rebookingResult(34, 120), 'report.utilisation_summary': denied },
    );
    // The owner's business-wide run first…
    await service.evaluate(
      authUser({ allowedLocationIds: [LOCATION_1] }),
      actingContext({
        accessibleLocationIds: [LOCATION_1],
        accessibleLocations: [{ id: LOCATION_1, name: 'Pinner' }],
      }),
      run,
    );
    // …then the manager's. Two rows, two keys, neither overwriting the other.
    await service.evaluate(managerAtOne(), managerContext(), run);

    expect(rows()).toHaveLength(2);
    const scopes = rows().map((row) => row['scope_type']).sort();
    expect(scopes).toEqual(['business', 'location']);
  });

  it('gives a single-location owner ONE key whether or not the turn is location-filtered', async () => {
    const { service, rows } = makeService(
      { [TABLE]: [] },
      { 'report.rebooking_summary': rebookingResult(34, 120), 'report.utilisation_summary': denied },
    );
    const base = {
      accessibleLocationIds: [LOCATION_1],
      accessibleLocations: [{ id: LOCATION_1, name: 'Pinner' }],
    };
    await service.evaluate(authUser({ allowedLocationIds: [LOCATION_1] }), actingContext(base), run);
    const first = String(rows()[0]['signal_key']);

    await service.evaluate(
      authUser({ allowedLocationIds: [LOCATION_1] }),
      actingContext({ ...base, locationId: LOCATION_1 }),
      { ...run, evaluatedAt: '2026-09-11T09:00:00.000Z' },
    );

    // The same fact under two keys would put one problem on the list twice.
    expect(rows()).toHaveLength(1);
    expect(String(rows()[0]['signal_key'])).toBe(first);
    expect(rows()[0]['occurrence_count']).toBe(2);
  });

  it('splits a multi-location owner into the business view plus each site', async () => {
    const { service, rows } = makeService(
      { [TABLE]: [] },
      { 'report.rebooking_summary': rebookingResult(34, 120), 'report.utilisation_summary': denied },
    );
    await service.evaluate(authUser(), actingContext(), run);
    const scopes = rows().map((row) => row['scope_type']);
    expect(scopes.filter((scope) => scope === 'business')).toHaveLength(1);
    expect(scopes.filter((scope) => scope === 'location')).toHaveLength(2);
  });
});

// ===========================================================================
// Retrieval robustness
// ===========================================================================

describe('a row referencing an unregistered metric is hidden, not fatal', () => {
  it('drops it from retrieval instead of taking the whole read down', async () => {
    // A metric could be deregistered while its signals are still live. Throwing
    // would 500 every retrieval AND make the offending row impossible to
    // suppress away; deny-by-default hides just that row.
    const { service } = makeService({
      [TABLE]: [
        {
          id: 'sig-ghost',
          business_id: BUSINESS_A,
          location_id: null,
          subject_user_id: null,
          signal_key: 'ghost',
          evaluator_key: 'ghost',
          metric_key: 'colour_waste_rate',
          issue_key: 'other',
          scope_type: 'business',
          scope_label: null,
          visibility_scope: 'business_owner',
          signal_type: 'risk',
          severity: 'attention',
          materiality: 0.5,
          confidence: 0.8,
          direction: 'unknown',
          observation_status: 'valid',
          observed_value: 1,
          comparison_value: null,
          target_value: 2,
          target_source: null,
          sample_size: null,
          period_label: null,
          metric_refs: [],
          evidence_refs: [],
          limitations: [],
          headline_redacted: 'ghost metric',
          status: 'active',
          resolution_reason: null,
          occurrence_count: 1,
          first_evaluated_at: NOW,
          last_evaluated_at: NOW,
          last_confirmed_at: NOW,
          resolved_at: null,
          suppressed_until: null,
          expires_at: null,
        },
      ],
    });

    await expect(service.listVisible(authUser(), actingContext())).resolves.toHaveLength(0);
    await expect(service.priorityCandidates(authUser(), actingContext())).resolves.toMatchObject({
      candidates: [],
    });
  });
});

describe('returning to active clears the suppression window', () => {
  it('does not leave an active signal reading as one somebody silenced', async () => {
    const { service, rows } = makeService(
      { [TABLE]: [] },
      { 'report.rebooking_summary': rebookingResult(34, 120), 'report.utilisation_summary': denied },
    );
    const context = actingContext({
      accessibleLocationIds: [LOCATION_1],
      accessibleLocations: [{ id: LOCATION_1, name: 'Pinner' }],
    });
    await service.evaluate(authUser({ allowedLocationIds: [LOCATION_1] }), context, run);

    const id = String(rows()[0]['id']);
    await service.suppress(authUser(), context, id, '2026-09-05T00:00:00.000Z', NOW);
    expect(rows()[0]['status']).toBe('suppressed');

    // A run after the window has closed.
    await service.evaluate(authUser({ allowedLocationIds: [LOCATION_1] }), context, {
      ...run,
      evaluatedAt: '2026-09-11T09:00:00.000Z',
    });
    expect(rows()[0]['status']).toBe('active');
    expect(rows()[0]['suppressed_until']).toBeNull();
  });
});
