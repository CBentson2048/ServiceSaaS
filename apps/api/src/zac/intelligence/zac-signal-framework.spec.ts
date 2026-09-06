import { ZacPriorityService } from '../analysis/zac-priority.service';
import type { ZacToolResult } from '../tools/zac-tool.types';
import { RebookingShortfallEvaluator } from './evaluators/rebooking-shortfall.evaluator';
import { UtilisationShortfallEvaluator } from './evaluators/utilisation-shortfall.evaluator';
import { ZacIntelligenceSignalService } from './zac-intelligence-signal.service';
import { ZacMetricObservationService } from './zac-metric-observation.service';
import { allMetricDefinitions, metricDefinition } from './zac-metric-registry';
import type { ZacMetricKey, ZacSignalScope } from './zac-metric.types';
import { ZacSignalEvaluatorRegistry } from './zac-signal-evaluator.registry';
import { ZacSignalPriorityAdapter } from './zac-signal-priority.adapter';
import { computeConfidence } from './zac-signal-scoring';
import { ZacSignalReconciler } from './zac-signal-reconciler';
import {
  buildSignalKey,
  type ZacPersistedSignal,
  type ZacSignalCandidate,
  type ZacSignalEvaluation,
} from './zac-signal.types';

/**
 * The Phase 2 Workstream 1 acceptance fixtures, A–L.
 *
 * Every layer under the store is pure and clock-free, so each fixture is a
 * table of inputs and an assertion — including the two that are usually only
 * reachable in an integration test ("the dashboard went down", "the permission
 * was revoked"). That is the point of keeping evaluation and reconciliation out
 * of the persistence layer.
 */

const BUSINESS_A = 'b0000000-0000-0000-0000-00000000000a';
const BUSINESS_B = 'b0000000-0000-0000-0000-00000000000b';
const LOCATION_1 = 'l0000000-0000-0000-0000-000000000001';
const LOCATION_2 = 'l0000000-0000-0000-0000-000000000002';
const NOW = '2026-09-04T09:00:00.000Z';

const observations = new ZacMetricObservationService();
const evaluators = new ZacSignalEvaluatorRegistry();
const reconciler = new ZacSignalReconciler();
const adapter = new ZacSignalPriorityAdapter();
const priorities = new ZacPriorityService();

const businessScope: ZacSignalScope = {
  type: 'business',
  locationId: null,
  label: 'Luke Ormsby Hair',
  subjectUserId: null,
};
const locationScope = (id: string, label: string): ZacSignalScope => ({
  type: 'location',
  locationId: id,
  label,
  subjectUserId: null,
});

// ---------------------------------------------------------------------------
// Canonical tool payloads, shaped exactly as the Phase 1 tools emit them.
// ---------------------------------------------------------------------------

