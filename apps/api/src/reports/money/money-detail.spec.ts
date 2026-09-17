/**
 * R1 Money detail view: an opaque keyset cursor over (instant, kind, id), no row
 * cap, and rows that explain the report in the location's local time.
 */
import { HttpException } from '@nestjs/common';
import { MONEY_DETAIL_PAGE_SIZE, type MoneyDetailRow, type ReportFilter } from '@sheer/domain';
import {
  DETAIL_KIND_RANK,
  comparePositions,
  decodeDetailCursor,
  encodeDetailCursor,
  keysetAfter,
  mergeDetailPage,
  windowsFingerprint,
} from './money-detail';
import { MoneyReportService } from './money-report.service';
import { MemoryMoneySource, type Ledger } from './testing/memory-money-source';
import { firstPage, instant, moneyScope } from './testing/money-scope';

const BIZ = 'biz-1';
const LONDON = { id: '30000000-0000-4000-8000-000000000001', name: 'London', timezone: 'Europe/London' };
const TOKYO = { id: '30000000-0000-4000-8000-000000000002', name: 'Tokyo', timezone: 'Asia/Tokyo' };
const DETAIL: ReportFilter = { preset: 'today', locationIds: [], staffProfileIds: [], view: 'detail' };
const AS_OF = new Date('2026-09-14T15:30:00Z');
const ID = '40000000-0000-4000-8000-00000000000a';
const FP = windowsFingerprint([{ locationId: LONDON.id, fromUtc: '2026-09-13T23:00:00.000Z', toUtcExclusive: '2026-09-14T23:00:00.000Z' }]);

function expectCursorInvalid(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getResponse()).toMatchObject({ statusCode: 400, code: 'report_cursor_invalid' });
    return;
  }
  throw new Error('expected report_cursor_invalid');
}

