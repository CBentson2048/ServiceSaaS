/**
 * R7 Cash Up detail paging. Pure — no I/O, no clock.
 *
 * Detail rows are location-days, newest day first, then by location id. The rows
 * on any page are known from the windows alone, so the cursor is the last row's
 * (date, location) — bound to the windows it was issued for, like R1's cursor.
 */
import type { LocalDate } from '@sheer/domain';
import { reportHttpError } from '../report-errors';
import { isUuid } from '../money/money-values';
import type { CashUpWindow } from './cash-up-days';

export interface CashUpPosition {
  localDate: LocalDate;
  locationId: string;
}

const CURSOR_PREFIX = 'c1.';
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const FINGERPRINT = /^[0-9a-f]{16}$/;

/**
 * The windows (and each location's local today, which decides which days have
 * started) a cursor was issued for. Detects staleness, not tampering (FNV-1a).
 */
export function cashUpFingerprint(windows: readonly CashUpWindow[]): string {
  const canonical = JSON.stringify(
    windows
      .map((w) => [w.locationId, w.from, w.to, w.localToday])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(canonical, 'utf8')) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

export function encodeCashUpCursor(position: CashUpPosition, fingerprint: string): string {
  const payload = JSON.stringify([position.localDate, position.locationId, fingerprint]);
  return CURSOR_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

/** A malformed cursor, or one issued for other windows, is `400 report_cursor_invalid`. */
export function decodeCashUpCursor(cursor: string, fingerprint: string): CashUpPosition {
  const invalid = () => reportHttpError('report_cursor_invalid');
  if (!cursor.startsWith(CURSOR_PREFIX)) throw invalid();
  const payload = cursor.slice(CURSOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,300}$/.test(payload)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalid();
  const [localDate, locationId, issuedFor] = parsed as unknown[];
  if (typeof localDate !== 'string' || !LOCAL_DATE.test(localDate)) throw invalid();
  if (typeof locationId !== 'string' || !isUuid(locationId)) throw invalid();
  if (typeof issuedFor !== 'string' || !FINGERPRINT.test(issuedFor) || issuedFor !== fingerprint) throw invalid();
  return { localDate, locationId };
}

/** Page order: newest day first, then location id. */
export function comparePositions(a: CashUpPosition, b: CashUpPosition): number {
  if (a.localDate !== b.localDate) return a.localDate > b.localDate ? -1 : 1;
  return a.locationId < b.locationId ? -1 : a.locationId > b.locationId ? 1 : 0;
}

/** The page after `position` (or the first page) and the next page's cursor position. */
export function pageAfter(
  positions: readonly CashUpPosition[],
  position: CashUpPosition | null,
  pageSize: number,
): { page: CashUpPosition[]; next: CashUpPosition | null } {
  const ordered = [...positions].sort(comparePositions);
  const start = position === null ? 0 : ordered.findIndex((p) => comparePositions(p, position) > 0);
  const remaining = start < 0 ? [] : ordered.slice(start);
  const page = remaining.slice(0, pageSize);
  return { page, next: remaining.length > pageSize ? page[page.length - 1] : null };
}
