/**
 * R1 Money detail paging. Pure — no I/O, no clock.
 *
 * Rows of four kinds are merged into one order: (instant, kind rank, id). The
 * cursor is the last row's position in that order. Each kind is read from its own
 * keyset start derived from the cursor, so identical instants never duplicate or
 * skip a row, and there is no row cap.
 */
import type { MoneyDetailRowKind } from '@sheer/domain';
import { reportHttpError } from '../report-errors';
import type { MoneyAfter, MoneyWindow } from './money-source';
import { isInstantKey, isUuid } from './money-values';

export const DETAIL_KIND_RANK: Record<MoneyDetailRowKind, number> = {
  paid_bill: 0,
  retail_sale: 1,
  deposit_collected: 2,
  deposit_refunded: 3,
};

export interface DetailPosition {
  key: string;
  rank: number;
  id: string;
}

const CURSOR_PREFIX = 'm1.';
const FINGERPRINT = /^[0-9a-f]{16}$/;

/**
 * The windows a cursor was issued for. A relative preset resolves again on every
 * request, so after a location's local midnight (or a change of locations) the
 * same filter names different windows: a cursor from the old windows would skip
 * the rest of that day and append rows from another. The fingerprint makes such
 * a cursor invalid instead. It detects staleness, not tampering (FNV-1a, 64-bit).
 */
export function windowsFingerprint(windows: readonly MoneyWindow[]): string {
  const canonical = JSON.stringify(
    windows
      .map((window) => [window.locationId, window.fromUtc, window.toUtcExclusive])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
  );
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(canonical, 'utf8')) hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  return hash.toString(16).padStart(16, '0');
}

export function encodeDetailCursor(position: DetailPosition, fingerprint: string): string {
  const payload = JSON.stringify([position.key, position.rank, position.id, fingerprint]);
  return CURSOR_PREFIX + Buffer.from(payload, 'utf8').toString('base64url');
}

/**
 * A malformed cursor, or one issued for other windows, is `400 report_cursor_invalid`;
 * nothing from it reaches a query unvalidated.
 */
export function decodeDetailCursor(cursor: string, fingerprint: string): DetailPosition {
  const invalid = () => reportHttpError('report_cursor_invalid');
  if (!cursor.startsWith(CURSOR_PREFIX)) throw invalid();
  const payload = cursor.slice(CURSOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{1,400}$/.test(payload)) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw invalid();
  const [key, rank, id, issuedFor] = parsed as unknown[];
  if (typeof key !== 'string' || !isInstantKey(key)) throw invalid();
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 0 || rank > 3) throw invalid();
  if (typeof id !== 'string' || !isUuid(id)) throw invalid();
  if (typeof issuedFor !== 'string' || !FINGERPRINT.test(issuedFor) || issuedFor !== fingerprint) throw invalid();
  return { key, rank, id };
}

/** Where rows of the kind with `rank` start, for a page that follows `position`. */
export function keysetAfter(position: DetailPosition | null, rank: number): MoneyAfter | null {
  if (position === null) return null;
  if (rank > position.rank) return { key: position.key, op: 'gte' };
  if (rank < position.rank) return { key: position.key, op: 'gt' };
  return { key: position.key, id: position.id };
}

export function comparePositions(a: DetailPosition, b: DetailPosition): number {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Merge per-kind candidates (each already ordered and each read with
 * `pageSize + 1` rows after the cursor) into one page. More rows exist exactly
 * when the merge holds more than `pageSize`.
 */
export function mergeDetailPage<T extends { position: DetailPosition }>(
  candidates: readonly T[],
  pageSize: number,
): { page: T[]; next: DetailPosition | null } {
  const ordered = [...candidates].sort((a, b) => comparePositions(a.position, b.position));
  const page = ordered.slice(0, pageSize);
  const next = ordered.length > pageSize && page.length > 0 ? page[page.length - 1].position : null;
  return { page, next };
}
