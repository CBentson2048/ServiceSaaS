import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Week 1 skeleton — NOT connected, and blocked on real build work: utilisation is
 * currently computed browser-side (`computeDailyUtilisation`) with no server
 * endpoint to wrap. Wiring this tool means building a server-side utilisation
 * path first, not wrapping an existing service.
 */
export class UtilisationSummaryTool implements ZacReadOnlyTool {
  readonly name = 'report.utilisation_summary' as const;
  readonly domain = 'report' as const;
  readonly description = 'Summarises chair/stylist utilisation for the accessible locations.';
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
    description: 'Utilisation summary (requires a server-side utilisation endpoint first).',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'none' as const;
  readonly cachePolicy = { ttlSeconds: 300, perTenant: true } as const;
  readonly rateLimit = { perMinute: 10 } as const;
  readonly requiresStaffSelf = false;
  readonly enabled = false;

  async execute(_context: ZacActingContext, _input: Record<string, unknown>): Promise<ZacToolResult> {
    return {
      status: 'not_connected',
      data: null,
      explanation:
        'Utilisation data is not available yet — there is no server-side utilisation source to read from.',
      rowCount: null,
    };
  }
}
