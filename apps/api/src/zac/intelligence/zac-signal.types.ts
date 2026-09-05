import type { ZacEvidenceSignal } from '../analysis/zac-analysis.types';
import type { ZacEvidenceItem, ZacMemoryScope } from '../responses/zac-response.types';
import type {
  ZacMetricKey,
  ZacMetricObservation,
  ZacMetricReference,
  ZacMetricObservationStatus,
  ZacMetricTargetSource,
  ZacSignalScope,
} from './zac-metric.types';

/** Re-exported so the signal layer has one import surface for its own vocabulary. */
export type { ZacSignalScope, ZacSignalScopeType } from './zac-metric.types';

/**
 * THE SIGNAL MODEL.
 *
 * Four types, closed. They answer "what KIND of thing is this?", which is a
 * different question from how bad it is (severity), how big the gap is
 * (materiality) and how much the data supports saying so (confidence). Keeping
 * those four axes apart is the point of this file — collapsing them into one
 * "score" is what produces a number nobody can explain back to an owner.
 *
 *   opportunity  an unrealised upside: the work happened, the follow-through
 *                did not. Recoverable by doing something differently.
 *   risk         a condition that is costing the business now and will keep
 *                costing it: capacity already paid for and lost.
 *   watch_point  a real gap that is not yet material. Worth knowing, not worth
 *                acting on today.
 *   progress     movement toward or past a target. Raised only on positive
 *                evidence, and only where a comparison exists to support it.
 */
export type ZacSignalType = 'opportunity' | 'risk' | 'watch_point' | 'progress';

export const ZAC_SIGNAL_TYPES: readonly ZacSignalType[] = [
  'opportunity',
  'risk',
  'watch_point',
  'progress',
];

/**
 * Severity reuses the Phase 1 vocabulary EXACTLY — `positive | watch |
 * attention`. Three severity scales already exist in this repo ('positive |
 * watch | attention' in ZAC, 'info | attention | high' in the V1.1 operational
 * signals, and the user-facing Risk / Watch Point response types), and
 * 'attention' already means two different things across two of them. A fourth
 * would make the mapping between persisted signals and priority candidates a
 * translation rather than an identity.
 */
export type ZacSignalSeverity = ZacEvidenceSignal['severity'];

export const ZAC_SIGNAL_SEVERITIES: readonly ZacSignalSeverity[] = ['positive', 'watch', 'attention'];

/**
 * LIFECYCLE.
 *
 *   active      the triggering condition is believed to hold now
 *   resolved    positive valid evidence showed the condition no longer holds
 *   suppressed  a person asked not to be told about this for a while
 *   expired     the signal aged past its metric's credibility window without
 *               being re-confirmed — we stop asserting it rather than pretend
 *
 * `resolved` and `expired` are deliberately different states. "It got better"
 * and "we stopped being able to tell" are not the same fact, and merging them
 * would let a data outage read as a business improvement.
 */
export type ZacSignalStatus = 'active' | 'resolved' | 'suppressed' | 'expired';

export const ZAC_SIGNAL_STATUSES: readonly ZacSignalStatus[] = [
  'active',
  'resolved',
  'suppressed',
  'expired',
];

/**
 * Why a signal left `active`. Closed, auditable, never free text.
 *
 * `recovered` and `superseded` are separate because the same reconciler branch
 * ends both a shortfall and a progress episode. A gap that closed has RECOVERED;
 * a run of progress that stopped because the metric fell back has been
 * SUPERSEDED by the problem that replaced it — calling that "recovered" would
 * put the most reassuring word in the audit trail on the least reassuring event.
 */
export type ZacSignalResolutionReason =
  | 'recovered'
  | 'superseded'
  | 'expired_unconfirmed'
  | 'suppressed_by_actor';

export const ZAC_SIGNAL_RESOLUTION_REASONS: readonly ZacSignalResolutionReason[] = [
  'recovered',
  'superseded',
  'expired_unconfirmed',
  'suppressed_by_actor',
];

/** Direction of travel, when a comparison reading exists. Same vocabulary as Phase 1. */
export type ZacSignalDirection = ZacEvidenceSignal['direction'];

/**
 * SIGNAL CANDIDATE — what an evaluator produces. Not yet persisted, not yet
 * reconciled against anything, and carrying no identity of its own beyond the
 * deterministic `signalKey` that decides which persisted signal it refreshes.
 */
