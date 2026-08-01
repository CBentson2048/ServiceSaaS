import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Live Week 2 tool — safe location context from the acting user's resolved
 * scope. Location names come only from the guard-resolved context, which the
 * context resolver has already filtered to the actor's accessible set — other
 * businesses' or out-of-scope locations can never appear here. No operational
 * data (bookings, revenue, stock) is included.
 */
export class LocationContextSummaryTool implements ZacReadOnlyTool {
  readonly name = 'context.location_summary' as const;
  readonly domain = 'context' as const;
  readonly description = 'Lists the locations the acting user can see and the current focus.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = [] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  readonly outputSchema = {
    type: 'object',
    description: 'Accessible location count, names, and the currently focused location if any.',
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

  async execute(
    _actor: AuthUser,
    context: ZacActingContext,
    _input: Record<string, unknown>,
  ): Promise<ZacToolResult> {
    const locations = context.accessibleLocations;
    if (locations.length === 0) {
      return {
        status: 'unavailable',
        data: null,
        explanation:
          'No locations are visible to your role yet, so I have no location context to share.',
        rowCount: 0,
      };
    }

    const focused = context.locationId
      ? locations.find((location) => location.id === context.locationId) ?? null
      : null;
    const names = locations.map((location) => location.name);
    const answer = [
      locations.length === 1
        ? `You have access to one location: ${names[0]}.`
        : `You have access to ${locations.length} locations: ${names.join(', ')}.`,
      focused
        ? `We're currently focused on ${focused.name}.`
        : 'Ask me about a specific location any time and I will focus there.',
    ].join(' ');

    return {
      status: 'ok',
      data: {
        accessible_location_count: locations.length,
        accessible_location_ids: locations.map((location) => location.id),
        focused_location_id: context.locationId,
      },
      explanation: 'Listed from your signed-in scope — no location records were read.',
      rowCount: locations.length,
      presentation: {
        answer,
        evidence: [
          {
            source_type: 'auth.context',
            source_ref: 'resolved-location-scope',
            as_of: null,
            entities_used: [],
          },
        ],
        confidence: 'high',
        limitations: [
          'Names and counts only — no bookings, revenue or stock data per location yet.',
        ],
        suggestedNextStep:
          'Try "How is my business doing?" for a health snapshot across these locations.',
        responseType: 'Explanation',
      },
    };
  }
}
