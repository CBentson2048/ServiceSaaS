import type { ZacMetricKey } from '../zac-metric.types';
import { MetricShortfallEvaluator } from './metric-shortfall.evaluator';

/**
 * REFERENCE EVALUATOR 1 — rebooking against its target.
 *
 * Everything that makes rebooking rebooking lives in the metric definition: the
 * canonical source (`DashboardService.kpis` via `report.rebooking_summary`), the
 * 20-completed-visit sample floor, the target precedence that lets a remembered
 * goal outrank the shipped 50% constant, and the decision that a material
 * shortfall here is an OPPORTUNITY rather than a risk — the visit happened and
 * was paid for; only the follow-up was not asked for.
 *
 * The class therefore carries no arithmetic at all, which is the point: it
 * demonstrates that registering a new domain is declarative.
 */
export class RebookingShortfallEvaluator extends MetricShortfallEvaluator {
  readonly key = 'rebooking_shortfall';
  readonly metricKey: ZacMetricKey = 'rebooking_rate';
}
