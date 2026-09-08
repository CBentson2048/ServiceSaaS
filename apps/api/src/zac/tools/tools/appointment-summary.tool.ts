import type { AuthUser, DashboardKpisResponse } from '@sheer/domain';
import type { DashboardService } from '../../../dashboard/dashboard.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';
import { capitalise, periodFromInput } from '../zac-period';

/**
 * The SAME window as business health and rebooking — deliberately, not by
 * coincidence. Both tools read cancellations from the same dashboard payload,
 * and a shared window is what lets the priority layer recognise those as one
 * reading instead of raising the same issue twice over two different periods.
 */
const DEFAULT_RANGE_DAYS = 7;


/**
 * Expanded Intelligence — the APPOINTMENTS domain.
 *
 * The appointment slice of the guarded `DashboardService.kpis`: how many
 * bookings were taken, how many completed, and how many were lost to
 * cancellation or a no-show. Business health answers "how did we trade"; this
 * answers "what happened to the diary", which is a different question and was
 * previously only reachable as a by-product of the health snapshot.
 *
 * Completion and cancellation shares are divisions between two counts the
 * dashboard already reported — never a recomputed booking status.
 *
 * NO-SHOWS ARE HANDLED HONESTLY. `no_show` is a real appointment status the
 * dashboard counts, but capture depends on a human marking it, so a zero is
 * NOT evidence that no client failed to arrive. A count is stated only when
 * one was actually recorded, and the capture caveat rides on every answer.
 */
export class AppointmentSummaryTool implements ZacReadOnlyTool {
  readonly name = 'report.appointment_summary' as const;
  readonly domain = 'report' as const;
  readonly description =
    'Summarises appointment volume, completions, cancellations and recorded no-shows.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['report.dashboard.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  readonly outputSchema = {
    type: 'object',
    description: 'Appointment volume and outcome shares for the accessible locations.',
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
    const from = new Date(period.fromIso);
    const to = new Date(period.toIso);

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
          'I could not read your appointment figures just now, so I have no diary summary to share.',
        rowCount: null,
      };
    }

    const s = kpis.summary;
    // A share over a zero denominator is not a share. An empty window reports
    // null rather than 0%, so "nothing was booked" can never be read as
    // "everything was cancelled".
    const completionRate =
      s.totalBookings > 0 ? Math.round((s.completedBookings / s.totalBookings) * 100) : null;
    const cancellationRate =
      s.totalBookings > 0 ? Math.round((s.cancelledBookings / s.totalBookings) * 100) : null;

    const byLocation = kpis.byLocation.map((location) => ({
      location_name: location.locationName,
      total_bookings: location.totalBookings,
      completed_bookings: location.completedBookings,
      cancelled_bookings: location.cancelledBookings,
      cancellation_rate_percent:
        location.totalBookings > 0
          ? Math.round((location.cancelledBookings / location.totalBookings) * 100)
          : null,
    }));

    if (s.totalBookings === 0) {
      return {
        status: 'ok',
        data: {
          range_start: kpis.rangeStart,
          range_end: kpis.rangeEnd,
          total_bookings: 0,
          completed_bookings: 0,
          cancelled_bookings: 0,
          completion_rate_percent: null,
          cancellation_rate_percent: null,
          by_location: byLocation,
        },
        explanation: 'No appointments fell inside the reporting window.',
        rowCount: 0,
        presentation: {
          answer: `No appointments were recorded in ${period.label}, so there are no completion or cancellation rates to report.`,
          evidence: [this.evidence(kpis)],
          confidence: 'high',
          limitations: [
            'An empty window is not the same as a quiet salon — check the date range and the locations you can see.',
          ],
          suggestedNextStep: 'Ask "How is my business doing?" for the wider trading picture.',
          responseType: 'Explanation',
        },
      };
    }

    const perLocation =
      byLocation.length > 1
        ? ` By location: ${byLocation
            .map((l) => `${l.location_name} ${l.cancellation_rate_percent ?? 0}% cancelled`)
            .join(', ')}.`
        : '';

    const answer = [
      `${capitalise(period.label)}: you took ${s.totalBookings} appointments: ${s.completedBookings} completed (${completionRate}%) and ${s.cancelledBookings} cancelled (${cancellationRate}%).`,
      s.noShowBookings > 0
        ? `${s.noShowBookings} were marked as no-shows.`
        : 'No no-shows were marked in this window.',
      perLocation,
    ]
      .filter(Boolean)
      .join(' ');

    return {
      status: 'ok',
      data: {
        range_start: kpis.rangeStart,
        range_end: kpis.rangeEnd,
        total_bookings: s.totalBookings,
        completed_bookings: s.completedBookings,
        cancelled_bookings: s.cancelledBookings,
        no_show_bookings: s.noShowBookings,
        completed_paid_bookings: s.completedPaidBookings,
        completion_rate_percent: completionRate,
        cancellation_rate_percent: cancellationRate,
        by_location: byLocation,
      },
      explanation: 'Read from your dashboard KPI service with your own permissions and scope.',
      rowCount: kpis.byLocation.length,
      presentation: {
        answer,
        evidence: [this.evidence(kpis)],
        confidence: 'medium',
        limitations: [
          'No-shows are only counted when someone marks them, so a low count may mean they were not recorded rather than that they did not happen.',
          `Figures cover ${period.label} and the locations you can see.`,
          ...(period.unsupportedReason ? [period.unsupportedReason] : []),
          'Cancellation reasons and who cancelled are not part of this summary.',
        ],
        suggestedNextStep:
          'Ask "How full is my diary?" to see whether the freed time was rebooked.',
        responseType:
          cancellationRate !== null && cancellationRate >= 15 ? 'Watch Point' : 'Insight',
      },
    };
  }

  private evidence(kpis: DashboardKpisResponse) {
    return {
      source_type: 'report.dashboard',
      source_ref: 'DashboardService.kpis',
      as_of: kpis.rangeEnd,
      entities_used: [],
    };
  }
}
