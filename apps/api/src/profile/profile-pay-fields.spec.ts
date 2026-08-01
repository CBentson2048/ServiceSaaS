import type { AdminUpdateProfileRequest, AuthUser, Permission } from '@sheer/domain';
import { DEFAULT_ROLE_PERMISSIONS, userHasPermission } from '@sheer/domain';
import {
  PAY_DETERMINING_PROFILE_FIELDS,
  changesPayDeterminingProfileFields,
  mayViewPayFields,
} from './profile.service';
import {
  PAY_DETERMINING_STAFF_FIELDS,
  changesPayDeterminingFields,
} from '../staff/staff.service';

/**
 * There are TWO write paths to the pay-determining columns on
 * core.staff_profiles, and both must require `staff.pay.manage`:
 *
 *   1. PATCH /staff/:userProfileId      -> StaffService.updateStaffMember
 *   2. PATCH /profiles/:userProfileId   -> ProfileService.updateProfileAsAdmin
 *
 * The second was unguarded: its only check was @RequireRoles('owner','manager'),
 * and profile.service.ts contained no permission check of any kind. A manager
 * holding just `staff.manage` could therefore set a stylist's hourly rate, or
 * their average bill benchmark — which payroll accelerator conditions with
 * `basis = 'staff_benchmark'` read, moving the stylist between commission band
 * rates. Guarding only path 1 left the escalation fully open.
 *
 * These tests exercise the real authorization decision: the exported field
 * predicate composed with the real userHasPermission() from @sheer/domain,
 * against realistic AuthUser shapes.
 */

function actor(permissions: Permission[]): AuthUser {
  return {
    id: 'user-1',
    email: 'manager@salon.test',
    businessId: 'biz-1',
    roles: ['manager'],
    primaryRole: 'manager',
    permissions,
    allowedLocationIds: ['loc-1'],
    locationScope: 'location',
  } as unknown as AuthUser;
}

/** A manager on the bare role default — the realistic un-assigned case. */
const staffManageOnly = actor([...DEFAULT_ROLE_PERMISSIONS.manager, 'staff.manage']);
const payManager = actor([...DEFAULT_ROLE_PERMISSIONS.manager, 'staff.manage', 'staff.pay.manage']);

/** The decision each service makes before writing. */
const profileWriteDenied = (a: AuthUser, input: AdminUpdateProfileRequest) =>
  changesPayDeterminingProfileFields(input) && !userHasPermission(a, 'staff.pay.manage');

const staffWriteDenied = (a: AuthUser, input: Record<string, unknown>) =>
  changesPayDeterminingFields(input as never) && !userHasPermission(a, 'staff.pay.manage');

const update = (patch: Record<string, unknown>) => patch as AdminUpdateProfileRequest;

describe('the manager fixture is realistic', () => {
  it('has staff.manage but NOT staff.pay.manage', () => {
    expect(userHasPermission(staffManageOnly, 'staff.manage')).toBe(true);
    expect(userHasPermission(staffManageOnly, 'staff.pay.manage')).toBe(false);
  });

  it('does not hold staff.pay.manage via the manager role default', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.manager).not.toContain('staff.pay.manage');
  });
});

