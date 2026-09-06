import type { ZacConfidenceBucket } from '../../routing/zac-request-mode.types';
import type { ZacToolName, ZacToolResult } from '../../tools/zac-tool.types';
import { allMetricDefinitions } from '../zac-metric-registry';
import type {
  ZacMetricKey,
  ZacMetricTargetSource,
  ZacSignalScopeType,
} from '../zac-metric.types';
import type { ZacSignalActionKind } from '../zac-signal-reconciler';
import type {
  ZacSignalDirection,
  ZacSignalFamily,
  ZacSignalResolutionReason,
  ZacSignalSeverity,
  ZacSignalStatus,
  ZacSignalType,
  ZacWithheldSignal,
} from '../zac-signal.types';

/**
 * THE LABEL CONTRACT for the Phase 2 signal evaluation dataset.
 *
 * Every label is one of the framework's OWN closed types — signal kind,
 * severity, direction, lifecycle action, resolution reason, withheld reason —
 * so a case can only assert values the pipeline can actually produce, and a
 * vocabulary change in the framework is a compile error in the dataset rather
 * than a silently stale label. The two band labels that are not framework types
 * are projections of framework numbers onto framework-declared thresholds:
 *
 *   materialityBand  zero | watch | attention — from the metric's own bands
 *   confidenceBand   high | medium | low      — the existing confidenceScoreBucket
 *
 * A case is a SEQUENCE of steps against one in-memory store, because the things
 * Workstream 1 exists to get right — refresh-not-duplicate, never-resolve-on-
 * missing, expire-is-not-resolve — are only observable across runs. A single
 * evaluation is a one-step sequence.
 */

/** Fixed actor presets, so a case names a role rather than fabricating one. */
export type SignalEvalActor =
  /** Business A owner, two locations (L1, L2) — the canonical whole-business view. */
  | 'owner'
  /** Business A owner whose business has ONE location (L1). */
  | 'owner_single'
  /** Business A manager scoped to L1 only. */
  | 'manager_l1'
  /** Business A manager scoped to L2 only. */
  | 'manager_l2'
  /** Business A manager holding TWO of the business's locations (L1 and L2): a partial, multi-site scope. */
  | 'manager_l1_l2'
  /** Business A stylist: zac.access only, no report permissions. */
  | 'stylist'
  /** Business A owner with report.dashboard.view REMOVED (rebooking metric denied). */
  | 'owner_no_dashboard'
  /** Business A owner with report.performance.view REMOVED (utilisation denied). */
  | 'owner_no_performance'
  /** Business A owner with zac.access REMOVED. */
  | 'owner_no_zac'
  /** Business B owner, one location (L3). A different tenant entirely. */
  | 'owner_b';

export type SignalEvalDomain = 'rebooking' | 'utilisation' | 'lifecycle' | 'scoping' | 'dedupe';

/**
 * Tool results are authored in the SAME shape the Phase 1 tools emit, keyed by
 * tool name — or `tool@locationId` for a per-location override on a
 * multi-location fan-out. A metric with no fixture is dispatched as
 * `permission_denied`, which the observation layer reads as `missing`: the safe
 * default, and never something a case can accidentally pass on.
 */
export type SignalEvalToolFixtures = Record<string, ZacToolResult>;

export type SignalEvalMaterialityBand = 'zero' | 'watch' | 'attention';

/** What one (metric, scope) should have produced in one evaluate step. */
export interface SignalEvalSignalExpectation {
  metric: ZacMetricKey;
  /** Defaults to the business scope. */
  scopeType?: ZacSignalScopeType;
  locationId?: string | null;
  /**
   * Which of the two logical signals about this (metric, scope) the expectation
   * is about. A shortfall and a progress run have different keys and can change
   * state in the SAME step (one opens while the other resolves); without this
   * the resolve of the progress row — the `superseded` semantic — could not be
   * asserted. Omitted = whichever candidate the step produced.
   */
  family?: ZacSignalFamily;
  /** Was a candidate raised at all (for the family, when given)? */
  produced: boolean;
  /** When not produced: why the evaluator declined. */
  withheldReason?: ZacWithheldSignal['reason'];
  kind?: ZacSignalType;
  direction?: ZacSignalDirection;
  materialityBand?: SignalEvalMaterialityBand;
  /** The materiality NUMBER (gap / target), to 1e-4 — the band alone cannot see a wrong formula inside the right band. */
  materiality?: number;
  severity?: ZacSignalSeverity;
  confidenceBand?: ZacConfidenceBucket;
  targetSource?: ZacMetricTargetSource | null;
  /** What the reconciler decided for this signal's key this step. */
  lifecycleAction?: ZacSignalActionKind;
  resolutionReason?: ZacSignalResolutionReason;
  /** Substrings that must appear in the candidate's limitations. */
  limitationsInclude?: string[];
}

/** Assertions on the in-memory store after the step. */
export interface SignalEvalStoreExpectation {
  /** Active rows for the step actor's business. The duplicate-active gate. */
  activeSignals?: number;
  /** Active + suppressed rows for the actor's business. */
  liveSignals?: number;
  /** Every row for the actor's business, every status — episodes accumulate. */
  episodes?: number;
  /** Row counts by status for the actor's business. */
  statuses?: Partial<Record<ZacSignalStatus, number>>;
  /**
   * Row counts by PERSISTED resolution reason — what the store holds after the
   * service applied the plan, not what the plan said. The two can only differ
   * if the service mis-applies a reason, which is exactly what this catches.
   */
  resolutionReasons?: Partial<Record<ZacSignalResolutionReason, number>>;
  /**
   * DEDUPE: the active signal key for `metric` (+ optional scope) must equal
   * the key that was live after the named earlier step. Same logical issue,
   * same row.
   */
  sameSignalKeyAsStep?: { step: string; metric: ZacMetricKey; locationId?: string | null };
  /** DEDUPE: the keys live after this step and after the named step must DIFFER. */
  differentSignalKeyFromStep?: { step: string; metric: ZacMetricKey; locationId?: string | null };
}

