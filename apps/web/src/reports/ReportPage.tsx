import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  isReportErrorBody,
  type ReportDefinition,
  type ReportErrorBody,
  type ReportErrorCode,
  type ReportFilter,
  type ReportFilterIssueCode,
  type ReportOptions,
  type ReportResult,
} from '@sheer/domain';
import { ApiRequestError, getReportOptions, getReportResult } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { AppButton, AppCard, AppText } from '../design';
import { ReportControlBar, WEEK_START_UNCONFIGURED_MESSAGE } from './ReportControlBar';
import { LOCAL_CALENDAR_NOTE, groupReportScope } from './reportScopeLine';
import { useReportFilter, type ReportFilterWriteMode } from './useReportFilter';

type Loadable<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  /** `refreshError`: a refresh of data already shown failed; the data stays usable. */
  | { status: 'ready'; data: T; refreshError?: unknown }
  | { status: 'error'; error: unknown };

function reportErrorOf(error: unknown): ReportErrorBody | null {
  return error instanceof ApiRequestError && isReportErrorBody(error.details) ? error.details : null;
}

const ID_ISSUES = new Set<ReportFilterIssueCode>(['invalid_id', 'too_many_ids']);
/** Shown by the control bar's custom-range form rather than as a page notice. */
const RANGE_ISSUES = new Set<ReportFilterIssueCode>([
  'custom_dates_required',
  'invalid_date',
  'date_before_min',
  'range_inverted',
  'range_too_long',
]);
/** Refusals that no retry can change. */
const TERMINAL_CODES = new Set<ReportErrorCode>(['report_no_locations_in_scope', 'report_forbidden', 'report_not_found']);
/** Result refusals whose notice carries a way to fix the filter. */
const FILTER_ACTION_CODES = new Set<ReportErrorCode>([
  'report_filter_invalid',
  'report_control_not_supported',
  'report_location_out_of_scope',
  'report_timezone_invalid',
  'report_week_start_unconfigured',
]);

const DEFAULT_FILTER: ReportFilter = { preset: 'today', locationIds: [], staffProfileIds: [], view: 'summary' };

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().every((id, i) => id === [...b].sort()[i]);
}

/**
 * One QLOOQO 10 report page on the shared foundation. Render it with
 * `key={definition.key}` so switching reports starts from a clean slate.
 *
 * The filter lives only in the URL. Options and result load in parallel; a
 * monotonic request id per stream discards any response that arrives after a
 * newer request (`request()` cannot be aborted). An access-token rotation alone
 * refreshes in place without blanking the page. A request that failed is shown
 * as a message with a way forward — never as an empty or zero report.
 */
