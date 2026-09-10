import type { AuthUser, DashboardKpisResponse, StylistKpiListResponse } from '@sheer/domain';
import type { DashboardService } from '../../../dashboard/dashboard.service';
import { REBOOKING_THRESHOLD_PERCENT } from '../../../kpi/kpi.calc';
import type { KpiService } from '../../../kpi/kpi.service';
import type { UtilisationService } from '../../../kpi/utilisation.service';
import type { OwnerLocationSettingsService } from '../../../owner-location-settings/owner-location-settings.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';
import { periodFromInput } from '../zac-period';

/** A month reads the business; a week is too noisy for a health view. */
const DEFAULT_RANGE_DAYS = 30;

/**
 * THE BUSINESS SCORECARD — the important KPIs in one answer, each said to be
 * on or off target.
 *
 * TWO RULES SHAPE THIS, and both push against the obvious implementation.
 *
 * 1. NO INVENTED TARGETS. A measure is judged ONLY against a target QLOOQO
 *    itself holds: the canonical rebooking threshold, the utilisation warning
 *    threshold an owner configured, or the KPI engine's own per-stylist
 *    verdict. Everything else — revenue, cancellations, client mix — is shown
 *    as CONTEXT with no verdict, because inventing "good revenue" would be
 *    ZAC's opinion wearing QLOOQO's clothes.
 *
 * 2. NO COMPOSITE SCORE. The tempting version is a single 0-100 health index,
 *    which requires deciding how much rebooking is worth against utilisation.
 *    That weighting would be invented, unexplainable ("why is it 72?"), and
 *    indefensible the first time an owner disagreed. Instead the headline is a
 *    COUNT of measures meeting their own target — a fact, not a judgement, and
 *    every part of it can be checked against the matching QLOOQO report.
 *
 * Sections degrade one at a time: a measure the actor cannot see, or whose
 * source failed, says so and the rest of the scorecard still renders. A
 * partial scorecard presented as complete is the failure worth avoiding.
 */
type MeasureStatus = 'on_target' | 'below_target' | 'no_target' | 'unavailable';

interface Measure {
  key: string;
  label: string;
  /** Rendered value, already formatted. Null when unavailable. */
  display: string | null;
  status: MeasureStatus;
  /** The target it was judged against, and where that target came from. */
  target: string | null;
  targetSource: 'canonical_threshold' | 'location_setting' | 'kpi_engine' | null;
  note: string | null;
}

