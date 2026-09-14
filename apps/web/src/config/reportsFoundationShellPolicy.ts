/**
 * Whether the QLOOQO 10 report foundation preview is on in this build.
 *
 * On only for the exact string `'true'`. Deliberately NOT like the ZAC routing
 * inspector: no dev-server default and no browser override, so the web and the
 * API (`REPORTS_FOUNDATION_SHELL`) can only be switched on together, by the
 * deployment. A report that is released does not need this flag at all.
 *
 * This hides navigation and routes; it is not the security boundary — the API
 * refuses unreleased reports (404) and unpermitted users (403) on its own.
 */
export function resolveReportsFoundationShell(explicit: string | undefined): boolean {
  return explicit === 'true';
}