export function ReportPage({ definition }: { definition: ReportDefinition }) {
  const { session, user } = useAuth();
  const accessToken = session?.accessToken ?? null;
  const userId = user?.id ?? null;
  const { filter, issues, filterKey, setFilter } = useReportFilter(definition);

  // Stable while the canonical filter is unchanged, so an unrelated URL
  // parameter or a canonicalising replace never sends a duplicate request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const requestFilter = useMemo<ReportFilter>(() => filter, [filterKey]);
  const blocked = issues.length > 0;
  const optionsKey = `${userId}|${definition.key}`;
  const resultKey = `${userId}|${definition.key}?${filterKey}`;

  const [options, setOptions] = useState<Loadable<ReportOptions>>({ status: 'loading' });
  const [result, setResult] = useState<Loadable<ReportResult>>({ status: 'idle' });
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [resultAttempt, setResultAttempt] = useState(0);
  const optionsRequest = useRef(0);
  const resultRequest = useRef(0);
  const shownOptionsKey = useRef<string | null>(null);
  const shownResultKey = useRef<string | null>(null);

  useEffect(() => {
    const id = ++optionsRequest.current;
    if (!accessToken) return;
    // Same user and report (a token rotation): keep what is shown while refreshing.
    setOptions((current) =>
      current.status === 'ready' && shownOptionsKey.current === optionsKey ? current : { status: 'loading' },
    );
    getReportOptions(accessToken, definition.key).then(
      (data) => {
        if (optionsRequest.current !== id) return;
        shownOptionsKey.current = optionsKey;
        setOptions({ status: 'ready', data });
      },
      (error: unknown) => {
        if (optionsRequest.current !== id) return;
        const code = reportErrorOf(error)?.code;
        const refusal = code !== undefined && TERMINAL_CODES.has(code);
        // A failed refresh of options already shown for this user and report
        // keeps them usable; a refusal (access withdrawn) never does.
        setOptions((current) =>
          current.status === 'ready' && shownOptionsKey.current === optionsKey && !refusal
            ? { status: 'ready', data: current.data, refreshError: error }
            : { status: 'error', error },
        );
      },
    );
  }, [accessToken, definition.key, optionsKey, optionsAttempt]);

  useEffect(() => {
    const id = ++resultRequest.current;
    if (!accessToken || blocked) {
      setResult({ status: 'idle' });
      return;
    }
    setResult((current) =>
      current.status === 'ready' && shownResultKey.current === resultKey ? current : { status: 'loading' },
    );
    getReportResult(accessToken, definition.key, requestFilter).then(
      (data) => {
        if (resultRequest.current !== id) return;
        shownResultKey.current = resultKey;
        setResult({ status: 'ready', data });
      },
      (error: unknown) => {
        if (resultRequest.current === id) setResult({ status: 'error', error });
      },
    );
  }, [accessToken, definition.key, requestFilter, resultKey, blocked, resultAttempt]);

  const optionsData = options.status === 'ready' ? options.data : null;
  const resolved = result.status === 'ready' && result.data.reportKey === definition.key ? result.data.filter : null;

  const write = (next: ReportFilter, mode: ReportFilterWriteMode) => setFilter(next, mode);
  const handlers: NoticeHandlers = {
    filter,
    optionsData,
    retryResult: () => setResultAttempt((n) => n + 1),
    write,
  };

  const optionsCode = options.status === 'error' ? reportErrorOf(options.error)?.code : undefined;
  const optionsRefused = optionsCode !== undefined && TERMINAL_CODES.has(optionsCode);
  const optionsRetryShown =
    (options.status === 'error' && !optionsRefused) || (options.status === 'ready' && options.refreshError !== undefined);
  // The page's one Retry: it also retries a failed result, which is then not
  // offered a Retry of its own.
  const retryOptions = () => {
    setOptionsAttempt((n) => n + 1);
    if (result.status === 'error') setResultAttempt((n) => n + 1);
  };
  const notices: ReactNode[] = [];
  if (options.status === 'error') {
    notices.push(
      optionsRefused ? (
        resultNotice(options.error, handlers)
      ) : (
        <Notice
          key="options"
          message="We couldn’t load this report’s options."
          action={<AppButton size="sm" variant="secondary" onClick={retryOptions}>Retry</AppButton>}
        />
      ),
    );
  } else if (options.status === 'ready' && options.refreshError !== undefined) {
    notices.push(
      <Notice
        key="options"
        message="We couldn’t refresh this report’s options."
        action={<AppButton size="sm" variant="secondary" onClick={retryOptions}>Retry</AppButton>}
      />,
    );
  }
  if (optionsRefused) {
    // The refusal is the whole story: nothing else on the page can succeed.
  } else if (blocked && issues.some((issue) => ID_ISSUES.has(issue.code))) {
    notices.push(
      <Notice
        key="ids"
        message="This link has location filters that aren’t valid."
        action={<AppButton size="sm" variant="secondary" onClick={() => write({ ...filter, locationIds: [] }, 'replace')}>Reset locations</AppButton>}
      />,
    );
  } else if (blocked && issues.some((issue) => !RANGE_ISSUES.has(issue.code))) {
    notices.push(
      <Notice
        key="link"
        message="This link has filters that aren’t valid."
        action={<AppButton size="sm" variant="secondary" onClick={() => write(DEFAULT_FILTER, 'replace')}>Reset filters</AppButton>}
      />,
    );
  } else if (result.status === 'error') {
    const resultCode = reportErrorOf(result.error)?.code;
    // Beside an options Retry, show only a refusal that carries its own way out
    // or needs none, so the page never offers two Retry buttons.
    const ownWayOut = resultCode !== undefined && (FILTER_ACTION_CODES.has(resultCode) || TERMINAL_CODES.has(resultCode));
    if (!optionsRetryShown || ownWayOut) {
      notices.push(resultNotice(result.error, handlers));
    }
  }

  const groups = resolved ? groupReportScope(resolved.locations) : [];

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
      <header className="mb-4">
        <AppText as="p" variant="micro" uppercase tone="muted">
          Reports
        </AppText>
        <AppText as="h1" variant="heading" weight="medium">
          {definition.label}
        </AppText>
      </header>

      <AppCard padding="md" className="mb-4">
        <ReportControlBar
          definition={definition}
          filter={filter}
          issues={issues}
          options={optionsData}
          resolvedLocations={resolved?.locations ?? null}
          disabled={options.status !== 'ready'}
          onChange={setFilter}
        />
      </AppCard>

      {notices}

      <section aria-label="Report dates" aria-live="polite" className="mb-4">
        {result.status === 'loading' ? (
          <AppText as="p" variant="caption" tone="muted">
            Working out each location’s dates…
          </AppText>
        ) : null}
        {groups.length > 0 ? (
          <div className="flex flex-col gap-1">
            {groups.map((group) => (
              <AppText as="p" variant="body" key={group.key}>
                <span className="text-text-secondary">{group.locationNames.join(', ')} · </span>
                <span className="font-medium">{group.label}</span>
              </AppText>
            ))}
            {groups.length > 1 ? (
              <AppText as="p" variant="caption" tone="muted">
                {LOCAL_CALENDAR_NOTE}
              </AppText>
            ) : null}
          </div>
        ) : null}
      </section>

      {resolved && definition.release === 'foundation' ? (
        <AppCard padding="md" variant="warning" elevation="none">
          <AppText as="p" variant="body" weight="medium">
            Foundation preview
          </AppText>
          <AppText as="p" variant="caption" tone="secondary">
            Figures arrive with this report’s own ticket. This page checks access, locations and dates only.
          </AppText>
        </AppCard>
      ) : null}
    </div>
  );
}

