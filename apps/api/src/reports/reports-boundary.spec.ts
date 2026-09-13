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

const API_SRC = join(__dirname, '..');
const DOMAIN_SRC = join(__dirname, '..', '..', '..', '..', 'packages', 'domain', 'src');

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function read(path: string): { name: string; code: string } {
  return { name: relative(join(API_SRC, '..', '..', '..'), path), code: stripComments(readFileSync(path, 'utf8')) };
}

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

  it('never reads merged permissions or merged location ids', () => {
    const files = [...reportFiles, grantResolver];
    expect(offenders(files, /allowedLocationIds|locationScope\b/)).toEqual([]);
    expect(offenders(files, /\b(auth|user|actor|currentUser)\??\.permissions\b/)).toEqual([]);
    expect(offenders(files, /\{[^}]*\bpermissions\b[^}]*\}\s*=\s*(request\.)?(auth|user|actor)\b/)).toEqual([]);
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