describe('PATCH /profiles — pay-determining fields', () => {
  it.each(PAY_DETERMINING_PROFILE_FIELDS)(
    'denies %s to an actor with staff.manage only',
    (field) => {
      expect(profileWriteDenied(staffManageOnly, update({ [field]: 1 }))).toBe(true);
    },
  );

  it.each(PAY_DETERMINING_PROFILE_FIELDS)('allows %s with staff.pay.manage', (field) => {
    expect(profileWriteDenied(payManager, update({ [field]: 1 }))).toBe(false);
  });

  it('covers exactly the three pay fields this endpoint can write', () => {
    // Tripwire: if AdminUpdateProfileRequest gains employmentType or
    // holidayEntitlementDays, they must be added to the guarded list.
    expect([...PAY_DETERMINING_PROFILE_FIELDS].sort()).toEqual([
      'averageBillBenchmark',
      'contractedHours',
      'hourlyRate',
    ]);
  });

  it('allows ordinary profile edits with staff.manage only', () => {
    expect(
      profileWriteDenied(
        staffManageOnly,
        update({ firstName: 'Jane', lastName: 'Doe', staffDisplayName: 'Jane', leaveNotes: 'Back Tuesday', isBookable: true }),
      ),
    ).toBe(false);
  });

  it('denies a mixed update that hides a pay field among safe ones', () => {
    expect(
      profileWriteDenied(staffManageOnly, update({ staffDisplayName: 'Jane', hourlyRate: 30 })),
    ).toBe(true);
  });

  it('denies a ZERO benchmark, the value that silently unlocks the accelerator', () => {
    expect(profileWriteDenied(staffManageOnly, update({ averageBillBenchmark: 0 }))).toBe(true);
  });

  it('treats an explicit undefined as absent, matching PATCH semantics', () => {
    expect(profileWriteDenied(staffManageOnly, update({ hourlyRate: undefined }))).toBe(false);
  });
});

describe('GET /profiles — reading pay-determining fields', () => {
  const OTHER = 'user-2';

  it('hides a colleague’s pay figures from a manager with staff.manage only', () => {
    // The old gate was userHasAnyRole(['owner','manager']), so this returned true.
    expect(mayViewPayFields(staffManageOnly, OTHER)).toBe(false);
  });

  it('shows a colleague’s pay figures to a holder of staff.pay.manage', () => {
    expect(mayViewPayFields(payManager, OTHER)).toBe(true);
  });

  it('always lets someone see their OWN pay figures', () => {
    expect(mayViewPayFields(staffManageOnly, staffManageOnly.id)).toBe(true);
  });

  it('hides pay figures from a receptionist-level user, whose base role is manager', () => {
    // The exact case the role-based gate got wrong: 'receptionist' is not a role,
    // so such a user reads as a manager.
    const receptionist = actor(['bookings.manage', 'crm.view', 'crm.manage', 'retail.record', 'services.view', 'rota.view']);
    expect(mayViewPayFields(receptionist, OTHER)).toBe(false);
  });

  it('hides pay figures from a stylist looking at a colleague', () => {
    const stylist = actor([...DEFAULT_ROLE_PERMISSIONS.stylist]);
    expect(mayViewPayFields(stylist, OTHER)).toBe(false);
    expect(mayViewPayFields(stylist, stylist.id)).toBe(true);
  });
});

describe('both write paths agree', () => {
  it('neither path lets staff.manage alone write a pay field', () => {
    expect(profileWriteDenied(staffManageOnly, update({ hourlyRate: 30 }))).toBe(true);
    expect(staffWriteDenied(staffManageOnly, { hourlyRate: 30 })).toBe(true);
  });

  it('both paths let staff.pay.manage write a pay field', () => {
    expect(profileWriteDenied(payManager, update({ hourlyRate: 30 }))).toBe(false);
    expect(staffWriteDenied(payManager, { hourlyRate: 30 })).toBe(false);
  });

  it('the profile field list is a subset of the staff field list', () => {
    // The profile endpoint writes fewer columns, but every one it does write
    // must also be protected on the richer staff endpoint.
    for (const field of PAY_DETERMINING_PROFILE_FIELDS) {
      expect(PAY_DETERMINING_STAFF_FIELDS).toContain(field);
    }
  });

  it('neither path blocks an ordinary edit for staff.manage', () => {
    expect(profileWriteDenied(staffManageOnly, update({ staffDisplayName: 'Jane' }))).toBe(false);
    expect(staffWriteDenied(staffManageOnly, { leaveNotes: 'Back Tuesday' })).toBe(false);
  });
});
