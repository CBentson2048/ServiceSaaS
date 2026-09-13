/**
 * Where to send someone after sign-in when a protected route bounced them to
 * /login. The whole address comes back — pathname, query and hash — so a
 * shared report link keeps its filters. Only an in-app absolute path is
 * accepted; anything else falls back to the caller's default.
 */
export function loginRedirectTarget(state: unknown): string | undefined {
  const from = (state as { from?: unknown } | null | undefined)?.from;
  if (!from || typeof from !== 'object') return undefined;
  const { pathname, search, hash } = from as { pathname?: unknown; search?: unknown; hash?: unknown };
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) return undefined;
  const query = typeof search === 'string' && search.startsWith('?') ? search : '';
  const fragment = typeof hash === 'string' && hash.startsWith('#') ? hash : '';
  return `${pathname}${query}${fragment}`;
}
