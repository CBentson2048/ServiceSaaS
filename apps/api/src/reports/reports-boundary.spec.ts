/**
 * Source boundaries for the report foundation, checked on the code itself
 * (comments stripped) so they hold for code nobody has written a test for yet.
 *
 * - Reporting never reads the merged AuthUser.permissions / allowedLocationIds,
 *   never falls back to role defaults, never uses the fail-open guards.
 * - Reporting is read-only.
 * - There is one clock read per request, in the controller.
 * - Staff scope (decision S-1d) lives only in R2 Team, from memberships and facts —
 *   never `primary_location_id`.
 * - The domain contract is browser-safe: no clock, no Intl, no day boundaries.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as ts from 'typescript';

const API_SRC = join(__dirname, '..');
const DOMAIN_SRC = join(__dirname, '..', '..', '..', '..', 'packages', 'domain', 'src');

/**
 * Blank out comments using the TypeScript parser, so a `/*` or `//` inside a
 * string, template or regex literal can never swallow real code.
 */
function stripComments(source: string, fileName = 'file.ts'): string {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const chars = source.split('');
  const blank = (range: ts.CommentRange) => {
    for (let i = range.pos; i < range.end; i++) if (chars[i] !== '\n') chars[i] = ' ';
  };
  const visit = (node: ts.Node) => {
    ts.getLeadingCommentRanges(source, node.getFullStart())?.forEach(blank);
    ts.getTrailingCommentRanges(source, node.getEnd())?.forEach(blank);
    node.getChildren(file).forEach(visit);
  };
  visit(file);
  return chars.join('');
}

function read(path: string): { name: string; code: string } {
  return { name: relative(join(API_SRC, '..', '..', '..'), path), code: stripComments(readFileSync(path, 'utf8'), path) };
}

/** Reads of the merged, role-default-backed user fields reporting must never use. */
const MERGED_USER_READ = [
  /allowedLocationIds|\blocationScope\b/,
  /\b(auth|user|actor|currentUser)\s*[?!]?\.\s*(permissions|locations)\b/,
  /\[\s*['"`](permissions|allowedLocationIds|locations|locationScope)['"`]\s*\]/,
  /\{[^}]*\b(permissions|locations)\b[^}]*\}\s*=\s*(request\.|req\.)?(auth|user|actor)\b/,
];

