import { REBOOKING_THRESHOLD_PERCENT } from '../../kpi/kpi.calc';
import type { ZacMetricDefinition, ZacMetricKey } from './zac-metric.types';

/**
 * THE CANONICAL METRIC REGISTRY.
 *
 * Two metrics, and deliberately only two. A metric is registered here ONLY when
 * all four of these hold — the bar exists because a registry of confident zeros
 * is worse than an empty one:
 *
 *  1. A canonical QLOOQO implementation already computes it and ZAC already
 *     calls that implementation through a guarded Phase 1 tool.
 *  2. The reading exposes its DENOMINATOR, so "nothing happened" and "nothing
 *     was measured" are distinguishable.
 *  3. A minimum sample can be stated in the metric's own units.
 *  4. A target exists with real provenance.
 *
 * What that bar excludes, and why (these are NOT oversights):
 *  - QLAB colour analytics and stock: their tools are registered but disabled
 *    skeletons returning `not_connected`, and the Phase 1 feasibility report
 *    records that no supplier / purchase-order / lead-time / expiry entity
 *    exists and that `inventory.waste_events` is written but never read.
 *  - Profitability: `billing.location_fixed_costs` has a full CRUD path
 *    (owner-location-settings.service.ts) but no canonical profitability
 *    computation exists to point at — criterion 1 — and no target with
 *    provenance — criterion 4. Workstream 2.
 *  - Retention: only a proxy over rebooking exists; lapsed-client detection
 *    (0097) answers a different question and produces no rate.
 *  - Revenue and cancellations: proven readings, but neither has a target with
 *    provenance, so materiality would be undefined and every signal would be a
 *    watch point forever. They fail criterion 4, not criterion 1.
 *
 * Adding any of them later is an entry here plus an evaluator. Nothing else in
 * the framework changes.
 */

/**
 * Rebooking rate — the share of completed visits that produced a booked
 * follow-up. Read from `report.rebooking_summary`, which is the rebooking slice
 * of the guarded `DashboardService.kpis`.
 *
 * The denominator survives: the tool emits `completed_bookings` at the top
 * level, so a week with no completed visits is `not_applicable` rather than 0%.
 *
 * Minimum sample is 20 completed visits. That is a stated product assumption,
 * not a measured one: a rate over a handful of visits moves ±25 points on one
 * client's decision, and a coaching conversation started by that noise costs
 * more trust than the signal is worth. It lives here so it is changed in one
 * place and is visible in the acceptance fixtures.
 *
 * A material shortfall is an OPPORTUNITY: the chairs were filled and the work
 * was done — the follow-up simply was not asked for, which is recoverable
 * behaviour rather than a deteriorating condition.
 */
const REBOOKING_RATE: ZacMetricDefinition = {
  key: 'rebooking_rate',
  label: 'Rebooking rate',
  issueKey: 'rebooking',
  unit: 'percent',
  polarity: 'higher_is_better',
  sourceTool: 'report.rebooking_summary',
  canonicalSourceRef: 'DashboardService.kpis',
  requiredPermissions: ['report.dashboard.view'],
  sampleUnit: 'completed visits',
  minimumSample: 20,
  materialityBands: { watch: 0.05, attention: 0.15 },
  materialShortfallType: 'opportunity',
  staleAfterDays: 21,
};

/**
 * Utilisation — booked stylist time against rostered available hours, from the
 * guarded `UtilisationService.summary`, which runs the CANONICAL
 * `computeDailyUtilisation` from @sheer/domain (the same formula behind the web
 * calendar badge). ZAC computes nothing.
 *
 * The denominator survives as `availableMinutes`, at both the aggregate and the
 * per-location level, so rostered hours is the sample unit rather than
 * `staffDayCount` (which the canonical payload reports only for the aggregate).
 * An empty rota yields `utilisationPercent: null`, which is `not_applicable` —
 * never 0%.
 *
 * Minimum sample is 40 rostered hours — one full-time chair for a working week.
 * Below that a single absence moves the figure further than any diary problem
 * would, so a shortfall says more about the rota than about the business.
 *
 * A material shortfall is a RISK: unlike rebooking, the capacity has already
 * been paid for and the hours are gone. It is also the only registered metric
 * with an owner-configured target — `utilisation_warning_threshold_percent` —
 * which QLOOQO resolves only when exactly one location is in scope. That is why
 * a per-location utilisation signal is produced by evaluating that location in
 * focus rather than by splitting an aggregate payload: the aggregate has no
 * target to be material against.
 */
const UTILISATION_RATE: ZacMetricDefinition = {
  key: 'utilisation_rate',
  label: 'Utilisation of rostered hours',
  issueKey: 'utilisation',
  unit: 'percent',
  polarity: 'higher_is_better',
  sourceTool: 'report.utilisation_summary',
  canonicalSourceRef: 'UtilisationService.summary (computeDailyUtilisation)',
  requiredPermissions: ['report.performance.view'],
  sampleUnit: 'rostered hours',
  minimumSample: 40,
  materialityBands: { watch: 0.05, attention: 0.15 },
  materialShortfallType: 'risk',
  staleAfterDays: 14,
};

const DEFINITIONS: Record<ZacMetricKey, ZacMetricDefinition> = {
  rebooking_rate: REBOOKING_RATE,
  utilisation_rate: UTILISATION_RATE,
};

/**
 * The QLOOQO constant that decides whether a stylist's rebooking KPI is met
 * (`kpi.calc.ts`). Re-exported, never re-declared: a second 50 in this file
 * would be a second source of truth the day the engine's changes.
 */
export const CANONICAL_REBOOKING_TARGET_PERCENT = REBOOKING_THRESHOLD_PERCENT;

/** Every registered metric, in declaration order. */
export function allMetricDefinitions(): readonly ZacMetricDefinition[] {
  return [REBOOKING_RATE, UTILISATION_RATE];
}

/** One definition by key. Throws on an unregistered key — the registry is closed. */
export function metricDefinition(key: ZacMetricKey): ZacMetricDefinition {
  const definition = DEFINITIONS[key];
  if (!definition) throw new Error(`unregistered ZAC metric: ${key}`);
  return definition;
}
