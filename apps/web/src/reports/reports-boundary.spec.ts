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
const teamDir = join(__dirname, 'team');
const configDir = join(__dirname, '..', 'config');
const sources = (dir: string) =>
  readdirSync(dir)
    .filter((file) => /\.(ts|tsx)$/.test(file) && !/\.spec\.(ts|tsx)$/.test(file))
    .map((file) => join(dir, file));

const files = [
  ...sources(reportsDir),
  ...sources(moneyDir),
  ...sources(cashUpDir),
  ...sources(teamDir),
  join(configDir, 'reportsFoundationShell.ts'),
  join(configDir, 'reportsFoundationShellPolicy.ts'),
].map((path) => ({ name: path.split('/src/')[1], code: stripComments(readFileSync(path, 'utf8'), path) }));

const offenders = (pattern: RegExp) => files.filter((file) => pattern.test(file.code)).map((file) => file.name);

const K = ts.SyntaxKind;
const ARITHMETIC_OPERATORS = new Set<ts.SyntaxKind>([
  K.PlusToken,
  K.MinusToken,
  K.AsteriskToken,
  K.SlashToken,
  K.PercentToken,
  K.AsteriskAsteriskToken,
  K.PlusEqualsToken,
  K.MinusEqualsToken,
  K.AsteriskEqualsToken,
  K.SlashEqualsToken,
  K.PercentEqualsToken,
  K.AsteriskAsteriskEqualsToken,
]);
const DERIVING_CALLS = new Set(['reduce', 'reduceRight']);

const COMPARISONS = new Set<ts.SyntaxKind>([
  K.EqualsEqualsEqualsToken,
  K.ExclamationEqualsEqualsToken,
  K.GreaterThanToken,
  K.GreaterThanEqualsToken,
  K.LessThanToken,
  K.LessThanEqualsToken,
]);

/**
 * A `.length` that only steers the layout: compared with a literal (`rows.length === 0`)
 * or a `colSpan` over a fixed column list. Any other `.length` could be a derived count.
 */
function isLayoutLength(node: ts.PropertyAccessExpression): boolean {
  const parent = node.parent;
  if (ts.isBinaryExpression(parent) && COMPARISONS.has(parent.operatorToken.kind)) {
    return ts.isNumericLiteral(parent.left === node ? parent.right : parent.left);
  }
  return ts.isJsxExpression(parent) && ts.isJsxAttribute(parent.parent) && parent.parent.name.getText() === 'colSpan';
}

/** `-2` in `text.slice(-2)`: a negative literal index into a string, not a figure. */
function isSliceIndex(node: ts.PrefixUnaryExpression): boolean {
  return (
    node.operator === K.MinusToken &&
    ts.isNumericLiteral(node.operand) &&
    ts.isCallExpression(node.parent) &&
    ts.isPropertyAccessExpression(node.parent.expression) &&
    node.parent.expression.name.text === 'slice'
  );
}

/** Every arithmetic expression, aggregate call, counting `.length` or Math use in the source, as `file: text`. */
function arithmeticIn(fileName: string, code: string): string[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, kind);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    const hit =
      (ts.isBinaryExpression(node) && ARITHMETIC_OPERATORS.has(node.operatorToken.kind)) ||
      (ts.isPrefixUnaryExpression(node) && [K.PlusToken, K.MinusToken, K.PlusPlusToken, K.MinusMinusToken].includes(node.operator) && !isSliceIndex(node)) ||
      (ts.isPostfixUnaryExpression(node) && [K.PlusPlusToken, K.MinusMinusToken].includes(node.operator)) ||
      (ts.isPropertyAccessExpression(node) && DERIVING_CALLS.has(node.name.text)) ||
      (ts.isPropertyAccessExpression(node) && node.name.text === 'length' && !isLayoutLength(node)) ||
      (ts.isIdentifier(node) && node.text === 'Math');
    if (hit) found.push(`${fileName}: ${node.getText(file)}`);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** None: layout `.length` checks and negative `slice` indexes are recognised above, not listed. */
const ALLOWED_TEAM_ARITHMETIC: string[] = [];

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
      'reports/team/TeamReport.tsx',
      'reports/team/teamLabels.ts',
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

  it('R2 Team: React formats money, percentages, counts and minutes and never calculates one', () => {
    const team = files.filter((file) => file.name.startsWith('reports/team/'));
    expect(team).toHaveLength(2);
    // No sums, averages, divisions or conversions: every figure arrives from the API.
    const arithmetic =
      /\.reduce\s*\(|\b(cents|count|numerator|denominator|basisPoints|availableMinutes|bookedMinutes)\s*[-+*/%]|[-+*/%]=?\s*[\w.]*\b(cents|count|numerator|denominator|basisPoints)\b|\bMath\.|parseFloat|parseInt|Number\s*\(|toFixed\s*\(/;
    expect(team.filter((file) => arithmetic.test(file.code)).map((file) => file.name)).toEqual([]);
    expect(team.filter((file) => /formatCurrency\(/.test(file.code)).map((file) => file.name)).toEqual([]);
    expect(team.filter((file) => /['"`]GBP['"`]/.test(file.code)).map((file) => file.name)).toEqual([]);
    expect(team.find((file) => file.name === 'reports/team/teamLabels.ts')!.code).toMatch(/formatMoneyAmount\(/);
    // The two measures are never merged or abbreviated.
    expect(team.filter((file) => /Rebooking(?! At Source)/.test(file.code)).map((file) => file.name)).toEqual([]);
  });

  it('R2 Team: no arithmetic at all, by syntax tree — however the operands are written', () => {
    // A regex can be dodged by brackets, renamed destructuring or an unlisted field; the parser cannot.
    const team = files.filter((file) => file.name.startsWith('reports/team/'));
    expect(team).toHaveLength(2);
    expect(team.flatMap((file) => arithmeticIn(file.name, file.code))).toEqual(ALLOWED_TEAM_ARITHMETIC);
  });

  it('the syntax-tree check catches the forms a regex misses', () => {
    const caught = (code: string) => arithmeticIn('probe.ts', code).length > 0;
    expect(caught('const t = (a.cents) + (b.cents);')).toBe(true);
    expect(caught('const t = x["cents"] / y;')).toBe(true);
    expect(caught('const { cents: c } = a; const p = c / 100;')).toBe(true);
    expect(caught('rows.reduceRight((s, r) => s, 0);')).toBe(true);
    expect(caught('const n = rows.filter(Boolean).length;')).toBe(true);
    expect(caught('let i = 0; i++;')).toBe(true);
    expect(caught('total += statements;')).toBe(true);
    expect(caught('const pct = Math.round(n);')).toBe(true);
    expect(caught('if (rows.filter(Boolean).length > limit) {}')).toBe(true);
    expect(caught('const x = count - 1;')).toBe(true);
    expect(caught('const label = `${a} of ${b}`;')).toBe(false);
    expect(caught('if (rows.length === 0) {}')).toBe(false);
    expect(caught('const tail = id.slice(-4);')).toBe(false);
  });
});
