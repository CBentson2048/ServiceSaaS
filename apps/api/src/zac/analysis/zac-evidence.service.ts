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
      // Workstream 1 - Expanded Intelligence.
      case 'report.appointment_summary':
        return this.fromAppointments(data, evidence, limitations);
      case 'report.service_mix':
        return this.fromServiceMix(data, evidence, limitations);
      case 'report.retail_performance':
        return this.fromRetail(data, evidence, limitations);
      case 'report.client_retention':
        return this.fromClientRetention(data, evidence, limitations);
      case 'kpi.personal_coaching':
        return this.fromPersonalCoaching(data, evidence, limitations, memory);
      // Workstream 3 - QLab & stock. WITHOUT A CASE HERE A TOOL RUNS PERFECTLY
      // AND CONTRIBUTES NOTHING: `default` returns [], so a cross-domain answer
      // would report that nothing stood out while the stock tool had just found
      // three items at zero. Silent, and indistinguishable from "all fine".
      case 'qlab.colour_analytics':
        return this.fromColourAnalytics(data, evidence, limitations);
      case 'inventory.stock_status':
        return this.fromStockStatus(data, evidence, limitations);
      case 'inventory.colour_prep_risk':
        return this.fromColourPrepRisk(data, evidence, limitations);
      case 'inventory.reorder_advisory':
        return this.fromReorderAdvisory(data, evidence, limitations);
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
   * Appointments. The cancelled share deliberately carries the SAME issueKey,
   * metric, scope and window as the business-health reading of it, so two
   * tools measuring one thing consolidate into one priority instead of two.
   *
   * No-shows are emitted only when one was actually recorded. A zero here means
   * "nobody marked one", which is not evidence that nobody failed to arrive —
   * and a confident 0% no-show signal would be exactly that false claim.
   */
  private fromAppointments(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
  ): ZacEvidenceSignal[] {
    const signals: ZacEvidenceSignal[] = [];
    const total = numberOrNull(data['total_bookings']);
    const cancelled = numberOrNull(data['cancelled_bookings']);
    const noShows = numberOrNull(data['no_show_bookings']);
    const cancellationRate = numberOrNull(data['cancellation_rate_percent']);
    const period = periodOf(data);

    if (total !== null && cancelled !== null && cancellationRate !== null && total > 0) {
      signals.push(
        this.signal({
          sourceTool: 'report.appointment_summary',
          domain: 'bookings',
          issueKey: 'cancellations',
          period,
          metric: 'Cancelled share of bookings',
          currentValue: cancellationRate,
          severity:
            cancellationRate >= 15 ? 'attention' : cancellationRate >= 8 ? 'watch' : 'positive',
          confidence: 0.8,
          evidence,
          limitations,
          headline: `${cancelled} of ${total} bookings in the period were cancelled (${cancellationRate}%).`,
        }),
      );
    }

    if (total !== null && noShows !== null && noShows > 0 && total > 0) {
      const share = Math.round((noShows / total) * 100);
      signals.push(
        this.signal({
          sourceTool: 'report.appointment_summary',
          domain: 'appointments',
          issueKey: 'no_shows',
          period,
          metric: 'Recorded no-show share',
          currentValue: share,
          // Capture is manual, so a recorded no-show count is a FLOOR.
          // Confidence reflects that, not the arithmetic.
          severity: share >= 8 ? 'attention' : share >= 4 ? 'watch' : 'positive',
          confidence: 0.55,
          evidence,
          limitations,
          headline: `${noShows} of ${total} bookings were marked as no-shows (${share}%) — a lower bound, since marking is manual.`,
        }),
      );
    }

    return signals;
  }

  /**
   * Service mix. The reading is CONCENTRATION, not revenue: how much of the
   * ranked services' revenue sits with the leader. It is scored as a watch
   * point at worst, because concentration is a resilience observation — a
   * salon can be both concentrated and perfectly healthy.
   */
  private fromServiceMix(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
  ): ZacEvidenceSignal[] {
    const share = numberOrNull(data['top_service_share_percent']);
    const rankedCount = numberOrNull(data['ranked_service_count']);
    const services = Array.isArray(data['services'])
      ? (data['services'] as Record<string, unknown>[])
      : [];
    const leader = services[0];
    // A "share" of a single ranked service is always 100% and says nothing.
    if (share === null || !leader || rankedCount === null || rankedCount < 2) return [];

    const leaderName = stringOrNull(leader['service_name']) ?? 'your leading service';
    return [
      this.signal({
        sourceTool: 'report.service_mix',
        domain: 'services',
        issueKey: 'service_concentration',
        period: periodOf(data),
        metric: 'Leading service share of ranked revenue',
        currentValue: share,
        severity: share >= 50 ? 'watch' : 'positive',
        confidence: 0.7,
        evidence,
        limitations,
        headline: `${leaderName} is ${share}% of the revenue across your top ${rankedCount} services.`,
      }),
    ];
  }

  /**
   * Retail. Two readings at most: the money taken, and how often a product
   * left with a paying client. Attachment is the one worth acting on, so it is
   * the one that can become a watch point; the total is context.
   *
   * Nothing here scores MARGIN. It is reported to the user with its coverage
   * attached, but a partially-covered margin is not a comparable business
   * reading and must not compete for a priority slot against a fully measured
   * one.
   */
  private fromRetail(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
  ): ZacEvidenceSignal[] {
    const signals: ZacEvidenceSignal[] = [];
    const totalCents = numberOrNull(data['total_amount_cents']);
    const saleCount = numberOrNull(data['sale_count']);
    const attachRate = numberOrNull(data['attach_rate_percent']);
    const period = periodOf(data);
    const currency = stringOrNull(data['currency_code']);

    if (totalCents !== null && saleCount !== null && saleCount > 0) {
      signals.push(
        this.signal({
          sourceTool: 'report.retail_performance',
          domain: 'retail',
          issueKey: 'retail_performance',
          period,
          metric: 'Retail revenue in the reporting period',
          currentValue: formatMoney(totalCents, currency),
          severity: 'positive',
          confidence: 0.85,
          evidence,
          limitations,
          headline: `Retail took ${formatMoney(totalCents, currency)} from ${saleCount} sales in the period.`,
        }),
      );
    }

    // Reported per 100 paid visits by the tool. There is no configured retail
    // target in QLOOQO, so a low rate is a watch point and never an alarm.
    if (attachRate !== null) {
      signals.push(
        this.signal({
          sourceTool: 'report.retail_performance',
          domain: 'retail',
          issueKey: 'retail_attachment',
          period,
          metric: 'Retail sales per 100 paid visits',
          currentValue: attachRate,
          severity: attachRate < 10 ? 'watch' : 'positive',
          confidence: 0.7,
          evidence,
          limitations,
          headline: `Retail attaches to roughly ${attachRate} of every 100 paid visits.`,
        }),
      );
    }

    return signals;
  }

  /**
   * Client retention. Shares the `client_retention` issue with the
   * business-health repeat-client reading on purpose: the two measure one
   * business concern from opposite ends (who came back, who has not), and
   * raising them as separate priorities is precisely the duplication the
   * consolidation layer exists to prevent.
   *
   * The denominator is the tool's `measurable_clients`, never the evaluated
   * total: clients ZAC could not assess are not evidence of health.
   */
  private fromClientRetention(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
  ): ZacEvidenceSignal[] {
    const measurable = numberOrNull(data['measurable_clients']);
    const atRisk = numberOrNull(data['at_risk_clients']);
    const lapsed = numberOrNull(data['lapsed_clients']);
    const atRiskShare = numberOrNull(data['at_risk_share_percent']);
    const lapsedShare = numberOrNull(data['lapsed_share_percent']);
    if (measurable === null || measurable === 0) return [];
    if (atRisk === null || lapsed === null || atRiskShare === null || lapsedShare === null) {
      return [];
    }

    // One signal, not two: "overdue" and "lapsed" are stages of one leak, and
    // the combined share is what an owner would actually act on.
    const combinedShare = atRiskShare + lapsedShare;
    return [
      this.signal({
        sourceTool: 'report.client_retention',
        domain: 'client_retention',
        issueKey: 'client_retention',
        period: null,
        metric: 'Clients overdue or lapsed',
        currentValue: combinedShare,
        severity: combinedShare >= 30 ? 'attention' : combinedShare >= 15 ? 'watch' : 'positive',
        confidence: 0.75,
        evidence,
        limitations,
        headline: `${atRisk + lapsed} of ${measurable} measurable clients are overdue or lapsed (${combinedShare}%).`,
      }),
    ];
  }

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

  /** @see rebookingGoalFromMemory — kept as a method so the adapters read the same. */
  private rebookingGoalFromMemory(memory: ZacModelMemoryItem[]): number | null {
    return rebookingGoalFromMemory(memory);
  }

  // ---------------------------------------------------------------------------
  // Workstream 3 — QLab & stock.
  //
  // EVERY ADAPTER HERE RETURNS [] RATHER THAN A SIGNAL WHEN THE FIGURE IS NULL.
  // That is deliberate and it is the most important rule in this section: the
  // WS3 tools publish `null` (never 0) for anything they could not measure, and
  // a signal built on a null would consolidate as `positive` evidence — so an
  // unmeasured colour margin would read to the priority engine as *good news*
  // and could silently resolve a real signal from another source.
  //
  // `targetValue` is left null throughout. `scoreEvidenceSignal.missesTarget()`
  // tests `currentValue < targetValue`, i.e. higher-is-better only; a
  // lower-is-better signal (waste, idle stock) given a target would silently
  // lose its materiality weight. Severity is set from the tool's own
  // probe-backed thresholds instead, which is honest about where the judgement
  // came from.
  // ---------------------------------------------------------------------------

  private fromColourAnalytics(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
  ): ZacEvidenceSignal[] {
    const marginPercent = numberOrNull(data['gross_margin_percent']);
    const formulas = numberOrNull(data['formulas_mixed']);
    // No margin means no revenue to measure it against — an unpriced Lab, not a
    // thin one. Nothing to rank.
    if (marginPercent === null || formulas === null || formulas === 0) return [];

    return [
      this.signal({
        sourceTool: 'qlab.colour_analytics',
        domain: 'colour',
        issueKey: 'colour_margin',
        period: periodOf(data),
        metric: 'Gross margin on colour work',
        currentValue: marginPercent,
        // Colour product commonly runs at a 4-6x mark-up, so a margin in the
        // teens means the charge barely clears the tube. Stated as the tool's
        // own threshold, not an owner-set target — there is no configured
        // colour-margin benchmark anywhere in QLOOQO to compare against.
        severity: marginPercent < 25 ? 'attention' : marginPercent < 50 ? 'watch' : 'positive',
        confidence: 0.7,
        evidence,
        limitations,
        headline: `Colour is running at a ${marginPercent}% gross margin across ${formulas} saved ${formulas === 1 ? 'formula' : 'formulas'}.`,
      }),
    ];
  }

  private fromStockStatus(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
  ): ZacEvidenceSignal[] {
    const signals: ZacEvidenceSignal[] = [];
    const lowCount = numberOrNull(data['low_stock_count']);
    const thresholds = numberOrNull(data['thresholds_configured']);
    const deadCount = numberOrNull(data['dead_stock_count']);
    const stockRecords = numberOrNull(data['stock_records']);

    // Zero low-stock items is only good news if thresholds exist to trip. With
    // none configured an empty list means "I cannot tell", so no signal at all.
    if (lowCount !== null && thresholds !== null && thresholds > 0) {
      signals.push(
        this.signal({
          sourceTool: 'inventory.stock_status',
          domain: 'stock',
          issueKey: 'stock_shortage',
          period: null,
          metric: 'Products at or below their low-stock threshold',
          currentValue: lowCount,
          severity: lowCount === 0 ? 'positive' : lowCount >= 3 ? 'attention' : 'watch',
          confidence: 0.85,
          evidence,
          limitations,
          headline:
            lowCount === 0
              ? `Nothing is at or below its low-stock threshold across ${thresholds} tracked ${thresholds === 1 ? 'item' : 'items'}.`
              : `${lowCount} ${lowCount === 1 ? 'product is' : 'products are'} at or below ${lowCount === 1 ? 'its' : 'their'} low-stock threshold.`,
        }),
      );
    }

    if (deadCount !== null && stockRecords !== null && stockRecords > 0 && deadCount > 0) {
      signals.push(
        this.signal({
          sourceTool: 'inventory.stock_status',
          domain: 'stock',
          issueKey: 'dead_stock',
          period: null,
          metric: 'Products idle past their dead-stock threshold',
          currentValue: deadCount,
          // Deliberately never 'attention'. On the live data every dead-stock
          // row is a function of a threshold the location itself set, so this
          // is something to look at, not something that is wrong.
          severity: 'watch',
          confidence: 0.6,
          evidence,
          limitations,
          headline: `${deadCount} of ${stockRecords} stocked ${stockRecords === 1 ? 'product has' : 'products have'} had no stock leave the shelf for longer than the threshold set for ${deadCount === 1 ? 'it' : 'them'}.`,
        }),
      );
    }

    return signals;
  }

  private fromColourPrepRisk(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
  ): ZacEvidenceSignal[] {
    const appointments = numberOrNull(data['appointments']);
    const shortfalls = numberOrNull(data['shortfall_product_count']);
    const claimable = data['sufficiency_claimable'];
    if (appointments === null || appointments === 0 || shortfalls === null) return [];

    // A clean result is only POSITIVE when the tool itself said it could see
    // the whole picture. With a formula missing or a product unmapped, "no
    // shortfall" means "none that I could check" — which must not rank as
    // reassurance.
    const severity: ZacEvidenceSignal['severity'] =
      shortfalls > 0 ? 'attention' : claimable === true ? 'positive' : 'watch';

    return [
      this.signal({
        sourceTool: 'inventory.colour_prep_risk',
        domain: 'stock',
        issueKey: 'colour_prep_shortfall',
        period: null,
        metric: 'Products short of what booked colour work needs',
        currentValue: shortfalls,
        severity,
        confidence: claimable === true ? 0.8 : 0.55,
        evidence,
        limitations,
        headline:
          shortfalls > 0
            ? `${shortfalls} ${shortfalls === 1 ? 'product will not cover' : 'products will not cover'} what the ${appointments} colour ${appointments === 1 ? 'appointment' : 'appointments'} already booked will need.`
            : `Stock covers what the ${appointments} booked colour ${appointments === 1 ? 'appointment needs' : 'appointments need'}.`,
      }),
    ];
  }

  private fromReorderAdvisory(
    data: Record<string, unknown>,
    evidence: ZacEvidenceItem[],
    limitations: string[],
  ): ZacEvidenceSignal[] {
    const lines = numberOrNull(data['suggested_line_count']);
    const unorderable = numberOrNull(data['unorderable_count']);
    if (lines === null) return [];
    // Nothing to order and nothing blocked is genuinely quiet; it carries no
    // information a priority answer would act on, so it emits nothing rather
    // than a positive signal competing for a top-3 slot.
    if (lines === 0 && (unorderable === null || unorderable === 0)) return [];

    return [
      this.signal({
        sourceTool: 'inventory.reorder_advisory',
        domain: 'stock',
        issueKey: 'stock_shortage',
        period: null,
        metric: 'Products below their reorder point',
        currentValue: lines,
        severity: lines > 0 ? 'attention' : 'watch',
        confidence: 0.75,
        evidence,
        limitations,
        headline:
          lines > 0
            ? `${lines} ${lines === 1 ? 'product is' : 'products are'} below the stock level your own reorder settings aim to hold.`
            : `${unorderable} ${unorderable === 1 ? 'product needs' : 'products need'} stock but cannot be ordered as set up.`,
      }),
    ];
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
    signal.priorityScore = scoreEvidenceSignal(signal);
    return signal;
  }

  /** Rank candidates for the synthesis. Deterministic and explainable. */
  rank(signals: ZacEvidenceSignal[]): ZacEvidenceSignal[] {
    return [...signals].sort((a, b) => b.priorityScore - a.priorityScore);
  }
}

/**
 * A remembered rebooking goal, if the user stated one. Read from the already
 * scope-filtered memory the turn retrieved — this never widens what memory the
 * actor can see, and private coaching belonging to others cannot reach here
 * because it is filtered out upstream.
 *
 * Exported so the Phase 2 metric-observation layer resolves a user-stated
 * target through exactly this rule rather than a second regex that drifts from
 * it.
 */
export function rebookingGoalFromMemory(memory: ZacModelMemoryItem[]): number | null {
  for (const item of memory) {
    if (!/rebook/i.test(item.summary)) continue;
    const match = /(\d{1,3})\s?%/.exec(item.summary);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value) && value > 0 && value <= 100) return value;
  }
  return null;
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
export function scoreEvidenceSignal(signal: ZacEvidenceSignal): number {
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
