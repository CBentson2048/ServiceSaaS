import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Week 1 skeleton — NOT connected, and a deferred surface (the stylist-facing
 * ZAC entry ships later). Week 2+ wires this to the guarded `KpiService.myKpi`,
 * keyed strictly on the acting user's own `staffProfileId`. The contract accepts
 * NO staffProfileId argument by design — a stylist can never be pointed at
 * another stylist's data, and owners/managers never see this tool at all.
 */
export class PersonalStylistCoachingTool implements ZacReadOnlyTool {
  readonly name = 'kpi.personal_coaching' as const;
  readonly domain = 'kpi' as const;
  readonly description =
    'Supportive coaching summary of the acting stylist own performance. Self-scope only.';
  readonly allowedRoles = ['stylist'] as const;
  readonly requiredPermissions = [] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['today', 'week', 'month'] },
    },
    additionalProperties: false,
  };
  readonly outputSchema = {
    type: 'object',
    description: 'Personal KPI coaching summary for the acting stylist only.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = [] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'low' as const;
  readonly cachePolicy = { ttlSeconds: 300, perTenant: true } as const;
  readonly rateLimit = { perMinute: 10 } as const;
  readonly requiresStaffSelf = true;
  readonly enabled = false;

  async execute(
    _actor: AuthUser,
    _context: ZacActingContext,
    _input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    return {
      status: 'not_connected',
      data: null,
      explanation:
        'Personal coaching data is not connected yet — this Week 1 skeleton returns no live figures.',
      rowCount: null,
    };
  }
}
