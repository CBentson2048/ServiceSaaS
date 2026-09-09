import type { AuthUser, DashboardStylistPerformanceResponse } from '@sheer/domain';
import type { DashboardService } from '../../../dashboard/dashboard.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';
import { capitalise, periodFromInput } from '../zac-period';

/** Same default window as the business-health tool: the last 7 days. */
const DEFAULT_RANGE_DAYS = 7;

/**
 * Live Week 3 tool — stylist performance from the existing guarded
 * `DashboardService.stylistPerformance` (the same reducer behind the dashboard,
 * which re-checks role and location scope itself). "Top" means revenue,
 * bookings and rebooking within the window — QLOOQO captures no client
 * ratings, and the presentation says so instead of pretending.
 *
 * Pay-adjacent fields (`hourlyRate`, `contractedHours`, `averageBillBenchmark`)
 * are NEVER included in ZAC output, whatever the actor's permissions — pay in
 * AI narration is a product decision that has not been made (Phase 1 rule:
 * strip, don't gate).
 */
export class StylistPerformanceTool implements ZacReadOnlyTool {
  readonly name = 'report.stylist_performance' as const;
  readonly domain = 'report' as const;
  readonly description = 'Summarises stylist performance across the accessible locations.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['report.performance.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  readonly outputSchema = {
    type: 'object',
    description: 'Ranked stylist performance with pay-adjacent fields always stripped.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = ['hourly_rate', 'contracted_hours', 'average_bill_benchmark'] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'low' as const;
  readonly cachePolicy = { ttlSeconds: 300, perTenant: true } as const;
  readonly rateLimit = { perMinute: 10 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = true;

  constructor(private readonly dashboard: DashboardService) {}

  async execute(
    actor: AuthUser,
    context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const period = periodFromInput(input, DEFAULT_RANGE_DAYS);
    const to = new Date(period.toIso);
    const from = new Date(period.fromIso);

    let performance: DashboardStylistPerformanceResponse;
    try {
      performance = await this.dashboard.stylistPerformance(actor, {
        locationId: context.locationId ?? undefined,
        from: from.toISOString(),
        to: to.toISOString(),
      });
    } catch {
      return {
        status: 'unavailable',
        data: null,
        explanation:
          'I could not read stylist performance just now, so I have no ranking to share.',
        rowCount: null,
      };
    }

    const stylists = performance.stylists;
    if (stylists.length === 0) {
      return {
        status: 'ok',
        data: { range_start: performance.rangeStart, range_end: performance.rangeEnd, stylists: [] },
        explanation: 'No stylist activity was recorded in the reporting window.',
        rowCount: 0,
        presentation: {
          answer: `No stylist had completed bookings in ${period.label}, so there is no performance ranking to show yet.`,
          evidence: [this.evidence(performance)],
          confidence: 'high',
          limitations: ['An empty window usually means bookings have not been completed/paid yet.'],
          suggestedNextStep: 'Ask "How is my business doing?" for the overall activity picture.',
          responseType: 'Explanation',
        },
      };
    }

    // Pay-adjacent fields deliberately never copied.
    const rows = stylists.map((s) => ({
      stylist_name: s.stylistName,
      location_name: s.locationName,
      completed_bookings: s.completedBookings,
      total_bookings: s.totalBookings,
      rebooking_rate_percent: s.rebookingRatePercent,
      revenue_cents: s.revenueCents,
      average_booking_value_cents: s.averageBookingValueCents,
      currency_code: s.currencyCode,
    }));

    const top = stylists[0];
    const runnersUp = stylists
      .slice(1, 3)
      .map((s) => `${s.stylistName} (${formatMoney(s.revenueCents, s.currencyCode)})`)
      .join(', ');

    const answer = [
      `${capitalise(period.label)}: your top performer was ${top.stylistName} at ${top.locationName}:`,
      `${formatMoney(top.revenueCents, top.currencyCode)} from ${top.completedBookings} completed bookings, with a ${top.rebookingRatePercent}% rebooking rate.`,
      runnersUp ? `Next: ${runnersUp}.` : '',
    ]
      .filter(Boolean)
      .join(' ');

    return {
      status: 'ok',
      data: {
        range_start: performance.rangeStart,
        range_end: performance.rangeEnd,
        stylists: rows,
      },
      explanation:
        'Read from your dashboard performance service with your own permissions and scope.',
      rowCount: rows.length,
      presentation: {
        answer,
        evidence: [this.evidence(performance)],
        confidence: 'medium',
        limitations: [
          'QLOOQO captures no client ratings — "top" here means revenue, completed bookings and rebooking in the window, not reviews.',
          `Figures cover ${period.label} and the locations you can see.`,
          ...(period.unsupportedReason ? [period.unsupportedReason] : []),
          'Pay, rates and contracted hours are never part of ZAC answers.',
        ],
        suggestedNextStep:
          'Ask "Which stylists are below their rebooking target?" to see who needs support.',
        responseType: 'Insight',
      },
    };
  }

  private evidence(performance: DashboardStylistPerformanceResponse) {
    return {
      source_type: 'report.dashboard',
      source_ref: 'DashboardService.stylistPerformance',
      as_of: performance.rangeEnd,
      entities_used: [],
    };
  }
}

function formatMoney(cents: number, currencyCode: string): string {
  const symbol = currencyCode === 'GBP' ? '£' : currencyCode === 'EUR' ? '€' : `${currencyCode} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}
