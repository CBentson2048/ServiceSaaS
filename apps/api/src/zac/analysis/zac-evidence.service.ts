import { Injectable } from '@nestjs/common';
import type { ZacModelMemoryItem } from '../models/zac-model-provider.interface';
import type { ZacEvidenceItem } from '../responses/zac-response.types';
import type { ZacToolName, ZacToolResult } from '../tools/zac-tool.types';
import type { ZacEvidenceSignal } from './zac-analysis.types';

/**
 * Turns heterogeneous tool payloads into comparable, source-attributed signals.
 *
 * Why normalise at all: a broad question needs several sources weighed against
 * each other, and raw tool payloads are not comparable — one reports pennies,
 * another a percentage against a configured threshold, another a per-stylist
 * list. Handing all of that to a model and asking it to prioritise invites
 * invented arithmetic. Instead the server extracts what each tool actually
 * measured, attaches the threshold that tool already knows about, and scores
 * it deterministically.
 *
 * Two rules hold throughout:
 *  - No metric is invented. Every `currentValue` is a figure the tool reported.
 *    The only derivations are subtractions between two values that are both
 *    already present (a gap to a threshold).
 *  - Provenance never blurs. A target from tool configuration and a target the
 *    user stated from memory carry different `targetSource` values, so the
 *    synthesis can attribute them differently — a remembered goal is never
 *    presented as a QLOOQO measurement.
 */
@Injectable()
export class ZacEvidenceService {
  /** Normalise one tool result. Returns [] for anything without usable data. */
  normalise(
    toolName: ZacToolName,
    result: ZacToolResult,
    memory: ZacModelMemoryItem[] = [],
  ): ZacEvidenceSignal[] {
    if (result.status !== 'ok' || !result.data) return [];
    const evidence = result.presentation?.evidence ?? [];
    const limitations = result.presentation?.limitations ?? [];
    const data = result.data;

    switch (toolName) {
      case 'report.business_health':
        return this.fromBusinessHealth(data, evidence, limitations, memory);
      case 'report.rebooking_summary':
        return this.fromRebooking(data, evidence, limitations, memory);
      case 'report.utilisation_summary':
        return this.fromUtilisation(data, evidence, limitations);
      case 'report.kpi_summary':
        return this.fromKpi(data, evidence, limitations);
      case 'report.stylist_performance':
        return this.fromStylistPerformance(data, evidence, limitations);
      case 'kpi.personal_coaching':
        return this.fromPersonalCoaching(data, evidence, limitations, memory);
      default:
        return [];
    }
  }

  // ---------------------------------------------------------------------------
  // Adapters. Each reads only keys the tool documents, and states a headline
  // the synthesis may quote verbatim.
  // ---------------------------------------------------------------------------

  private fromBusinessHealth(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
    memory: ZacModelMemoryItem[],
  ): ZacEvidenceSignal[] {
    const signals: ZacEvidenceSignal[] = [];
    const bookings = numberOrNull(data['total_bookings']);
    const completed = numberOrNull(data['completed_bookings']);
    const cancelled = numberOrNull(data['cancelled_bookings']);
    const revenueCents = numberOrNull(data['total_revenue_cents']);
    const rebooking = numberOrNull(data['rebooking_rate_percent']);
    const newClients = numberOrNull(data['new_clients']);
    const repeatClients = numberOrNull(data['repeat_clients']);

    if (revenueCents !== null) {
      signals.push(
        this.signal({
          sourceTool: 'report.business_health',
          domain: 'revenue',
          issueKey: 'revenue',
          period: periodOf(data),
          metric: 'Revenue in the reporting period',
          currentValue: formatMoney(revenueCents, stringOrNull(data['currency_code'])),
          severity: 'positive',
          confidence: 0.9,
          evidence,
          limitations,
          headline: `Revenue for the period is ${formatMoney(revenueCents, stringOrNull(data['currency_code']))} across ${bookings ?? 0} bookings.`,
        }),
      );
    }

    // A rate over a zero denominator is not a rate. The dashboard reports
    // `completedBookings > 0 ? round(...) : 0`, so an empty period arrives here
    // as a flat 0% — indistinguishable from a real collapse in rebooking, and
    // far more alarming. Nothing was measured, so nothing is claimed.
    if (rebooking !== null && (completed === null || completed > 0)) {
      signals.push(
        this.rebookingSignal(
          'report.business_health',
          rebooking,
          evidence,
          limitations,
          memory,
          periodOf(data),
        ),
      );
    }

    // A cancellation share is a subtraction between two reported counts —
    // deterministic, and only stated when both are present.
    if (bookings !== null && cancelled !== null && bookings > 0) {
      const share = Math.round((cancelled / bookings) * 100);
      signals.push(
        this.signal({
          sourceTool: 'report.business_health',
          domain: 'bookings',
          issueKey: 'cancellations',
          period: periodOf(data),
          metric: 'Cancelled share of bookings',
          currentValue: share,
          severity: share >= 15 ? 'attention' : share >= 8 ? 'watch' : 'positive',
          confidence: 0.75,
          evidence,
          limitations,
          headline: `${cancelled} of ${bookings} bookings in the period were cancelled (${share}%).`,
        }),
      );
    }

    if (newClients !== null && repeatClients !== null && newClients + repeatClients > 0) {
      const repeatShare = Math.round((repeatClients / (newClients + repeatClients)) * 100);
      signals.push(
        this.signal({
          sourceTool: 'report.business_health',
          domain: 'bookings',
          issueKey: 'client_retention',
          period: periodOf(data),
          metric: 'Repeat-client share',
          currentValue: repeatShare,
          severity: repeatShare < 50 ? 'watch' : 'positive',
          confidence: 0.7,
          evidence,
          limitations,
          headline: `${repeatClients} repeat clients against ${newClients} new clients (${repeatShare}% repeat).`,
        }),
      );
    }

    void completed;
    return signals;
  }

