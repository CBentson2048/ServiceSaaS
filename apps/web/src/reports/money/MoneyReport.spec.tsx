/**
 * The R1 Money body renders the API's figures as they are. An unavailable
 * figure reads as words, never £0.00; nothing is recomputed in the browser.
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MoneyAmount, MoneyDetailPage, MoneyReportBody, MoneyTotals, ResolvedReportLocation } from '@sheer/domain';
import { MoneyReport } from './MoneyReport';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const a = (cents: number): MoneyAmount => ({ availability: 'available', cents });

const locations: ResolvedReportLocation[] = [
  { id: L1, name: 'London', timezone: 'Europe/London', isActive: true, timezoneValid: true, localToday: '2026-09-14', from: '2026-09-14', to: '2026-09-14', status: 'in_progress' },
  { id: L2, name: 'Tokyo', timezone: 'Asia/Tokyo', isActive: true, timezoneValid: true, localToday: '2026-09-15', from: '2026-09-15', to: '2026-09-15', status: 'in_progress' },
];

function totals(gross: number): MoneyTotals {
  return {
    paidBills: { gross: a(gross), netOfVat: a(gross - 1000), vat: a(1000) },
    composition: [
      { key: 'service', gross: a(gross - 2500) },
      { key: 'product_usage', gross: a(3000) },
      { key: 'adjustment', gross: a(-500) },
      { key: 'not_itemised', gross: a(0) },
    ],
    colour: { gross: a(3000), netOfVat: a(2500), vat: a(500) },
    settlement: [
      { key: 'cash', amount: a(1650) },
      { key: 'card_reader', amount: a(gross - 1650 - 300) },
      { key: 'deposits_applied', amount: a(300) },
      { key: 'not_itemised', amount: a(0) },
    ],
    retail: {
      recorded: a(800),
      vat: { availability: 'unavailable', reason: 'not_captured' },
      byMethod: [
        { key: 'cash', amount: a(120) },
        { key: 'card_reader', amount: a(250) },
        { key: 'other', amount: a(330) },
        { key: 'not_recorded', amount: a(100) },
      ],
    },
    deposits: { collected: a(450), redeemed: a(300), refunded: { availability: 'unavailable', reason: 'partial_refund_amount_not_recorded' } },
    netPosition: { availability: 'unavailable', reason: 'definition_pending' },
  };
}

const body = (overrides: Partial<MoneyReportBody> = {}): MoneyReportBody => ({
  currencyCode: 'GBP',
  summary: totals(59500),
  locations: [
    { locationId: L1, totals: totals(35500) },
    { locationId: L2, totals: totals(24000) },
  ],
  notRecorded: ['discounts', 'till_refunds', 'voids', 'tips', 'retail_vat', 'forfeited_deposits', 'outside_deposit_refunds'],
  coverage: { tillPaymentsWithoutBill: { count: 2, amount: a(12199) } },
  detail: null,
  ...overrides,
});

const detailPage = (rows: MoneyDetailPage['rows'], nextCursor: string | null): MoneyDetailPage => ({ rows, nextCursor });
const billRow = (n: number): MoneyDetailPage['rows'][number] => ({
  kind: 'paid_bill',
  rowKey: `paid_bill:${n}`,
  locationId: L2,
  localDate: '2026-09-15',
  localTime: '01:05',
  currencyCode: 'GBP',
  amount: a(12000 + n),
  billNumber: n,
  netOfVat: a(10000),
  vat: a(2000),
  colour: a(3000),
  cash: a(4000),
  cardReader: a(6000),
  depositApplied: a(2000),
});

const section = (name: string) => screen.getByRole('region', { name });

describe('MoneyReport summary', () => {
  it('shows the server’s figures, formatted, including a negative adjustment', () => {
    render(<MoneyReport body={body()} locations={locations} loadMore={jest.fn()} />);
    const revenue = section('Paid bill revenue');
    expect(within(revenue).getByText('£595.00')).toBeTruthy();
    expect(within(revenue).getByText('£585.00')).toBeTruthy();
    expect(within(revenue).getByText('£10.00')).toBeTruthy();
    const composition = section('What paid bills were made of');
    expect(within(composition).getByText('Colour (product use)').nextSibling?.textContent).toBe('£30.00');
    expect(within(composition).getByText('Till reconciliation adjustments').nextSibling?.textContent).toBe('-£5.00');
    expect(within(section('Retail')).getByText('Method not recorded').nextSibling?.textContent).toBe('£1.00');
  });

  it('never writes a zero for what QLOOQO does not record', () => {
    render(<MoneyReport body={body()} locations={locations} loadMore={jest.fn()} />);
    expect(within(section('Retail')).getByText('VAT on retail').nextSibling?.textContent).toBe('Not recorded');
    expect(within(section('Deposits')).getByText('Refunded in QLOOQO').nextSibling?.textContent).toBe('Not recorded (partial refund amount)');
    const notRecorded = section('Not recorded by QLOOQO');
    expect(within(notRecorded).getByText('Net position').nextSibling?.textContent).toBe('Definition pending');
    for (const label of ['Discounts', 'Till refunds', 'Voids', 'Tips', 'VAT on retail sales', 'Forfeited deposits', 'Deposit refunds made outside QLOOQO']) {
      expect(within(notRecorded).getByText(label).nextSibling?.textContent).toBe('Not recorded');
    }
    expect(notRecorded.textContent).not.toMatch(/£/);
  });

  it('a report that has not started shows Not started, and no money at all', () => {
    const notStarted = JSON.parse(JSON.stringify(body()), (key, value) =>
      value && typeof value === 'object' && value.availability === 'available' ? { availability: 'not_started' } : value,
    ) as MoneyReportBody;
    render(<MoneyReport body={{ ...notStarted, coverage: { tillPaymentsWithoutBill: { count: 0, amount: { availability: 'not_started' } } } }} locations={locations} loadMore={jest.fn()} />);
    expect(within(section('Paid bill revenue')).getAllByText('Not started')).toHaveLength(3);
    expect(document.body.textContent).not.toMatch(/£/);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('warns about till payments that have no paid bill yet', () => {
    render(<MoneyReport body={body()} locations={locations} loadMore={jest.fn()} />);
    expect(screen.getByRole('status').textContent).toMatch(/2 till payments \(£121\.99\) have no paid bill yet/);
  });

  it('lists each location with its own figures', () => {
    render(<MoneyReport body={body()} locations={locations} loadMore={jest.fn()} />);
    const table = section('By location');
    expect(within(table).getByRole('rowheader', { name: 'London' }).parentElement?.textContent).toContain('£355.00');
    expect(within(table).getByRole('rowheader', { name: 'Tokyo' }).parentElement?.textContent).toContain('£240.00');
  });

  it('a single location has no location table', () => {
    render(<MoneyReport body={body({ locations: [{ locationId: L1, totals: totals(35500) }] })} locations={locations} loadMore={jest.fn()} />);
    expect(screen.queryByRole('region', { name: 'By location' })).toBeNull();
  });
});

describe('MoneyReport detail', () => {
  it('renders rows in the location’s local date and time, never raw UTC', () => {
    render(<MoneyReport body={body({ detail: detailPage([billRow(42)], null) })} locations={locations} loadMore={jest.fn()} />);
    const detail = section('Detail');
    const row = within(detail).getByText('Bill 42').closest('tr')!;
    expect(row.textContent).toContain('15 Sept 2026');
    expect(row.textContent).toContain('01:05');
    expect(row.textContent).toContain('Tokyo');
    expect(row.textContent).toContain('£120.42');
    expect(row.textContent).toContain('Deposit applied £20.00');
    expect(document.body.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|Z\b/);
    expect(within(detail).queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('loads the next page with the cursor and appends it; an error offers Retry', async () => {
    const loadMore = jest
      .fn()
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce(detailPage([billRow(2)], null));
    render(<MoneyReport body={body({ detail: detailPage([billRow(1)], 'm1.cursor') })} locations={locations} loadMore={loadMore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('We couldn’t load more rows.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByText('Bill 2');
    expect(loadMore.mock.calls).toEqual([['m1.cursor'], ['m1.cursor']]);
    expect(screen.getByText('Bill 1')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('a new first page replaces the appended rows', async () => {
    const loadMore = jest.fn().mockResolvedValue(detailPage([billRow(2)], null));
    const { rerender } = render(<MoneyReport body={body({ detail: detailPage([billRow(1)], 'm1.cursor') })} locations={locations} loadMore={loadMore} />);
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    await screen.findByText('Bill 2');
    rerender(<MoneyReport body={body({ detail: detailPage([billRow(7)], null) })} locations={locations} loadMore={loadMore} />);
    await waitFor(() => expect(screen.queryByText('Bill 2')).toBeNull());
    expect(screen.getByText('Bill 7')).toBeTruthy();
    await act(async () => undefined);
  });
});
