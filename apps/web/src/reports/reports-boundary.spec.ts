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
import * as ts from 'typescript';

/**
 * Blank out comments using the TypeScript parser, so a `/*` or `//` inside a
 * string, template or regex literal can never swallow real code.
 */
function stripComments(source: string, fileName = 'file.tsx'): string {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
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

const reportsDir = __dirname;
const configDir = join(__dirname, '..', 'config');

const files = [
  ...readdirSync(reportsDir)
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.spec\.(ts|tsx)$/.test(file))
    .map((file) => join(reportsDir, file)),
  join(configDir, 'reportsFoundationShell.ts'),
  join(configDir, 'reportsFoundationShellPolicy.ts'),
].map((path) => ({ name: path.split('/src/')[1], code: stripComments(readFileSync(path, 'utf8'), path) }));

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

  it('the preview flag has one input: the build-time variable, with no dev-mode default and no browser override', () => {
    const shell = files.find((file) => file.name === 'config/reportsFoundationShell.ts')?.code ?? '';
    expect(shell.match(/import\.meta\.env\.\w+/g)).toEqual(['import.meta.env.VITE_REPORTS_FOUNDATION_SHELL']);
    expect(shell).not.toMatch(/\bDEV\b|\bMODE\b|\bPROD\b|\blocation\b|URLSearchParams|localStorage|sessionStorage|document\.cookie/);
    const policy = files.find((file) => file.name === 'config/reportsFoundationShellPolicy.ts')?.code ?? '';
    expect(policy).not.toMatch(/import\.meta|process\.env|\bwindow\b|\blocation\b|localStorage/);
  });

  it('strips comments without swallowing code after a "/*" or "//" inside a string', () => {
    const tricky = [
      'const splat = "/reports/*";',
      'const cdn = "//cdn.example.com";',
      'const when = Date.now();',
      '/** a doc comment mentioning localStorage */',
      'export const x = <div>{"a"}</div>; // trailing note mentioning allowedLocationIds',
    ].join('\n');
    const code = stripComments(tricky, 'tricky.tsx');
    expect(code).toContain('Date.now()');
    expect(code).toContain('"/reports/*"');
    expect(code).toContain('<div>');
    expect(code).not.toContain('localStorage');
    expect(code).not.toContain('allowedLocationIds');
  });
});
