/**
 * SupabaseCashUpSource: the exact reads that reach PostgREST. Cash-ups are read as
 * recorded, filtered by business and locations, by business date, with an id
 * keyset; nothing is written; a bad value or a database error is a 500.
 */
import { InternalServerErrorException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import { MoneySourceShapeError } from '../money/money-values';
import { SupabaseCashUpSource } from './cash-up-source';

jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn() }));
const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

const BIZ = 'biz-1';
const L1 = '45000000-0000-4000-8000-000000000001';
const L2 = '45000000-0000-4000-8000-000000000002';
const ID = '45000000-0000-4000-8000-0000000000aa';
const USER = '45000000-0000-4000-8000-0000000000bb';

type FakeResult = { data: unknown; error: unknown };
interface Recorded {
  schema: string;
  table: string;
  ops: Array<[string, unknown[]]>;
}

function fakeSupabase(result: FakeResult) {
  const queries: Recorded[] = [];
  const writes: unknown[] = [];
  const client = {
    schema: (schema: string) => ({
      from: (table: string) => {
        const query: Recorded = { schema, table, ops: [] };
        queries.push(query);
        const builder: Record<string, unknown> = {};
        for (const op of ['select', 'eq', 'in', 'gt', 'gte', 'lte', 'order', 'limit']) {
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
  return { source: new SupabaseCashUpSource(config), queries, writes };
}

const RECORD = {
  id: ID,
  location_id: L1,
  business_date: '2026-09-12',
  status: 'signed_off',
  opening_float_cents: 10000,
  expected_cash_cents: 4000,
  counted_cash_cents: 3800,
  expected_card_cents: 26500,
  counted_card_cents: 26500,
  petty_cash_out_cents: 500,
  refunds_cents: 0,
  voids_cents: 0,
  variance_cents: -200,
  notes: null,
  signed_off_by_user_profile_id: USER,
  signed_off_at: '2026-09-12T19:30:00.123456+00:00',
  currency_code: 'gbp',
};

describe('SupabaseCashUpSource reads', () => {
  it('cash-ups: billing.eod_reconciliations, business and locations, business-date range, id keyset, never a write or the RPC', async () => {
    const { source, queries, writes } = fakeSupabase({ data: [RECORD], error: null });
    const rows = await source.records(BIZ, [L1, L2], '2026-09-01', '2026-09-14', ID, 1000);
    expect(queries).toEqual([
      {
        schema: 'billing',
        table: 'eod_reconciliations',
        ops: [
          ['select', ['id,location_id,business_date,status,opening_float_cents,expected_cash_cents,counted_cash_cents,expected_card_cents,counted_card_cents,petty_cash_out_cents,refunds_cents,voids_cents,variance_cents,notes,signed_off_by_user_profile_id,signed_off_at,currency_code']],
          ['eq', ['business_id', BIZ]],
          ['in', ['location_id', [L1, L2]]],
          ['gte', ['business_date', '2026-09-01']],
          ['lte', ['business_date', '2026-09-14']],
          ['gt', ['id', ID]],
          ['order', ['id', { ascending: true }]],
          ['limit', [1000]],
        ],
      },
    ]);
    expect(rows[0]).toMatchObject({ businessDate: '2026-09-12', status: 'signed_off', varianceCents: -200, signedOffAt: '2026-09-12T19:30:00.123456Z', currencyCode: 'GBP' });
    expect(writes).toEqual([]);
  });

  it('names and thresholds: core.user_profiles by id; core.location_settings by business and location, pounds to exact pence', async () => {
    const names = fakeSupabase({ data: [{ id: USER, full_name: 'Ava Stone' }], error: null });
    expect([...(await names.source.userNames([USER]))]).toEqual([[USER, 'Ava Stone']]);
    expect(names.queries[0]).toEqual({ schema: 'core', table: 'user_profiles', ops: [['select', ['id,full_name']], ['in', ['id', [USER]]], ['limit', [1]]] });

    const thresholds = fakeSupabase({ data: [{ location_id: L1, cash_variance_threshold_amount: '5.00' }], error: null });
    expect([...(await thresholds.source.thresholds(BIZ, [L1, L2]))]).toEqual([[L1, 500]]);
    expect(thresholds.queries[0]).toEqual({
      schema: 'core',
      table: 'location_settings',
      ops: [['select', ['location_id,cash_variance_threshold_amount']], ['eq', ['business_id', BIZ]], ['in', ['location_id', [L1, L2]]], ['limit', [2]]],
    });
  });

  it('refuses inputs that could alter a filter', async () => {
    const { source } = fakeSupabase({ data: [], error: null });
    await expect(source.records(BIZ, ['x),or(true'], '2026-09-01', '2026-09-14', null, 10)).rejects.toThrow();
    await expect(source.records(BIZ, [L1], '2026-09-01T00:00', '2026-09-14', null, 10)).rejects.toThrow();
    await expect(source.userNames(['not-a-uuid'])).rejects.toThrow();
  });

  it('a row that does not have the expected shape is refused, not coerced', async () => {
    for (const bad of [{ status: 'reopened' }, { currency_code: 'GB' }, { counted_cash_cents: '3800' }, { business_date: '12/09/2026' }, { signed_off_at: '2026-09-12T19:30:00+01:00' }]) {
      const { source } = fakeSupabase({ data: [{ ...RECORD, ...bad }], error: null });
      await expect(source.records(BIZ, [L1], '2026-09-01', '2026-09-14', null, 10)).rejects.toBeInstanceOf(MoneySourceShapeError);
    }
  });

  it('a database error is a 500, never an empty report', async () => {
    const { source } = fakeSupabase({ data: null, error: { message: 'boom' } });
    await expect(source.records(BIZ, [L1], '2026-09-01', '2026-09-14', null, 10)).rejects.toBeInstanceOf(InternalServerErrorException);
    await expect(source.thresholds(BIZ, [L1])).rejects.toBeInstanceOf(InternalServerErrorException);
  });
});
