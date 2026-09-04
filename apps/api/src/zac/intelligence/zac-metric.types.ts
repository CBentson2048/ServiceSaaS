import type { Permission } from '@sheer/domain';
import type { ZacEvidenceItem } from '../responses/zac-response.types';
import type { ZacToolName } from '../tools/zac-tool.types';

/**
 * CANONICAL METRIC DEFINITION — the first stage of the Phase 2 pipeline.
 *
 * A metric definition does not compute anything. It NAMES the QLOOQO
 * implementation that already computes the figure, states what a trustworthy
 * reading of it looks like, and records where its target legitimately comes
 * from. That separation is the whole point: ZAC recreating a KPI formula is how
 * two numbers for the same thing end up on one screen, so the registry is
 * deliberately a pointer table, not a calculator.
 *
 * Everything a later workstream needs to add QLAB, stock, profitability or
 * retention is a new entry here plus an evaluator — no changes to the
 * observation, evaluation, reconciliation or persistence layers.
 */

/** The closed set of metrics ZAC can currently observe. Proven implementations only. */
export type ZacMetricKey = 'rebooking_rate' | 'utilisation_rate';

export const ZAC_METRIC_KEYS: readonly ZacMetricKey[] = ['rebooking_rate', 'utilisation_rate'];

/**
 * Which way a healthy reading points. Every metric registered today is
 * higher-is-better; the field exists so a cost/waste metric added later cannot
 * be mis-scored by a shortfall formula that assumed a direction.
 */
export type ZacMetricPolarity = 'higher_is_better' | 'lower_is_better';

/** The unit a value is expressed in — decides how a gap may be phrased. */
export type ZacMetricUnit = 'percent';

/**
 * Where a target legitimately came from. Provenance is never lost, because a
 * remembered goal and a configured threshold are different kinds of fact and
 * must be attributed differently in any answer that quotes them.
 */
export type ZacMetricTargetSource =
  /** A value an owner configured, e.g. core.location_settings. */
  | 'location_setting'
  /** A QLOOQO constant shipped with the KPI engine (e.g. REBOOKING_THRESHOLD_PERCENT). */
  | 'canonical_threshold'
  /** A goal the user stated, surfaced from ZAC memory. Attributed, never presented as measurement. */
  | 'user_stated_goal';

export const ZAC_METRIC_TARGET_SOURCES: readonly ZacMetricTargetSource[] = [
  'location_setting',
  'canonical_threshold',
  'user_stated_goal',
];

/**
 * Target precedence, LOWEST number wins. A goal the user stated outranks a
 * configured threshold, which outranks the shipped constant: the owner's own
 * statement of what they are aiming at is the most specific fact available.
 */
export const ZAC_METRIC_TARGET_PRECEDENCE: Record<ZacMetricTargetSource, number> = {
  user_stated_goal: 0,
  location_setting: 1,
  canonical_threshold: 2,
};

/**
 * OBSERVATION SEMANTICS — the five outcomes of trying to read a metric.
 *
 * These are five different facts and the framework never collapses them:
 *
 *   valid                a real reading over a sufficient denominator
 *   zero                 a real reading that happens to be zero — measured, not absent
 *   missing              the source did not answer (unavailable, denied, failed)
 *   insufficient_sample  measured, but over too small a denominator to mean anything
 *   not_applicable       the denominator is zero, so the metric does not exist here
 *
 * The distinction between `zero` and `not_applicable` is the one the Phase 1
 * evidence service already fought for in code ("a rate over a zero denominator
 * is not a rate") and the one that decides whether an empty week looks like a
 * business collapsing. The distinction between `missing` and everything else is
 * what makes signal resolution safe: only a POSITIVE reading may retire a
 * signal.
 */
export type ZacMetricObservationStatus =
  | 'valid'
  | 'zero'
  | 'missing'
  | 'insufficient_sample'
  | 'not_applicable';

export const ZAC_METRIC_OBSERVATION_STATUSES: readonly ZacMetricObservationStatus[] = [
  'valid',
  'zero',
  'missing',
  'insufficient_sample',
  'not_applicable',
];

/**
 * True for statuses that carry positive evidence about the world — the only
 * ones the reconciler may use to RESOLVE an existing signal. `missing`,
 * `insufficient_sample` and `not_applicable` say something about the
 * measurement, not about the business, and can never retire anything.
 */
export function isPositiveEvidence(status: ZacMetricObservationStatus): boolean {
  return status === 'valid' || status === 'zero';
}

/** True when a status carries a usable number at all. */
export function hasMeasuredValue(status: ZacMetricObservationStatus): boolean {
  return status === 'valid' || status === 'zero' || status === 'insufficient_sample';
}

