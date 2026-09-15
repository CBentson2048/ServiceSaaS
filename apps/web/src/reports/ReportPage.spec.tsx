/**
 * A report page on the foundation: parallel loading, one request per change,
 * stale responses discarded, every refusal shown as a message with a way out
 * (never an empty or zero page), and dates shown per location without a clock
 * time.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect } from 'react';
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  getReportDefinition,
  type MoneyDetailPage,
  type MoneyReportBody,
  type MoneyTotals,
  type ReportDefinition,
  type ReportOptions,
  type ReportResult,
  type ResolvedReportLocation,
} from '@sheer/domain';
import { ReportPage } from './ReportPage';

jest.mock('../auth/api', () => {
  class ApiRequestError extends Error {
    status: number;
    details?: unknown;
    constructor(message: string, status: number, details?: unknown) {
      super(message);
      this.status = status;
      this.details = details;
    }
  }
  return { ApiRequestError, getReportOptions: jest.fn(), getReportResult: jest.fn() };
});

let mockToken = 'token';
let mockUserId = 'u';

jest.mock('../auth/AuthProvider', () => ({
  useAuth: () => ({ status: 'authenticated', session: { accessToken: mockToken }, user: { id: mockUserId, roles: ['owner'] } }),
}));

const api = jest.requireMock('../auth/api') as {
  ApiRequestError: new (message: string, status: number, details?: unknown) => Error;
  getReportOptions: jest.Mock;
  getReportResult: jest.Mock;
};

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';

const options = (weekStartDay: 2 | null = 2): ReportOptions => ({
  reportKey: 'money',
  weekStartDay,
  locations: [
    { id: L1, name: 'London', timezone: 'Europe/London', isActive: true, timezoneValid: true },
    { id: L2, name: 'Tokyo', timezone: 'Asia/Tokyo', isActive: true, timezoneValid: true },
  ],
});

const loc = (id: string, name: string, from: string, to: string, status: ResolvedReportLocation['status'], localToday = to): ResolvedReportLocation => ({
  id, name, timezone: name === 'Tokyo' ? 'Asia/Tokyo' : 'Europe/London', isActive: true, timezoneValid: true, localToday, from, to, status,
});

const result = (reportKey: ReportResult['reportKey'], locations: ResolvedReportLocation[]): ReportResult => ({
  reportKey,
  filter: { reportKey, filter: { preset: 'today', locationIds: [], staffProfileIds: [], view: 'summary' }, weekStartDay: null, locations },
  body: null,
});

const reportError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new api.ApiRequestError(code, status, { statusCode: status, code, message: code, ...extra });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let currentSearch = '';
let navigateTo: ((to: string) => void) | null = null;

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  currentSearch = location.search;
  useEffect(() => {
    navigateTo = (to: string) => navigate(to);
  }, [navigate]);
  return null;
}

function KeyedReport() {
  const { key } = useParams();
  const definition = getReportDefinition(key ?? '') as ReportDefinition;
  return <ReportPage key={definition.key} definition={definition} />;
}

function renderAt(url: string) {
  // A fresh element each time: re-rendering the identical element is a React bail-out.
  const tree = () => (
    <MemoryRouter initialEntries={[url]}>
      <Probe />
      <Routes>
        <Route path="/reports/:key" element={<KeyedReport />} />
      </Routes>
    </MemoryRouter>
  );
  const view = render(tree());
  return { ...view, rerenderSame: () => view.rerender(tree()) };
}

beforeEach(() => {
  api.getReportOptions.mockReset();
  api.getReportResult.mockReset();
  mockToken = 'token';
  mockUserId = 'u';
});

describe('loading', () => {
  it('requests options and result in parallel', async () => {
    const pendingOptions = deferred<ReportOptions>();
    const pendingResult = deferred<ReportResult>();
    api.getReportOptions.mockReturnValue(pendingOptions.promise);
    api.getReportResult.mockReturnValue(pendingResult.promise);
    renderAt('/reports/money');
    expect(api.getReportOptions).toHaveBeenCalledWith('token', 'money');
    expect(api.getReportResult).toHaveBeenCalledWith('token', 'money', { preset: 'today', locationIds: [], staffProfileIds: [], view: 'summary' });
    await act(async () => {
      pendingOptions.resolve(options());
      pendingResult.resolve(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    });
  });

  it('loads options once per report and sends exactly one result request per change', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockResolvedValue(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    renderAt('/reports/money');
    await screen.findByText('28 Sept 2026 (in progress)');
    fireEvent.click(screen.getByRole('tab', { name: 'Last week' }));
    await waitFor(() => expect(api.getReportResult).toHaveBeenCalledTimes(2));
    expect(api.getReportResult.mock.calls[1][2]).toMatchObject({ preset: 'last_week' });
    expect(api.getReportOptions).toHaveBeenCalledTimes(1);
  });

  it('sends no request when the chosen preset is already active', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockResolvedValue(result('money', []));
    renderAt('/reports/money?preset=yesterday');
    await waitFor(() => expect(api.getReportResult).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole('tab', { name: 'Yesterday' }));
    await act(async () => undefined);
    expect(api.getReportResult).toHaveBeenCalledTimes(1);
  });

  it('sends no result request for an invalid custom range in the URL', async () => {
    api.getReportOptions.mockResolvedValue(options());
    renderAt('/reports/money?preset=custom&from=2026-09-29&to=2026-09-22');
    await screen.findByText(/on or before the end date/);
    expect(api.getReportResult).not.toHaveBeenCalled();
  });

  it('does not send a second request when the URL is only canonicalised', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockResolvedValue(result('money', []));
    renderAt(`/reports/money?staff=${L1}&preset=yesterday`);
    await waitFor(() => expect(currentSearch).toBe('?preset=yesterday'));
    await act(async () => undefined);
    expect(api.getReportResult).toHaveBeenCalledTimes(1);
  });
});

describe('races', () => {
  it('discards a response that arrives after a newer one', async () => {
    api.getReportOptions.mockResolvedValue(options());
    const first = deferred<ReportResult>();
    const second = deferred<ReportResult>();
    api.getReportResult.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderAt('/reports/money');
    fireEvent.click(await screen.findByRole('tab', { name: 'Yesterday' }));
    await waitFor(() => expect(api.getReportResult).toHaveBeenCalledTimes(2));
    await act(async () => second.resolve(result('money', [loc(L1, 'London', '2026-09-27', '2026-09-27', 'complete')])));
    await act(async () => first.resolve(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')])));
    expect(screen.getByText('27 Sept 2026')).toBeTruthy();
    expect(screen.queryByText('28 Sept 2026 (in progress)')).toBeNull();
  });

  it('discards a stale error that arrives after a newer success', async () => {
    api.getReportOptions.mockResolvedValue(options());
    const first = deferred<ReportResult>();
    api.getReportResult.mockReturnValueOnce(first.promise).mockResolvedValueOnce(result('money', [loc(L1, 'London', '2026-09-27', '2026-09-27', 'complete')]));
    renderAt('/reports/money');
    fireEvent.click(await screen.findByRole('tab', { name: 'Yesterday' }));
    await screen.findByText('27 Sept 2026');
    await act(async () => first.reject(reportError(500, 'boom')));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('switching reports with identical parameters never shows the previous report’s data', async () => {
    const teamOptions = deferred<ReportOptions>();
    const teamResult = deferred<ReportResult>();
    api.getReportOptions.mockReturnValueOnce(teamOptions.promise).mockResolvedValueOnce(options());
    api.getReportResult.mockReturnValueOnce(teamResult.promise).mockResolvedValueOnce(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    renderAt('/reports/team?preset=today');
    act(() => navigateTo?.('/reports/money?preset=today'));
    await screen.findByRole('heading', { name: 'Money' });
    await act(async () => {
      teamOptions.resolve({ ...options(), reportKey: 'team' });
      teamResult.resolve(result('team', [loc(L2, 'Tokyo', '2026-09-29', '2026-09-29', 'in_progress')]));
    });
    await screen.findByText('28 Sept 2026 (in progress)');
    expect(screen.queryByText(/Tokyo/)).toBeNull();
    expect(api.getReportResult.mock.calls[1][1]).toBe('money');
  });

  it('clears the dates while a new filter loads', async () => {
    api.getReportOptions.mockResolvedValue(options());
    const second = deferred<ReportResult>();
    api.getReportResult.mockResolvedValueOnce(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')])).mockReturnValueOnce(second.promise);
    renderAt('/reports/money');
    await screen.findByText('28 Sept 2026 (in progress)');
    fireEvent.click(screen.getByRole('tab', { name: 'Last month' }));
    await waitFor(() => expect(screen.queryByText('28 Sept 2026 (in progress)')).toBeNull());
    expect(screen.getByText(/Working out each location’s dates/)).toBeTruthy();
    await act(async () => second.resolve(result('money', [])));
  });
});

describe('refusals are messages with a way out', () => {
  it('a shared link naming a location outside scope: message, then Reset locations re-requests all permitted', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockRejectedValueOnce(reportError(403, 'report_location_out_of_scope')).mockResolvedValueOnce(result('money', []));
    renderAt(`/reports/money?locations=${L2}`);
    await screen.findByText('This link includes a location you can’t report on.');
    expect(within(screen.getByRole('region', { name: 'Report dates' })).queryByText(/Tokyo/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Reset locations' }));
    await waitFor(() => expect(api.getReportResult).toHaveBeenCalledTimes(2));
    expect(currentSearch).toBe('');
    expect(api.getReportResult.mock.calls[1][2]).toMatchObject({ locationIds: [] });
    expect((screen.getByRole('tab', { name: 'Today' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('an unusable filter: message and Reset filters', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockRejectedValueOnce(reportError(400, 'report_filter_invalid')).mockResolvedValueOnce(result('money', []));
    renderAt('/reports/money?preset=last_month&view=detail');
    await screen.findByText('This link has filters this report can’t use.');
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(currentSearch).toBe(''));
  });

  it('malformed location ids never reach the API', async () => {
    api.getReportOptions.mockResolvedValue(options());
    renderAt('/reports/money?locations=bogus');
    await screen.findByText('This link has location filters that aren’t valid.');
    expect(api.getReportResult).not.toHaveBeenCalled();
    api.getReportResult.mockResolvedValue(result('money', []));
    fireEvent.click(screen.getByRole('button', { name: 'Reset locations' }));
    await waitFor(() => expect(api.getReportResult).toHaveBeenCalledTimes(1));
  });

  it('no permitted locations: a plain message, no retry', async () => {
    api.getReportOptions.mockRejectedValue(reportError(403, 'report_no_locations_in_scope'));
    api.getReportResult.mockRejectedValue(reportError(403, 'report_no_locations_in_scope'));
    renderAt('/reports/money');
    await screen.findByText('You have no locations available for this report.');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('options failure: Retry fetches the options again', async () => {
    api.getReportOptions.mockRejectedValueOnce(reportError(500, 'boom')).mockResolvedValueOnce(options());
    api.getReportResult.mockResolvedValue(result('money', []));
    renderAt('/reports/money');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.getReportOptions).toHaveBeenCalledTimes(2));
  });

  it('missing week start: message and Use today', async () => {
    api.getReportOptions.mockResolvedValue(options(null));
    api.getReportResult.mockRejectedValueOnce(reportError(409, 'report_week_start_unconfigured')).mockResolvedValueOnce(result('money', []));
    renderAt('/reports/money?preset=this_week');
    const messages = await screen.findAllByText(/no week start configured/);
    expect(messages.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Use today' }));
    await waitFor(() => expect(currentSearch).toBe(''));
  });

  it('invalid timezone: names the locations it knows from the options', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockRejectedValue(reportError(422, 'report_timezone_invalid', { locationIds: [L2] }));
    renderAt('/reports/money');
    await screen.findByText(/need their time zone fixing.*Tokyo/);
  });

  it('invalid timezone on "all locations": Report on the other locations requests only the valid ones', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult
      .mockRejectedValueOnce(reportError(422, 'report_timezone_invalid', { locationIds: [L2] }))
      .mockResolvedValueOnce(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    renderAt('/reports/money');
    fireEvent.click(await screen.findByRole('button', { name: 'Report on the other locations' }));
    await waitFor(() => expect(api.getReportResult).toHaveBeenCalledTimes(2));
    expect(api.getReportResult.mock.calls[1][2]).toMatchObject({ locationIds: [L1] });
    expect(currentSearch).toBe(`?locations=${L1}`);
  });

  it('invalid timezone on an explicit link to the broken location: offers the valid locations instead', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult
      .mockRejectedValueOnce(reportError(422, 'report_timezone_invalid', { locationIds: [L2] }))
      .mockResolvedValueOnce(result('money', []));
    renderAt(`/reports/money?locations=${L2}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Report on the other locations' }));
    await waitFor(() => expect(currentSearch).toBe(`?locations=${L1}`));
  });

  it('invalid timezone everywhere: the message, and no action that cannot work', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockRejectedValue(reportError(422, 'report_timezone_invalid', { locationIds: [L1, L2] }));
    renderAt('/reports/money');
    await screen.findByText(/need their time zone fixing/);
    expect(screen.queryByRole('button', { name: 'Report on the other locations' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset locations' })).toBeNull();
  });

  it('options refused for good (403 / 404): a plain message, never a Retry that cannot succeed', async () => {
    api.getReportOptions.mockRejectedValue(reportError(403, 'report_forbidden'));
    api.getReportResult.mockRejectedValue(reportError(403, 'report_forbidden'));
    const { unmount } = renderAt('/reports/money');
    await screen.findByText('You don’t have access to this report.');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    unmount();
    api.getReportOptions.mockRejectedValue(reportError(404, 'report_not_found'));
    api.getReportResult.mockRejectedValue(reportError(404, 'report_not_found'));
    renderAt('/reports/money');
    await screen.findByText('This report isn’t available.');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('a transient options failure still shows the result’s own way out', async () => {
    api.getReportOptions.mockRejectedValue(reportError(500, 'boom'));
    api.getReportResult.mockRejectedValue(reportError(403, 'report_location_out_of_scope'));
    renderAt(`/reports/money?locations=${L2}`);
    await screen.findByText('This link includes a location you can’t report on.');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset locations' })).toBeTruthy();
  });

  it('a link with a repeated parameter is refused as invalid, without a request', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockResolvedValue(result('money', []));
    renderAt(`/reports/money?locations=${L1}&locations=${L2}`);
    await screen.findByText('This link has filters that aren’t valid.');
    expect(api.getReportResult).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(currentSearch).toBe(''));
    await waitFor(() => expect(api.getReportResult).toHaveBeenCalledTimes(1));
  });

  it('an unexpected failure shows an error with Retry, never an empty report', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(result('money', []));
    renderAt('/reports/money');
    await screen.findByText('We couldn’t load this report.');
    expect(screen.queryByText('Foundation preview')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.getReportResult).toHaveBeenCalledTimes(2));
  });
});

describe('access-token rotation', () => {
  it('refreshes in place: controls stay enabled and the dates stay visible while the new token re-fetches', async () => {
    api.getReportOptions.mockResolvedValueOnce(options());
    api.getReportResult.mockResolvedValueOnce(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    const { rerenderSame } = renderAt('/reports/money');
    await screen.findByText('28 Sept 2026 (in progress)');
    const pendingOptions = deferred<ReportOptions>();
    const pendingResult = deferred<ReportResult>();
    api.getReportOptions.mockReturnValueOnce(pendingOptions.promise);
    api.getReportResult.mockReturnValueOnce(pendingResult.promise);
    mockToken = 'token-2';
    rerenderSame();
    await waitFor(() => expect(api.getReportResult).toHaveBeenCalledTimes(2));
    expect(api.getReportResult.mock.calls[1][0]).toBe('token-2');
    expect(screen.getByText('28 Sept 2026 (in progress)')).toBeTruthy();
    expect((screen.getByRole('tab', { name: 'Today' }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => {
      pendingOptions.resolve(options());
      pendingResult.resolve(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    });
  });

  it('a different signed-in user does not see the previous user’s dates while loading', async () => {
    api.getReportOptions.mockResolvedValueOnce(options());
    api.getReportResult.mockResolvedValueOnce(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    const { rerenderSame } = renderAt('/reports/money');
    await screen.findByText('28 Sept 2026 (in progress)');
    api.getReportOptions.mockReturnValueOnce(deferred<ReportOptions>().promise);
    api.getReportResult.mockReturnValueOnce(deferred<ReportResult>().promise);
    mockToken = 'other-token';
    mockUserId = 'someone-else';
    rerenderSame();
    await waitFor(() => expect(screen.queryByText('28 Sept 2026 (in progress)')).toBeNull());
  });
});

describe('review fixes', () => {
  it('writes each scope line names first: "London · 28 Sept 2026 (in progress)"', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockResolvedValue(
      result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress'), loc(L2, 'Tokyo', '2026-09-29', '2026-09-29', 'in_progress')]),
    );
    renderAt('/reports/money');
    await screen.findByText('28 Sept 2026 (in progress)');
    const lines = within(screen.getByRole('region', { name: 'Report dates' })).getAllByText(/Sept 2026/).map((node) => node.parentElement?.textContent);
    expect(lines).toEqual(['London · 28 Sept 2026 (in progress)', 'Tokyo · 29 Sept 2026 (in progress)']);
  });

  it('a failed options refresh keeps the controls usable and offers a quiet Retry', async () => {
    api.getReportOptions.mockResolvedValueOnce(options());
    api.getReportResult.mockResolvedValue(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    const { rerenderSame } = renderAt('/reports/money');
    await screen.findByText('28 Sept 2026 (in progress)');
    api.getReportOptions.mockRejectedValueOnce(reportError(500, 'boom')).mockResolvedValueOnce(options());
    mockToken = 'token-2';
    rerenderSame();
    await screen.findByText('We couldn’t refresh this report’s options.');
    expect((screen.getByRole('tab', { name: 'Today' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByText('We couldn’t load this report’s options.')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByText('We couldn’t refresh this report’s options.')).toBeNull());
  });

  it('one Retry when both refreshes fail during an outage, and it retries both', async () => {
    api.getReportOptions.mockResolvedValueOnce(options());
    api.getReportResult.mockResolvedValueOnce(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    const { rerenderSame } = renderAt('/reports/money');
    await screen.findByText('28 Sept 2026 (in progress)');
    api.getReportOptions.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(options());
    api.getReportResult.mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    mockToken = 'token-2';
    rerenderSame();
    await waitFor(() => expect(api.getReportResult).toHaveBeenCalledTimes(2));
    // One notice, worded for what is missing (the report), with one Retry.
    await screen.findByText('We couldn’t load this report.');
    expect(screen.queryByText('We couldn’t refresh this report’s options.')).toBeNull();
    expect(screen.getAllByRole('alert')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(api.getReportResult).toHaveBeenCalledTimes(3));
    await screen.findByText('28 Sept 2026 (in progress)');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });

  it('after a quiet options refresh failure, a report that then fails to load is said so', async () => {
    api.getReportOptions.mockResolvedValueOnce(options());
    api.getReportResult.mockResolvedValue(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    const { rerenderSame } = renderAt('/reports/money');
    await screen.findByText('28 Sept 2026 (in progress)');
    api.getReportOptions.mockRejectedValueOnce(new Error('network'));
    mockToken = 'token-2';
    rerenderSame();
    await screen.findByText('We couldn’t refresh this report’s options.');
    api.getReportResult.mockRejectedValueOnce(new Error('network'));
    fireEvent.click(screen.getByRole('tab', { name: 'Yesterday' }));
    await screen.findByText('We couldn’t load this report.');
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(1);
  });

  it('a refresh refused for access withdrawn is not kept quiet', async () => {
    api.getReportOptions.mockResolvedValueOnce(options());
    api.getReportResult.mockResolvedValueOnce(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    const { rerenderSame } = renderAt('/reports/money');
    await screen.findByText('28 Sept 2026 (in progress)');
    api.getReportOptions.mockRejectedValueOnce(reportError(403, 'report_forbidden'));
    api.getReportResult.mockRejectedValueOnce(reportError(403, 'report_forbidden'));
    mockToken = 'token-2';
    rerenderSame();
    await screen.findByText('You don’t have access to this report.');
    expect((screen.getByRole('tab', { name: 'Today' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('while options fail, a link with bad location ids still shows its own way out', async () => {
    api.getReportOptions.mockRejectedValue(reportError(500, 'boom'));
    renderAt('/reports/money?locations=bogus');
    await screen.findByText('We couldn’t load this report’s options.');
    expect(screen.getByText('This link has location filters that aren’t valid.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset locations' })).toBeTruthy();
  });
});

describe('R1 Money body', () => {
  const zero = { availability: 'available', cents: 0 } as const;
  const totals: MoneyTotals = {
    paidBills: { gross: { availability: 'available', cents: 35500 }, netOfVat: zero, vat: zero },
    composition: [
      { key: 'service', gross: zero },
      { key: 'product_usage', gross: zero },
      { key: 'adjustment', gross: zero },
      { key: 'not_itemised', gross: zero },
    ],
    colour: { gross: zero, netOfVat: zero, vat: zero },
    settlement: [
      { key: 'cash', amount: zero },
      { key: 'card_reader', amount: zero },
      { key: 'deposits_applied', amount: zero },
      { key: 'not_itemised', amount: zero },
    ],
    retail: { recorded: zero, vat: { availability: 'unavailable', reason: 'not_captured' }, byMethod: [] },
    deposits: { collected: zero, redeemed: zero, refunded: zero },
    netPosition: { availability: 'unavailable', reason: 'definition_pending' },
  };
  const moneyBody = (detail: MoneyDetailPage | null): MoneyReportBody => ({
    currencyCode: 'GBP',
    summary: totals,
    locations: [{ locationId: L1, totals }],
    notRecorded: ['discounts'],
    coverage: { tillPaymentsWithoutBill: { count: 0, amount: zero } },
    detail,
  });
  const detailRow = (n: number): MoneyDetailPage['rows'][number] => ({
    kind: 'retail_sale',
    rowKey: `retail_sale:${n}`,
    locationId: L1,
    localDate: '2026-09-28',
    localTime: '10:0' + n,
    currencyCode: 'GBP',
    amount: { availability: 'available', cents: 100 * n },
    quantity: n,
    method: 'cash',
  });
  const moneyResult = (detail: MoneyDetailPage | null): ReportResult => ({
    ...result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]),
    body: moneyBody(detail),
  });

  it('renders the Money figures in place of the foundation preview card, under the same scope line', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockResolvedValue(moneyResult(null));
    renderAt('/reports/money');
    await screen.findByRole('region', { name: 'Paid bill revenue' });
    expect(screen.getByText('£355.00')).toBeTruthy();
    expect(screen.getByText('28 Sept 2026 (in progress)')).toBeTruthy();
    expect(screen.queryByText('Foundation preview')).toBeNull();
  });

  it('Detail asks for the detail view, and Load more pages with the same filter and the cursor', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult
      .mockResolvedValueOnce(moneyResult(null))
      .mockResolvedValueOnce(moneyResult({ rows: [detailRow(1)], nextCursor: 'm1.next' }))
      .mockResolvedValueOnce(moneyResult({ rows: [detailRow(2)], nextCursor: null }));
    renderAt(`/reports/money?locations=${L1}`);
    await screen.findByRole('region', { name: 'Paid bill revenue' });
    fireEvent.click(screen.getByRole('tab', { name: 'Detail' }));
    await screen.findByRole('region', { name: 'Detail' });
    expect(api.getReportResult.mock.calls[1][2]).toMatchObject({ view: 'detail', locationIds: [L1] });
    expect(currentSearch).toBe(`?locations=${L1}&view=detail`);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('10:02');
    expect(api.getReportResult.mock.calls[2]).toEqual(['token', 'money', expect.objectContaining({ view: 'detail', locationIds: [L1] }), 'm1.next']);
    expect(screen.getByText('10:01')).toBeTruthy();
  });
});

describe('dates and the foundation preview', () => {
  it('shows each location’s own dates, grouped, with the local-calendar note and no clock time', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockResolvedValue(
      result('money', [
        loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress'),
        loc(L2, 'Tokyo', '2026-09-29', '2026-09-29', 'in_progress'),
      ]),
    );
    renderAt('/reports/money');
    await screen.findByText('28 Sept 2026 (in progress)');
    expect(screen.getByText('29 Sept 2026 (in progress)')).toBeTruthy();
    expect(screen.getByText('Dates follow each location’s local calendar.')).toBeTruthy();
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/\d{1,2}:\d{2}/);
    expect(text).not.toMatch(/\dZ\b|T\d{2}/);
  });

  it('shows an unstarted location as not started, never as a zero or a currency', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockResolvedValue(result('money', [loc(L1, 'London', '2026-09-29', '2026-09-29', 'not_started', '2026-09-28')]));
    renderAt('/reports/money?preset=custom&from=2026-09-29&to=2026-09-29');
    await screen.findByText('29 Sept 2026 (not started)');
    const text = document.body.textContent ?? '';
    expect(text).not.toMatch(/£|\$|€/);
  });

  it('shows the foundation preview banner — no figures, no "Not connected yet"', async () => {
    api.getReportOptions.mockResolvedValue(options());
    api.getReportResult.mockResolvedValue(result('money', [loc(L1, 'London', '2026-09-28', '2026-09-28', 'in_progress')]));
    renderAt('/reports/money');
    await screen.findByText('Foundation preview');
    expect(document.body.textContent).not.toMatch(/Not connected yet|£/);
  });
});