function rebookingResult(input: {
  ratePercent: number;
  completedBookings: number;
  byLocationCount?: number;
}): ZacToolResult {
  return {
    status: 'ok',
    data: {
      range_start: '2026-08-28T09:00:00.000Z',
      range_end: '2026-09-04T09:00:00.000Z',
      rebooking_rate_percent: input.ratePercent,
      rebooked_visits: Math.round((input.completedBookings * input.ratePercent) / 100),
      stylist_rebooked_visits: 0,
      client_rebooked_visits: 0,
      completed_bookings: input.completedBookings,
      by_location: Array.from({ length: input.byLocationCount ?? 1 }, (_, index) => ({
        location_name: `Site ${index + 1}`,
        rebooking_rate_percent: input.ratePercent,
        rebooked_visits: 0,
      })),
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

function utilisationResult(input: {
  percent: number | null;
  availableMinutes: number;
  threshold: number | null;
  previousPercent?: number | null;
}): ZacToolResult {
  return {
    status: 'ok',
    data: {
      scope: 'owner',
      period: 'week',
      rangeStart: '2026-08-28T00:00:00.000Z',
      rangeEnd: '2026-09-04T00:00:00.000Z',
      overall: {
        availableMinutes: input.availableMinutes,
        bookedMinutes: Math.round((input.availableMinutes * (input.percent ?? 0)) / 100),
        utilisationPercent: input.percent,
        staffDayCount: 20,
      },
      previousPeriod: {
        availableMinutes: input.availableMinutes,
        bookedMinutes: 0,
        utilisationPercent: input.previousPercent ?? null,
      },
      byLocation: [],
      byWeekday: [],
      quietestWeekday: null,
      busiestWeekday: null,
      largestGaps: [],
      warningThresholdPercent: input.threshold,
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

/**
 * The utilisation tool answers `unavailable` two ways and tells them apart by
 * `rowCount`: the no-available-time branch returns the staff-day count, the
 * catch branch returns null.
 */
const noAvailableTime = (explanation: string, staffDayCount = 12): ZacToolResult => ({
  status: 'unavailable',
  data: null,
  explanation,
  rowCount: staffDayCount,
});

const failedRead = (explanation: string): ZacToolResult => ({
  status: 'unavailable',
  data: null,
  explanation,
  rowCount: null,
});

// ---------------------------------------------------------------------------
// Pipeline helpers
// ---------------------------------------------------------------------------

function evaluate(
  metricKey: ZacMetricKey,
  result: ZacToolResult,
  options: { businessId?: string; scope?: ZacSignalScope } = {},
): ZacSignalEvaluation {
  const scope = options.scope ?? businessScope;
  const observation = observations.observe(metricKey, result, scope);
  const [evaluation] = evaluators.evaluate({
    businessId: options.businessId ?? BUSINESS_A,
    observation,
    evaluatedAt: NOW,
  });
  return evaluation;
}

/** A stored row exactly as the store would read one back after an `open`. */
function persist(candidate: ZacSignalCandidate, overrides: Partial<ZacPersistedSignal> = {}): ZacPersistedSignal {
  return {
    id: `sig-${candidate.signalKey}`,
    businessId: BUSINESS_A,
    locationId: candidate.scope.locationId,
    subjectUserId: candidate.scope.subjectUserId,
    signalKey: candidate.signalKey,
    evaluatorKey: candidate.evaluatorKey,
    metricKey: candidate.metricKey,
    issueKey: candidate.issueKey,
    scopeType: candidate.scope.type,
    scopeLabel: candidate.scope.label,
    visibilityScope: candidate.scope.type === 'business' ? 'business_owner' : 'manager_team_theme',
    signalType: candidate.signalType,
    severity: candidate.severity,
    materiality: candidate.materiality,
    confidence: candidate.confidence,
    direction: candidate.direction,
    observationStatus: candidate.observationStatus,
    observedValue: candidate.observedValue,
    comparisonValue: candidate.comparisonValue,
    targetValue: candidate.targetValue,
    targetSource: candidate.targetSource,
    sampleSize: candidate.sampleSize,
    period: candidate.period,
    headline: candidate.headline,
    metricRefs: candidate.metricRefs,
    evidenceRefs: candidate.evidenceRefs,
    limitations: candidate.limitations,
    status: 'active',
    resolutionReason: null,
    occurrenceCount: 1,
    firstEvaluatedAt: '2026-08-28T09:00:00.000Z',
    lastEvaluatedAt: '2026-08-28T09:00:00.000Z',
    lastConfirmedAt: '2026-08-28T09:00:00.000Z',
    resolvedAt: null,
    suppressedUntil: null,
    expiresAt: '2026-09-18T09:00:00.000Z',
    ...overrides,
  };
}

// ===========================================================================
// The registry itself
// ===========================================================================

describe('canonical metric registry', () => {
  it('registers only the metrics with a proven canonical implementation', () => {
    expect(allMetricDefinitions().map((definition) => definition.key)).toEqual([
      'rebooking_rate',
      'utilisation_rate',
    ]);
  });

  it('does not pre-register speculative QLAB, stock, profitability or retention metrics', () => {
    const keys = allMetricDefinitions().map((definition) => definition.key as string);
    for (const speculative of ['colour_waste', 'stock_cover', 'gross_margin', 'client_retention']) {
      expect(keys).not.toContain(speculative);
    }
    expect(() => metricDefinition('colour_waste' as ZacMetricKey)).toThrow(/unregistered/);
  });

  it('admits only definitions that meet the four-criterion bar, structurally', () => {
    // The bar is documented prose unless something checks it: a canonical source
    // reference, a real tool, a stateable sample floor with its unit, ordered
    // materiality bands, and a permission requirement.
    for (const definition of allMetricDefinitions()) {
      expect(definition.canonicalSourceRef.length).toBeGreaterThan(0);
      expect(definition.sourceTool.length).toBeGreaterThan(0);
      expect(definition.sampleUnit.length).toBeGreaterThan(0);
      expect(definition.minimumSample).toBeGreaterThan(0);
      expect(definition.materialityBands.watch).toBeGreaterThan(0);
      expect(definition.materialityBands.attention).toBeGreaterThan(definition.materialityBands.watch);
      expect(definition.staleAfterDays).toBeGreaterThan(0);
      expect(definition.requiredPermissions.length).toBeGreaterThan(0);
    }
  });

  it('points every metric at a real Phase 1 tool rather than recreating the formula', () => {
    expect(metricDefinition('rebooking_rate').sourceTool).toBe('report.rebooking_summary');
    expect(metricDefinition('utilisation_rate').sourceTool).toBe('report.utilisation_summary');
  });

  it('reuses the QLOOQO rebooking threshold rather than declaring a second one', () => {
    // 50 comes from kpi.calc.ts; a literal here would be a second source of truth.
    const evaluation = evaluate('rebooking_rate', rebookingResult({ ratePercent: 30, completedBookings: 100 }));
    expect(evaluation.candidates[0].targetValue).toBe(50);
    expect(evaluation.candidates[0].targetSource).toBe('canonical_threshold');
  });

  it('binds every evaluator to a registered metric and its issue key at boot', () => {
    for (const evaluator of evaluators.all()) {
      expect(metricDefinition(evaluator.metricKey).issueKey).toBe(evaluator.issueKey);
    }
    expect(evaluators.all().map((evaluator) => evaluator.key)).toEqual([
      'rebooking_shortfall',
      'utilisation_shortfall',
    ]);
  });

  it('refuses an evaluator whose issue key contradicts its metric', () => {
    class Rogue extends RebookingShortfallEvaluator {
      override get issueKey(): string {
        return 'utilisation';
      }
    }
    const rogue = new Rogue();
    expect(metricDefinition(rogue.metricKey).issueKey).not.toBe(rogue.issueKey);
  });
});

// ===========================================================================
// Fixture A — material shortfall, sufficient sample
// ===========================================================================

describe('A: rebooking materially below target with a sufficient sample', () => {
  const evaluation = evaluate(
    'rebooking_rate',
    rebookingResult({ ratePercent: 34, completedBookings: 120 }),
  );

  it('raises exactly one active opportunity signal', () => {
    expect(evaluation.candidates).toHaveLength(1);
    expect(evaluation.withheld).toHaveLength(0);
    expect(evaluation.candidates[0].signalType).toBe('opportunity');
  });

  it('separates materiality, severity and confidence', () => {
    const [candidate] = evaluation.candidates;
    // (50 - 34) / 50 — the shortfall as a fraction of the target.
    expect(candidate.materiality).toBeCloseTo(0.32, 4);
    expect(candidate.severity).toBe('attention');
    // Confidence is data quality alone: it never reads the size of the gap.
    expect(candidate.confidence).toBeGreaterThan(0.8);
    expect(candidate.confidence).toBeLessThanOrEqual(0.95);
  });

  it('states a headline built only from measured figures', () => {
    expect(evaluation.candidates[0].headline).toBe(
      'Rebooking rate is 34% against a 50% target — 16 points short, 32% of the target across 120 completed visits.',
    );
  });

  it('reconciles into an OPEN action against an empty store', () => {
    const plan = reconciler.reconcile([], [evaluation], NOW);
    expect(plan.opened).toBe(1);
    expect(plan.actions[0].kind).toBe('open');
    // Expiry comes from the metric's own credibility window (21 days).
    expect(plan.actions[0].expiresAt).toBe('2026-09-25T09:00:00.000Z');
  });

  it('scores a bigger gap as more material without touching confidence', () => {
    const worse = evaluate('rebooking_rate', rebookingResult({ ratePercent: 10, completedBookings: 120 }));
    expect(worse.candidates[0].materiality).toBeGreaterThan(evaluation.candidates[0].materiality);
    expect(worse.candidates[0].confidence).toBe(evaluation.candidates[0].confidence);
  });
});

// ===========================================================================
// Fixture B — same gap, insufficient sample
// ===========================================================================

describe('B: the same gap over an insufficient sample', () => {
  const evaluation = evaluate(
    'rebooking_rate',
    rebookingResult({ ratePercent: 34, completedBookings: 12 }),
  );

  it('raises no signal at all — a thin sample never becomes a negative claim', () => {
    expect(evaluation.candidates).toHaveLength(0);
    expect(evaluation.observationStatus).toBe('insufficient_sample');
  });

  it('records WHY, so "we cannot say yet" is reportable rather than silent', () => {
    expect(evaluation.withheld).toHaveLength(1);
    expect(evaluation.withheld[0].reason).toBe('insufficient_sample');
    expect(evaluation.withheld[0].note).toContain('12 completed visits');
    expect(evaluation.withheld[0].note).toContain('below the 20 needed');
  });

  it('crosses into a signal at the metric-declared floor and not before', () => {
    const atFloor = evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 20 }));
    expect(atFloor.candidates).toHaveLength(1);
    const belowFloor = evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 19 }));
    expect(belowFloor.candidates).toHaveLength(0);
  });

  it('never resolves an existing signal from an insufficient sample', () => {
    const existing = persist(
      evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 })).candidates[0],
    );
    const plan = reconciler.reconcile([existing], [evaluation], NOW);
    expect(plan.resolved).toBe(0);
    expect(plan.actions[0].kind).toBe('retain');
  });
});

