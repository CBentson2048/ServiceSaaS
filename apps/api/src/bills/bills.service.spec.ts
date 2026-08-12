/**
 * Bill finder — scoping and filter mapping tests.
 *
 * The harness captures every builder call on the mocked Supabase client so
 * each test can assert exactly which filters reached the database — the
 * finder's whole contract is "the right predicates, on the right tenant".
 */
import { ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser } from '@sheer/domain';
import { BillsService } from './bills.service';

jest.mock('@supabase/supabase-js', () => ({
  createClient: jest.fn(),
}));

const mockedCreateClient = createClient as jest.MockedFunction<typeof createClient>;

interface CapturedCall {
  method: string;
  args: unknown[];
}

// Chainable mock: every builder method records itself and returns the chain;
// the terminal `returns()` resolves the configured result. Each `schema()`
// call starts a fresh capture list so multi-query flows stay distinguishable.
function createMockAdmin(results: Array<{ data: unknown; error: unknown; count?: number }>) {
  const queries: CapturedCall[][] = [];
  let queryIndex = -1;
  const chain: Record<string, unknown> = {};
  const record = (method: string) =>
    jest.fn((...args: unknown[]) => {
      queries[queryIndex].push({ method, args });
      return chain;
    });
  Object.assign(chain, {
    from: record('from'),
    select: record('select'),
    eq: record('eq'),
    in: record('in'),
    gte: record('gte'),
    lte: record('lte'),
    lt: record('lt'),
    order: record('order'),
    range: record('range'),
    returns: jest.fn(() => {
      queries[queryIndex].push({ method: 'returns', args: [] });
      return Promise.resolve(results[queryIndex] ?? { data: [], error: null });
    }),
  });
  const client = {
    queries,
    schema: jest.fn((...args: unknown[]) => {
      queryIndex += 1;
      queries.push([{ method: 'schema', args }]);
      return chain;
    }),
  };
  return client;
}

function createService(results: Array<{ data: unknown; error: unknown; count?: number }>) {
  const client = createMockAdmin(results);
  mockedCreateClient.mockReturnValue(client as never);
  const config = { getOrThrow: jest.fn(() => 'test') } as unknown as ConfigService;
  return { service: new BillsService(config), client };
}

function actor(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    id: 'user_1',
    roles: ['manager'],
    primaryRole: 'manager',
    businessId: 'business_1',
    allowedLocationIds: ['location_1', 'location_2'],
    ...overrides,
  } as unknown as AuthUser;
}

function billRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bill_1',
    business_id: 'business_1',
    location_id: 'location_1',
    visit_id: 'visit_1',
    client_profile_id: 'client_1',
    staff_profile_id: 'staff_1',
    bill_number: 7,
    status: 'paid',
    gross_cents: 8400,
    deposit_applied_cents: 2000,
    balance_collected_cents: 6400,
    currency_code: 'GBP',
    occurred_at: '2026-08-01T10:00:00.000Z',
    ...overrides,
  };
}

const emptyEnrichment = [
  { data: [], error: null },
  { data: [], error: null },
];

describe('BillsService — scoping', () => {
  beforeEach(() => jest.clearAllMocks());

  it('owner without a location filter searches business-wide (no location predicate)', async () => {
    const { service, client } = createService([
      { data: [billRow()], error: null, count: 1 },
      { data: [{ id: 'client_1', first_name: 'Jane', last_name: 'Doe' }], error: null },
      { data: [{ id: 'staff_1', display_name: 'Alex' }], error: null },
    ]);

    const result = await service.list(actor({ roles: ['owner'], primaryRole: 'owner' }), {});

    const calls = client.queries[0];
    expect(calls).toContainEqual({ method: 'eq', args: ['business_id', 'business_1'] });
    expect(calls.some((call) => call.method === 'in' && call.args[0] === 'location_id')).toBe(false);
    expect(result.bills[0]).toMatchObject({
      billNumber: 7,
      clientName: 'Jane Doe',
      staffName: 'Alex',
      grossCents: 8400,
    });
  });

  it('manager is always restricted to their permitted locations', async () => {
    const { service, client } = createService([{ data: [], error: null, count: 0 }]);

    await service.list(actor(), {});

    expect(client.queries[0]).toContainEqual({
      method: 'in',
      args: ['location_id', ['location_1', 'location_2']],
    });
  });

  it('rejects a location filter outside the manager scope before querying', async () => {
    const { service, client } = createService([]);

    await expect(service.list(actor(), { locationId: 'location_9' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(client.queries).toHaveLength(0);
  });

  it('returns empty without querying when the actor has no permitted locations', async () => {
    const { service, client } = createService([]);

    const result = await service.list(actor({ allowedLocationIds: [] }), {});

    expect(client.queries).toHaveLength(0);
    expect(result.bills).toEqual([]);
    expect(result.pagination.total).toBe(0);
  });
});

describe('BillsService — filter mapping', () => {
  beforeEach(() => jest.clearAllMocks());

  it('maps every finder filter onto the expected predicate', async () => {
    const { service, client } = createService([
      { data: [], error: null, count: 0 },
      ...emptyEnrichment,
    ]);

    await service.list(actor({ roles: ['owner'], primaryRole: 'owner' }), {
      clientProfileId: 'client_9',
      staffProfileId: 'staff_9',
      dateFrom: '2026-08-01',
      dateTo: '2026-08-07',
      amountMinCents: 1000,
      amountMaxCents: 20000,
      billNumber: 42,
    });

    const calls = client.queries[0];
    expect(calls).toContainEqual({ method: 'eq', args: ['client_profile_id', 'client_9'] });
    expect(calls).toContainEqual({ method: 'eq', args: ['staff_profile_id', 'staff_9'] });
    expect(calls).toContainEqual({ method: 'eq', args: ['bill_number', 42] });
    expect(calls).toContainEqual({
      method: 'gte',
      args: ['occurred_at', '2026-08-01T00:00:00.000Z'],
    });
    // dateTo is an INCLUSIVE day: the predicate is strictly-before the next day.
    expect(calls).toContainEqual({
      method: 'lt',
      args: ['occurred_at', '2026-08-08T00:00:00.000Z'],
    });
    expect(calls).toContainEqual({ method: 'gte', args: ['gross_cents', 1000] });
    expect(calls).toContainEqual({ method: 'lte', args: ['gross_cents', 20000] });
  });

  it('pages with a stable order and exact count', async () => {
    const { service, client } = createService([{ data: [], error: null, count: 55 }]);

    const result = await service.list(actor(), { page: 3, pageSize: 10 });

    const calls = client.queries[0];
    expect(calls).toContainEqual({ method: 'range', args: [20, 29] });
    expect(calls).toContainEqual({ method: 'order', args: ['occurred_at', { ascending: false }] });
    expect(calls).toContainEqual({ method: 'order', args: ['id', { ascending: false }] });
    expect(result.pagination).toEqual({ total: 55, page: 3, pageSize: 10, pageCount: 6 });
  });
});
