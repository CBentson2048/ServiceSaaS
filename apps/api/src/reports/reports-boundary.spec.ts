/**
 * Source boundaries for the report foundation, checked on the code itself
 * (comments stripped) so they hold for code nobody has written a test for yet.
 *
 * - Reporting never reads the merged AuthUser.permissions / allowedLocationIds,
 *   never falls back to role defaults, never uses the fail-open guards.
 * - Reporting is read-only.
 * - There is one clock read per request, in the controller.
 * - Ticket A has no staff scope (decision S-1d): no staff-location source.
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

const reportFiles = readdirSync(__dirname)
  .filter((file) => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
  .map((file) => read(join(__dirname, file)));
const grantResolver = read(join(API_SRC, 'auth', 'membership-grants.ts'));
const domainContract = ['reporting.ts', 'local-date.ts'].map((file) => read(join(DOMAIN_SRC, file)));

function offenders(files: Array<{ name: string; code: string }>, pattern: RegExp): string[] {
  return files.filter((file) => pattern.test(file.code)).map((file) => file.name);
}

describe('report foundation source boundaries', () => {
  it('scans the files it claims to', () => {
    expect(reportFiles.map((file) => file.name.split('/').pop()).sort()).toEqual([
      'dto.ts',
      'report-access.guard.ts',
      'report-actor.ts',
      'report-availability.guard.ts',
      'report-errors.ts',
      'report-scope.service.ts',
      'report-surface.ts',
      'report-window.ts',
      'reports.controller.ts',
      'reports.module.ts',
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

  it('has no staff scope in Ticket A (S-1d): no staff-location source and no primary location', () => {
    expect(offenders(reportFiles, /primary_location_id|staff_profiles|user_memberships|['"]shifts['"]|['"]appointments['"]|appointment_services/)).toEqual([]);
  });

  it('keeps the domain contract browser-safe: no clock, no Intl, no day boundaries', () => {
    expect(offenders(domainContract, /\bIntl\b|Date\.now|new Date\s*\(|toISOString|localDateStartUtc|utcToLocalDate|periodUtcWindow/)).toEqual([]);
    expect(offenders(domainContract, /allowedLocationIds|\.permissions\b(?!\.includes)/)).toEqual([]);
  });
});
