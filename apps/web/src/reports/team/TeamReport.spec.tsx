/**
 * The R2 Team body renders the API's figures as they are: money through the Money
 * formatter, percentages placed from basis points, counts and minutes as given.
 * A figure that can't be stated is words, never 0 or 0%. Rebooking At Source and
 * Future Booking are always named in full, and Future Booking always says "As at".
 */
import { render, screen, within } from '@testing-library/react';
import type {
  ResolvedReportLocation,
  TeamAmount,
  TeamMetrics,
  TeamReportBody,
  TeamStaffRow,
  TeamTotals,
} from '@sheer/domain';
import { TeamReport } from './TeamReport';
import { basisPointsText } from './teamLabels';

const L1 = '11111111-1111-4111-8111-111111111111';
const L2 = '22222222-2222-4222-8222-222222222222';
const ALICE = '33333333-3333-4333-8333-333333333333';
const CARA = '44444444-4444-4444-8444-444444444444';

const locations: ResolvedReportLocation[] = [
  { id: L1, name: 'London', timezone: 'Europe/London', isActive: true, timezoneValid: true, localToday: '2026-09-16', from: '2026-09-14', to: '2026-09-14', status: 'complete' },
  { id: L2, name: 'Tokyo', timezone: 'Asia/Tokyo', isActive: true, timezoneValid: true, localToday: '2026-09-16', from: '2026-09-14', to: '2026-09-14', status: 'complete' },
];

const gbp = (cents: number): TeamAmount => ({ availability: 'available', cents });
const count = (n: number) => ({ availability: 'available', count: n }) as const;

function metrics(overrides: Partial<TeamMetrics> = {}): TeamMetrics {
  return {
    serviceRevenue: { gross: gbp(1300000), netOfVat: gbp(1083400) },
    colour: { gross: gbp(100000), netOfVat: gbp(83300) },
    averageBill: { total: gbp(1400000), bills: count(2), average: gbp(700000) },
    utilisation: { availableMinutes: count(420), bookedMinutes: count(120), utilisation: { availability: 'available', numerator: 120, denominator: 420, basisPoints: 2857 } },
    futureBooking: {
      clientsSeen: count(10),
      withFutureBooking: { availability: 'available', numerator: 5, denominator: 10, basisPoints: 5000 },
      withConfirmedFutureBooking: { availability: 'available', numerator: 2, denominator: 10, basisPoints: 2000 },
    },
    retailRevenue: gbp(120000),
    ...overrides,
  };
}

function totals(overrides: Partial<TeamTotals> = {}): TeamTotals {
  return {
    ...metrics(),
    retailShareOfServiceRevenue: { availability: 'available', numerator: 250000, denominator: 2450000, basisPoints: 1020 },
    otherBillLines: gbp(-500),
    notItemised: gbp(200000),
    ...overrides,
  };
}

const row = (key: string, staff: TeamStaffRow['staff'], m: TeamMetrics = metrics(), locationId = L1): TeamStaffRow => ({ rowKey: `${locationId}:${key}`, locationId, staff, currencyCode: 'GBP', metrics: m });

