/**
 * R7 Cash Up reconciliation: SOURCE LEDGER = REPORT, to the penny.
 *
 * asOf 2026-09-14T20:00:00Z; custom range 12–15 Sep. Each location reads its own window:
 *   London   (Europe/London,    today 14 Sep 21:00 BST)  started 12, 13, 14; 15 not started
 *   New York (America/New_York, today 14 Sep 16:00 EDT)  started 12, 13, 14; 15 not started
 *   Empty    (Europe/London, no threshold setting)       started 12, 13, 14; 15 not started
 *
 * TAKINGS (pence)                                   cash     card   retail other / not recorded
 * London 12  till 4000 cash · 6000 + 18000 card · retail 2500 card   4000    26500
 * London 13  till 1000 cash (09:00Z) + 500 cash taken AFTER sign-off (20:00Z = 21:00 BST)
 *            · retail 300 other · 200 method not recorded           1500        0     300 / 200
 * London 14  900 cash at 13T23:30Z (00:30 BST on the 14th) · card 3000   900     3000
 * New York 13  5000 cash (15:00Z) · 700 card at 14T02:00Z (22:00 EDT on the 13th)  5000  700
 *
 * CASH-UPS (as recorded)                exp cash  counted  exp card  counted  variance  petty  refunds
 * London 12  signed off 19:30Z (Ava)      4000     3800     26500     26500     −200     500      0
 * London 13  signed off 18:00Z (Ben)      1000     1700         0         0     +700       0   1200
 * London 14  open (draft)                    0     2000         0      null     —         0      0
 * London 15  open, FUTURE date (ignored)     0    99999         0         0     —         0      0
 * New York 13 signed off 23:00Z (Ava)     5000     5100         0         0     +100     300      0
 *
 * EXPECTED
 * London   days 3 started: 2 signed, 1 open, 0 none, 1 not started. Recorded: cash 5000 / 5500 / +500,
 *          card 26500 / 26500 / 0, variance +500, petty 500, refunds 1200, voids 0, outside £5 threshold 1
 *          (the +£7 day). Source check: 1 day changed, cash +500, card 0. Without sign-off (14th):
 *          cash 900, card 3000. Retail outside the till: other 300, not recorded 200.
 * New York days 3: 1 signed, 0 open, 2 none. Its snapshot was on a London day: recorded figures
 *          unavailable (london_trading_day), 1 day unavailable; petty cash still 300.
 *          Without sign-off (12th, 14th): cash 0, card 0.
 * Empty    days 3: 3 none. Recorded: not signed off. Threshold: not set. Takings 0.
 * SUMMARY  days 9: 3 signed, 1 open, 5 none, 3 not started. Recorded cash 5000 / 5500 / +500,
 *          card 26500 / 26500 / 0, variance +500, petty 800, refunds 1200, outside threshold 1,
 *          1 day unavailable. Changed 1 (cash +500). Without sign-off cash 900, card 3000.
 */
import type { CashUpAmount, CashUpFirstPageBody, CashUpReportBody, ReportFilter } from '@sheer/domain';
import type { ReportScope } from '../report-scope.service';
import { MemoryMoneySource, type Ledger } from '../money/testing/memory-money-source';
import { instant as at, moneyScope } from '../money/testing/money-scope';
import { CashUpReportService } from './cash-up-report.service';
import type { CashUpRecordRow } from './cash-up-source';
import { MemoryCashUpSource, type CashUpLedger, type LedgerCashUp } from './testing/memory-cash-up-source';

const BIZ = 'biz-1';
const OTHER_BIZ = 'biz-2';
const LONDON = '41000000-0000-4000-8000-000000000001';
const NEW_YORK = '41000000-0000-4000-8000-000000000002';
const EMPTY = '41000000-0000-4000-8000-000000000003';
const LOCATIONS = [
  { id: LONDON, name: 'London', timezone: 'Europe/London' },
  { id: NEW_YORK, name: 'New York', timezone: 'America/New_York' },
  { id: EMPTY, name: 'Empty', timezone: 'Europe/London' },
];
const AVA = '51000000-0000-4000-8000-000000000001';
const BEN = '51000000-0000-4000-8000-000000000002';
const AS_OF = new Date('2026-09-14T20:00:00Z');
const RANGE: ReportFilter = { preset: 'custom', from: '2026-09-12', to: '2026-09-15', locationIds: [], staffProfileIds: [], view: 'summary' };

