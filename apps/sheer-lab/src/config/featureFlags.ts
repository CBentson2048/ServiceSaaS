/**
 * Build-time feature flags for the Sheer Lab app.
 *
 * These are simple hardcoded toggles (distinct from the env-driven `appConfig`)
 * used to hide a finished feature from the UI without deleting its code. The
 * screen, API client, backend module and navigation route all stay intact — a
 * hidden feature is purely removed from the sidebar/nav entry points.
 */
export const featureFlags = {
  /**
   * Billing & Revenue Rules station page. Hidden for now — set to `true` to
   * restore it everywhere (LabShell sidebar + Home dashboard nav/quick tools +
   * the formula-flow screen sidebars). Owner/manager gating still applies when
   * re-enabled.
   */
  billingRules: false,
  /**
   * Audit Trail station page. A placeholder destination ("Soon") that is hidden
   * from every sidebar/nav until the feature lands. Set to `true` to surface it.
   */
  auditTrail: false,
} as const;
