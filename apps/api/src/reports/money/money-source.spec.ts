/**
 * SupabaseMoneySource: the exact reads that reach PostgREST. Each windowed read
 * filters the business and binds every location to its own window (never an
 * envelope), orders by (instant, id), reads with a keyset, and never writes.
 */
import { InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { SupabaseMoneySource, windowFilter, type MoneyWindow } from './money-source';
import { MoneySourceShapeError } from './money-values';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const BIZ = 'biz-1';
const L1 = '50000000-0000-4000-8000-000000000001';
const L2 = '50000000-0000-4000-8000-000000000002';
const ROW_ID = '60000000-0000-4000-8000-000000000001';
const WINDOWS: MoneyWindow[] = [
  { locationId: L1, fromUtc: '2026-09-13T23:00:00.000Z', toUtcExclusive: '2026-09-14T23:00:00.000Z' },
  { locationId: L2, fromUtc: '2026-09-14T15:00:00.000Z', toUtcExclusive: '2026-09-15T15:00:00.000Z' },
];

interface Recorded {
  schema: string;
  table: string;
  ops: Array<[string, unknown[]]>;
}

function fakeSupabase(result: { data: unknown; error: unknown }) {
  const queries: Recorded[] = [];
  const writes: unknown[] = [];
  const client = {
    schema: (schema: string) => ({
      from: (table: string) => {
        const query: Recorded = { schema, table, ops: [] };
        queries.push(query);
        const builder: Record<string, unknown> = {};
        for (const op of ['select', 'eq', 'in', 'gt', 'or', 'order', 'limit']) {
          builder[op] = (...args: unknown[]) => {
            query.ops.push([op, args]);
            return builder;
          };
        }
        for (const op of ['insert', 'update', 'upsert', 'delete']) {
          builder[op] = (...args: unknown[]) => {
            writes.push([op, table, ...args]);
            return builder;
          };
        }
        builder.returns = () => Promise.resolve(result);
        return builder;
      },
    }),
    rpc: (...args: unknown[]) => {
      writes.push(['rpc', ...args]);
      return Promise.resolve({ data: null, error: null });
    },
  };
  mockedCreateClient.mockReturnValue(client as unknown as ReturnType<typeof createClient>);
  const config = { getOrThrow: (key: string) => `placeholder-${key}` } as unknown as ConfigService;
  return { source: new SupabaseMoneySource(config), queries, writes };
}

describe('windowFilter', () => {
  it('binds each location to its own window, with no envelope', () => {
    expect(windowFilter('occurred_at', WINDOWS, null)).toBe(
      `and(location_id.eq.${L1},occurred_at.gte."2026-09-13T23:00:00.000Z",occurred_at.lt."2026-09-14T23:00:00.000Z"),` +
        `and(location_id.eq.${L2},occurred_at.gte."2026-09-14T15:00:00.000Z",occurred_at.lt."2026-09-15T15:00:00.000Z")`,
    );
  });

  it('adds the keyset start inside every location clause', () => {
    const key = '2026-09-14T16:00:00.123456Z';
    expect(windowFilter('paid_at', WINDOWS.slice(0, 1), { key, id: ROW_ID })).toBe(
      `and(location_id.eq.${L1},paid_at.gte."2026-09-13T23:00:00.000Z",paid_at.lt."2026-09-14T23:00:00.000Z",` +
        `or(paid_at.gt."${key}",and(paid_at.eq."${key}",id.gt.${ROW_ID})))`,
    );
    expect(windowFilter('sold_at', WINDOWS.slice(1), { key, op: 'gte' })).toContain(`sold_at.gte."${key}")`);
  });

  it('accepts a five-digit-year window end (a range ending 9999-12-31)', () => {
    expect(() => windowFilter('occurred_at', [{ ...WINDOWS[0], toUtcExclusive: '10000-01-01T00:00:00.000Z' }], null)).not.toThrow();
  });

  it('refuses anything that could alter the filter', () => {
    const bad: Array<[MoneyWindow[], Parameters<typeof windowFilter>[2]]> = [
      [[], null],
      [[{ ...WINDOWS[0], locationId: `${L1},business_id.neq.x` }], null],
      [[{ ...WINDOWS[0], fromUtc: '2026-09-13' }], null],
      [[{ ...WINDOWS[0], toUtcExclusive: '2026-09-14T23:00:00Z")' }], null],
      [WINDOWS, { key: '2026-09-14T16:00:00Z', id: ROW_ID }],
      [WINDOWS, { key: '2026-09-14T16:00:00.000000Z', id: 'x),or(true' }],
    ];
    for (const [windows, after] of bad) expect(() => windowFilter('occurred_at', windows, after)).toThrow();
  });
});

describe('SupabaseMoneySource reads', () => {
  it('paid bills: billing.bills, business and paid only, per-location windows, (occurred_at, id) order, limit', async () => {
    const { source, queries, writes } = fakeSupabase({
      data: [
        {
          id: ROW_ID,
          visit_id: '70000000-0000-4000-8000-000000000001',
          location_id: L1,
          occurred_at: '2026-09-14T10:00:00.123456+00:00',
          bill_number: 1001,
          gross_cents: 12000,
          net_cents: 10000,
          tax_cents: 2000,
          deposit_applied_cents: 2000,
          currency_code: 'GBP',
        },
      ],
      error: null,
    });
    const rows = await source.paidBills(BIZ, WINDOWS, null, 1000);
    expect(queries).toEqual([
      {
        schema: 'billing',
        table: 'bills',
        ops: [
          ['select', ['id,visit_id,location_id,occurred_at,bill_number,gross_cents,net_cents,tax_cents,deposit_applied_cents,currency_code']],
          ['eq', ['business_id', BIZ]],
          ['eq', ['status', 'paid']],
          ['or', [windowFilter('occurred_at', WINDOWS, null)]],
          ['order', ['occurred_at', { ascending: true }]],
          ['order', ['id', { ascending: true }]],
          ['limit', [1000]],
        ],
      },
    ]);
    expect(rows[0]).toMatchObject({ at: '2026-09-14T10:00:00.123456Z', grossCents: 12000, depositAppliedCents: 2000, billNumber: 1001 });
    expect(writes).toEqual([]);
  });

  it('deposits: booking.deposits, collected by paid_at and refunded by refunded_at, with exact pence', async () => {
    const collected = fakeSupabase({
      data: [{ id: ROW_ID, location_id: L1, paid_at: '2026-09-14T08:00:00+00:00', amount: 15.5, status: 'refunded', currency_code: 'GBP' }],
      error: null,
    });
    const rows = await collected.source.depositsCollected(BIZ, WINDOWS, null, 10);
    expect(collected.queries[0].schema).toBe('booking');
    expect(collected.queries[0].table).toBe('deposits');
    expect(collected.queries[0].ops).toContainEqual(['in', ['status', ['paid', 'partially_refunded', 'refunded']]]);
    expect(collected.queries[0].ops).toContainEqual(['or', [windowFilter('paid_at', WINDOWS, null)]]);
    expect(rows[0]).toMatchObject({ amountCents: 1550, status: 'refunded', at: '2026-09-14T08:00:00.000000Z' });

    const refunded = fakeSupabase({
      data: [{ id: ROW_ID, location_id: L1, refunded_at: '2026-09-14T16:00:00+00:00', amount: '30.00', status: 'refunded', currency_code: 'GBP' }],
      error: null,
    });
    const refundRows = await refunded.source.depositsRefunded(BIZ, WINDOWS, null, 10);
    expect(refunded.queries[0].ops).toContainEqual(['select', ['id,location_id,refunded_at,amount,status,currency_code']]);
    expect(refunded.queries[0].ops).toContainEqual(['in', ['status', ['partially_refunded', 'refunded']]]);
    expect(refunded.queries[0].ops).toContainEqual(['or', [windowFilter('refunded_at', WINDOWS, null)]]);
    expect(refundRows[0].amountCents).toBe(3000);
  });

  it('retail: a missing payment method is "not recorded", never guessed', async () => {
    const { source, queries } = fakeSupabase({
      data: [{ id: ROW_ID, location_id: L1, sold_at: '2026-09-14T09:00:00Z', total_amount_cents: 2500, quantity: 1, payment_method: null, currency_code: 'GBP' }],
      error: null,
    });
    const rows = await source.retailSales(BIZ, WINDOWS, null, 10);
    expect(queries[0]).toMatchObject({ schema: 'billing', table: 'retail_sales' });
    expect(rows[0].method).toBe('not_recorded');
  });

  it('lines and payments of known bills are read by id keyset, never an offset', async () => {
    const lines = fakeSupabase({ data: [], error: null });
    await lines.source.billLines([ROW_ID], '60000000-0000-4000-8000-000000000000', 1000);
    expect(lines.queries[0].ops).toEqual([
      ['select', ['id,bill_id,line_type,gross_cents,net_cents,tax_cents']],
      ['in', ['bill_id', [ROW_ID]]],
      ['gt', ['id', '60000000-0000-4000-8000-000000000000']],
      ['order', ['id', { ascending: true }]],
      ['limit', [1000]],
    ]);
    const payments = fakeSupabase({ data: [], error: null });
    await payments.source.tillPaymentsForVisits(BIZ, [ROW_ID], null, 1000);
    expect(payments.queries[0].ops).toContainEqual(['eq', ['business_id', BIZ]]);
    expect(payments.queries[0].ops).toContainEqual(['in', ['visit_id', [ROW_ID]]]);
  });

  it('a database error is a 500, never an empty report', async () => {
    const { source } = fakeSupabase({ data: null, error: { message: 'boom' } });
    await expect(source.paidBills(BIZ, WINDOWS, null, 10)).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('a row that does not have the expected shape is refused, not coerced', async () => {
    const lineType = fakeSupabase({ data: [{ id: ROW_ID, bill_id: ROW_ID, line_type: 'gift_card', gross_cents: 1, net_cents: 1, tax_cents: 0 }], error: null });
    await expect(lineType.source.billLines([ROW_ID], null, 10)).rejects.toBeInstanceOf(MoneySourceShapeError);
    const offset = fakeSupabase({
      data: [{ id: ROW_ID, location_id: L1, sold_at: '2026-09-14T10:00:00+01:00', total_amount_cents: 1, quantity: 1, payment_method: 'cash', currency_code: 'GBP' }],
      error: null,
    });
    await expect(offset.source.retailSales(BIZ, WINDOWS, null, 10)).rejects.toBeInstanceOf(MoneySourceShapeError);
    const fraction = fakeSupabase({ data: [{ id: ROW_ID, location_id: L1, paid_at: '2026-09-14T08:00:00Z', amount: 1.005, status: 'paid', currency_code: 'GBP' }], error: null });
    await expect(fraction.source.depositsCollected(BIZ, WINDOWS, null, 10)).rejects.toBeInstanceOf(MoneySourceShapeError);
  });
});