// ===========================================================================
// Fixture C — zero denominator
// ===========================================================================

describe('C: a zero denominator produces no false negative-performance signal', () => {
  // The dashboard reports `completedBookings > 0 ? round(...) : 0`, so an empty
  // week arrives as a flat 0% — indistinguishable from a real collapse unless
  // the denominator is read.
  const evaluation = evaluate(
    'rebooking_rate',
    rebookingResult({ ratePercent: 0, completedBookings: 0 }),
  );

  it('classifies it as not applicable, never as a real zero', () => {
    expect(evaluation.observationStatus).toBe('not_applicable');
    expect(evaluation.candidates).toHaveLength(0);
    expect(evaluation.withheld[0].reason).toBe('not_applicable');
  });

  it('still distinguishes a REAL zero over a real denominator', () => {
    const genuine = evaluate('rebooking_rate', rebookingResult({ ratePercent: 0, completedBookings: 140 }));
    expect(genuine.observationStatus).toBe('zero');
    expect(genuine.candidates).toHaveLength(1);
    expect(genuine.candidates[0].materiality).toBe(1);
    expect(genuine.candidates[0].signalType).toBe('opportunity');
    // A measured zero is worth slightly less confidence than a measured value:
    // genuine zero rates are more often a capture gap than a true collapse.
    const measured = evaluate('rebooking_rate', rebookingResult({ ratePercent: 20, completedBookings: 140 }));
    expect(genuine.candidates[0].confidence).toBeLessThan(measured.candidates[0].confidence);
  });

  it('treats an empty rota as not applicable rather than a failed read', () => {
    const evaluation = evaluate('utilisation_rate', noAvailableTime('No rota shifts are recorded.'));
    expect(evaluation.observationStatus).toBe('not_applicable');
    expect(evaluation.candidates).toHaveLength(0);
  });

  it('does NOT read a failed utilisation call as an empty rota', () => {
    // Both come back as `unavailable`; only rowCount separates them. Collapsing
    // the two would let a permission or infrastructure failure present itself as
    // a state the reconciler treats as covered.
    const evaluation = evaluate('utilisation_rate', failedRead('I could not read utilisation just now.'));
    expect(evaluation.observationStatus).toBe('missing');
  });

  it('treats zero available minutes as not applicable', () => {
    const evaluation = evaluate(
      'utilisation_rate',
      utilisationResult({ percent: null, availableMinutes: 0, threshold: 60 }),
    );
    expect(evaluation.observationStatus).toBe('not_applicable');
  });

  it('never resolves an existing signal from a zero denominator', () => {
    const existing = persist(
      evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 })).candidates[0],
    );
    const plan = reconciler.reconcile([existing], [evaluation], NOW);
    expect(plan.resolved).toBe(0);
  });
});

// ===========================================================================
// Fixture D — a healthy metric
// ===========================================================================

