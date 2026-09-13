import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  isReportErrorBody,
  type ReportDefinition,
  type ReportErrorBody,
  type ReportFilter,
  type ReportOptions,
  type ReportResult,
} from '@sheer/domain';
import { ApiRequestError, getReportOptions, getReportResult } from '../auth/api';
import { useAuth } from '../auth/AuthProvider';
import { AppButton, AppCard, AppText } from '../design';
import { ReportControlBar, WEEK_START_UNCONFIGURED_MESSAGE } from './ReportControlBar';
import { LOCAL_CALENDAR_NOTE, groupReportScope } from './reportScopeLine';
import { useReportFilter } from './useReportFilter';

type Loadable<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: unknown };

function reportErrorOf(error: unknown): ReportErrorBody | null {
  return error instanceof ApiRequestError && isReportErrorBody(error.details) ? error.details : null;
}

const ID_ISSUES = new Set(['invalid_id', 'too_many_ids']);

/**
 * One QLOOQO 10 report page on the shared foundation. Render it with
 * `key={definition.key}` so switching reports starts from a clean slate.
 *
 * The filter lives only in the URL. Options and result load in parallel; a
 * monotonic request id per stream discards any response that arrives after a
 * newer request (`request()` cannot be aborted). A request that failed is shown
 * as a message — never as an empty or zero report.
 */
export function ReportPage({ definition }: { definition: ReportDefinition }) {
  const { session } = useAuth();
  const accessToken = session?.accessToken ?? null;
  const { filter, issues, filterKey, setFilter } = useReportFilter(definition);

  // Stable while the canonical filter is unchanged, so an unrelated URL
  // parameter or a canonicalising replace never sends a duplicate request.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const requestFilter = useMemo<ReportFilter>(() => filter, [filterKey]);
  const blocked = issues.length > 0;

  const [options, setOptions] = useState<Loadable<ReportOptions>>({ status: 'loading' });
  const [result, setResult] = useState<Loadable<ReportResult>>({ status: 'idle' });
  const [optionsAttempt, setOptionsAttempt] = useState(0);
  const [resultAttempt, setResultAttempt] = useState(0);
  const optionsRequest = useRef(0);
  const resultRequest = useRef(0);

  useEffect(() => {
    const id = ++optionsRequest.current;
    if (!accessToken) return;
    setOptions({ status: 'loading' });
    getReportOptions(accessToken, definition.key).then(
      (data) => {
        if (optionsRequest.current === id) setOptions({ status: 'ready', data });
      },
      (error: unknown) => {
        if (optionsRequest.current === id) setOptions({ status: 'error', error });
      },
    );
  }, [accessToken, definition.key, optionsAttempt]);

  useEffect(() => {
    const id = ++resultRequest.current;
    if (!accessToken || blocked) {
      setResult({ status: 'idle' });
      return;
    }
    setResult({ status: 'loading' });
    getReportResult(accessToken, definition.key, requestFilter).then(
      (data) => {
        if (resultRequest.current === id) setResult({ status: 'ready', data });
      },
      (error: unknown) => {
        if (resultRequest.current === id) setResult({ status: 'error', error });
      },
    );
  }, [accessToken, definition.key, requestFilter, blocked, resultAttempt]);

  const optionsData = options.status === 'ready' ? options.data : null;
  const resolved = result.status === 'ready' && result.data.reportKey === definition.key ? result.data.filter : null;

  const resetLocations = () => setFilter({ ...filter, locationIds: [] }, 'push');
  const resetFilters = () =>
    setFilter({ preset: 'today', locationIds: [], staffProfileIds: [], view: 'summary' }, 'replace');

  let notice: ReactNode = null;
  if (options.status === 'error') {
    const code = reportErrorOf(options.error)?.code;
    notice =
      code === 'report_no_locations_in_scope' ? (
        <Notice message="You have no locations available for this report." />
      ) : (
        <Notice
          message="We couldn’t load this report’s options."
          action={<AppButton size="sm" variant="secondary" onClick={() => setOptionsAttempt((n) => n + 1)}>Retry</AppButton>}
        />
      );
  } else if (blocked && issues.some((issue) => ID_ISSUES.has(issue.code))) {
    notice = (
      <Notice
        message="This link has location filters that aren’t valid."
        action={<AppButton size="sm" variant="secondary" onClick={() => setFilter({ ...filter, locationIds: [] }, 'replace')}>Reset locations</AppButton>}
      />
    );
  } else if (result.status === 'error') {
    notice = resultNotice(result.error, {
      optionsData,
      retry: () => setResultAttempt((n) => n + 1),
      resetLocations,
      resetFilters,
      useToday: () => setFilter({ ...filter, preset: 'today', from: undefined, to: undefined }, 'push'),
    });
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

      {notice}

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
                <span className="font-medium">{group.label}</span>
                <span className="text-text-secondary"> · {group.locationNames.join(', ')}</span>
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

function resultNotice(
  error: unknown,
  handlers: {
    optionsData: ReportOptions | null;
    retry: () => void;
    resetLocations: () => void;
    resetFilters: () => void;
    useToday: () => void;
  },
): ReactNode {
  const body = reportErrorOf(error);
  switch (body?.code) {
    case 'report_filter_invalid':
    case 'report_control_not_supported':
      return (
        <Notice
          message="This link has filters this report can’t use."
          action={<AppButton size="sm" variant="secondary" onClick={handlers.resetFilters}>Reset filters</AppButton>}
        />
      );
    case 'report_location_out_of_scope':
      return (
        <Notice
          message="This link includes a location you can’t report on."
          action={<AppButton size="sm" variant="secondary" onClick={handlers.resetLocations}>Reset locations</AppButton>}
        />
      );
    case 'report_no_locations_in_scope':
      return <Notice message="You have no locations available for this report." />;
    case 'report_timezone_invalid': {
      const known = new Map((handlers.optionsData?.locations ?? []).map((l) => [l.id, l.name]));
      const names = (body.locationIds ?? []).map((id) => known.get(id)).filter((name): name is string => Boolean(name));
      return (
        <Notice
          message={
            names.length > 0
              ? `These locations need their time zone fixing before they can be reported on: ${names.join(', ')}.`
              : 'A selected location needs its time zone fixing before it can be reported on.'
          }
          action={<AppButton size="sm" variant="secondary" onClick={handlers.resetLocations}>Reset locations</AppButton>}
        />
      );
    }
    case 'report_week_start_unconfigured':
      return (
        <Notice
          message={WEEK_START_UNCONFIGURED_MESSAGE}
          action={<AppButton size="sm" variant="secondary" onClick={handlers.useToday}>Use today</AppButton>}
        />
      );
    case 'report_forbidden':
      return <Notice message="You don’t have access to this report." />;
    case 'report_not_found':
      return <Notice message="This report isn’t available." />;
    default:
      return (
        <Notice
          message="We couldn’t load this report."
          action={<AppButton size="sm" variant="secondary" onClick={handlers.retry}>Retry</AppButton>}
        />
      );
  }
}
