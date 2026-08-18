import type { AuthUser } from '@sheer/domain';
import type {
  UtilisationService,
  UtilisationSummaryResponse,
} from '../../../kpi/utilisation.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacEvidenceItem } from '../../responses/zac-response.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * LIVE (the final Core MVP tool): explains utilisation patterns and diary
 * gaps. All figures come from the guarded UtilisationService, which runs the
 * CANONICAL `computeDailyUtilisation` from @sheer/domain — the same formula
 * behind the web calendar badge (booked stylist-occupied time ÷ rostered
 * available time). The tool computes nothing itself and the model narrates
 * only these verified figures.
 */
export class UtilisationSummaryTool implements ZacReadOnlyTool {
  readonly name = 'report.utilisation_summary' as const;
  readonly domain = 'report' as const;
  readonly description = 'Summarises chair/stylist utilisation and diary gaps for the accessible locations.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['report.performance.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = {
    type: 'object',
    properties: {
      locationId: {
        type: 'string',
        description: 'Optional single-location focus; must be inside the acting user scope.',
      },
      period: { type: 'string', enum: ['today', 'week', 'month'] },
    },
    additionalProperties: false,
  };
  readonly outputSchema = {
    type: 'object',
    description:
      'Deterministic utilisation summary: overall/previous-period percentages, weekday pattern, largest diary gaps, benchmark threshold and data-quality notes.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'low' as const;
  readonly cachePolicy = { ttlSeconds: 300, perTenant: true } as const;
  readonly rateLimit = { perMinute: 10 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = true;

  constructor(private readonly utilisation: UtilisationService) {}

  async execute(
    actor: AuthUser,
    context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const period = this.parsePeriod(input['period']);
    const locationId = typeof input['locationId'] === 'string' ? input['locationId'] : context.locationId ?? undefined;

    let summary: UtilisationSummaryResponse;
    try {
      summary = await this.utilisation.summary(actor, { period, locationId });
    } catch {
      // Fail closed: scope/permission/infrastructure errors from the guarded
      // service become a safe unavailable answer — never raw error text.
      return {
        status: 'unavailable',
        data: null,
        explanation:
          'I could not read utilisation just now, so I have no figures to share — please try again shortly.',
        rowCount: null,
      };
    }

    // No available time = nothing to measure. Honest refusal, never an
    // invented percentage — and the REASON must be accurate: an empty rota is
    // different advice from a rota zeroed out by leave/book-outs.
    if (summary.overall.utilisationPercent === null) {
      const explanation =
        summary.overall.staffDayCount === 0
          ? summary.dataQuality[0] ??
            'Utilisation needs rostered hours to measure against, and no rota shifts are recorded for this period. Fill in the rota and ask again.'
          : 'The rota is filled in, but leave and hour-reducing book-outs left no available working time in this period — so there is no utilisation to measure.';
      return {
        status: 'unavailable',
        data: null,
        explanation,
        rowCount: summary.overall.staffDayCount,
      };
    }

    return {
      status: 'ok',
      data: summary as unknown as Record<string, unknown>,
      explanation: 'Utilisation summary computed from rota availability and booked appointment time.',
      rowCount: summary.overall.staffDayCount,
      presentation: {
        answer: this.composeAnswer(context, summary),
        evidence: this.composeEvidence(summary),
        confidence: 'medium',
        limitations: this.composeLimitations(summary),
        suggestedNextStep: this.composeNextStep(summary),
        responseType:
          summary.warningThresholdPercent !== null &&
          summary.overall.utilisationPercent < summary.warningThresholdPercent
            ? 'Watch Point'
            : 'Insight',
      },
    };
  }

  private parsePeriod(raw: unknown): 'today' | 'week' | 'month' {
    return raw === 'today' || raw === 'month' ? raw : 'week';
  }

  private composeAnswer(context: ZacActingContext, summary: UtilisationSummaryResponse): string {
    const periodLabel = { today: 'today', week: 'this week', month: 'this month' }[summary.period];
    const lines: string[] = [];

    const overall = summary.overall.utilisationPercent!;
    const hoursAvailable = Math.round(summary.overall.availableMinutes / 6) / 10;
    const hoursBooked = Math.round(summary.overall.bookedMinutes / 6) / 10;
    lines.push(
      `Your utilisation ${periodLabel} is ${overall}% — ${hoursBooked} of ${hoursAvailable} available hours are booked${
        summary.locations.length === 1 ? ` at ${summary.locations[0].name}` : ` across ${summary.locations.length} locations`
      }.`,
    );

    if (summary.previousPeriod.utilisationPercent !== null) {
      const delta = overall - summary.previousPeriod.utilisationPercent;
      lines.push(
        delta === 0
          ? `That is level with the previous period (${summary.previousPeriod.utilisationPercent}%).`
          : `That is ${Math.abs(delta)} percentage point${Math.abs(delta) === 1 ? '' : 's'} ${delta > 0 ? 'up on' : 'down from'} the previous period (${summary.previousPeriod.utilisationPercent}%).`,
      );
    }

    if (summary.warningThresholdPercent !== null) {
      lines.push(
        overall < summary.warningThresholdPercent
          ? `It sits below your ${summary.warningThresholdPercent}% utilisation warning threshold.`
          : `It clears your ${summary.warningThresholdPercent}% utilisation warning threshold.`,
      );
    }

    if (summary.quietestWeekday && summary.busiestWeekday && summary.quietestWeekday !== summary.busiestWeekday) {
      const quiet = summary.byWeekday.find((entry) => entry.weekday === summary.quietestWeekday);
      const busy = summary.byWeekday.find((entry) => entry.weekday === summary.busiestWeekday);
      if (quiet && busy) {
        lines.push(
          `${summary.quietestWeekday} is the quietest day (${quiet.utilisationPercent}%) and ${summary.busiestWeekday} the busiest (${busy.utilisationPercent}%).`,
        );
      }
    }

    if (summary.byLocation.length > 1) {
      const parts = summary.byLocation
        .filter((entry) => entry.utilisationPercent !== null)
        .map((entry) => `${entry.locationName} ${entry.utilisationPercent}%`);
      if (parts.length > 1) lines.push(`By location: ${parts.join(', ')}.`);
    }

    const gap = summary.largestGaps[0];
    if (gap) {
      const gapHours = Math.round(gap.minutes / 6) / 10;
      lines.push(
        `The biggest diary gap is ${gapHours} unbooked available hours for ${gap.staffName} on ${gap.weekday} ${gap.date}${summary.locations.length > 1 ? ` at ${gap.locationName}` : ''}.`,
      );
    }

    void context;
    return lines.join('\n\n');
  }

  private composeEvidence(summary: UtilisationSummaryResponse): ZacEvidenceItem[] {
    return [
      {
        source_type: 'report.utilisation',
        source_ref: 'rota.shifts − breaks − reducing book-outs vs booking.occupied_ranges (computeDailyUtilisation)',
        as_of: summary.rangeEnd,
        entities_used: [],
      },
    ];
  }

  private composeLimitations(summary: UtilisationSummaryResponse): string[] {
    const limitations = [
      'Utilisation measures booked stylist time against rostered available hours (breaks and hour-reducing book-outs excluded) — the same formula as the calendar badge.',
      // The period dates ride here so a narration naming them stays grounded.
      `Period measured: ${summary.rangeStart.slice(0, 10)} to ${summary.rangeEnd.slice(0, 10)}, on UTC day boundaries (Europe/London operating assumption).`,
    ];
    for (const note of summary.dataQuality) limitations.push(note);
    if (summary.warningThresholdPercent === null && summary.locations.length === 1) {
      limitations.push('No utilisation warning threshold is configured for this location.');
    }
    return limitations;
  }

  private composeNextStep(summary: UtilisationSummaryResponse): string | null {
    // Only a gap that has not already elapsed is actionable.
    const upcomingGap = summary.largestGaps.find((gap) => Date.parse(gap.endIso) > Date.now());
    if (upcomingGap) {
      return `Consider promoting ${upcomingGap.weekday} availability — start with ${upcomingGap.staffName}'s open window on ${upcomingGap.date}.`;
    }
    if (summary.quietestWeekday) {
      return `Ask "Why is ${summary.quietestWeekday} quiet?" or target promotions at your quietest day.`;
    }
    return 'Ask for a single location or a different period to dig deeper.';
  }
}