export interface ZacSignalCandidate {
  /** Deterministic dedupe identity. See {@link buildSignalKey}. */
  signalKey: string;
  evaluatorKey: string;
  metricKey: ZacMetricKey;
  /** The Phase 1 business issue, so the priority engine groups correctly. */
  issueKey: string;
  scope: ZacSignalScope;
  signalType: ZacSignalType;
  severity: ZacSignalSeverity;
  /** 0..1, how far short of target the reading falls, as a fraction of target. */
  materiality: number;
  /** 0..1, how much the data supports the claim. Data quality only. */
  confidence: number;
  direction: ZacSignalDirection;
  observationStatus: ZacMetricObservationStatus;
  observedValue: number | null;
  comparisonValue: number | null;
  targetValue: number | null;
  targetSource: ZacMetricTargetSource | null;
  sampleSize: number | null;
  period: string | null;
  /** One safe sentence, quotable verbatim. Redacted before any write. */
  headline: string;
  metricRefs: ZacMetricReference[];
  evidenceRefs: ZacEvidenceItem[];
  limitations: string[];
}

/**
 * A candidate an evaluator deliberately did NOT raise, with the reason. Kept as
 * a first-class result rather than a silent absence: "we cannot say yet" and
 * "there is nothing to say" are different answers, and only the second one is
 * allowed to resolve an existing signal.
 */
export interface ZacWithheldSignal {
  signalKey: string;
  metricKey: ZacMetricKey;
  scope: ZacSignalScope;
  reason:
    | ZacMetricObservationStatus
    | 'no_target'
    | 'below_materiality_floor'
    | 'healthy_steady';
  /** Safe explanation of why nothing was claimed. */
  note: string;
}

/**
 * One evaluator's verdict for one (metric, scope). The observation status rides
 * along because the RECONCILER cannot be safe without it: it is the difference
 * between "the rebooking gap has closed" and "the dashboard did not answer".
 */
export interface ZacSignalEvaluation {
  evaluatorKey: string;
  metricKey: ZacMetricKey;
  scope: ZacSignalScope;
  observationStatus: ZacMetricObservationStatus;
  /**
   * The reading and the target it was judged against, carried so the reconciler
   * can tell a gap that CLOSED from a target that MOVED: a remembered goal
   * appearing under an unchanged number retires the old signal as superseded,
   * never as recovered. Null when the observation carried none.
   */
  observedValue: number | null;
  target: number | null;
  candidates: ZacSignalCandidate[];
  withheld: ZacWithheldSignal[];
}

/**
 * Everything an evaluator is allowed to see. Deliberately closed and
 * deliberately clock-free: `evaluatedAt` is passed in so the same inputs always
 * produce the same output, which is what makes the acceptance fixtures possible
 * and what keeps evaluation out of reach of a model.
 */
export interface ZacSignalEvaluationInput {
  /** The tenant the reading belongs to. Part of every signal key, so an evaluator cannot mint a keyless — and therefore cross-tenant collidable — candidate. */
  businessId: string;
  observation: ZacMetricObservation;
  evaluatedAt: string;
}

/**
 * THE EVALUATOR CONTRACT.
 *
 * Pure and synchronous by construction: no I/O, no clock, no model. Materiality,
 * severity and confidence are domain arithmetic, and an LLM has no place in
 * deciding whether a business has a problem — it may narrate the conclusion,
 * never reach it.
 *
 * A later workstream registers QLAB, stock, profitability or retention by
 * implementing this interface against a new metric definition. Nothing about
 * this shape assumes rebooking or utilisation.
 */
export interface ZacSignalEvaluator {
  /** Stable identifier, part of the dedupe key. lower_snake. */
  readonly key: string;
  /** The one metric this evaluator reads. */
  readonly metricKey: ZacMetricKey;
  /** The Phase 1 issue its signals belong to. */
  readonly issueKey: string;
  evaluate(input: ZacSignalEvaluationInput): ZacSignalEvaluation;
}

/**
 * PERSISTED INTELLIGENCE SIGNAL — one row of zac.intelligence_signals.
 *
 * `visibilityScope` is a snapshot taken at write time, exactly like
 * zac.outputs. It narrows retrieval; it never authorises it. Current
 * permissions are re-evaluated on every read (see ZacIntelligenceSignalService).
 */
