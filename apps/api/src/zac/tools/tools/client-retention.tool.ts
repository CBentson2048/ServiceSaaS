import type { AuthUser, ListClientLapseResponse } from '@sheer/domain';
import type { ClientIntelligenceService } from '../../../client-intelligence/client-intelligence.service';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * One row is requested because ZAC reports COUNTS, never a client list. The
 * counts in the payload cover the whole evaluated scope regardless of page
 * size, so this asks for the smallest page the endpoint allows.
 */
const COUNTS_ONLY_PAGE_SIZE = 1;

/**
 * Expanded Intelligence — the CLIENTS / RETENTION domain.
 *
 * Reads the guarded `ClientIntelligenceService.listLapsedClients`, which
 * re-checks owner/manager role and location scope itself and applies the
 * salon's own configured lapse settings.
 *
 * TWO THINGS THIS DELIBERATELY DOES NOT DO.
 *
 * It never returns a client. The endpoint can page through named individuals;
 * ZAC asks for one row and reads only the scope-wide counts, so no client name,
 * contact detail or visit history can reach an answer. `piiLevel` is 'none'
 * because that is structurally true, not because the source is harmless.
 *
 * It never calls this a "retention rate". The canonical metric registry records
 * that lapse detection answers a different question from retention and produces
 * no rate; inventing one here would stand a second, competing formula next to
 * QLOOQO's own. What is reported is a SHARE of the clients that could actually
 * be judged — clients without enough visit history are excluded from the
 * denominator and stated separately, so "not measurable" can never read as
 * "healthy".
 */
export class ClientRetentionTool implements ZacReadOnlyTool {
  readonly name = 'report.client_retention' as const;
  readonly domain = 'report' as const;
  readonly description =
    'Counts clients who are active, at risk of lapsing, lapsed or already rebooked.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['crm.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  readonly outputSchema = {
    type: 'object',
    description: 'Scope-wide client lapse counts and shares. Counts only — never a client list.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'none' as const;
  readonly cachePolicy = { ttlSeconds: 600, perTenant: true } as const;
  readonly rateLimit = { perMinute: 6 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = true;

  constructor(private readonly clientIntelligence: ClientIntelligenceService) {}

  async execute(
    actor: AuthUser,
    context: ZacActingContext,
    _input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    let lapse: ListClientLapseResponse;
    try {
      lapse = await this.clientIntelligence.listLapsedClients(actor, {
        locationId: context.locationId ?? undefined,
        page: 1,
        pageSize: COUNTS_ONLY_PAGE_SIZE,
      });
    } catch {
      return {
        status: 'unavailable',
        data: null,
        explanation:
          'I could not read your client retention picture just now, so I have no lapse counts to share.',
        rowCount: null,
      };
    }

    const counts = lapse.counts;
    // Only clients with enough visit history can be judged. Excluding the rest
    // from the denominator is the difference between "12% of your measurable
    // clients are at risk" and a number quietly diluted by everyone ZAC could
    // not assess at all.
    const measurable = counts.active + counts.atRisk + counts.lapsed + counts.booked;
    const atRiskShare = measurable > 0 ? Math.round((counts.atRisk / measurable) * 100) : null;
    const lapsedShare = measurable > 0 ? Math.round((counts.lapsed / measurable) * 100) : null;

    const data = {
      active_clients: counts.active,
      at_risk_clients: counts.atRisk,
      lapsed_clients: counts.lapsed,
      booked_clients: counts.booked,
      insufficient_history_clients: counts.insufficientHistory,
      measurable_clients: measurable,
      evaluated_client_count: lapse.evaluatedClientCount,
      at_risk_share_percent: atRiskShare,
      lapsed_share_percent: lapsedShare,
      lapsed_buffer_days: lapse.settings.lapsedBufferDays,
      minimum_completed_visits: lapse.settings.minCompletedVisits,
      history_truncated: lapse.truncated,
    };

    if (measurable === 0) {
      return {
        status: 'ok',
        data,
        explanation: 'No client had enough completed visit history to judge a return pattern.',
        rowCount: 0,
        presentation: {
          answer: [
            `I cannot judge retention yet: none of the ${lapse.evaluatedClientCount} clients I looked at has the ${lapse.settings.minCompletedVisits} completed visits needed before I can tell what their normal return gap is.`,
            'This is a history-depth limit, not a sign that clients are leaving.',
          ].join(' '),
          evidence: [this.evidence()],
          confidence: 'high',
          limitations: [
            `A client needs at least ${lapse.settings.minCompletedVisits} completed visits before a personal return pattern can be claimed.`,
            'No client names or contact details are ever part of this answer.',
          ],
          suggestedNextStep:
            'Ask "How is my rebooking rate?" for the forward-booking picture instead.',
          responseType: 'Explanation',
        },
      };
    }

    const answer = [
      `Of the ${measurable} clients I can judge, ${counts.active} are visiting on their usual pattern, ${counts.atRisk} are overdue and at risk (${atRiskShare}%), and ${counts.lapsed} have lapsed (${lapsedShare}%).`,
      counts.booked > 0
        ? `A further ${counts.booked} were overdue but already have a future appointment booked.`
        : '',
      counts.insufficientHistory > 0
        ? `${counts.insufficientHistory} more clients do not yet have enough visit history to judge.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');

    // A lapsed client is a completed loss; an at-risk one is still recoverable.
    // The badge follows the worse of the two.
    const severe = (lapsedShare ?? 0) >= 25 || (atRiskShare ?? 0) >= 25;

    return {
      status: 'ok',
      data,
      explanation:
        'Read from your guarded client-intelligence service with your own permissions and scope.',
      rowCount: measurable,
      presentation: {
        answer,
        evidence: [this.evidence()],
        confidence: 'medium',
        limitations: [
          `"Overdue" is measured against each client's own usual visit gap plus your ${lapse.settings.lapsedBufferDays}-day grace period, not a fixed calendar rule.`,
          'These are counts only — I never list or name individual clients.',
          lapse.truncated
            ? 'Visit history was truncated for some clients, so a few patterns rest on partial history.'
            : 'Clients not seen inside the history window are out of scope rather than counted as lapsed.',
        ],
        suggestedNextStep:
          'Ask "How is my rebooking rate?" to see whether future visits are being booked at the chair.',
        responseType: severe ? 'Risk' : 'Insight',
      },
    };
  }

  private evidence() {
    return {
      source_type: 'crm.client_intelligence',
      source_ref: 'ClientIntelligenceService.listLapsedClients',
      as_of: null,
      entities_used: [],
    };
  }
}
