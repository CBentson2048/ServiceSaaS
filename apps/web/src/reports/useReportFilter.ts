import { useCallback, useEffect, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  REPORT_PARAM_KEYS,
  decodeReportFilter,
  encodeReportFilter,
  type ReportDefinition,
  type ReportFilter,
  type ReportFilterIssue,
} from '@sheer/domain';

export type ReportFilterWriteMode = 'push' | 'replace';

const REPORT_PARAMS: readonly string[] = REPORT_PARAM_KEYS;

/**
 * `current` with its report parameters replaced by `filter`'s canonical
 * encoding. Every other parameter is kept, in place.
 */
export function withReportFilter(current: URLSearchParams, filter: ReportFilter): URLSearchParams {
  const next = new URLSearchParams();
  current.forEach((value, key) => {
    if (!REPORT_PARAMS.includes(key)) next.append(key, value);
  });
  for (const [key, value] of Object.entries(encodeReportFilter(filter))) {
    next.set(key, value);
  }
  return next;
}

export interface UseReportFilter {
  filter: ReportFilter;
  /**
   * Problems that must stop a request: a repeated parameter; an incomplete,
   * invalid, pre-2000, inverted or over-366-day custom range; or malformed or
   * too many ids. Empty when the filter can be sent.
   */
  issues: ReportFilterIssue[];
  /** Canonical query string of `filter`: equal filters always give equal keys. */
  filterKey: string;
  /**
   * Write a filter to the URL. `push` adds a history entry (a deliberate
   * choice: a preset, Apply, a selection); `replace` does not. Writing a filter
   * equal to the current one does nothing, so repeated clicks add no history.
   */
  setFilter(next: ReportFilter, mode: ReportFilterWriteMode): void;
}

/**
 * The URL is the only place a report filter lives — no copy in component
 * state — so refresh, Back/Forward and a shared link all reproduce the view.
 *
 * Parameters the report does not support are removed with `replace`, so a link
 * carried from another report cannot leave a filter the page ignores. Ids are
 * never removed: a link naming a location this viewer may not report on is
 * refused by the server rather than silently widened. A URL with a blocking
 * problem is left exactly as typed, so the page can show what is wrong.
 */
export function useReportFilter(definition: ReportDefinition): UseReportFilter {
  const [searchParams, setSearchParams] = useSearchParams();
  const current = searchParams.toString();

  const decoded = useMemo(
    () => decodeReportFilter(new URLSearchParams(current), definition, 'lenient'),
    [current, definition],
  );
  const filterKey = useMemo(
    () => new URLSearchParams(encodeReportFilter(decoded.filter)).toString(),
    [decoded.filter],
  );

  useEffect(() => {
    if (decoded.issues.length > 0) return;
    const canonical = withReportFilter(new URLSearchParams(current), decoded.filter).toString();
    if (canonical !== current) {
      setSearchParams(new URLSearchParams(canonical), { replace: true });
    }
  }, [current, decoded, setSearchParams]);

  const setFilter = useCallback(
    (next: ReportFilter, mode: ReportFilterWriteMode) => {
      const target = withReportFilter(new URLSearchParams(current), next).toString();
      if (target === current) return;
      setSearchParams(new URLSearchParams(target), { replace: mode === 'replace' });
    },
    [current, setSearchParams],
  );

  return { filter: decoded.filter, issues: decoded.issues, filterKey, setFilter };
}
