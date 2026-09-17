import { isReportPath } from '../reports/reportNav';

/**
 * Where to send someone after sign-in when a protected route bounced them to
 * /login. Only an in-app absolute path is accepted; anything else falls back to
 * the caller's default.
 *
 * A report link comes back whole — pathname, query and hash — so a shared
 * report keeps its filters. Every other page gets its pathname only, as
 * before: another page's query (a client search, a booking prefill) must never
 * carry into whoever signs in next on a shared browser.
 */
export function loginRedirectTarget(state: unknown): string | undefined {
  const from = (state as { from?: unknown } | null | undefined)?.from;
  if (!from || typeof from !== 'object') return undefined;
  const { pathname, search, hash } = from as { pathname?: unknown; search?: unknown; hash?: unknown };
  // '/' followed by '/', '\' or whitespace is read by URL parsers as another host.
  if (typeof pathname !== 'string' || !/^\/(?![/\\\s])/.test(pathname)) return undefined;
  if (!isReportPath(pathname)) return pathname;
  const query = typeof search === 'string' && search.startsWith('?') ? search : '';
  const fragment = typeof hash === 'string' && hash.startsWith('#') ? hash : '';
  return `${pathname}${query}${fragment}`;
}