describe('D: a healthy metric raises no negative signal', () => {
  it('produces nothing negative when rebooking clears its target', () => {
    const evaluation = evaluate(
      'rebooking_rate',
      rebookingResult({ ratePercent: 62, completedBookings: 140 }),
    );
    for (const candidate of evaluation.candidates) {
      expect(candidate.severity).toBe('positive');
      expect(['progress']).toContain(candidate.signalType);
    }
  });

  it('says nothing at all when a metric merely holds at its target', () => {
    const evaluation = evaluate(
      'utilisation_rate',
      utilisationResult({ percent: 60, availableMinutes: 6000, threshold: 60, previousPercent: 60 }),
    );
    expect(evaluation.candidates).toHaveLength(0);
    expect(evaluation.withheld[0].reason).toBe('healthy_steady');
  });

  it('stays quiet for a gap inside the metric noise floor', () => {
    // 48.5 against 50 is a 3% relative shortfall — under the 5% watch band.
    const evaluation = evaluate(
      'rebooking_rate',
      rebookingResult({ ratePercent: 48.5, completedBookings: 140 }),
    );
    expect(evaluation.candidates).toHaveLength(0);
    expect(evaluation.withheld[0].reason).toBe('below_materiality_floor');
  });

  it('keeps a positive signal out of a priority list when a problem competes', () => {
    // The adapter converts `progress` signals too, and relies on Phase 1's
    // selectTop dropping `positive` candidates so good news never displaces a
    // problem. Asserting that with a positive candidate ALONE proves nothing:
    // selectTop falls back to the full pool when filtering would empty it, so
    // such a test passes even if the filter is removed entirely. The competing
    // problem is what makes this a real assertion.
    const healthy = persist(
      evaluate('rebooking_rate', rebookingResult({ ratePercent: 62, completedBookings: 140 }))
        .candidates[0],
    );
    const problem = persist(
      evaluate('utilisation_rate', utilisationResult({ percent: 44, availableMinutes: 6000, threshold: 60 }))
        .candidates[0],
    );

    const { candidates } = priorities.consolidate(
      adapter.toEvidenceSignals([healthy, problem]),
    );
    expect(candidates).toHaveLength(2);

    // With room for BOTH, the positive one is still left out. This is the
    // assertion that bites: ranking alone would put the problem first anyway, so
    // only asking for more slots than there are problems can tell a real filter
    // from a lucky sort.
    const top = priorities.selectTop(candidates, 3);
    expect(top).toHaveLength(1);
    expect(top[0].severity).toBe('attention');
    expect(top[0].domain).toBe('utilisation');
    expect(top.some((candidate) => candidate.severity === 'positive')).toBe(false);
  });

  it('still returns the good news when it is all there is', () => {
    // The other half of Phase 1's rule: nothing is invented to fill a slot, and
    // an answer of "nothing is wrong" is better than an empty one.
    const healthy = persist(
      evaluate('rebooking_rate', rebookingResult({ ratePercent: 62, completedBookings: 140 }))
        .candidates[0],
    );
    const { candidates } = priorities.consolidate(adapter.toEvidenceSignals([healthy]));
    expect(priorities.selectTop(candidates, 3)).toEqual(candidates);
    expect(candidates[0].severity).toBe('positive');
  });
});

// ===========================================================================
// Fixture E — improvement
// ===========================================================================

describe('E: improvement toward or past a target becomes progress where supported', () => {
  it('raises progress when a reading clears its target having improved', () => {
    const evaluation = evaluate(
      'utilisation_rate',
      utilisationResult({ percent: 71, availableMinutes: 6000, threshold: 60, previousPercent: 58 }),
    );
    const [candidate] = evaluation.candidates;
    expect(candidate.signalType).toBe('progress');
    expect(candidate.severity).toBe('positive');
    expect(candidate.direction).toBe('improving');
    expect(candidate.materiality).toBe(0);
    expect(candidate.headline).toContain('up from 58%');
  });

  it('does NOT call an improvement that is still short of target progress', () => {
    // 46 against 50 is still an 8% relative gap: improving, and still a gap.
    const evaluation = evaluate(
      'rebooking_rate',
      rebookingResult({ ratePercent: 46, completedBookings: 140 }),
    );
    expect(evaluation.candidates[0].signalType).toBe('watch_point');
    expect(evaluation.candidates[0].severity).toBe('watch');
  });

  it('gives progress its own dedupe identity, distinct from the gap it replaces', () => {
    const shortfall = buildSignalKey({
      businessId: BUSINESS_A,
      evaluatorKey: 'utilisation_shortfall',
      metricKey: 'utilisation_rate',
      scope: businessScope,
      family: 'shortfall',
    });
    const progress = buildSignalKey({
      businessId: BUSINESS_A,
      evaluatorKey: 'utilisation_shortfall',
      metricKey: 'utilisation_rate',
      scope: businessScope,
      family: 'progress',
    });
    expect(shortfall).not.toBe(progress);
  });
});

// ===========================================================================
// Fixture F — repeated evaluation
// ===========================================================================

