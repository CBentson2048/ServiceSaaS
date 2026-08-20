import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZacRoleContext } from '../../context/zac-context.types';
import { ZAC_REQUEST_MODES, type ZacRequestMode } from '../zac-request-mode.types';

/** One labelled routing example. */
export interface RoutingEvalCase {
  prompt: string;
  expected: ZacRequestMode;
  role: ZacRoleContext;
  /** Additional modes that are also defensible for genuinely ambiguous items. */
  acceptable?: ZacRequestMode[];
  /** One-line summary of the previous assistant answer, for follow-ups. */
  priorTurn?: string;
  /** A prompt-injection attempt. Scored by the security suite, not by accuracy. */
  injection?: boolean;
  /** Excluded from accuracy/precision/recall (injections). */
  metricsExempt?: boolean;
  /** Pinned by the client acceptance criteria — these must never regress. */
  mandated?: boolean;
  rationale?: string;
}

export function loadRoutingEvalDataset(): RoutingEvalCase[] {
  const path = join(__dirname, 'routing-eval-dataset.json');
  return JSON.parse(readFileSync(path, 'utf8')) as RoutingEvalCase[];
}

/** The modes that are allowed to reach the operational QLOOQO tool pipeline. */
const LIVE_DATA_MODE: ZacRequestMode = 'qlooqo_data';

export interface RoutingEvalOutcome {
  case: RoutingEvalCase;
  actual: ZacRequestMode | null;
  /** True when `actual` is the expected mode or one of its acceptable alternatives. */
  correct: boolean;
}

export interface RoutingEvalMetrics {
  total: number;
  scored: number;
  correct: number;
  /** Correct including a case's documented acceptable alternatives. */
  accuracy: number;
  /** Exact-label matches only — no credit for acceptable alternatives. */
  strictCorrect: number;
  strictAccuracy: number;
  perMode: Record<
    ZacRequestMode,
    { support: number; predicted: number; truePositives: number; precision: number; recall: number }
  >;
  /** rows = expected, cols = actual. `null` actual is bucketed under 'unclassified'. */
  confusion: Record<string, Record<string, number>>;
  /**
   * The dangerous direction: a request that needed NO live data was routed to
   * the live-data pipeline. This is the error that failed hosted acceptance.
   */
  liveDataFalsePositives: RoutingEvalOutcome[];
  liveDataFalsePositiveRate: number;
  /** Cases that could produce a false positive at all — the honest denominator. */
  liveDataFalsePositiveDenominator: number;
  /** A genuine live-data request routed away from the data pipeline. */
  liveDataFalseNegatives: RoutingEvalOutcome[];
  liveDataFalseNegativeRate: number;
  /** Cases that could produce a false negative at all — the honest denominator. */
  liveDataFalseNegativeDenominator: number;
  failures: RoutingEvalOutcome[];
}

/** Score a set of routing decisions. Injection cases are excluded from metrics. */
export function scoreRouting(outcomes: RoutingEvalOutcome[]): RoutingEvalMetrics {
  const scored = outcomes.filter((o) => !o.case.metricsExempt);

  const perMode = Object.fromEntries(
    ZAC_REQUEST_MODES.map((mode) => [
      mode,
      { support: 0, predicted: 0, truePositives: 0, precision: 0, recall: 0 },
    ]),
  ) as RoutingEvalMetrics['perMode'];

  const confusion: Record<string, Record<string, number>> = {};
  for (const mode of ZAC_REQUEST_MODES) {
    confusion[mode] = Object.fromEntries([
      ...ZAC_REQUEST_MODES.map((m) => [m, 0]),
      ['unclassified', 0],
    ]) as Record<string, number>;
  }

  for (const outcome of scored) {
    const expected = outcome.case.expected;
    const actual = outcome.actual;
    perMode[expected].support += 1;
    if (actual) perMode[actual].predicted += 1;
    // Credit the true positive against the EXPECTED label so an acceptable
    // alternative does not silently inflate a different mode's precision.
    if (outcome.correct && actual === expected) perMode[expected].truePositives += 1;
    confusion[expected][actual ?? 'unclassified'] += 1;
  }

  for (const mode of ZAC_REQUEST_MODES) {
    const stats = perMode[mode];
    stats.precision = stats.predicted === 0 ? 0 : stats.truePositives / stats.predicted;
    stats.recall = stats.support === 0 ? 0 : stats.truePositives / stats.support;
  }

  // A live-data false positive is only *possible* for a case that both needs no
  // live data AND has no defensible live-data reading. Cases where qlooqo_data
  // is an accepted alternative are excluded from BOTH the numerator and the
  // denominator — leaving them in the denominator would flatter the rate by
  // padding it with cases that can never contribute to it.
  const couldBeFalsePositive = scored.filter(
    (o) => o.case.expected !== LIVE_DATA_MODE && !(o.case.acceptable ?? []).includes(LIVE_DATA_MODE),
  );
  const liveDataFalsePositives = couldBeFalsePositive.filter((o) => o.actual === LIVE_DATA_MODE);

  // Symmetrically, a live-data FALSE NEGATIVE must honour `acceptable` too: a
  // case labelled qlooqo_data that also accepts general_advice is not misrouted
  // when it lands there, and must not be counted as both correct and missed.
  const couldBeFalseNegative = scored.filter(
    (o) => o.case.expected === LIVE_DATA_MODE && (o.case.acceptable ?? []).length === 0,
  );
  const liveDataFalseNegatives = couldBeFalseNegative.filter((o) => o.actual !== LIVE_DATA_MODE);

  const correct = scored.filter((o) => o.correct).length;
  const strictCorrect = scored.filter((o) => o.actual === o.case.expected).length;

  return {
    total: outcomes.length,
    scored: scored.length,
    correct,
    accuracy: scored.length === 0 ? 0 : correct / scored.length,
    strictCorrect,
    strictAccuracy: scored.length === 0 ? 0 : strictCorrect / scored.length,
    perMode,
    confusion,
    liveDataFalsePositives,
    liveDataFalsePositiveRate:
      couldBeFalsePositive.length === 0
        ? 0
        : liveDataFalsePositives.length / couldBeFalsePositive.length,
    liveDataFalsePositiveDenominator: couldBeFalsePositive.length,
    liveDataFalseNegatives,
    liveDataFalseNegativeRate:
      couldBeFalseNegative.length === 0
        ? 0
        : liveDataFalseNegatives.length / couldBeFalseNegative.length,
    liveDataFalseNegativeDenominator: couldBeFalseNegative.length,
    failures: scored.filter((o) => !o.correct),
  };
}

