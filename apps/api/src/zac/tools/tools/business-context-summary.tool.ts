import type { AuthUser } from '@sheer/domain';
import type { ZacActingContext } from '../../context/zac-context.types';
import type { ZacReadOnlyTool, ZacToolResult } from '../zac-tool.types';

/**
 * Live Week 2 tool — safe, high-level business context for the acting user,
 * composed entirely from the guard-resolved acting context. No service or DB
 * call is involved, so there is nothing here `zac.access` alone could leak:
 * no financials, no client/staff data, no metrics — just what ZAC is looking
 * at and through which role.
 */
export class BusinessContextSummaryTool implements ZacReadOnlyTool {
  readonly name = 'context.business_summary' as const;
  readonly domain = 'context' as const;
  readonly description =
    'Explains which business and locations ZAC is looking at and what the acting role can see.';
  readonly allowedRoles = ['owner', 'manager'] as const;
  readonly requiredPermissions = [] as const;
  readonly anyOfPermissions = [] as const;
  readonly inputSchema = { type: 'object', properties: {}, additionalProperties: false };
  readonly outputSchema = {
    type: 'object',
    description: 'Business name/id, role context, accessible location count and scope summary.',
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
    if (!context.businessId) {
      return {
        status: 'unavailable',
        data: null,
        explanation: 'I could not resolve a business for your account, so I have nothing to summarise yet.',
        rowCount: null,
      };
    }

    const businessLabel = context.businessName ?? 'your business';
    const locationCount = context.accessibleLocations.length;
    const locationPhrase =
      locationCount === 0
        ? 'no locations yet'
        : locationCount === 1
          ? `1 location (${context.accessibleLocations[0].name})`
          : `${locationCount} locations`;

    const answer = [
      `I'm looking at ${businessLabel}, through your ${context.roleContext} role.`,
      `You have access to ${locationPhrase}${
        context.locationId ? ', and we are currently focused on one specific location' : ''
      }.`,
      `Everything I tell you stays inside that scope — I only ever see what your role is allowed to see.`,
    ].join(' ');

    return {
      status: 'ok',
      data: {
        business_id: context.businessId,
        business_name: context.businessName,
        role_context: context.roleContext,
        accessible_location_count: locationCount,
        focused_location_id: context.locationId,
      },
      explanation: 'Summarised from your signed-in role and scope — no business records were read.',
      rowCount: locationCount,
      presentation: {
        answer,
        evidence: [
          {
            source_type: 'auth.context',
            source_ref: 'resolved-acting-user',
            as_of: null,
            entities_used: [],
          },
        ],
        confidence: 'high',
        limitations: [
          'This is scope context only — no revenue, client, staff or operational data was read.',
        ],
        suggestedNextStep: 'Ask "What can you help me with?" to see what I can do inside this scope.',
        responseType: 'Explanation',
      },
    };
  }
}
