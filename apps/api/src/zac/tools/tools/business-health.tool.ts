import type { AuthUser, DashboardKpisResponse } from '@sheer/domain';
import type { DashboardService } from '../../../dashboard/dashboard.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';
import { periodFromInput } from '../zac-period';

/** Default reporting window when the user gives no range: the last 7 days. */
const DEFAULT_RANGE_DAYS = 7;

/**
 * Live Week 2 tool — basic business health from the existing guarded
 * `DashboardService.kpis` (the same service behind the dashboard, which
 * re-checks role and location scope itself). The resolved actor is passed
 * through unchanged; ZAC adds its own `report.dashboard.view` re-check at the
 * registry/dispatch layer on top. "Business health" is revenue & activity
 * health — not a P&L; no cost or profit lines exist in the platform yet.
 */
export class BusinessHealthSummaryTool implements ZacReadOnlyTool {
  readonly name = 'report.business_health' as const;
  readonly domain = 'report' as const;
  readonly description =
    'Summarises revenue and activity health for the business from dashboard KPIs.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['report.dashboard.view'] as const;
  readonly anyOfPermissions = [] as const;
  // Location focus comes from the ask request via the validated acting context,
  // never from tool input — the schema stays empty until input plumbing lands.
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  readonly outputSchema = {
    type: 'object',
    description: 'Dashboard KPI summary with as-of range and the location scope aggregated.',
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

    let kpis: DashboardKpisResponse;
    try {
      kpis = await this.dashboard.kpis(actor, {
        locationId: context.locationId ?? undefined,
        from: from.toISOString(),
        to: to.toISOString(),
      });
    } catch {
      // Fail closed: scope/permission errors from the guarded service become a
      // safe unavailable-data answer, never a raw error to the user.
      return {
        status: 'unavailable',
        data: null,
        explanation:
          'I could not read your dashboard KPIs just now, so I have no health snapshot to share.',
        rowCount: null,
      };
    }

    const s = kpis.summary;
    const locationCount = kpis.byLocation.length;
    const revenue = formatMoney(s.totalRevenueCents, s.currencyCode);
    const average = formatMoney(s.averageBookingValueCents, s.currencyCode);

    const answer = [
      `Here's your business health snapshot for ${period.label}${
        locationCount > 1 ? ` across ${locationCount} locations` : ''
      }:`,
      `revenue was ${revenue} from ${s.completedPaidBookings} completed paid bookings (average ${average} per booking).`,
      `You had ${s.totalBookings} bookings overall — ${s.completedBookings} completed and ${s.cancelledBookings} cancelled — with ${s.newClients} new and ${s.repeatClients} repeat clients.`,
      `Your rebooking rate was ${s.rebookingRatePercent}%.`,
    ].join(' ');

    return {
      status: 'ok',
      data: {
        range_start: kpis.rangeStart,
        range_end: kpis.rangeEnd,
        location_count: locationCount,
        total_revenue_cents: s.totalRevenueCents,
        currency_code: s.currencyCode,
        total_bookings: s.totalBookings,
        completed_bookings: s.completedBookings,
        cancelled_bookings: s.cancelledBookings,
        new_clients: s.newClients,
        repeat_clients: s.repeatClients,
        rebooking_rate_percent: s.rebookingRatePercent,
      },
      explanation: 'Read from your dashboard KPI service with your own permissions and scope.',
      rowCount: locationCount,
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
        confidence: 'medium',
        limitations: [
          'This is revenue and activity health, not a profit view — cost and margin data is not tracked yet.',
          `Figures cover ${period.label} only; ask again with a location focus for a narrower view.`,
          ...(period.unsupportedReason ? [period.unsupportedReason] : []),
          'No-show counts are not reliably captured yet, so they are not part of this snapshot.',
        ],
        suggestedNextStep:
          'Ask "What locations can I see?" to focus this snapshot on a single location.',
        responseType: 'Insight',
      },
    };
  }
}

function formatMoney(cents: number, currencyCode: string): string {
  const symbol = currencyCode === 'GBP' ? '£' : currencyCode === 'EUR' ? '€' : `${currencyCode} `;
  return `${symbol}${(cents / 100).toFixed(2)}`;
}
