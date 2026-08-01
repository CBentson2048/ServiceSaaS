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
  readonly allowedRoles = ['owner', 'manager'] as const;
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

    const answer = [
      greeting,
      "I'm ZAC, your AI business assistant for QLOOQO.",
      `Here's what I can help with right now:\n${connectedLines.join('\n')}`,
      "As I continue to develop, I'll also help with revenue, team productivity, appointments, utilisation, retention, rebooking, retail performance, QLAB colour usage and costs, stock, inventory, trends and growth opportunities.",
      "I'm still in foundation mode: beyond the sources above, I don't yet have access to your live business data, and I'll always tell you when an answer isn't based on your salon's information.",
      'Try asking: "How is my business doing?" or "What locations can I see?" — or check back as more sources come online.',
    ].join('\n\n');

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
        limitations: [
          `${connected.length} data source${connected.length === 1 ? ' is' : 's are'} connected for your role; ${planned.length} more are planned but not live yet.`,
          'I never guess: answers that need a source I do not have will say so plainly.',
        ],
        suggestedNextStep: 'Ask "How is my business doing?" for your first data-backed snapshot.',
        responseType: 'Explanation',
      },
    };
  }
}
