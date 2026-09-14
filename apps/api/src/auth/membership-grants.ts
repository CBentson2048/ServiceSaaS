import { expandPermissions } from '@sheer/domain';
import type { MembershipGrant, Permission, UserRole } from '@sheer/domain';

/**
 * Per-membership report grants (QLOOQO 10, V1.1 Week 8 Ticket A).
 *
 * The merged `AuthUser.permissions` unions every membership and, for a
 * membership with no security level, falls back to the base-role defaults. That
 * is right for the V1 feature gates it serves, and wrong for management reports
 * twice over:
 *
 * - A front-desk user and a manager look identical when neither has a level
 *   (there is no receptionist role), so a role default would hand front desk
 *   every report.
 * - A level is written to every manager AND stylist row of a person, so a union
 *   would let a manager@A who is a stylist@B report on B.
 *
 * So a grant exists only for an ACTIVE MANAGER membership, at a location of the
 * business, whose security level is EXPLICITLY assigned, still exists and
 * belongs to the same business. Nothing else grants: no role default, no
 * stylist row, no missing or foreign level. Pure — auth.service supplies rows.
 */

export interface GrantMembershipRow {
  business_id: string;
  location_id: string | null;
  role: UserRole;
  status: string;
  security_level_id: string | null;
}

export interface GrantSecurityLevel {
  businessId: string;
  /** Already stripped to catalogue keys. */
  permissions: readonly Permission[];
}

export function resolveMembershipGrants(input: {
  businessId: string;
  roles: readonly UserRole[];
  memberships: readonly GrantMembershipRow[];
  levels: ReadonlyMap<string, GrantSecurityLevel>;
  /** Every location of the business, inactive included. */
  businessLocationIds: ReadonlySet<string>;
}): MembershipGrant[] | undefined {
  // Owners open every report through their role; they carry no grants.
  if (input.roles.includes('owner')) return undefined;

  const byLocation = new Map<string, Set<Permission>>();
  for (const membership of input.memberships) {
    if (membership.status !== 'active') continue;
    if (membership.role !== 'manager') continue;
    if (membership.business_id !== input.businessId) continue;
    const locationId = membership.location_id;
    if (!locationId || !input.businessLocationIds.has(locationId)) continue;
    const levelId = membership.security_level_id;
    if (!levelId) continue;
    const level = input.levels.get(levelId);
    if (!level || level.businessId !== input.businessId) continue;

    const permissions = byLocation.get(locationId) ?? new Set<Permission>();
    for (const permission of expandPermissions(level.permissions)) permissions.add(permission);
    byLocation.set(locationId, permissions);
  }

  return [...byLocation.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([locationId, permissions]) => ({ locationId, permissions: expandPermissions(permissions) }));
}