const MONEY_DIR = join(__dirname, 'money');
const CASH_UP_DIR = join(__dirname, 'cash-up');
const TEAM_DIR = join(__dirname, 'team');
const reportFiles = [
  ...readdirSync(__dirname)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map((file) => read(join(__dirname, file))),
  // R1 Money (Ticket B). Test support under money/testing is not app code.
  ...readdirSync(MONEY_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map((file) => read(join(MONEY_DIR, file))),
  // R7 Cash Up. Test support under cash-up/testing is not app code.
  ...readdirSync(CASH_UP_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map((file) => read(join(CASH_UP_DIR, file))),
  // R2 Team. Test support under team/testing is not app code.
  ...readdirSync(TEAM_DIR)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map((file) => read(join(TEAM_DIR, file))),
];
const moneyFiles = reportFiles.filter((file) => file.name.includes('/reports/money/'));
const cashUpFiles = reportFiles.filter((file) => file.name.includes('/reports/cash-up/'));
const teamFiles = reportFiles.filter((file) => file.name.includes('/reports/team/'));
const grantResolver = read(join(API_SRC, 'auth', 'membership-grants.ts'));
const domainContract = ['reporting.ts', 'local-date.ts', 'money-report.ts', 'cash-up-report.ts', 'team-report.ts'].map((file) =>
  read(join(DOMAIN_SRC, file)),
);

function offenders(files: Array<{ name: string; code: string }>, pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(file.code)).map((file) => file.name);
}

describe('report foundation source boundaries', () => {
  it('scans the files it claims to', () => {
    expect(reportFiles.map((file) => file.name.split('/').pop()).sort()).toEqual([
      'cash-up-days.ts',
      'cash-up-detail.ts',
      'cash-up-report.service.ts',
      'cash-up-source.ts',
      'dto.ts',
      'money-detail.ts',
      'money-report.service.ts',
      'money-source.ts',
      'money-totals.ts',
      'money-values.ts',
      'report-access.guard.ts',
      'report-actor.ts',
      'report-availability.guard.ts',
      'report-errors.ts',
      'report-scope.service.ts',
      'report-surface.ts',
      'report-window.ts',
      'reports.controller.ts',
      'reports.module.ts',
      'team-commission.ts',
      'team-future-booking.ts',
      'team-money.ts',
      'team-report.service.ts',
      'team-source.ts',
      'team-utilisation.ts',
    ]);
  });

  it('strips comments without swallowing code after a "/*" or "//" inside a string', () => {
    const tricky = [
      'const splat = "/reports/*";',
      'const cdn = "//cdn.example.com";',
      'const leak = user.permissions;',
      '/** a doc comment */',
      'export const x = 1; // trailing note mentioning allowedLocationIds',
    ].join('\n');
    const code = stripComments(tricky);
    expect(code).toContain('user.permissions');
    expect(code).toContain('"/reports/*"');
    expect(code).not.toContain('a doc comment');
    expect(code).not.toContain('allowedLocationIds');
    expect(MERGED_USER_READ.some((pattern) => pattern.test(code))).toBe(true);
  });

  it('the merged-read patterns catch dotted, optional, non-null, bracket and destructured reads', () => {
    for (const read of ['auth.permissions', 'user?.permissions', 'actor!.locations', "auth['permissions']", 'const { permissions } = request.auth', 'x.allowedLocationIds']) {
      expect([read, MERGED_USER_READ.some((pattern) => pattern.test(read))]).toEqual([read, true]);
    }
    expect(MERGED_USER_READ.some((pattern) => pattern.test('grant.permissions.includes(key)'))).toBe(false);
  });

  it('never reads merged permissions or merged location ids', () => {
    const files = [...reportFiles, grantResolver];
    for (const pattern of MERGED_USER_READ) expect([String(pattern), offenders(files, pattern)]).toEqual([String(pattern), []]);
    expect(offenders(files, /\buserHas(Permission|AllPermissions|AnyPermission|Role|AnyRole)\b|\bcanAccessLocation\b/)).toEqual([]);
  });

  it('never falls back to role defaults or seeded level definitions', () => {
    expect(offenders([...reportFiles, grantResolver], /DEFAULT_ROLE_PERMISSIONS|SYSTEM_SECURITY_LEVELS|base_role|baseRole/)).toEqual([]);
  });

  it('never uses the fail-open metadata guards', () => {
    expect(offenders(reportFiles, /\b(RolesGuard|PermissionsGuard|LocationScopeGuard|RequireRoles|RequirePermissions|RequireLocationScope)\b/)).toEqual([]);
  });

  it('is read-only', () => {
    expect(offenders(reportFiles, /\.(insert|update|upsert|delete|rpc)\s*\(/)).toEqual([]);
    expect(offenders(reportFiles, /\bloadSettings\b|\bPayrollInputsService\b/)).toEqual([]);
  });

  it('reads the clock only in the controller, once per request', () => {
    expect(offenders(reportFiles, /Date\.now\s*\(/)).toEqual([]);
    expect(offenders(reportFiles, /new Date\s*\(/)).toEqual(['apps/api/src/reports/reports.controller.ts']);
  });

  it('never uses primary_location_id or appointment service prices, and reads staff sources only in R2 Team (S-1d)', () => {
    expect(offenders(reportFiles, /primary_location_id|appointment_services/)).toEqual([]);
    const outsideTeam = reportFiles.filter((file) => !teamFiles.includes(file));
    expect(offenders(outsideTeam, /staff_profiles|user_memberships|['"]shifts['"]|['"]appointments['"]/)).toEqual([]);
    // Within Team, only the source adapter touches the database.
    expect(offenders(teamFiles, /\.from\(/)).toEqual(['apps/api/src/reports/team/team-source.ts']);
  });

  it('R2 Team reads money through R1 and never a legacy calculation, calculator or merged scope', () => {
    expect(teamFiles).toHaveLength(6);
    expect(
      offenders(
        teamFiles,
        /visit_line_items|price_amount|rebooking_outcomes|client_next_bookings|\bKpiService\b|\bUtilisationService\b|kpi\.calc|payroll\.calc|calculatePaySummary|computeCommission|\bDashboardService\b|PayrollInputsService|\bEodService\b/,
      ),
    ).toEqual([]);
    // Money is R1's loader and R1's universe: Team reads no bill, retail or deposit table itself.
    const tables = [...new Set([...teamFiles.map((f) => f.code).join('\n').matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]))].sort();
    expect(tables).toEqual([
      'absence_events',
      'appointments',
      'book_out_types',
      'leave_requests',
      'pay_periods',
      'pay_summaries',
      'shift_breaks',
      'shifts',
      'staff_profiles',
      'user_memberships',
      'visits',
    ]);
    expect(offenders(teamFiles, /loadMoneyFacts\(/)).toEqual(['apps/api/src/reports/team/team-report.service.ts']);
    // Windows come from the Ticket A scope; Team never resolves one or reads the clock.
    expect(offenders(teamFiles, /resolveReportWindows|periodUtcWindow|resolveLocalRange|new Date\s*\(|Date\.now/)).toEqual([]);
    // Finalised commission only: locked or paid calculation periods, never approved, review or draft.
    const teamSource = teamFiles.find((file) => file.name.endsWith('team-source.ts'))!.code;
    expect(teamSource).toContain(".eq('kind', 'calculation')");
    expect(teamSource).toContain(".in('status', ['locked', 'paid'])");
    expect(offenders(teamFiles, /'ready_for_review'|'draft'/)).toEqual([]);
    // 'approved' appears once: approved leave, which reduces rostered time.
    expect([...teamSource.matchAll(/'approved'/g)]).toHaveLength(1);
    // Approved leave is staff-wide: read by staff, never filtered by — or even selecting — the location that recorded it.
    expect(teamSource).toContain(".select('id,staff_profile_id,start_date,end_date')");
    expect(teamSource).toContain(".eq('status', 'approved')\n        .in('staff_profile_id'");
    // A pay statement's stored currency code has no provenance (default and literal 'GBP'): never read, never trusted.
    expect(offenders(teamFiles, /currency_code/)).toEqual([]);
    expect(offenders(teamFiles, /['"`]GBP['"`]/)).toEqual([]);
  });

  it('R1 Money reads only its canonical sources, never a legacy revenue calculation', () => {
    expect(moneyFiles).toHaveLength(5);
    expect(
      offenders(moneyFiles, /visit_line_items|appointment_services|price_amount|billable_charge_cents|eod_expected_figures|\bDashboardService\b|\bKpiService\b|\bEodService\b|\bRetailSalesService\b|\bLabAnalyticsService\b|scheduled_start_at|completed_at/),
    ).toEqual([]);
    // Money never resolves a date itself: windows come from the Ticket A scope.
    expect(offenders(moneyFiles, /resolveReportWindows|localDateStartUtc|periodUtcWindow|resolveLocalRange|asOf\b.*new Date/)).toEqual([]);
    const sourceTables = [...new Set([...moneyFiles.map((f) => f.code).join('\n').matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]))].sort();
    expect(sourceTables).toEqual(['bill_lines', 'bills', 'businesses', 'deposits', 'location_settings', 'retail_sales', 'salon_payments']);
    // A figure's currency always comes from data: there is no default currency.
    expect(offenders(moneyFiles, /['"`]GBP['"`]/)).toEqual([]);
    // The staff fields R2 added to R1's adapter are carried, never used: only the adapter names them,
    // so R1's own figures cannot change because of them.
    expect(offenders(moneyFiles, /\bstaffProfileId\b|\bperService\b|\bsellerStaffProfileId\b/)).toEqual(['apps/api/src/reports/money/money-source.ts']);
  });

  it('R7 Cash Up reads cash-ups as recorded and takings through R1 — never End of Day’s own calculations', () => {
    expect(cashUpFiles).toHaveLength(4);
    // Never the EOD RPC, service or London day window; never a merged location list.
    expect(offenders(cashUpFiles, /eod_expected_figures|\bEodService\b|businessDayWindow|EOD_TIMEZONE|visit_line_items|\bDashboardService\b/)).toEqual([]);
    // Days come from the Ticket A scope: Cash Up never resolves a window or reads the clock.
    expect(offenders(cashUpFiles, /resolveReportWindows|localDateStartUtc|periodUtcWindow|resolveLocalRange|new Date\s*\(|Date\.now/)).toEqual([]);
    const tables = [...new Set([...cashUpFiles.map((f) => f.code).join('\n').matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]))].sort();
    expect(tables).toEqual(['eod_reconciliations', 'location_settings', 'user_profiles']);
    // A figure's currency always comes from data: there is no default currency, and no default threshold.
    expect(offenders(cashUpFiles, /['"`]GBP['"`]|\b500\b/)).toEqual([]);
  });

  it('keeps the domain contract browser-safe: no clock, no Intl, no day boundaries', () => {
    expect(offenders(domainContract, /\bIntl\b|Date\.now|new Date\s*\(|toISOString|localDateStartUtc|utcToLocalDate|periodUtcWindow/)).toEqual([]);
    expect(offenders(domainContract, /allowedLocationIds|\.permissions\b(?!\.includes)/)).toEqual([]);
  });
});
