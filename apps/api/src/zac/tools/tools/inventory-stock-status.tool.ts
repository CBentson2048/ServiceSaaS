import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Placeholder contract only — stock stays at feasibility for Phase 1 Week 1.
 * A future week may wire this to the guarded `InventoryService` low-stock/stock
 * listings, gated on a data-feasibility probe (initialised location stock +
 * thresholds). Visibility summary ONLY: no forecasting, no ordering predictions,
 * no automated or over-ordering detection, no expiry automation — all explicitly
 * out of scope for Phase 1.
 */
export class InventoryStockStatusTool implements ZacReadOnlyTool {
  readonly name = 'inventory.stock_status' as const;
  readonly domain = 'inventory' as const;
  readonly description = 'Summarises current stock visibility and low-stock items.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = ['inventory.manage'] as const;
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
    description: 'Stock visibility summary (feasibility-gated; placeholder in Phase 1 Week 1).',
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

  async execute(
    _actor: AuthUser,
    _context: ZacActingContext,
    _input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    return {
      status: 'not_connected',
      data: null,
      explanation:
        'Stock visibility is at feasibility stage — no live inventory data is connected to ZAC yet.',
      rowCount: null,
    };
  }
}