describe('detail cursor', () => {
  it('round-trips a position', () => {
    const position = { key: '2026-09-14T10:00:00.123456Z', rank: 2, id: ID };
    expect(decodeDetailCursor(encodeDetailCursor(position, FP), FP)).toEqual(position);
  });

  it('is valid only for the windows it was issued for', () => {
    const position = { key: '2026-09-14T10:00:00.123456Z', rank: 0, id: ID };
    const nextDay = windowsFingerprint([{ locationId: LONDON.id, fromUtc: '2026-09-14T23:00:00.000Z', toUtcExclusive: '2026-09-15T23:00:00.000Z' }]);
    expect(nextDay).not.toBe(FP);
    expectCursorInvalid(() => decodeDetailCursor(encodeDetailCursor(position, FP), nextDay));
    // Window order does not matter; the set does.
    const a = { locationId: LONDON.id, fromUtc: '2026-09-13T23:00:00.000Z', toUtcExclusive: '2026-09-14T23:00:00.000Z' };
    const b = { locationId: TOKYO.id, fromUtc: '2026-09-14T15:00:00.000Z', toUtcExclusive: '2026-09-15T15:00:00.000Z' };
    expect(windowsFingerprint([a, b])).toBe(windowsFingerprint([b, a]));
    expect(windowsFingerprint([a, b])).not.toBe(windowsFingerprint([a]));
  });

  it('refuses anything malformed with 400 report_cursor_invalid', () => {
    const encode = (value: unknown) => `m1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    for (const cursor of [
      'abc',
      'm2.xyz',
      'm1.',
      'm1.***',
      `m1.${Buffer.from('not json').toString('base64url')}`,
      encode({ key: '2026-09-14T10:00:00.000000Z' }),
      encode(['2026-09-14T10:00:00Z', 0, ID]),
      encode(['2026-09-14T10:00:00.000000Z', 4, ID]),
      encode(['2026-09-14T10:00:00.000000Z', 1.5, ID]),
      encode(['2026-09-14T10:00:00.000000Z', 0, 'not-a-uuid']),
      encode(['2026-09-14T10:00:00.000000Z"),id.gt.(', 0, ID]),
      encode(['2026-09-14T10:00:00.000000Z', 0, ID]),
      encode(['2026-09-14T10:00:00.000000Z', 0, ID, 'short']),
      encode(['2026-09-14T10:00:00.000000Z', 0, ID, 'AAAAAAAAAAAAAAAA']),
      encode(['2026-09-14T10:00:00.000000Z', 0, ID, '0123456789abcdef']),
      `m1.${'A'.repeat(401)}`,
    ]) {
      expectCursorInvalid(() => decodeDetailCursor(cursor, FP));
    }
  });

  it('starts each kind at the right side of the cursor', () => {
    const position = { key: '2026-09-14T10:00:00.000000Z', rank: DETAIL_KIND_RANK.retail_sale, id: ID };
    expect(keysetAfter(position, DETAIL_KIND_RANK.paid_bill)).toEqual({ key: position.key, op: 'gt' });
    expect(keysetAfter(position, DETAIL_KIND_RANK.retail_sale)).toEqual({ key: position.key, id: ID });
    expect(keysetAfter(position, DETAIL_KIND_RANK.deposit_collected)).toEqual({ key: position.key, op: 'gte' });
    expect(keysetAfter(null, 0)).toBeNull();
  });

  it('orders by instant, then kind, then id, and reports more only when the merge overflows the page', () => {
    const a = { position: { key: '2026-09-14T10:00:00.000000Z', rank: 1, id: ID } };
    const b = { position: { key: '2026-09-14T10:00:00.000000Z', rank: 0, id: 'f0000000-0000-4000-8000-000000000000' } };
    const c = { position: { key: '2026-09-14T09:59:59.999999Z', rank: 3, id: ID } };
    expect(mergeDetailPage([a, b, c], 3)).toEqual({ page: [c, b, a], next: null });
    expect(mergeDetailPage([a, b, c], 2)).toEqual({ page: [c, b], next: b.position });
    expect(comparePositions(a.position, a.position)).toBe(0);
  });
});

let serial = 0;
const uid = () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}`;

/**
 * 60 bills, 40 retail lines, 20 collections and 10 refunds, most sharing one
 * microsecond — all inside the hours where London's 14 Sep and Tokyo's 15 Sep
 * windows overlap ([15:00Z, 23:00Z) on 14 Sep), so every row is in scope.
 */
function crowdedLedger(): Ledger {
  const ledger: Ledger = { bills: [], lines: [], payments: [], retail: [], deposits: [] };
  const sameInstant = instant('2026-09-14T16:00:00.500000Z');
  for (let i = 0; i < 60; i += 1) {
    const id = uid();
    const visitId = uid();
    const at = i < 45 ? sameInstant : instant(`2026-09-14T1${6 + (i % 4)}:00:00.000001Z`);
    ledger.bills.push({ id, visitId, businessId: BIZ, status: 'paid', locationId: i % 2 ? LONDON.id : TOKYO.id, at, billNumber: 5000 + i, grossCents: 1000 + i, netCents: 1000 + i, taxCents: 0, depositAppliedCents: 0, currencyCode: 'GBP' });
    ledger.lines.push({ id: uid(), billId: id, lineType: 'service', grossCents: 1000 + i, netCents: 1000 + i, taxCents: 0 });
    ledger.payments.push({ id: uid(), businessId: BIZ, visitId, locationId: i % 2 ? LONDON.id : TOKYO.id, at, method: 'card_reader', amountCents: 1000 + i, currencyCode: 'GBP' });
  }
  for (let i = 0; i < 40; i += 1) {
    ledger.retail.push({ id: uid(), businessId: BIZ, locationId: LONDON.id, at: i < 30 ? sameInstant : instant('2026-09-14T17:30:00Z'), totalCents: 500 + i, quantity: 1, method: 'cash', currencyCode: 'GBP' });
  }
  for (let i = 0; i < 20; i += 1) {
    const refunded = i < 10;
    ledger.deposits.push({ id: uid(), businessId: BIZ, locationId: LONDON.id, amountCents: 2000 + i, status: refunded ? 'refunded' : 'paid', paidAt: sameInstant, refundedAt: refunded ? sameInstant : null, currencyCode: 'GBP' });
  }
  return ledger;
}

async function page(source: MemoryMoneySource, cursor: string | null) {
  const scope = moneyScope(BIZ, [LONDON, TOKYO], DETAIL, AS_OF);
  const body = await new MoneyReportService(source).build(scope, { cursor });
  return body.detail!;
}

describe('detail paging over identical instants', () => {
  beforeEach(() => {
    serial = 0;
  });

  it('walks every row exactly once, in (instant, kind, id) order, with no cap', async () => {
    const source = new MemoryMoneySource(crowdedLedger());
    const seen: MoneyDetailRow[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const detail = await page(source, cursor);
      expect(detail.rows.length).toBeLessThanOrEqual(MONEY_DETAIL_PAGE_SIZE);
      seen.push(...detail.rows);
      cursor = detail.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    const keys = seen.map((row) => row.rowKey);
    expect(new Set(keys).size).toBe(keys.length);
    // 60 bills + 40 retail + 20 collections + 10 refunds.
    expect(keys.length).toBe(130);
    serial = 0;
    const ledger = crowdedLedger();
    const expectedOrder = [
      ...ledger.bills.map((b) => ({ key: b.at, rank: 0, id: b.id, rowKey: `paid_bill:${b.id}` })),
      ...ledger.retail.map((r) => ({ key: r.at, rank: 1, id: r.id, rowKey: `retail_sale:${r.id}` })),
      ...ledger.deposits.map((d) => ({ key: d.paidAt!, rank: 2, id: d.id, rowKey: `deposit_collected:${d.id}` })),
      ...ledger.deposits.filter((d) => d.refundedAt).map((d) => ({ key: d.refundedAt!, rank: 3, id: d.id, rowKey: `deposit_refunded:${d.id}` })),
    ]
      .sort((a, b) => comparePositions(a, b))
      .map((p) => p.rowKey);
    expect(keys).toEqual(expectedOrder);
  });

  it('gives the same page and the same next cursor for the same cursor', async () => {
    const source = new MemoryMoneySource(crowdedLedger());
    const first = await page(source, null);
    const again = await page(source, first.nextCursor);
    const repeat = await page(source, first.nextCursor);
    expect(repeat).toEqual(again);
    expect(again.rows[0].rowKey).not.toBe(first.rows[first.rows.length - 1].rowKey);
  });

  it('pages completely even when the server caps every read at seven rows', async () => {
    const source = new MemoryMoneySource(crowdedLedger(), 7);
    const keys: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const detail = await page(source, cursor);
      keys.push(...detail.rows.map((row) => row.rowKey));
      cursor = detail.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    expect(pages).toBe(3);
    expect(keys).toHaveLength(130);
    expect(new Set(keys).size).toBe(130);
  });

  it('a continuation page carries only the next rows and does not recompute the report', async () => {
    const source = new MemoryMoneySource(crowdedLedger());
    const first = await page(source, null);
    const readsBefore = source.reads.length;
    const scope = moneyScope(BIZ, [LONDON, TOKYO], DETAIL, AS_OF);
    const body = await new MoneyReportService(source).build(scope, { cursor: first.nextCursor });
    expect(body.continuation).toBe(true);
    expect(body.summary).toBeNull();
    expect(body.coverage).toBeNull();
    expect(body.locations).toEqual([]);
    expect(body.detail?.rows).toHaveLength(MONEY_DETAIL_PAGE_SIZE);
    const continuationReads = source.reads.slice(readsBefore);
    expect(continuationReads.some((r) => r.method === 'tillPaymentsInWindows')).toBe(false);
    expect(continuationReads.filter((r) => r.windows).every((r) => r.after !== null)).toBe(true);
  });

  it('refuses a cursor once the dates have moved on (past local midnight) or the locations changed', async () => {
    const source = new MemoryMoneySource(crowdedLedger());
    const first = await page(source, null);
    expect(first.nextCursor).not.toBeNull();
    // The same "Today" filter, one hour later: London and Tokyo are both on a new local day.
    const afterMidnight = moneyScope(BIZ, [LONDON, TOKYO], DETAIL, new Date('2026-09-14T23:30:00Z'));
    await expect(new MoneyReportService(source).build(afterMidnight, { cursor: first.nextCursor })).rejects.toMatchObject({
      response: { code: 'report_cursor_invalid' },
    });
    const londonOnly = moneyScope(BIZ, [LONDON], DETAIL, AS_OF);
    await expect(new MoneyReportService(source).build(londonOnly, { cursor: first.nextCursor })).rejects.toMatchObject({
      response: { code: 'report_cursor_invalid' },
    });
    // Within the same windows it still pages.
    const sameDayLater = moneyScope(BIZ, [LONDON, TOKYO], DETAIL, new Date('2026-09-14T15:59:00Z'));
    const next = await new MoneyReportService(source).build(sameDayLater, { cursor: first.nextCursor });
    expect(next.continuation).toBe(true);
  });

  it('a detail view whose dates have not started says so, with no rows', async () => {
    const scope = moneyScope(BIZ, [LONDON, TOKYO], { ...DETAIL, preset: 'custom', from: '2026-10-01', to: '2026-10-01' }, AS_OF);
    const body = firstPage(await new MoneyReportService(new MemoryMoneySource(crowdedLedger())).build(scope, { cursor: null }));
    expect(body.detail).toEqual({ notStarted: true, rows: [], nextCursor: null });
  });

  it('refuses a cursor without the detail view', async () => {
    const scope = moneyScope(BIZ, [LONDON], { ...DETAIL, view: 'summary' }, AS_OF);
    await expect(new MoneyReportService(new MemoryMoneySource(crowdedLedger())).build(scope, { cursor: 'm1.abc' })).rejects.toMatchObject({
      response: { code: 'report_cursor_invalid' },
    });
  });

  it('has no detail block in the summary view', async () => {
    const scope = moneyScope(BIZ, [LONDON], { ...DETAIL, view: 'summary' }, AS_OF);
    const body = await new MoneyReportService(new MemoryMoneySource(crowdedLedger())).build(scope, { cursor: null });
    expect(body.detail).toBeNull();
  });
});

describe('detail paging across location chunks', () => {
  // Twelve locations: the service reads ten at a time, so rows come from two chunks.
  const MANY = Array.from({ length: 12 }, (_, i) => ({
    id: `31000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    name: `Salon ${i}`,
    timezone: i % 2 ? 'Europe/London' : 'Asia/Tokyo',
  }));

  /**
   * 120 bills dealt round-robin across the twelve locations, the first 100 at one
   * microsecond, so ids interleave across the chunks and the first chunk alone
   * holds more than a page at that instant; plus 30 retail lines at the same
   * microsecond in both chunks. All inside the London/Tokyo overlap.
   */
  function spreadLedger(): Ledger {
    const ledger: Ledger = { bills: [], lines: [], payments: [], retail: [], deposits: [] };
    const sameInstant = instant('2026-09-14T16:00:00.500000Z');
    for (let i = 0; i < 120; i += 1) {
      const id = uid();
      const at = i < 100 ? sameInstant : instant(`2026-09-14T17:00:00.00000${i % 3}Z`);
      ledger.bills.push({ id, visitId: uid(), businessId: BIZ, status: 'paid', locationId: MANY[i % 12].id, at, billNumber: 7000 + i, grossCents: 100 + i, netCents: 100 + i, taxCents: 0, depositAppliedCents: 0, currencyCode: 'GBP' });
      ledger.lines.push({ id: uid(), billId: id, lineType: 'service', grossCents: 100 + i, netCents: 100 + i, taxCents: 0 });
    }
    for (let i = 0; i < 30; i += 1) {
      ledger.retail.push({ id: uid(), businessId: BIZ, locationId: MANY[(i * 5) % 12].id, at: sameInstant, totalCents: 300 + i, quantity: 1, method: 'cash', currencyCode: 'GBP' });
    }
    return ledger;
  }

  beforeEach(() => {
    serial = 0;
  });

  it('walks every row of every chunk exactly once, in order, under a server row cap', async () => {
    const ledger = spreadLedger();
    const source = new MemoryMoneySource(ledger, 7);
    const scope = moneyScope(BIZ, MANY, DETAIL, AS_OF);
    const keys: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const body = await new MoneyReportService(source).build(scope, { cursor });
      expect(body.detail!.rows.length).toBeLessThanOrEqual(MONEY_DETAIL_PAGE_SIZE);
      keys.push(...body.detail!.rows.map((row) => row.rowKey));
      cursor = body.detail!.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 10);
    const expectedOrder = [
      ...ledger.bills.map((b) => ({ key: b.at, rank: 0, id: b.id, rowKey: `paid_bill:${b.id}` })),
      ...ledger.retail.map((r) => ({ key: r.at, rank: 1, id: r.id, rowKey: `retail_sale:${r.id}` })),
    ]
      .sort((a, b) => comparePositions(a, b))
      .map((p) => p.rowKey);
    expect(pages).toBe(3);
    expect(keys).toEqual(expectedOrder);
    // The reads really were split: some bill read covered only the second chunk's two locations.
    expect(source.reads.some((r) => r.method === 'paidBills' && r.windows?.length === 2)).toBe(true);
    expect(source.reads.every((r) => (r.windows?.length ?? 0) <= 10)).toBe(true);
  });
});

describe('detail rows explain the money in local time', () => {
  it('shows each location’s local date and time, the bill’s tenders and deposit, and never raw UTC', async () => {
    serial = 0;
    const billId = uid();
    const visitId = uid();
    const partial = uid();
    const ledger: Ledger = {
      bills: [{ id: billId, visitId, businessId: BIZ, status: 'paid', locationId: TOKYO.id, at: instant('2026-09-14T16:05:00Z'), billNumber: 42, grossCents: 12000, netCents: 10000, taxCents: 2000, depositAppliedCents: 2000, currencyCode: 'GBP' }],
      lines: [
        { id: uid(), billId, lineType: 'service', grossCents: 9000, netCents: 7500, taxCents: 1500 },
        { id: uid(), billId, lineType: 'product_usage', grossCents: 3000, netCents: 2500, taxCents: 500 },
      ],
      payments: [
        { id: uid(), businessId: BIZ, visitId, locationId: TOKYO.id, at: instant('2026-09-14T16:05:00Z'), method: 'cash', amountCents: 4000, currencyCode: 'GBP' },
        { id: uid(), businessId: BIZ, visitId, locationId: TOKYO.id, at: instant('2026-09-14T16:05:00Z'), method: 'card_reader', amountCents: 6000, currencyCode: 'GBP' },
      ],
      retail: [{ id: uid(), businessId: BIZ, locationId: LONDON.id, at: instant('2026-09-14T08:15:00Z'), totalCents: 2500, quantity: 2, method: 'not_recorded', currencyCode: 'GBP' }],
      deposits: [{ id: partial, businessId: BIZ, locationId: LONDON.id, amountCents: 3000, status: 'partially_refunded', paidAt: instant('2026-09-01T10:00:00Z'), refundedAt: instant('2026-09-14T09:00:00Z'), currencyCode: 'GBP' }],
    };
    const detail = await page(new MemoryMoneySource(ledger), null);
    expect(detail.nextCursor).toBeNull();
    expect(detail.notStarted).toBe(false);
    expect(detail.rows).toEqual([
      {
        kind: 'retail_sale',
        rowKey: expect.stringMatching(/^retail_sale:/),
        locationId: LONDON.id,
        localDate: '2026-09-14',
        localTime: '09:15',
        currencyCode: 'GBP',
        amount: { availability: 'available', cents: 2500 },
        quantity: 2,
        method: 'not_recorded',
      },
      {
        kind: 'deposit_refunded',
        rowKey: `deposit_refunded:${partial}`,
        locationId: LONDON.id,
        localDate: '2026-09-14',
        localTime: '10:00',
        currencyCode: 'GBP',
        amount: { availability: 'unavailable', reason: 'partial_refund_amount_not_recorded' },
      },
      {
        kind: 'paid_bill',
        rowKey: `paid_bill:${billId}`,
        locationId: TOKYO.id,
        localDate: '2026-09-15',
        localTime: '01:05',
        currencyCode: 'GBP',
        amount: { availability: 'available', cents: 12000 },
        billNumber: 42,
        netOfVat: { availability: 'available', cents: 10000 },
        vat: { availability: 'available', cents: 2000 },
        colour: { availability: 'available', cents: 3000 },
        cash: { availability: 'available', cents: 4000 },
        cardReader: { availability: 'available', cents: 6000 },
        depositApplied: { availability: 'available', cents: 2000 },
      },
    ]);
    expect(JSON.stringify(detail)).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('a bill whose till payments are in another currency does not show them under the bill’s currency', async () => {
    serial = 0;
    const billId = uid();
    const visitId = uid();
    const ledger: Ledger = {
      bills: [{ id: billId, visitId, businessId: BIZ, status: 'paid', locationId: LONDON.id, at: instant('2026-09-14T16:05:00Z'), billNumber: 7, grossCents: 5000, netCents: 5000, taxCents: 0, depositAppliedCents: 0, currencyCode: 'GBP' }],
      lines: [{ id: uid(), billId, lineType: 'service', grossCents: 5000, netCents: 5000, taxCents: 0 }],
      payments: [{ id: uid(), businessId: BIZ, visitId, locationId: LONDON.id, at: instant('2026-09-14T16:05:00Z'), method: 'cash', amountCents: 5000, currencyCode: 'EUR' }],
      retail: [],
      deposits: [],
    };
    const [row] = (await page(new MemoryMoneySource(ledger), null)).rows;
    expect(row).toMatchObject({
      kind: 'paid_bill',
      amount: { availability: 'available', cents: 5000 },
      cash: { availability: 'unavailable', reason: 'mixed_currencies' },
      cardReader: { availability: 'unavailable', reason: 'mixed_currencies' },
    });
  });
});
