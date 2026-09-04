import type { ZacMetricDefinition } from '../zac-metric.types';
import type { ZacMetricKey } from '../zac-metric.types';
import type { ZacSignalType } from '../zac-signal.types';
import { MetricShortfallEvaluator } from './metric-shortfall.evaluator';

/**
 * REFERENCE EVALUATOR 2 — utilisation against its configured warning threshold.
 *
 * Shares the shortfall evaluation with rebooking and differs only where the
 * domain genuinely differs, which is the second thing these two references are
 * here to show:
 *
 *  - the target is an owner-configured threshold
 *    (`core.location_settings.utilisation_warning_threshold_percent`), which
 *    QLOOQO resolves only for a single-location scope — so a business-wide
 *    reading across several locations legitimately produces NO signal rather
 *    than a signal against an averaged target nobody set;
 *  - a material shortfall is a RISK, not an opportunity: the hours were rostered
 *    and paid for, and unlike a missed rebooking they cannot be recovered later;
 *  - the shortfall is worth expressing in hours as well as points, because
 *    "12 points short" and "31 rostered hours nobody was in the chair" are the
 *    same fact and only one of them gets acted on.
 */
export class UtilisationShortfallEvaluator extends MetricShortfallEvaluator {
  readonly key = 'utilisation_shortfall';
  readonly metricKey: ZacMetricKey = 'utilisation_rate';

  protected override headline(input: {
    definition: ZacMetricDefinition;
    value: number;
    target: number;
    comparisonValue: number | null;
    materiality: number;
    signalType: ZacSignalType;
    sampleSize: number | null;
  }): string {
    if (input.signalType === 'progress' || input.sampleSize === null) {
      return super.headline(input);
    }
    // The SHORTFALL in hours — the rostered hours that would have to be booked to
    // reach the threshold. Deliberately NOT "unbooked hours", which is the much
    // larger `rostered × (100 − value)%`: naming the gap after the wrong quantity
    // would understate idle capacity while sounding more precise.
    const gapPoints = Math.round((input.target - input.value) * 10) / 10;
    const gapHours = Math.round(input.sampleSize * (gapPoints / 100) * 10) / 10;
    return `${input.definition.label} is ${input.value}% against a ${input.target}% threshold — ${gapPoints} points short, about ${gapHours} more booked hours across ${input.sampleSize} rostered hours would reach it.`;
  }
}