describe('F: the same issue evaluated repeatedly stays ONE signal, refreshed', () => {
  const first = evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 }));
  const stored = persist(first.candidates[0]);

  it('produces the same dedupe key across evaluations with different readings', () => {
    const later = evaluate('rebooking_rate', rebookingResult({ ratePercent: 31, completedBookings: 155 }));
    // Different value, different sample, different rolling window — same issue.
    expect(later.candidates[0].signalKey).toBe(first.candidates[0].signalKey);
    expect(later.candidates[0].observedValue).not.toBe(first.candidates[0].observedValue);
  });

  it('refreshes rather than opening a duplicate', () => {
    const later = evaluate('rebooking_rate', rebookingResult({ ratePercent: 31, completedBookings: 155 }));
    const plan = reconciler.reconcile([stored], [later], NOW);
    expect(plan.opened).toBe(0);
    expect(plan.refreshed).toBe(1);
    expect(plan.actions[0].existing?.id).toBe(stored.id);
    expect(plan.actions[0].candidate?.observedValue).toBe(31);
  });

  it('never emits more than one action for one logical issue', () => {
    const later = evaluate('rebooking_rate', rebookingResult({ ratePercent: 31, completedBookings: 155 }));
    const plan = reconciler.reconcile([stored], [later], NOW);
    const keys = plan.actions.map((action) => action.signalKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps a suppressed signal suppressed while its window is open', () => {
    const suppressed = persist(first.candidates[0], {
      status: 'suppressed',
      suppressedUntil: '2026-10-01T00:00:00.000Z',
    });
    const later = evaluate('rebooking_rate', rebookingResult({ ratePercent: 31, completedBookings: 155 }));
    const plan = reconciler.reconcile([suppressed], [later], NOW);
    expect(plan.actions[0].kind).toBe('refresh');
    expect(plan.actions[0].keepSuppressed).toBe(true);
  });

  it('lets a signal return to active once its suppression window has passed', () => {
    const suppressed = persist(first.candidates[0], {
      status: 'suppressed',
      suppressedUntil: '2026-08-30T00:00:00.000Z',
    });
    const later = evaluate('rebooking_rate', rebookingResult({ ratePercent: 31, completedBookings: 155 }));
    const plan = reconciler.reconcile([suppressed], [later], NOW);
    expect(plan.actions[0].keepSuppressed).toBe(false);
  });
});

// ===========================================================================
// Fixture G — valid recovery
// ===========================================================================

describe('G: a valid recovery resolves the active signal', () => {
  const shortfall = evaluate(
    'utilisation_rate',
    utilisationResult({ percent: 44, availableMinutes: 6000, threshold: 60 }),
  );
  const stored = persist(shortfall.candidates[0]);

  it('resolves when a later valid reading clears the target', () => {
    const recovered = evaluate(
      'utilisation_rate',
      utilisationResult({ percent: 68, availableMinutes: 6000, threshold: 60, previousPercent: 44 }),
    );
    const plan = reconciler.reconcile([stored], [recovered], NOW);
    const resolve = plan.actions.find((action) => action.kind === 'resolve');
    expect(resolve?.signalKey).toBe(stored.signalKey);
    expect(plan.resolved).toBe(1);
    // And the recovery is recorded as its own, separate signal.
    expect(plan.opened).toBe(1);
  });

  it('resolves when the gap merely closes inside the noise floor', () => {
    const settled = evaluate(
      'utilisation_rate',
      utilisationResult({ percent: 59, availableMinutes: 6000, threshold: 60, previousPercent: 59 }),
    );
    expect(settled.candidates).toHaveLength(0);
    expect(settled.withheld[0].reason).toBe('below_materiality_floor');
    const plan = reconciler.reconcile([stored], [settled], NOW);
    expect(plan.resolved).toBe(1);
  });

  it('does NOT resolve when the target itself disappears', () => {
    // A multi-location scope resolves no configured threshold. That says
    // nothing about whether the gap closed.
    const targetless = evaluate(
      'utilisation_rate',
      utilisationResult({ percent: 44, availableMinutes: 6000, threshold: null }),
    );
    expect(targetless.withheld[0].reason).toBe('no_target');
    const plan = reconciler.reconcile([stored], [targetless], NOW);
    expect(plan.resolved).toBe(0);
    expect(plan.actions[0].kind).toBe('retain');
  });
});

// ===========================================================================
// Fixture H — missing / failed observation
// ===========================================================================

describe('H: a missing or failed observation NEVER resolves an existing signal', () => {
  const stored = persist(
    evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 })).candidates[0],
  );

  const failures: Array<[string, ZacToolResult]> = [
    ['the tool errored', { status: 'error', data: null, explanation: 'temporarily unavailable', rowCount: null }],
    ['the tool was denied', { status: 'permission_denied', data: null, explanation: 'not for your role', rowCount: null }],
    ['the tool is not connected', { status: 'not_connected', data: null, explanation: 'not connected', rowCount: null }],
    ['the payload was empty', { status: 'ok', data: {}, explanation: '', rowCount: 0 }],
  ];

  it.each(failures)('leaves the signal active when %s', (_label, result) => {
    const evaluation = evaluate('rebooking_rate', result);
    expect(evaluation.observationStatus).toBe('missing');
    const plan = reconciler.reconcile([stored], [evaluation], NOW);
    expect(plan.resolved).toBe(0);
    expect(plan.actions[0].kind).toBe('retain');
    expect(plan.actions[0].retentionReason).toBe('unconfirmed_observation');
  });

  it('leaves the signal active when the metric was not evaluated at all', () => {
    const plan = reconciler.reconcile([stored], [], NOW);
    expect(plan.resolved).toBe(0);
    expect(plan.actions[0].retentionReason).toBe('not_evaluated');
  });

  it('does not extend the expiry clock on an unconfirmed reading', () => {
    const evaluation = evaluate('rebooking_rate', failures[0][1]);
    const plan = reconciler.reconcile([stored], [evaluation], NOW);
    expect(plan.actions[0].expiresAt).toBeUndefined();
  });

  it('EXPIRES rather than resolves once an unconfirmed signal ages out', () => {
    const stale = persist(
      evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 })).candidates[0],
      { expiresAt: '2026-09-01T00:00:00.000Z' },
    );
    const evaluation = evaluate('rebooking_rate', failures[0][1]);
    const plan = reconciler.reconcile([stale], [evaluation], NOW);
    expect(plan.expired).toBe(1);
    expect(plan.resolved).toBe(0);
    // "We stopped being able to tell" is a different fact from "it got better".
    expect(plan.actions[0].kind).toBe('expire');
  });

  it('does not expire a signal that a live reading just re-confirmed', () => {
    const stale = persist(
      evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 })).candidates[0],
      { expiresAt: '2026-09-01T00:00:00.000Z' },
    );
    const confirmed = evaluate('rebooking_rate', rebookingResult({ ratePercent: 33, completedBookings: 130 }));
    const plan = reconciler.reconcile([stale], [confirmed], NOW);
    expect(plan.expired).toBe(0);
    expect(plan.refreshed).toBe(1);
  });
});

