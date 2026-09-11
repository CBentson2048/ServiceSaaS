import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolName, ZacToolResult } from '../zac-tool.types';

/**
 * Live Week 2 tool — answers "what can you help me with?" honestly and
 * role-aware. The registry hands it a lens onto the acting user's own visible
 * tool set at construction time, so connected vs coming-soon is always derived
 * from what this actor can actually reach — never a hardcoded claim.
 */
/**
 * One line per capability, keyed by tool name. Adding a tool without adding a
 * line here means ZAC simply does not mention it — the failure is silent but
 * harmless, unlike the previous hardcoded list, which actively denied
 * capabilities that existed.
 */
const CAPABILITY_LINES: Partial<Record<ZacToolName, string>> = {
  'context.business_summary':
    'Your business context — which business and locations I can see, and what your role lets me look at.',
  'context.location_summary':
    'Your locations — how many you can access and which one we are focused on.',
  'report.business_health':
    'A business health snapshot — bookings, revenue and rebooking activity from your dashboard KPIs.',
  'report.utilisation_summary':
    'Utilisation and diary gaps — booked time against rostered available hours, quiet days and unbooked windows.',
  'report.stylist_performance':
    'Stylist performance — who is earning most, their completed bookings and rebooking rates.',
  'report.kpi_summary': 'Team KPIs — who is meeting their targets and who is below them.',
  'report.rebooking_summary':
    'Rebooking — your rate, and whether it came from the chair or the client.',
  'report.appointment_summary':
    'Appointments — volume, completion, cancellations and recorded no-shows.',
  'report.service_mix': 'Services — which services earn most, and their share of your revenue.',
  'report.retail_performance':
    'Retail — takings, attachment per visit, and gross margin where product cost was recorded.',
  'report.client_retention':
    'Client retention — how many clients are on pattern, overdue or lapsed — and, if your access covers client records, who they are.',
  'kpi.personal_coaching': 'Your own KPIs and personal coaching.',
  'schedule.my_appointments': 'Your own diary for today and tomorrow.',
  // Workstream 3 — QLab & stock.
  //
  // The colour line does NOT mention waste, deliberately. No saved formula on
  // the platform records any, so offering waste analytics here would advertise
  // a capability the data cannot support — the tool itself explains that gap
  // when asked, which is the honest place for it.
  'qlab.colour_analytics':
    'Colour costs and margin — what the product in your formulas costs, what colour earns, and which products that spend goes on.',
  'inventory.stock_status':
    'Stock — what is at or below its low-stock threshold right now, and what has been sitting unused.',
  'inventory.colour_prep_risk':
    'Colour preparation — whether what is on the shelf covers the colour appointments already in the diary.',
  'inventory.reorder_advisory':
    'Ordering — what a supplier order would contain if you placed one today, and what cannot be ordered yet. Advice only: I never place an order.',
};

/**
 * Named as coming only while genuinely unbuilt.
 *
 * QLAB colour, stock and inventory were removed here when Workstream 3
 * connected them. Leaving them would have told an owner a capability was
 * "coming" while ZAC was already answering questions with it — the precise
 * failure the comment above this file's CAPABILITY_LINES warns about.
 */
const PLANNED_AREAS = 'trends over time';

/** The full list, used only when nothing at all is connected. */
const ALL_AREAS =
  'revenue, team productivity, appointments, utilisation, retention, rebooking, retail performance, QLAB colour usage and costs, stock, inventory, trends and growth opportunities';

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
    input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const visible = this.listVisibleTools(actor).filter((tool) => tool.name !== this.name);
    const connected = visible.filter((tool) => tool.enabled);
    const planned = visible.filter((tool) => !tool.enabled);

    // Greeting + "I'm ZAC" appear on a conversation's first assistant turn
    // only — except when the user explicitly asked who ZAC is, where identity
    // IS the answer (the orchestrator sets introduceIdentity for that intent).
    const introduce = context.firstAssistantTurn || input['introduceIdentity'] === true;

    const answer =
      context.roleContext === 'stylist'
        ? this.composeStylistAnswer(context, connected, introduce)
        : this.composeBusinessAnswer(context, connected, introduce);

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
  private composeBusinessAnswer(
    context: ZacActingContext,
    connected: ZacReadOnlyTool[],
    introduce: boolean,
  ): string {
    const greeting = context.actorFirstName ? `Hi ${context.actorFirstName} 👋` : 'Hi 👋';
    // Derived from the ACTOR'S CONNECTED TOOLS, never hardcoded. The previous
    // version listed two capabilities behind hand-written `if` checks and was
    // never updated as tools were added, so ZAC told owners it could not do
    // things it could — and advertised appointments, retail and retention as
    // "still coming" while they were live. Anything absent from this map is a
    // capability nobody described, which is visible; a stale sentence is not.
    const connectedLines = connected
      .map((tool) => CAPABILITY_LINES[tool.name])
      .filter((line): line is string => Boolean(line))
      .map((line) => `• ${line}`);

    // Only genuinely unbuilt areas may be named as coming. Reading a live
    // capability in this sentence is what made the answer wrong.
    const planned = connected.length > 0 ? PLANNED_AREAS : ALL_AREAS;

    return [
      ...(introduce ? [greeting, "I'm ZAC, your AI business assistant for QLOOQO."] : []),
      `Here's what I can help with right now:\n${connectedLines.join('\n')}`,
      `As I continue to develop, I'll also help with ${planned}.`,
      // The foundation-mode caveat is TRUE only when nothing is connected.
      // Stated unconditionally it contradicted the list directly above it.
      connectedLines.length > 0
        ? "Every figure I give you comes from QLOOQO's own reports, and I'll always say plainly when something isn't connected yet rather than guessing."
        : "I'm still in foundation mode: I don't yet have access to your live business data, and I'll always tell you when an answer isn't based on your salon's information.",
      'Try asking: "How is my business doing?" or "What locations can I see?" — or check back as more sources come online.',
    ].join('\n\n');
  }

  /**
   * Stylist framing: a personal assistant scoped to their own work. Never
   * mentions business reports, payroll, colleagues or clients as capabilities,
   * and states the access boundary plainly. Connected lines are derived from
   * the actor's actual visible tool set — never hardcoded claims.
   */
  private composeStylistAnswer(
    context: ZacActingContext,
    connected: ZacReadOnlyTool[],
    introduce: boolean,
  ): string {
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
      ...(introduce ? [greeting, "I'm ZAC, your AI assistant for QLOOQO."] : []),
      connectedLines.length > 0
        ? `For stylists, I can already help with:\n${connectedLines.join('\n')}`
        : "For stylists, I'm here to help with your own workday: your appointments, personal coaching, rebooking habits, retail opportunities and service improvement — wherever those read-only tools are connected.",
      // Same correction as the business copy: "foundation mode" contradicted
      // the list of live capabilities printed directly above it.
      connectedLines.length > 0
        ? "Every figure I give you comes from QLOOQO's own records, and I'll always say plainly when something isn't connected or isn't available at your access level."
        : "I'm still in foundation mode, so some stylist data may not be connected yet. I'll always tell you when something is not connected or not available at your access level.",
      'You can ask things like:\n• What should I focus on today?\n• Is there a scheduled appointment from today to tomorrow?\n• How can I improve this week?',
      "I can't show owner-level business reports, payroll, other staff performance or restricted client information.",
    ].join('\n\n');
  }
}
