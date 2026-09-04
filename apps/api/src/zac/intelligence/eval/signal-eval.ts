import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AuthUser, Permission } from '@sheer/domain';
import { ZacPriorityService } from '../../analysis/zac-priority.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import { ZacCostTelemetryService } from '../../measurement/zac-cost-telemetry.service';
import { confidenceScoreBucket } from '../../routing/zac-request-mode.types';
import type { ZacToolName, ZacToolResult } from '../../tools/zac-tool.types';
import type { ZacToolRegistryService } from '../../tools/zac-tool-registry.service';
import { ZacIntelligenceSignalService } from '../zac-intelligence-signal.service';
import { ZacMetricObservationService } from '../zac-metric-observation.service';
import { metricDefinition } from '../zac-metric-registry';
import { isPositiveEvidence, type ZacMetricKey, type ZacSignalScopeType } from '../zac-metric.types';
import { ZacSignalEvaluatorRegistry } from '../zac-signal-evaluator.registry';
import { ZacSignalPriorityAdapter } from '../zac-signal-priority.adapter';
import { ZacSignalReconciler, type ZacSignalAction } from '../zac-signal-reconciler';
import type { ZacPersistedSignal, ZacSignalCandidate } from '../zac-signal.types';
import { InMemorySignalRepository } from './in-memory-signal-repository';
import {
  SIGNAL_EVAL_ACTORS,
  type SignalEvalActor,
  type SignalEvalCase,
  type SignalEvalCaseResult,
  type SignalEvalCheck,
  type SignalEvalDataset,
  type SignalEvalEvaluateStep,
  type SignalEvalInvariant,
  type SignalEvalMaterialityBand,
  type SignalEvalMetrics,
  type SignalEvalSignalExpectation,
  type SignalEvalStoreExpectation,
  type SignalEvalSuppressStep,
  type SignalEvalVisibilityExpectation,
} from './signal-eval.types';

/**
 * THE PHASE 2 SIGNAL EVALUATION HARNESS.
 *
 * Runs labelled cases through the REAL Workstream 1 pipeline — the real
 * observation service, evaluator registry, reconciler and
 * `ZacIntelligenceSignalService` (scope fan-out, visibility matrix, permission
 * re-check, plan application) — over an in-memory repository that enforces the
 * same live-uniqueness rule as the database. Only two things are faked, and
 * both are inputs: the tool dispatch (canned Phase 1 tool results, exactly as
 * the tools emit them) and the clock (`evaluatedAt` is a label).
 *
 * It calls no model. Signal intelligence is deterministic business logic; a
 * provider is not involved in materiality, severity, confidence, dedupe,
 * lifecycle or permission, and this harness would be wrong to consult one.
 *
 * Three design rules:
 *  - Every metric is computed from individual CHECKS, and every failed check is
 *    reported with its expected and actual value. An aggregate percentage
 *    never hides a failure.
 *  - The invariant counters (false resolution on missing data, duplicate live
 *    attempts, cross-tenant reconciliation) are derived from what the pipeline
 *    ACTUALLY DID, not from labels — a case cannot pass one by being labelled
 *    kindly.
 *  - Adding a metric later means adding cases, not changing the harness: the
 *    label vocabulary is the framework's own closed types.
 */

export const SIGNAL_EVAL_DATASET_VERSION = 'zac-signal-eval-v1';
/** Bumped when a change to the framework alters what existing labels mean. */
export const SIGNAL_FRAMEWORK_VERSION = 'ws1-2026-09-04';

export function loadSignalEvalDataset(): SignalEvalDataset {
  const path = join(__dirname, 'zac-signal-eval-dataset.v1.json');
  const dataset = JSON.parse(readFileSync(path, 'utf8')) as SignalEvalDataset;
  validateDataset(dataset);
  return dataset;
}

