/**
 * R1 Money uses Ticket A's per-location windows exactly: every read binds each
 * location to its own window, windows come only from the scope, a location whose
 * window has not started is never read, and DST days and custom ranges follow the
 * location's own calendar.
 */
import type { MoneyAmount, ReportFilter } from '@sheer/domain';
import type { ReportScope } from '../report-scope.service';
import { MoneyReportService } from './money-report.service';
import { MemoryMoneySource, type Ledger } from './testing/memory-money-source';
import { firstPage, instant, moneyScope } from './testing/money-scope';

const BIZ = 'biz-1';
const LONDON = { id: '20000000-0000-4000-8000-000000000001', name: 'London', timezone: 'Europe/London' };
const TOKYO = { id: '20000000-0000-4000-8000-000000000002', name: 'Tokyo', timezone: 'Asia/Tokyo' };
const NEW_YORK = { id: '20000000-0000-4000-8000-000000000003', name: 'New York', timezone: 'America/New_York' };
const filter = (overrides: Partial<ReportFilter> = {}): ReportFilter => ({ preset: 'today', locationIds: [], staffProfileIds: [], view: 'summary', ...overrides });

let serial = 0;
const uid = () => `00000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}`;

function ledgerWithBills(bills: Array<{ locationId: string; at: string; gross: number }>): Ledger {
  const ledger: Ledger = { bills: [], lines: [], payments: [], retail: [], deposits: [] };
  for (const b of bills) {
    const id = uid();
    ledger.bills.push({
      id,
      visitId: uid(),
      businessId: BIZ,
      status: 'paid',
      locationId: b.locationId,
      at: instant(b.at),
      billNumber: serial,
      grossCents: b.gross,
      netCents: b.gross,
      taxCents: 0,
      depositAppliedCents: 0,
      currencyCode: 'GBP',
    });
    ledger.lines.push({ id: uid(), billId: id, lineType: 'service', grossCents: b.gross, netCents: b.gross, taxCents: 0 });
  }
  return ledger;
}

const gross = (amount: MoneyAmount) => (amount.availability === 'available' ? amount.cents : amount.availability);

async function run(ledger: Ledger, scope: ReportScope) {
  const source = new MemoryMoneySource(ledger);
  const body = firstPage(await new MoneyReportService(source).build(scope, { cursor: null }));
  const byLocation = Object.fromEntries(body.locations.map((l) => [l.locationId, gross(l.totals.paidBills.gross)]));
  return { body, source, byLocation };
}

beforeEach(() => {
  serial = 0;
});