// ===========================================================================
// Fixtures I and J — isolation and scoping
// ===========================================================================

describe('I: the same issue in two businesses stays two isolated signals', () => {
  const result = rebookingResult({ ratePercent: 34, completedBookings: 120 });

  it('gives each tenant its own dedupe identity', () => {
    const a = evaluate('rebooking_rate', result, { businessId: BUSINESS_A });
    const b = evaluate('rebooking_rate', result, { businessId: BUSINESS_B });
    expect(a.candidates[0].signalKey).not.toBe(b.candidates[0].signalKey);
    expect(a.candidates[0].signalKey.startsWith(BUSINESS_A)).toBe(true);
  });

  it("never reconciles one business's candidate against another's signal", () => {
    const a = evaluate('rebooking_rate', result, { businessId: BUSINESS_A });
    const b = evaluate('rebooking_rate', result, { businessId: BUSINESS_B });
    const storedA = persist(a.candidates[0]);
    // Business B evaluating its own identical problem must OPEN, not refresh.
    const plan = reconciler.reconcile([storedA], [b], NOW);
    expect(plan.opened).toBe(1);
    expect(plan.refreshed).toBe(0);
  });
});

describe('J: the same issue at two locations becomes two scoped signals', () => {
  const one = evaluate('utilisation_rate', utilisationResult({ percent: 42, availableMinutes: 6000, threshold: 60 }), {
    scope: locationScope(LOCATION_1, 'Pinner'),
  });
  const two = evaluate('utilisation_rate', utilisationResult({ percent: 47, availableMinutes: 5400, threshold: 60 }), {
    scope: locationScope(LOCATION_2, 'Primrose Hill'),
  });

  it('keys each location separately', () => {
    expect(one.candidates[0].signalKey).not.toBe(two.candidates[0].signalKey);
    expect(one.candidates[0].scope.locationId).toBe(LOCATION_1);
    expect(two.candidates[0].scope.locationId).toBe(LOCATION_2);
  });

  it('opens one signal per location rather than merging them', () => {
    const plan = reconciler.reconcile([], [one, two], NOW);
    expect(plan.opened).toBe(2);
  });

  it('resolving one location leaves the other untouched', () => {
    const stored = [persist(one.candidates[0]), persist(two.candidates[0])];
    const recovered = evaluate(
      'utilisation_rate',
      utilisationResult({ percent: 74, availableMinutes: 6000, threshold: 60, previousPercent: 42 }),
      { scope: locationScope(LOCATION_1, 'Pinner') },
    );
    const plan = reconciler.reconcile(stored, [recovered, two], NOW);
    const resolved = plan.actions.filter((action) => action.kind === 'resolve');
    expect(resolved).toHaveLength(1);
    expect(resolved[0].existing?.locationId).toBe(LOCATION_1);
    expect(plan.actions.some((action) => action.kind === 'refresh' && action.existing?.locationId === LOCATION_2)).toBe(true);
  });

  it('carries the location scope into the persisted visibility boundary', () => {
    const stored = persist(one.candidates[0]);
    expect(stored.scopeType).toBe('location');
    expect(stored.visibilityScope).toBe('manager_team_theme');
  });
});

// ===========================================================================
// Fixture L — conversion into a Phase 1 priority candidate
// ===========================================================================

