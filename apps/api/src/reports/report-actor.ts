import type { AuthUser, MembershipGrant, ReportDefinition } from '@sheer/domain';
import type { AuthenticatedRequest } from '../auth/types';

/**
 * The only parts of the signed-in user reporting may see. It deliberately has
 * no `permissions` and no `allowedLocationIds`: both are unions across every
 * membership (with role-default fallback), and reading either would let a
 * manager@A who is a stylist@B report on B.
 */
export interface ReportActor {
  readonly id: string;
  readonly businessId: string;
  readonly roles: readonly AuthUser['roles'][number][];
  readonly membershipGrants?: readonly MembershipGrant[];
}

/**
 * Copies — never spreads — the fields reporting needs, so the merged fields do
 * not travel with the object at runtime whatever a later caller casts it to.
 */
export function toReportActor(auth: AuthUser): ReportActor {
  return Object.freeze({
    id: auth.id,
    businessId: auth.businessId,
    roles: Object.freeze([...auth.roles]),
    ...(auth.membershipGrants
      ? {
          membershipGrants: Object.freeze(
            auth.membershipGrants.map((grant) =>
              Object.freeze({ locationId: grant.locationId, permissions: [...grant.permissions] }),
            ),
          ),
        }
      : {}),
  });
}

/** A request that has passed the report guards. */
export interface ReportRequest extends AuthenticatedRequest {
  reportDefinition?: ReportDefinition;
}
