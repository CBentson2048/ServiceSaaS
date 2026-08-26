import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ZacRoleContext } from '../../context/zac-context.types';
import type { ZacAnalysisIntent } from '../../analysis/zac-analysis.types';

/**
 * Labels for orchestration evaluation. `not_live_data` is not an analysis
 * intent — it marks a question that must never reach the live pipeline at all,
 * and it is scored as its own outcome so an over-eager broad classifier cannot
 * hide behind good intent accuracy.
 */
export type OrchestrationLabel = ZacAnalysisIntent | 'not_live_data';

export interface OrchestrationEvalCase {
  prompt: string;
  role: ZacRoleContext;
  expectedIntent: OrchestrationLabel;
  rationale?: string;
  /** Pinned by the client acceptance criteria — must never regress. */
  mandated?: boolean;
}

export function loadOrchestrationEvalDataset(): OrchestrationEvalCase[] {
  const path = join(__dirname, 'orchestration-eval-dataset.json');
  return JSON.parse(readFileSync(path, 'utf8')) as OrchestrationEvalCase[];
}

export interface OrchestrationOutcome {
  case: OrchestrationEvalCase;
  /** null when the turn was (correctly or otherwise) not routed to live data. */
  actualIntent: ZacAnalysisIntent | null;
  /** How many tools the plan selected. 0 for a non-live turn. */
  toolsSelected: number;
  correct: boolean;
}

export interface OrchestrationMetrics {
  scored: number;
  correct: number;
  intentAccuracy: number;
  /** Broad-priority questions correctly recognised — the acceptance number. */
  businessPriorityRecall: number;
  businessPrioritySupport: number;
  /**
   * A question ONE source should answer that nevertheless gathered several.
   * Excludes intents that are multi-source by design — see MULTI_BY_DESIGN.
   */
  unnecessaryMultiToolRate: number;
  /** A broad question answered from one source or none. */
  missedMultiToolRate: number;
  /** A question that must not read live data that was routed to it anyway. */
  liveDataOnAdviceRate: number;
  averageToolsPerBroadQuery: number;
  confusion: Record<string, Record<string, number>>;
  misses: OrchestrationOutcome[];
}

/** Intents whose answer is a ranked set of priorities. Drives recall. */
const BROAD: ReadonlySet<string> = new Set(['business_priorities', 'team_priorities']);

/**
 * Intents that legitimately gather several sources. `diagnostic` belongs here:
 * it consults the named metric plus its context by design, so counting it as a
 * "narrow" question inflated the unnecessary-multi-tool rate with correct
 * behaviour — 13.7% of it, in the first production run.
 */
const MULTI_BY_DESIGN: ReadonlySet<string> = new Set([
  'business_priorities',
  'team_priorities',
  'diagnostic',
]);

/**
 * Score analysis-intent selection AND the tool-count consequences of it.
 *
 * Intent accuracy on its own is not enough: classifying a question correctly
 * and then gathering one source (or five for a one-metric question) are both
 * product failures the user would feel — as a thin answer or as needless
 * latency and cost.
 */
export function scoreOrchestration(outcomes: OrchestrationOutcome[]): OrchestrationMetrics {
  const labels = [
    'specific_metric',
    'business_health',
    'business_priorities',
    'team_priorities',
    'diagnostic',
    'comparison',
    'explanation',
    'not_live_data',
  ];
  const confusion: Record<string, Record<string, number>> = Object.fromEntries(
    labels.map((expected) => [expected, Object.fromEntries(labels.map((a) => [a, 0]))]),
  );

  let correct = 0;
  let broadSupport = 0;
  let broadCorrect = 0;
  let broadToolTotal = 0;
  let unnecessaryMultiTool = 0;
  let narrowSupport = 0;
  let missedMultiTool = 0;
  let adviceSupport = 0;
  let liveDataOnAdvice = 0;
  const misses: OrchestrationOutcome[] = [];

  for (const outcome of outcomes) {
    const expected = outcome.case.expectedIntent;
    const actual = outcome.actualIntent ?? 'not_live_data';
    confusion[expected][actual] += 1;
    if (outcome.correct) correct += 1;
    else misses.push(outcome);

    if (BROAD.has(expected)) {
      broadSupport += 1;
      if (outcome.correct) broadCorrect += 1;
      broadToolTotal += outcome.toolsSelected;
      // A broad question answered from a single source is the thin-answer
      // failure — the user asked for the picture and got one number.
      if (outcome.toolsSelected <= 1) missedMultiTool += 1;
    }
    if (!MULTI_BY_DESIGN.has(expected)) {
      narrowSupport += 1;
      if (outcome.toolsSelected > 1) unnecessaryMultiTool += 1;
    }

    if (expected === 'not_live_data') {
      adviceSupport += 1;
      if (outcome.actualIntent !== null) liveDataOnAdvice += 1;
    }
  }

  return {
    scored: outcomes.length,
    correct,
    intentAccuracy: outcomes.length === 0 ? 0 : correct / outcomes.length,
    businessPriorityRecall: broadSupport === 0 ? 0 : broadCorrect / broadSupport,
    businessPrioritySupport: broadSupport,
    unnecessaryMultiToolRate: narrowSupport === 0 ? 0 : unnecessaryMultiTool / narrowSupport,
    missedMultiToolRate: broadSupport === 0 ? 0 : missedMultiTool / broadSupport,
    liveDataOnAdviceRate: adviceSupport === 0 ? 0 : liveDataOnAdvice / adviceSupport,
    averageToolsPerBroadQuery: broadSupport === 0 ? 0 : broadToolTotal / broadSupport,
    confusion,
    misses,
  };
}

export function formatOrchestrationReport(title: string, metrics: OrchestrationMetrics): string {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const lines: string[] = [
    '',
    `  ${title} — orchestration`,
    `  scored ${metrics.scored}   intent accuracy ${pct(metrics.intentAccuracy)}`,
    `  business-priority recall           ${pct(metrics.businessPriorityRecall)} (n=${metrics.businessPrioritySupport})`,
    `  unnecessary multi-tool (narrow)    ${pct(metrics.unnecessaryMultiToolRate)}`,
    `  missed multi-tool (broad)          ${pct(metrics.missedMultiToolRate)}`,
    `  live data used on advice questions ${pct(metrics.liveDataOnAdviceRate)}`,
    `  average tools per broad query      ${metrics.averageToolsPerBroadQuery.toFixed(2)}`,
  ];
  const rows = Object.entries(metrics.confusion).filter(([, row]) =>
    Object.values(row).some((count) => count > 0),
  );
  if (rows.length > 0) {
    lines.push('  Confusion (rows = expected, cols = actual, non-empty only):');
    for (const [expected, row] of rows) {
      const cells = Object.entries(row)
        .filter(([, count]) => count > 0)
        .map(([actual, count]) => `${actual}=${count}`)
        .join('  ');
      lines.push(`    ${expected.padEnd(20)} ${cells}`);
    }
  }
  for (const miss of metrics.misses.slice(0, 8)) {
    lines.push(
      `    MISS  ${miss.case.expectedIntent} -> ${miss.actualIntent ?? 'not_live_data'}  "${miss.case.prompt}"`,
    );
  }
  return lines.join('\n');
}