describe('L: a persisted signal converts safely into a priority candidate', () => {
  const stored = persist(
    evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 })).candidates[0],
  );

  it('produces a valid Phase 1 evidence signal with a real tool name', () => {
    const [signal] = adapter.toEvidenceSignals([stored]);
    expect(signal.sourceTool).toBe('report.rebooking_summary');
    expect(signal.issueKey).toBe('rebooking');
    expect(signal.domain).toBe('rebooking');
    expect(signal.severity).toBe('attention');
    expect(signal.currentValue).toBe(34);
    expect(signal.targetValue).toBe(50);
    expect(signal.targetSource).toBe('tool_threshold');
    expect(signal.priorityScore).toBeGreaterThan(0);
  });

  it('consolidates through the EXISTING priority engine into a titled candidate', () => {
    const { candidates } = priorities.consolidate(adapter.toEvidenceSignals([stored]));
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('cand_rebooking');
    expect(candidates[0].domain).toBe('rebooking');
    expect(candidates[0].title).toBe('Rebooking');
    expect(candidates[0].materiality).toBeCloseTo(0.32, 4);
    expect(candidates[0].priorityScore).toBeGreaterThan(0);
  });

  it('merges with a live reading of the same issue instead of taking a second slot', () => {
    const live = adapter.toEvidenceSignals([stored]);
    const alsoLive = adapter.toEvidenceSignals([
      persist(
        evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 }), {
          scope: locationScope(LOCATION_1, 'Pinner'),
        }).candidates[0],
      ),
    ]);
    const { candidates } = priorities.consolidate([...live, ...alsoLive]);
    // One business issue, one candidate — the whole reason issueKey exists.
    expect(candidates).toHaveLength(1);
    expect(candidates[0].supportingSignals).toHaveLength(1);
  });

  it('attributes a remembered goal differently from a configured threshold', () => {
    const goal = observations.observe(
      'rebooking_rate',
      rebookingResult({ ratePercent: 34, completedBookings: 120 }),
      businessScope,
      [{ kind: 'business_goal', summary: 'Increase rebooking to 60%.' }],
    );
    expect(goal.targetSource).toBe('user_stated_goal');
    const [evaluation] = evaluators.evaluate({ businessId: BUSINESS_A, observation: goal, evaluatedAt: NOW });
    const [signal] = adapter.toEvidenceSignals([persist(evaluation.candidates[0])]);
    expect(signal.targetValue).toBe(60);
    expect(signal.targetSource).toBe('user_memory_goal');
    // Phase 1 raises RELEVANCE for a stated goal — provenance survives the trip.
    const { candidates } = priorities.consolidate([signal]);
    expect(candidates[0].relevance).toBe(1);
  });

  it('carries safe references only — no operational payload', () => {
    const [signal] = adapter.toEvidenceSignals([stored]);
    expect(signal.evidenceRefs).toEqual([
      {
        source_type: 'report.dashboard',
        source_ref: 'DashboardService.kpis',
        as_of: '2026-09-04T09:00:00.000Z',
        entities_used: [],
      },
    ]);
    expect(stored.metricRefs).toEqual([
      {
        metricKey: 'rebooking_rate',
        sourceRef: 'DashboardService.kpis',
        sourceTool: 'report.rebooking_summary',
        windowStart: '2026-08-28T09:00:00.000Z',
        windowEnd: '2026-09-04T09:00:00.000Z',
      },
    ]);
  });

  it('tells a reader how long a persisted problem has been running', () => {
    const recurring = persist(
      evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 })).candidates[0],
      { occurrenceCount: 4 },
    );
    const [signal] = adapter.toEvidenceSignals([recurring]);
    expect(signal.limitations).toContain('Seen in 4 evaluations since 2026-08-28.');
  });

  it('does not let a location signal claim to be the business', () => {
    const scoped = persist(
      evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 }), {
        scope: locationScope(LOCATION_1, 'Pinner'),
      }).candidates[0],
    );
    const [signal] = adapter.toEvidenceSignals([scoped]);
    expect(signal.scope).toBe(`location:${LOCATION_1}`);
  });

  it('keeps two sites with the same reading as two facts, not one duplicate', () => {
    // Phase 1's identityKey is issueKey|metric|scope|period|current|target. A
    // bare 'location' for both would make the second an exact duplicate —
    // silently dropped AND counted as corroboration that raises confidence.
    const one = persist(
      evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 }), {
        scope: locationScope(LOCATION_1, 'Pinner'),
      }).candidates[0],
    );
    const two = persist(
      evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 }), {
        scope: locationScope(LOCATION_2, 'Primrose Hill'),
      }).candidates[0],
      { locationId: LOCATION_2 },
    );
    const { candidates, duplicateSignalsRemoved } = priorities.consolidate(
      adapter.toEvidenceSignals([one, two]),
    );
    expect(duplicateSignalsRemoved).toBe(0);
    expect(candidates[0].supportingSignals).toHaveLength(1);
  });
});

// ===========================================================================
// Boundaries this workstream deliberately does not cross
// ===========================================================================

describe('workstream boundaries', () => {
  it('evaluates deterministically — same inputs, same output, no clock read', () => {
    const result = rebookingResult({ ratePercent: 34, completedBookings: 120 });
    const first = evaluate('rebooking_rate', result);
    const second = evaluate('rebooking_rate', result);
    expect(second).toEqual(first);
  });

  it('reconciles deterministically for a fixed evaluatedAt', () => {
    const evaluation = evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 }));
    expect(reconciler.reconcile([], [evaluation], NOW)).toEqual(
      reconciler.reconcile([], [evaluation], NOW),
    );
  });

  it('registers no scheduler, no cron and no background scan', () => {
    const service = ZacIntelligenceSignalService.prototype as unknown as Record<string, unknown>;
    expect(service['onModuleInit']).toBeUndefined();
    expect(service['onApplicationBootstrap']).toBeUndefined();
    // Evaluation is only ever reached through an explicit call.
    expect(typeof service['evaluate']).toBe('function');
  });

  it('keeps the evaluator contract open for domains this workstream does not implement', () => {
    // A later workstream registers a metric and an evaluator; nothing in the
    // observation, evaluation, reconciliation or persistence layers changes.
    expect(new RebookingShortfallEvaluator().metricKey).toBe('rebooking_rate');
    expect(new UtilisationShortfallEvaluator().metricKey).toBe('utilisation_rate');
    expect(evaluators.forMetric('rebooking_rate')).toHaveLength(1);
  });
});

// ===========================================================================
// Honesty repairs found in adversarial review
// ===========================================================================

describe('a non-positive target is not a target', () => {
  // core.location_settings permits a 0% utilisation threshold. Treating 0 as a
  // real target makes EVERY reading "meet" it — minting a false progress signal
  // and, far worse, resolving the genuine risk signal it replaced.
  const zeroTarget = evaluate(
    'utilisation_rate',
    utilisationResult({ percent: 44, availableMinutes: 6000, threshold: 0 }),
  );

  it('withholds rather than claiming progress', () => {
    expect(zeroTarget.candidates).toHaveLength(0);
    expect(zeroTarget.withheld[0].reason).toBe('no_target');
  });

  it('does not resolve a live risk signal', () => {
    const existing = persist(
      evaluate('utilisation_rate', utilisationResult({ percent: 44, availableMinutes: 6000, threshold: 60 }))
        .candidates[0],
    );
    expect(reconciler.reconcile([existing], [zeroTarget], NOW).resolved).toBe(0);
  });
});

