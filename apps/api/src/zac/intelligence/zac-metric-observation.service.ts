import { Injectable } from '@nestjs/common';
import { rebookingGoalFromMemory } from '../analysis/zac-evidence.service';
import type { ZacModelMemoryItem } from '../models/zac-model-provider.interface';
import type { ZacEvidenceItem } from '../responses/zac-response.types';
import type { ZacToolResult } from '../tools/zac-tool.types';
import { CANONICAL_REBOOKING_TARGET_PERCENT, metricDefinition } from './zac-metric-registry';
import type {
  ZacMetricDefinition,
  ZacMetricKey,
  ZacMetricObservation,
  ZacMetricObservationStatus,
  ZacMetricReference,
  ZacMetricTargetSource,
  ZacSignalScope,
} from './zac-metric.types';

/**
 * Memory kinds that can state a TARGET. A goal, a stated business priority or a
 * coaching focus is someone saying what they are aiming at; a recurring problem
 * or a prior decision is someone describing what happened.
 */
const GOAL_MEMORY_KINDS = new Set(['business_goal', 'business_priority', 'coaching_focus']);

/**
 * METRIC OBSERVATION — stage two of the pipeline.
 *
 * This service READS a canonical QLOOQO payload and states what was observed.
 * It never computes a KPI: every value here is a figure the guarded QLOOQO
 * service already produced, reached through the same Phase 1 tool the rest of
 * ZAC uses, with the actor's own permissions and scope. The only arithmetic is
 * unit conversion of a denominator the payload already contains.
 *
 * Its whole job is the five-way status decision, which is the honesty layer the
 * rest of the framework rests on:
 *
 *   the tool did not answer                    -> missing
 *   the denominator is zero                    -> not_applicable
 *   the denominator is below the metric's floor -> insufficient_sample
 *   the value is a real zero                   -> zero
 *   otherwise                                  -> valid
 *
 * A tool result is read at ONE scope — whichever scope it was dispatched for.
 * Sub-slices of an aggregate payload (`by_location`, `byLocation`) are used only
 * to enrich limitations, never to mint extra observations: those rows carry no
 * denominator (rebooking) or no target (utilisation), so a signal built from
 * them could not tell a real collapse from an empty week.
 */
@Injectable()
export class ZacMetricObservationService {
  /**
   * Read one metric from one tool result at one scope. Never throws: an
   * unreadable payload is a `missing` observation, which is a fact the
   * reconciler knows how to handle safely.
   */
  observe(
    metricKey: ZacMetricKey,
    result: ZacToolResult,
    scope: ZacSignalScope,
    memory: ZacModelMemoryItem[] = [],
  ): ZacMetricObservation {
    const definition = metricDefinition(metricKey);

    if (result.status !== 'ok' || !result.data) {
      return this.unmeasured(
        definition,
        scope,
        // The utilisation tool answers `unavailable` for TWO different reasons,
        // and they are not interchangeable: no available working time to measure
        // against (a zero denominator — `not_applicable`), or the guarded service
        // threw (`missing`). It distinguishes them itself by `rowCount`: the
        // no-time branch returns the staff-day count, the catch branch returns
        // null. Collapsing the two would let a permission or infrastructure
        // failure look like an empty rota — and an empty rota is a state the
        // reconciler treats as covered.
        metricKey === 'utilisation_rate' &&
        result.status === 'unavailable' &&
        result.rowCount !== null
          ? 'not_applicable'
          : 'missing',
        result.explanation ? [result.explanation] : [],
      );
    }

    switch (metricKey) {
      case 'rebooking_rate':
        return this.observeRebooking(definition, result, scope, memory);
      case 'utilisation_rate':
        return this.observeUtilisation(definition, result, scope);
      default:
        return this.unmeasured(definition, scope, 'missing', []);
    }
  }

  // ---------------------------------------------------------------------------
  // Rebooking — `report.rebooking_summary` (DashboardService.kpis, snake_case).
  // ---------------------------------------------------------------------------

  private observeRebooking(
    definition: ZacMetricDefinition,
    result: ZacToolResult,
    scope: ZacSignalScope,
    memory: ZacModelMemoryItem[],
  ): ZacMetricObservation {
    const data = result.data as Record<string, unknown>;
    const rate = numberOrNull(data['rebooking_rate_percent']);
    const completed = numberOrNull(data['completed_bookings']);
    const evidence = result.presentation?.evidence ?? [];
    const limitations = [...(result.presentation?.limitations ?? [])];

    // A remembered goal is the most specific statement of intent available, so
    // it outranks the shipped constant — and carries its own provenance so an
    // answer can attribute it rather than present it as a QLOOQO measurement.
    //
    // The KIND filter is this layer's own, deliberately not pushed into the
    // shared Phase 1 helper: that helper decides what a LIVE answer quotes, and
    // narrowing it here would change shipped ZAC behaviour. But a persisted
    // target is a durable claim about what the business is aiming at, so
    // "rebooking was 40% last spring" — a recurring_problem or a prior_decision
    // that merely mentions rebooking and a percentage — must not become one.
    const goal = rebookingGoalFromMemory(memory.filter((item) => GOAL_MEMORY_KINDS.has(item.kind)));
    const target = goal ?? CANONICAL_REBOOKING_TARGET_PERCENT;
    const targetSource: ZacMetricTargetSource = goal === null ? 'canonical_threshold' : 'user_stated_goal';

    const period = periodLabel(stringOrNull(data['range_start']), stringOrNull(data['range_end']));
    const refs: ZacMetricReference[] = [
      {
        metricKey: definition.key,
        sourceRef: definition.canonicalSourceRef,
        sourceTool: definition.sourceTool,
        windowStart: stringOrNull(data['range_start']),
        windowEnd: stringOrNull(data['range_end']),
      },
    ];

    // The per-location rows of this payload carry a rate and a rebooked count
    // but NO per-location denominator, so they cannot be observed on their own
    // terms. Saying so is more useful than silently aggregating over them.
    const byLocation = Array.isArray(data['by_location']) ? (data['by_location'] as unknown[]) : [];
    if (scope.type === 'business' && byLocation.length > 1) {
      limitations.push(
        `Covers ${byLocation.length} locations together; per-location rebooking is reported without its own completed-visit count, so it is not measured separately here.`,
      );
    }

    const base = {
      metricKey: definition.key,
      scope,
      comparisonValue: null,
      target,
      targetSource,
      period,
      metricRefs: refs,
      evidenceRefs: evidence,
      limitations,
    };

    // A negative denominator is not a small one — it is a corrupt reading, and
    // `not_applicable` would wrongly assert that the metric does not exist here.
    if (rate === null || completed === null || completed < 0) {
      return { ...base, status: 'missing', value: null, sampleSize: completed };
    }
    if (completed === 0) {
      return { ...base, status: 'not_applicable', value: null, sampleSize: 0 };
    }
    if (completed < definition.minimumSample) {
      return { ...base, status: 'insufficient_sample', value: rate, sampleSize: completed };
    }
    return {
      ...base,
      status: rate === 0 ? 'zero' : 'valid',
      value: rate,
      sampleSize: completed,
    };
  }

