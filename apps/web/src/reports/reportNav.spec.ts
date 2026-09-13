/**
 * Report navigation from the registry: the same fail-closed decision as the API,
 * availability kept separate from permission, and filters carried between
 * reports only where the target supports them.
 */
import {
  ALL_PERMISSIONS,
  REPORT_DEFINITIONS,
  type AuthUser,
  type Permission,
  type ReportAccessUser,
  type ReportDefinition,
} from '@sheer/domain';
import { buildReportNavGroup, isReportPath, reportLinkSearch, reportPath } from './reportNav';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ON = { foundationShell: true };
const OFF = { foundationShell: false };
const MANAGER_LEVEL: Permission[] = ['report.dashboard.view', 'report.performance.view', 'report.commission.view', 'report.financials.view', 'report.lab_analytics.view'];

const owner: ReportAccessUser = { roles: ['owner'] };
const managerLevel: ReportAccessUser = { roles: ['manager'], membershipGrants: [{ locationId: A, permissions: MANAGER_LEVEL }] };
const nullLevelManager = { roles: ['manager'], permissions: [...ALL_PERMISSIONS], membershipGrants: [] } as unknown as AuthUser;
const receptionist: ReportAccessUser = { roles: ['manager'], membershipGrants: [{ locationId: A, permissions: ['bookings.manage', 'eod.manage'] }] };
const managerAPlusStylistB = { roles: ['manager', 'stylist'], allowedLocationIds: [A, B], membershipGrants: [{ locationId: A, permissions: MANAGER_LEVEL }] } as unknown as AuthUser;
const customPnl: ReportAccessUser = { roles: ['manager'], membershipGrants: [{ locationId: A, permissions: [...MANAGER_LEVEL, 'report.pnl.view'] }] };
const noFinancials: ReportAccessUser = { roles: ['manager'], membershipGrants: [{ locationId: A, permissions: MANAGER_LEVEL.filter((p) => p !== 'report.financials.view') }] };

const keysFor = (user: ReportAccessUser | null, surface = ON, definitions?: readonly ReportDefinition[]) =>
  buildReportNavGroup(user, surface, '/dashboard', '', definitions)?.entries.map((entry) => entry.key) ?? null;

describe('buildReportNavGroup', () => {
  it('shows no Reports group at all while the foundation shell is off and nothing is released', () => {
    for (const user of [owner, managerLevel, customPnl]) expect(keysFor(user, OFF)).toBeNull();
  });

  it('with the shell on, lists exactly the reports each user may open', () => {
    expect(keysFor(owner)).toEqual(['money', 'cash-up', 'team', 'colour-lab', 'pnl']);
    expect(keysFor(managerLevel)).toEqual(['money', 'cash-up', 'team', 'colour-lab']);
    expect(keysFor(managerAPlusStylistB)).toEqual(['money', 'cash-up', 'team', 'colour-lab']);
    expect(keysFor(customPnl)).toEqual(['money', 'cash-up', 'team', 'colour-lab', 'pnl']);
    expect(keysFor(noFinancials)).toEqual(['team', 'colour-lab']);
  });

  it('fails closed: a NULL-level manager, a receptionist and no user get no group', () => {
    expect(keysFor(nullLevelManager)).toBeNull();
    expect(keysFor(receptionist)).toBeNull();
    expect(keysFor(null)).toBeNull();
  });

  it('labels the group as a preview while it holds unreleased reports', () => {
    expect(buildReportNavGroup(owner, ON, '/dashboard', '')?.label).toBe('Reports (preview)');
  });

  it('shows a released report with the shell off, labelled plainly, to permitted users only', () => {
    const released = REPORT_DEFINITIONS.map((d) => (d.key === 'money' ? { ...d, release: 'released' as const } : d));
    expect(keysFor(managerLevel, OFF, released)).toEqual(['money']);
    expect(buildReportNavGroup(managerLevel, OFF, '/dashboard', '', released)?.label).toBe('Reports');
    expect(keysFor(receptionist, OFF, released)).toBeNull();
  });

  it('links point at /reports/<key>, with the pathname kept separate from the query', () => {
    const group = buildReportNavGroup(owner, ON, '/reports/money', '?preset=last_week');
    expect(group?.entries[0]).toEqual({ key: 'money', label: 'Money', to: '/reports/money', search: '?preset=last_week' });
  });
});

describe('reportLinkSearch — carrying a filter between reports', () => {
  const team = REPORT_DEFINITIONS.find((d) => d.key === 'team') as ReportDefinition;
  const cashUp = REPORT_DEFINITIONS.find((d) => d.key === 'cash-up') as ReportDefinition;

  it('carries dates and locations; view only to a report with a detail view', () => {
    const search = `?preset=last_week&locations=${A}&view=detail`;
    expect(reportLinkSearch(team, '/reports/money', search)).toBe(`?preset=last_week&locations=${A}`);
    expect(reportLinkSearch(cashUp, '/reports/money', search)).toBe(`?preset=last_week&locations=${A}&view=detail`);
  });

  it('carries a custom range as given', () => {
    expect(reportLinkSearch(team, '/reports/money', '?preset=custom&from=2026-09-22&to=2026-09-29')).toBe(
      '?preset=custom&from=2026-09-22&to=2026-09-29',
    );
  });

  it('never carries staff (no report supports it yet) or a broken filter', () => {
    expect(reportLinkSearch(team, '/reports/money', `?staff=${A}&preset=yesterday`)).toBe('?preset=yesterday');
    expect(reportLinkSearch(team, '/reports/money', '?preset=custom&from=2026-09-29&to=2026-09-01')).toBe('');
    expect(reportLinkSearch(team, '/reports/money', '?locations=bogus')).toBe('');
  });

  it('carries nothing from a page that is not a report', () => {
    expect(reportLinkSearch(team, '/dashboard', '?preset=last_week')).toBe('');
  });
});

describe('paths', () => {
  it('recognises report pages only', () => {
    expect(isReportPath('/reports')).toBe(true);
    expect(isReportPath('/reports/money')).toBe(true);
    expect(isReportPath('/reportsx')).toBe(false);
    expect(isReportPath('/dashboard')).toBe(false);
    expect(reportPath(REPORT_DEFINITIONS[4])).toBe('/reports/pnl');
  });
});