describe('Money reads each location inside its own window', () => {
  it('passes every started window exactly as the scope resolved it, to every windowed read, and nothing wider', async () => {
    const scope = moneyScope(BIZ, [LONDON, TOKYO, NEW_YORK], filter(), new Date('2026-09-14T15:30:00Z'));
    const { source } = await run(ledgerWithBills([]), scope);
    const expected = scope.windows.map((w) => ({ locationId: w.locationId, fromUtc: w.fromUtc, toUtcExclusive: w.toUtcExclusive }));
    const windowed = source.reads.filter((r) => r.windows !== undefined);
    expect(windowed.map((r) => r.method).sort()).toEqual(
      ['depositsCollected', 'depositsRefunded', 'paidBills', 'retailSales', 'tillPaymentsInWindows'].sort(),
    );
    for (const read of windowed) {
      expect(read.windows).toEqual(expected);
      expect(read.businessId).toBe(BIZ);
    }
    // Three different windows: London 14 Sep, Tokyo 15 Sep, New York 14 Sep.
    expect(expected.map((w) => [w.fromUtc, w.toUtcExclusive])).toEqual([
      ['2026-09-13T23:00:00.000Z', '2026-09-14T23:00:00.000Z'],
      ['2026-09-14T15:00:00.000Z', '2026-09-15T15:00:00.000Z'],
      ['2026-09-14T04:00:00.000Z', '2026-09-15T04:00:00.000Z'],
    ]);
  });

  it('uses the windows it is given and never recomputes a date', async () => {
    const scope = moneyScope(BIZ, [LONDON], filter(), new Date('2026-09-14T15:30:00Z'));
    const handMade: ReportScope = {
      ...scope,
      windows: [{ ...scope.windows[0], fromUtc: '2026-01-01T00:00:00.000Z', toUtcExclusive: '2026-01-02T00:00:00.000Z' }],
    };
    const ledger = ledgerWithBills([
      { locationId: LONDON.id, at: '2026-01-01T12:00:00Z', gross: 111 },
      { locationId: LONDON.id, at: '2026-09-14T12:00:00Z', gross: 999 },
    ]);
    const { byLocation, source } = await run(ledger, handMade);
    expect(byLocation[LONDON.id]).toBe(111);
    expect(source.reads.find((r) => r.method === 'paidBills')?.windows).toEqual([
      { locationId: LONDON.id, fromUtc: '2026-01-01T00:00:00.000Z', toUtcExclusive: '2026-01-02T00:00:00.000Z' },
    ]);
  });

  it('at one instant, London and Tokyo each count only their own local day', async () => {
    const scope = moneyScope(BIZ, [LONDON, TOKYO], filter(), new Date('2026-09-14T15:30:00Z'));
    const ledger = ledgerWithBills([
      { locationId: LONDON.id, at: '2026-09-14T16:00:00Z', gross: 100 }, // London 14 Sep 17:00 — London's today
      { locationId: TOKYO.id, at: '2026-09-14T16:00:00Z', gross: 200 }, // Tokyo 15 Sep 01:00 — Tokyo's today
      { locationId: TOKYO.id, at: '2026-09-14T14:00:00Z', gross: 400 }, // Tokyo 14 Sep 23:00 — London's day, not Tokyo's
    ]);
    const { byLocation, body } = await run(ledger, scope);
    expect(byLocation).toEqual({ [LONDON.id]: 100, [TOKYO.id]: 200 });
    expect(gross(body.summary.paidBills.gross)).toBe(300);
  });

  it('a location whose window has not started is not read and renders Not started; the others still report', async () => {
    // At 15:30Z Tokyo is already on 15 Sep; London and New York are still on 14 Sep.
    const scope = moneyScope(BIZ, [LONDON, TOKYO, NEW_YORK], filter({ preset: 'custom', from: '2026-09-15', to: '2026-09-15' }), new Date('2026-09-14T15:30:00Z'));
    const ledger = ledgerWithBills([{ locationId: TOKYO.id, at: '2026-09-15T01:00:00Z', gross: 700 }]);
    const { byLocation, body, source } = await run(ledger, scope);
    expect(byLocation).toEqual({ [LONDON.id]: 'not_started', [TOKYO.id]: 700, [NEW_YORK.id]: 'not_started' });
    expect(gross(body.summary.paidBills.gross)).toBe(700);
    for (const read of source.reads.filter((r) => r.windows)) expect(read.windows?.map((w) => w.locationId)).toEqual([TOKYO.id]);
  });

  it('London autumn DST day: all 25 hours count, and nothing either side', async () => {
    const scope = moneyScope(BIZ, [LONDON], filter(), new Date('2026-10-25T20:00:00Z'));
    expect([scope.windows[0].fromUtc, scope.windows[0].toUtcExclusive]).toEqual(['2026-10-24T23:00:00.000Z', '2026-10-26T00:00:00.000Z']);
    const ledger = ledgerWithBills([
      { locationId: LONDON.id, at: '2026-10-24T22:59:59.999999Z', gross: 1 }, // 24 Oct 23:59:59 BST
      { locationId: LONDON.id, at: '2026-10-24T23:30:00Z', gross: 10 }, // 25 Oct 00:30 BST
      { locationId: LONDON.id, at: '2026-10-25T23:30:00Z', gross: 100 }, // 25 Oct 23:30 GMT (hour 25)
      { locationId: LONDON.id, at: '2026-10-26T00:00:00Z', gross: 1000 }, // 26 Oct 00:00 GMT
    ]);
    expect((await run(ledger, scope)).byLocation[LONDON.id]).toBe(110);
  });

  it('London spring DST day: 23 hours', async () => {
    const scope = moneyScope(BIZ, [LONDON], filter(), new Date('2026-03-29T12:00:00Z'));
    expect([scope.windows[0].fromUtc, scope.windows[0].toUtcExclusive]).toEqual(['2026-03-29T00:00:00.000Z', '2026-03-29T23:00:00.000Z']);
    const ledger = ledgerWithBills([
      { locationId: LONDON.id, at: '2026-03-29T00:30:00Z', gross: 10 }, // 00:30 GMT
      { locationId: LONDON.id, at: '2026-03-29T22:59:00Z', gross: 100 }, // 23:59 BST
      { locationId: LONDON.id, at: '2026-03-29T23:00:00Z', gross: 1000 }, // 30 Mar 00:00 BST
    ]);
    expect((await run(ledger, scope)).byLocation[LONDON.id]).toBe(110);
  });

  it('a New York custom range covers its local days, in daylight time', async () => {
    const scope = moneyScope(BIZ, [NEW_YORK], filter({ preset: 'custom', from: '2026-09-10', to: '2026-09-12' }), new Date('2026-09-14T15:30:00Z'));
    expect([scope.windows[0].fromUtc, scope.windows[0].toUtcExclusive]).toEqual(['2026-09-10T04:00:00.000Z', '2026-09-13T04:00:00.000Z']);
    const ledger = ledgerWithBills([
      { locationId: NEW_YORK.id, at: '2026-09-10T03:59:59Z', gross: 1 }, // 9 Sep 23:59:59 EDT
      { locationId: NEW_YORK.id, at: '2026-09-10T04:00:00Z', gross: 10 }, // 10 Sep 00:00 EDT
      { locationId: NEW_YORK.id, at: '2026-09-12T23:30:00Z', gross: 100 }, // 12 Sep 19:30 EDT
      { locationId: NEW_YORK.id, at: '2026-09-13T04:00:00Z', gross: 1000 }, // 13 Sep 00:00 EDT
    ]);
    const { byLocation } = await run(ledger, scope);
    expect(byLocation[NEW_YORK.id]).toBe(110);
    expect(scope.windows[0].status).toBe('complete');
  });

  it('reads many locations in chunks of at most ten, and still counts every location in its own window', async () => {
    const many = Array.from({ length: 23 }, (_, i) => ({
      id: `21000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name: `Salon ${i}`,
      timezone: i % 2 ? 'Europe/London' : 'Asia/Tokyo',
    }));
    const scope = moneyScope(BIZ, many, filter(), new Date('2026-09-14T15:30:00Z'));
    const ledger = ledgerWithBills(many.map((l, i) => ({ locationId: l.id, at: '2026-09-14T16:00:00Z', gross: 100 + i })));
    const { body, source } = await run(ledger, scope);
    const billReads = source.reads.filter((r) => r.method === 'paidBills');
    expect(billReads.every((r) => (r.windows?.length ?? 0) <= 10)).toBe(true);
    // Each chunk is read until an empty read, so a chunk's windows appear more than once: compare the set.
    expect([...new Set(billReads.flatMap((r) => r.windows ?? []).map((w) => w.locationId))].sort()).toEqual(many.map((l) => l.id).sort());
    expect(gross(body.summary.paidBills.gross)).toBe(many.reduce((sum, _l, i) => sum + 100 + i, 0));
  });
});
