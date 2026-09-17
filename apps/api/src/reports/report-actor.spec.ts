/**
 * toReportActor — the one place an AuthUser becomes something reporting may
 * read. A fallback here (e.g. rebuilding grants from merged permissions and
 * visible locations when a user has none) would open reports to every NULL-level
 * manager and front-desk user, so it is pinned directly, with users shaped as
 * resolveAuthUser really builds them.
 */
import { ALL_PERMISSIONS, DEFAULT_ROLE_PERMISSIONS, canOpenReport, getReportDefinition, reportLocationIds, type AuthUser, type ReportDefinition } from '@sheer/domain';
import { toReportActor } from './report-actor';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const base = {
  id: 'user-1',
  businessId: 'biz-1',
  primaryRole: 'manager',
  profile: { id: 'user-1', email: 'x@example.com', fullName: 'X' },
} as const;

const nullLevelManager = {
  ...base,
  roles: ['manager'],
  permissions: [...DEFAULT_ROLE_PERMISSIONS.manager],
  allowedLocationIds: [A, B],
  locations: [{ id: A, name: 'London' }, { id: B, name: 'Tokyo' }],
  locationScope: { kind: 'locations', locationIds: [A, B] },
  membershipGrants: [],
} as unknown as AuthUser;

const managerAPlusStylistB = {
  ...base,
  roles: ['manager', 'stylist'],
  permissions: [...ALL_PERMISSIONS],
  allowedLocationIds: [A, B],
  locations: [{ id: A, name: 'London' }, { id: B, name: 'Tokyo' }],
  locationScope: { kind: 'locations', locationIds: [A, B] },
  membershipGrants: [{ locationId: A, permissions: ['report.financials.view'] }],
} as unknown as AuthUser;

const owner = { ...base, roles: ['owner'], primaryRole: 'owner', permissions: [...ALL_PERMISSIONS], allowedLocationIds: [A, B], locations: [] } as unknown as AuthUser;

const money = getReportDefinition('money') as ReportDefinition;

describe('toReportActor', () => {
  it('carries exactly id, businessId, roles and membershipGrants — never merged permissions or locations', () => {
    for (const auth of [nullLevelManager, managerAPlusStylistB]) {
      const actor = toReportActor(auth);
      expect(Object.keys(actor).sort()).toEqual(['businessId', 'id', 'membershipGrants', 'roles']);
      expect(JSON.stringify(actor)).not.toMatch(/allowedLocationIds|locationScope|"locations"|"permissions":\[(?!"report)/);
    }
  });

  it('keeps an empty grant list empty: a NULL-level manager opens nothing, anywhere', () => {
    const actor = toReportActor(nullLevelManager);
    expect(actor.membershipGrants).toEqual([]);
    expect(canOpenReport(actor, money)).toBe(false);
    expect(reportLocationIds(actor, money, [A, B])).toEqual([]);
  });

  it('copies grants exactly, as new objects', () => {
    const actor = toReportActor(managerAPlusStylistB);
    expect(actor.membershipGrants).toEqual(managerAPlusStylistB.membershipGrants);
    expect(actor.membershipGrants?.[0]).not.toBe(managerAPlusStylistB.membershipGrants?.[0]);
    expect(reportLocationIds(actor, money, [A, B])).toEqual([A]);
  });

  it('gives an owner no grants key', () => {
    const actor = toReportActor(owner);
    expect(Object.keys(actor).sort()).toEqual(['businessId', 'id', 'roles']);
    expect(canOpenReport(actor, money)).toBe(true);
  });

  it('is frozen, so a later caller cannot attach merged fields to it', () => {
    const actor = toReportActor(managerAPlusStylistB) as unknown as Record<string, unknown>;
    expect(Object.isFrozen(actor)).toBe(true);
    expect(() => {
      'use strict';
      actor.permissions = [...ALL_PERMISSIONS];
    }).toThrow();
  });
});
