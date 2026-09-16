/**
 * R7 Cash Up days follow each location's own calendar: days are enumerated between
 * the local dates Ticket A resolved, takings are read inside each location's own
 * window (never wider) and placed on the location's local day, DST days included.
 */
import type { ReportFilter } from '@sheer/domain';
import { MemoryMoneySource, type Ledger } from '../money/testing/memory-money-source';
import { instant, moneyScope } from '../money/testing/money-scope';
import { locationDays } from './cash-up-days';
import { CashUpReportService } from './cash-up-report.service';
import { MemoryCashUpSource } from './testing/memory-cash-up-source';

const BIZ = 'biz-1';
const LONDON = { id: '44000000-0000-4000-8000-000000000001', name: 'London', timezone: 'Europe/London' };
const TOKYO = { id: '44000000-0000-4000-8000-000000000002', name: 'Tokyo', timezone: 'Asia/Tokyo' };
const filter = (overrides: Partial<ReportFilter> = {}): ReportFilter => ({ preset: 'today', locationIds: [], staffProfileIds: [], view: 'detail', ...overrides });

let serial = 0;
const uid = () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}`;

function ledgerWithCash(payments: Array<{ location: { id: string }; at: string; cents: number }>): Ledger {
  return {
    bills: [],
    lines: [],
    payments: payments.map((p) => ({ id: uid(), businessId: BIZ, visitId: uid(), locationId: p.location.id, at: instant(p.at), method: 'cash' as const, amountCents: p.cents, currencyCode: 'GBP' })),
    retail: [],
    deposits: [],
    locations: [LONDON, TOKYO].map((l) => ({ id: l.id, businessId: BIZ, currencyCode: 'GBP' })),
  };
}

async function run(ledger: Ledger, locations: Array<typeof LONDON>, f: ReportFilter, asOf: Date) {
  const money = new MemoryMoneySource(ledger);
  const scope = moneyScope(BIZ, locations, f, asOf);
  const body = await new CashUpReportService(money, new MemoryCashUpSource({ records: [], users: {}, thresholds: [] })).build(scope, { cursor: null });
  if (body.continuation) throw new Error('expected a first page');
  const cash = Object.fromEntries(body.detail!.rows.map((r) => [r.rowKey, (r.sources.expectedCash as { cents: number }).cents]));
  return { body, money, scope, cash };
}

beforeEach(() => {
  serial = 0;
});

describe('cash-up days follow each location’s own calendar', () => {
  it('enumerates only started local days, newest first, and counts the rest as not started', () => {
    expect(locationDays({ localToday: '2026-09-14', from: '2026-09-12', to: '2026-09-16' })).toEqual({
      started: ['2026-09-14', '2026-09-13', '2026-09-12'],
      notStarted: 2,
    });
    expect(locationDays({ localToday: '2026-09-14', from: '2026-02-27', to: '2026-03-01' }).started).toEqual([
      '2026-03-01',
      '2026-02-28',
      '2026-02-27',
    ]);
  });

  it('a range that ends on 9999-12-31 (the last date the filter accepts) terminates, with nothing started', async () => {
    expect(locationDays({ localToday: '2026-09-14', from: '9999-12-30', to: '9999-12-31' })).toEqual({ started: [], notStarted: 2 });
    const { body } = await run(ledgerWithCash([]), [LONDON], filter({ preset: 'custom', from: '9999-12-31', to: '9999-12-31' }), new Date('2026-09-14T16:30:00Z'));
    expect(body.summary.days).toEqual({ started: 0, signedOff: 0, open: 0, none: 0, inProgress: 0, notStarted: 1 });
    expect(body.detail).toEqual({ notStarted: true, rows: [], nextCursor: null });
  });

  it('at one instant, London and Tokyo are on different days, and each payment lands on its location’s own day', async () => {
    const ledger = ledgerWithCash([
      { location: LONDON, at: '2026-09-14T16:00:00Z', cents: 100 }, // London 14 Sep 17:00
      { location: TOKYO, at: '2026-09-14T16:00:00Z', cents: 200 }, // Tokyo 15 Sep 01:00
      { location: TOKYO, at: '2026-09-14T14:00:00Z', cents: 400 }, // Tokyo 14 Sep 23:00 — not Tokyo's today
    ]);
    const { cash, money, scope } = await run(ledger, [LONDON, TOKYO], filter(), new Date('2026-09-14T16:30:00Z'));
    expect(cash).toEqual({ [`${LONDON.id}:2026-09-14`]: 100, [`${TOKYO.id}:2026-09-15`]: 200 });
    // Every windowed takings read uses exactly the scope's windows, never an envelope.
    const expected = scope.windows.map((w) => ({ locationId: w.locationId, fromUtc: w.fromUtc, toUtcExclusive: w.toUtcExclusive }));
    for (const read of money.reads.filter((r) => r.windows)) expect(read.windows).toEqual(expected);
  });

  it('London autumn DST day: all 25 hours are that day, and nothing either side', async () => {
    const ledger = ledgerWithCash([
      { location: LONDON, at: '2026-10-24T22:59:59.999999Z', cents: 1 }, // 24 Oct 23:59:59 BST
      { location: LONDON, at: '2026-10-24T23:30:00Z', cents: 10 }, // 25 Oct 00:30 BST
      { location: LONDON, at: '2026-10-25T23:30:00Z', cents: 100 }, // 25 Oct 23:30 GMT
      { location: LONDON, at: '2026-10-26T00:00:00Z', cents: 1000 }, // 26 Oct 00:00 GMT
    ]);
    const { cash } = await run(ledger, [LONDON], filter({ preset: 'custom', from: '2026-10-24', to: '2026-10-26' }), new Date('2026-10-27T12:00:00Z'));
    expect(cash).toEqual({ [`${LONDON.id}:2026-10-26`]: 1000, [`${LONDON.id}:2026-10-25`]: 110, [`${LONDON.id}:2026-10-24`]: 1 });
  });

  it('a location whose days have not started is not read for takings; the others still report', async () => {
    const ledger = ledgerWithCash([{ location: TOKYO, at: '2026-09-15T01:00:00Z', cents: 700 }]);
    const { body, money } = await run(ledger, [LONDON, TOKYO], filter({ preset: 'custom', from: '2026-09-15', to: '2026-09-15' }), new Date('2026-09-14T16:30:00Z'));
    expect(body.detail!.rows.map((r) => r.rowKey)).toEqual([`${TOKYO.id}:2026-09-15`]);
    expect(body.locations.find((l) => l.locationId === LONDON.id)!.totals.days).toEqual({ started: 0, signedOff: 0, open: 0, none: 0, inProgress: 0, notStarted: 1 });
    for (const read of money.reads.filter((r) => r.windows)) expect(read.windows!.map((w) => w.locationId)).toEqual([TOKYO.id]);
  });
});
