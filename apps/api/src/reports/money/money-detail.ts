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
import type { MoneyAfter } from './money-source';
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

export function encodeDetailCursor(position: DetailPosition): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify([position.key, position.rank, position.id]), 'utf8').toString('base64url');
}

/** A malformed cursor is `400 report_cursor_invalid`; nothing from it reaches a query unvalidated. */
export function decodeDetailCursor(cursor: string): DetailPosition {
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
  if (!Array.isArray(parsed) || parsed.length !== 3) throw invalid();
  const [key, rank, id] = parsed as unknown[];
  if (typeof key !== 'string' || !isInstantKey(key)) throw invalid();
  if (typeof rank !== 'number' || !Number.isInteger(rank) || rank < 0 || rank > 3) throw invalid();
  if (typeof id !== 'string' || !isUuid(id)) throw invalid();
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
