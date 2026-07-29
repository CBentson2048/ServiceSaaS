import type { Permission, UserRole } from '@sheer/domain';

/** Role lens ZAC answers through. `client` is never a ZAC role context. */
export type ZacRoleContext = 'owner' | 'manager' | 'stylist';

export type ZacRequestSource = 'web_dashboard' | 'mobile_app';

/**
 * The resolved acting-user context threaded through a single ZAC turn.
 * Built once per request from the guard-verified {@link AuthUser} — never from
 * model output — and passed to every tool and permission check unchanged.
 */
export interface ZacActingContext {
  actorUserId: string;
  /** For greeting copy only — never logged and never sent to telemetry. */
  actorFirstName: string | null;
  businessId: string;
  /** Explicit single-location focus for the turn; null = aggregate across accessible locations. */
  locationId: string | null;
  /** Locations the actor may see; answers that aggregate must name these. */
  accessibleLocationIds: string[];
  /** Display/framing snapshot; permission gating always uses `roles` + `permissions`. */
  roleContext: ZacRoleContext;
  roles: UserRole[];
  permissions: Permission[];
  staffProfileId: string | null;
  requestSource: ZacRequestSource;
  timezone: string;
  locale: string;
}