let serial = 0;
const uid = () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}`;

function money(): Ledger {
  const ledger: Ledger = {
    bills: [],
    lines: [],
    payments: [],
    retail: [],
    deposits: [],
    locations: [LONDON, NEW_YORK, EMPTY].map((id) => ({ id, businessId: BIZ, currencyCode: 'GBP' })),
  };
  const pay = (locationId: string, iso: string, method: 'cash' | 'card_reader', amountCents: number, businessId = BIZ) =>
    ledger.payments.push({ id: uid(), businessId, visitId: uid(), locationId, at: at(iso), method, amountCents, currencyCode: 'GBP' });
  const sell = (locationId: string, iso: string, method: 'cash' | 'card_reader' | 'other' | 'not_recorded', totalCents: number, currencyCode = 'GBP') =>
    ledger.retail.push({ id: uid(), businessId: BIZ, locationId, at: at(iso), totalCents, quantity: 1, method, currencyCode });
  pay(LONDON, '2026-09-12T10:00:00Z', 'cash', 4000);
  pay(LONDON, '2026-09-12T10:05:00Z', 'card_reader', 6000);
  pay(LONDON, '2026-09-12T14:00:00Z', 'card_reader', 18000);
  sell(LONDON, '2026-09-12T11:00:00Z', 'card_reader', 2500);
  pay(LONDON, '2026-09-13T09:00:00Z', 'cash', 1000);
  pay(LONDON, '2026-09-13T20:00:00Z', 'cash', 500);
  sell(LONDON, '2026-09-13T12:00:00Z', 'other', 300);
  sell(LONDON, '2026-09-13T12:30:00Z', 'not_recorded', 200);
  pay(LONDON, '2026-09-13T23:30:00Z', 'cash', 900);
  pay(LONDON, '2026-09-14T12:00:00Z', 'card_reader', 3000);
  pay(LONDON, '2026-09-12T12:00:00Z', 'cash', 77777, OTHER_BIZ);
  pay(NEW_YORK, '2026-09-13T15:00:00Z', 'cash', 5000);
  pay(NEW_YORK, '2026-09-14T02:00:00Z', 'card_reader', 700);
  return ledger;
}

function record(fields: Partial<LedgerCashUp> & Pick<CashUpRecordRow, 'locationId' | 'businessDate' | 'status'>): LedgerCashUp {
  return {
    id: uid(),
    businessId: BIZ,
    openingFloatCents: 10000,
    expectedCashCents: 0,
    countedCashCents: null,
    expectedCardCents: 0,
    countedCardCents: null,
    pettyCashOutCents: 0,
    refundsCents: 0,
    voidsCents: 0,
    varianceCents: null,
    notes: null,
    signedOffByUserProfileId: null,
    signedOffAt: null,
    currencyCode: 'GBP',
    ...fields,
  };
}

function cashUps(): CashUpLedger {
  return {
    records: [
      record({ locationId: LONDON, businessDate: '2026-09-12', status: 'signed_off', expectedCashCents: 4000, countedCashCents: 3800, expectedCardCents: 26500, countedCardCents: 26500, pettyCashOutCents: 500, varianceCents: -200, notes: 'Float miscounted', signedOffByUserProfileId: AVA, signedOffAt: at('2026-09-12T19:30:00Z') }),
      record({ locationId: LONDON, businessDate: '2026-09-13', status: 'signed_off', expectedCashCents: 1000, countedCashCents: 1700, expectedCardCents: 0, countedCardCents: 0, refundsCents: 1200, varianceCents: 700, signedOffByUserProfileId: BEN, signedOffAt: at('2026-09-13T18:00:00Z') }),
      record({ locationId: LONDON, businessDate: '2026-09-14', status: 'open', countedCashCents: 2000 }),
      record({ locationId: LONDON, businessDate: '2026-09-15', status: 'open', countedCashCents: 99999, countedCardCents: 0 }),
      record({ locationId: NEW_YORK, businessDate: '2026-09-13', status: 'signed_off', openingFloatCents: 5000, expectedCashCents: 5000, countedCashCents: 5100, expectedCardCents: 0, countedCardCents: 0, pettyCashOutCents: 300, varianceCents: 100, signedOffByUserProfileId: AVA, signedOffAt: at('2026-09-13T23:00:00Z') }),
      record({ businessId: OTHER_BIZ, locationId: LONDON, businessDate: '2026-09-12', status: 'signed_off', expectedCashCents: 1, countedCashCents: 99, expectedCardCents: 1, countedCardCents: 99, varianceCents: 196 }),
    ],
    users: { [AVA]: 'Ava Stone', [BEN]: 'Ben Cole' },
    thresholds: [
      { businessId: BIZ, locationId: LONDON, cents: 500 },
      { businessId: BIZ, locationId: NEW_YORK, cents: 1000 },
    ],
  };
}

function scopeFor(filter: ReportFilter = RANGE, asOf: Date = AS_OF, locations = LOCATIONS): ReportScope {
  return moneyScope(BIZ, locations, filter, asOf);
}

async function build(opts: { filter?: ReportFilter; money?: Ledger; cashUps?: CashUpLedger; cap?: number; locations?: typeof LOCATIONS } = {}) {
  serial = 0;
  const moneySource = new MemoryMoneySource(opts.money ?? money(), opts.cap);
  const cashUpSource = new MemoryCashUpSource(opts.cashUps ?? cashUps(), opts.cap);
  const body = await new CashUpReportService(moneySource, cashUpSource).build(scopeFor(opts.filter, AS_OF, opts.locations), { cursor: null });
  return { body: firstPage(body), moneySource, cashUpSource };
}

function firstPage(body: CashUpReportBody): CashUpFirstPageBody {
  if (body.continuation) throw new Error('expected a first page');
  return body;
}

const p = (cents: number): CashUpAmount => ({ availability: 'available', cents });
const u = (reason: string) => ({ availability: 'unavailable', reason });
const count = (n: number) => ({ availability: 'available', count: n });
const location = (body: CashUpFirstPageBody, id: string) => body.locations.find((l) => l.locationId === id)!;

beforeEach(() => {
  serial = 0;
});

describe('R7 Cash Up reconciles to the source ledger', () => {
  it('London, to the penny', async () => {
    const { body } = await build();
    const london = location(body, LONDON);
    expect(london.currencyCode).toBe('GBP');
    expect(london.threshold).toEqual(p(500));
    expect(london.thresholdCurrencyCode).toBe('GBP');
    expect(london.totals).toEqual({
      days: { started: 3, signedOff: 2, open: 0, none: 0, inProgress: 1, notStarted: 1 },
      recorded: {
        cash: { expected: p(5000), counted: p(5500), variance: p(500) },
        card: { expected: p(26500), counted: p(26500), variance: p(0) },
        variance: p(500),
        pettyCashOut: p(500),
        refundsEntered: p(1200),
        voidsEntered: p(0),
        daysOutsideThreshold: count(1),
        daysUnavailable: 0,
        unavailableReasons: [],
      },
      sourceCheck: { daysChanged: count(1), cashChange: p(500), cardChange: p(0) },
      withoutSignOff: { expectedCash: p(900), expectedCard: p(3000) },
      retailOutsideTill: { other: p(300), notRecorded: p(200) },
    });
  });

  it('New York: its End of Day snapshot was on a London day, so recorded figures are unavailable, never compared', async () => {
    const { body } = await build();
    const ny = location(body, NEW_YORK).totals;
    expect(ny.days).toEqual({ started: 3, signedOff: 1, open: 0, none: 1, inProgress: 1, notStarted: 1 });
    expect(ny.recorded.cash).toEqual({ expected: u('london_trading_day'), counted: u('london_trading_day'), variance: u('london_trading_day') });
    expect(ny.recorded.variance).toEqual(u('london_trading_day'));
    // Every recorded figure covers the same days, so petty cash is left out with the rest.
    expect(ny.recorded.pettyCashOut).toEqual(u('london_trading_day'));
    expect(ny.recorded.daysUnavailable).toBe(1);
    expect(ny.recorded.unavailableReasons).toEqual(['london_trading_day']);
    // Nothing could be judged: the counts are unavailable, never 0.
    expect(ny.recorded.daysOutsideThreshold).toEqual(u('london_trading_day'));
    expect(ny.sourceCheck).toEqual({ daysChanged: u('london_trading_day'), cashChange: u('london_trading_day'), cardChange: u('london_trading_day') });
    expect(ny.withoutSignOff).toEqual({ expectedCash: p(0), expectedCard: p(0) });
  });

  it('a location with no cash-ups: No cash-up recorded, never zero variance; an unset threshold is never assumed', async () => {
    const { body } = await build();
    const empty = location(body, EMPTY);
    expect(empty.threshold).toEqual(u('threshold_not_set'));
    // Today (the 14th) is in progress, not missed.
    expect(empty.totals.days).toEqual({ started: 3, signedOff: 0, open: 0, none: 2, inProgress: 1, notStarted: 1 });
    expect(empty.totals.recorded.daysOutsideThreshold).toEqual(u('not_signed_off'));
    expect(empty.totals.sourceCheck.daysChanged).toEqual(u('not_signed_off'));
    expect(empty.totals.recorded.variance).toEqual(u('not_signed_off'));
    expect(empty.totals.recorded.cash.counted).toEqual(u('not_signed_off'));
    expect(empty.totals.withoutSignOff).toEqual({ expectedCash: p(0), expectedCard: p(0) });
  });

  it('the summary, to the penny', async () => {
    const { body } = await build();
    expect(body.currencyCode).toBe('GBP');
    expect(body.summary).toEqual({
      days: { started: 9, signedOff: 3, open: 0, none: 3, inProgress: 3, notStarted: 3 },
      recorded: {
        cash: { expected: p(5000), counted: p(5500), variance: p(500) },
        card: { expected: p(26500), counted: p(26500), variance: p(0) },
        variance: p(500),
        pettyCashOut: p(500),
        refundsEntered: p(1200),
        voidsEntered: p(0),
        daysOutsideThreshold: count(1),
        daysUnavailable: 1,
        unavailableReasons: ['london_trading_day'],
      },
      sourceCheck: { daysChanged: count(1), cashChange: p(500), cardChange: p(0) },
      withoutSignOff: { expectedCash: p(900), expectedCard: p(3000) },
      retailOutsideTill: { other: p(300), notRecorded: p(200) },
    });
  });

  it('day rows: recorded, per-tender variance, sign-off in local time, change since sign-off, and a draft day', async () => {
    const { body } = await build({ filter: { ...RANGE, view: 'detail' } });
    const rows = body.detail!.rows;
    expect(rows.map((r) => r.rowKey)).toEqual([
      `${LONDON}:2026-09-14`, `${NEW_YORK}:2026-09-14`, `${EMPTY}:2026-09-14`,
      `${LONDON}:2026-09-13`, `${NEW_YORK}:2026-09-13`, `${EMPTY}:2026-09-13`,
      `${LONDON}:2026-09-12`, `${NEW_YORK}:2026-09-12`, `${EMPTY}:2026-09-12`,
    ]);
    const row = (key: string) => rows.find((r) => r.rowKey === key)!;

    expect(row(`${LONDON}:2026-09-12`)).toEqual({
      rowKey: `${LONDON}:2026-09-12`,
      locationId: LONDON,
      localDate: '2026-09-12',
      isToday: false,
      status: 'signed_off',
      currencyCode: 'GBP',
      record: {
        openingFloat: p(10000),
        cash: { expected: p(4000), counted: p(3800), variance: p(-200) },
        card: { expected: p(26500), counted: p(26500), variance: p(0) },
        variance: p(-200),
        thresholdCheck: 'within',
        pettyCashOut: p(500),
        refundsEntered: p(0),
        voidsEntered: p(0),
        signedOffBy: 'Ava Stone',
        signedOff: { localDate: '2026-09-12', localTime: '20:30' },
        notes: 'Float miscounted',
      },
      sources: { expectedCash: p(4000), expectedCard: p(26500), retailOther: p(0), retailNotRecorded: p(0) },
      changeSinceSignOff: { cash: p(0), card: p(0) },
    });

    const thirteenth = row(`${LONDON}:2026-09-13`);
    expect(thirteenth.record?.thresholdCheck).toBe('outside');
    expect(thirteenth.changeSinceSignOff).toEqual({ cash: p(500), card: p(0) });
    expect(thirteenth.sources).toEqual({ expectedCash: p(1500), expectedCard: p(0), retailOther: p(300), retailNotRecorded: p(200) });

    const today = row(`${LONDON}:2026-09-14`);
    expect(today).toMatchObject({ isToday: true, status: 'open', changeSinceSignOff: null });
    expect(today.record?.cash).toEqual({ expected: p(0), counted: p(2000), variance: u('not_signed_off') });
    expect(today.record?.card.counted).toEqual(u('not_captured'));
    expect(today.record?.variance).toEqual(u('not_signed_off'));
    expect(today.record?.thresholdCheck).toBe('not_signed_off');
    expect(today.sources.expectedCash).toEqual(p(900));

    const ny = row(`${NEW_YORK}:2026-09-13`);
    expect(ny.record?.cash).toEqual({ expected: u('london_trading_day'), counted: p(5100), variance: u('london_trading_day') });
    expect(ny.record?.signedOff).toEqual({ localDate: '2026-09-13', localTime: '19:00' });
    expect(ny.record?.thresholdCheck).toBe('not_comparable');
    expect(ny.record?.pettyCashOut).toEqual(p(300));
    expect(ny.sources).toMatchObject({ expectedCash: p(5000), expectedCard: p(700) });

    expect(row(`${EMPTY}:2026-09-13`)).toMatchObject({ status: 'none', record: null, changeSinceSignOff: null });
    // The future-dated record and the other business's record never appear.
    expect(JSON.stringify(rows)).not.toMatch(/99999|2026-09-15/);
  });

  it('reads every row even when the server caps each read at two rows', async () => {
    const full = await build({ filter: { ...RANGE, view: 'detail' } });
    const capped = await build({ filter: { ...RANGE, view: 'detail' }, cap: 2 });
    expect(capped.body).toEqual(full.body);
  });
});

describe('currency and thresholds', () => {
  it('mixed currencies at a location are never totalled, in the location or the summary', async () => {
    serial = 0;
    const ledger = money();
    ledger.retail.push({ id: uid(), businessId: BIZ, locationId: LONDON, at: at('2026-09-13T13:00:00Z'), totalCents: 999, quantity: 1, method: 'cash', currencyCode: 'USD' });
    const { body } = await build({ money: ledger });
    expect(location(body, LONDON).currencyCode).toBeNull();
    expect(location(body, LONDON).totals.recorded.cash.expected).toEqual(u('mixed_currencies'));
    expect(location(body, LONDON).totals.withoutSignOff.expectedCash).toEqual(u('mixed_currencies'));
    expect(body.currencyCode).toBeNull();
    expect(body.summary.recorded.variance).toEqual(u('mixed_currencies'));
  });

  it('a cash-up stored in another currency than the location’s is unavailable and left out of the totals', async () => {
    const ledger = cashUps();
    ledger.records[0] = { ...ledger.records[0], currencyCode: 'EUR' };
    const { body } = await build({ cashUps: ledger, locations: [LOCATIONS[0]], filter: { ...RANGE, view: 'detail' } });
    const london = location(body, LONDON).totals;
    expect(london.recorded.daysUnavailable).toBe(1);
    expect(london.recorded.cash).toEqual({ expected: p(1000), counted: p(1700), variance: p(700) });
    const twelfth = body.detail!.rows.find((r) => r.localDate === '2026-09-12')!;
    expect(twelfth.record?.cash.counted).toEqual(u('currency_mismatch'));
    expect(twelfth.record?.thresholdCheck).toBe('not_comparable');
    expect(london.recorded.unavailableReasons).toEqual(['currency_mismatch']);
  });

  it('signed-off days at a location with no threshold setting: days outside threshold is unavailable, not counted against £5', async () => {
    const ledger = cashUps();
    ledger.records.push({ ...ledger.records[0], id: '99999999-0000-4000-8000-000000000001', locationId: EMPTY, varianceCents: -2000, countedCashCents: 2000, expectedCashCents: 4000 });
    const { body } = await build({ cashUps: ledger, locations: [LOCATIONS[2]], filter: { ...RANGE, view: 'detail' } });
    expect(location(body, EMPTY).totals.recorded.daysOutsideThreshold).toEqual(u('threshold_not_set'));
    expect(location(body, EMPTY).totals.recorded.variance).toEqual(p(-2000));
    // The day itself is not judged against an assumed threshold either.
    expect(body.detail!.rows.find((r) => r.localDate === '2026-09-12')!.record!.thresholdCheck).toBe('no_threshold');
  });
});

describe('availability', () => {
  it('a range that has not started reads nothing and shows Not started, never zeros', async () => {
    const future: ReportFilter = { ...RANGE, from: '2026-10-01', to: '2026-10-02', view: 'detail' };
    const { body, moneySource, cashUpSource } = await build({ filter: future });
    expect(body.summary.days).toEqual({ started: 0, signedOff: 0, open: 0, none: 0, inProgress: 0, notStarted: 6 });
    expect(body.summary.recorded.variance).toEqual({ availability: 'not_started' });
    expect(body.summary.withoutSignOff.expectedCash).toEqual({ availability: 'not_started' });
    expect(body.detail).toEqual({ notStarted: true, rows: [], nextCursor: null });
    expect(moneySource.reads.filter((r) => r.method !== 'locationCurrencies')).toEqual([]);
    expect(cashUpSource.reads.filter((r) => r.method === 'records')).toEqual([]);
  });
});