describe('headlines state only what was measured', () => {
  it('does not claim a rise when the reading did not rise', () => {
    // Above target but FALLING: still progress against the target, and "up from"
    // would be a sentence the numbers do not support.
    const declining = evaluate(
      'utilisation_rate',
      utilisationResult({ percent: 64, availableMinutes: 6000, threshold: 60, previousPercent: 78 }),
    );
    expect(declining.candidates[0].signalType).toBe('progress');
    expect(declining.candidates[0].direction).toBe('declining');
    expect(declining.candidates[0].headline).not.toContain('up from');
  });

  it('names the utilisation gap as the hours needed, not the hours idle', () => {
    // 100 rostered hours at 44% against 60%: 16 more booked hours reach the
    // threshold. The IDLE hours are 56 — a different, much larger number, and
    // calling 16 "unbooked" would understate idle capacity while sounding exact.
    const evaluation = evaluate(
      'utilisation_rate',
      utilisationResult({ percent: 44, availableMinutes: 6000, threshold: 60 }),
    );
    expect(evaluation.candidates[0].headline).toBe(
      'Utilisation of rostered hours is 44% against a 60% threshold — 16 points short, about 16 more booked hours across 100 rostered hours would reach it.',
    );
  });
});

describe('an unevaluated signal can still expire', () => {
  it('expires when nothing looked at it and its credibility window has passed', () => {
    // A metric that stops being evaluated at all — a permission removed, a
    // location dropped — must not leave its signals asserting themselves
    // forever. That is the same lie as resolving them, pointing the other way.
    const stale = persist(
      evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 })).candidates[0],
      { expiresAt: '2026-09-01T00:00:00.000Z' },
    );
    const plan = reconciler.reconcile([stale], [], NOW);
    expect(plan.expired).toBe(1);
    expect(plan.resolved).toBe(0);
  });

  it('still retains an unevaluated signal that is inside its window', () => {
    const fresh = persist(
      evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 })).candidates[0],
    );
    const plan = reconciler.reconcile([fresh], [], NOW);
    expect(plan.expired).toBe(0);
    expect(plan.actions[0].retentionReason).toBe('not_evaluated');
  });
});

describe('confidence ordering', () => {
  it('never scores an unknown denominator above a known minimal one', () => {
    const minimal = evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 20 }));
    // 20 is exactly the floor, so this is the weakest signal the evaluator will
    // raise. An observation with no denominator at all must rank below it.
    const known = minimal.candidates[0]?.confidence ?? 0;
    const unknownSample = computeConfidence(
      {
        metricKey: 'rebooking_rate',
        scope: businessScope,
        status: 'valid',
        value: 34,
        comparisonValue: null,
        sampleSize: null,
        target: 50,
        targetSource: 'canonical_threshold',
        period: null,
        metricRefs: [],
        evidenceRefs: [],
        limitations: [],
      },
      metricDefinition('rebooking_rate'),
    ).confidence;
    expect(unknownSample).toBeLessThan(known);
  });
});

// ===========================================================================
// Fixture H — WHY a signal resolves: recovered vs superseded
// ===========================================================================

describe('H: why a signal resolves — recovered is earned against the signal’s own target', () => {
  type Memory = Parameters<ZacMetricObservationService['observe']>[3];
  const goal30: Memory = [{ kind: 'business_goal', summary: 'Get rebooking back to 30%.' }];
  const withMemory = (result: ZacToolResult, memory: Memory): ZacSignalEvaluation => {
    const observation = observations.observe('rebooking_rate', result, businessScope, memory);
    const [evaluation] = evaluators.evaluate({ businessId: BUSINESS_A, observation, evaluatedAt: NOW });
    return evaluation;
  };
  const shortfall = () =>
    persist(evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 })).candidates[0]);
  const resolveOf = (plan: ReturnType<ZacSignalReconciler['reconcile']>) => plan.actions.find((a) => a.kind === 'resolve');

  it('ends a progress episode as superseded, never recovered', () => {
    const progress = persist(evaluate('rebooking_rate', rebookingResult({ ratePercent: 62, completedBookings: 130 })).candidates[0]);
    const fallback = evaluate('rebooking_rate', rebookingResult({ ratePercent: 34, completedBookings: 120 }));
    const plan = reconciler.reconcile([progress], [fallback], NOW);
    expect(resolveOf(plan)?.existing?.id).toBe(progress.id);
    expect(resolveOf(plan)?.resolutionReason).toBe('superseded');
  });

  it('records recovered when the reading closed the gap against the target the signal was raised for', () => {
    const recovered = evaluate('rebooking_rate', rebookingResult({ ratePercent: 62, completedBookings: 130 }));
    expect(resolveOf(reconciler.reconcile([shortfall()], [recovered], NOW))?.resolutionReason).toBe('recovered');
  });

  it('records superseded when only the TARGET moved: a goal typed into memory is not a business improvement', () => {
    // The identical 34% reading, now "healthy" only because a 30% goal is remembered.
    const substituted = withMemory(rebookingResult({ ratePercent: 34, completedBookings: 120 }), goal30);
    expect(substituted.candidates[0]?.signalType).toBe('progress');
    const plan = reconciler.reconcile([shortfall()], [substituted], NOW);
    expect(resolveOf(plan)?.existing?.signalKey).toBe(shortfall().signalKey);
    expect(resolveOf(plan)?.resolutionReason).toBe('superseded');
  });

  it('still records recovered when the target moved AND the reading cleared the original target', () => {
    const genuinelyBetter = withMemory(rebookingResult({ ratePercent: 62, completedBookings: 130 }), goal30);
    expect(resolveOf(reconciler.reconcile([shortfall()], [genuinelyBetter], NOW))?.resolutionReason).toBe('recovered');
  });
});
