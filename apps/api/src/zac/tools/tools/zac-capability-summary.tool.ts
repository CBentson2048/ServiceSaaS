import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Live Week 2 tool — answers "what can you help me with?" honestly and
 * role-aware. The registry hands it a lens onto the acting user's own visible
 * tool set at construction time, so connected vs coming-soon is always derived
 * from what this actor can actually reach — never a hardcoded claim.
 */
export class ZacCapabilitySummaryTool implements ZacReadOnlyTool {
  readonly name = 'context.capabilities' as const;
  readonly domain = 'context' as const;
  readonly description = 'Explains what ZAC can help with right now and what is coming soon.';
  readonly allowedRoles = ['owner', 'manager', 'stylist'] as const;
  readonly requiredPermissions = [] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  readonly outputSchema = {
    type: 'object',
    description: 'Connected capability list, planned capability list, and honest limitations.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'none' as const;
  readonly cachePolicy = { ttlSeconds: 0, perTenant: true } as const;
  readonly rateLimit = { perMinute: 20 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = true;

  constructor(
    private readonly listVisibleTools: (
      actor: Pick<AuthUser, 'roles' | 'permissions'>,
    ) => ZacReadOnlyTool[],
  ) {}

  async execute(
    actor: AuthUser,
    context: ZacActingContext,
    _input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const visible = this.listVisibleTools(actor).filter((tool) => tool.name !== this.name);
    const connected = visible.filter((tool) => tool.enabled);
    const planned = visible.filter((tool) => !tool.enabled);

    const answer =
      context.roleContext === 'stylist'
        ? this.composeStylistAnswer(context, connected)
        : this.composeBusinessAnswer(context, connected);

    return {
      status: 'ok',
      data: {
        connected_capabilities: connected.map((tool) => tool.name),
        planned_capabilities: planned.map((tool) => tool.name),
        role_context: context.roleContext,
      },
      explanation: 'Derived from the tools your role and permissions can currently reach.',
      rowCount: connected.length,
      presentation: {
        answer,
        evidence: [
          {
            source_type: 'zac.registry',
            source_ref: 'visible-tool-set',
            as_of: null,
            entities_used: [],
          },
        ],
        confidence: 'high',
        limitations:
          context.roleContext === 'stylist'
            ? [
                'Your ZAC scope is your own work only — never colleagues, business financials, pay or client lists.',
                `${connected.length} stylist data source${connected.length === 1 ? ' is' : 's are'} connected for your role.`,
                'I never guess: answers that need a source I do not have will say so plainly.',
              ]
            : [
                `${connected.length} data source${connected.length === 1 ? ' is' : 's are'} connected for your role; ${planned.length} more are planned but not live yet.`,
                'I never guess: answers that need a source I do not have will say so plainly.',
              ],
        suggestedNextStep:
          context.roleContext === 'stylist'
            ? 'Try "What should I focus on today?" for coaching from your own numbers.'
            : 'Ask "How is my business doing?" for your first data-backed snapshot.',
        responseType: 'Explanation',
      },
    };
  }

  /** Owner/manager framing: the business console. */
  private composeBusinessAnswer(context: ZacActingContext, connected: ZacReadOnlyTool[]): string {
    const greeting = context.actorFirstName ? `Hi ${context.actorFirstName} 👋` : 'Hi 👋';
    const connectedLines = [
      '• Your business context — which business and locations I can see, and what your role lets me look at.',
      '• Your locations — how many you can access and which one we are focused on.',
    ];
    if (connected.some((tool) => tool.name === 'report.business_health')) {
      connectedLines.push(
        '• A basic business health snapshot — bookings, revenue and rebooking activity from your dashboard KPIs.',
      );
    }

    return [
      greeting,
      "I'm ZAC, your AI business assistant for QLOOQO.",
      `Here's what I can help with right now:\n${connectedLines.join('\n')}`,
      "As I continue to develop, I'll also help with revenue, team productivity, appointments, utilisation, retention, rebooking, retail performance, QLAB colour usage and costs, stock, inventory, trends and growth opportunities.",
      "I'm still in foundation mode: beyond the sources above, I don't yet have access to your live business data, and I'll always tell you when an answer isn't based on your salon's information.",
      'Try asking: "How is my business doing?" or "What locations can I see?" — or check back as more sources come online.',
    ].join('\n\n');
  }

  /**
   * Stylist framing: a personal assistant scoped to their own work. Never
   * mentions business reports, payroll, colleagues or clients as capabilities,
   * and states the access boundary plainly. Connected lines are derived from
   * the actor's actual visible tool set — never hardcoded claims.
   */
  private composeStylistAnswer(context: ZacActingContext, connected: ZacReadOnlyTool[]): string {
    const greeting = context.actorFirstName ? `Hi ${context.actorFirstName} 👋` : 'Hi 👋';

    const connectedLines: string[] = [];
    if (connected.some((tool) => tool.name === 'schedule.my_appointments')) {
      connectedLines.push('• Your own diary — appointments for today and tomorrow.');
    }
    if (connected.some((tool) => tool.name === 'kpi.personal_coaching')) {
      connectedLines.push(
        '• Personal coaching — your own targets, rebooking and retail habits, with a suggested focus.',
      );
    }

    return [
      greeting,
      "I'm ZAC, your AI assistant for QLOOQO.",
      connectedLines.length > 0
        ? `For stylists, I can already help with:\n${connectedLines.join('\n')}`
        : "For stylists, I'm here to help with your own workday: your appointments, personal coaching, rebooking habits, retail opportunities and service improvement — wherever those read-only tools are connected.",
      "I'm still in foundation mode, so some stylist data may not be connected yet. I'll always tell you when something is not connected or not available at your access level.",
      'You can ask things like:\n• What should I focus on today?\n• Is there a scheduled appointment from today to tomorrow?\n• How can I improve this week?',
      "I can't show owner-level business reports, payroll, other staff performance or restricted client information.",
    ].join('\n\n');
  }
}
