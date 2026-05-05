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
});

describe('StaffService — staff management', () => {
  it.todo('owner can change role between manager and stylist');
  it.todo('owner can change location to another location in the same business');
  it.todo('cannot promote a member to owner via update');
  it.todo('cannot edit owner accounts via the staff endpoint');
  it.todo('deactivateStaff sets membership status to suspended');
  it.todo('reactivateStaff sets membership status to active');
  it.todo('listStaff returns memberships hydrated with profiles, staffProfiles, and locations');
});