  private fromRebooking(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
    memory: ZacModelMemoryItem[],
  ): ZacEvidenceSignal[] {
    const rate = numberOrNull(data['rebooking_rate_percent']);
    if (rate === null) return [];
    const completed = numberOrNull(data['completed_bookings']);
    if (completed !== null && completed === 0) {
      // Measurable only when something was completed to rebook FROM.
      return [];
    }
    return [
      this.rebookingSignal(
        'report.rebooking_summary',
        rate,
        evidence,
        limitations,
        memory,
        periodOf(data),
      ),
    ];
  }

  private fromUtilisation(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
  ): ZacEvidenceSignal[] {
    const overall = data['overall'] as Record<string, unknown> | undefined;
    const previous = data['previousPeriod'] as Record<string, unknown> | undefined;
    const current = overall ? numberOrNull(overall['utilisationPercent']) : null;
    if (current === null) return [];

    const priorValue = previous ? numberOrNull(previous['utilisationPercent']) : null;
    const threshold = numberOrNull(data['warningThresholdPercent']);
    const quietest = stringOrNull(data['quietestWeekday']);
    const dataQuality = Array.isArray(data['dataQuality'])
      ? (data['dataQuality'] as unknown[]).filter((note): note is string => typeof note === 'string')
      : [];

    const belowThreshold = threshold !== null && current < threshold;
    return [
      this.signal({
        sourceTool: 'report.utilisation_summary',
        domain: 'utilisation',
        issueKey: 'utilisation',
        metric: 'Utilisation of rostered hours',
        currentValue: current,
        comparisonValue: priorValue,
        targetValue: threshold,
        targetSource: threshold === null ? null : 'tool_threshold',
        direction: trend(current, priorValue),
        severity: belowThreshold ? 'attention' : current < 70 ? 'watch' : 'positive',
        confidence: dataQuality.length > 0 ? 0.6 : 0.85,
        evidence,
        limitations: [...limitations, ...dataQuality],
        headline: belowThreshold
          ? `Utilisation is ${current}%, below the ${threshold}% warning threshold${quietest ? `, and ${quietest} is the quietest day` : ''}.`
          : `Utilisation is ${current}%${quietest ? `, with ${quietest} the quietest day` : ''}.`,
      }),
    ];
  }

