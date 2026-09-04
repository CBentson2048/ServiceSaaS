import { metricDefinition } from '../zac-metric-registry';
import type { ZacMetricDefinition, ZacMetricKey } from '../zac-metric.types';
import { hasMeasuredValue } from '../zac-metric.types';
import {
  computeConfidence,
  computeDirection,
  computeMateriality,
  computeSeverity,
  computeSignalType,
} from '../zac-signal-scoring';
import {
  buildSignalKey,
  signalFamily,
  type ZacSignalCandidate,
  type ZacSignalEvaluation,
  type ZacSignalEvaluationInput,
  type ZacSignalEvaluator,
  type ZacSignalType,
  type ZacWithheldSignal,
} from '../zac-signal.types';

/**
 * The shared body of the reference evaluators.
 *
 * Rebooking and utilisation ask the same question of their metric — "how far is
 * this from where it should be, and can we say so honestly?" — so they share one
 * evaluation, and everything that genuinely differs (target provenance, sample
 * floor, what a shortfall MEANS, how long a claim stays credible) is declared on
 * the metric definition rather than coded twice.
 *
 * That is also the extension point. A QLAB, stock, profitability or retention
 * evaluator shaped the same way needs a registry entry and a two-line subclass;
 * one that is NOT shaped the same way implements {@link ZacSignalEvaluator}
 * directly and never touches this file.
 *
 * WITHHOLDING is the safety argument, and every case is recorded rather than
 * returned as a silent empty array — because the reconciler has to tell "the
 * problem went away" from "we could not look":
 *
 *   missing              nothing was read, so nothing is claimed
 *   not_applicable       the denominator is zero. A rate over nothing is not a
 *                        rate, and "0% rebooking" for a week with no completed
 *                        visits is the exact false negative this framework
 *                        exists to prevent
 *   insufficient_sample  measured, but the number would swing on one client's
 *                        decision
 *   no_target            without a target there is no shortfall to be material
 *                        about, and inventing one would be inventing a KPI
 *   below_materiality_floor  a gap inside the metric's own noise band
 *   healthy_steady       at target and not moving — true, and not news
 */
export abstract class MetricShortfallEvaluator implements ZacSignalEvaluator {
  abstract readonly key: string;
  abstract readonly metricKey: ZacMetricKey;

  get issueKey(): string {
    return this.definition.issueKey;
  }

  protected get definition(): ZacMetricDefinition {
    return metricDefinition(this.metricKey);
  }