  // ---------------------------------------------------------------------------
  // Utilisation — `report.utilisation_summary` (UtilisationSummaryResponse,
  // camelCase; the tool passes the domain response through unchanged).
  // ---------------------------------------------------------------------------

  private observeUtilisation(
    definition: ZacMetricDefinition,
    result: ZacToolResult,
    scope: ZacSignalScope,
  ): ZacMetricObservation {
    const data = result.data as Record<string, unknown>;
    const overall = recordOrNull(data['overall']);
    const previous = recordOrNull(data['previousPeriod']);
    const evidence = result.presentation?.evidence ?? [];
    const limitations = [...(result.presentation?.limitations ?? [])];

    const dataQuality = stringArray(data['dataQuality']);
    for (const note of dataQuality) if (!limitations.includes(note)) limitations.push(note);

    const value = overall ? numberOrNull(overall['utilisationPercent']) : null;
    const availableMinutes = overall ? numberOrNull(overall['availableMinutes']) : null;
    // The canonical denominator is minutes; the metric's sample unit is hours,
    // so this is a unit conversion of a figure the payload already carries —
    // not a derived measurement.
    const rosteredHours =
      availableMinutes === null ? null : Math.round((availableMinutes / 60) * 10) / 10;

    // `utilisation_warning_threshold_percent` permits 0, and a 0% threshold is
    // not a threshold — every reading clears it. Read as "none configured", so
    // the evaluator withholds for `no_target` rather than minting false progress.
    const rawTarget = numberOrNull(data['warningThresholdPercent']);
    const target = rawTarget !== null && rawTarget > 0 ? rawTarget : null;
    const period = periodLabel(stringOrNull(data['rangeStart']), stringOrNull(data['rangeEnd']));

    const refs: ZacMetricReference[] = [
      {
        metricKey: definition.key,
        sourceRef: definition.canonicalSourceRef,
        sourceTool: definition.sourceTool,
        windowStart: stringOrNull(data['rangeStart']),
        windowEnd: stringOrNull(data['rangeEnd']),
      },
    ];

    const base = {
      metricKey: definition.key,
      scope,
      comparisonValue: previous ? numberOrNull(previous['utilisationPercent']) : null,
      target,
      targetSource: target === null ? null : ('location_setting' as ZacMetricTargetSource),
      period,
      metricRefs: refs,
      evidenceRefs: evidence,
      limitations,
    };

    // `utilisationPercent: null` means no available working time — the
    // canonical response documents it exactly that way, so it is the zero
    // denominator, never a missing reading.
    if (value === null || availableMinutes === null || availableMinutes <= 0) {
      return { ...base, status: 'not_applicable', value: null, sampleSize: 0 };
    }
    if (rosteredHours !== null && rosteredHours < definition.minimumSample) {
      return { ...base, status: 'insufficient_sample', value, sampleSize: rosteredHours };
    }
    return {
      ...base,
      status: value === 0 ? 'zero' : 'valid',
      value,
      sampleSize: rosteredHours,
    };
  }

  // ---------------------------------------------------------------------------

  /** An observation that carries no number, for the reasons the status names. */
  private unmeasured(
    definition: ZacMetricDefinition,
    scope: ZacSignalScope,
    status: Extract<ZacMetricObservationStatus, 'missing' | 'not_applicable'>,
    limitations: string[],
  ): ZacMetricObservation {
    return {
      metricKey: definition.key,
      scope,
      status,
      value: null,
      comparisonValue: null,
      sampleSize: null,
      target: null,
      targetSource: null,
      period: null,
      metricRefs: [],
      evidenceRefs: [] as ZacEvidenceItem[],
      limitations,
    };
  }
}

/**
 * The identity component Phase 1's consolidation compares on. Formatted from
 * date parts only: two readings of the same window taken minutes apart are the
 * same reading, and a full ISO instant would make them different.
 */
function periodLabel(start: string | null, end: string | null): string | null {
  if (!start && !end) return null;
  return `${start?.slice(0, 10) ?? '?'}..${end?.slice(0, 10) ?? '?'}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}
