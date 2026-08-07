import type { AppointmentStatus, AuthUser, StaffBookingSummary } from '@sheer/domain';
import type { LabAppointmentsService } from '../../../lab-appointments/lab-appointments.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Live stylist tool — the acting stylist's OWN diary, read through the guarded
 * `LabAppointmentsService` (the same service behind the mobile bookings screen).
 * Self-scope is enforced by the service itself: `applyActorScope` pins a pure
 * stylist to their own column via `actor.staffProfileId`, so this tool cannot
 * see a colleague's book even if asked. The contract accepts no staff id input
 * by design.
 *
 * Client references in the answer are first names only — the stylist already
 * sees full names in their own diary, but a ZAC answer should carry the minimum
 * that is useful.
 */
export class MyScheduleTool implements ZacReadOnlyTool {
  readonly name = 'schedule.my_appointments' as const;
  readonly domain = 'schedule' as const;
  readonly description = 'Lists the acting stylist own upcoming appointments (today, or today and tomorrow).';
  readonly allowedRoles = ['stylist'] as const;
  // Mirrors the guard on GET /lab/appointments/today — re-checked at dispatch.
  readonly requiredPermissions = ['bookings.manage'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = {
    type: 'object',
    properties: {
      horizon: { type: 'string', enum: ['today', 'today_tomorrow'] },
    },
    additionalProperties: false,
  };
  readonly outputSchema = {
    type: 'object',
    description: 'Appointment counts and per-slot time/service lines for the self-scoped diary.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'low' as const;
  readonly cachePolicy = { ttlSeconds: 60, perTenant: true } as const;
  readonly rateLimit = { perMinute: 12 } as const;
  readonly requiresStaffSelf = true;
  readonly enabled = true;

  constructor(private readonly labAppointments: LabAppointmentsService) {}

  async execute(
    actor: AuthUser,
    context: ZacActingContext,
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const horizon = input.horizon === 'today_tomorrow' ? 'today_tomorrow' : 'today';

    let today;
    try {
      today = await this.labAppointments.today(actor);
    } catch {
      return this.unavailable();
    }

    const todayRows = today.bookings.filter(isScheduled);
    let tomorrowRows: StaffBookingSummary[] = [];

    if (horizon === 'today_tomorrow') {
      try {
        // The list endpoint is self-scoped identically; the tomorrow window is
        // anchored on the service's own canonical end-of-today boundary (falling
        // back to "now" if the service ever omits it).
        const endOfToday = today.rangeEnd || new Date().toISOString();
        const all = await this.labAppointments.list(actor);
        const tomorrowEnd = new Date(
          new Date(endOfToday).getTime() + 24 * 60 * 60 * 1000,
        ).toISOString();
        tomorrowRows = all.bookings.filter(
          (booking) =>
            isScheduled(booking) &&
            booking.startsAt >= endOfToday &&
            booking.startsAt < tomorrowEnd,
        );
      } catch {
        return this.unavailable();
      }
    }

    const lines = [
      ...todayRows.map((booking) => formatSlot(booking, context.timezone, 'today')),
      ...tomorrowRows.map((booking) => formatSlot(booking, context.timezone, 'tomorrow')),
    ];
    const total = todayRows.length + tomorrowRows.length;
    const horizonLabel = horizon === 'today_tomorrow' ? 'today and tomorrow' : 'today';

    const answer =
      total === 0
        ? `You have no appointments scheduled for ${horizonLabel}. A quiet diary can be a good moment to reach out to recent clients about rebooking.`
        : [
            `You have ${total} appointment${total === 1 ? '' : 's'} scheduled for ${horizonLabel}:`,
            lines.join('\n'),
          ].join('\n\n');

    return {
      status: 'ok',
      data: {
        horizon,
        today_count: todayRows.length,
        tomorrow_count: tomorrowRows.length,
      },
      explanation: 'Read from your own diary with your own permissions — no other columns were read.',
      rowCount: total,
      presentation: {
        answer,
        evidence: [
          {
            source_type: 'booking.schedule',
            source_ref: 'LabAppointmentsService.today',
            as_of: new Date().toISOString(),
            entities_used: [],
          },
        ],
        confidence: 'high',
        limitations: [
          'This is your own column only — cancelled and rejected bookings are not shown.',
          horizon === 'today'
            ? 'Showing today only; ask about "today and tomorrow" for the wider view.'
            : 'Showing today and tomorrow only.',
        ],
        suggestedNextStep:
          total === 0
            ? 'Ask "How can I improve this week?" for coaching based on your own numbers.'
            : 'Ask "What should I focus on today?" for coaching alongside this diary.',
        responseType: 'Explanation',
      },
    };
  }

  private unavailable(): ZacToolResult {
    return {
      status: 'unavailable',
      data: null,
      explanation:
        'I could not read your diary just now, so I have no schedule to share. Please try again shortly.',
      rowCount: null,
    };
  }
}

/** "Scheduled" = anything not explicitly dead. Robust to new active statuses. */
function isScheduled(booking: StaffBookingSummary): boolean {
  const dead: AppointmentStatus[] = ['rejected', 'cancelled', 'no_show'];
  return !dead.includes(booking.status);
}

function formatSlot(
  booking: StaffBookingSummary,
  timeZone: string,
  day: 'today' | 'tomorrow',
): string {
  const time = new Date(booking.startsAt).toLocaleTimeString('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  });
  const firstName = booking.clientDisplayName.trim().split(/\s+/)[0] || 'a client';
  const services = booking.serviceNames.length > 0 ? booking.serviceNames.join(' + ') : 'appointment';
  return `• ${day === 'tomorrow' ? 'Tomorrow ' : ''}${time} — ${services} with ${firstName}`;
}