export interface ZacPersistedSignal {
  id: string;
  businessId: string;
  locationId: string | null;
  subjectUserId: string | null;
  signalKey: string;
  evaluatorKey: string;
  metricKey: ZacMetricKey;
  issueKey: string;
  scopeType: ZacSignalScope['type'];
  scopeLabel: string | null;
  visibilityScope: ZacMemoryScope;
  signalType: ZacSignalType;
  severity: ZacSignalSeverity;
  materiality: number;
  confidence: number;
  direction: ZacSignalDirection;
  observationStatus: ZacMetricObservationStatus;
  observedValue: number | null;
  comparisonValue: number | null;
  targetValue: number | null;
  targetSource: ZacMetricTargetSource | null;
  sampleSize: number | null;
  period: string | null;
  headline: string;
  metricRefs: ZacMetricReference[];
  evidenceRefs: ZacEvidenceItem[];
  limitations: string[];
  status: ZacSignalStatus;
  resolutionReason: ZacSignalResolutionReason | null;
  occurrenceCount: number;
  firstEvaluatedAt: string;
  lastEvaluatedAt: string;
  /** The last time POSITIVE valid evidence confirmed the condition still held. */
  lastConfirmedAt: string | null;
  resolvedAt: string | null;
  suppressedUntil: string | null;
  expiresAt: string | null;
}

/**
 * Whether a signal is about a GAP or about MOVEMENT. Part of the dedupe key,
 * because "your rebooking gap has closed" and "your rebooking improved" are two
 * different messages: the first should leave the owner's list, the second may
 * enter it. Sharing one key would make a recovery indistinguishable from a
 * relabelled problem.
 */
export type ZacSignalFamily = 'shortfall' | 'progress';

export function signalFamily(signalType: ZacSignalType): ZacSignalFamily {
  return signalType === 'progress' ? 'progress' : 'shortfall';
}

/**
 * The deterministic dedupe identity of a logical issue.
 *
 * What is IN: the tenant, the scope it is about, the evaluator that raised it,
 * the metric it is about and whether it is a gap or a movement. Two evaluations
 * a week apart of the same rebooking gap at the same location produce the same
 * key, so the second REFRESHES the first instead of stacking a duplicate on the
 * owner's list.
 *
 * What is deliberately OUT: the period, the value and the severity. Phase 1's
 * per-turn `identityKey` includes all three — correctly, because it is deduping
 * two readings inside ONE turn, where a different value really is a different
 * reading. A persisted signal spans turns and rolling windows, so including any
 * of them would mint a brand-new signal on every evaluation and the whole
 * lifecycle would be unreachable.
 *
 * `businessId` leads the key so cross-tenant collision is impossible by
 * construction, not merely by a WHERE clause.
 */
export function buildSignalKey(input: {
  businessId: string;
  evaluatorKey: string;
  metricKey: ZacMetricKey;
  scope: ZacSignalScope;
  family?: ZacSignalFamily;
}): string {
  const { scope } = input;
  return [
    input.businessId,
    input.evaluatorKey,
    input.metricKey,
    scope.type,
    scope.locationId ?? '-',
    scope.subjectUserId ?? '-',
    input.family ?? 'shortfall',
  ].join('|');
}

/**
 * The identity of what was LOOKED AT, independent of what was found.
 *
 * The reconciler needs this separately from the signal key: an active shortfall
 * whose next evaluation produced a progress candidate has no candidate under its
 * own key, and the only safe way to tell that apart from "the dashboard did not
 * answer" is to ask whether this metric-and-scope was successfully read at all.
 */
export function buildCoverageKey(input: {
  businessId: string;
  metricKey: ZacMetricKey;
  scope: Pick<ZacSignalScope, 'type' | 'locationId' | 'subjectUserId'>;
}): string {
  const { scope } = input;
  return [
    // The tenant leads here for the same reason it leads the signal key: the
    // reconciler is only ever handed one business's signals today, but a
    // coverage key that cannot express a tenant makes that a caller's promise
    // rather than the key's guarantee.
    input.businessId,
    input.metricKey,
    scope.type,
    scope.locationId ?? '-',
    scope.subjectUserId ?? '-',
  ].join('|');
}

export function isZacSignalType(candidate: unknown): candidate is ZacSignalType {
  return typeof candidate === 'string' && (ZAC_SIGNAL_TYPES as readonly string[]).includes(candidate);
}

export function isZacSignalStatus(candidate: unknown): candidate is ZacSignalStatus {
  return (
    typeof candidate === 'string' && (ZAC_SIGNAL_STATUSES as readonly string[]).includes(candidate)
  );
}
