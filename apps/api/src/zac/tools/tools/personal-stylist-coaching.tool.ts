import type { AuthUser, KpiPeriod, StylistKpiResult } from '@sheer/domain';
import type { KpiService } from '../../../kpi/kpi.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Live stylist tool — supportive coaching from the acting stylist's OWN KPI
 * results via the guarded `KpiService.myKpi`, which itself refuses any actor
 * without a staff profile and reads only that profile's numbers. The contract
 * accepts NO staffProfileId argument by design — a stylist can never be pointed
 * at a colleague.
 *
 * Deliberately excluded from answers: commission and hourly-rate figures. The
 * stylist can see their own pay detail on the Performance screen; whether ZAC
 * should repeat pay figures (which would also flow into ZAC persistence later)
 * is a product decision not yet taken — so this tool talks about targets,
 * rebooking, retail and hours only.
 */
export class PersonalStylistCoachingTool implements ZacReadOnlyTool {
  readonly name = 'kpi.personal_coaching' as const;
  readonly domain = 'kpi' as const;
  readonly description =
    'Supportive coaching summary of the acting stylist own performance. Self-scope only.';
  readonly allowedRoles = ['stylist'] as const;
  readonly requiredPermissions = [] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'week', 'month'] },
    },
    additionalProperties: false,
  };
  readonly outputSchema = {
    type: 'object',
    description: 'Personal KPI coaching summary for the acting stylist only — no pay figures.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = ['commission', 'hourlyRateCents'] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'low' as const;
  readonly cachePolicy = { ttlSeconds: 300, perTenant: true } as const;
  readonly rateLimit = { perMinute: 10 } as const;
  readonly requiresStaffSelf = true;
  readonly enabled = true;

  constructor(private readonly kpi: KpiService) {}

  async execute(
    actor: AuthUser,
    _context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const period: KpiPeriod =
      input.period === 'today' || input.period === 'month' ? input.period : 'week';

    let stylist: StylistKpiResult;
    let periodEnd: string;
    try {
      const result = await this.kpi.myKpi(actor, { period });
      stylist = result.stylist;
      periodEnd = result.periodEnd;
    } catch {
      return {
        status: 'unavailable',
        data: null,
        explanation:
          'I could not read your performance numbers just now, so I have no coaching to offer yet. Please try again shortly.',
        rowCount: null,
      };
    }

    const periodLabel = period === 'today' ? 'today' : period === 'month' ? 'this month' : 'this week';
    const focus = pickFocus(stylist);
    const money = (cents: number) => formatMoney(cents, stylist.currencyCode);

    const answer = [
      `Here's how ${periodLabel} looks for you:`,
      [
        `service revenue is ${money(stylist.actualServiceRevenueCents)} against a ${money(stylist.serviceTargetCents)} target (${stylist.serviceTargetProgressPercent}%),`,
        `retail is at ${stylist.retailTargetProgressPercent}% of target,`,
        `and your rebooking rate is ${stylist.rebooking.rebookingRatePercent}%${stylist.rebookingKpiMet ? ' — on target' : ''}.`,
      ].join(' '),
      focus,
    ].join('\n\n');

    return {
      status: 'ok',
      data: {
        period,
        service_target_progress_percent: stylist.serviceTargetProgressPercent,
        retail_target_progress_percent: stylist.retailTargetProgressPercent,
        rebooking_rate_percent: stylist.rebooking.rebookingRatePercent,
        rebooking_kpi_met: stylist.rebookingKpiMet,
        retail_kpi_met: stylist.retailKpiMet,
        average_bill_kpi_met: stylist.averageBillKpiMet,
        hours_worked: stylist.hoursWorked,
      },
      explanation: 'Read from your own KPI results with your own permissions.',
      rowCount: 1,
      presentation: {
        answer,
        evidence: [
          {
            source_type: 'kpi.personal',
            source_ref: 'KpiService.myKpi',
            as_of: periodEnd,
            entities_used: [],
          },
        ],
        confidence: 'medium',
        limitations: [
          'Your own numbers only — this never includes colleagues or business-wide figures.',
          'Pay detail stays on your Performance screen; ZAC coaching talks targets and habits.',
          `Figures cover ${periodLabel}; hours worked so far: ${stylist.hoursWorked}.`,
        ],
        suggestedNextStep: stylist.rebookingKpiMet
          ? 'Ask "Is there a scheduled appointment from today to tomorrow?" to plan your next slots.'
          : 'Ask "What appointments do I have today?" — each visit is a rebooking chance.',
        responseType: 'Coaching Point',
      },
    };
  }
}

/** Deterministic, supportive focus: the first unmet KPI wins; never shaming. */
function pickFocus(stylist: StylistKpiResult): string {
  if (!stylist.rebookingKpiMet) {
    return `A good focus: rebooking. Your rate is ${stylist.rebooking.rebookingRatePercent}% — try offering the next appointment before each client leaves the chair.`;
  }
  if (!stylist.retailKpiMet) {
    return `A good focus: retail. You're at ${stylist.retailTargetProgressPercent}% of your retail target — recommending the products you already use in the chair is the easiest win.`;
  }
  if (!stylist.averageBillKpiMet) {
    return 'A good focus: average bill. Suggesting a finishing treatment or upgrade where it genuinely fits can lift it without pressure.';
  }
  return "All three of your KPIs are on target — keep doing what you're doing.";
}

function formatMoney(cents: number, currencyCode: string): string {
  const symbol = currencyCode === 'GBP' ? '£' : currencyCode === 'EUR' ? '€' : `${currencyCode} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}
