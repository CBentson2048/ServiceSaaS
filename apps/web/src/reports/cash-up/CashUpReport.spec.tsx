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
    days: { started: 3, signedOff: 2, open: 0, none: 0, inProgress: 1, notStarted: 1 },
    recorded: {
      cash: { expected: a(5000), counted: a(5500), variance: a(500) },
      card: { expected: a(26500), counted: a(26500), variance: a(0) },
      variance: a(500),
      pettyCashOut: a(500),
      refundsEntered: a(1200),
      voidsEntered: a(0),
      daysOutsideThreshold: { availability: 'available', count: 1 },
      daysUnavailable: 0,
      unavailableReasons: [],
    },
    sourceCheck: { daysChanged: { availability: 'available', count: 1 }, cashChange: a(500), cardChange: a(0) },
    withoutSignOff: { expectedCash: a(900), expectedCard: a(3000) },
    retailOutsideTill: { other: a(300), notRecorded: a(200) },
    ...overrides,
  };
}

const nyTotals = totals({
  days: { started: 3, signedOff: 1, open: 0, none: 1, inProgress: 1, notStarted: 1 },
  recorded: {
    cash: { expected: u('london_trading_day'), counted: u('london_trading_day'), variance: u('london_trading_day') },
    card: { expected: u('london_trading_day'), counted: u('london_trading_day'), variance: u('london_trading_day') },
    variance: u('london_trading_day'),
    pettyCashOut: u('london_trading_day'),
    refundsEntered: u('london_trading_day'),
    voidsEntered: u('london_trading_day'),
    daysOutsideThreshold: { availability: 'unavailable', reason: 'london_trading_day' },
    daysUnavailable: 1,
    unavailableReasons: ['london_trading_day', 'currency_mismatch'],
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
    thresholdCheck: 'within',
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
    { locationId: LONDON, currencyCode: 'GBP', threshold: a(500), thresholdCurrencyCode: 'GBP', totals: totals() },
    { locationId: NEW_YORK, currencyCode: null, threshold: a(1000), thresholdCurrencyCode: 'USD', totals: nyTotals },
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
    expect(valueOf(recorded, 'Days outside current threshold')).toBe('1');
    expect(valueOf(section('Days'), 'No cash-up recorded')).toBe('0');
    expect(valueOf(section('Changed since sign-off'), 'Cash')).toBe('£5.00');
    expect(valueOf(section('Takings without a signed-off cash-up'), 'Expected card')).toBe('£30.00');
    expect(valueOf(section('Retail outside the till'), 'Payment method not recorded')).toBe('£2.00');
  });

  it('a stored zero for a manual entry reads “£0.00 recorded”, and never claims whether anyone entered it', () => {
    render(<CashUpReport body={body()} locations={locations} loadMore={jest.fn()} />);
    const recorded = section('Signed-off days, as recorded');
    expect(valueOf(recorded, 'Voids (manual entry)')).toBe('£0.00 recorded');
    expect(valueOf(recorded, 'Refunds (manual entry)')).toBe('£12.00');
    expect(recorded.textContent).toContain(
      'Refunds, voids and the opening float are typed in on End of Day, and zero is stored when nothing is typed. A zero marked “recorded” can’t show whether anyone entered it.',
    );
    expect(document.body.textContent).not.toMatch(/None entered|entered at cash-up/);
  });

  it('the threshold is always called the current threshold, never the one in force at sign-off', () => {
    render(<CashUpReport body={body({ detail: page([signedRow('2026-09-12', -200)], null) })} locations={locations} loadMore={jest.fn()} />);
    const recorded = section('Signed-off days, as recorded');
    expect(valueOf(recorded, 'Days outside current threshold')).toBe('1');
    expect(recorded.textContent).toContain('The threshold in force at sign-off was not stored, so it may have been different.');
    expect(within(section('By location')).getByRole('columnheader', { name: 'Current threshold' })).toBeTruthy();
    expect(within(section('Detail')).getByRole('columnheader', { name: 'Against current threshold' })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/threshold today|today’s threshold|Threshold \(today’s\)/i);
  });

  it('figures that can’t be compared, and an unset threshold, are words — never £0.00', () => {
    render(<CashUpReport body={body({ summary: nyTotals })} locations={locations} loadMore={jest.fn()} />);
    const recorded = section('Signed-off days, as recorded');
    expect(within(recorded).getByRole('rowheader', { name: 'Card' }).parentElement!.textContent).not.toMatch(/£/);
    expect(valueOf(recorded, 'Variance, both tenders')).toBe('Not comparable (London trading day)');
    expect(valueOf(recorded, 'Days outside current threshold')).toBe('Not comparable (London trading day)');
    expect(valueOf(recorded, 'Petty cash out')).toBe('Not comparable (London trading day)');
    // The note gives the real reasons, not always the London day.
    expect(recorded.textContent).toContain(
      '1 signed-off day is not included in these figures: End of Day used a London trading day for the location; the cash-up is stored in another currency than the location’s.',
    );
  });

  it('lists each location with its own figures; the threshold is in the location’s configured currency even when its figures are not', () => {
    render(<CashUpReport body={body()} locations={locations} loadMore={jest.fn()} />);
    const table = section('By location');
    expect(within(table).getByRole('rowheader', { name: 'London' }).parentElement!.textContent).toBe('London200£5.001£5.00');
    expect(within(table).getByRole('rowheader', { name: 'New York' }).parentElement!.textContent).toBe(
      'New York101Not comparable (London trading day)Not comparable (London trading day)US$10.00',
    );
  });

  it('counts today as in progress, not as a missed day', () => {
    render(<CashUpReport body={body()} locations={locations} loadMore={jest.fn()} />);
    expect(valueOf(section('Days'), 'Today, not signed off yet')).toBe('1');
    expect(valueOf(section('Days'), 'No cash-up recorded')).toBe('0');
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
    expect(signed.textContent).toContain('£100.00'); // opening float
    expect(signed.textContent).toContain('£0.00 recorded'); // refunds and voids: a stored zero
    const today = within(detail).getByText('Not cashed up yet').closest('tr')!;
    // Takings in the row's own currency; no recorded figures invented.
    expect(today.textContent).toContain('US$7.00');
    expect(today.textContent).not.toMatch(/£/);
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('a draft day never shows a variance or Within: its threshold reads Not signed off', () => {
    const draft: CashUpDayRow = {
      ...signedRow('2026-09-13', 0),
      status: 'open',
      record: {
        ...signedRow('2026-09-13', 0).record!,
        cash: { expected: a(4000), counted: a(4100), variance: u('not_signed_off') },
        variance: u('not_signed_off'),
        thresholdCheck: 'not_signed_off',
        signedOffBy: null,
        signedOff: null,
        notes: 'Draft count',
      },
      changeSinceSignOff: null,
    };
    render(<CashUpReport body={body({ detail: page([draft], null) })} locations={locations} loadMore={jest.fn()} />);
    const row = within(section('Detail')).getByText('Draft count').closest('tr')!;
    expect(row.textContent).toContain('Not signed off');
    expect(row.textContent).not.toContain('Within');
    expect(row.textContent).not.toContain('£1.00');
  });

  it('loads the next page with the cursor and appends it', async () => {
    const loadMore = jest.fn().mockResolvedValue(page([signedRow('2026-09-11', 0)], null));
    render(<CashUpReport body={body({ detail: page([signedRow('2026-09-12', -200)], 'c1.cursor') })} locations={locations} loadMore={loadMore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('11 Sept 2026');
    expect(loadMore).toHaveBeenCalledWith('c1.cursor');
    expect(screen.getByText('Showing 2 rows')).toBeTruthy();
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