export function isAcceptable(evalCase: RoutingEvalCase, actual: ZacRequestMode | null): boolean {
  if (actual === null) return false;
  if (actual === evalCase.expected) return true;
  return (evalCase.acceptable ?? []).includes(actual);
}

/** Render the confusion matrix and per-mode scores as a fixed-width report. */
export function formatRoutingReport(label: string, metrics: RoutingEvalMetrics): string {
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push(`\n=== ${label} ===`);
  lines.push(
    `Scored ${metrics.scored} of ${metrics.total} prompts (${metrics.total - metrics.scored} injection cases excluded).`,
  );
  lines.push(
    `Accuracy (strict, exact label):        ${metrics.strictCorrect}/${metrics.scored} = ${pct(metrics.strictAccuracy)}`,
  );
  lines.push(
    `Accuracy (incl. documented alternatives): ${metrics.correct}/${metrics.scored} = ${pct(metrics.accuracy)}`,
  );
  lines.push(
    `Live-data FALSE POSITIVES (no data needed → routed to data): ${metrics.liveDataFalsePositives.length}/${metrics.liveDataFalsePositiveDenominator} (${pct(metrics.liveDataFalsePositiveRate)})`,
  );
  lines.push(
    `Live-data FALSE NEGATIVES (data needed → routed away):       ${metrics.liveDataFalseNegatives.length}/${metrics.liveDataFalseNegativeDenominator} (${pct(metrics.liveDataFalseNegativeRate)})`,
  );

  lines.push('\nPer-mode:');
  lines.push(`  ${'mode'.padEnd(23)}${'n'.padStart(5)}${'precision'.padStart(12)}${'recall'.padStart(10)}`);
  for (const mode of ZAC_REQUEST_MODES) {
    const stats = metrics.perMode[mode];
    lines.push(
      `  ${mode.padEnd(23)}${String(stats.support).padStart(5)}${pct(stats.precision).padStart(12)}${pct(stats.recall).padStart(10)}`,
    );
  }

  const cols = [...ZAC_REQUEST_MODES, 'unclassified'];
  lines.push('\nConfusion matrix (rows = expected, cols = actual):');
  lines.push(`  ${''.padEnd(23)}${cols.map((c) => c.slice(0, 9).padStart(11)).join('')}`);
  for (const mode of ZAC_REQUEST_MODES) {
    lines.push(
      `  ${mode.padEnd(23)}${cols.map((c) => String(metrics.confusion[mode][c]).padStart(11)).join('')}`,
    );
  }

  if (metrics.failures.length > 0) {
    lines.push(`\nMisrouted (${metrics.failures.length}):`);
    for (const failure of metrics.failures) {
      lines.push(
        `  want ${failure.case.expected.padEnd(22)} got ${String(failure.actual ?? 'unclassified').padEnd(22)} | ${failure.case.prompt}`,
      );
    }
  }
  return lines.join('\n');
}
