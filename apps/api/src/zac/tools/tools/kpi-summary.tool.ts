import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Week 1 skeleton — NOT connected. Week 2 wires this to the guarded
 * `KpiService.stylistList`. Commission figures are sensitive: they must be
 * stripped from the output unless the actor holds `report.commission.view`
 * (holding only `report.performance.view` yields the commission-free view).
 */
export class KpiSummaryTool implements ZacReadOnlyTool {
  readonly name = 'report.kpi_summary' as const;
  readonly domain = 'report' as const;
  readonly description = 'Summarises stylist KPI figures for the accessible locations.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = [] as const;
  readonly anyOfPermissions = ['report.commission.view', 'report.performance.view'] as const;
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
      'Stylist KPI list with data-quality notes surfaced (e.g. no_hours_worked) instead of degenerate zeros.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = ['commission'] as const;
  readonly errorBehavior = 'fail_closed' as const;
  readonly fallbackBehavior = 'state_unavailable' as const;
  readonly piiLevel = 'low' as const;
  readonly cachePolicy = { ttlSeconds: 300, perTenant: true } as const;
  readonly rateLimit = { perMinute: 10 } as const;
  readonly requiresStaffSelf = false;
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
        'KPI summary data is not connected yet — this Week 1 skeleton returns no live figures.',
      rowCount: null,
    };
  }
}
