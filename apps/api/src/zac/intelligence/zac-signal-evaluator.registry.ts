import { Injectable } from '@nestjs/common';
import { RebookingShortfallEvaluator } from './evaluators/rebooking-shortfall.evaluator';
import { UtilisationShortfallEvaluator } from './evaluators/utilisation-shortfall.evaluator';
import { metricDefinition } from './zac-metric-registry';
import type { ZacMetricKey } from './zac-metric.types';
import type {
  ZacSignalEvaluation,
  ZacSignalEvaluationInput,
  ZacSignalEvaluator,
} from './zac-signal.types';

/**
 * THE EVALUATOR REGISTRY.
 *
 * Mirrors {@link ZacToolRegistryService}: evaluators are plain objects `new`-ed
 * in the constructor rather than Nest providers, and the structural guarantees
 * are asserted at BOOT so a mis-declared evaluator can never register. A wrong
 * evaluator that fails on first use fails in front of a customer; one that fails
 * to construct fails in CI.
 *
 * Three boot invariants:
 *  - every evaluator names a metric that is actually in the canonical registry
 *    (an evaluator for a metric nobody defined would produce signals with no
 *    provenance);
 *  - its `issueKey` matches its metric's, so a signal cannot be filed under a
 *    business issue its metric does not speak to;
 *  - keys are unique, because the key is part of the dedupe identity and two
 *    evaluators sharing one would silently overwrite each other's signals.
 */
@Injectable()
export class ZacSignalEvaluatorRegistry {
  private readonly evaluators: readonly ZacSignalEvaluator[];

  constructor() {
    const evaluators: ZacSignalEvaluator[] = [
      new RebookingShortfallEvaluator(),
      new UtilisationShortfallEvaluator(),
    ];

    const seen = new Set<string>();
    for (const evaluator of evaluators) {
      if (seen.has(evaluator.key)) {
        throw new Error(`ZAC signal evaluator ${evaluator.key} is registered twice`);
      }
      seen.add(evaluator.key);

      // Throws for an unregistered metric — the registry is closed by design.
      const definition = metricDefinition(evaluator.metricKey);
      if (definition.issueKey !== evaluator.issueKey) {
        throw new Error(
          `ZAC signal evaluator ${evaluator.key} claims issue '${evaluator.issueKey}' but metric ${evaluator.metricKey} belongs to '${definition.issueKey}'`,
        );
      }
    }

    this.evaluators = evaluators;
  }

  /** Every registered evaluator, in declaration order. */
  all(): readonly ZacSignalEvaluator[] {
    return this.evaluators;
  }

  /** The evaluators that read one metric. Empty is a legitimate answer. */
  forMetric(metricKey: ZacMetricKey): ZacSignalEvaluator[] {
    return this.evaluators.filter((evaluator) => evaluator.metricKey === metricKey);
  }

  /**
   * Run every evaluator that reads this observation's metric. Deterministic in
   * evaluator declaration order; an evaluator that throws is fatal, not
   * swallowed — a broken evaluator must not silently become "no problem here",
   * which the reconciler would then read as evidence of recovery.
   */
  evaluate(input: ZacSignalEvaluationInput): ZacSignalEvaluation[] {
    return this.forMetric(input.observation.metricKey).map((evaluator) => evaluator.evaluate(input));
  }
}
