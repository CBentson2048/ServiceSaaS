/**
 * R7 Cash Up detail view: location-days newest first, an opaque cursor bound to
 * the windows it was issued for, no row cap, and continuation pages that read only
 * their own days' cash-ups.
 */
import { HttpException } from '@nestjs/common';
import { CASH_UP_DETAIL_PAGE_SIZE, type CashUpReportBody, type ReportFilter } from '@sheer/domain';
import { MemoryMoneySource, type Ledger } from '../money/testing/memory-money-source';
import { instant, moneyScope } from '../money/testing/money-scope';
import { cashUpFingerprint, comparePositions, decodeCashUpCursor, encodeCashUpCursor, pageAfter } from './cash-up-detail';
import { CashUpReportService } from './cash-up-report.service';
import { MemoryCashUpSource, type CashUpLedger } from './testing/memory-cash-up-source';

const BIZ = 'biz-1';
const LONDON = { id: '42000000-0000-4000-8000-000000000001', name: 'London', timezone: 'Europe/London' };
const TOKYO = { id: '42000000-0000-4000-8000-000000000002', name: 'Tokyo', timezone: 'Asia/Tokyo' };
const DETAIL = (from: string, to: string): ReportFilter => ({ preset: 'custom', from, to, locationIds: [], staffProfileIds: [], view: 'detail' });
const WINDOW = {
  locationId: LONDON.id,
  timezone: 'Europe/London',
  localToday: '2026-09-14',
  from: '2026-09-01',
  to: '2026-09-14',
  fromUtc: '2026-08-31T23:00:00.000Z',
  toUtcExclusive: '2026-09-14T23:00:00.000Z',
};

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

describe('cash-up cursor', () => {
  const FP = cashUpFingerprint([WINDOW]);

  it('round-trips a position for the same windows', () => {
    const position = { localDate: '2026-09-10', locationId: LONDON.id };
    expect(decodeCashUpCursor(encodeCashUpCursor(position, FP), FP)).toEqual(position);
  });

  it('is refused once a window that includes today moves to a new day, or the windows or zone change', () => {
    const cursor = encodeCashUpCursor({ localDate: '2026-09-10', locationId: LONDON.id }, FP);
    const current = { ...WINDOW, to: '2026-09-30' };
    const currentCursor = encodeCashUpCursor({ localDate: '2026-09-10', locationId: LONDON.id }, cashUpFingerprint([current]));
    expectCursorInvalid(() => decodeCashUpCursor(currentCursor, cashUpFingerprint([{ ...current, localToday: '2026-09-15' }])));
    expectCursorInvalid(() => decodeCashUpCursor(cursor, cashUpFingerprint([{ ...WINDOW, from: '2026-09-02' }])));
    expectCursorInvalid(() => decodeCashUpCursor(cursor, cashUpFingerprint([{ ...WINDOW, timezone: 'Europe/Dublin' }])));
    expectCursorInvalid(() => decodeCashUpCursor(cursor, cashUpFingerprint([{ ...WINDOW, toUtcExclusive: '2026-09-15T00:00:00.000Z' }])));
  });

  it('survives midnight for a window that is already in the past', () => {
    const past = { ...WINDOW, localToday: '2026-09-20' };
    const cursor = encodeCashUpCursor({ localDate: '2026-09-10', locationId: LONDON.id }, cashUpFingerprint([past]));
    expect(decodeCashUpCursor(cursor, cashUpFingerprint([{ ...past, localToday: '2026-09-21' }]))).toEqual({ localDate: '2026-09-10', locationId: LONDON.id });
  });

  it('refuses anything malformed', () => {
    const encode = (value: unknown) => `c1.${Buffer.from(JSON.stringify(value)).toString('base64url')}`;
    for (const cursor of [
      'abc',
      'm1.xyz',
      'c1.',
      `c1.${'A'.repeat(301)}`,
      encode(['2026-09-10', LONDON.id]),
      encode(['2026-9-10', LONDON.id, FP]),
      encode(['2026-09-10', 'not-a-uuid', FP]),
      encode(['2026-09-10', LONDON.id, 'ABCDEF0123456789']),
    ]) {
      expectCursorInvalid(() => decodeCashUpCursor(cursor, FP));
    }
  });

  it('orders newest day first, then location id, and pages strictly after the cursor', () => {
    const a = { localDate: '2026-09-14', locationId: TOKYO.id };
    const b = { localDate: '2026-09-14', locationId: LONDON.id };
    const c = { localDate: '2026-09-13', locationId: LONDON.id };
    expect([c, a, b].sort(comparePositions)).toEqual([b, a, c]);
    expect(pageAfter([c, a, b], null, 2)).toEqual({ page: [b, a], next: a });
    expect(pageAfter([c, a, b], a, 2)).toEqual({ page: [c], next: null });
    expect(pageAfter([c, a, b], c, 2)).toEqual({ page: [], next: null });
  });
});

