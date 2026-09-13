/**
 * Source boundaries for the web report foundation (comments stripped):
 *
 * - The browser never computes a day boundary or reads its own clock or locale
 *   for report dates: the server resolves every location's window.
 * - Report access never reads merged permissions or location ids — only the
 *   shared report decision.
 * - The sidebar location scope is not a report scope.
 * - Nothing persists report state outside the URL.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const reportsDir = __dirname;
const configDir = join(__dirname, '..', 'config');

const files = [
  ...readdirSync(reportsDir)
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.spec\.(ts|tsx)$/.test(file))
    .map((file) => join(reportsDir, file)),
  join(configDir, 'reportsFoundationShell.ts'),
  join(configDir, 'reportsFoundationShellPolicy.ts'),
].map((path) => ({ name: path.split('/src/')[1], code: stripComments(readFileSync(path, 'utf8')) }));

const offenders = (pattern: RegExp) => files.filter((file) => pattern.test(file.code)).map((file) => file.name);

describe('web report foundation source boundaries', () => {
  it('scans the report files', () => {
    expect(files.map((file) => file.name).sort()).toEqual([
      'config/reportsFoundationShell.ts',
      'config/reportsFoundationShellPolicy.ts',
      'reports/ReportControlBar.tsx',
      'reports/ReportMultiSelect.tsx',
      'reports/ReportPage.tsx',
      'reports/reportNav.ts',
      'reports/reportRoutes.tsx',
      'reports/reportScopeLine.ts',
      'reports/useReportFilter.ts',
    ]);
  });

  it('never reads the browser clock, locale or timezone', () => {
    expect(offenders(/new Date\s*\(|Date\.now|toISOString|toLocale|\bIntl\b/)).toEqual([]);
  });

  it('never computes a day boundary or uses the payroll/today helpers', () => {
    expect(offenders(/localDateStartUtc|utcToLocalDate|periodUtcWindow|todayLocalIso|formatLocalDate/)).toEqual([]);
  });

  it('never reads merged permissions, merged location ids or the sidebar location scope', () => {
    expect(offenders(/userHas(Permission|AllPermissions|AnyPermission)\b|allowedLocationIds|\.permissions\b|useLocationScope/)).toEqual([]);
  });

  it('keeps report state in the URL only', () => {
    expect(offenders(/localStorage|sessionStorage|indexedDB/)).toEqual([]);
  });
});
