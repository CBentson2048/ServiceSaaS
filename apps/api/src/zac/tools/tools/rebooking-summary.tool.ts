import type { AuthUser, DashboardKpisResponse } from '@sheer/domain';
import type { DashboardService } from '../../../dashboard/dashboard.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';
import { periodFromInput } from '../zac-period';

/** Same default window as the business-health tool: the last 7 days. */
const DEFAULT_RANGE_DAYS = 7;

/**
 * Live Week 3 tool — the rebooking slice of the guarded `DashboardService.kpis`
 * (which re-checks role and location scope itself): overall rate, the
 * stylist-initiated vs client-initiated split, and per-location rates.
 * `no_show` is never written by V1.1, so it is stated as "not captured",
 * never presented as a real figure.
 */
export class RebookingSummaryTool implements ZacReadOnlyTool {
  readonly name = 'report.rebooking_summary' as const;
  readonly domain = 'report' as const;
  readonly description = 'Summarises rebooking rates and sources for the accessible locations.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['report.dashboard.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  readonly outputSchema = {
    type: 'object',
    description: 'Rebooking rate summary by source, with not-captured metrics flagged.',
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
      return {
        status: 'unavailable',
        data: null,
        explanation:
          'I could not read your dashboard KPIs just now, so I have no rebooking view to share.',
        rowCount: null,
      };
    }

    const s = kpis.summary;
    const byLocation = kpis.byLocation.map((location) => ({
      location_name: location.locationName,
      rebooking_rate_percent: location.rebookingRatePercent,
      rebooked_visits: location.rebookedVisits,
    }));

    const perLocation =
      byLocation.length > 1
        ? ` By location: ${byLocation
            .map((l) => `${l.location_name} ${l.rebooking_rate_percent}%`)
            .join(', ')}.`
        : '';

    const answer = [
      `Your rebooking rate for ${period.label} was ${s.rebookingRatePercent}% — ${s.rebookedVisits} rebooked visits out of ${s.completedBookings} completed.`,
      `${s.stylistRebookedVisits} were rebooked by stylists at the chair and ${s.clientRebookedVisits} by clients themselves.${perLocation}`,
    ].join(' ');

    return {
      status: 'ok',
      data: {
        range_start: kpis.rangeStart,
        range_end: kpis.rangeEnd,
        rebooking_rate_percent: s.rebookingRatePercent,
        rebooked_visits: s.rebookedVisits,
        stylist_rebooked_visits: s.stylistRebookedVisits,
        client_rebooked_visits: s.clientRebookedVisits,
        completed_bookings: s.completedBookings,
        by_location: byLocation,
      },
      explanation: 'Read from your dashboard KPI service with your own permissions and scope.',
      rowCount: kpis.byLocation.length,
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
          'Rebooking is a lower bound — rebookings made outside QLOOQO are not captured.',
          'No-show data is not reliably captured yet, so it is excluded rather than shown as zero.',
          `Figures cover ${period.label}.`,
          ...(period.unsupportedReason ? [period.unsupportedReason] : [])
        ],
        suggestedNextStep:
          'Ask "Which stylists are below their rebooking target?" to see who to coach.',
        responseType: 'Insight',
      },
    };
  }
}