function body(overrides: Partial<TeamReportBody> = {}): TeamReportBody {
  return {
    generatedAt: '2026-09-16T10:00:00.000Z',
    currencyCode: 'GBP',
    summary: totals(),
    selectedStaff: null,
    locations: [
      { locationId: L1, currencyCode: 'GBP', totals: totals(), selectedStaff: null, futureBookingAsAt: { localDate: '2026-09-16', localTime: '11:00' } },
      { locationId: L2, currencyCode: 'GBP', totals: totals(), selectedStaff: null, futureBookingAsAt: { localDate: '2026-09-16', localTime: '19:00' } },
    ],
    staffRows: [
      row(ALICE, { kind: 'staff', staffProfileId: ALICE, name: 'Alice', currentEmploymentStatus: 'active', currentlyActiveHere: true }),
      row(
        'eve',
        { kind: 'staff', staffProfileId: 'eve', name: 'Eve', currentEmploymentStatus: 'terminated', currentlyActiveHere: false },
        metrics({
          averageBill: { total: gbp(0), bills: count(0), average: { availability: 'unavailable', reason: 'no_bills' } },
          utilisation: { availableMinutes: count(0), bookedMinutes: count(0), utilisation: { availability: 'unavailable', reason: 'no_rostered_time' } },
          futureBooking: {
            clientsSeen: count(0),
            withFutureBooking: { availability: 'unavailable', reason: 'no_clients_seen' },
            withConfirmedFutureBooking: { availability: 'unavailable', reason: 'no_clients_seen' },
          },
        }),
      ),
      row(CARA, { kind: 'former', staffProfileId: CARA }),
      row(
        'unattributed',
        { kind: 'unattributed' },
        metrics({
          utilisation: {
            availableMinutes: { availability: 'unavailable', reason: 'leave_location_ambiguous' },
            bookedMinutes: { availability: 'unavailable', reason: 'leave_location_ambiguous' },
            utilisation: { availability: 'unavailable', reason: 'leave_location_ambiguous' },
          },
        }),
      ),
    ],
    staffOptions: [],
    finalisedCommission: {
      periods: [
        {
          payPeriodId: 'p1',
          label: 'Week 38',
          periodStart: '2026-09-08',
          periodEnd: '2026-09-14',
          scope: { kind: 'business' },
          status: 'locked',
          lines: [
            { staff: { kind: 'staff', staffProfileId: ALICE, name: 'Alice' }, currencyCode: 'GBP', commission: gbp(5000), adjustments: gbp(-300), greaterOf: 'base_pay_won' },
          ],
          total: gbp(5700),
          currencyCode: 'GBP',
        },
      ],
      restrictions: [],
    },
    unavailableMetrics: [
      { metric: 'rebooking_at_source', reason: 'capture_not_implemented' },
      { metric: 'service_revenue_target', reason: 'target_model_not_available' },
      { metric: 'retail_attach', reason: 'retail_visit_linkage_not_captured' },
      { metric: 'live_commission', reason: 'payroll_rules_not_implemented' },
    ],
    dataQuality: { rolledUpServiceLines: 1, bookedWithoutRota: 0, bookedAtAnotherLocation: 2, leaveAtAnotherLocation: 1 },
    ...overrides,
  };
}

const section = (name: string) => screen.getByRole('region', { name });
const valueOf = (container: HTMLElement, label: string) => within(container).getByText(label).nextElementSibling!.textContent;
const rowText = (name: string) => within(section('Staff performance')).getByRole('rowheader', { name: new RegExp(`^${name}`) }).parentElement!.textContent;

describe('basis points are placed, not divided', () => {
  it.each([
    [1020, '10.2%'],
    [2857, '28.57%'],
    [5000, '50%'],
    [5, '0.05%'],
    [0, '0%'],
    [20000, '200%'],
    [12345, '123.45%'],
  ])('%i → %s', (bp, text) => expect(basisPointsText(bp)).toBe(text));
});

