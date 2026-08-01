import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Week 1 skeleton — NOT connected. Week 2 wires this to the guarded
 * `DashboardService.stylistPerformance`. Stripping rules for the wired version:
 * commission fields require `report.commission.view`; pay/rate/target fields
 * require `staff.pay.manage`; present the computed performance target, not the
 * stored `performance_target_amount`.
 */
export class StylistPerformanceTool implements ZacReadOnlyTool {
  readonly name = 'report.stylist_performance' as const;
  readonly domain = 'report' as const;
  readonly description = 'Summarises stylist performance across the accessible locations.';
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
    description: 'Stylist performance summary with sensitive fields stripped by permission.',
  };
  readonly readOnly = true as const;
  readonly sensitiveFields = ['commission', 'pay_rate', 'performance_target'] as const;
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
        'Stylist performance data is not connected yet — this Week 1 skeleton returns no live figures.',
      rowCount: null,
    };
  }
}
