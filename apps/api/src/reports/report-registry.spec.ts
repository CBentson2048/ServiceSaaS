/**
 * The report registry and the permission catalogue it depends on.
 *
 * The registry is the single definition the API guards, the web routes and the
 * sidebar all read, so its shape is pinned here: which reports exist, which key
 * each needs, which optional controls each supports, and that nothing is
 * released before its own ticket passes G5. The P&L key is owner-only by
 * default, which is a property of the catalogue and the security-level seeds,
 * not of any code path — so it is pinned here too.
 */
import {
  ALL_PERMISSIONS,
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSION_CATALOG,
  REPORT_DEFINITIONS,
  SYSTEM_SECURITY_LEVELS,
  getReportDefinition,
  isReportAvailable,
  type ReportDefinition,
} from '@sheer/domain';

describe('report registry', () => {
  it('defines exactly money, cash-up, team, colour-lab and pnl, with unique kebab-case keys', () => {
    const keys = REPORT_DEFINITIONS.map((definition) => definition.key);
    expect(keys).toEqual(['money', 'cash-up', 'team', 'colour-lab', 'pnl']);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  it('looks reports up by key and never resolves prototype or empty keys', () => {
    expect(getReportDefinition('money')?.label).toBe('Money');
    for (const key of ['constructor', '__proto__', 'hasOwnProperty', 'toString', '', 'MONEY', 'money ']) {
      expect(getReportDefinition(key)).toBeUndefined();
    }
  });

  it('maps each report to its approved permission, never report.dashboard.view', () => {
    const permissions = Object.fromEntries(REPORT_DEFINITIONS.map((d) => [d.key, d.permission]));
    expect(permissions).toEqual({
      money: 'report.financials.view',
      'cash-up': 'report.financials.view',
      team: 'report.performance.view',
      'colour-lab': 'report.lab_analytics.view',
      pnl: 'report.pnl.view',
    });
    for (const definition of REPORT_DEFINITIONS) {
      expect(ALL_PERMISSIONS).toContain(definition.permission);
      expect(definition.permission).not.toBe('report.dashboard.view');
    }
  });

  it('offers summary/detail only on money and cash-up, and a staff control only on Team (R2, S-1d)', () => {
    const controls = Object.fromEntries(REPORT_DEFINITIONS.map((d) => [d.key, d.controls]));
    expect(controls).toEqual({
      money: { staff: false, detail: true },
      'cash-up': { staff: false, detail: true },
      team: { staff: true, detail: false },
      'colour-lab': { staff: false, detail: false },
      pnl: { staff: false, detail: false },
    });
  });

  it('releases nothing in Ticket A: every report is foundation-only', () => {
    for (const definition of REPORT_DEFINITIONS) expect(definition.release).toBe('foundation');
  });

  it('availability depends only on release and the foundation shell', () => {
    const foundation = REPORT_DEFINITIONS[0];
    const released: ReportDefinition = { ...foundation, release: 'released' };
    expect(isReportAvailable(foundation, { foundationShell: false })).toBe(false);
    expect(isReportAvailable(foundation, { foundationShell: true })).toBe(true);
    expect(isReportAvailable(released, { foundationShell: false })).toBe(true);
    expect(isReportAvailable(released, { foundationShell: true })).toBe(true);
  });
});

describe('report.pnl.view — owner-only by default', () => {
  const pnl = PERMISSION_CATALOG.find((entry) => entry.key === 'report.pnl.view');

  it('is a report key in the Reports & financials group, with no prerequisite edge', () => {
    expect(pnl).toMatchObject({ kind: 'report', group: 'Reports & financials', label: 'Profit & loss' });
    expect(pnl?.requires).toBeUndefined();
  });

  it('is held by the owner role and by no other role default', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.owner).toContain('report.pnl.view');
    expect(DEFAULT_ROLE_PERMISSIONS.manager).not.toContain('report.pnl.view');
    expect(DEFAULT_ROLE_PERMISSIONS.stylist).not.toContain('report.pnl.view');
    expect(DEFAULT_ROLE_PERMISSIONS.client).not.toContain('report.pnl.view');
  });

  it('is on no system security level, including Owner and Group Admin', () => {
    expect(SYSTEM_SECURITY_LEVELS.map((level) => level.key)).toEqual([
      'owner',
      'group_admin',
      'manager',
      'receptionist',
      'stylist',
    ]);
    for (const level of SYSTEM_SECURITY_LEVELS) {
      expect([level.key, level.permissions.includes('report.pnl.view')]).toEqual([level.key, false]);
    }
  });

  it('leaves every other key on the Owner and Group Admin levels unchanged', () => {
    const owner = SYSTEM_SECURITY_LEVELS.find((level) => level.key === 'owner');
    const groupAdmin = SYSTEM_SECURITY_LEVELS.find((level) => level.key === 'group_admin');
    expect(owner?.permissions).toEqual(ALL_PERMISSIONS.filter((p) => p !== 'report.pnl.view'));
    expect(groupAdmin?.permissions).toEqual(
      ALL_PERMISSIONS.filter(
        (p) => p !== 'account.manage' && p !== 'security.manage' && p !== 'report.pnl.view',
      ),
    );
    expect(owner?.description).toContain('Profit & loss must be granted separately');
  });

  it('no longer describes Financials as including P&L', () => {
    const financials = PERMISSION_CATALOG.find((entry) => entry.key === 'report.financials.view');
    expect(financials?.label).toBe('Financials (revenue)');
    expect(`${financials?.label} ${financials?.description}`).not.toMatch(/P&L|profit/i);
  });

  it('adds no prerequisite edge to any report key', () => {
    for (const entry of PERMISSION_CATALOG.filter((e) => e.key.startsWith('report.'))) {
      expect([entry.key, entry.requires]).toEqual([entry.key, undefined]);
    }
  });
});
