/**
 * The approved Ticket A actor matrix, end to end:
 * membership rows → resolveMembershipGrants (as auth.service runs it) →
 * canOpenReport / reportLocationIds (as the guard, route and sidebar run them).
 *
 * Levels use the real SYSTEM_SECURITY_LEVELS permissions, so a change to a
 * seeded level that would widen report access fails here.
 * docs/V1.1/week-8-ticket-a-foundation.md §2.
 */
import {
  REPORT_DEFINITIONS,
  SYSTEM_SECURITY_LEVELS,
  canOpenReport,
  reportLocationIds,
  sortRolesByPriority,
  type Permission,
  type ReportAccessUser,
  type ReportKey,
  type SystemSecurityLevelKey,
  type UserRole,
} from '@sheer/domain';
import {
  resolveMembershipGrants,
  type GrantMembershipRow,
  type GrantSecurityLevel,
} from '../auth/membership-grants';

const BIZ = 'biz-1';
const A = 'loc-a';
const B = 'loc-b';
const C = 'loc-c';
const CLOSED = 'loc-closed';
const FOREIGN_LOCATION = 'loc-foreign';
const BUSINESS_LOCATIONS = [A, B, C, CLOSED];

const systemPermissions = (key: SystemSecurityLevelKey): Permission[] =>
  [...(SYSTEM_SECURITY_LEVELS.find((level) => level.key === key)?.permissions ?? [])];

const LEVELS = new Map<string, GrantSecurityLevel>([
  ['owner-level', { businessId: BIZ, permissions: systemPermissions('owner') }],
  ['group-admin', { businessId: BIZ, permissions: systemPermissions('group_admin') }],
  ['manager', { businessId: BIZ, permissions: systemPermissions('manager') }],
  ['receptionist', { businessId: BIZ, permissions: systemPermissions('receptionist') }],
  ['stylist', { businessId: BIZ, permissions: systemPermissions('stylist') }],
  ['receptionist-with-financials', { businessId: BIZ, permissions: [...systemPermissions('receptionist'), 'report.financials.view'] }],
  ['custom-pnl', { businessId: BIZ, permissions: [...systemPermissions('manager'), 'report.pnl.view'] }],
  ['custom-no-financials', { businessId: BIZ, permissions: systemPermissions('manager').filter((p) => p !== 'report.financials.view') }],
  ['other-business-manager', { businessId: 'biz-2', permissions: systemPermissions('manager') }],
]);

type Row = [role: UserRole, location: string | null, level: string | null, status?: string];

function actor(rows: Row[], options: { omitGrants?: boolean } = {}): ReportAccessUser {
  const memberships: GrantMembershipRow[] = rows.map(([role, location, level, status]) => ({
    business_id: BIZ,
    location_id: location,
    role,
    status: status ?? 'active',
    security_level_id: level,
  }));
  const roles = sortRolesByPriority(memberships.filter((m) => m.status === 'active').map((m) => m.role));
  const membershipGrants = resolveMembershipGrants({
    businessId: BIZ,
    roles,
    memberships,
    levels: LEVELS,
    businessLocationIds: new Set(BUSINESS_LOCATIONS),
  });
  return {
    roles,
    ...(membershipGrants && !options.omitGrants ? { membershipGrants } : {}),
  };
}

/** For each report key: the locations it may be opened at, or '—'. */
function outcome(user: ReportAccessUser): Record<ReportKey, string> {
  const result = {} as Record<ReportKey, string>;
  for (const definition of REPORT_DEFINITIONS) {
    const open = canOpenReport(user, definition);
    const locations = reportLocationIds(user, definition, BUSINESS_LOCATIONS);
    // The two must agree: a report is openable exactly when it has a location.
    expect([definition.key, open]).toEqual([definition.key, locations.length > 0 || user.roles.includes('owner')]);
    result[definition.key] = open ? locations.join(',') : '—';
  }
  return result;
}

const ALL = [A, B, C, CLOSED].sort().join(',');
const four = (locations: string) => ({ money: locations, 'cash-up': locations, team: locations, 'colour-lab': locations, pnl: '—' });
const none = { money: '—', 'cash-up': '—', team: '—', 'colour-lab': '—', pnl: '—' };

describe('Ticket A report access matrix (fails closed, per membership)', () => {
  const cases: Array<[string, ReportAccessUser, Record<ReportKey, string>]> = [
    ['owner', actor([['owner', null, null]]), { money: ALL, 'cash-up': ALL, team: ALL, 'colour-lab': ALL, pnl: ALL }],
    ['owner who also works as a stylist', actor([['owner', null, null], ['stylist', A, 'stylist']]), { money: ALL, 'cash-up': ALL, team: ALL, 'colour-lab': ALL, pnl: ALL }],
    ['manager@A, Manager level', actor([['manager', A, 'manager']]), four(A)],
    ['manager@A, NULL level', actor([['manager', A, null]]), none],
    ['manager@A, Receptionist level (as seeded)', actor([['manager', A, 'receptionist']]), none],
    ['manager@A, Receptionist level an owner customised with Financials (explicit grant)', actor([['manager', A, 'receptionist-with-financials']]), { ...none, money: A, 'cash-up': A }],
    ['stylist@B, NULL level', actor([['stylist', B, null]]), none],
    ['stylist@B carrying the Manager level', actor([['stylist', B, 'manager']]), none],
    ['manager@A + stylist@B, Manager level on both rows', actor([['manager', A, 'manager'], ['stylist', B, 'manager']]), four(A)],
    ['manager@A NULL + stylist@A Manager level', actor([['manager', A, null], ['stylist', A, 'manager']]), none],
    ['manager@A Manager + manager@C from an invite (NULL level)', actor([['manager', A, 'manager'], ['manager', C, null]]), four(A)],
    ['Group Admin level on manager@A and manager@C', actor([['manager', A, 'group-admin'], ['manager', C, 'group-admin']]), four([A, C].join(','))],
    ['manager@A on the Owner system level', actor([['manager', A, 'owner-level']]), four(A)],
    ['manager@A, custom level with report.pnl.view', actor([['manager', A, 'custom-pnl']]), { ...four(A), pnl: A }],
    ['manager@A, custom level without report.financials.view', actor([['manager', A, 'custom-no-financials']]), { ...none, team: A, 'colour-lab': A }],
    ['manager at an inactive location, Manager level', actor([['manager', CLOSED, 'manager']]), four(CLOSED)],
    ['manager row at another business’s location', actor([['manager', FOREIGN_LOCATION, 'manager']]), none],
    ['manager@A, dangling level', actor([['manager', A, 'deleted-level']]), none],
    ['manager@A, another business’s level', actor([['manager', A, 'other-business-manager']]), none],
    ['manager@A suspended', actor([['manager', A, 'manager', 'suspended'], ['stylist', B, 'stylist']]), none],
    ['manager@A revoked', actor([['manager', A, 'manager', 'revoked'], ['stylist', B, 'stylist']]), none],
    ['manager@A invited', actor([['manager', A, 'manager', 'invited'], ['stylist', B, 'stylist']]), none],
    ['non-owner with membershipGrants absent', actor([['manager', A, 'manager']], { omitGrants: true }), none],
  ];

  it.each(cases)('%s', (_label, user, expected) => {
    expect(outcome(user)).toEqual(expected);
  });
});
