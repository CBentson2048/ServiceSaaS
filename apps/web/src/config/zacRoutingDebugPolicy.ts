/**
 * Presentation policy for the ZAC semantic-routing inspector.
 *
 * Decides whether the routing badge and technical details are SHOWN. It is
 * not a security control: the metadata it reveals is already part of the
 * `/zac/ask` response the browser holds, and the backend remains the only
 * authority for routing, permissions and privacy. Pure so it can be tested
 * without a Vite runtime — the env read lives in `zacRoutingDebug.ts`.
 */
export interface ZacRoutingDebugInputs {
  /** `VITE_ZAC_SHOW_ROUTING_DEBUG` as built into the bundle, if set. */
  explicit: string | undefined;
  /** Vite's dev-server flag (`import.meta.env.DEV`). */
  isDev: boolean;
  /**
   * A per-browser override an internal tester can set on a production build
   * (`localStorage['zac.routing_debug'] = 'true'`). Honoured only when the
   * deployment did not decide explicitly.
   */
  override: string | null;
}

function asBoolean(value: string | null | undefined): boolean | null {
  if (value === null || value === undefined) return null;
  const normalised = value.trim().toLowerCase();
  if (normalised === 'true' || normalised === '1' || normalised === 'on') return true;
  if (normalised === 'false' || normalised === '0' || normalised === 'off') return false;
  return null;
}

/**
 * development → visible; production → hidden unless the deployment (env var)
 * or an internal tester (browser override) turned it on. An explicit env value
 * wins over the override in both directions.
 */
export function resolveZacRoutingDebug(inputs: ZacRoutingDebugInputs): boolean {
  const explicit = asBoolean(inputs.explicit);
  if (explicit !== null) return explicit;
  const override = asBoolean(inputs.override);
  if (override !== null) return override;
  return inputs.isDev;
}

export const ZAC_ROUTING_DEBUG_STORAGE_KEY = 'zac.routing_debug';
