import type {
  ZacMetricDefinition,
  ZacMetricObservation,
  ZacMetricTargetSource,
} from './zac-metric.types';
import { hasMeasuredValue } from './zac-metric.types';
import type { ZacSignalDirection, ZacSignalSeverity, ZacSignalType } from './zac-signal.types';

/**
 * DETERMINISTIC SCORING. No model, no randomness, no clock.
 *
 * Three axes, kept separate on purpose, because they answer three questions an
 * owner asks in sequence and a single blended score answers none of them:
 *
 *   MATERIALITY  "how big is this?"        — the gap, in the metric's own terms
 *   SEVERITY     "how bad is that?"        — which band the gap falls in
 *   CONFIDENCE   "how sure are you?"       — the DATA's quality, nothing else
 *
 * The rule that keeps them honest: confidence is computed from the observation
 * alone and never looks at the size of the gap. A catastrophic reading over a
 * thin sample must come out as a big gap we are unsure about — not as a
 * medium-sized certainty, which is what a blended score silently produces.
 */

/** Clamp to [0, 1] and round to 4dp, matching the Phase 1 scorer's precision. */
function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Number(Math.min(1, Math.max(0, value)).toFixed(4));
}

/**
 * MATERIALITY — how far the reading falls short of its target, as a fraction of
 * the target, capped at 1.
 *
 * Relative rather than absolute: a 10-point miss against a 20% target is most of
 * the target gone, while the same 10 points against 80% is a rounding error, and
 * an absolute gap cannot tell those apart. This mirrors the Phase 1 candidate
 * scorer's `shortfallOf`, which replaced a binary materiality precisely because
 * binary let a two-point miss outrank a metric at a third of its threshold.
 *
 * Zero when there is no target, when the target is not positive, or when the
 * reading is on the healthy side of it — a metric that is meeting its target has
 * no shortfall to be material about.
 */
export function computeMateriality(
  definition: ZacMetricDefinition,
  value: number | null,
  target: number | null,
): number {
  if (value === null || target === null) return 0;
  if (!Number.isFinite(value) || !Number.isFinite(target) || target <= 0) return 0;
  const gap =
    definition.polarity === 'higher_is_better' ? target - value : value - target;
  if (gap <= 0) return 0;
  return clamp01(gap / target);
}

/**
 * SEVERITY — which band the materiality falls in, using the metric's own
 * declared bands. Thresholds live on the metric definition rather than here so
 * that "what counts as bad" is a per-domain product decision, stated once, in
 * the registry, where a later workstream can set its own without editing this
 * file.
 *
 * `positive` is reserved for readings that are NOT short of target. A gap below
 * the watch band is still `watch` — it is a real gap, just not a material one —
 * which is what makes a `watch_point` signal distinguishable from `progress`.
 */
export function computeSeverity(
  definition: ZacMetricDefinition,
  materiality: number,
): ZacSignalSeverity {
  if (materiality <= 0) return 'positive';
  if (materiality >= definition.materialityBands.attention) return 'attention';
  return 'watch';
}

/**
 * The SIGNAL TYPE, decided from the shape of the gap and never from the size of
 * the number alone.
 *
 *  - No shortfall + supported improvement, or no shortfall at all → `progress`.
 *  - A material shortfall → whatever this metric's shortfall MEANS: an
 *    opportunity for rebooking (the follow-up was not asked for), a risk for
 *    utilisation (paid-for capacity already lost).
 *  - A real but sub-material shortfall → `watch_point`.
 *
 * `progress` requires positive evidence by construction: it is only reachable
 * from a materiality of zero, which is only reachable from a measured value on
 * the healthy side of a real target.
 */
export function computeSignalType(
  definition: ZacMetricDefinition,
  materiality: number,
): ZacSignalType {
  if (materiality <= 0) return 'progress';
  if (materiality >= definition.materialityBands.attention) {
    return definition.materialShortfallType;
  }
  return 'watch_point';
}

/**
 * Direction of travel. Two points either side of a two-unit dead band, matching
 * the Phase 1 evidence service's `trend` so a persisted signal and a live
 * reading never disagree about whether something is improving.
 */
export function computeDirection(
  value: number | null,
  comparisonValue: number | null,
): ZacSignalDirection {
  if (value === null || comparisonValue === null) return 'unknown';
  if (value > comparisonValue + 2) return 'improving';
  if (value < comparisonValue - 2) return 'declining';
  return 'stable';
}

/** How much a target's provenance is worth. A configured number beats a scraped one. */
const TARGET_PROVENANCE_FACTOR: Record<ZacMetricTargetSource, number> = {
  location_setting: 1,
  canonical_threshold: 0.95,
  // A goal read out of remembered prose is real, attributed and useful — but it
  // came from a regex over a sentence, not a settings screen.
  user_stated_goal: 0.9,
};

/** Every factor that went into a confidence score, so it can be explained. */
export interface ZacConfidenceBreakdown {
  base: number;
  sampleFactor: number;
  targetFactor: number;
  coverageFactor: number;
  confidence: number;
}

/**
 * CONFIDENCE — a product of four data-quality factors, and nothing else.
 *
 * It deliberately does NOT read materiality, severity or the signal type. The
 * temptation to nudge confidence up for a dramatic reading is exactly how a
 * scoring system starts arguing for its own conclusions.
 *
 *   base          the observation status: a measured value we can stand behind
 *                 (0.9), or a measured ZERO (0.85 — genuinely zero rates are far
 *                 more often a capture gap than a true collapse, and Phase 1's
 *                 own tools say so in their limitations).
 *   sampleFactor  how far past the minimum sample the denominator reaches,
 *                 saturating at twice the minimum. Floored at 0.6 so a
 *                 just-sufficient sample is still worth something.
 *   targetFactor  the target's provenance.
 *   coverageFactor  one tenth off per honest caveat the source reported, to
 *                 three — the source telling us its own data is patchy is
 *                 evidence about our confidence, not decoration.
 *
 * Bounded [0.2, 0.95]: never certain, never worthless.
 */
export function computeConfidence(observation: ZacMetricObservation, definition: ZacMetricDefinition): ZacConfidenceBreakdown {
  const base = observation.status === 'zero' ? 0.85 : hasMeasuredValue(observation.status) ? 0.9 : 0.5;

  const sample = observation.sampleSize;
  const saturation = Math.max(1, definition.minimumSample * 2);
  // An UNKNOWN denominator scores below the floor a known-but-minimal one gets.
  // The reverse — which is what a mid-range default produces — would rank "we do
  // not know how much this is based on" above "we know, and it is barely enough".
  const sampleFactor =
    sample === null ? 0.55 : Number(Math.min(1, Math.max(0.6, sample / saturation)).toFixed(4));

  const targetFactor =
    observation.targetSource === null ? 0.85 : TARGET_PROVENANCE_FACTOR[observation.targetSource];

  const caveats = Math.min(3, observation.limitations.length);
  const coverageFactor = Number((1 - caveats * 0.1).toFixed(4));

  const raw = base * sampleFactor * targetFactor * coverageFactor;
  const confidence = Number(Math.min(0.95, Math.max(0.2, raw)).toFixed(4));

  return { base, sampleFactor, targetFactor, coverageFactor, confidence };
}
