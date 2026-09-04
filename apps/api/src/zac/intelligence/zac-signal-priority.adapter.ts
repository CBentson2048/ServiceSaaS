import { Injectable } from '@nestjs/common';
import type { ZacEvidenceSignal } from '../analysis/zac-analysis.types';
import { scoreEvidenceSignal } from '../analysis/zac-evidence.service';
import { metricDefinition } from './zac-metric-registry';
import type { ZacMetricTargetSource } from './zac-metric.types';
import type { ZacPersistedSignal, ZacSignalScopeType } from './zac-signal.types';

/**
 * PRIORITY-ENGINE ADAPTER — the last stage of the pipeline.
 *
 * Phase 2 does NOT get its own priority engine. Phase 1 already solved the hard
 * part of this problem: it dedupes identical readings, groups by BUSINESS ISSUE
 * rather than by source, scores the issue once, ranks, and caps at what the user
 * asked for — the fix for a hosted defect where one rebooking problem occupied
 * three slots and printed twice. A second engine ranking the same issues from a
 * second table would recreate that defect at a larger scale.
 *
 * So a persisted signal converts into the type Phase 1 already consumes,
 * {@link ZacEvidenceSignal}, and is handed to the existing
 * `ZacPriorityService.consolidate()`. Everything downstream — consolidation,
 * candidate scoring, ranking, selection, synthesis validation, the grounded-
 * narration guard — is untouched.
 *
 * Two design notes worth stating, because both were live risks:
 *
 *  - `ZacEvidenceSignal.sourceTool` is a CLOSED union of Phase 1 tool names.
 *    Rather than widen it (which would ripple into the model-provider contract
 *    and let a non-tool value reach a prompt), every metric definition names the
 *    canonical tool it is read from. A persisted signal therefore already knows
 *    a legitimate `ZacToolName`, and no Phase 1 type changes at all.
 *
 *  - `issueKey` is carried through unchanged, so a persisted rebooking signal
 *    and a live rebooking reading land in the SAME candidate rather than two.
 *    That is the entire reason issueKey exists, and honouring it is what makes
 *    this an adapter rather than a competing source.
 */
@Injectable()
export class ZacSignalPriorityAdapter {
  /**
   * Convert persisted signals into Phase 1 evidence signals.
   *
   * `progress` signals are converted too, and Phase 1's `selectTop` already
   * filters `severity === 'positive'` out of a priority list unless nothing else
   * is available — so good news never displaces a problem, and never has to be
   * special-cased here.
   */
  toEvidenceSignals(signals: readonly ZacPersistedSignal[]): ZacEvidenceSignal[] {
    return signals.map((signal) => this.toEvidenceSignal(signal));
  }

  private toEvidenceSignal(signal: ZacPersistedSignal): ZacEvidenceSignal {
    const definition = metricDefinition(signal.metricKey);
    const evidenceSignal: ZacEvidenceSignal = {
      // The canonical tool the metric is read from — a real ZacToolName, so the
      // Phase 1 union stays closed.
      sourceTool: definition.sourceTool,
      issueKey: signal.issueKey,
      scope: mapScope(signal.scopeType, signal.locationId),
      period: signal.period,
      domain: mapDomain(signal.metricKey),
      metric: definition.label,
      currentValue: signal.observedValue,
      comparisonValue: signal.comparisonValue,
      targetValue: signal.targetValue,
      targetSource: mapTargetSource(signal.targetSource),
      direction: signal.direction,
      severity: signal.severity,
      confidence: signal.confidence,
      evidenceRefs: signal.evidenceRefs,
      limitations: this.limitationsOf(signal),
      priorityScore: 0,
      headline: signal.headline,
    };
    // Scored with the SAME function the live evidence path uses, so a persisted
    // signal and a live reading of the same thing rank identically. A private
    // re-implementation here would drift the first time either changed.
    evidenceSignal.priorityScore = scoreEvidenceSignal(evidenceSignal);
    return evidenceSignal;
  }

  /**
   * The signal's own caveats, plus the two facts a reader of a PERSISTED signal
   * needs that a live reading does not: when it was last confirmed, and how long
   * it has been running. A signal refreshed four times is a standing problem,
   * not a bad week, and an answer that cannot say so is missing the point.
   */
  private limitationsOf(signal: ZacPersistedSignal): string[] {
    const lines = [...signal.limitations];
    if (signal.occurrenceCount > 1) {
      lines.push(
        `Seen in ${signal.occurrenceCount} evaluations since ${signal.firstEvaluatedAt.slice(0, 10)}.`,
      );
    }
    if (signal.lastConfirmedAt) {
      lines.push(`Last confirmed by a live reading on ${signal.lastConfirmedAt.slice(0, 10)}.`);
    }
    if (signal.scopeLabel) {
      lines.push(`Scope: ${signal.scopeLabel}.`);
    }
    return [...new Set(lines)];
  }
}

/**
 * Phase 1's `scope` is free-form text used for identity and for primary
 * selection (`business` outranks `team`, which outranks everything else).
 *
 * `business`, `team` and `self` map straight onto the values Phase 1 already
 * produces. A `location` scope has no Phase 1 equivalent and deliberately does
 * NOT masquerade as `business`: a single site's reading is not the business's
 * reading, and letting it claim to be would make a two-location salon's worst
 * branch look like the whole company. It ranks below `team` in primary
 * selection, which is the correct outcome — a business-wide or team-wide
 * statement of an issue leads, and the location detail supports it.
 */
function mapScope(scopeType: ZacSignalScopeType, locationId: string | null): string {
  switch (scopeType) {
    case 'business':
      return 'business';
    case 'team':
      return 'team';
    case 'personal':
      return 'self';
    default:
      // The location IDENTITY rides in the scope string, because Phase 1's
      // identityKey uses `scope` to decide whether two readings are the same
      // reading. Two sites both sitting at 44% for the same window are two
      // facts; a bare 'location' would make the second an "exact duplicate" of
      // the first — silently dropped, and treated as corroboration that raises
      // confidence. `scopeRank` only tests 'business'/'team', so the suffix
      // changes identity without changing ranking, and nothing renders it.
      return locationId ? `location:${locationId}` : 'location';
  }
}

/** Metric to the Phase 1 evidence domain. Both registered metrics have an exact one. */
function mapDomain(metricKey: ZacPersistedSignal['metricKey']): ZacEvidenceSignal['domain'] {
  return metricKey === 'rebooking_rate' ? 'rebooking' : 'utilisation';
}

/**
 * Phase 1 knows two target provenances: a threshold the tool carries, and a goal
 * the user stated. Phase 2's three collapse onto them without losing the
 * distinction that matters — a remembered goal must never be presented as a
 * QLOOQO measurement, and both configured sources are exactly that.
 */
function mapTargetSource(source: ZacMetricTargetSource | null): ZacEvidenceSignal['targetSource'] {
  if (source === null) return null;
  return source === 'user_stated_goal' ? 'user_memory_goal' : 'tool_threshold';
}
