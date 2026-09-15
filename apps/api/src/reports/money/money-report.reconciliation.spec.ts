/**
 * R1 Money reconciliation: SOURCE LEDGER = REPORT, to the penny.
 *
 * asOf 2026-09-14T15:30:00Z, preset Today. Each location reads its own window:
 *   London   (Europe/London,     Mon 14 Sep)  [2026-09-13T23:00Z, 2026-09-14T23:00Z)
 *   Tokyo    (Asia/Tokyo,        Tue 15 Sep)  [2026-09-14T15:00Z, 2026-09-15T15:00Z)
 *   New York (America/New_York,  Mon 14 Sep)  [2026-09-14T04:00Z, 2026-09-15T04:00Z)
 *
 * LEDGER (pence)                                       gross    net   VAT  dep.applied  cash   card
 * London
 *   #1001 14T10:00Z  service 12000/10000/2000          12000  10000  2000       2000    4000   6000
 *   #1002 14T11:15:30.123456Z  service 15000 + colour  18000  15000  3000          0       0  18000
 *         3000 (2500/500)
 *   #1003 14T12:00Z  service 5000 (4167/833) +          4500   3667   833          0    4500      0
 *         adjustment −500 (VAT 0)
 *   #1005 14T14:00Z  seeded header-only bill, no lines   1000   1000     0          0       0      0
 *   #1004 14T13:00Z  VOIDED                             excluded
 *   #0999 13T22:59:59.999999Z  (London 13 Sep)          excluded (before London's window)
 *   other business, same window                         excluded
 *   retail: card 2500 · cash 1200 (same instant as card) · method null 1000   = 4700
 *   deposits: collected 14T08:00Z 1500 (future booking); collected 14T07:30Z 3000 and refunded
 *             14T16:00Z (3000); a deposit collected 9 Sep and refunded 14T17:00Z (700) whose status a
 *             re-delivered Stripe webhook put back to 'paid' (refunded_at still set, so it counts);
 *             the deposit redeemed on #1001 was collected 11 Sep (not in window)
 *   till payment 14T15:00Z cash 2200 for a visit with NO bill, and the voided #1004's cash 9999
 *   (a payment whose visit has no PAID bill) → coverage notice: 2 payments, 12199
 *   London: gross 35500 net 29667 VAT 5833 | service 32000 colour 3000 adjustment −500 not itemised 1000
 *           cash 8500 card 24000 deposits applied 2000 not itemised 1000 | retail 4700
 *           deposits collected 4500 redeemed 2000 refunded 3700
 * Tokyo
 *   #2001 14T15:00:00.000000Z (window start, inclusive)  8000   8000     0          0       0   8000
 *   #2000 14T14:59:59.999999Z (Tokyo 14 Sep)            excluded
 *   retail other 3300; a partially refunded deposit (refund amount not stored) → refunds Not recorded
 * New York
 *   #3001 15T03:59:59.999999Z (inside, before the end)  6000   5000  1000       1000    5000      0
 *   #3002 14T20:00Z  service 7000 (5834/1166) + colour  10000   8334  1666          0    3000   7000
 *         3000 (2500/500) — split tender
 *   #3003 15T04:00:00.000000Z (window end, exclusive)   excluded
 *   #2999 14T02:00Z (New York 13 Sep)                   excluded
 * SUMMARY: gross 59500 net 51001 VAT 8499 | service 53000 colour 6000 adjustment −500 not itemised 1000
 *          cash 16500 card 39000 deposits applied 3000 not itemised 1000 | retail 8000
 *          (cash 1200 card 2500 other 3300 not recorded 1000) | deposits collected 4500 redeemed 3000
 *          refunded Not recorded (Tokyo's partial refund) | coverage: 2 payments, 12199
 */
import type { MoneyAmount, MoneyTotals, ReportFilter } from '@sheer/domain';
import type { ReportScope } from '../report-scope.service';
import { MoneyReportService } from './money-report.service';
import { MemoryMoneySource, type Ledger, type LedgerBill, type LedgerLine } from './testing/memory-money-source';
import { firstPage, instant as at, moneyScope, type FirstPageBody } from './testing/money-scope';

