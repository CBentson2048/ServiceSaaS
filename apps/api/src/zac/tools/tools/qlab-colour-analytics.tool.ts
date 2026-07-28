import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Placeholder contract only — QLAB stays at feasibility for Phase 1 Week 1.
 * A future week may wire this to the guarded `LabAnalyticsService.summary`
 * (waste figures come from `formulas.waste_cost_cents` via that service, never
 * the write-only waste_events table), gated on a data-feasibility probe. No
 * forecasting, ordering predictions, automated ordering or stock intelligence
 * belongs in this tool — those are explicitly out of scope for Phase 1.
 */
export class QlabColourAnalyticsTool implements ZacReadOnlyTool {
  readonly name = 'qlab.colour_analytics' as const;
  readonly domain = 'qlab' as const;
  readonly description = 'Summarises QLAB colour usage and waste from lab analytics.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['report.lab_analytics.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = {
    type: 'object',
    properties: {
      locationId: {
        type: 'string',
        description: 'Optional single-location focus; must be inside the acting user scope.',
      },
    },
    additionalProperties: false,
  };
  readonly outputSchema = {
    type: 'object',
    description: 'QLAB colour usage/waste summary (feasibility-gated; placeholder in Phase 1 Week 1).',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'none' as const;
  readonly cachePolicy = { ttlSeconds: 600, perTenant: true } as const;
  readonly rateLimit = { perMinute: 6 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = false;

  async execute(_context: ZacActingContext, _input: Record<string, unknown>): Promise<ZacToolResult> {
    return {
      status: 'not_connected',
      data: null,
      explanation:
        'QLAB colour analytics is at feasibility stage — no live QLAB data is connected to ZAC yet.',
      rowCount: null,
    };
  }
}
