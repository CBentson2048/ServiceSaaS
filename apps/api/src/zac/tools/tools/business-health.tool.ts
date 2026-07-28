import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Week 1 skeleton — NOT connected. Week 2 wires this to the guarded
 * `DashboardService.kpis` (plus an optional lab-analytics block gated separately
 * on `report.lab_analytics.view`), passing the resolved actor through unchanged.
 * "Business health" means revenue & activity health — not a P&L; no cost or
 * profit lines exist in the platform yet.
 */
export class BusinessHealthSummaryTool implements ZacReadOnlyTool {
  readonly name = 'report.business_health' as const;
  readonly domain = 'report' as const;
  readonly description =
    'Summarises revenue and activity health for the business from dashboard KPIs.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['report.dashboard.view'] as const;
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
    description: 'Dashboard KPI summary with as-of timestamps and the location scope aggregated.',
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
        'Business health data is not connected yet — this Week 1 skeleton returns no live figures.',
      rowCount: null,
    };
  }
}