/** What the reading covers. `team` and `personal` are supported by the contract from day one. */
export type ZacSignalScopeType = 'business' | 'location' | 'team' | 'personal';

export const ZAC_SIGNAL_SCOPE_TYPES: readonly ZacSignalScopeType[] = [
  'business',
  'location',
  'team',
  'personal',
];

/**
 * The subject a reading is about. `locationId` is set for location and team
 * scopes; `subjectUserId` for personal scope. Both null for a business reading.
 *
 * There is no team ENTITY in this platform — no teams table, no team_id — so a
 * team scope is expressed exactly the way Phase 1 expresses it: the staff at a
 * location, keyed on `locationId`.
 */
export interface ZacSignalScope {
  type: ZacSignalScopeType;
  locationId: string | null;
  /** Display label for the scope (location name). Safe text, never PII. */
  label: string | null;
  subjectUserId: string | null;
}

/** A safe, replayable pointer to WHERE a number came from. Never a payload. */
export interface ZacMetricReference {
  metricKey: ZacMetricKey;
  /** The canonical QLOOQO implementation, e.g. 'DashboardService.kpis'. */
  sourceRef: string;
  sourceTool: ZacToolName;
  /** ISO window the reading covers, or null when the source reported none. */
  windowStart: string | null;
  windowEnd: string | null;
}

/**
 * METRIC OBSERVATION — one attempt to read one metric for one scope.
 *
 * Deliberately carries the denominator and the sample as first-class fields
 * rather than only a rate: every honesty rule in this framework (zero vs
 * missing, insufficient sample, no-false-negative on an empty denominator) is
 * decidable only when the denominator survives the trip from the tool.
 */
export interface ZacMetricObservation {
  metricKey: ZacMetricKey;
  scope: ZacSignalScope;
  status: ZacMetricObservationStatus;
  /** The measured figure in the metric's unit. Null unless the status carries one. */
  value: number | null;
  /** The same metric one period earlier, when the source reported it. */
  comparisonValue: number | null;
  /** The denominator the value was computed over, in `sampleUnit`s. Null when unknown. */
  sampleSize: number | null;
  target: number | null;
  targetSource: ZacMetricTargetSource | null;
  /** ISO period the reading covers, formatted as the Phase 1 identity component. */
  period: string | null;
  metricRefs: ZacMetricReference[];
  evidenceRefs: ZacEvidenceItem[];
  /** Honest caveats from the source (dataQuality notes, capture limitations). */
  limitations: string[];
}

/**
 * One registered metric. `sourceTool` is the load-bearing field: it names the
 * Phase 1 tool whose already-guarded, already-canonical payload this metric is
 * read from, which is both the reuse guarantee and — because it is a real
 * {@link ZacToolName} — what lets a persisted signal convert into a Phase 1
 * evidence signal without widening any Phase 1 union.
 */
export interface ZacMetricDefinition {
  key: ZacMetricKey;
  /** User-facing metric name. Quoted verbatim in headlines. */
  label: string;
  /** The Phase 1 business issue this metric speaks to (must exist in the priority engine). */
  issueKey: string;
  unit: ZacMetricUnit;
  polarity: ZacMetricPolarity;
  /** The canonical QLOOQO tool ZAC reads this metric from. ZAC never recomputes it. */
  sourceTool: ZacToolName;
  /** The canonical implementation behind that tool, for evidence attribution. */
  canonicalSourceRef: string;
  /** Re-checked against the actor's CURRENT permissions on every retrieval. */
  requiredPermissions: readonly Permission[];
  /** What one unit of sample is, e.g. 'completed visits'. Used in limitations copy. */
  sampleUnit: string;
  /**
   * The smallest denominator over which a reading of this metric is allowed to
   * drive a signal. Below it the observation is `insufficient_sample` and no
   * negative claim is ever made.
   */
  minimumSample: number;
  /**
   * Relative-shortfall bands, as a fraction of the target. Below `watch` a gap
   * is noise; at or above `attention` it is a material miss. Deterministic,
   * per-metric, and the only place a threshold judgement lives.
   */
  materialityBands: { watch: number; attention: number };
  /** What a MATERIAL shortfall of this metric means for the business. */
  materialShortfallType: 'opportunity' | 'risk';
  /** How long a signal about this metric stays credible without re-confirmation. */
  staleAfterDays: number;
}

export function isZacMetricKey(candidate: unknown): candidate is ZacMetricKey {
  return typeof candidate === 'string' && (ZAC_METRIC_KEYS as readonly string[]).includes(candidate);
}