/** Who can retrieve what, re-checked against CURRENT permissions after the step. */
export interface SignalEvalVisibilityExpectation {
  actor: SignalEvalActor;
  count: number;
}

export interface SignalEvalEvaluateStep {
  kind: 'evaluate';
  id: string;
  evaluatedAt: string;
  actor: SignalEvalActor;
  /** context.locationId — an explicit single-location focus for the turn. */
  locationFocus?: string | null;
  /** Redacted memory summaries, as the turn would retrieve them. */
  memory?: Array<{ kind: string; summary: string }>;
  tools: SignalEvalToolFixtures;
  expected: {
    signals?: SignalEvalSignalExpectation[];
    store?: SignalEvalStoreExpectation;
    visibleTo?: SignalEvalVisibilityExpectation[];
  };
}

/** A human action between evaluations. The framework never suppresses on its own. */
export interface SignalEvalSuppressStep {
  kind: 'suppress';
  id: string;
  at: string;
  actor: SignalEvalActor;
  metric: ZacMetricKey;
  locationId?: string | null;
  until: string;
  expected: {
    /** Whether the service accepted the suppression (false = not visible / invalid window). */
    accepted: boolean;
    store?: SignalEvalStoreExpectation;
    visibleTo?: SignalEvalVisibilityExpectation[];
  };
}

export type SignalEvalStep = SignalEvalEvaluateStep | SignalEvalSuppressStep;

export interface SignalEvalCase {
  id: string;
  domain: SignalEvalDomain;
  description: string;
  /** Hard Workstream 1 invariants this case guards. Any failure here is a gate failure. */
  invariants?: SignalEvalInvariant[];
  steps: SignalEvalStep[];
}

/** The zero-tolerance gates. A case tagged with one fails the RUN, not just the case. */
export type SignalEvalInvariant =
  | 'zero_denominator_no_false_negative'
  | 'missing_data_never_resolves'
  | 'failed_read_never_resolves'
  | 'repeat_run_no_duplicate'
  | 'tenants_never_reconcile'
  | 'removed_permission_hides'
  | 'restricted_scope_never_widens';

export interface SignalEvalDataset {
  version: string;
  /** The signal framework contract the labels were authored against. */
  frameworkVersion: string;
  cases: SignalEvalCase[];
}

/** One assertion's outcome — the unit every metric is computed over. */
export interface SignalEvalCheck {
  caseId: string;
  stepId: string;
  /** Which scorecard line this check feeds. */
  category:
    | 'signal_presence'
    | 'kind'
    | 'direction'
    | 'materiality_band'
    | 'severity'
    | 'confidence_band'
    | 'target_source'
    | 'withheld_reason'
    | 'lifecycle_action'
    | 'resolution_reason'
    | 'limitations'
    | 'dedupe'
    | 'store'
    | 'visibility'
    | 'suppress';
  label: string;
  expected: string;
  actual: string;
  passed: boolean;
  /** Which zero-tolerance gate this check belongs to, if any. */
  invariant?: SignalEvalInvariant;
  /** For a presence check: the kind the pipeline actually produced, so the scorer can tell a false NEGATIVE signal from unexpected good news. */
  producedKind?: ZacSignalType | null;
}

export interface SignalEvalCaseResult {
  caseId: string;
  domain: SignalEvalDomain;
  passed: boolean;
  checks: SignalEvalCheck[];
  /** Derived from ACTUALS, not labels — see the scorer. */
  falseResolutionsOnMissingData: number;
  duplicateLiveAttempts: number;
  crossTenantReconciliations: number;
  /** Rows returned by listVisible whose business is not the actor's. Must be 0. */
  crossTenantVisibleRows: number;
  /** Case-level authoring or runtime error, if the case could not run at all. */
  error?: string;
}

export interface SignalEvalMetrics {
  datasetVersion: string;
  frameworkVersion: string;
  cases: number;
  passed: number;
  failed: number;
  /** Per-category accuracy: correct / asserted. */
  accuracy: Record<SignalEvalCheck['category'], { asserted: number; correct: number }>;
  /** A negative signal (opportunity/risk/watch_point) where none, or progress, was expected. */
  falsePositiveNegativeSignals: { count: number; denominator: number };
  /** No signal where one was expected. */
  falseNegativeSignals: { count: number; denominator: number };
  duplicateActiveSignals: number;
  falseResolutionsOnMissingData: number;
  tenantIsolationFailures: number;
  permissionFailures: number;
  /** Gate failures by invariant. Any non-zero fails the run. */
  invariantFailures: Record<SignalEvalInvariant, number>;
  failedCases: Array<{ caseId: string; failures: SignalEvalCheck[]; error?: string }>;
}

/** Type guard over a loaded JSON dataset — closed enums, checked at load. */
export const SIGNAL_EVAL_ACTORS: readonly SignalEvalActor[] = [
  'owner',
  'owner_single',
  'manager_l1',
  'manager_l2',
  'manager_l1_l2',
  'stylist',
  'owner_no_dashboard',
  'owner_no_performance',
  'owner_no_zac',
  'owner_b',
];

/**
 * The tools a fixture may name — derived from the registry, so registering a
 * new metric (with its `sourceTool`) is what admits its fixtures: no second
 * list to keep in step.
 */
export const SIGNAL_EVAL_TOOLS: readonly ZacToolName[] = allMetricDefinitions().map((d) => d.sourceTool);
