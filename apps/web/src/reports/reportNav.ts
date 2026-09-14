import {
  REPORT_DEFINITIONS,
  decodeReportFilter,
  encodeReportFilter,
  reportAccessDecision,
  type ReportAccessUser,
  type ReportDefinition,
  type ReportKey,
  type ReportSurface,
} from '@sheer/domain';

/**
 * Report navigation, from the one registry and the one access decision the API
 * guard also applies. Availability (released, or the foundation preview on) and
 * permission are separate checks combined by `reportAccessDecision`; nothing
 * here re-implements either.
 */

export function reportPath(definition: ReportDefinition): string {
  return `/reports/${definition.key}`;
}

export function isReportPath(pathname: string): boolean {
  return pathname === '/reports' || pathname.startsWith('/reports/');
}

/**
 * The query string a link to `target` should carry. On a report page the date
 * range and locations travel to the next report; staff and view travel only to
 * a report that supports them. A current URL with a blocking problem carries
 * nothing, so a broken link does not spread. Elsewhere, links carry nothing.
 */
export function reportLinkSearch(target: ReportDefinition, currentPathname: string, currentSearch: string): string {
  if (!isReportPath(currentPathname)) return '';
  const { filter, issues } = decodeReportFilter(new URLSearchParams(currentSearch), target, 'lenient');
  if (issues.length > 0) return '';
  const query = new URLSearchParams(encodeReportFilter(filter)).toString();
  return query ? `?${query}` : '';
}

export interface ReportNavEntry {
  key: ReportKey;
  label: string;
  /** Pathname only, so active-link matching keeps working. */
  to: string;
  search: string;
}

export interface ReportNavGroup {
  label: string;
  entries: ReportNavEntry[];
}

/** The Reports sidebar group for this user, or `null` when they may open no report here. */
export function buildReportNavGroup(
  user: ReportAccessUser | null | undefined,
  surface: ReportSurface,
  currentPathname: string,
  currentSearch: string,
  definitions: readonly ReportDefinition[] = REPORT_DEFINITIONS,
): ReportNavGroup | null {
  const allowed = definitions.filter((definition) => reportAccessDecision(user, definition, surface) === 'allowed');
  if (allowed.length === 0) return null;
  return {
    label: allowed.some((definition) => definition.release === 'foundation') ? 'Reports (preview)' : 'Reports',
    entries: allowed.map((definition) => ({
      key: definition.key,
      label: definition.label,
      to: reportPath(definition),
      search: reportLinkSearch(definition, currentPathname, currentSearch),
    })),
  };
}