export class ScorecardTool implements ZacReadOnlyTool {
  readonly name = 'report.scorecard' as const;
  readonly domain = 'report' as const;
  readonly description =
    'The important KPIs in one view, each marked on or off target against QLOOQO’s own thresholds.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  /**
   * Dashboard access is the floor — revenue, rebooking and cancellations all
   * come from it. The team and utilisation sections need more, and are
   * attempted then degraded individually rather than gating the whole answer.
   */
  readonly requiredPermissions = ['report.dashboard.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = {
    type: 'object',
    properties: { period: { type: 'object' } },
    additionalProperties: true,
  };
  readonly outputSchema = {
    type: 'object',
    description: 'Measures with value, status and the target each was judged against.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'none' as const;
  readonly cachePolicy = { ttlSeconds: 0, perTenant: true } as const;
  readonly rateLimit = { perMinute: 10 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = true;

  constructor(
    private readonly dashboard: DashboardService,
    private readonly kpi: KpiService,
    private readonly utilisation: UtilisationService,
    private readonly locationSettings: OwnerLocationSettingsService,
  ) {}

  async execute(
    actor: AuthUser,
    context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const period = periodFromInput(input, DEFAULT_RANGE_DAYS);
    const locationId = context.locationId ?? undefined;

    let kpis: DashboardKpisResponse;
    try {
      kpis = await this.dashboard.kpis(actor, {
        locationId,
        from: period.fromIso,
        to: period.toIso,
      });
    } catch {
      // Without the dashboard there is no scorecard: it supplies the trading
      // base every other measure is read beside.
      return {
        status: 'unavailable',
        data: null,
        explanation: 'I could not read your dashboard KPIs, so I cannot put a scorecard together.',
        rowCount: null,
      };
    }

    const s = kpis.summary;
    const measures: Measure[] = [];

    // ---- Trading. Context only: QLOOQO holds no revenue target. -------------
    measures.push({
      key: 'revenue',
      label: 'Revenue',
      display: `${money(s.totalRevenueCents, s.currencyCode)} from ${s.completedPaidBookings} paid bookings`,
      status: 'no_target',
      target: null,
      targetSource: null,
      note: 'No revenue target is configured in QLOOQO, so this is shown as context.',
    });

    // ---- Rebooking, against the OWNER'S benchmark where one is configured. ---
    // The location setting wins over the shipped constant — the precedence
    // ZAC_METRIC_TARGET_PRECEDENCE already defines. Judging a business against
    // 50% while the owner has typed 60% into Record settings would have ZAC
    // contradicting a number they set themselves.
    const rebookTarget = await this.rebookingTarget(actor, locationId);
    measures.push({
      key: 'rebooking_rate',
      label: 'Rebooking rate',
      display: `${s.rebookingRatePercent}%`,
      status: s.rebookingRatePercent >= rebookTarget.percent ? 'on_target' : 'below_target',
      target: `${rebookTarget.percent}%`,
      targetSource: rebookTarget.source,
      note:
        rebookTarget.source === 'canonical_threshold'
          ? 'Measured against QLOOQO’s default benchmark — I could not read a benchmark configured for this location.'
          : null,
    });

    // ---- Cancellations. Context: no threshold exists to judge against. -------
    const cancellationRate =
      s.totalBookings > 0 ? Math.round((s.cancelledBookings / s.totalBookings) * 1000) / 10 : null;
    measures.push({
      key: 'cancellation_rate',
      label: 'Cancellations',
      display:
        cancellationRate === null
          ? null
          : `${cancellationRate}% (${s.cancelledBookings} of ${s.totalBookings})`,
      status: cancellationRate === null ? 'unavailable' : 'no_target',
      target: null,
      targetSource: null,
      note:
        cancellationRate === null
          ? 'No bookings in this window, so there is no rate to show.'
          : 'No cancellation threshold is configured, so this is shown as context.',
    });

    // ---- Client mix. Context. ----------------------------------------------
    measures.push({
      key: 'client_mix',
      label: 'New vs repeat clients',
      display: `${s.newClients} new, ${s.repeatClients} repeat`,
      status: 'no_target',
      target: null,
      targetSource: null,
      note: null,
    });

    measures.push(await this.utilisationMeasure(actor, locationId, period.kind));
    measures.push(await this.teamMeasure(actor, locationId));

    // ---- The headline: a COUNT, never a composite score. --------------------
    const judged = measures.filter(
      (m) => m.status === 'on_target' || m.status === 'below_target',
    );
    const onTarget = judged.filter((m) => m.status === 'on_target');
    const behind = judged.filter((m) => m.status === 'below_target');

    const headline =
      judged.length === 0
        ? `For ${period.label} I can show your key figures, but none of them has a target configured in QLOOQO, so I cannot say whether they are on track.`
        : `For ${period.label}, ${onTarget.length} of ${judged.length} measures with a target ${judged.length === 1 ? 'is' : 'are'} on track${behind.length > 0 ? ` — ${behind.map((m) => m.label.toLowerCase()).join(' and ')} ${behind.length === 1 ? 'is' : 'are'} below target` : ''}.`;

    const lines = measures
      .filter((m) => m.display !== null || m.status === 'unavailable')
      .map((m) => {
        const mark =
          m.status === 'on_target'
            ? 'on target'
            : m.status === 'below_target'
              ? `below target (${m.target})`
              : m.status === 'unavailable'
                ? 'not available'
                : 'no target set';
        return `• **${m.label}:** ${m.display ?? '—'} — ${mark}`;
      });

    const answer = [headline, lines.join('\n'), this.footnote(measures)]
      .filter(Boolean)
      .join('\n\n');

    return {
      status: 'ok',
      data: {
        period_label: period.label,
        measures_with_target: judged.length,
        measures_on_target: onTarget.length,
        measures: measures.map((m) => ({
          key: m.key,
          status: m.status,
          target: m.target,
          target_source: m.targetSource,
        })),
        currency_code: s.currencyCode,
      },
      explanation:
        'Composed from your dashboard KPIs, the KPI engine and utilisation — each judged only against a target QLOOQO already holds.',
      rowCount: measures.length,
      presentation: {
        answer,
        evidence: [
          {
            source_type: 'report.dashboard',
            source_ref: 'DashboardService.kpis',
            as_of: kpis.rangeEnd,
            entities_used: [],
          },
        ],
        confidence: measures.some((m) => m.status === 'unavailable') ? 'medium' : 'high',
        limitations: [
          'Each measure is judged only against a target QLOOQO already holds; anything without one is shown as context, never scored.',
          'There is no single health score — that would need a weighting nobody has agreed, and it could not be checked against any QLOOQO report.',
          `Figures cover ${period.label} and the locations you can see.`,
          ...measures
            .filter((m) => m.status === 'unavailable' && m.note)
            .map((m) => m.note as string),
          ...(period.unsupportedReason ? [period.unsupportedReason] : []),
        ],
        suggestedNextStep: behind.length > 0
          ? `Ask "${behind[0].key === 'rebooking_rate' ? "How's my rebooking rate?" : 'How full is my diary?'}" to go deeper on what is behind.`
          : 'Ask about any measure above to go deeper.',
        responseType: behind.length > 0 ? 'Watch Point' : 'Insight',
      },
    };
  }

  /**
   * The rebooking benchmark, preferring what the owner configured.
   *
   * Falls back to the shipped constant when the setting cannot be read — no
   * location in focus, or an actor without `settings.location.manage`. The
   * fallback is REPORTED rather than silent, because "on target" means
   * something different depending on which number it was measured against.
   */
  private async rebookingTarget(
    actor: AuthUser,
    locationId: string | undefined,
  ): Promise<{ percent: number; source: 'location_setting' | 'canonical_threshold' }> {
    if (!locationId) {
      // A business-wide question has no single location setting to read.
      return { percent: REBOOKING_THRESHOLD_PERCENT, source: 'canonical_threshold' };
    }
    try {
      const settings = await this.locationSettings.getSettings(actor, locationId);
      const configured = settings.rebookRateBenchmarkPercent;
      if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0) {
        return { percent: configured, source: 'location_setting' };
      }
    } catch {
      // Missing permission or an unreadable row: fall back, never fail the
      // whole scorecard for one target lookup.
    }
    return { percent: REBOOKING_THRESHOLD_PERCENT, source: 'canonical_threshold' };
  }

  /** Utilisation against the owner-configured warning threshold, when one is set. */
  private async utilisationMeasure(
    actor: AuthUser,
    locationId: string | undefined,
    periodKind: string,
  ): Promise<Measure> {
    // UtilisationService takes its own period enum, not an arbitrary window.
    const period = periodKind === 'today' ? 'today' : periodKind.includes('week') ? 'week' : 'month';
    try {
      const summary = await this.utilisation.summary(actor, { period, locationId });
      // The service returns a null percentage when there is nothing to divide
      // by. Rendering that as 0% would read as "the diary is empty" rather
      // than "there were no rostered hours to measure".
      const percent = summary.overall.utilisationPercent;
      if (percent === null || summary.overall.availableMinutes === 0) {
        return {
          key: 'utilisation_rate',
          label: 'Utilisation',
          display: null,
          status: 'unavailable',
          target: null,
          targetSource: null,
          note: 'No rostered hours in this window, so utilisation cannot be measured.',
        };
      }
      const threshold = summary.warningThresholdPercent;
      return {
        key: 'utilisation_rate',
        label: 'Utilisation',
        display: `${percent}% of rostered hours booked`,
        status:
          threshold === null
            ? 'no_target'
            : percent >= threshold
              ? 'on_target'
              : 'below_target',
        target: threshold === null ? null : `${threshold}%`,
        targetSource: threshold === null ? null : 'location_setting',
        note:
          threshold === null
            ? 'No utilisation warning threshold is configured for this location.'
            : null,
      };
    } catch {
      return {
        key: 'utilisation_rate',
        label: 'Utilisation',
        display: null,
        status: 'unavailable',
        target: null,
        targetSource: null,
        note: 'Utilisation is not available to you, or its source could not be read.',
      };
    }
  }

  /** The KPI engine's OWN per-stylist verdict — never a threshold of ZAC's. */
  private async teamMeasure(
    actor: AuthUser,
    locationId: string | undefined,
  ): Promise<Measure> {
    try {
      const list: StylistKpiListResponse = await this.kpi.stylistList(actor, {
        period: 'month',
        locationId,
      });
      const total = list.stylists.length;
      if (total === 0) {
        return {
          key: 'team_kpis',
          label: 'Team on target',
          display: null,
          status: 'unavailable',
          target: null,
          targetSource: null,
          note: 'No stylist KPI data exists for this period yet.',
        };
      }
      return {
        key: 'team_kpis',
        label: 'Team on target',
        display: `${list.commissionReadyCount} of ${total} stylists meeting all KPIs`,
        status: list.commissionReadyCount === total ? 'on_target' : 'below_target',
        target: `all ${total}`,
        targetSource: 'kpi_engine',
        note: null,
      };
    } catch {
      return {
        key: 'team_kpis',
        label: 'Team on target',
        display: null,
        status: 'unavailable',
        target: null,
        targetSource: null,
        note: 'Team KPIs are not available to you, or their source could not be read.',
      };
    }
  }

  /** Name what could not be included, so a partial view never reads as complete. */
  private footnote(measures: Measure[]): string {
    const missing = measures.filter((m) => m.status === 'unavailable');
    if (missing.length === 0) return '';
    return `Not included: ${missing.map((m) => m.label.toLowerCase()).join(', ')}. This scorecard is therefore not a complete picture.`;
  }
}

function money(cents: number, currencyCode: string): string {
  const symbol = currencyCode === 'GBP' ? '£' : currencyCode === 'EUR' ? '€' : `${currencyCode} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}
