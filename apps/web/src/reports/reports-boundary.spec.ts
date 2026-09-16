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
const moneyDir = join(__dirname, 'money');
const cashUpDir = join(__dirname, 'cash-up');
const configDir = join(__dirname, '..', 'config');
const sources = (dir: string) =>
  readdirSync(dir)
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.spec\.(ts|tsx)$/.test(file))
    .map((file) => join(dir, file));

const files = [
  ...sources(reportsDir),
  ...sources(moneyDir),
  ...sources(cashUpDir),
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
      'reports/cash-up/CashUpReport.tsx',
      'reports/cash-up/cashUpLabels.ts',
      'reports/money/MoneyReport.tsx',
      'reports/money/moneyLabels.ts',
      'reports/reportNav.ts',
      'reports/reportRoutes.tsx',
      'reports/reportScopeLine.ts',
      'reports/usePagedDetail.ts',
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

  it('R1 Money: React formats money and never calculates it', () => {
    const money = files.filter((file) => file.name.startsWith('reports/money/'));
    expect(money).toHaveLength(2);
    // No summing, no arithmetic on amounts, no parsing money back out of text.
    const arithmetic = /\.reduce\s*\(|\bcents\s*[-+*/%]|[-+*/%]=?\s*[\w.]*\bcents\b|\bMath\.|parseFloat|parseInt|Number\s*\(/;
    expect(money.filter((file) => arithmetic.test(file.code)).map((file) => file.name)).toEqual([]);
    // Money is formatted only through the shared formatter, from minor units.
    expect(money.filter((file) => /formatCurrency\(/.test(file.code)).map((file) => file.name)).toEqual(['reports/money/moneyLabels.ts']);
    // An unavailable figure is words: the formatter handles every availability.
    const labels = money.find((file) => file.name === 'reports/money/moneyLabels.ts')!.code;
    expect(labels).toMatch(/case 'unavailable'/);
    expect(labels).toMatch(/case 'not_started'/);
    // A figure is written only in the currency the API names: no default currency.
    expect(money.filter((file) => /['"`]GBP['"`]/.test(file.code)).map((file) => file.name)).toEqual([]);
  });

  it('R7 Cash Up: React formats figures through the Money formatter and never calculates them', () => {
    const cashUp = files.filter((file) => file.name.startsWith('reports/cash-up/'));
    expect(cashUp).toHaveLength(2);
    const arithmetic = /\.reduce\s*\(|\bcents\s*[-+*/%]|[-+*/%]=?\s*[\w.]*\bcents\b|\bcount\s*[-+*/%]|\bMath\.|parseFloat|parseInt|Number\s*\(/;
    expect(cashUp.filter((file) => arithmetic.test(file.code)).map((file) => file.name)).toEqual([]);
    // No formatter of its own and no default currency: every figure goes through formatMoneyAmount.
    expect(cashUp.filter((file) => /formatCurrency\(|Intl\./.test(file.code)).map((file) => file.name)).toEqual([]);
    expect(cashUp.filter((file) => /['"`]GBP['"`]/.test(file.code)).map((file) => file.name)).toEqual([]);
    expect(cashUp.find((file) => file.name === 'reports/cash-up/cashUpLabels.ts')!.code).toMatch(/formatMoneyAmount\(/);
  });
});