  private fromKpi(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
  ): ZacEvidenceSignal[] {
    const stylists = Array.isArray(data['stylists'])
      ? (data['stylists'] as Record<string, unknown>[])
      : [];
    if (stylists.length === 0) return [];

    const belowRebooking = stylists.filter((row) => row['rebooking_met'] === false);
    const allMet = stylists.filter((row) => row['all_kpis_met'] === true);
    const threshold = numberOrNull(stylists[0]?.['rebooking_threshold_percent'] ?? null);

    const signals: ZacEvidenceSignal[] = [];
    if (belowRebooking.length > 0) {
      signals.push(
        this.signal({
          sourceTool: 'report.kpi_summary',
          domain: 'kpi',
          // The team's view of the SAME rebooking problem — not a second one.
          issueKey: 'rebooking',
          scope: 'team',
          period: periodOf(data),
          metric: 'Stylists below their rebooking target',
          currentValue: belowRebooking.length,
          targetValue: threshold,
          targetSource: threshold === null ? null : 'tool_threshold',
          severity: belowRebooking.length >= Math.ceil(stylists.length / 2) ? 'attention' : 'watch',
          confidence: 0.85,
          evidence,
          limitations,
          headline: `${belowRebooking.length} of ${stylists.length} stylists are below the ${threshold ?? 0}% rebooking target.`,
        }),
      );
    }
    signals.push(
      this.signal({
        sourceTool: 'report.kpi_summary',
        domain: 'kpi',
        issueKey: 'team_kpi_standing',
        scope: 'team',
        period: periodOf(data),
        metric: 'Stylists meeting every KPI',
        currentValue: allMet.length,
        severity: allMet.length === stylists.length ? 'positive' : 'watch',
        confidence: 0.8,
        evidence,
        limitations,
        headline: `${allMet.length} of ${stylists.length} stylists are meeting all of their KPIs.`,
      }),
    );
    return signals;
  }

  private fromStylistPerformance(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
  ): ZacEvidenceSignal[] {
    const stylists = Array.isArray(data['stylists'])
      ? (data['stylists'] as Record<string, unknown>[])
      : [];
    if (stylists.length < 2) return [];

    const rates = stylists
      .map((row) => numberOrNull(row['rebooking_rate_percent']))
      .filter((value): value is number => value !== null);
    if (rates.length < 2) return [];

    const best = Math.max(...rates);
    const worst = Math.min(...rates);
    const spread = best - worst;
    return [
      this.signal({
        sourceTool: 'report.stylist_performance',
        domain: 'team_performance',
        // Deliberately its OWN issue: a wide spread means the team is
        // inconsistent, which is a different thing to act on from the rate
        // itself being low everywhere.
        issueKey: 'team_consistency',
        scope: 'team',
        period: periodOf(data),
        metric: 'Spread in rebooking rate across the team',
        currentValue: spread,
        severity: spread >= 25 ? 'attention' : spread >= 15 ? 'watch' : 'positive',
        confidence: 0.75,
        evidence,
        limitations,
        headline: `Rebooking ranges from ${worst}% to ${best}% across the team — a ${spread} point spread.`,
      }),
    ];
  }

  private fromPersonalCoaching(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
    memory: ZacModelMemoryItem[],
  ): ZacEvidenceSignal[] {
    const rate = numberOrNull(data['rebooking_rate_percent']);
    if (rate === null) return [];
    const completed = numberOrNull(data['completed_bookings'] ?? data['bookings']);
    if (completed !== null && completed === 0) return [];
    return [
      this.rebookingSignal('kpi.personal_coaching', rate, evidence, limitations, memory, periodOf(data)),
    ];
  }

  // ---------------------------------------------------------------------------

  /**
   * Rebooking, with a remembered goal folded in as a SEPARATE, attributed
   * target. This is the case the brief calls out: 52% live and 60% remembered
   * are two different kinds of fact, and the gap between them is a deterministic
   * subtraction — not a QLOOQO measurement.
   */
  private rebookingSignal(
    sourceTool: ZacToolName,
    rate: number,
    evidence: ZacEvidenceItem[],
    limitations: string[],
    memory: ZacModelMemoryItem[],
    period: string | null = null,
  ): ZacEvidenceSignal {
    const goal = this.rebookingGoalFromMemory(memory);
    const belowGoal = goal !== null && rate < goal;
    // Missing a goal by a point or two is worth noting, not sounding an alarm
    // about — severity should track how far short the number actually falls.
    const materiallyBelow = belowGoal && goal - rate >= Math.max(5, goal * 0.1);
    return this.signal({
      sourceTool,
      domain: 'rebooking',
      issueKey: 'rebooking',
      scope: sourceTool === 'kpi.personal_coaching' ? 'self' : 'business',
      period,
      metric: 'Rebooking rate',
      currentValue: rate,
      targetValue: goal,
      targetSource: goal === null ? null : 'user_memory_goal',
      severity: materiallyBelow ? 'attention' : belowGoal || rate < 40 ? 'watch' : 'positive',
      confidence: 0.85,
      evidence,
      limitations,
      headline: belowGoal
        ? `Rebooking is ${rate}%, against your stated goal of ${goal}% — a gap of ${Math.round(goal - rate)} points.`
        : `Rebooking is ${rate}% for the period.`,
    });
  }

