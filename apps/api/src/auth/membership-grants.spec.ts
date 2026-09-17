/**
 * resolveMembershipGrants — how membership rows become report grants.
 *
 * Fail-closed rules pinned here: only ACTIVE MANAGER memberships, at a location
 * of the business, with an EXPLICIT, existing, same-business security level.
 * No role defaults, no stylist rows, no missing or foreign levels.
 */
import { DEFAULT_ROLE_PERMISSIONS, type Permission, type UserRole } from '@sheer/domain';
import {
  resolveMembershipGrants,
  type GrantMembershipRow,
  type GrantSecurityLevel,
} from './membership-grants';

const BIZ = 'biz-1';
const OTHER_BIZ = 'biz-2';
const A = 'loc-a';
const B = 'loc-b';
const C = 'loc-c';
const CLOSED = 'loc-closed';
const LOCATIONS = new Set([A, B, C, CLOSED]);

const MANAGER_LEVEL = 'level-manager';
const FOREIGN_LEVEL = 'level-foreign';
const BOOKINGS_ONLY_LEVEL = 'level-bookings';

const levels = new Map<string, GrantSecurityLevel>([
  [MANAGER_LEVEL, { businessId: BIZ, permissions: ['report.financials.view', 'report.performance.view'] }],
  [FOREIGN_LEVEL, { businessId: OTHER_BIZ, permissions: ['report.financials.view'] }],
  [BOOKINGS_ONLY_LEVEL, { businessId: BIZ, permissions: ['bookings.manage'] }],
]);

const row = (
  role: UserRole,
  location: string | null,
  level: string | null,
  overrides: Partial<GrantMembershipRow> = {},
): GrantMembershipRow => ({
  business_id: BIZ,
  location_id: location,
  role,
  status: 'active',
  security_level_id: level,
  ...overrides,
});

const resolve = (roles: UserRole[], memberships: GrantMembershipRow[]) =>
  resolveMembershipGrants({ businessId: BIZ, roles, memberships, levels, businessLocationIds: LOCATIONS });

describe('resolveMembershipGrants', () => {
  it('gives an owner no grants at all (owners open every report through their role)', () => {
    expect(resolve(['owner', 'stylist'], [row('owner', null, null), row('stylist', A, MANAGER_LEVEL)])).toBeUndefined();
  });

  it('grants a manager membership its explicit level, expanded over prerequisites', () => {
    const grants = resolve(['manager'], [row('manager', A, BOOKINGS_ONLY_LEVEL)]);
    expect(grants).toHaveLength(1);
    expect(grants?.[0].locationId).toBe(A);
    // bookings.manage requires crm.view, services.view and rota.view.
    expect(grants?.[0].permissions).toEqual(expect.arrayContaining(['bookings.manage', 'crm.view', 'services.view', 'rota.view']));
    expect(grants?.[0].permissions.some((p) => p.startsWith('report.'))).toBe(false);
  });

  it('never falls back to role defaults: a NULL-level manager gets no grant', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.manager).toContain('report.financials.view');
    expect(resolve(['manager'], [row('manager', A, null)])).toEqual([]);
  });

  it('gives no grant for a dangling level or another business’s level', () => {
    expect(resolve(['manager'], [row('manager', A, 'level-deleted')])).toEqual([]);
    expect(resolve(['manager'], [row('manager', A, FOREIGN_LEVEL)])).toEqual([]);
  });

  it('never grants from a stylist membership, whatever its level', () => {
    expect(resolve(['stylist'], [row('stylist', B, MANAGER_LEVEL)])).toEqual([]);
  });

  it('manager@A + stylist@B with the same level: one grant, at A only', () => {
    const grants = resolve(['manager', 'stylist'], [row('manager', A, MANAGER_LEVEL), row('stylist', B, MANAGER_LEVEL)]);
    expect(grants?.map((g) => g.locationId)).toEqual([A]);
  });

  it('a NULL manager row next to a Manager-level stylist row grants nothing', () => {
    expect(resolve(['manager', 'stylist'], [row('manager', A, null), row('stylist', A, MANAGER_LEVEL)])).toEqual([]);
  });

  it('an invite-accepted manager row with a NULL level adds nothing beside a levelled row', () => {
    const grants = resolve(['manager'], [row('manager', A, MANAGER_LEVEL), row('manager', C, null)]);
    expect(grants?.map((g) => g.locationId)).toEqual([A]);
  });

  it('ignores suspended, revoked and invited memberships', () => {
    for (const status of ['suspended', 'revoked', 'invited']) {
      expect(resolve(['manager'], [row('manager', A, MANAGER_LEVEL, { status })])).toEqual([]);
    }
  });

  it('ignores client rows, rows with no location and rows from another business', () => {
    expect(resolve(['manager', 'client'], [row('client', A, MANAGER_LEVEL)])).toEqual([]);
    expect(resolve(['manager'], [row('manager', null, MANAGER_LEVEL)])).toEqual([]);
    expect(resolve(['manager'], [row('manager', A, MANAGER_LEVEL, { business_id: OTHER_BIZ })])).toEqual([]);
  });

  it('drops a location that is not one of the business’s locations', () => {
    expect(resolve(['manager'], [row('manager', 'loc-elsewhere', MANAGER_LEVEL)])).toEqual([]);
  });

  it('keeps a grant at an inactive business location', () => {
    expect(resolve(['manager'], [row('manager', CLOSED, MANAGER_LEVEL)])?.map((g) => g.locationId)).toEqual([CLOSED]);
  });

  it('returns one grant per location, sorted by location id', () => {
    const grants = resolve(['manager'], [row('manager', C, MANAGER_LEVEL), row('manager', A, BOOKINGS_ONLY_LEVEL)]);
    expect(grants?.map((g) => g.locationId)).toEqual([A, C]);
    const permissionsAtC: Permission[] = grants?.[1].permissions ?? [];
    expect(permissionsAtC).toEqual(['report.performance.view', 'report.financials.view']);
  });
});
