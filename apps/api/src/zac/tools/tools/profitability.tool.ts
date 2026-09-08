import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Expanded Intelligence — the PROFITABILITY domain, registered and DISABLED.
 *
 * Registering a disabled tool is not a placeholder for its own sake. Without
 * it, "what is my profit margin?" has no intent to land on, falls through to
 * the capability summary, and is answered with copy about what ZAC can do —
 * which reads as evasion. With it, the registry returns `not_connected` and the
 * user is told the truth: the number does not exist to be read.
 *
 * WHY IT CANNOT BE ENABLED TODAY. `billing.location_fixed_costs` has a full
 * CRUD path, so fixed costs can be entered — but there is no canonical QLOOQO
 * profitability computation to call, and no target with provenance to judge a
 * result against. ZAC's rule is that QLOOQO owns every reporting formula; a
 * margin invented inside ZAC would be a second source of truth that disagrees
 * with the dashboard the day either changes. Service delivery cost is not
 * tracked at all, so even a hand-rolled figure would be revenue minus overhead,
 * not profit.
 *
 * The one genuinely recorded margin in the platform — retail cost at the till —
 * is reported by `report.retail_performance`, scoped explicitly to retail and
 * never described as business profit.
 *
 * Enabling this is a Workstream 2 decision that starts with a canonical
 * computation in QLOOQO, not with a change here.
 */
export class ProfitabilityTool implements ZacReadOnlyTool {
  readonly name = 'report.profitability' as const;
  readonly domain = 'report' as const;
  readonly description = 'Business profitability and margin. Not connected: no canonical source.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['report.financials.view'] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  readonly outputSchema = {
    type: 'object',
    description: 'Profitability summary (not connected in Phase 1 / Workstream 1).',
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
  /**
   * The generic "not connected yet" would promise a figure that is coming.
   * Nothing is coming until QLOOQO itself computes profitability, so the tool
   * says exactly that instead.
   */
  readonly notConnectedExplanation =
    'QLOOQO tracks revenue and fixed costs, but it has no profitability calculation for me to read, and the cost of delivering a service is not recorded anywhere — so there is no profit figure to give you, and I will not estimate one. Retail gross margin is available separately, where product cost was recorded at the till.';

  async execute(
    _actor: AuthUser,
    _context: ZacActingContext,
    _input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    return {
      status: 'not_connected',
      data: null,
      explanation:
        'Profit and margin are not connected to ZAC: QLOOQO tracks revenue and fixed costs but has no profitability calculation for me to read, and service delivery costs are not recorded at all. I will not estimate one. Retail gross margin, where product cost was recorded at the till, is available separately.',
      rowCount: null,
    };
  }
}