  /**
   * A remembered rebooking goal, if the user stated one. Read from the already
   * scope-filtered memory the turn retrieved — this never widens what memory
   * the actor can see, and private coaching belonging to others cannot reach
   * here because it is filtered out upstream.
   */
  private rebookingGoalFromMemory(memory: ZacModelMemoryItem[]): number | null {
    for (const item of memory) {
      if (!/rebook/i.test(item.summary)) continue;
      const match = /(\d{1,3})\s?%/.exec(item.summary);
      if (!match) continue;
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value <= 100) return value;
    }
    return null;
  }

  private signal(input: {
    sourceTool: ZacToolName;
    domain: ZacEvidenceSignal['domain'];
    issueKey: string;
    scope?: string;
    period?: string | null;
    metric: string;
    currentValue: number | string | null;
    comparisonValue?: number | string | null;
    targetValue?: number | string | null;
    targetSource?: ZacEvidenceSignal['targetSource'];
    direction?: ZacEvidenceSignal['direction'];
    severity: ZacEvidenceSignal['severity'];
    confidence: number;
    evidence: ZacEvidenceItem[];
    limitations: string[];
    headline: string;
  }): ZacEvidenceSignal {
    const signal: ZacEvidenceSignal = {
      sourceTool: input.sourceTool,
      domain: input.domain,
      issueKey: input.issueKey,
      scope: input.scope ?? 'business',
      period: input.period ?? null,
      metric: input.metric,
      currentValue: input.currentValue,
      comparisonValue: input.comparisonValue ?? null,
      targetValue: input.targetValue ?? null,
      targetSource: input.targetSource ?? null,
      direction: input.direction ?? 'unknown',
      severity: input.severity,
      confidence: input.confidence,
      evidenceRefs: input.evidence,
      limitations: input.limitations,
      priorityScore: 0,
      headline: input.headline,
    };
    signal.priorityScore = scoreSignal(signal);
    return signal;
  }

  /** Rank candidates for the synthesis. Deterministic and explainable. */
  rank(signals: ZacEvidenceSignal[]): ZacEvidenceSignal[] {
    return [...signals].sort((a, b) => b.priorityScore - a.priorityScore);
  }
}

/**
 * The ranking aid — deliberately simple, and deliberately not a business
 * scoring engine.
 *
 *   severity    how far outside acceptable this reading is
 *   confidence  how much the underlying data supports saying so
 *   materiality whether a threshold or stated goal is actually being missed
 *
 * It orders CANDIDATES. The synthesis still chooses and explains, and may only
 * choose from signals that exist.
 */
function scoreSignal(signal: ZacEvidenceSignal): number {
  const severityWeight = signal.severity === 'attention' ? 1 : signal.severity === 'watch' ? 0.55 : 0.15;
  const materialityWeight = missesTarget(signal) ? 1.3 : 1;
  const directionWeight = signal.direction === 'declining' ? 1.15 : 1;
  return Number(
    (severityWeight * signal.confidence * materialityWeight * directionWeight).toFixed(4),
  );
}

function missesTarget(signal: ZacEvidenceSignal): boolean {
  if (typeof signal.currentValue !== 'number' || typeof signal.targetValue !== 'number') {
    return false;
  }
  return signal.currentValue < signal.targetValue;
}

function trend(current: number, previous: number | null): ZacEvidenceSignal['direction'] {
  if (previous === null) return 'unknown';
  if (current > previous + 2) return 'improving';
  if (current < previous - 2) return 'declining';
  return 'stable';
}

/**
 * The period a tool result covers, as a stable identity component. Two tools
 * reporting the same metric for the same window are the same reading.
 */
function periodOf(data: Record<string, unknown>): string | null {
  const start = stringOrNull(data['range_start'] ?? data['period_start']);
  const end = stringOrNull(data['range_end'] ?? data['period_end']);
  if (!start && !end) return null;
  return `${start ?? '?'}..${end ?? '?'}`;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function formatMoney(cents: number, currencyCode: string | null): string {
  const amount = (cents / 100).toFixed(2);
  const symbol = currencyCode === 'GBP' || currencyCode === null ? '£' : `${currencyCode} `;
  return `${symbol}${amount}`;
}