describe('TeamReport', () => {
  it('overview: money, average bill, utilisation, Future Booking and retail share as the API sent them', () => {
    render(<TeamReport body={body()} locations={locations} />);
    const overview = section('Team overview');
    expect(valueOf(overview, 'Service revenue (incl. VAT)')).toBe('£13,000.00');
    expect(valueOf(overview, 'Service revenue, net of VAT')).toBe('£10,834.00');
    expect(valueOf(overview, 'Average bill')).toBe('£7,000.002 bills');
    expect(valueOf(overview, 'Utilisation')).toBe('28.57%120 min booked of 420 min');
    expect(valueOf(overview, 'Future Booking')).toBe('50%5 of 10 clients');
    expect(valueOf(overview, 'Future Booking, confirmed only')).toBe('20%');
    expect(valueOf(overview, 'Retail as a share of service revenue')).toBe('10.2%');
    expect(screen.queryByRole('region', { name: 'Selected staff' })).toBeNull();
  });

  it('staff rows: names, today’s status labelled as current, former staff and Unattributed', () => {
    render(<TeamReport body={body()} locations={locations} />);
    expect(rowText('Alice')).toContain('Current: Active, at this location');
    expect(rowText('Eve')).toContain('Current: Left, not at this location');
    expect(rowText('Former staff \\(profile removed\\)')).toContain('£13,000.00');
    expect(rowText('Unattributed')).toContain('Not stated (leave at another location)');
    expect(within(section('Staff performance')).getAllByRole('rowheader', { name: 'Location total' })).toHaveLength(2);
  });

  it('never shows a fake zero: no bills, no rostered time and no clients seen read as words', () => {
    render(<TeamReport body={body()} locations={locations} />);
    const eve = rowText('Eve')!;
    expect(eve).toContain('No bills');
    expect(eve).toContain('No rostered time');
    expect(eve).toContain('No clients seen');
    expect(eve).not.toMatch(/(^|[^\d.,£])0%/);
  });

  it('with a staff filter: a Selected staff section and subtotal rows beside the full location totals', () => {
    const selected = metrics({ serviceRevenue: { gross: gbp(300000), netOfVat: gbp(250000) } });
    const filtered = body({
      selectedStaff: selected,
      locations: body().locations.map((location) => ({ ...location, selectedStaff: selected })),
    });
    render(<TeamReport body={filtered} locations={locations} />);
    expect(valueOf(section('Selected staff'), 'Service revenue (incl. VAT)')).toBe('£3,000.00');
    const table = section('Staff performance');
    expect(within(table).getAllByRole('rowheader', { name: 'Selected staff' })).toHaveLength(2);
    expect(within(table).getAllByRole('rowheader', { name: 'Location total' })).toHaveLength(2);
  });

  it('Future Booking says As at, per location when the local times differ, and is never called Rebooking', () => {
    render(<TeamReport body={body()} locations={locations} />);
    expect(section('Future Booking').textContent).toContain('As at 16 Sept 2026, 11:00 (London); 16 Sept 2026, 19:00 (Tokyo)');
    expect(section('Future Booking').textContent).toContain('It is not Rebooking At Source.');
    expect(document.body.textContent).not.toMatch(/Rebooking(?! At Source)/);
  });

  it('names the metrics that are not available yet, with plain reasons and no number', () => {
    render(<TeamReport body={body()} locations={locations} />);
    const unavailable = section('Not available yet');
    for (const label of ['Rebooking At Source', 'Revenue vs target', 'Retail attach', 'Live commission']) {
      expect(within(unavailable).getByText(label)).toBeTruthy();
    }
    expect(unavailable.textContent).toContain('A later online booking is never counted as rebooked at source.');
    expect(unavailable.textContent).not.toMatch(/\d/);
  });

  it('finalised commission: per pay period, adjustments apart, greater-of outcome, restrictions and an empty state', () => {
    const { unmount } = render(<TeamReport body={body()} locations={locations} />);
    const commission = section('Finalised commission');
    expect(commission.textContent).toContain('Week 38 · 8 Sept 2026 – 14 Sept 2026 · Whole business · Locked');
    const alice = within(commission).getByRole('rowheader', { name: 'Alice' }).parentElement!.textContent;
    expect(alice).toBe('Alice£50.00-£3.00Base pay was higher');
    expect(within(commission).getByRole('rowheader', { name: 'Pay period commission (all staff)' }).parentElement!.textContent).toContain('£57.00');
    unmount();
    render(
      <TeamReport
        body={body({ finalisedCommission: { periods: [], restrictions: ['business_wide_owner_only', 'location_commission_permission_required'] } })}
        locations={locations}
      />,
    );
    const empty = section('Finalised commission');
    expect(empty.textContent).toContain('No locked or paid pay periods overlap these dates.');
    expect(empty.textContent).toContain('Business-wide pay periods are shown to owners only.');
  });

  it('data quality notes say what was left out, in the singular and plural', () => {
    render(<TeamReport body={body()} locations={locations} />);
    const notes = section('Data quality').textContent;
    expect(notes).toContain('1 service line was not itemised per service');
    expect(notes).toContain('2 booked appointment days are at a different location');
    expect(notes).toContain('1 rostered day is covered by leave recorded at another location');
    expect(notes).not.toContain('no rota shift');
  });
});