  evaluate(input: ZacSignalEvaluationInput): ZacSignalEvaluation {
    const { observation } = input;
    const definition = this.definition;
    const keyFor = (family: 'shortfall' | 'progress'): string =>
      buildSignalKey({
        businessId: input.businessId,
        evaluatorKey: this.key,
        metricKey: this.metricKey,
        scope: observation.scope,
        family,
      });
    // Withholding is always about the gap: there is no such thing as declining
    // to raise a progress signal, only declining to raise a problem.
    const signalKey = keyFor('shortfall');

    const shell = {
      evaluatorKey: this.key,
      metricKey: this.metricKey,
      scope: observation.scope,
      observationStatus: observation.status,
    };
    const withhold = (reason: ZacWithheldSignal['reason'], note: string): ZacSignalEvaluation => ({
      ...shell,
      candidates: [],
      withheld: [{ signalKey, metricKey: this.metricKey, scope: observation.scope, reason, note }],
    });

    // 1. Nothing measurable at all.
    if (!hasMeasuredValue(observation.status) || observation.value === null) {
      return withhold(
        observation.status,
        observation.status === 'not_applicable'
          ? `${definition.label} has no ${definition.sampleUnit} to measure against in this period, so there is no rate to report.`
          : `${definition.label} could not be read for this period, so nothing is claimed about it.`,
      );
    }

    // 2. Measured, but over too little to mean anything.
    if (observation.status === 'insufficient_sample') {
      return withhold(
        'insufficient_sample',
        `${definition.label} is based on ${observation.sampleSize ?? 0} ${definition.sampleUnit}, below the ${definition.minimumSample} needed for a reliable reading — reported, but not raised as a signal.`,
      );
    }

    // 3. Nothing to be short OF. A non-positive target is not a target either:
    //    `utilisation_warning_threshold_percent` permits 0, and a 0% threshold
    //    would make every reading "meet" it — minting a false progress signal and,
    //    worse, resolving the real risk signal it replaced.
    if (observation.target === null || observation.target <= 0) {
      return withhold(
        'no_target',
        `No ${definition.label.toLowerCase()} target is configured for this scope, so there is nothing to measure the reading against.`,
      );
    }

    const materiality = computeMateriality(definition, observation.value, observation.target);
    const direction = computeDirection(observation.value, observation.comparisonValue);
    const meetsTarget = materiality === 0;

    // 4. A gap inside the metric's own noise band.
    if (!meetsTarget && materiality < definition.materialityBands.watch) {
      return withhold(
        'below_materiality_floor',
        `${definition.label} is within ${Math.round(definition.materialityBands.watch * 100)}% of its ${observation.target}% target, which is inside normal movement.`,
      );
    }

    // 5. At target and going nowhere. True, and not news — announcing it would
    //    put a congratulation in a list of things to fix. Progress is claimed
    //    only where it is SUPPORTED: a measured improvement, or a reading that
    //    has actually cleared the target rather than merely landed on it.
    const clearsTarget = this.clearsTarget(definition, observation.value, observation.target);
    if (meetsTarget && direction !== 'improving' && !clearsTarget) {
      return withhold(
        'healthy_steady',
        `${definition.label} is holding at ${observation.value}% against its ${observation.target}% target.`,
      );
    }

    const severity = computeSeverity(definition, materiality);
    const signalType = computeSignalType(definition, materiality);
    const { confidence } = computeConfidence(observation, definition);

    const candidate: ZacSignalCandidate = {
      signalKey: keyFor(signalFamily(signalType)),
      evaluatorKey: this.key,
      metricKey: this.metricKey,
      issueKey: definition.issueKey,
      scope: observation.scope,
      signalType,
      severity,
      materiality,
      confidence,
      direction,
      observationStatus: observation.status,
      observedValue: observation.value,
      comparisonValue: observation.comparisonValue,
      targetValue: observation.target,
      targetSource: observation.targetSource,
      sampleSize: observation.sampleSize,
      period: observation.period,
      headline: this.headline({
        definition,
        value: observation.value,
        target: observation.target,
        comparisonValue: observation.comparisonValue,
        materiality,
        signalType,
        sampleSize: observation.sampleSize,
      }),
      metricRefs: observation.metricRefs,
      evidenceRefs: observation.evidenceRefs,
      limitations: observation.limitations,
    };

    return { ...shell, candidates: [candidate], withheld: [] };
  }

  /** True when the reading is on the healthy side of the target, not merely level with it. */
  private clearsTarget(definition: ZacMetricDefinition, value: number, target: number): boolean {
    return definition.polarity === 'higher_is_better' ? value > target : value < target;
  }

  /** True when the reading moved in the metric's healthy direction. */
  protected movedTowardTarget(
    definition: ZacMetricDefinition,
    value: number,
    comparisonValue: number,
  ): boolean {
    return definition.polarity === 'higher_is_better'
      ? value > comparisonValue
      : value < comparisonValue;
  }

  /**
   * One safe sentence, built only from figures the observation already carries.
   * No adjective that implies a cause, and no number that was not measured.
   */
  protected headline(input: {
    definition: ZacMetricDefinition;
    value: number;
    target: number;
    comparisonValue: number | null;
    materiality: number;
    signalType: ZacSignalType;
    sampleSize: number | null;
  }): string {
    const { definition, value, target, comparisonValue, materiality, signalType, sampleSize } = input;
    const over = sampleSize === null ? '' : ` across ${sampleSize} ${definition.sampleUnit}`;

    if (signalType === 'progress') {
      // "Up from" is only true when the reading actually improved. A metric that
      // cleared its target while FALLING is still progress against the target
      // and must not be narrated as a rise — the number would be real and the
      // sentence would not.
      const improved = comparisonValue !== null && this.movedTowardTarget(definition, value, comparisonValue);
      const movement = improved ? ` — up from ${comparisonValue}%` : '';
      return `${definition.label} is ${value}%, at or above its ${target}% target${movement}${over}.`;
    }

    // Polarity-aware, so a lower-is-better metric added later reports a positive
    // overshoot rather than a negative shortfall.
    const gap =
      Math.round(
        (definition.polarity === 'higher_is_better' ? target - value : value - target) * 10,
      ) / 10;
    const share = Math.round(materiality * 100);
    return `${definition.label} is ${value}% against a ${target}% target — ${gap} points short, ${share}% of the target${over}.`;
  }
}
