/**
 * Staff invitation + management — test scaffold.
 *
 * The repo has no Jest configuration committed yet (see apps/api/package.json
 * `"test": "jest --passWithNoTests"`). These `it.todo` entries record the
 * test cases that should be written when a Jest harness lands so the
 * coverage requirements from the staff invitation phase are not lost.
 *
 * When implementing:
 *   - mock SupabaseClient with `jest.fn()` covers for `.schema().from().select()`
 *     chains and for `.rpc()` results.
 *   - mock AuthService.login to return a fake session/user.
 *   - cover guard rails (assertOwner / location-in-business / no double invite).
 */

import { staleMembershipIds } from './staff.service';

// Pure guard behind the owner+stylist feature: an owner may take the stylist
// role on themselves via the Team page, and syncing their manager/stylist role
// SET must NEVER delete their (business-wide) owner membership. This is the one
// catastrophic path — losing ownership mid-request — so it is unit-tested for
// real rather than left as an integration `it.todo`.
describe('staleMembershipIds', () => {
  const owner = { id: 'm-owner', role: 'owner' as const };
  const stylist = { id: 'm-stylist', role: 'stylist' as const };
  const manager = { id: 'm-manager', role: 'manager' as const };

  it('never removes the owner membership, even when only stylist is kept', () => {
    // Owner adds the stylist role: keptIds holds the (new/updated) stylist row.
    const result = staleMembershipIds([owner, stylist], new Set([stylist.id]));
    expect(result).toEqual([]);
  });

  it('never removes the owner membership when the owner drops to owner-only', () => {
    // Owner turns stylist OFF: nothing is kept, but the owner row survives and
    // only the stylist row is deleted.
    const result = staleMembershipIds([owner, stylist], new Set());
    expect(result).toEqual([stylist.id]);
  });

  it('removes non-owner roles that are no longer desired', () => {
    // Regular member drops manager, keeps stylist.
    const result = staleMembershipIds([manager, stylist], new Set([stylist.id]));
    expect(result).toEqual([manager.id]);
  });

  it('keeps every membership whose id is in keptIds', () => {
    const result = staleMembershipIds([manager, stylist], new Set([manager.id, stylist.id]));
    expect(result).toEqual([]);
  });
});

describe('StaffService — invitations', () => {
  it.todo('owner can create a stylist invitation for a location in their business');
  it.todo('owner can create a manager invitation for a location in their business');
  it.todo('non-owner role is rejected with 403');
  it.todo('invitable role enum rejects owner / client values');
  it.todo('cannot invite to a location belonging to a different business');
  it.todo('cannot create a second pending invitation for the same email');
  it.todo('listInvitations filters by status when provided');
  it.todo('resendInvitation rotates the token + extends the expiry for pending invites');
  it.todo('resendInvitation rejects already-accepted invitations');
  it.todo('revokeInvitation transitions a pending invite to revoked');
});

describe('StaffService — invitation acceptance', () => {
  it.todo('rejects unknown / hashed-token-mismatch');
  it.todo('rejects accepted/revoked invitations');
  it.todo('marks expired invites as expired and rejects acceptance');
  it.todo('creates auth user + profile + active membership for stylist');
  it.todo('creates a staff_profile when role is stylist');
  it.todo('does not roll back an existing auth user when only linking');
  it.todo('rolls back the freshly-created auth user if RPC fails');
  it.todo('returns nextStep=dashboard with a session when auto sign-in succeeds');
  // Role-aware completion contract (post-account-creation flow).
  it.todo(
    'manager invitation acceptance returns targetSurface=web + nextAction=redirect_to_dashboard',
  );
  it.todo(
    'stylist invitation acceptance returns targetSurface=mobile + nextAction=show_completion_page',
  );
  it.todo('stylist invitation acceptance does NOT issue a web_dashboard session');
  it.todo(
    "stylist invitation acceptance redirects to '/auth/account-created?role=stylist'",
  );
  it.todo('response.role is always derived from the invitation row, never the request body');
});

describe('StaffService — staff management', () => {
  it.todo('owner can change role between manager and stylist');
  it.todo('owner can change location to another location in the same business');
  it.todo('cannot promote a member to owner via update');
  it.todo("cannot edit ANOTHER owner's account via the staff endpoint (self-edit is allowed)");
  it.todo('deactivateStaff sets membership status to suspended');
  it.todo('reactivateStaff sets membership status to active');
  it.todo('listStaff returns memberships hydrated with profiles, staffProfiles, and locations');
});

describe('StaffService — per-stylist service pricing', () => {
  // booking.staff_service_eligibility.price_amount: NULL inherits services.base_price.
  it.todo('serviceAssignments writes price_amount via set_staff_service_eligibility RPC (jsonb)');
  it.todo('serviceAssignments with priceAmount null/omitted stores NULL (inherits base price)');
  it.todo('legacy serviceIds[] still works and stores NULL prices for every service');
  it.todo('serviceAssignments takes precedence over serviceIds when both are sent');
  it.todo('rejects an assignment whose serviceId does not belong to the business');
  it.todo('rejects assigning services to a member without a staff profile');
  it.todo('listStaff hydrates staffProfile.servicePricing alongside serviceIds');
});

describe('StaffService — multi-role members', () => {
  // A member can hold several roles at their location (e.g. a working manager
  // who also does hair). Roles are managed as a SET keyed by user.
  it.todo('listStaff returns ONE row per user with roles[] (manager + stylist collapsed)');
  it.todo('update with roles:[manager,stylist] creates both membership rows at the location');
  it.todo('update that drops stylist removes the stylist membership and keeps manager');
  it.todo('removing the stylist role downgrades the staff profile to non-bookable (kept for history)');
  it.todo('adding the stylist role (re)creates a bookable staff profile, preserving existing fields');
  it.todo('update with empty roles[] is rejected for a NON-owner member (must keep at least one role)');
  it.todo('changing location moves ALL of the member\'s role memberships to the new location');
  it.todo('status-only update (deactivate/reactivate) applies to every role the member holds');
  it.todo('updating a member never touches their owner membership and cannot grant owner');
  it.todo('existing membership activated_at is preserved across edits');
});

describe('StaffService — owner as stylist (self-service)', () => {
  // An owner may take the stylist role at one of their locations via the Team
  // page (owner + stylist), keeping full owner access. See staleMembershipIds
  // for the unit-tested owner-preservation guard.
  it.todo('owner editing THEMSELVES with roles:[stylist] adds a stylist membership at the chosen location');
  it.todo('owner self-edit keeps the owner membership row (location_id stays NULL) — never deleted');
  it.todo('owner self-edit with roles:[stylist] creates a bookable staff_profile at the chosen location');
  it.todo('owner reverting to owner-only (roles:[]) removes the stylist membership but keeps ownership');
  it.todo('owner reverting to owner-only downgrades the staff profile to non-bookable (kept for history)');
  it.todo('owner self-edit ignores membershipStatus and always runs active (owner cannot deactivate self)');
  it.todo('owner-only self-edit (empty roles) does NOT require a location');
  it.todo('stylist self-edit requires a location that belongs to the business');
  it.todo('an owner editing a DIFFERENT owner is still rejected (403)');
  it.todo('a non-owner cannot reach the endpoint (assertOwner / RequireRoles)');
  it.todo('after taking stylist, findStaffMember returns roles [owner, stylist] with primaryRole owner');
});
