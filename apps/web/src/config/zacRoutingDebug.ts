/**
 * Runtime read of the ZAC routing-inspector presentation flag.
 *
 *   VITE_ZAC_SHOW_ROUTING_DEBUG=true|false  — deployment decision (Vercel env)
 *   unset                                   — visible on the Vite dev server,
 *                                             hidden in production builds
 *   localStorage['zac.routing_debug']       — per-browser override for
 *                                             internal testers (unset env only)
 *
 * Presentation only. See zacRoutingDebugPolicy.ts for the rules and why this
 * is not a security boundary.
 */
import { resolveZacRoutingDebug, ZAC_ROUTING_DEBUG_STORAGE_KEY } from './zacRoutingDebugPolicy';

function readOverride(): string | null {
  try {
    return typeof localStorage === 'undefined'
      ? null
      : localStorage.getItem(ZAC_ROUTING_DEBUG_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function zacRoutingDebugEnabled(): boolean {
  const env = import.meta.env;
  const explicit = env.VITE_ZAC_SHOW_ROUTING_DEBUG;
  return resolveZacRoutingDebug({
    explicit: typeof explicit === 'string' ? explicit : undefined,
    isDev: Boolean(env.DEV),
    override: readOverride(),
  });
}
