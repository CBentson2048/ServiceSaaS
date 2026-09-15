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
} from './money-detail';
import { MoneyReportService } from './money-report.service';
import { MemoryMoneySource, type Ledger } from './testing/memory-money-source';
import { instant, moneyScope } from './testing/money-scope';

const BIZ = 'biz-1';
const LONDON = { id: '30000000-0000-4000-8000-000000000001', name: 'London', timezone: 'Europe/London' };
const TOKYO = { id: '30000000-0000-4000-8000-000000000002', name: 'Tokyo', timezone: 'Asia/Tokyo' };
const DETAIL: ReportFilter = { preset: 'today', locationIds: [], staffProfileIds: [], view: 'detail' };
const AS_OF = new Date('2026-09-14T15:30:00Z');
const ID = '40000000-0000-4000-8000-00000000000a';

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
    expect(decodeDetailCursor(encodeDetailCursor(position))).toEqual(position);
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
      `m1.${'A'.repeat(401)}`,
    ]) {
      expectCursorInvalid(() => decodeDetailCursor(cursor));
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
});
