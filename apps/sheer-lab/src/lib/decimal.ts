/**
 * Decimal text parsing for numeric fields — the ONE implementation.
 *
 * A pure module with no `react-native` import, deliberately: the app's tests
 * run in a Node environment (no renderer is installable here), so anything that
 * imports `react-native` cannot be unit-tested. Keeping the parsing rules out
 * of `DecimalInput.tsx` is what makes them testable at all.
 *
 * See `src/screens/shared/DecimalInput.tsx` for why these rules exist — in
 * short, a field whose value is derived from the parsed number erases a decimal
 * point as it is typed, turning 1.5g into 15g.
 */

/**
 * Digits and at most one separator. A comma is folded to a dot so a European
 * keyboard's "1,5" is not silently dropped.
 */
export function sanitiseDecimal(raw: string): string {
  const unified = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '');
  const firstDot = unified.indexOf('.');
  if (firstDot === -1) return unified;
  return unified.slice(0, firstDot + 1) + unified.slice(firstDot + 1).replace(/\./g, '');
}

/** `undefined` for empty or not-yet-a-number text ("", "."), so nothing is stored as NaN. */
export function parseDecimal(text: string): number | undefined {
  if (text.trim().length === 0) return undefined;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}
