/**
 * The report access predicates — the ONE decision the API guard, the web route
 * gate and the sidebar share.
 *
 * These tests feed grants directly. How membership rows become grants (and why
 * a NULL level or a stylist row never does) is pinned in
 * auth/membership-grants.spec.ts, and the two are joined end to end in
 * report-access-matrix.spec.ts.
 */
import {
  ALL_PERMISSIONS,
  REPORT_DEFINITIONS,
  canOpenReport,
  getReportDefinition,
  reportAccessDecision,
  reportLocationIds,
  type AuthUser,
  type MembershipGrant,
  type Permission,
  type ReportAccessUser,
  type ReportDefinition,
} from '@sheer/domain';

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';
const C = '00000000-0000-4000-8000-00000000000c';
const FOREIGN = '00000000-0000-4000-8000-0000000000ff';
const BUSINESS = [A, B, C];

const money = getReportDefinition('money') as ReportDefinition;
const pnl = getReportDefinition('pnl') as ReportDefinition;
const team = getReportDefinition('team') as ReportDefinition;

const grant = (locationId: string, permissions: Permission[]): MembershipGrant => ({ locationId, permissions });
const managerUser = (grants: MembershipGrant[] | undefined): ReportAccessUser => ({
  roles: ['manager'],
  ...(grants ? { membershipGrants: grants } : {}),
});

describe('canOpenReport', () => {
  it('lets an owner open every report without any grant', () => {
    const owner: ReportAccessUser = { roles: ['owner'] };
    for (const definition of REPORT_DEFINITIONS) expect(canOpenReport(owner, definition)).toBe(true);
  });

  it('lets a non-owner open a report only through a grant carrying its permission', () => {
    const user = managerUser([grant(A, ['report.financials.view'])]);
    expect(canOpenReport(user, money)).toBe(true);
    expect(canOpenReport(user, team)).toBe(false);
    expect(canOpenReport(user, pnl)).toBe(false);
  });

  it('fails closed for a missing user, absent grants and empty grants', () => {
    expect(canOpenReport(null, money)).toBe(false);
    expect(canOpenReport(undefined, money)).toBe(false);
    expect(canOpenReport(managerUser(undefined), money)).toBe(false);
    expect(canOpenReport(managerUser([]), money)).toBe(false);
    expect(canOpenReport(managerUser([grant(A, [])]), money)).toBe(false);
  });

  it('never reads the merged AuthUser.permissions or allowedLocationIds', () => {
    const user = {
      roles: ['manager', 'stylist'],
      permissions: [...ALL_PERMISSIONS],
      allowedLocationIds: [A, B],
      membershipGrants: [],
    } as unknown as AuthUser;
    for (const definition of REPORT_DEFINITIONS) {
      expect(canOpenReport(user, definition)).toBe(false);
      expect(reportLocationIds(user, definition, BUSINESS)).toEqual([]);
    }
  });

  it('does not depend on whether a report is released', () => {
    const user = managerUser([grant(A, ['report.financials.view'])]);
    const released: ReportDefinition = { ...money, release: 'released' };
    expect(canOpenReport(user, released)).toBe(canOpenReport(user, money));
    expect(canOpenReport(managerUser([]), released)).toBe(false);
  });
});

describe('reportLocationIds', () => {
  it('gives an owner every business location, sorted', () => {
    expect(reportLocationIds({ roles: ['owner'] }, money, [C, A, B])).toEqual([A, B, C]);
  });

  it('gives a non-owner only the locations whose grant carries the report permission', () => {
    const user = managerUser([
      grant(A, ['report.financials.view', 'report.performance.view']),
      grant(C, ['report.performance.view']),
    ]);
    expect(reportLocationIds(user, money, BUSINESS)).toEqual([A]);
    expect(reportLocationIds(user, team, BUSINESS)).toEqual([A, C]);
    expect(reportLocationIds(user, pnl, BUSINESS)).toEqual([]);
  });

  it('never adds a location from allowedLocationIds (manager@A + stylist@B)', () => {
    const user = {
      roles: ['manager', 'stylist'],
      allowedLocationIds: [A, B],
      membershipGrants: [grant(A, ['report.financials.view'])],
    } as unknown as ReportAccessUser;
    expect(reportLocationIds(user, money, BUSINESS)).toEqual([A]);
  });

  it('drops a grant pointing at a location outside the business', () => {
    const user = managerUser([grant(FOREIGN, ['report.financials.view']), grant(B, ['report.financials.view'])]);
    expect(reportLocationIds(user, money, BUSINESS)).toEqual([B]);
  });

  it('dedupes repeated grants at one location', () => {
    const user = managerUser([grant(A, ['report.financials.view']), grant(A, ['report.financials.view'])]);
    expect(reportLocationIds(user, money, BUSINESS)).toEqual([A]);
  });
});

describe('reportAccessDecision', () => {
  const managerLevel = managerUser([grant(A, ['report.financials.view', 'report.performance.view', 'report.lab_analytics.view'])]);

  it('reports unavailable before anything else when the shell is off', () => {
    expect(reportAccessDecision({ roles: ['owner'] }, money, { foundationShell: false })).toBe('unavailable');
    expect(reportAccessDecision(null, money, { foundationShell: false })).toBe('unavailable');
  });

  it('with the shell on: owner allowed, manager allowed or forbidden by permission, no user forbidden', () => {
    const on = { foundationShell: true };
    expect(reportAccessDecision({ roles: ['owner'] }, pnl, on)).toBe('allowed');
    expect(reportAccessDecision(managerLevel, money, on)).toBe('allowed');
    expect(reportAccessDecision(managerLevel, pnl, on)).toBe('forbidden');
    expect(reportAccessDecision(managerUser([]), money, on)).toBe('forbidden');
    expect(reportAccessDecision(null, money, on)).toBe('forbidden');
  });

  it('a released report is available with the shell off, and permission still applies', () => {
    const released: ReportDefinition = { ...money, release: 'released' };
    const off = { foundationShell: false };
    expect(reportAccessDecision(managerLevel, released, off)).toBe('allowed');
    expect(reportAccessDecision(managerUser([]), released, off)).toBe('forbidden');
  });
});