function Notice({ message, action }: { message: string; action?: ReactNode }) {
  return (
    <AppCard padding="md" variant="danger" elevation="none" className="mb-4" role="alert">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <AppText as="p" variant="body">
          {message}
        </AppText>
        {action ?? null}
      </div>
    </AppCard>
  );
}

interface NoticeHandlers {
  filter: ReportFilter;
  optionsData: ReportOptions | null;
  retryResult: () => void;
  write: (next: ReportFilter, mode: ReportFilterWriteMode) => void;
}

/**
 * For a timezone refusal: the permitted locations that can be reported on —
 * the valid part of the current selection, or every valid location when the
 * selection was "all" or held only broken ones. `null` when nothing usable
 * remains or it would not change the request.
 */
function reportableInstead(body: ReportErrorBody, handlers: NoticeHandlers): string[] | null {
  if (!handlers.optionsData) return null;
  const broken = new Set(body.locationIds ?? []);
  const usable = handlers.optionsData.locations
    .filter((location) => location.timezoneValid && !broken.has(location.id))
    .map((location) => location.id);
  const keptSelection = handlers.filter.locationIds.filter((id) => usable.includes(id));
  const target = (keptSelection.length > 0 ? keptSelection : usable).sort();
  if (target.length === 0 || sameIds(target, handlers.filter.locationIds)) return null;
  return target;
}

function resultNotice(error: unknown, handlers: NoticeHandlers): ReactNode {
  const body = reportErrorOf(error);
  const { filter, write } = handlers;
  const button = (label: string, onClick: () => void) => (
    <AppButton size="sm" variant="secondary" onClick={onClick}>
      {label}
    </AppButton>
  );
  switch (body?.code) {
    case 'report_filter_invalid':
    case 'report_control_not_supported':
      return (
        <Notice
          key="result"
          message="This link has filters this report can’t use."
          action={button('Reset filters', () => write(DEFAULT_FILTER, 'replace'))}
        />
      );
    case 'report_location_out_of_scope':
      return (
        <Notice
          key="result"
          message="This link includes a location you can’t report on."
          action={button('Reset locations', () => write({ ...filter, locationIds: [] }, 'push'))}
        />
      );
    case 'report_no_locations_in_scope':
      return <Notice key="result" message="You have no locations available for this report." />;
    case 'report_timezone_invalid': {
      const known = new Map((handlers.optionsData?.locations ?? []).map((l) => [l.id, l.name]));
      const names = (body.locationIds ?? []).map((id) => known.get(id)).filter((name): name is string => Boolean(name));
      const instead = reportableInstead(body, handlers);
      return (
        <Notice
          key="result"
          message={
            names.length > 0
              ? `These locations need their time zone fixing before they can be reported on: ${names.join(', ')}.`
              : 'A selected location needs its time zone fixing before it can be reported on.'
          }
          action={instead ? button('Report on the other locations', () => write({ ...filter, locationIds: instead }, 'push')) : undefined}
        />
      );
    }
    case 'report_week_start_unconfigured':
      return (
        <Notice
          key="result"
          message={WEEK_START_UNCONFIGURED_MESSAGE}
          action={button('Use today', () => write({ ...filter, preset: 'today', from: undefined, to: undefined }, 'push'))}
        />
      );
    case 'report_forbidden':
      return <Notice key="result" message="You don’t have access to this report." />;
    case 'report_not_found':
      return <Notice key="result" message="This report isn’t available." />;
    default:
      return (
        <Notice key="result" message="We couldn’t load this report." action={button('Retry', handlers.retryResult)} />
      );
  }
}