describe('detail paging over many days', () => {
  const emptyMoney = (): Ledger => ({ bills: [], lines: [], payments: [], retail: [], deposits: [], locations: [{ id: LONDON.id, businessId: BIZ, currencyCode: 'GBP' }, { id: TOKYO.id, businessId: BIZ, currencyCode: 'GBP' }] });
  /** A signed-off cash-up for every London day in August with the day number as counted cash. */
  function ledger(): CashUpLedger {
    const records = Array.from({ length: 31 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0');
      return {
        id: `43000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
        businessId: BIZ,
        locationId: LONDON.id,
        businessDate: `2026-08-${day}`,
        status: 'signed_off' as const,
        openingFloatCents: 0,
        expectedCashCents: 0,
        countedCashCents: i + 1,
        expectedCardCents: 0,
        countedCardCents: 0,
        pettyCashOutCents: 0,
        refundsCents: 0,
        voidsCents: 0,
        varianceCents: i + 1,
        notes: null,
        signedOffByUserProfileId: null,
        signedOffAt: instant(`2026-08-${day}T18:00:00Z`),
        currencyCode: 'GBP',
      };
    });
    return { records, users: {}, thresholds: [] };
  }
  const AS_OF = new Date('2026-09-14T12:00:00Z');

  async function page(sources: { money: MemoryMoneySource; cashUp: MemoryCashUpSource }, cursor: string | null, asOf = AS_OF) {
    const scope = moneyScope(BIZ, [LONDON, TOKYO], DETAIL('2026-08-01', '2026-08-31'), asOf);
    return new CashUpReportService(sources.money, sources.cashUp).build(scope, { cursor });
  }

  it('walks all 62 location-days exactly once, newest first, 50 per page, with continuation pages carrying only rows', async () => {
    const sources = { money: new MemoryMoneySource(emptyMoney()), cashUp: new MemoryCashUpSource(ledger(), 7) };
    const keys: string[] = [];
    let cursor: string | null = null;
    const bodies: CashUpReportBody[] = [];
    do {
      const body = await page(sources, cursor);
      bodies.push(body);
      expect(body.detail!.rows.length).toBeLessThanOrEqual(CASH_UP_DETAIL_PAGE_SIZE);
      keys.push(...body.detail!.rows.map((r) => r.rowKey));
      cursor = body.detail!.nextCursor;
    } while (cursor !== null && bodies.length < 5);
    expect(bodies.map((b) => [b.continuation, b.detail!.rows.length])).toEqual([[false, 50], [true, 12]]);
    expect(bodies[1]).toMatchObject({ summary: null, locations: [], currencyCode: null });
    expect(new Set(keys).size).toBe(62);
    const dates = keys.map((k) => k.slice(k.indexOf(':') + 1));
    expect(dates).toEqual([...dates].sort().reverse());
    expect(keys[0]).toBe(`${LONDON.id}:2026-08-31`);
    // Each London day keeps its own recorded count across pages.
    const rows = bodies.flatMap((b) => b.detail!.rows).filter((r) => r.locationId === LONDON.id);
    expect(rows.map((r) => (r.record!.cash.counted as { cents: number }).cents)).toEqual(Array.from({ length: 31 }, (_, i) => 31 - i));
  });

  it('a continuation page reads cash-ups only for its own days and locations', async () => {
    const sources = { money: new MemoryMoneySource(emptyMoney()), cashUp: new MemoryCashUpSource(ledger()) };
    const first = await page(sources, null);
    const before = sources.cashUp.reads.length;
    const next = await page(sources, first.detail!.nextCursor);
    const recordReads = sources.cashUp.reads.slice(before).filter((r) => r.method === 'records');
    expect(recordReads.length).toBeGreaterThan(0);
    expect(recordReads.every((r) => r.fromDate === '2026-08-01' && r.toDate === '2026-08-06')).toBe(true);
    expect(next.detail!.rows.map((r) => r.localDate)).toEqual(['2026-08-06', '2026-08-06', '2026-08-05', '2026-08-05', '2026-08-04', '2026-08-04', '2026-08-03', '2026-08-03', '2026-08-02', '2026-08-02', '2026-08-01', '2026-08-01']);
  });

  it('refuses a cursor from before local midnight for a range that includes today, and a cursor without the detail view', async () => {
    const sources = { money: new MemoryMoneySource(emptyMoney()), cashUp: new MemoryCashUpSource(ledger()) };
    const thisMonth = (asOf: Date) =>
      new CashUpReportService(sources.money, sources.cashUp).build(moneyScope(BIZ, [LONDON, TOKYO], DETAIL('2026-07-01', '2026-09-30'), asOf), {
        cursor: null,
      });
    const current = await thisMonth(AS_OF);
    const continueAt = (asOf: Date) =>
      new CashUpReportService(sources.money, sources.cashUp).build(moneyScope(BIZ, [LONDON, TOKYO], DETAIL('2026-07-01', '2026-09-30'), asOf), {
        cursor: current.detail!.nextCursor,
      });
    // Tokyo is on 15 Sep at 15:30Z: its last started day moved, so the page set changed.
    await expect(continueAt(new Date('2026-09-14T15:30:00Z'))).rejects.toMatchObject({ response: { code: 'report_cursor_invalid' } });
    // August is entirely past: its cursor still pages after Tokyo's midnight.
    const first = await page(sources, null);
    await expect(page(sources, first.detail!.nextCursor, new Date('2026-09-14T15:30:00Z'))).resolves.toMatchObject({ continuation: true });
    const summaryScope = moneyScope(BIZ, [LONDON], { ...DETAIL('2026-08-01', '2026-08-31'), view: 'summary' }, AS_OF);
    await expect(new CashUpReportService(sources.money, sources.cashUp).build(summaryScope, { cursor: first.detail!.nextCursor })).rejects.toMatchObject({
      response: { code: 'report_cursor_invalid' },
    });
  });

  it('a day reads the same on a continuation page as on a first page: takings, currencies and who signed off', async () => {
    const money = emptyMoney();
    for (let i = 1; i <= 31; i += 1) {
      const day = String(i).padStart(2, '0');
      money.payments.push({ id: `46000000-0000-4000-8000-${String(i).padStart(12, '0')}`, businessId: BIZ, visitId: `47000000-0000-4000-8000-${String(i).padStart(12, '0')}`, locationId: LONDON.id, at: instant(`2026-08-${day}T10:00:00Z`), method: 'cash', amountCents: 100 * i, currencyCode: 'GBP' });
    }
    const cashUps = ledger();
    const signer = '48000000-0000-4000-8000-000000000001';
    cashUps.users[signer] = 'Ava Stone';
    for (const r of cashUps.records) r.signedOffByUserProfileId = signer;
    const sources = { money: new MemoryMoneySource(money), cashUp: new MemoryCashUpSource(cashUps) };
    const first = await page(sources, null);
    const continuation = await page(sources, first.detail!.nextCursor);
    const early = await new CashUpReportService(sources.money, sources.cashUp).build(moneyScope(BIZ, [LONDON, TOKYO], DETAIL('2026-08-01', '2026-08-06'), AS_OF), { cursor: null });
    expect(continuation.detail!.rows).toEqual(early.detail!.rows);
    expect(continuation.detail!.rows.find((r) => r.rowKey === `${LONDON.id}:2026-08-03`)).toMatchObject({
      sources: { expectedCash: { availability: 'available', cents: 300 } },
      record: { signedOffBy: 'Ava Stone' },
      changeSinceSignOff: { cash: { availability: 'available', cents: 300 } },
    });
  });

  it('has no detail block in the summary view', async () => {
    const sources = { money: new MemoryMoneySource(emptyMoney()), cashUp: new MemoryCashUpSource(ledger()) };
    const scope = moneyScope(BIZ, [LONDON], { ...DETAIL('2026-08-01', '2026-08-31'), view: 'summary' }, AS_OF);
    const body = await new CashUpReportService(sources.money, sources.cashUp).build(scope, { cursor: null });
    expect(body.detail).toBeNull();
  });
});