/** Authoring mistakes are harness failures, never silently-passing cases. */
function validateDataset(dataset: SignalEvalDataset): void {
  if (dataset.version !== SIGNAL_EVAL_DATASET_VERSION) {
    throw new Error(`dataset version ${dataset.version} does not match harness ${SIGNAL_EVAL_DATASET_VERSION}`);
  }
  const ids = new Set<string>();
  for (const evalCase of dataset.cases) {
    if (ids.has(evalCase.id)) throw new Error(`duplicate case id ${evalCase.id}`);
    ids.add(evalCase.id);
    const stepIds = new Set<string>();
    for (const step of evalCase.steps) {
      if (stepIds.has(step.id)) throw new Error(`${evalCase.id}: duplicate step id ${step.id}`);
      stepIds.add(step.id);
      if (!SIGNAL_EVAL_ACTORS.includes(step.actor)) {
        throw new Error(`${evalCase.id}/${step.id}: unknown actor ${step.actor}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Fixed identities. Constant, so every case in every run sees the same world.
// ---------------------------------------------------------------------------

export const BUSINESS_A = 'b0000000-0000-0000-0000-00000000000a';
export const BUSINESS_B = 'b0000000-0000-0000-0000-00000000000b';
export const LOCATION_1 = 'l0000000-0000-0000-0000-000000000001';
export const LOCATION_2 = 'l0000000-0000-0000-0000-000000000002';
export const LOCATION_3 = 'l0000000-0000-0000-0000-000000000003';

const OWNER_PERMISSIONS: Permission[] = ['zac.access', 'report.dashboard.view', 'report.performance.view'];

interface ActorProfile {
  actor: AuthUser;
  context: ZacActingContext;
}

/** Actor presets. Roles and permissions are the ONLY thing that differs between them. */
export function actorProfile(preset: SignalEvalActor, locationFocus: string | null = null): ActorProfile {
  const base = (input: {
    id: string;
    businessId: string;
    businessName: string;
    roles: AuthUser['roles'];
    permissions: Permission[];
    locations: Array<{ id: string; name: string }>;
  }): ActorProfile => ({
    actor: {
      id: input.id,
      roles: input.roles,
      primaryRole: input.roles[0],
      businessId: input.businessId,
      allowedLocationIds: input.locations.map((l) => l.id),
      locationScope: { kind: input.roles.includes('owner') ? 'all' : 'locations', locationIds: input.locations.map((l) => l.id) },
      locations: [],
      profile: { id: input.id, fullName: 'Eval Actor', email: 'eval@example.com' },
      permissions: input.permissions,
    } as unknown as AuthUser,
    context: {
      actorUserId: input.id,
      actorFirstName: 'Eval',
      businessId: input.businessId,
      businessName: input.businessName,
      locationId: locationFocus,
      accessibleLocationIds: input.locations.map((l) => l.id),
      accessibleLocations: input.locations,
      roleContext: input.roles[0] as ZacActingContext['roleContext'],
      roles: input.roles,
      permissions: input.permissions,
      staffProfileId: input.roles[0] === 'stylist' ? 's0000000-0000-0000-0000-000000000003' : null,
      requestSource: 'web_dashboard',
      timezone: 'Europe/London',
      locale: 'en-GB',
      firstAssistantTurn: true,
    },
  });

  const two = [
    { id: LOCATION_1, name: 'Pinner' },
    { id: LOCATION_2, name: 'Primrose Hill' },
  ];
  const one = [{ id: LOCATION_1, name: 'Pinner' }];
  const A = { businessId: BUSINESS_A, businessName: 'Signal Salon' };

  switch (preset) {
    case 'owner':
      return base({ ...A, id: 'u0000000-0000-0000-0000-000000000001', roles: ['owner'], permissions: OWNER_PERMISSIONS, locations: two });
    case 'owner_single':
      return base({ ...A, id: 'u0000000-0000-0000-0000-000000000001', roles: ['owner'], permissions: OWNER_PERMISSIONS, locations: one });
    case 'manager_l1':
      return base({ ...A, id: 'u0000000-0000-0000-0000-000000000002', roles: ['manager'], permissions: OWNER_PERMISSIONS, locations: one });
    case 'manager_l2':
      return base({ ...A, id: 'u0000000-0000-0000-0000-000000000004', roles: ['manager'], permissions: OWNER_PERMISSIONS, locations: [{ id: LOCATION_2, name: 'Primrose Hill' }] });
    case 'stylist':
      return base({ ...A, id: 'u0000000-0000-0000-0000-000000000003', roles: ['stylist'], permissions: ['zac.access'], locations: one });
    case 'owner_no_dashboard':
      return base({ ...A, id: 'u0000000-0000-0000-0000-000000000001', roles: ['owner'], permissions: ['zac.access', 'report.performance.view'], locations: two });
    case 'owner_no_performance':
      return base({ ...A, id: 'u0000000-0000-0000-0000-000000000001', roles: ['owner'], permissions: ['zac.access', 'report.dashboard.view'], locations: two });
    case 'owner_no_zac':
      return base({ ...A, id: 'u0000000-0000-0000-0000-000000000001', roles: ['owner'], permissions: ['report.dashboard.view', 'report.performance.view'], locations: two });
    case 'owner_b':
      return base({ businessId: BUSINESS_B, businessName: 'Rival Salon', id: 'u0000000-0000-0000-0000-00000000000b', roles: ['owner'], permissions: OWNER_PERMISSIONS, locations: [{ id: LOCATION_3, name: 'Watford' }] });
    default:
      throw new Error(`unknown actor preset ${String(preset)}`);
  }
}

// ---------------------------------------------------------------------------
// The pipeline under test
// ---------------------------------------------------------------------------

const DENIED: ZacToolResult = {
  status: 'permission_denied',
  data: null,
  explanation: 'That data is not available to your role.',
  rowCount: null,
};

/** Canned tool dispatch. `tool@locationId` wins over `tool`; nothing else is consulted. */
function fakeRegistry(fixtures: Record<string, ZacToolResult>): ZacToolRegistryService {
  return {
    dispatch: async (_actor: AuthUser, context: ZacActingContext, toolName: ZacToolName) => {
      const scoped = context.locationId ? fixtures[`${toolName}@${context.locationId}`] : undefined;
      const result = scoped ?? fixtures[toolName] ?? DENIED;
      return { result, trace: { tool: toolName, status: result.status, latency_ms: 0, row_count: result.rowCount } };
    },
  } as unknown as ZacToolRegistryService;
}

class Harness {
  readonly repository = new InMemorySignalRepository();
  private readonly observations = new ZacMetricObservationService();
  private readonly evaluators = new ZacSignalEvaluatorRegistry();
  private readonly reconciler = new ZacSignalReconciler();
  private readonly priorities = new ZacPriorityService();
  private readonly adapter = new ZacSignalPriorityAdapter();
  private readonly telemetry = new ZacCostTelemetryService();

  service(fixtures: Record<string, ZacToolResult>): ZacIntelligenceSignalService {
    return new ZacIntelligenceSignalService(
      fakeRegistry(fixtures),
      this.observations,
      this.evaluators,
      this.reconciler,
      this.repository,
      this.priorities,
      this.adapter,
      this.telemetry,
    );
  }
}

// ---------------------------------------------------------------------------
// Running one case
// ---------------------------------------------------------------------------

function materialityBand(candidate: ZacSignalCandidate): SignalEvalMaterialityBand {
  if (candidate.materiality <= 0) return 'zero';
  const bands = metricDefinition(candidate.metricKey).materialityBands;
  return candidate.materiality >= bands.attention ? 'attention' : 'watch';
}

function scopeMatches(
  expected: { scopeType?: ZacSignalScopeType; locationId?: string | null },
  scope: { type: ZacSignalScopeType; locationId: string | null },
): boolean {
  const type = expected.scopeType ?? 'business';
  if (scope.type !== type) return false;
  if (expected.locationId !== undefined) return scope.locationId === expected.locationId;
  return type === 'business' ? scope.locationId === null : true;
}

export async function runSignalEvalCase(evalCase: SignalEvalCase): Promise<SignalEvalCaseResult> {
  const harness = new Harness();
  const checks: SignalEvalCheck[] = [];
  /** signalKey live for (metric, scope) after each step — for dedupe assertions. */
  const liveKeysByStep = new Map<string, Map<string, string>>();
  let falseResolutions = 0;
  let crossTenant = 0;
  const invariants = evalCase.invariants ?? [];
  const gate = (category: SignalEvalCheck['category']): SignalEvalInvariant | undefined =>
    invariantFor(category, invariants);

  const check = (
    stepId: string,
    category: SignalEvalCheck['category'],
    label: string,
    expected: unknown,
    actual: unknown,
    invariant = gate(category),
  ): boolean => {
    const passed = JSON.stringify(expected) === JSON.stringify(actual);
    checks.push({
      caseId: evalCase.id,
      stepId,
      category,
      label,
      expected: JSON.stringify(expected),
      actual: JSON.stringify(actual),
      passed,
      ...(invariant ? { invariant } : {}),
    });
    return passed;
  };

  try {
    for (const step of evalCase.steps) {
      if (step.kind === 'suppress') {
        await runSuppressStep(harness, step, check);
        await assertStore(harness, step.id, actorProfile(step.actor).context.businessId, step.expected.store, liveKeysByStep, check);
        await assertVisibility(harness, step.id, step.expected.visibleTo, check);
        continue;
      }

      const profile = actorProfile(step.actor, step.locationFocus ?? null);
      const service = harness.service(step.tools);
      const run = await service.evaluate(profile.actor, profile.context, {
        traceId: `eval-${evalCase.id}-${step.id}`,
        evaluatedAt: step.evaluatedAt,
        memory: step.memory ?? [],
      });

      // ---- Derived invariant counters, from what the pipeline actually did.
      for (const action of run.reconciliation.actions) {
        if (action.kind === 'resolve') {
          // A resolve is only legitimate on positive evidence for that metric
          // and scope. Anything else is the failure this framework exists to
          // prevent, whatever the case's labels say.
          const observation = run.observations.find(
            (o) =>
              o.metricKey === action.existing?.metricKey &&
              o.scope.type === action.existing?.scopeType &&
              o.scope.locationId === (action.existing?.locationId ?? null),
          );
          if (!observation || !isPositiveEvidence(observation.status)) falseResolutions += 1;
        }
        if ((action.kind === 'refresh' || action.kind === 'resolve' || action.kind === 'expire') && action.existing) {
          if (action.existing.businessId !== profile.context.businessId) crossTenant += 1;
        }
      }
      if (run.persistenceErrors.length > 0) {
        check(step.id, 'store', 'persistence errors', [], run.persistenceErrors, 'repeat_run_no_duplicate');
      }

      // ---- Signal expectations.
      for (const expectation of step.expected.signals ?? []) {
        assertSignal(step, expectation, run, check);
      }

      // ---- Store, dedupe and visibility.
      const live = await harness.repository.listLive(profile.context.businessId);
      const keys = new Map<string, string>();
      for (const row of live) keys.set(`${row.metricKey}|${row.scopeType}|${row.locationId ?? '-'}`, row.signalKey);
      liveKeysByStep.set(step.id, keys);
      await assertStore(harness, step.id, profile.context.businessId, step.expected.store, liveKeysByStep, check);
      await assertVisibility(harness, step.id, step.expected.visibleTo, check);
    }
  } catch (error) {
    return {
      caseId: evalCase.id,
      domain: evalCase.domain,
      passed: false,
      checks,
      falseResolutionsOnMissingData: falseResolutions,
      duplicateLiveAttempts: harness.repository.duplicateLiveAttempts,
      crossTenantReconciliations: crossTenant,
      error: (error as Error).message,
    };
  }

  return {
    caseId: evalCase.id,
    domain: evalCase.domain,
    passed: checks.every((c) => c.passed) && falseResolutions === 0 && harness.repository.duplicateLiveAttempts === 0 && crossTenant === 0,
    checks,
    falseResolutionsOnMissingData: falseResolutions,
    duplicateLiveAttempts: harness.repository.duplicateLiveAttempts,
    crossTenantReconciliations: crossTenant,
  };
}

function invariantFor(category: SignalEvalCheck['category'], invariants: SignalEvalInvariant[]): SignalEvalInvariant | undefined {
  const map: Partial<Record<SignalEvalCheck['category'], SignalEvalInvariant[]>> = {
    signal_presence: ['zero_denominator_no_false_negative'],
    lifecycle_action: ['missing_data_never_resolves', 'failed_read_never_resolves'],
    resolution_reason: ['missing_data_never_resolves', 'failed_read_never_resolves'],
    store: ['repeat_run_no_duplicate', 'tenants_never_reconcile'],
    dedupe: ['repeat_run_no_duplicate', 'tenants_never_reconcile'],
    visibility: ['removed_permission_hides', 'restricted_scope_never_widens', 'tenants_never_reconcile'],
  };
  return (map[category] ?? []).find((candidate) => invariants.includes(candidate));
}

type Check = (stepId: string, category: SignalEvalCheck['category'], label: string, expected: unknown, actual: unknown, invariant?: SignalEvalInvariant) => boolean;

function assertSignal(
  step: SignalEvalEvaluateStep,
  expectation: SignalEvalSignalExpectation,
  run: Awaited<ReturnType<ZacIntelligenceSignalService['evaluate']>>,
  check: Check,
): void {
  const where = `${expectation.metric}@${expectation.scopeType ?? 'business'}${expectation.locationId ? ':' + expectation.locationId : ''}`;
  const evaluation = run.evaluations.find(
    (e) => e.metricKey === expectation.metric && scopeMatches(expectation, e.scope),
  );
  if (!evaluation) {
    check(step.id, 'signal_presence', `${where} evaluated`, true, false);
    return;
  }
  const candidate = evaluation.candidates[0];
  const produced = candidate !== undefined;
  check(step.id, 'signal_presence', `${where} produced`, expectation.produced, produced);

  if (!expectation.produced) {
    if (expectation.withheldReason !== undefined) {
      check(step.id, 'withheld_reason', `${where} withheld reason`, expectation.withheldReason, evaluation.withheld[0]?.reason ?? null);
    }
    // No candidate this step, but an EXISTING signal may have been retained,
    // resolved or expired — the transitions the core invariant is about.
    if (expectation.lifecycleAction !== undefined || expectation.resolutionReason !== undefined) {
      const action = reconciliationActionFor(run, expectation);
      if (expectation.lifecycleAction !== undefined) {
        check(step.id, 'lifecycle_action', `${where} lifecycle action`, expectation.lifecycleAction, action?.kind ?? null);
      }
      if (expectation.resolutionReason !== undefined) {
        check(step.id, 'resolution_reason', `${where} resolution reason`, expectation.resolutionReason, action?.resolutionReason ?? null);
      }
    }
    return;
  }
  if (!candidate) return;

  if (expectation.kind !== undefined) check(step.id, 'kind', `${where} kind`, expectation.kind, candidate.signalType);
  if (expectation.direction !== undefined) check(step.id, 'direction', `${where} direction`, expectation.direction, candidate.direction);
  if (expectation.materialityBand !== undefined) check(step.id, 'materiality_band', `${where} materiality band`, expectation.materialityBand, materialityBand(candidate));
  if (expectation.severity !== undefined) check(step.id, 'severity', `${where} severity`, expectation.severity, candidate.severity);
  if (expectation.confidenceBand !== undefined) check(step.id, 'confidence_band', `${where} confidence band`, expectation.confidenceBand, confidenceScoreBucket(candidate.confidence));
  if (expectation.targetSource !== undefined) check(step.id, 'target_source', `${where} target source`, expectation.targetSource, candidate.targetSource);
  if (expectation.limitationsInclude) {
    for (const needle of expectation.limitationsInclude) {
      check(step.id, 'limitations', `${where} limitations include "${needle}"`, true, candidate.limitations.some((l) => l.includes(needle)));
    }
  }
  if (expectation.lifecycleAction !== undefined || expectation.resolutionReason !== undefined) {
    const action: ZacSignalAction | undefined = run.reconciliation.actions.find((a) => a.signalKey === candidate.signalKey);
    if (expectation.lifecycleAction !== undefined) {
      check(step.id, 'lifecycle_action', `${where} lifecycle action`, expectation.lifecycleAction, action?.kind ?? null);
    }
    if (expectation.resolutionReason !== undefined) {
      check(step.id, 'resolution_reason', `${where} resolution reason`, expectation.resolutionReason, action?.resolutionReason ?? null);
    }
  }
}

/**
 * Lifecycle expectations about signals that produced NO candidate this step —
 * a resolve, expire or retain — are asserted through the store, because the
 * candidate list cannot name them. `lifecycleAction` on a `produced: false`
 * expectation is resolved here against the reconciliation plan by (metric, scope).
 */
function reconciliationActionFor(
  run: Awaited<ReturnType<ZacIntelligenceSignalService['evaluate']>>,
  expectation: SignalEvalSignalExpectation,
): ZacSignalAction | undefined {
  return run.reconciliation.actions.find(
    (a) =>
      a.existing !== null &&
      a.existing.metricKey === expectation.metric &&
      scopeMatches(expectation, { type: a.existing.scopeType, locationId: a.existing.locationId }),
  );
}

async function runSuppressStep(harness: Harness, step: SignalEvalSuppressStep, check: Check): Promise<void> {
  const profile = actorProfile(step.actor);
  const service = harness.service({});
  const visible = await service.listVisible(profile.actor, profile.context);
  const target = visible.find(
    (s) => s.metricKey === step.metric && (step.locationId === undefined ? s.scopeType === 'business' : s.locationId === step.locationId),
  );
  const accepted = target
    ? await service.suppress(profile.actor, profile.context, target.id, step.until, step.at)
    : false;
  check(step.id, 'suppress', `suppress ${step.metric} accepted`, step.expected.accepted, accepted);
}

async function assertStore(
  harness: Harness,
  stepId: string,
  businessId: string,
  expected: SignalEvalStoreExpectation | undefined,
  liveKeysByStep: Map<string, Map<string, string>>,
  check: Check,
): Promise<void> {
  if (!expected) return;
  const all = await harness.repository.listAll(businessId);
  const by = (status: ZacPersistedSignal['status']) => all.filter((r) => r.status === status).length;
  if (expected.activeSignals !== undefined) check(stepId, 'store', 'active signals', expected.activeSignals, by('active'));
  if (expected.liveSignals !== undefined) check(stepId, 'store', 'live signals', expected.liveSignals, by('active') + by('suppressed'));
  if (expected.episodes !== undefined) check(stepId, 'store', 'episodes', expected.episodes, all.length);
  if (expected.statuses) {
    for (const [status, count] of Object.entries(expected.statuses)) {
      check(stepId, 'store', `rows with status ${status}`, count, by(status as ZacPersistedSignal['status']));
    }
  }
  // Also enforce, unconditionally: no two live rows share a key. The database
  // would refuse it; the harness must refuse it too.
  const liveKeys = all.filter((r) => r.status === 'active' || r.status === 'suppressed').map((r) => r.signalKey);
  check(stepId, 'dedupe', 'live signal keys unique', liveKeys.length, new Set(liveKeys).size, 'repeat_run_no_duplicate');

  const live = await harness.repository.listLive(businessId);
  const keyFor = (metric: ZacMetricKey, locationId: string | null | undefined) => {
    const row = live.find((r) => r.metricKey === metric && (locationId === undefined ? r.scopeType === 'business' : r.locationId === locationId));
    return row?.signalKey ?? null;
  };
  if (expected.sameSignalKeyAsStep) {
    const { step, metric, locationId } = expected.sameSignalKeyAsStep;
    const prior = liveKeysByStep.get(step)?.get(`${metric}|${locationId === undefined ? 'business' : 'location'}|${locationId ?? '-'}`) ?? null;
    check(stepId, 'dedupe', `same signal key as step ${step} for ${metric}`, prior, keyFor(metric, locationId));
  }
  if (expected.differentSignalKeyFromStep) {
    const { step, metric, locationId } = expected.differentSignalKeyFromStep;
    const prior = liveKeysByStep.get(step)?.get(`${metric}|${locationId === undefined ? 'business' : 'location'}|${locationId ?? '-'}`) ?? null;
    const now = keyFor(metric, locationId);
    check(stepId, 'dedupe', `different signal key from step ${step} for ${metric}`, true, prior !== null && now !== null && prior !== now);
  }
}

async function assertVisibility(
  harness: Harness,
  stepId: string,
  expected: SignalEvalVisibilityExpectation[] | undefined,
  check: Check,
): Promise<void> {
  for (const expectation of expected ?? []) {
    const profile = actorProfile(expectation.actor);
    const visible = await harness.service({}).listVisible(profile.actor, profile.context);
    check(stepId, 'visibility', `visible to ${expectation.actor}`, expectation.count, visible.length);
  }
}

// ---------------------------------------------------------------------------
// Scoring and reporting
// ---------------------------------------------------------------------------

const CATEGORIES: SignalEvalCheck['category'][] = [
  'signal_presence', 'kind', 'direction', 'materiality_band', 'severity', 'confidence_band',
  'target_source', 'withheld_reason', 'lifecycle_action', 'resolution_reason', 'limitations',
  'dedupe', 'store', 'visibility', 'suppress',
];

const INVARIANTS: SignalEvalInvariant[] = [
  'zero_denominator_no_false_negative',
  'missing_data_never_resolves',
  'failed_read_never_resolves',
  'repeat_run_no_duplicate',
  'tenants_never_reconcile',
  'removed_permission_hides',
  'restricted_scope_never_widens',
];

export function scoreSignalEval(dataset: SignalEvalDataset, results: SignalEvalCaseResult[]): SignalEvalMetrics {
  const accuracy = Object.fromEntries(CATEGORIES.map((c) => [c, { asserted: 0, correct: 0 }])) as SignalEvalMetrics['accuracy'];
  const invariantFailures = Object.fromEntries(INVARIANTS.map((i) => [i, 0])) as Record<SignalEvalInvariant, number>;
  let fpNeg = 0, fpDen = 0, fnSig = 0, fnDen = 0, isolation = 0, permission = 0;

  const isNegativeKind = (kind: string) => kind === 'opportunity' || kind === 'risk' || kind === 'watch_point';

  for (const result of results) {
    for (const c of result.checks) {
      accuracy[c.category].asserted += 1;
      if (c.passed) accuracy[c.category].correct += 1;
      if (!c.passed && c.invariant) invariantFailures[c.invariant] += 1;

      if (c.category === 'signal_presence' && c.label.endsWith('produced')) {
        const expectedProduced = c.expected === 'true';
        const actualProduced = c.actual === 'true';
        if (expectedProduced) { fnDen += 1; if (!actualProduced) fnSig += 1; }
        else { fpDen += 1; if (actualProduced) fpNeg += 1; }
      }
      if (c.category === 'kind' && c.expected === '"progress"' && c.actual !== '"progress"' && isNegativeKind(JSON.parse(c.actual))) {
        fpNeg += 1;
      }
      if (c.category === 'visibility' && !c.passed) {
        if (c.label.includes('owner_b')) isolation += 1; else permission += 1;
      }
    }
    if (result.falseResolutionsOnMissingData > 0) {
      invariantFailures.missing_data_never_resolves += result.falseResolutionsOnMissingData;
    }
    if (result.duplicateLiveAttempts > 0) invariantFailures.repeat_run_no_duplicate += result.duplicateLiveAttempts;
    if (result.crossTenantReconciliations > 0) {
      invariantFailures.tenants_never_reconcile += result.crossTenantReconciliations;
      isolation += result.crossTenantReconciliations;
    }
  }

  return {
    datasetVersion: dataset.version,
    frameworkVersion: dataset.frameworkVersion,
    cases: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    accuracy,
    falsePositiveNegativeSignals: { count: fpNeg, denominator: fpDen },
    falseNegativeSignals: { count: fnSig, denominator: fnDen },
    duplicateActiveSignals: results.reduce((n, r) => n + r.duplicateLiveAttempts, 0),
    falseResolutionsOnMissingData: results.reduce((n, r) => n + r.falseResolutionsOnMissingData, 0),
    tenantIsolationFailures: isolation,
    permissionFailures: permission,
    invariantFailures,
    failedCases: results
      .filter((r) => !r.passed)
      .map((r) => ({ caseId: r.caseId, failures: r.checks.filter((c) => !c.passed), ...(r.error ? { error: r.error } : {}) })),
  };
}

export async function runSignalEval(dataset: SignalEvalDataset = loadSignalEvalDataset()): Promise<{ results: SignalEvalCaseResult[]; metrics: SignalEvalMetrics }> {
  const results: SignalEvalCaseResult[] = [];
  for (const evalCase of dataset.cases) results.push(await runSignalEvalCase(evalCase));
  return { results, metrics: scoreSignalEval(dataset, results) };
}

const pct = (n: number, d: number): string => (d === 0 ? '   n/a' : `${((100 * n) / d).toFixed(1).padStart(5)}%`);

export function formatSignalEvalReport(metrics: SignalEvalMetrics, meta: { commit: string; timestamp: string }): string {
  const lines: string[] = [];
  const row = (label: string, value: string) => lines.push(`${label.padEnd(38)} ${value}`);
  const acc = (label: string, category: SignalEvalCheck['category']) => {
    const a = metrics.accuracy[category];
    row(label, `${pct(a.correct, a.asserted)}   (${a.correct}/${a.asserted})`);
  };

  lines.push('ZAC Phase 2 Signal Evaluation');
  row('Dataset', metrics.datasetVersion);
  row('Framework', metrics.frameworkVersion);
  row('Commit', meta.commit);
  row('Timestamp', meta.timestamp);
  lines.push('');
  row('Cases', String(metrics.cases));
  row('Passed', String(metrics.passed));
  row('Failed', String(metrics.failed));
  lines.push('');
  acc('Signal/no-signal accuracy', 'signal_presence');
  acc('Kind accuracy', 'kind');
  acc('Direction accuracy', 'direction');
  acc('Materiality-band accuracy', 'materiality_band');
  acc('Severity accuracy', 'severity');
  acc('Confidence-band accuracy', 'confidence_band');
  acc('Target-source accuracy', 'target_source');
  acc('Withheld-reason accuracy', 'withheld_reason');
  acc('Lifecycle transition accuracy', 'lifecycle_action');
  acc('Resolution accuracy', 'resolution_reason');
  acc('Dedupe accuracy', 'dedupe');
  acc('Store-state accuracy', 'store');
  acc('Visibility accuracy', 'visibility');
  lines.push('');
  row('False-positive negative signals', `${metrics.falsePositiveNegativeSignals.count} / ${metrics.falsePositiveNegativeSignals.denominator}`);
  row('False-negative signals', `${metrics.falseNegativeSignals.count} / ${metrics.falseNegativeSignals.denominator}`);
  row('Duplicate active signals', String(metrics.duplicateActiveSignals));
  row('False resolution on missing/failed', String(metrics.falseResolutionsOnMissingData));
  row('Tenant isolation failures', String(metrics.tenantIsolationFailures));
  row('Permission failures', String(metrics.permissionFailures));
  lines.push('');
  lines.push('Hard invariants (zero tolerance):');
  for (const invariant of INVARIANTS) {
    const n = metrics.invariantFailures[invariant];
    row(`  ${invariant}`, n === 0 ? 'PASS' : `FAIL (${n})`);
  }
  if (metrics.failedCases.length > 0) {
    lines.push('');
    lines.push('Failed cases:');
    for (const failed of metrics.failedCases) {
      lines.push(`  ${failed.caseId}${failed.error ? ` — ERROR: ${failed.error}` : ''}`);
      for (const c of failed.failures) {
        lines.push(`    [${c.stepId}] ${c.label}: expected ${c.expected}, actual ${c.actual}`);
      }
    }
  }
  return lines.join('\n');
}

/** True when every hard invariant holds AND every case passed. */
export function signalEvalGatesPass(metrics: SignalEvalMetrics): boolean {
  return metrics.failed === 0 && INVARIANTS.every((i) => metrics.invariantFailures[i] === 0);
}
