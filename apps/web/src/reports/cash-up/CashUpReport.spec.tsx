/**
 * The R7 Cash Up body renders the API's figures as they are. A day without a
 * cash-up, a figure that can't be compared, or an unset threshold reads as words,
 * never £0.00; nothing is recomputed in the browser.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CashUpAmount, CashUpDayRow, CashUpDetailPage, CashUpTotals, ResolvedReportLocation } from '@sheer/domain';
import { CashUpReport, type CashUpFirstPage } from './CashUpReport';

const LONDON = '11111111-1111-4111-8111-111111111111';
const NEW_YORK = '22222222-2222-4222-8222-222222222222';
const a = (cents: number): CashUpAmount => ({ availability: 'available', cents });
const u = (reason: string) => ({ availability: 'unavailable', reason }) as CashUpAmount;

const locations: ResolvedReportLocation[] = [
  { id: LONDON, name: 'London', timezone: 'Europe/London', isActive: true, timezoneValid: true, localToday: '2026-09-14', from: '2026-09-12', to: '2026-09-15', status: 'in_progress' },
  { id: NEW_YORK, name: 'New York', timezone: 'America/New_York', isActive: true, timezoneValid: true, localToday: '2026-09-14', from: '2026-09-12', to: '2026-09-15', status: 'in_progress' },
];

function totals(overrides: Partial<CashUpTotals> = {}): CashUpTotals {
  return {
    days: { started: 3, signedOff: 2, open: 1, none: 0, notStarted: 1 },
    recorded: {
      cash: { expected: a(5000), counted: a(5500), variance: a(500) },
      card: { expected: a(26500), counted: a(26500), variance: a(0) },
      variance: a(500),
      pettyCashOut: a(500),
      refundsEntered: a(1200),
      voidsEntered: a(0),
      daysOutsideThreshold: { availability: 'available', count: 1 },
      daysUnavailable: 0,
    },
    sourceCheck: { daysChanged: { availability: 'available', count: 1 }, cashChange: a(500), cardChange: a(0) },
    withoutSignOff: { expectedCash: a(900), expectedCard: a(3000) },
    retailOutsideTill: { other: a(300), notRecorded: a(200) },
    ...overrides,
  };
}

const nyTotals = totals({
  days: { started: 3, signedOff: 1, open: 0, none: 2, notStarted: 1 },
  recorded: {
    cash: { expected: u('london_trading_day'), counted: u('london_trading_day'), variance: u('london_trading_day') },
    card: { expected: u('london_trading_day'), counted: u('london_trading_day'), variance: u('london_trading_day') },
    variance: u('london_trading_day'),
    pettyCashOut: a(300),
    refundsEntered: a(0),
    voidsEntered: a(0),
    daysOutsideThreshold: { availability: 'unavailable', reason: 'threshold_not_set' },
    daysUnavailable: 1,
  },
});

const signedRow = (date: string, variance: number): CashUpDayRow => ({
  rowKey: `${LONDON}:${date}`,
  locationId: LONDON,
  localDate: date,
  isToday: false,
  status: 'signed_off',
  currencyCode: 'GBP',
  record: {
    openingFloat: a(10000),
    cash: { expected: a(4000), counted: a(4000 + variance), variance: a(variance) },
    card: { expected: a(26500), counted: a(26500), variance: a(0) },
    variance: a(variance),
    outsideThreshold: false,
    pettyCashOut: a(500),
    refundsEntered: a(0),
    voidsEntered: a(0),
    signedOffBy: 'Ava Stone',
    signedOff: { localDate: date, localTime: '20:30' },
    notes: 'Float miscounted',
  },
  sources: { expectedCash: a(4000), expectedCard: a(26500), retailOther: a(0), retailNotRecorded: a(0) },
  changeSinceSignOff: { cash: a(0), card: a(0) },
});

const noCashUpToday: CashUpDayRow = {
  rowKey: `${NEW_YORK}:2026-09-14`,
  locationId: NEW_YORK,
  localDate: '2026-09-14',
  isToday: true,
  status: 'none',
  currencyCode: 'USD',
  record: null,
  sources: { expectedCash: a(0), expectedCard: a(700), retailOther: a(0), retailNotRecorded: a(0) },
  changeSinceSignOff: null,
};

const body = (overrides: Partial<CashUpFirstPage> = {}): CashUpFirstPage => ({
  continuation: false,
  currencyCode: 'GBP',
  summary: totals(),
  locations: [
    { locationId: LONDON, currencyCode: 'GBP', threshold: a(500), totals: totals() },
    { locationId: NEW_YORK, currencyCode: 'GBP', threshold: u('threshold_not_set'), totals: nyTotals },
  ],
  detail: null,
  ...overrides,
});

const page = (rows: CashUpDayRow[], nextCursor: string | null): CashUpDetailPage => ({ notStarted: false, rows, nextCursor });
const section = (name: string) => screen.getByRole('region', { name });
const valueOf = (region: HTMLElement, label: string) => within(region).getByText(label).nextSibling?.textContent;

describe('CashUpReport summary', () => {
  it('shows the recorded tills by tender, the variance and the day counts, formatted, never recomputed', () => {
    render(<CashUpReport body={body()} locations={locations} loadMore={jest.fn()} />);
    const recorded = section('Signed-off days, as recorded');
    const cashRow = within(recorded).getByRole('rowheader', { name: 'Cash' }).parentElement!;
    expect(cashRow.textContent).toBe('Cash£50.00£55.00£5.00');
    expect(valueOf(recorded, 'Variance, both tenders')).toBe('£5.00');
    expect(valueOf(recorded, 'Days outside threshold')).toBe('1');
    expect(valueOf(section('Days'), 'No cash-up recorded')).toBe('0');
    expect(valueOf(section('Changed since sign-off'), 'Cash')).toBe('£5.00');
    expect(valueOf(section('Takings without a signed-off cash-up'), 'Expected card')).toBe('£30.00');
    expect(valueOf(section('Retail outside the till'), 'Payment method not recorded')).toBe('£2.00');
  });

  it('a manual entry of zero reads None entered, because a zero can’t be told apart from not entered', () => {
    render(<CashUpReport body={body()} locations={locations} loadMore={jest.fn()} />);
    const recorded = section('Signed-off days, as recorded');
    expect(valueOf(recorded, 'Voids entered at cash-up')).toBe('None entered');
    expect(valueOf(recorded, 'Refunds entered at cash-up')).toBe('£12.00');
  });

  it('figures that can’t be compared, and an unset threshold, are words — never £0.00', () => {
    render(<CashUpReport body={body({ summary: nyTotals })} locations={locations} loadMore={jest.fn()} />);
    const recorded = section('Signed-off days, as recorded');
    expect(within(recorded).getByRole('rowheader', { name: 'Card' }).parentElement!.textContent).not.toMatch(/£/);
    expect(valueOf(recorded, 'Variance, both tenders')).toBe('Not comparable (London trading day)');
    expect(valueOf(recorded, 'Days outside threshold')).toBe('No threshold set');
    expect(recorded.textContent).toContain('1 signed-off day is not included');
  });

  it('lists each location with its own currency, day counts and today’s threshold', () => {
    render(<CashUpReport body={body()} locations={locations} loadMore={jest.fn()} />);
    const table = section('By location');
    expect(within(table).getByRole('rowheader', { name: 'London' }).parentElement!.textContent).toBe('London210£5.001£5.00');
    expect(within(table).getByRole('rowheader', { name: 'New York' }).parentElement!.textContent).toBe(
      'New York102Not comparable (London trading day)No threshold setNo threshold set',
    );
  });
});

describe('CashUpReport detail', () => {
  it('shows each location-day with its status, local sign-off time and name, and a day without a cash-up as words', () => {
    render(<CashUpReport body={body({ detail: page([noCashUpToday, signedRow('2026-09-12', -200)], null) })} locations={locations} loadMore={jest.fn()} />);
    const detail = section('Detail');
    const signed = within(detail).getByText('Float miscounted').closest('tr')!;
    expect(signed.textContent).toContain('12 Sept 2026');
    expect(signed.textContent).toContain('Signed off');
    expect(signed.textContent).toContain('-£2.00');
    expect(signed.textContent).toContain('12 Sept 2026 20:30 · Ava Stone');
    expect(signed.textContent).toContain('Within');
    const today = within(detail).getByText('Not cashed up yet').closest('tr')!;
    // Takings in the row's own currency; no recorded figures invented.
    expect(today.textContent).toContain('US$7.00');
    expect(today.textContent).not.toMatch(/£/);
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('loads the next page with the cursor and appends it', async () => {
    const loadMore = jest.fn().mockResolvedValue(page([signedRow('2026-09-11', 0)], null));
    render(<CashUpReport body={body({ detail: page([signedRow('2026-09-12', -200)], 'c1.cursor') })} locations={locations} loadMore={loadMore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('11 Sept 2026');
    expect(loadMore).toHaveBeenCalledWith('c1.cursor');
    expect(screen.getByText('Showing 2 days')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('a stale Load more keeps Loading while the report reloads, then focuses the new list', async () => {
    const loadMore = jest.fn().mockResolvedValue('reloading');
    const { rerender } = render(<CashUpReport body={body({ detail: page([signedRow('2026-09-12', -200)], 'c1.old') })} locations={locations} loadMore={loadMore} />);
    const action = screen.getByRole('button', { name: 'Load more' });
    action.focus();
    fireEvent.click(action);
    await act(async () => undefined);
    expect(screen.getByRole('button', { name: 'Loading…' })).toBe(action);
    expect(screen.queryByRole('alert')).toBeNull();
    rerender(<CashUpReport body={body({ detail: page([signedRow('2026-09-13', 0)], null) })} locations={locations} loadMore={loadMore} />);
    await screen.findByText('13 Sept 2026');
    await waitFor(() => expect(document.activeElement).toBe(section('Detail')));
  });

  it('dates that have not started say so', () => {
    render(<CashUpReport body={body({ detail: { notStarted: true, rows: [], nextCursor: null } })} locations={locations} loadMore={jest.fn()} />);
    expect(within(section('Detail')).getByText('These dates have not started yet.')).toBeTruthy();
  });
});
