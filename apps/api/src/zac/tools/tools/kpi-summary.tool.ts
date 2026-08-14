import { userHasPermission } from '@sheer/domain';
import type { AuthUser, StylistKpiListResponse, StylistKpiResult } from '@sheer/domain';
import type { KpiService } from '../../../kpi/kpi.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

type KpiPeriodInput = 'today' | 'week' | 'month';

/**
 * Live Week 3 tool — the stylist KPI list from the guarded
 * `KpiService.stylistList` (the deterministic KPI engine; the service re-checks
 * role and location scope itself). Answer-first framing: who is below their
 * rebooking threshold, who meets all three KPIs.
 *
 * Commission figures are sensitive: stripped from data AND presentation unless
 * the actor holds `report.commission.view` — holding only
 * `report.performance.view` yields the commission-free view.
 */
export class KpiSummaryTool implements ZacReadOnlyTool {
  readonly name = 'report.kpi_summary' as const;
  readonly domain = 'report' as const;
  readonly description = 'Summarises stylist KPI figures for the accessible locations.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = [] as const;
  readonly anyOfPermissions = ['report.commission.view', 'report.performance.view'] as const;
  readonly inputSchema = {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'week', 'month'] },
    },
    additionalProperties: false,
  };
  readonly outputSchema = {
    type: 'object',
    description:
      'Stylist KPI list with data-quality notes surfaced (e.g. no_hours_worked) instead of degenerate zeros.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = ['commission'] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'low' as const;
  readonly cachePolicy = { ttlSeconds: 300, perTenant: true } as const;
  readonly rateLimit = { perMinute: 10 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = true;

  constructor(private readonly kpi: KpiService) {}

  async execute(
    actor: AuthUser,
    context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const period: KpiPeriodInput =
      input['period'] === 'today' || input['period'] === 'month'
        ? (input['period'] as KpiPeriodInput)
        : 'week';

    let list: StylistKpiListResponse;
    try {
      list = await this.kpi.stylistList(actor, {
        locationId: context.locationId ?? undefined,
        period,
      });
    } catch {
      return {
        status: 'unavailable',
        data: null,
        explanation: 'I could not read the KPI engine just now, so I have no KPI view to share.',
        rowCount: null,
      };
    }

    if (list.stylists.length === 0) {
      return {
        status: 'ok',
        data: { period_start: list.periodStart, period_end: list.periodEnd, stylists: [] },
        explanation: 'The KPI engine returned no stylists for this period.',
        rowCount: 0,
        presentation: {
          answer: `No stylist KPI data exists for this ${period} yet.`,
          evidence: [this.evidence(list)],
          confidence: 'high',
          limitations: ['KPI figures appear once stylists have rostered hours and completed visits.'],
          suggestedNextStep: 'Ask again later in the period, or try "How is my business doing?".',
          responseType: 'Explanation',
        },
      };
    }

    const showCommission = userHasPermission(actor, 'report.commission.view');
    const rows = list.stylists.map((s) => this.toRow(s, showCommission));

    const belowRebooking = list.stylists.filter((s) => !s.rebookingKpiMet);
    const threshold = list.stylists[0]?.rebooking.thresholdPercent;
    const belowText =
      belowRebooking.length === 0
        ? `every stylist is at or above the ${threshold}% rebooking threshold`
        : `below the ${threshold}% rebooking threshold: ${belowRebooking
            .map((s) => `${s.stylistName} (${s.rebooking.rebookingRatePercent}%)`)
            .join(', ')}`;

    const answer = [
      `KPI view for this ${period}: ${list.commissionReadyCount} of ${list.stylists.length} stylists meet all three KPIs.`,
      `On rebooking, ${belowText}.`,
    ].join(' ');

    return {
      status: 'ok',
      data: {
        period_start: list.periodStart,
        period_end: list.periodEnd,
        commission_ready_count: list.commissionReadyCount,
        stylists: rows,
      },
      explanation: 'Read from the deterministic KPI engine with your own permissions and scope.',
      rowCount: rows.length,
      presentation: {
        answer,
        evidence: [this.evidence(list)],
        confidence: 'medium',
        limitations: [
          'Rebooking is a lower bound — some rebookings are not captured at source yet.',
          showCommission
            ? 'Commission figures reflect the KPI gate, not payroll — pay statements are the source of truth.'
            : 'Commission figures are excluded — they need the commission permission.',
        ],
        suggestedNextStep:
          'Ask "Who is my top performer?" for the revenue side of this picture.',
        responseType: belowRebooking.length > 0 ? 'Watch Point' : 'Insight',
      },
    };
  }

  private toRow(s: StylistKpiResult, showCommission: boolean): Record<string, unknown> {
    return {
      stylist_name: s.stylistName,
      location_name: s.locationName,
      hours_worked: s.hoursWorked,
      service_target_progress_percent: s.serviceTargetProgressPercent,
      retail_target_progress_percent: s.retailTargetProgressPercent,
      rebooking_rate_percent: s.rebooking.rebookingRatePercent,
      rebooking_threshold_percent: s.rebooking.thresholdPercent,
      rebooking_met: s.rebookingKpiMet,
      retail_met: s.retailKpiMet,
      average_bill_met: s.averageBillKpiMet,
      all_kpis_met: s.allKpisMet,
      data_notes: s.notes,
      // Sensitive: only with report.commission.view.
      ...(showCommission
        ? {
            commission_tier: s.commission.tier,
            commission_rate_percent: s.commission.ratePercent,
          }
        : {}),
    };
  }

  private evidence(list: StylistKpiListResponse) {
    return {
      source_type: 'kpi.engine',
      source_ref: 'KpiService.stylistList',
      as_of: list.periodEnd,
      entities_used: [],
    };
  }
}