const BIZ = 'biz-1';
const OTHER_BIZ = 'biz-2';
const LONDON = '10000000-0000-4000-8000-000000000001';
const TOKYO = '10000000-0000-4000-8000-000000000002';
const NEW_YORK = '10000000-0000-4000-8000-000000000003';
const LOCATIONS = [
  { id: LONDON, name: 'London', timezone: 'Europe/London' },
  { id: TOKYO, name: 'Tokyo', timezone: 'Asia/Tokyo' },
  { id: NEW_YORK, name: 'New York', timezone: 'America/New_York' },
];
const AS_OF = new Date('2026-09-14T15:30:00Z');
const TODAY: ReportFilter = { preset: 'today', locationIds: [], staffProfileIds: [], view: 'summary' };

let serial = 0;
const uid = () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}`;

function bill(
  ledger: Ledger,
  fields: Partial<LedgerBill> & { locationId: string; at: string; billNumber: number; gross: number; net: number; tax: number },
  lines: Array<[LedgerLine['lineType'], number, number, number]>,
  payments: Array<['cash' | 'card_reader', number]>,
  depositApplied = 0,
): void {
  const id = uid();
  const visitId = uid();
  ledger.bills.push({
    id,
    visitId,
    businessId: fields.businessId ?? BIZ,
    status: fields.status ?? 'paid',
    locationId: fields.locationId,
    at: at(fields.at),
    billNumber: fields.billNumber,
    grossCents: fields.gross,
    netCents: fields.net,
    taxCents: fields.tax,
    depositAppliedCents: depositApplied,
    currencyCode: fields.currencyCode ?? 'GBP',
  });
  for (const [lineType, gross, net, tax] of lines) ledger.lines.push({ id: uid(), billId: id, lineType, grossCents: gross, netCents: net, taxCents: tax });
  for (const [method, amount] of payments) {
    ledger.payments.push({ id: uid(), businessId: fields.businessId ?? BIZ, visitId, locationId: fields.locationId, at: at(fields.at), method, amountCents: amount, currencyCode: 'GBP' });
  }
}

function buildLedger(): Ledger {
  const ledger: Ledger = { bills: [], lines: [], payments: [], retail: [], deposits: [] };
  // London
  bill(ledger, { locationId: LONDON, at: '2026-09-14T10:00:00Z', billNumber: 1001, gross: 12000, net: 10000, tax: 2000 }, [['service', 12000, 10000, 2000]], [['cash', 4000], ['card_reader', 6000]], 2000);
  bill(ledger, { locationId: LONDON, at: '2026-09-14T11:15:30.123456Z', billNumber: 1002, gross: 18000, net: 15000, tax: 3000 }, [['service', 15000, 12500, 2500], ['product_usage', 3000, 2500, 500]], [['card_reader', 18000]]);
  bill(ledger, { locationId: LONDON, at: '2026-09-14T12:00:00Z', billNumber: 1003, gross: 4500, net: 3667, tax: 833 }, [['service', 5000, 4167, 833], ['adjustment', -500, -500, 0]], [['cash', 4500]]);
  bill(ledger, { locationId: LONDON, at: '2026-09-14T14:00:00Z', billNumber: 1005, gross: 1000, net: 1000, tax: 0 }, [], []);
  bill(ledger, { locationId: LONDON, at: '2026-09-14T13:00:00Z', billNumber: 1004, gross: 9999, net: 9999, tax: 0, status: 'voided' }, [['service', 9999, 9999, 0]], [['cash', 9999]]);
  bill(ledger, { locationId: LONDON, at: '2026-09-13T22:59:59.999999Z', billNumber: 999, gross: 7777, net: 7777, tax: 0 }, [['service', 7777, 7777, 0]], [['cash', 7777]]);
  bill(ledger, { locationId: LONDON, at: '2026-09-14T10:30:00Z', billNumber: 1, gross: 99999, net: 99999, tax: 0, businessId: OTHER_BIZ }, [['service', 99999, 99999, 0]], [['cash', 99999]]);
  ledger.retail.push(
    { id: uid(), businessId: BIZ, locationId: LONDON, at: at('2026-09-14T09:00:00Z'), totalCents: 2500, quantity: 1, method: 'card_reader', currencyCode: 'GBP' },
    { id: uid(), businessId: BIZ, locationId: LONDON, at: at('2026-09-14T09:00:00Z'), totalCents: 1200, quantity: 2, method: 'cash', currencyCode: 'GBP' },
    { id: uid(), businessId: BIZ, locationId: LONDON, at: at('2026-09-14T09:45:00Z'), totalCents: 1000, quantity: 1, method: 'not_recorded', currencyCode: 'GBP' },
  );
  ledger.deposits.push(
    { id: uid(), businessId: BIZ, locationId: LONDON, amountCents: 1500, status: 'paid', paidAt: at('2026-09-14T08:00:00Z'), refundedAt: null, currencyCode: 'GBP' },
    { id: uid(), businessId: BIZ, locationId: LONDON, amountCents: 3000, status: 'refunded', paidAt: at('2026-09-14T07:30:00Z'), refundedAt: at('2026-09-14T16:00:00Z'), currencyCode: 'GBP' },
    { id: uid(), businessId: BIZ, locationId: LONDON, amountCents: 2000, status: 'paid', paidAt: at('2026-09-11T10:00:00Z'), refundedAt: null, currencyCode: 'GBP' },
    { id: uid(), businessId: BIZ, locationId: LONDON, amountCents: 4000, status: 'pending', paidAt: null, refundedAt: null, currencyCode: 'GBP' },
    { id: uid(), businessId: BIZ, locationId: LONDON, amountCents: 700, status: 'paid', paidAt: at('2026-09-09T10:00:00Z'), refundedAt: at('2026-09-14T17:00:00Z'), currencyCode: 'GBP' },
  );
  ledger.payments.push({ id: uid(), businessId: BIZ, visitId: uid(), locationId: LONDON, at: at('2026-09-14T15:00:00Z'), method: 'cash', amountCents: 2200, currencyCode: 'GBP' });
  // Tokyo
  bill(ledger, { locationId: TOKYO, at: '2026-09-14T15:00:00Z', billNumber: 2001, gross: 8000, net: 8000, tax: 0 }, [['service', 8000, 8000, 0]], [['card_reader', 8000]]);
  bill(ledger, { locationId: TOKYO, at: '2026-09-14T14:59:59.999999Z', billNumber: 2000, gross: 5000, net: 5000, tax: 0 }, [['service', 5000, 5000, 0]], [['card_reader', 5000]]);
  ledger.retail.push({ id: uid(), businessId: BIZ, locationId: TOKYO, at: at('2026-09-15T01:00:00Z'), totalCents: 3300, quantity: 1, method: 'other', currencyCode: 'GBP' });
  ledger.deposits.push({ id: uid(), businessId: BIZ, locationId: TOKYO, amountCents: 2500, status: 'partially_refunded', paidAt: at('2026-09-10T02:00:00Z'), refundedAt: at('2026-09-15T02:00:00Z'), currencyCode: 'GBP' });
  // New York
  bill(ledger, { locationId: NEW_YORK, at: '2026-09-15T03:59:59.999999Z', billNumber: 3001, gross: 6000, net: 5000, tax: 1000 }, [['service', 6000, 5000, 1000]], [['cash', 5000]], 1000);
  bill(ledger, { locationId: NEW_YORK, at: '2026-09-14T20:00:00Z', billNumber: 3002, gross: 10000, net: 8334, tax: 1666 }, [['service', 7000, 5834, 1166], ['product_usage', 3000, 2500, 500]], [['cash', 3000], ['card_reader', 7000]]);
  bill(ledger, { locationId: NEW_YORK, at: '2026-09-15T04:00:00Z', billNumber: 3003, gross: 4000, net: 4000, tax: 0 }, [['service', 4000, 4000, 0]], [['cash', 4000]]);
  bill(ledger, { locationId: NEW_YORK, at: '2026-09-14T02:00:00Z', billNumber: 2999, gross: 3000, net: 3000, tax: 0 }, [['service', 3000, 3000, 0]], [['cash', 3000]]);
  return ledger;
}

function scopeFor(filter: ReportFilter, asOf: Date = AS_OF, locations = LOCATIONS): ReportScope {
  return moneyScope(BIZ, locations, filter, asOf);
}

const cents = (amount: MoneyAmount): number => {
  if (amount.availability !== 'available') throw new Error(`expected an available amount, got ${JSON.stringify(amount)}`);
  return amount.cents;
};

/** The figures of a totals block as plain pence, for exact comparison with the ledger table. */
function ledgerView(t: MoneyTotals) {
  return {
    gross: cents(t.paidBills.gross),
    net: cents(t.paidBills.netOfVat),
    vat: cents(t.paidBills.vat),
    composition: Object.fromEntries(t.composition.map((c) => [c.key, cents(c.gross)])),
    colour: [cents(t.colour.gross), cents(t.colour.netOfVat), cents(t.colour.vat)],
    settlement: Object.fromEntries(t.settlement.map((s) => [s.key, cents(s.amount)])),
    retail: cents(t.retail.recorded),
    retailByMethod: Object.fromEntries(t.retail.byMethod.map((m) => [m.key, cents(m.amount)])),
    collected: cents(t.deposits.collected),
    redeemed: cents(t.deposits.redeemed),
  };
}

async function build(filter: ReportFilter = TODAY, serverCap?: number): Promise<{ body: FirstPageBody; source: MemoryMoneySource }> {
  const source = new MemoryMoneySource(buildLedger(), serverCap);
  const body = firstPage(await new MoneyReportService(source).build(scopeFor(filter), { cursor: null }));
  return { body, source };
}

beforeEach(() => {
  serial = 0;
});

describe('R1 Money reconciles to the source ledger', () => {
  it('London, to the penny', async () => {
    const { body } = await build();
    const london = body.locations.find((l) => l.locationId === LONDON)!.totals;
    expect(ledgerView(london)).toEqual({
      gross: 35500,
      net: 29667,
      vat: 5833,
      composition: { service: 32000, product_usage: 3000, adjustment: -500, not_itemised: 1000 },
      colour: [3000, 2500, 500],
      settlement: { cash: 8500, card_reader: 24000, deposits_applied: 2000, not_itemised: 1000 },
      retail: 4700,
      retailByMethod: { cash: 1200, card_reader: 2500, other: 0, not_recorded: 1000 },
      collected: 4500,
      redeemed: 2000,
    });
    expect(london.deposits.refunded).toEqual({ availability: 'available', cents: 3700 });
  });

  it('Tokyo, on its own local date, with the window start inclusive', async () => {
    const { body } = await build();
    const tokyo = body.locations.find((l) => l.locationId === TOKYO)!.totals;
    expect(ledgerView(tokyo)).toEqual({
      gross: 8000,
      net: 8000,
      vat: 0,
      composition: { service: 8000, product_usage: 0, adjustment: 0, not_itemised: 0 },
      colour: [0, 0, 0],
      settlement: { cash: 0, card_reader: 8000, deposits_applied: 0, not_itemised: 0 },
      retail: 3300,
      retailByMethod: { cash: 0, card_reader: 0, other: 3300, not_recorded: 0 },
      collected: 0,
      redeemed: 0,
    });
    expect(tokyo.deposits.refunded).toEqual({ availability: 'unavailable', reason: 'partial_refund_amount_not_recorded' });
  });

  it('New York, with the window end exclusive and a split tender', async () => {
    const { body } = await build();
    const newYork = body.locations.find((l) => l.locationId === NEW_YORK)!.totals;
    expect(ledgerView(newYork)).toEqual({
      gross: 16000,
      net: 13334,
      vat: 2666,
      composition: { service: 13000, product_usage: 3000, adjustment: 0, not_itemised: 0 },
      colour: [3000, 2500, 500],
      settlement: { cash: 8000, card_reader: 7000, deposits_applied: 1000, not_itemised: 0 },
      retail: 0,
      retailByMethod: { cash: 0, card_reader: 0, other: 0, not_recorded: 0 },
      collected: 0,
      redeemed: 1000,
    });
    expect(newYork.deposits.refunded).toEqual({ availability: 'available', cents: 0 });
  });

  it('the summary, to the penny', async () => {
    const { body } = await build();
    expect(ledgerView(body.summary)).toEqual({
      gross: 59500,
      net: 51001,
      vat: 8499,
      composition: { service: 53000, product_usage: 6000, adjustment: -500, not_itemised: 1000 },
      colour: [6000, 5000, 1000],
      settlement: { cash: 16500, card_reader: 39000, deposits_applied: 3000, not_itemised: 1000 },
      retail: 8000,
      retailByMethod: { cash: 1200, card_reader: 2500, other: 3300, not_recorded: 1000 },
      collected: 4500,
      redeemed: 3000,
    });
    expect(body.summary.deposits.refunded).toEqual({ availability: 'unavailable', reason: 'partial_refund_amount_not_recorded' });
    expect(body.currencyCode).toBe('GBP');
    expect(body.coverage).toEqual({ tillPaymentsWithoutBill: { count: 2, amount: { availability: 'available', cents: 12199 }, currencyCode: 'GBP' } });
    expect(body.continuation).toBe(false);
    expect(body.locations.map((l) => l.currencyCode)).toEqual(['GBP', 'GBP', 'GBP']);
  });

  it('the location rows sum to the summary for every additive figure', async () => {
    const { body } = await build();
    const rows = body.locations.map((l) => ledgerView(l.totals));
    const summary = ledgerView(body.summary);
    const add = (pick: (v: ReturnType<typeof ledgerView>) => number) => rows.reduce((sum, row) => sum + pick(row), 0);
    for (const pick of [
      (v: ReturnType<typeof ledgerView>) => v.gross,
      (v: ReturnType<typeof ledgerView>) => v.net,
      (v: ReturnType<typeof ledgerView>) => v.vat,
      (v: ReturnType<typeof ledgerView>) => v.retail,
      (v: ReturnType<typeof ledgerView>) => v.collected,
      (v: ReturnType<typeof ledgerView>) => v.redeemed,
    ]) {
      expect(add(pick)).toBe(pick(summary));
    }
    for (const key of Object.keys(summary.composition)) expect(add((v) => v.composition[key] ?? 0)).toBe(summary.composition[key]);
    for (const key of Object.keys(summary.settlement)) expect(add((v) => v.settlement[key])).toBe(summary.settlement[key]);
    for (const key of Object.keys(summary.retailByMethod)) expect(add((v) => v.retailByMethod[key])).toBe(summary.retailByMethod[key]);
  });

  it('composition and settlement each reconcile exactly to paid bill gross; retail methods to retail', async () => {
    const { body } = await build();
    for (const totals of [body.summary, ...body.locations.map((l) => l.totals)]) {
      const v = ledgerView(totals);
      expect(Object.values(v.composition).reduce((a, b) => a + b, 0)).toBe(v.gross);
      expect(Object.values(v.settlement).reduce((a, b) => a + b, 0)).toBe(v.gross);
      expect(Object.values(v.retailByMethod).reduce((a, b) => a + b, 0)).toBe(v.retail);
      expect(v.net + v.vat).toBe(v.gross);
    }
  });

  it('colour is inside gross, never added to it; retail and deposits are never inside gross', async () => {
    const { body } = await build();
    const v = ledgerView(body.summary);
    expect(v.gross).toBe(59500);
    expect(v.gross).not.toBe(59500 + v.colour[0]);
    expect(v.gross).not.toBe(59500 + v.retail);
    expect(v.collected).not.toBe(v.redeemed);
  });

  it('never shows a number for what QLOOQO does not record', async () => {
    const { body } = await build();
    expect(body.notRecorded).toEqual(['discounts', 'till_refunds', 'voids', 'tips', 'retail_vat', 'forfeited_deposits', 'outside_deposit_refunds']);
    expect(body.summary.retail.vat).toEqual({ availability: 'unavailable', reason: 'not_captured' });
    expect(body.summary.netPosition).toEqual({ availability: 'unavailable', reason: 'definition_pending' });
    // No figure exists for them anywhere in the body: only the category names above.
    expect(JSON.stringify(body)).not.toMatch(/"(discount|tip|void|refund)s?Cents"/i);
  });

  it('reads every row even when the server caps each read at two rows', async () => {
    const full = await build();
    serial = 0;
    const capped = await build(TODAY, 2);
    expect(capped.body).toEqual(full.body);
    expect(capped.source.reads.filter((r) => r.method === 'paidBills').length).toBeGreaterThan(3);
  });

  it('a London-only scope reports only London, where refunds are available', async () => {
    const londonOnly = firstPage(
      await new MoneyReportService(new MemoryMoneySource(buildLedgerFresh())).build(scopeFor(TODAY, AS_OF, [LOCATIONS[0]]), { cursor: null }),
    );
    expect(londonOnly.locations.map((l) => l.locationId)).toEqual([LONDON]);
    expect(ledgerView(londonOnly.summary).gross).toBe(35500);
    expect(londonOnly.summary.deposits.refunded).toEqual({ availability: 'available', cents: 3700 });
  });
});

function buildLedgerFresh(): Ledger {
  serial = 0;
  return buildLedger();
}

describe('availability', () => {
  it('a window that has not started renders Not started and reads nothing', async () => {
    const source = new MemoryMoneySource(buildLedger());
    const future: ReportFilter = { preset: 'custom', from: '2026-10-01', to: '2026-10-02', locationIds: [], staffProfileIds: [], view: 'summary' };
    const body = firstPage(await new MoneyReportService(source).build(scopeFor(future), { cursor: null }));
    expect(body.summary.paidBills.gross).toEqual({ availability: 'not_started' });
    expect(body.summary.deposits.collected).toEqual({ availability: 'not_started' });
    expect(body.locations.every((l) => l.totals.paidBills.gross.availability === 'not_started')).toBe(true);
    expect(body.coverage.tillPaymentsWithoutBill.amount).toEqual({ availability: 'not_started' });
    expect(body.currencyCode).toBeNull();
    expect(source.reads).toEqual([]);
  });

  it('a started location with no facts shows recorded zeros, which are genuine', async () => {
    const source = new MemoryMoneySource({ bills: [], lines: [], payments: [], retail: [], deposits: [] });
    const body = firstPage(await new MoneyReportService(source).build(scopeFor(TODAY), { cursor: null }));
    expect(body.summary.paidBills.gross).toEqual({ availability: 'available', cents: 0 });
  });

  it('mixed currencies are never summed', async () => {
    const ledger = buildLedger();
    ledger.retail.push({ id: uid(), businessId: BIZ, locationId: NEW_YORK, at: at('2026-09-14T18:00:00Z'), totalCents: 999, quantity: 1, method: 'card_reader', currencyCode: 'USD' });
    const body = firstPage(await new MoneyReportService(new MemoryMoneySource(ledger)).build(scopeFor(TODAY), { cursor: null }));
    expect(body.summary.paidBills.gross).toEqual({ availability: 'unavailable', reason: 'mixed_currencies' });
    expect(body.currencyCode).toBeNull();
    // Each location row carries its own currency: London is still GBP, New York is mixed.
    expect(body.locations.map((l) => [l.locationId, l.currencyCode])).toEqual([[LONDON, 'GBP'], [TOKYO, 'GBP'], [NEW_YORK, null]]);
    const london = body.locations.find((l) => l.locationId === LONDON)!.totals;
    expect(london.paidBills.gross).toEqual({ availability: 'available', cents: 35500 });
    const newYork = body.locations.find((l) => l.locationId === NEW_YORK)!.totals;
    expect(newYork.retail.recorded).toEqual({ availability: 'unavailable', reason: 'mixed_currencies' });
  });
});
