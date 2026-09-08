import type { AuthUser, DashboardTopServicesResponse } from '@sheer/domain';
import type { DashboardService } from '../../../dashboard/dashboard.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';
import { capitalise, periodFromInput } from '../zac-period';

/** Service mix reads a trading month — a week is too few bookings per service. */
const DEFAULT_RANGE_DAYS = 30;

/**
 * Expanded Intelligence — the SERVICES domain.
 *
 * The guarded `DashboardService.topServices` (which resolves the actor's
 * location scope itself) already ranks services by booking count and revenue;
 * ZAC reads that ranking and states the concentration it implies. Nothing is
 * recomputed: the only derivation is each service's share of the ranked
 * revenue, a division between two figures the service already reported.
 *
 * The ranking is a TOP-5, not a catalogue. That bound is stated in every
 * answer, because "your top service is 38% of revenue" would otherwise be read
 * as a share of ALL revenue, which this payload cannot support.
 */
export class ServiceMixTool implements ZacReadOnlyTool {
  readonly name = 'report.service_mix' as const;
  readonly domain = 'report' as const;
  readonly description =
    'Ranks the top services by bookings and revenue, with the concentration that implies.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['report.dashboard.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  readonly outputSchema = {
    type: 'object',
    description: 'Top services by booking count and revenue, with each share of the ranked total.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'none' as const;
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

    let top: DashboardTopServicesResponse;
    try {
      top = await this.dashboard.topServices(actor, {
        locationId: context.locationId ?? undefined,
        from: from.toISOString(),
        to: to.toISOString(),
      });
    } catch {
      // Fail closed: a scope or permission error from the guarded service
      // becomes a safe unavailable answer, never raw error text.
      return {
        status: 'unavailable',
        data: null,
        explanation:
          'I could not read your service mix just now, so I have no service ranking to share.',
        rowCount: null,
      };
    }

    const services = top.services;
    if (services.length === 0) {
      return {
        status: 'ok',
        data: { range_start: top.rangeStart, range_end: top.rangeEnd, services: [] },
        explanation: 'No service activity was recorded in the reporting window.',
        rowCount: 0,
        presentation: {
          answer: `No services were booked in ${period.label}, so there is no service mix to rank yet.`,
          evidence: [this.evidence(top)],
          confidence: 'high',
          limitations: [
            'An empty window usually means bookings have not been completed or paid yet.',
          ],
          suggestedNextStep: 'Ask "How is my business doing?" for the overall activity picture.',
          responseType: 'Explanation',
        },
      };
    }

    const rankedRevenueCents = services.reduce((sum, service) => sum + service.revenueCents, 0);
    const rows = services.map((service) => ({
      service_name: service.serviceName,
      booking_count: service.bookingCount,
      revenue_cents: service.revenueCents,
      currency_code: service.currencyCode,
      share_of_ranked_revenue_percent:
        rankedRevenueCents > 0 ? Math.round((service.revenueCents / rankedRevenueCents) * 100) : 0,
    }));

    const leader = rows[0];
    const currency = leader.currency_code;
    const rest = rows
      .slice(1, 3)
      .map((row) => `${row.service_name} (${formatMoney(row.revenue_cents, currency)})`)
      .join(', ');

    const answer = [
      `${capitalise(period.label)}: your highest-earning service was ${leader.service_name}: ${formatMoney(leader.revenue_cents, currency)} from ${leader.booking_count} bookings — ${leader.share_of_ranked_revenue_percent}% of the revenue across your top ${rows.length} services.`,
      rest ? `Next: ${rest}.` : '',
      rows.length > 1
        ? `Together your top ${rows.length} services took ${formatMoney(rankedRevenueCents, currency)}.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');

    return {
      status: 'ok',
      data: {
        range_start: top.rangeStart,
        range_end: top.rangeEnd,
        services: rows,
        ranked_service_count: rows.length,
        ranked_revenue_cents: rankedRevenueCents,
        currency_code: currency,
        top_service_share_percent: leader.share_of_ranked_revenue_percent,
      },
      explanation:
        'Read from your dashboard top-services service with your own permissions and scope.',
      rowCount: rows.length,
      presentation: {
        answer,
        evidence: [this.evidence(top)],
        confidence: 'medium',
        limitations: [
          `This ranks your top ${rows.length} services only — shares are of that ranked group, not of all salon revenue.`,
          `Figures cover ${period.label} and the locations you can see.`,
          ...(period.unsupportedReason ? [period.unsupportedReason] : []),
          'Service cost and margin are not tracked, so this is revenue mix, not profitability.',
        ],
        suggestedNextStep:
          'Ask "How is my retail doing?" to see the product side of the same period.',
        responseType: 'Insight',
      },
    };
  }

  private evidence(top: DashboardTopServicesResponse) {
    return {
      source_type: 'report.dashboard',
      source_ref: 'DashboardService.topServices',
      as_of: top.rangeEnd,
      entities_used: [],
    };
  }
}

function formatMoney(cents: number, currencyCode: string): string {
  const symbol = currencyCode === 'GBP' ? '£' : currencyCode === 'EUR' ? '€' : `${currencyCode} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}
